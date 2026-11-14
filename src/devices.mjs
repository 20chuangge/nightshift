/**
 * devices.mjs - the phones (and other machines) that have paired with this hub.
 *
 * Why a store and not "the cookie holds the master token": a device list is
 * useless if revoking a device is impossible. Every device that pairs gets its
 * *own* 32-byte session token, stored here as a SHA-256 hash; deleting the
 * record is enough to end that session, and the master token in
 * data/security.json (scripts, curl, other hubs) is untouched.
 *
 * The master token is still accepted as a cookie, on purpose: browsers paired
 * before this module existed hold it, and logging them all out on upgrade would
 * be a worse bug than the one this fixes.
 *
 * Nothing secret ever leaves this module: list() returns metadata only.
 */

import crypto from 'node:crypto';

import { P, readJson, writeJsonAtomic } from './store.mjs';

/** Old devices age out of the list, but never out of the file silently: we cap. */
const MAX_DEVICES = 50;

/** lastSeenAt is written at most this often; every request would be a file write. */
const TOUCH_INTERVAL_MS = 60_000;

const SESSION_BYTES = 32;

export function hashSession(token) {
  return crypto.createHash('sha256').update(String(token ?? '')).digest('hex');
}

/**
 * A name a human recognizes in a list: "iPhone", "Android 手机", "iPad",
 * "Windows 电脑上的浏览器". Anything unknown stays a plain word.
 */
export function describeAgent(userAgent) {
  const ua = String(userAgent || '');
  const has = (re) => re.test(ua);
  if (has(/iPhone/i)) return 'iPhone';
  if (has(/iPad/i)) return 'iPad';
  if (has(/Android/i) && has(/Mobile/i)) return 'Android 手机';
  if (has(/Android/i)) return 'Android 平板';
  if (has(/Windows/i)) return 'Windows 电脑上的浏览器';
  if (has(/Macintosh|Mac OS X/i)) return 'Mac 上的浏览器';
  if (has(/Linux/i)) return 'Linux 上的浏览器';
  if (has(/curl|wget|python-requests|node-fetch|undici/i)) return '脚本';
  return '浏览器';
}

/**
 * What kind of client paired (SEC-06): a phone or tablet, a web browser, or
 * another computer's Lamplit (the desktop app's own requests and its window).
 * Only a computer may push an update package. A client could lie here, but it
 * needed the pairing code to get this far.
 */
