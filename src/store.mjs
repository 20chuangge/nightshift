/**
 * store.mjs - the single place that knows where bytes live.
 *
 * Everything else in the app talks to this module instead of joining paths
 * itself, so a "home directory" override (ASSIST_HOME) moves the whole
 * installation in one go. That is what the smoke test uses: it copies
 * config/, skills/ and public/ into a temp directory, points ASSIST_HOME at it,
 * and then runs the real server binary against throw-away state.
 *
 * Persistence choices, deliberately boring:
 *   - JSON (+ atomic tmp+rename) for things we mutate as a whole (bots, routines, config)
 *   - JSONL append-only for things we only ever add to (sessions, audit)
 *   - Markdown for memory and skills, because a human is supposed to be able
 *     to open them in an editor and understand them.
 */

import fs from 'node:fs';
import fsp from 'node:fs/promises';
import path from 'node:path';
import crypto from 'node:crypto';
import { fileURLToPath } from 'node:url';

const SRC_DIR = path.dirname(fileURLToPath(import.meta.url));

/** Installation root. Overridable so tests / demos never touch real state. */
export const ROOT = process.env.ASSIST_HOME
  ? path.resolve(process.env.ASSIST_HOME)
  : path.resolve(SRC_DIR, '..');

function pickDir(envName, fallback) {
  const raw = process.env[envName];
  return raw && raw.trim() ? path.resolve(raw.trim()) : path.join(ROOT, fallback);
}

const DATA_DIR = pickDir('ASSIST_DATA_DIR', 'data');

/** Where the bots' shared workspace lives by default (no setting, no env). */
export const DEFAULT_WORKSPACE_DIR = path.join(ROOT, 'workspace');
/** The human's own workspace folder (data/workspace.json {path}), set in
 *  settings and read once at start; ASSIST_WORKSPACE_DIR still wins (tests). */
export const WORKSPACE_FILE = path.join(DATA_DIR, 'workspace.json');
function chosenWorkspace() {
  try {
    const p = String(JSON.parse(fs.readFileSync(WORKSPACE_FILE, 'utf8')).path || '').trim();
    return p && path.isAbsolute(p) ? path.resolve(p) : '';
  } catch {
    return '';
  }
}

export const P = {
  root: ROOT,
  configDir: path.join(ROOT, 'config'),
  botsDir: path.join(ROOT, 'config', 'bots'),
  assistantConfig: path.join(ROOT, 'config', 'assistant.json'),
  // Product settings (provider / baseUrl / model). No secrets in this file.
  settingsFile: path.join(ROOT, 'config', 'settings.json'),
  skillsDir: path.join(ROOT, 'skills'),
  publicDir: path.join(ROOT, 'public'),
  workspaceDir: process.env.ASSIST_WORKSPACE_DIR?.trim() ? path.resolve(process.env.ASSIST_WORKSPACE_DIR.trim()) : (chosenWorkspace() || DEFAULT_WORKSPACE_DIR),
  dataDir: DATA_DIR,
  memoryDir: path.join(DATA_DIR, 'memory'),
  sessionsDir: path.join(DATA_DIR, 'sessions'),
  // Uploaded bot avatars, one file per bot: data/avatars/<botId>.<png|jpg|webp>.
  avatarsDir: path.join(DATA_DIR, 'avatars'),
  // Group chats: data/groups/<id>.json is the roster, <id>.jsonl the transcript.
  groupsDir: path.join(DATA_DIR, 'groups'),
  auditFile: path.join(DATA_DIR, 'audit.jsonl'),
  routinesFile: path.join(DATA_DIR, 'routines.json'),
  // Secrets live next to the data, never in config/ and never in an API response.
  secretsFile: path.join(DATA_DIR, 'secrets.json'),
  // Remote-access token + pairing code, generated on first boot.
  securityFile: path.join(DATA_DIR, 'security.json'),
  // Phones and other devices that paired with this hub (Settings -> 手机和外网).
  // Each one carries its own session token, so one can be revoked without
  // logging out everything else.
  devicesFile: path.join(DATA_DIR, 'devices.json'),
  // Approvals that were still waiting for a human (crash recovery).
  pendingFile: path.join(DATA_DIR, 'pending.json'),
  // One file per turn, so an interrupted process can be explained after a restart.
  turnsDir: path.join(DATA_DIR, 'turns'),
};

/** Create every directory the app expects. Idempotent. */
export async function ensureDirs() {
  const dirs = [
    P.configDir,
    P.botsDir,
    P.skillsDir,
    P.workspaceDir,
    P.dataDir,
    P.memoryDir,
    P.sessionsDir,
    P.avatarsDir,
    P.groupsDir,
    P.turnsDir,
  ];
  for (const dir of dirs) {
    await fsp.mkdir(dir, { recursive: true });
  }
}

/** Short, readable ids: ap_9f3c1a2b4d5e (approval), turn_..., etc. */
export function uid(prefix = 'id') {
  return `${prefix}_${crypto.randomBytes(6).toString('hex')}`;
}

