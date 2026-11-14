/**
 * netguard.mjs - keep the bots' web fetches out of the home network (SEC-11).
 *
 * The name in a URL proves nothing: `127.0.0.1.nip.io` resolves to loopback,
 * `http://2130706433/` is 127.0.0.1, and a public page can redirect to the
 * router. So the check looks at the addresses a name resolves to, and every
 * redirect is followed by hand through the same check.
 *
 * ALLOW_PRIVATE=1 still opens the home network on purpose (tests, a NAS).
 */

import dns from 'node:dns/promises';
import net from 'node:net';

function guardError(code, message) {
  const err = new Error(message);
  err.code = code;
  return err;
}

/** Loopback, private, link-local, CGNAT / Tailscale (100.64/10), unspecified - and IPv4-mapped IPv6 of those. */
export function isPrivateIp(ip) {
  let v = String(ip || '').trim().replace(/^\[|\]$/g, '').toLowerCase();
  const mapped = /^::ffff:(\d+\.\d+\.\d+\.\d+)$/.exec(v) || /^::ffff:([0-9a-f]{1,4}):([0-9a-f]{1,4})$/.exec(v);
  if (mapped && mapped.length === 2) v = mapped[1];
  else if (mapped) {
    const hi = parseInt(mapped[1], 16);
    const lo = parseInt(mapped[2], 16);
    v = `${hi >> 8}.${hi & 255}.${lo >> 8}.${lo & 255}`;
  }
  if (net.isIPv4(v)) {
    const [a, b] = v.split('.').map(Number);
    return a === 0 || a === 10 || a === 127 || (a === 169 && b === 254) || (a === 192 && b === 168)
      || (a === 172 && b >= 16 && b <= 31) || (a === 100 && b >= 64 && b <= 127);
  }
  if (net.isIPv6(v)) {
    return v === '::1' || v === '::' || /^f[cd]/.test(v) || /^fe[89ab]/.test(v);
  }
  return true; // not an address at all: refuse rather than guess
}

/**
 * Throws PRIVATE_HOST_BLOCKED when the URL's host is, or resolves to, a private
 * address. `lookup(host)` -> [{address}] is injectable for tests.
 */
export async function assertPublicUrl(url, { lookup = (host) => dns.lookup(host, { all: true }) } = {}) {
  if (process.env.ALLOW_PRIVATE === '1') return;
  let parsed;
  try {
    parsed = new URL(String(url));
  } catch {
    throw guardError('HTTP_BAD_URL', `not a valid URL: ${url}`);
  }
  // new URL() already turns 2130706433 and 0x7f.1 into 127.0.0.1.
  const host = parsed.hostname.replace(/^\[|\]$/g, '').toLowerCase();
  if (!host || host === 'localhost' || host.endsWith('.localhost')) {
    throw guardError('PRIVATE_HOST_BLOCKED', `${host || url} is this computer`);
  }
  let addresses;
  if (net.isIP(host)) addresses = [host];
  else {
    try {
      addresses = (await lookup(host)).map((a) => a.address);
    } catch (err) {
      throw guardError('HTTP_FAILED', `cannot resolve ${host}: ${err.code || err.message}`);
    }
  }
  if (!addresses.length || addresses.some(isPrivateIp)) {
    throw guardError('PRIVATE_HOST_BLOCKED', `${host} points into the home network or this computer (set ALLOW_PRIVATE=1 to allow it)`);
  }
}

/**
 * fetch() that checks the address before the request and before every
 * redirect (at most 5). POST turns into GET on 301/302/303, as browsers do.
 */
export async function fetchPublic(url, init = {}, { fetchImpl = fetch, lookup, maxRedirects = 5 } = {}) {
  let current = String(url);
  let options = { ...init, redirect: 'manual' };
  for (let hop = 0; hop <= maxRedirects; hop += 1) {
    await assertPublicUrl(current, lookup ? { lookup } : {});
    const res = await fetchImpl(current, options);
    const status = Number(res.status);
    const location = status >= 300 && status < 400 ? res.headers.get('location') : null;
    if (!location) return Object.assign(res, { finalUrl: current });
    current = new URL(location, current).href;
    if (status === 301 || status === 302 || status === 303) {
      const { body: _drop, ...rest } = options;
      options = { ...rest, method: 'GET' };
    }
  }
  throw guardError('HTTP_FAILED', `more than ${maxRedirects} redirects`);
}
