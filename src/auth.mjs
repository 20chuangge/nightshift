/**
 * auth.mjs - who is allowed to talk to this assistant.
 *
 * The model: this is a personal tool that lives on your machine. A request that
 * arrives over loopback is you, sitting at the computer, and is always allowed.
 * A request from anywhere else is somebody on the network and must prove it
 * knows one of two secrets:
 *
 *   Bearer <token>        the 24-hex token in data/security.json (scripts, curl)
 *   Cookie desk_session   set by a successful POST /api/pair (a browser)
 *
 * The pairing code is a *separate*, shorter secret on purpose: it is meant to be
 * read off the screen and typed into a phone, it is rate-limited, and it can be
 * rotated without invalidating an already-paired browser. The bearer token is
 * what those paired clients end up holding.
 *
 * Static shell assets (the HTML, the manifest, the service worker, the offline
 * page, the icons) are exempt: the pairing screen has to load *before* the
 * client can authenticate, otherwise you could never pair.
 */

import crypto from 'node:crypto';
import os from 'node:os';
import fsp from 'node:fs/promises';

import { P, readJson, writeJsonAtomic } from './store.mjs';

export const SESSION_COOKIE = 'desk_session';
export const SESSION_MAX_AGE_SECONDS = 365 * 24 * 60 * 60;

const LOOPBACK_HOSTS = new Set(['127.0.0.1', 'localhost', '::1', '[::1]', '::ffff:127.0.0.1']);

/** Normalize an address so IPv4-mapped IPv6 still reads as loopback. */
export function normalizeAddress(value) {
  const text = String(value || '').trim().toLowerCase();
  if (!text) return '';
  if (text.startsWith('::ffff:')) return text.slice(7);
  return text;
}

export function isLoopbackAddress(value) {
  const address = normalizeAddress(value);
  if (!address) return false;
  return address === '::1' || address === '127.0.0.1' || address.startsWith('127.');
}

/** A bind address that only exposes the machine itself. */
export function isLoopbackHost(value) {
  const host = String(value || '').trim().toLowerCase().replace(/^\[|\]$/g, '');
  if (!host) return true;
  if (LOOPBACK_HOSTS.has(host)) return true;
  return host.startsWith('127.');
}

export function clientIp(req) {
  return normalizeAddress(req?.socket?.remoteAddress) || 'unknown';
}

/** Constant-time comparison. Hashing first hides the length difference too. */
export function safeEqual(a, b) {
  const left = crypto.createHash('sha256').update(String(a ?? '')).digest();
  const right = crypto.createHash('sha256').update(String(b ?? '')).digest();
  return crypto.timingSafeEqual(left, right);
}

export function readCookie(cookieHeader, name) {
  const header = String(cookieHeader || '');
  if (!header) return '';
  for (const part of header.split(';')) {
    const separator = part.indexOf('=');
    if (separator === -1) continue;
    if (part.slice(0, separator).trim() !== name) continue;
    const raw = part.slice(separator + 1).trim();
    try {
      return decodeURIComponent(raw);
    } catch {
      return raw;
    }
  }
  return '';
}

// ---------------------------------------------------------------------------
// Secrets on disk
// ---------------------------------------------------------------------------

/** 24 hex characters, per the product spec. */
export function generateToken() {
  return crypto.randomBytes(12).toString('hex');
}

/**
 * 8 digits: short enough to read off a screen and type on a phone (the UI
 * groups the digits in fours), still ~26 bits behind a 5/minute rate limit.
 */
export function generatePairingCode() {
  return String(crypto.randomInt(10_000_000, 100_000_000));
}

/**
 * Read data/security.json, creating it on first boot.
 * Kept in the data directory (gitignored) rather than config/, because it is a
 * secret, not configuration.
 */
export async function loadOrCreateSecurity() {
  const raw = await readJson(P.securityFile, null);
  const token =
    typeof raw?.token === 'string' && raw.token.trim() ? raw.token.trim() : generateToken();
  const code =
    typeof raw?.code === 'string' && raw.code.trim() ? raw.code.trim() : generatePairingCode();

  const security = {
    ...(raw && typeof raw === 'object' ? raw : {}),
    token,
    code,
    createdAt: typeof raw?.createdAt === 'string' ? raw.createdAt : new Date().toISOString(),
  };

  const needsWrite = !raw || raw.token !== token || raw.code !== code || !raw.createdAt;
  if (needsWrite) {
    await writeJsonAtomic(P.securityFile, security);
    try {
      await fsp.chmod(P.securityFile, 0o600);
    } catch {
      /* Windows ignores modes; the profile directory is the protection */
    }
  }
  return security;
}

/** Rotate the pairing code without disturbing paired browsers. */
export async function rotatePairingCode(security) {
  const next = { ...security, code: generatePairingCode(), codeCreatedAt: new Date().toISOString() };
  await writeJsonAtomic(P.securityFile, next);
  return next;
}

// ---------------------------------------------------------------------------
// The decision
// ---------------------------------------------------------------------------

/**
 * The one auth function. Exported so it can be unit-tested with a fake request
 * object (that is how the smoke test proves remote clients are gated without
 * actually opening a network port).
 *
 * @param {{socket?: {remoteAddress?: string}, headers?: object}} req
 * @param {{token?: string}} security
 * @returns {{required: boolean, authorized: boolean, mode: 'local'|'token'|'cookie'|'none', local: boolean, address: string}}
 */