export function nowIso() {
  return new Date().toISOString();
}

// ---------------------------------------------------------------------------
// Text helpers
// ---------------------------------------------------------------------------

export async function readText(file, fallback = '') {
  try {
    return await fsp.readFile(file, 'utf8');
  } catch (err) {
    if (err.code === 'ENOENT') return fallback;
    throw err;
  }
}

/**
 * Write via tmp + rename so a crash mid-write cannot leave a half-file behind.
 * Windows can throw EPERM/EBUSY when a virus scanner holds the target open for
 * a few ms, so we retry the rename a handful of times before giving up.
 *
 * `data` may be a string (with `encoding`, default utf8) or a Buffer - avatar
 * uploads are binary, and they deserve the same no-half-file guarantee.
 */
export async function writeFileAtomic(file, data, encoding = null) {
  await fsp.mkdir(path.dirname(file), { recursive: true });
  const tmp = `${file}.${process.pid}.${Date.now()}.tmp`;
  await fsp.writeFile(tmp, data, encoding);
  let lastErr;
  for (let attempt = 0; attempt < 5; attempt += 1) {
    try {
      await fsp.rename(tmp, file);
      return;
    } catch (err) {
      lastErr = err;
      if (!['EPERM', 'EBUSY', 'EACCES'].includes(err.code)) break;
      await new Promise((r) => setTimeout(r, 20 * (attempt + 1)));
    }
  }
  await fsp.rm(tmp, { force: true }).catch(() => {});
  throw lastErr;
}

export async function writeTextAtomic(file, text) {
  return writeFileAtomic(file, text, 'utf8');
}


export async function appendText(file, text) {
  await fsp.mkdir(path.dirname(file), { recursive: true });
  await fsp.appendFile(file, text, 'utf8');
}

// ---------------------------------------------------------------------------
// JSON (whole-document) storage
// ---------------------------------------------------------------------------

export async function readJson(file, fallback = null) {
  try {
    const raw = await fsp.readFile(file, 'utf8');
    if (!raw.trim()) return fallback;
    return JSON.parse(raw);
  } catch (err) {
    // A corrupt config file should degrade to the fallback, not take the server
    // down; the caller decides whether that is fatal.
    if (err.code === 'ENOENT' || err instanceof SyntaxError) return fallback;
    throw err;
  }
}

export async function writeJsonAtomic(file, value) {
  await writeTextAtomic(file, `${JSON.stringify(value, null, 2)}\n`);
}

/**
 * Synchronous atomic JSON write.
 *
 * Crash-recovery bookkeeping (pending approvals, per-turn status) uses this on
 * purpose: the whole point is that the bytes are on disk *before* the process
 * can die, so an async fire-and-forget write is not good enough. The files are
 * tiny (a handful of records), so the blocking cost is irrelevant.
 */
export function writeJsonSyncAtomic(file, value) {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  const tmp = `${file}.${process.pid}.${Date.now()}.tmp`;
  fs.writeFileSync(tmp, `${JSON.stringify(value, null, 2)}\n`, 'utf8');
  let lastErr;
  for (let attempt = 0; attempt < 5; attempt += 1) {
    try {
      fs.renameSync(tmp, file);
      return;
    } catch (err) {
      lastErr = err;
      if (!['EPERM', 'EBUSY', 'EACCES'].includes(err.code)) break;
      // Windows: a scanner or another handle can hold the target for a few ms.
      const waitUntil = Date.now() + 20 * (attempt + 1);
      while (Date.now() < waitUntil) {
        /* tiny synchronous backoff */
      }
    }
  }
  try {
    fs.rmSync(tmp, { force: true });
  } catch {
    /* ignore */
  }
  throw lastErr;
}

export function readJsonSync(file, fallback = null) {
  try {
    const raw = fs.readFileSync(file, 'utf8');
    if (!raw.trim()) return fallback;
    return JSON.parse(raw);
  } catch (err) {
    if (err.code === 'ENOENT' || err instanceof SyntaxError) return fallback;
    throw err;
  }
}

// ---------------------------------------------------------------------------
// JSONL append-only storage (sessions + audit)
// ---------------------------------------------------------------------------

export async function appendJsonl(file, record) {
  await appendText(file, `${JSON.stringify(record)}\n`);
}

/**
 * Read a JSONL file. Malformed lines (a torn write, a hand-edited file) are
 * skipped rather than thrown so one bad line cannot brick a conversation.
 */
export async function readJsonl(file, { limit = 0 } = {}) {
  let raw;
  try {
    raw = await fsp.readFile(file, 'utf8');
  } catch (err) {
    if (err.code === 'ENOENT') return [];
    throw err;
  }
  const out = [];
  for (const line of raw.split('\n')) {
    const trimmed = line.trim();
    if (!trimmed) continue;
    try {
      out.push(JSON.parse(trimmed));
    } catch {
      /* skip torn line */
    }
  }
  return limit > 0 ? out.slice(-limit) : out;
}