export function deviceKind(userAgent) {
  const ua = String(userAgent || '');
  if (/iPhone|iPad|Android/i.test(ua)) return 'phone';
  if (/Electron\//i.test(ua)) return 'machine';
  if (/Mozilla/i.test(ua)) return 'browser';
  return 'machine';
}

/** May this paired device replace this machine's code? Devices paired before 1.2.153 have no kind: all but phones may. */
export function mayPushUpdate(device) {
  if (!device) return false;
  if (device.kind) return device.kind === 'machine';
  return !/^(iPhone|iPad|Android)/.test(String(device.name || ''));
}

function cleanIso(value, fallback) {
  const text = String(value || '').trim();
  if (!text) return fallback;
  const parsed = Date.parse(text);
  return Number.isFinite(parsed) ? new Date(parsed).toISOString() : fallback;
}

/** Metadata only. Never hand a token hash to a route that returns JSON. */
function publicDevice(device) {
  return {
    id: device.id,
    name: device.name,
    createdAt: device.createdAt,
    lastSeenAt: device.lastSeenAt,
    ip: device.ip,
    ...(device.kind ? { kind: device.kind } : {}),
  };
}

/**
 * Build the store over an already-read list. Kept synchronous and pure so the
 * smoke test can construct one over fixtures without touching disk.
 */
export function createDeviceStore({ items = [], persist = async () => {} } = {}) {
  const now = () => new Date().toISOString();
  const devices = items
    .filter((d) => d && typeof d.id === 'string' && typeof d.tokenHash === 'string')
    .map((d) => ({
      id: d.id,
      name: String(d.name || '设备'),
      tokenHash: d.tokenHash,
      createdAt: cleanIso(d.createdAt, now()),
      lastSeenAt: cleanIso(d.lastSeenAt || d.createdAt, now()),
      ip: String(d.ip || ''),
      ...(['phone', 'browser', 'machine'].includes(d.kind) ? { kind: d.kind } : {}),
    }))
    .slice(0, MAX_DEVICES);

  let saveChain = Promise.resolve();
  function save() {
    // Serialized: two devices pairing at once must not lose one another.
    saveChain = saveChain
      .catch(() => {})
      .then(() => persist(devices.map((d) => ({ ...d }))))
      .catch(() => {});
    return saveChain;
  }

  return {
    /** Everything the UI may show, newest activity first. */
    list() {
      return devices
        .slice()
        .sort((a, b) => String(b.lastSeenAt).localeCompare(String(a.lastSeenAt)))
        .map(publicDevice);
    },

    /** Register a newly paired device and hand back its one-time session token. */
    add({ name = '设备', ip = '', kind = '' } = {}) {
      const sessionToken = crypto.randomBytes(SESSION_BYTES).toString('hex');
      const stamp = now();
      const device = {
        id: crypto.randomBytes(8).toString('hex'),
        name: String(name || '设备').slice(0, 40),
        tokenHash: hashSession(sessionToken),
        createdAt: stamp,
        lastSeenAt: stamp,
        ip: String(ip || ''),
        ...(['phone', 'browser', 'machine'].includes(kind) ? { kind } : {}),
      };
      devices.push(device);
      // Oldest activity goes first when the list is full.
      if (devices.length > MAX_DEVICES) {
        const oldest = devices
          .slice()
          .sort((a, b) => String(a.lastSeenAt).localeCompare(String(b.lastSeenAt)))[0];
        const index = devices.indexOf(oldest);
        if (index >= 0) devices.splice(index, 1);
      }
      save();
      return { device: publicDevice(device), sessionToken };
    },

    /** The device behind a session cookie, or null. */
    findBySession(sessionToken) {
      const token = String(sessionToken || '').trim();
      if (!token) return null;
      const wanted = hashSession(token);
      const device = devices.find((d) => d.tokenHash.length === wanted.length && safeDigestEqual(d.tokenHash, wanted));
      return device ? publicDevice(device) : null;
    },

    /** Record that a device is still around. Throttled; never throws. */
    touch(id) {
      const device = devices.find((d) => d.id === id);
      if (!device) return false;
      const age = Date.now() - Date.parse(device.lastSeenAt);
      if (Number.isFinite(age) && age >= 0 && age < TOUCH_INTERVAL_MS) return true;
      device.lastSeenAt = now();
      save();
      return true;
    },

    /** Revoke one device. Its cookie stops working on the next request. */
    remove(id) {
      const index = devices.findIndex((d) => d.id === id);
      if (index === -1) return false;
      devices.splice(index, 1);
      save();
      return true;
    },

    get size() {
      return devices.length;
    },
  };
}

function safeDigestEqual(a, b) {
  const left = Buffer.from(String(a), 'utf8');
  const right = Buffer.from(String(b), 'utf8');
  if (left.length !== right.length) return false;
  return crypto.timingSafeEqual(left, right);
}

/** Read data/devices.json and wrap it. A corrupt or missing file is an empty list. */
export async function loadDeviceStore(file = P.devicesFile) {
  const raw = await readJson(file, null);
  const items = Array.isArray(raw) ? raw : Array.isArray(raw?.devices) ? raw.devices : [];
  return createDeviceStore({
    items,
    persist: async (devices) => {
      await writeJsonAtomic(file, { devices });
      try {
        const fsp = await import('node:fs/promises');
        await fsp.chmod(file, 0o600);
      } catch {
        /* Windows ignores modes; the profile directory is the protection */
      }
    },
  });
}