export function evaluateAuth(req, security) {
  const address = clientIp(req);
  if (isLoopbackAddress(address)) {
    return { required: false, authorized: true, mode: 'local', local: true, address };
  }

  const authorization = String(req?.headers?.authorization || '');
  const bearer = /^bearer\s+/i.test(authorization) ? authorization.replace(/^bearer\s+/i, '').trim() : '';
  if (bearer && security?.token && safeEqual(bearer, security.token)) {
    return { required: true, authorized: true, mode: 'token', local: false, address };
  }

  const cookie = readCookie(req?.headers?.cookie, SESSION_COOKIE);
  if (cookie && security?.token && safeEqual(cookie, security.token)) {
    return { required: true, authorized: true, mode: 'cookie', local: false, address };
  }

  return { required: true, authorized: false, mode: 'none', local: false, address };
}

// ---------------------------------------------------------------------------
// Path exemptions
// ---------------------------------------------------------------------------

/**
 * The app shell must load before pairing, so these are reachable without a
 * credential. Nothing under /api/ belongs on this list except /api/auth and
 * /api/pair (which are handled separately).
 */
const PUBLIC_SHELL_PATHS = new Set([
  '/',
  '/index.html',
  '/manifest.json',
  '/sw.js',
  '/offline.html',
  '/favicon.ico',
]);

export function isPublicShellPath(pathname) {
  const value = String(pathname || '/');
  if (PUBLIC_SHELL_PATHS.has(value)) return true;
  if (value.startsWith('/icons/')) return true;
  return false;
}

/** /api/auth tells the client whether it needs to pair; /api/pair is how it does. */
export function isAuthExemptPath(method, pathname) {
  const verb = String(method || 'GET').toUpperCase();
  const value = String(pathname || '');
  if (value === '/api/auth' && (verb === 'GET' || verb === 'HEAD')) return true;
  if (value === '/api/pair' && verb === 'POST') return true;
  return false;
}

export function sessionCookieHeader(token) {
  // No `Secure`: this server speaks plain HTTP on a LAN. HttpOnly keeps the
  // token away from page scripts, SameSite=Lax blocks cross-site sends.
  return `${SESSION_COOKIE}=${encodeURIComponent(token)}; HttpOnly; SameSite=Lax; Path=/; Max-Age=${SESSION_MAX_AGE_SECONDS}`;
}

// ---------------------------------------------------------------------------
// Pairing rate limit
// ---------------------------------------------------------------------------

/**
 * 5 attempts per minute per IP. Small enough to make guessing a 32-bit code
 * pointless, generous enough for a human who mistypes.
 */
export function createRateLimiter({ limit = 5, windowMs = 60_000 } = {}) {
  const hits = new Map(); // key -> array of timestamps

  return {
    check(key, now = Date.now()) {
      const bucket = (hits.get(key) || []).filter((ts) => now - ts < windowMs);
      if (bucket.length >= limit) {
        hits.set(key, bucket);
        return { allowed: false, retryAfterMs: Math.max(windowMs - (now - bucket[0]), 0) };
      }
      bucket.push(now);
      hits.set(key, bucket);
      // Opportunistic cleanup so the map cannot grow forever.
      if (hits.size > 500) {
        for (const [storedKey, timestamps] of hits) {
          if (!timestamps.some((ts) => now - ts < windowMs)) hits.delete(storedKey);
        }
      }
      return { allowed: true, remaining: limit - bucket.length };
    },
    reset() {
      hits.clear();
    },
    get size() {
      return hits.size;
    },
  };
}

// ---------------------------------------------------------------------------
// Network surface
// ---------------------------------------------------------------------------

export function listLanAddresses() {
  const interfaces = os.networkInterfaces();
  const out = [];
  for (const [name, addresses] of Object.entries(interfaces)) {
    for (const info of addresses || []) {
      if (info.family !== 'IPv4' || info.internal) continue;
      out.push({ name, address: info.address });
    }
  }
  return out;
}

function privateRank(address) {
  if (address.startsWith('192.168.')) return 0;
  if (address.startsWith('10.')) return 1;
  if (/^172\.(1[6-9]|2\d|3[01])\./.test(address)) return 2;
  return 3;
}

/** Best guess at "the address your phone should use". */
export function preferredLanAddress() {
  return listLanAddresses()
    .sort((a, b) => privateRank(a.address) - privateRank(b.address))[0]
    ?.address;
}

/**
 * This machine's Tailscale address, if it is on a tailnet: an IPv4 in
 * 100.64.0.0/10 (Tailscale's range). With it, the hub is reachable from the
 * owner's other devices anywhere, no port opened to the internet.
 */
export function tailnetAddress() {
  const all = listLanAddresses();
  const inRange = (a) => {
    const [x, y] = a.split('.').map(Number);
    return x === 100 && y >= 64 && y <= 127;
  };
  return (all.find((i) => /tailscale/i.test(i.name) && inRange(i.address))
    || all.find((i) => inRange(i.address)))?.address || null;
}

export function lanUrlFor(address, port) {
  return address && port ? `http://${address}:${port}` : null;
}