/** Last `n` records, cheaper to reason about than reading everything. */
export async function tailJsonl(file, n) {
  return readJsonl(file, { limit: n });
}

/**
 * Read only the *end* of a JSONL file.
 *
 * A session log grows forever, and the sidebar only wants the last meaningful
 * line, so slurping a multi-megabyte transcript to answer "what did this bot say
 * last" is the wrong shape of work. We stat the file, read the last
 * `windowBytes`, drop the first (possibly halved) line, and grow the window
 * when it contains no complete, parseable line at all (one giant tool output
 * can be wider than the window).
 *
 * Records come back oldest-first, like readJsonl; malformed lines are skipped.
 * `maxBytes` is the point where we give up rather than read the whole file.
 */
export async function readJsonlTail(file, { windowBytes = 32 * 1024, maxBytes = 2 * 1024 * 1024 } = {}) {
  let handle;
  try {
    handle = await fsp.open(file, 'r');
  } catch (err) {
    if (err.code === 'ENOENT') return [];
    throw err;
  }

  try {
    const { size } = await handle.stat();
    if (!size) return [];

    let window = Math.min(size, Math.max(1, windowBytes));
    const cap = Math.min(size, Math.max(window, maxBytes));
    for (;;) {
      const start = Math.max(0, size - window);
      const length = size - start;
      const buffer = Buffer.alloc(length);
      const { bytesRead } = await handle.read(buffer, 0, length, start);
      let text = buffer.subarray(0, bytesRead).toString('utf8');

      if (start > 0) {
        // The window probably started mid-line; that fragment is not a record.
        const firstNewline = text.indexOf('\n');
        text = firstNewline === -1 ? '' : text.slice(firstNewline + 1);
      }

      const records = [];
      for (const line of text.split('\n')) {
        const trimmed = line.trim();
        if (!trimmed) continue;
        try {
          records.push(JSON.parse(trimmed));
        } catch {
          /* a torn line, or the tail of a line we did not read from the top */
        }
      }

      // Stop when we have something to look at, when the window is the whole
      // file, or when we have hit the byte budget.
      if (records.length || start === 0 || window >= cap) return records;
      window = Math.min(cap, window * 2);
    }
  } finally {
    await handle.close().catch(() => {});
  }
}


export async function listFiles(dir, filter = () => true) {
  let names;
  try {
    names = await fsp.readdir(dir);
  } catch (err) {
    if (err.code === 'ENOENT') return [];
    throw err;
  }
  return names.filter(filter).sort();
}

export function sessionFile(botId) {
  // Bot ids are slugs we generate; still, never let one escape the sessions dir.
  const safe = String(botId).replace(/[^a-zA-Z0-9._-]/g, '_');
  return path.join(P.sessionsDir, `${safe}.jsonl`);
}

/** One JSON file per turn: data/turns/turn_<id>.json (crash-recovery record). */
export function turnFile(turnId) {
  const safe = String(turnId).replace(/[^a-zA-Z0-9._-]/g, '_');
  return path.join(P.turnsDir, `${safe}.json`);
}

// ---------------------------------------------------------------------------
// In-process event bus (feeds SSE; kept in-process on purpose)
// ---------------------------------------------------------------------------

/**
 * Minimal pub/sub for agent events. The server subscribes and forwards to SSE
 * clients; the UI's Activity tab reads the same stream. We keep a small ring
 * buffer so a browser tab that connects mid-turn still sees recent context.
 */
export class EventBus {
  constructor({ bufferSize = 200 } = {}) {
    this.subscribers = new Set();
    this.buffer = [];
    this.bufferSize = bufferSize;
  }

  subscribe(fn) {
    this.subscribers.add(fn);
    return () => this.subscribers.delete(fn);
  }

  emit(event) {
    const stamped = { ts: nowIso(), ...event };
    this.buffer.push(stamped);
    if (this.buffer.length > this.bufferSize) this.buffer.shift();
    for (const fn of this.subscribers) {
      try {
        fn(stamped);
      } catch {
        /* a broken subscriber must never break an agent turn */
      }
    }
    return stamped;
  }

  recent(limit = 50) {
    return this.buffer.slice(-limit);
  }
}

// ---------------------------------------------------------------------------
// Audit log
// ---------------------------------------------------------------------------

/**
 * Append one audit record. Every approval decision, every tool run and every
 * routine execution lands here; it is the answer to "why did it do that?".
 */
export async function audit(record) {
  const stamped = { ts: nowIso(), ...record };
  try {
    await appendJsonl(P.auditFile, stamped);
  } catch (err) {
    // Never let logging take down a turn.
    console.error('[audit] write failed:', err.message);
  }
  return stamped;
}

export async function readAudit({ limit = 100 } = {}) {
  const all = await readJsonl(P.auditFile);
  return all.slice(-limit).reverse();
}
