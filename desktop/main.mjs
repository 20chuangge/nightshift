/**
 * Lamplit desktop shell (长明 · Evenlight 1.2.146-1.2.149, Nightshift before).
 *
 * The renderer is just the web UI; all the value sits in the Node server that
 * this shell starts as a child process. Keeping them separate means a crashed
 * turn cannot take the window down, and the same server binary is what a phone
 * talks to when you pair it.
 *
 * Layout, packaged:
 *   resources/server/src/*      <- the agent (read-only, ships with the app)
 *   resources/server/config/*   <- seed config, copied to userData on first run
 *   %APPDATA%/Lamplit/          <- ASSIST_HOME: config, skills, public, workspace, data
 *                                  (%APPDATA%/Desk/ on installs from before 1.2.151)
 */
import { app, BrowserWindow, Menu, Tray, shell, dialog, nativeImage, ipcMain, session, net, Notification, clipboard } from 'electron';
import { spawn } from 'node:child_process';
import os from 'node:os';
import path from 'node:path';
import fs from 'node:fs';
import fsp from 'node:fs/promises';
import readline from 'node:readline';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { pickDataDir } from './datadir.mjs';
import { textMenuTemplate } from './textmenu.mjs';
import { senderKind, mayUse, isProgramFile } from './guard.mjs';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const isPackaged = app.isPackaged;
const DEV_URL = process.env.ASSIST_DEV_URL || '';

// The product is Lamplit (长明 · Evenlight 1.2.146-1.2.149, Nightshift before). Installs from when it was called Desk keep
// their data where it already is, %APPDATA%\Desk; a new install uses
// %APPDATA%\Lamplit (datadir.mjs). Set before anything reads it.
app.setName('Lamplit');
app.setPath('userData', pickDataDir(app.getPath('appData')));

/** Shell text follows the system language (the web UI has its own setting). */
const L = (zh, en) => (/^zh/i.test(app.getLocale?.() || process.env.LANG || '') ? zh : en);

let win = null;
let tray = null;
let child = null;
let quitting = false;
let serverPort = 0;
/** True while we kill the bundled server on purpose (port/host change). */
let restarting = false;
/** When the local server died recently (restart budget: 3 a minute). */
const crashTimes = [];
/** The machine the window shows: '' is this computer, otherwise a hub URL. */
let remoteHub = '';
/** A task a bot handed to another machine: delivered once that machine loads. */
let pendingTask = null;

// ---------------------------------------------------------------------------
// machines
//
// A machine is a Desk server: this computer's own (always running, the
// "本机" entry) or a hub on another box. Each one is its own world - own bots,
// memory and workspace - so switching machines is just pointing the window at
// another server. No relaunch: the local server keeps running underneath.
// ---------------------------------------------------------------------------

const HUB_FILE = path.join(app.getPath('userData'), 'hub.json');          // last machine used
const MACHINES_FILE = path.join(app.getPath('userData'), 'machines.json'); // every remote machine

// A packaged GUI app has nowhere to print. Anything that kills it before the
// window exists would otherwise be invisible, so keep a small boot log.
const BOOT_LOG = path.join(app.getPath('userData'), 'startup.log');
function bootLog(message) {
  try {
    fs.appendFileSync(BOOT_LOG, `${new Date().toISOString()} ${message}\n`);
  } catch { /* ignore */ }
}
process.on('uncaughtException', (err) => bootLog(`uncaught ${err?.stack || err}`));
process.on('unhandledRejection', (err) => bootLog(`rejected ${err?.stack || err}`));
bootLog(`boot packaged=${isPackaged} argv=${process.argv.slice(1).join(' ')}`);

function readHub() {
  try {
    const raw = JSON.parse(fs.readFileSync(HUB_FILE, 'utf8'));
    return typeof raw.url === 'string' && raw.url ? raw.url : '';
  } catch {
    return '';
  }
}

function writeHub(url) {
  try {
    if (!url) { fs.unlinkSync(HUB_FILE); return; }
    fs.mkdirSync(path.dirname(HUB_FILE), { recursive: true });
    fs.writeFileSync(HUB_FILE, `${JSON.stringify({ url, ts: new Date().toISOString() }, null, 2)}\n`);
  } catch { /* already gone / read-only profile */ }
}

function readMachines() {
  try {
    const raw = JSON.parse(fs.readFileSync(MACHINES_FILE, 'utf8'));
    if (Array.isArray(raw)) return raw.filter((m) => m && typeof m.url === 'string');
  } catch { /* first run */ }
  return [];
}

function writeMachines(list) {
  try {
    fs.mkdirSync(path.dirname(MACHINES_FILE), { recursive: true });
    fs.writeFileSync(MACHINES_FILE, `${JSON.stringify(list, null, 2)}\n`);
  } catch { /* a read-only profile must not break switching */ }
  // Added, renamed, removed or a new Tailscale address: tell every hub.
  clearTimeout(sharePeersTimer);
  sharePeersTimer = setTimeout(() => sharePeers().catch(() => {}), 3000);
}

/**
 * Hand every hub (this computer's and each machine's) the list of the human's
 * other machines, with the pairing token this client holds for each, so their
 * bots can hand work to each other and move files directly - even while this
 * laptop is closed. This computer's hub listens on loopback only, so it is
 * never in a remote machine's list.
 */
let sharePeersTimer = null;
async function sharePeers() {
  if (HUB_MODE || !serverPort) return;
  const machines = [];
  for (const m of readMachines()) {
    const raw = await session.defaultSession.cookies.get({ url: m.url, name: 'desk_session' }).catch(() => []);
    const token = raw[0]?.value || '';
    if (token) machines.push({ name: m.name || m.url, url: m.url, tailnetUrl: m.tailnetUrl || '', token });
  }
  // This computer, when it accepts other devices (LAN or Tailscale): it goes in
  // every other machine's list too, so all the lists are the same and a phone
  // on any machine can switch back to it.
  const self = await thisComputerAsPeer().catch(() => null);
  const targets = [{ url: localUrl().replace(/\/+$/, ''), local: true }, ...machines];
  for (const t of targets) {
    const others = machines.filter((m) => m.url !== t.url);
    if (!t.local && self) others.unshift(self);
    const base = t.local ? t.url : ((await reachMachine(t.url)) || t.url);
    // Each machine also learns the name it was given here.
    const body = t.local ? { peers: others } : { peers: others, self: { name: t.name } };
    const r = await putToMachine(base.replace(/\/+$/, ''), '/api/peers', body);
    if (!r.ok) bootLog(`share peers with ${t.url}: ${r.error}`);
  }
}

/**
 * This computer as an entry for the other machines' lists: its address and a
 * login of its own (a paired device called "其他机器（同步用）", visible and
 * removable in Settings like a phone). Null while it only listens on 127.0.0.1.
 */
const PEER_TOKEN_FILE = path.join(app.getPath('userData'), 'peer-token.json');
async function thisComputerAsPeer() {
  const local = localUrl().replace(/\/+$/, '');
  const health = await (await net.fetch(`${local}/api/health`, { signal: AbortSignal.timeout(5000) })).json();
  const url = health?.lanUrl || health?.tailnetUrl || '';
  if (!url) return null;
  let token = '';
  try { token = JSON.parse(fs.readFileSync(PEER_TOKEN_FILE, 'utf8')).token || ''; } catch { /* first time */ }
  // The login behind it can be gone (removed in Settings → 设备, or lost). Handed
  // out anyway, every other machine was refused and took this computer for
  // offline, so nothing reached it (seen: a mailbox connected on Ubuntu never
  // came here). Ask this computer's own hub, by its LAN address, whether it
  // still lets that login in; if not, make a new one.
  if (token) {
    const stillGood = await net.fetch(`${url.replace(/\/+$/, '')}/api/auth`, { headers: { authorization: `Bearer ${token}` }, signal: AbortSignal.timeout(5000) })
      .then((r) => r.json()).then((a) => !(a && a.required && a.authorized === false)).catch(() => true);
    if (!stillGood) {
      bootLog('peer token no longer accepted here: pairing a new one');
      token = '';
    }
  }
  if (!token) {
    // A one-time link from this computer's own hub, spent right away on a device of its own.
    const link = await (await net.fetch(`${local}/api/pairing/link`, { method: 'POST', signal: AbortSignal.timeout(5000) })).json();
    const code = link?.url ? new URL(link.url).searchParams.get('pair') : '';
    if (!code) return null;
    const paired = await (await net.fetch(`${local}/api/pair`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ code, client: 'app', deviceName: '其他机器（同步用）' }),
      signal: AbortSignal.timeout(5000),
    })).json();
    token = paired?.token || '';
    if (!token) return null;
    try { fs.writeFileSync(PEER_TOKEN_FILE, JSON.stringify({ token })); } catch { /* asked again next time */ }
  }
  return { name: health.name || os.hostname(), url, tailnetUrl: health.tailnetUrl || '', token };
}

/** Add or update one machine. A name the human gave is never overwritten. */
function rememberMachine(url, patch = {}) {
  const norm = normalizeHub(url);
  if (!norm) return null;
  const list = readMachines();
  const prev = list.find((m) => m.url === norm);
  let fallbackName = norm;
  try { fallbackName = new URL(norm).hostname; } catch { /* keep url */ }
  const row = { ...prev, ...patch, url: norm, name: patch.name || prev?.name || fallbackName };
  writeMachines([row, ...list.filter((m) => m.url !== norm)].slice(0, 30));
  return row;
}

function normalizeHub(url) {
  const raw = String(url || '').trim();
  if (!raw) return '';
  const withScheme = /^https?:\/\//i.test(raw) ? raw : `http://${raw}`;
  try {
    const u = new URL(withScheme);
    if (!u.port && u.protocol === 'http:') u.port = '4390';
    return `${u.protocol}//${u.host}`;
  } catch {
    return '';
  }
}

/** Cheap liveness probe. A hub that requires pairing answers 401 to
 *  /api/health, which still proves the server is alive — treating that as
 *  "unreachable" would make a perfectly good hub look dead. */
async function probeHub(url) {
  try {
    const res = await fetch(`${url.replace(/\/$/, '')}/api/health`, { signal: AbortSignal.timeout(3500) });
    return res.ok || res.status === 401 || res.status === 403;
  } catch {
    return false;
  }
}

/**
 * A system proxy (Clash and the like) usually bypasses 192.168.* and 10.* but
 * not Tailscale's 100.64.0.0/10, so the window's requests to a machine's
 * Tailscale address would go to the proxy and fail. When that is the case,
 * this app's own session keeps the same proxy for everything else and goes
 * direct to private and Tailscale addresses. The system setting is untouched.
 */
let tailnetDirectDone = false;
async function tailnetDirect() {
  if (tailnetDirectDone) return;
  try {
    const viaTailnet = await session.defaultSession.resolveProxy('http://100.64.0.1/');
    if (/^DIRECT/i.test(viaTailnet.trim())) { tailnetDirectDone = true; return; }
    const m = /PROXY\s+([^;\s]+)/i.exec(viaTailnet) || /SOCKS5?\s+([^;\s]+)/i.exec(viaTailnet);
    if (!m) return;
    const scheme = /^SOCKS/i.test(viaTailnet.trim()) ? 'socks5://' : '';
    await session.defaultSession.setProxy({
      mode: 'fixed_servers',
      proxyRules: `${scheme}${m[1]}`,
      proxyBypassRules: '<local>;localhost;127.0.0.0/8;10.0.0.0/8;172.16.0.0/12;192.168.0.0/16;100.64.0.0/10;*.local',
    });
    tailnetDirectDone = true;
    bootLog(`system proxy ${m[1]} does not bypass Tailscale: going direct to 100.64.0.0/10 in this app`);
  } catch (err) { bootLog(`proxy bypass for Tailscale failed: ${err.message}`); }
}

/** Learn (every few minutes) the Tailscale address each machine reports. */
const tailnetLearned = new Map();
async function learnTailnet(url) {
  if (!url || Date.now() - (tailnetLearned.get(url) || 0) < 5 * 60 * 1000) return;
  tailnetLearned.set(url, Date.now());
  try {
    // net.fetch: this app's session, so the pairing cookie goes along.
    const res = await net.fetch(`${url.replace(/\/$/, '')}/api/health`, { signal: AbortSignal.timeout(5000) });
    if (!res.ok) return;
    const health = await res.json();
    const known = readMachines().find((m) => m.url === url)?.tailnetUrl || '';
    if ((health.tailnetUrl || '') !== known) patchMachine(url, { tailnetUrl: health.tailnetUrl || '' });
  } catch { /* off or away */ }
}

/** Update one machine's record in place (keeps the list order). */
function patchMachine(url, patch) {
  const list = readMachines();
  const i = list.findIndex((m) => m.url === url);
  if (i < 0) return;
  list[i] = { ...list[i], ...patch };
  writeMachines(list);
}

/**
 * The address to use for a machine right now: its LAN address, or - away from
 * home, when that does not answer - its Tailscale address (100.x, learned from
 * the machine itself). The pairing cookie is copied to that address so the
 * human never pairs twice. Returns the base URL, or '' when neither answers.
 */
async function reachMachine(url) {
  // DESK_FORCE_TAILNET=1 acts as if the LAN were unreachable (testing away-from-home at home).
  if (process.env.DESK_FORCE_TAILNET !== '1' && await probeHub(url)) return url;
  const alt = readMachines().find((m) => m.url === url)?.tailnetUrl;
  if (!alt || !(await probeHub(alt))) return '';
  await tailnetDirect();
  try {
    for (const c of await session.defaultSession.cookies.get({ url })) {
      await session.defaultSession.cookies.set({
        url: alt, name: c.name, value: c.value, path: c.path || '/', httpOnly: c.httpOnly,
        ...(c.expirationDate ? { expirationDate: c.expirationDate } : {}), ...(c.sameSite ? { sameSite: c.sameSite } : {}),
      });
    }
  } catch (err) { bootLog(`cookie copy to ${alt} failed: ${err.message}`); }
  bootLog(`${url} unreachable, using its Tailscale address ${alt}`);
  return alt;
}

/**
 * Pair this client with a hub using the code its installer printed, and keep
 * the session cookie in Electron's store. The human never sees a pairing
 * screen for a machine Desk configured itself.
 */
async function pairWith(url, code) {
  if (!code) return false;
  try {
    const res = await fetch(`${url}/api/pair`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ code: String(code) }),
      signal: AbortSignal.timeout(5000),
    });
    if (!res.ok) return false;
    const match = /desk_session=([^;]+)/.exec(res.headers.get('set-cookie') || '');
    if (!match) return false;
    await session.defaultSession.cookies.set({
      url,
      name: 'desk_session',
      value: decodeURIComponent(match[1]),
      httpOnly: true,
      sameSite: 'lax',
      expirationDate: Math.floor(Date.now() / 1000) + 10 * 365 * 24 * 3600,
    });
    return true;
  } catch (err) {
    bootLog(`pair ${url} failed: ${err?.message || err}`);
    return false;
  }
}

// ---------------------------------------------------------------------------
// paths
// ---------------------------------------------------------------------------

const RES = isPackaged ? process.resourcesPath : path.resolve(__dirname, '..');
const SERVER_DIR = isPackaged ? path.join(RES, 'server') : path.resolve(__dirname, '..');
// Packaged: everything writable lives in %APPDATA%/Desk. Dev: use the repo as-is,
// so `npm run desktop` behaves exactly like `npm start`.
const HOME = isPackaged ? app.getPath('userData') : SERVER_DIR;

async function exists(p) {
  try { await fsp.access(p); return true; } catch { return false; }
}

async function copyDir(from, to, { overwrite = true } = {}) {
  await fsp.mkdir(to, { recursive: true });
  for (const entry of await fsp.readdir(from, { withFileTypes: true })) {
    const src = path.join(from, entry.name);
    const dst = path.join(to, entry.name);
    if (entry.isDirectory()) await copyDir(src, dst, { overwrite });
    else if (overwrite || !(await exists(dst))) await fsp.copyFile(src, dst);
  }
}

/** Seed the writable home, refresh code assets (public/) on every launch.
 *
 * Only meaningful when packaged: in dev, HOME *is* the repo, so copying into it
 * would delete the very files we are reading from. */
async function prepareHome() {
  if (!isPackaged || path.resolve(HOME) === path.resolve(SERVER_DIR)) return;
  await fsp.mkdir(HOME, { recursive: true });
  for (const [dir, overwrite] of [['config', false], ['skills', false], ['workspace', false]]) {
    const src = path.join(SERVER_DIR, dir);
    if (await exists(src)) await copyDir(src, path.join(HOME, dir), { overwrite });
  }
  const pub = path.join(SERVER_DIR, 'public');
  if (await exists(pub)) {
    await fsp.rm(path.join(HOME, 'public'), { recursive: true, force: true });
    await copyDir(pub, path.join(HOME, 'public'));
  }
  await fsp.mkdir(path.join(HOME, 'data'), { recursive: true });
}

// ---------------------------------------------------------------------------
// hub mode: `Desk.exe --hub` turns this install into a headless hub (no window),
// reachable from other devices. Used on the idle PC / VM. Still uses the same
// bundled runtime, so the VM needs no separate Node install.
// ---------------------------------------------------------------------------

const HUB_MODE = process.argv.includes('--hub');
const HUB_HOST = '0.0.0.0';

/*
 * The local server's port is part of the window's identity: localStorage (the
 * machine list, layout prefs) is keyed by origin, so a random port per launch
 * would be a new profile every time. But a fixed port is not always free:
 * Windows with Hyper-V/WSL reserves random port ranges at every boot (it once
 * took 4296-4395, and with it 4390). So: a short list of well-spread
 * candidates, and the one that worked is remembered and tried first.
 */
const PORT_FILE = path.join(app.getPath('userData'), 'port.json');
const PORT_CANDIDATES = [4390, 14390, 24390, 34390, 44390, 54390];

/**
 * "允许手机连接" (Settings → 手机和外网). Off by default: a fresh install only
 * listens on 127.0.0.1. Turning it on rebinds the bundled server to 0.0.0.0 so
 * a phone on the home network - or on Tailscale, away from home - can reach it.
 * Pairing is still required, and only paired devices get in.
 */
const REMOTE_FILE = path.join(app.getPath('userData'), 'remote.json');

function savedRemote() {
  try {
    return Boolean(JSON.parse(fs.readFileSync(REMOTE_FILE, 'utf8')).allowRemote);
  } catch {
    return false;
  }
}

function writeRemote(allowRemote) {
  try {
    fs.writeFileSync(REMOTE_FILE, `${JSON.stringify({ allowRemote: Boolean(allowRemote) })}\n`);
  } catch (err) {
    bootLog(`remote.json write failed: ${err.message}`);
  }
}

function savedPort() {
  try { return Number(JSON.parse(fs.readFileSync(PORT_FILE, 'utf8')).port) || 0; } catch { return 0; }
}

/** Start the local server on the first port that binds.
 *  `host` decides the network surface: 127.0.0.1 (this computer only) or
 *  0.0.0.0 (phones on the LAN / Tailscale, Settings → 允许手机连接). */
async function startServer({ host = '127.0.0.1', pinned = false } = {}) {
  if (pinned || process.env.PORT) return launchServer({ host, port: process.env.PORT || '0' });
  const tried = [...new Set([savedPort(), ...PORT_CANDIDATES].filter(Boolean))];
  let lastError = null;
  for (const port of tried) {
    try {
      const bound = await launchServer({ host, port: String(port) });
      if (bound !== savedPort()) {
        try { fs.writeFileSync(PORT_FILE, `${JSON.stringify({ port: bound })}\n`); } catch { /* read-only profile */ }
      }
      return bound;
    } catch (err) {
      lastError = err;
      bootLog(`port ${port} unavailable: ${err.message}`);
    }
  }
  // Every candidate is reserved: take any free port rather than not start.
  bootLog(`all pinned ports unavailable (${lastError?.message}); using a free port`);
  return launchServer({ host, port: '0' });
}

/** One server process. Resolves with its port once it is listening; rejects
 *  if it exits first. A crash later restarts it on the same port. */
function launchServer({ host, port }) {
  const entry = path.join(SERVER_DIR, 'src', 'server.mjs');
  if (!fs.existsSync(entry)) throw new Error(`server entry missing: ${entry}`);

  child = spawn(process.execPath, [entry], {
    cwd: SERVER_DIR,
    env: {
      ...process.env,
      ELECTRON_RUN_AS_NODE: '1',
      ASSIST_HOME: HOME,
      PORT: port,
      HOST: host,
      ...(host === HUB_HOST ? { ASSIST_ALLOW_REMOTE: '1' } : {}),
    },
    stdio: ['ignore', 'pipe', 'pipe'],
    windowsHide: true,
  });
  const proc = child;
  let ready = false;
  let stderrTail = '';

  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error('server did not become ready in 20s')), 20000);

    readline.createInterface({ input: proc.stdout }).on('line', (line) => {
      // the server prints exactly one machine-readable ready line
      if (line.startsWith('{')) {
        try {
          const msg = JSON.parse(line);
          if (msg.event === 'ready' && msg.port) {
            clearTimeout(timer);
            ready = true;
            serverPort = msg.port;
            resolve(msg.port);
          }
        } catch { /* human log line, ignore */ }
      }
    });

    proc.stderr.on('data', (buf) => {
      const text = buf.toString().trim();
      if (!text) return;
      console.error('[server]', text);
      stderrTail = `${stderrTail}\n${text}`.slice(-1500);
    });

    proc.on('exit', (code, signal) => {
      if (quitting) return;
      // Deliberate rebind (允许手机连接): this exact process was told to stop.
      if (restarting || proc.__deliberate) return;
      if (!ready) {
        clearTimeout(timer);
        // Node prints the error object over many lines; keep the one that names it.
        const lines = stderrTail.split('\n').map((l) => l.trim()).filter(Boolean);
        reject(new Error(lines.find((l) => /\bError\b|EACCES|EADDRINUSE/.test(l)) || lines.pop() || `exit ${code ?? signal}`));
        return;
      }
      // It was running and died: keep the app alive and bring the server back
      // on the same port (the window reconnects by itself). Give up only if it
      // keeps dying.
      bootLog(`server exited code=${code ?? signal} after start:${stderrTail.slice(-600)}`);
      crashTimes.push(Date.now());
      while (crashTimes.length && Date.now() - crashTimes[0] > 60_000) crashTimes.shift();
      if (crashTimes.length <= 3) {
        launchServer({ host, port: String(serverPort) }).catch((err) => bootLog(`restart failed: ${err.message}`));
        return;
      }
      if (win && !win.isDestroyed()) {
        dialog.showErrorBox(
          L('Lamplit 的后台进程退出了', 'The Lamplit server stopped'),
          L(`一分钟内连续退出了好几次（退出码 ${code ?? signal}）。重新打开 Lamplit 即可恢复；详情见 ${BOOT_LOG}`, `It stopped several times in a minute (exit code ${code ?? signal}). Reopen Lamplit to recover; details in ${BOOT_LOG}`),
        );
      }
      app.quit();
    });

    proc.on('error', reject);
  });
}

/**
 * Rebind the bundled server (127.0.0.1 <-> 0.0.0.0) without restarting the app.
 * The window keeps its origin as long as the port survives; if the port had to
 * change, the window is pointed at the new one.
 */
async function restartLocalServer(host) {
  const previous = serverPort;
  if (child && !child.killed) {
    restarting = true;
    const dying = child;
    dying.__deliberate = true;
    await new Promise((resolve) => {
      const timer = setTimeout(resolve, 4000);
      const done = () => {
        clearTimeout(timer);
        resolve();
      };
      dying.once('exit', done);
      try {
        dying.kill();
      } catch {
        done();
      }
    });
    restarting = false;
  }
  const port = await startServer({ host });
  serverPort = port;
  bootLog(`server rebound to ${host}:${port}`);
  if (win && !win.isDestroyed() && port !== previous) {
    win.loadURL(`http://127.0.0.1:${port}/`).catch((err) => bootLog(`reload after rebind failed: ${err.message}`));
  }
  return { port, host };
}

// ---------------------------------------------------------------------------
// window / tray / menu
// ---------------------------------------------------------------------------

/**
 * Right-click: copy, read aloud, translate, ask the assistant, search on
 * selected text; cut / paste / select all in a text box (textmenu.mjs).
 * Reading, translating and asking run in the page (window.lamplitSelection),
 * so they use this machine's voice and model. Nothing selected and no text
 * box: no menu (the page's own right-click menus, e.g. on a bot, still work).
 */
function attachTextMenu(target) {
  target.webContents.on('context-menu', async (_event, params) => {
    const selected = String(params.selectionText || '').trim();
    let hasPageTools = false;
    try {
      hasPageTools = (await target.webContents.executeJavaScript('typeof window.lamplitSelection')) === 'object';
    } catch { /* page busy or gone */ }
    const call = (fn) => target.webContents
      .executeJavaScript(`window.lamplitSelection.${fn}(${JSON.stringify(selected.slice(0, 6000))})`)
      .catch((err) => bootLog(`text menu ${fn}: ${err.message}`));
    const actions = {
      speak: () => call('speak'),
      translate: () => call('translate'),
      ask: () => call('ask'),
      search: () => shell.openExternal(`https://www.bing.com/search?q=${encodeURIComponent(selected.slice(0, 300))}`),
    };
    const zh = /^zh/i.test(app.getLocale?.() || process.env.LANG || '');
    const template = textMenuTemplate(params, { hasPageTools, zh }).map((item) => (item.id && actions[item.id] ? { ...item, click: actions[item.id] } : item));
    if (!template.length) return;
    Menu.buildFromTemplate(template).popup({ window: target });
  });
}

function createWindowFor(url, bounds = null) {
  win = new BrowserWindow({
    ...(bounds || { width: 1280, height: 860 }),
    minWidth: 900,
    minHeight: 600,
    backgroundColor: '#0a0a0a',
    title: 'Lamplit',
    icon: path.join(__dirname, 'build', 'icon.png'),
    autoHideMenuBar: true,
    show: false,
    // No OS title bar: the web UI draws its own (Grok-Bot style). The thin
    // native frame on Windows also goes away with `frame: false`.
    frame: false,
    titleBarStyle: 'hidden',
    webPreferences: {
      preload: path.join(__dirname, 'shell-preload.cjs'),
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: true,
      spellcheck: true,
    },
  });

  const self = win;
  self.once('ready-to-show', () => self.show());
  // A replaced window must not clear the reference to its replacement.
  self.on('closed', () => { if (win === self) win = null; });
  // Leave a trail when a page fails, so a stuck switch can be explained.
  self.webContents.on('did-fail-load', (_e, code, desc, failedUrl, isMainFrame) => {
    if (isMainFrame && code !== -3) bootLog(`load failed ${code} ${desc} ${failedUrl}`);
  });
  self.webContents.on('render-process-gone', (_e, details) => bootLog(`renderer gone: ${details.reason}`));
  // A frozen page cannot draw its own close button or answer a quit. After a
  // few seconds, ask like a browser does: wait, reload, or quit.
  let hangTimer = null;
  let hangDialog = false;
  self.on('unresponsive', () => {
    let page = '';
    try { page = self.webContents.getURL(); } catch { /* gone */ }
    bootLog(`window unresponsive on ${page}`);
    if (hangTimer || hangDialog) return;
    hangTimer = setTimeout(async () => {
      hangTimer = null;
      if (self.isDestroyed() || quitting) return;
      hangDialog = true;
      const { response } = await dialog.showMessageBox(self, {
        type: 'warning',
        title: 'Lamplit',
        message: L('页面没有响应', 'The page is not responding'),
        detail: L('可以再等一会儿，或者重新加载这一页（聊天记录不会丢）。', 'Wait a little longer, or reload the page (your chats are kept).'),
        buttons: [L('等待', 'Wait'), L('重新加载', 'Reload'), L('退出 Lamplit', 'Quit Lamplit')],
        defaultId: 1,
        cancelId: 0,
        noLink: true,
      }).catch(() => ({ response: 0 }));
      hangDialog = false;
      if (self.isDestroyed()) return;
      if (response === 1) {
        bootLog('hang → reload');
        try { self.webContents.forcefullyCrashRenderer(); } catch { /* already gone */ }
        self.webContents.reload();
      } else if (response === 2) {
        quitNow();
      }
    }, 5000);
  });
  self.on('responsive', () => {
    if (hangTimer) { clearTimeout(hangTimer); hangTimer = null; bootLog('window responsive again'); }
  });

  // external links open in the real browser, never inside the app window
  win.webContents.setWindowOpenHandler(({ url }) => {
    if (url.startsWith('http')) shell.openExternal(url);
    return { action: 'deny' };
  });
  // The window only ever shows a hub: a link to anywhere else opens in the
  // browser, so no outside page gets window.desk (SEC-09).
  win.webContents.on('will-navigate', (e, url) => {
    if (pageKind(url) !== 'other') return;
    e.preventDefault();
    if (/^https?:/i.test(url)) shell.openExternal(url);
  });

  // Frameless: the page draws the title bar and its own traffic buttons.
  // `?shell=desk` tells the web UI it is inside the desktop shell (it is also
  // opened in plain browsers, where the buttons must not appear).
  const target = new URL(url);
  target.searchParams.set('shell', 'desk');
  win.loadURL(target.toString());
  attachTextMenu(win);

  // Safety net for an older UI (e.g. a hub that has not been updated yet):
  // without traffic buttons a frameless window cannot be closed. The page's own
  // markup wins when present; this only fills the gap.
  win.webContents.on('did-finish-load', async () => {
    try {
      const hasBridge = await win.webContents.executeJavaScript('typeof window.deskShell');
      if (hasBridge !== 'object') {
        bootLog('shell preload missing — window controls unavailable');
        return;
      }
      bootLog('shell bridge ready (frameless title bar)');
    } catch {
      return;
    }
    win.webContents.executeJavaScript(`
      (() => {
        if (!window.deskShell || !document.body || document.getElementById('winbtns')) return;
        document.body.classList.add('shell');
        const style = document.createElement('style');
        style.textContent = \`
          body.shell .topbar { -webkit-app-region: drag; }
          body.shell .topbar button, body.shell .topbar .pill { -webkit-app-region: no-drag; }
          .winbtns { display: inline-flex; gap: 2px; margin-left: 6px; }
          .winbtns button { width: 36px; height: 28px; border: 0; border-radius: 7px;
            background: transparent; color: #98a1b2; font: 13px system-ui; cursor: default; }
          .winbtns button:hover { background: rgba(255,255,255,.07); color: #e6e8ee; }
          .winbtns .win-close:hover { background: #e11d48; color: #fff; }
        \`;
        document.head.appendChild(style);
        const box = document.createElement('div');
        box.className = 'winbtns';
        box.id = 'winbtns';
        box.innerHTML = '<button data-win="min">&#8211;</button>' +
          '<button data-win="max">&#9633;</button>' +
          '<button data-win="close" class="win-close">&#10005;</button>';
        box.addEventListener('click', (e) => {
          const act = e.target.closest('[data-win]')?.dataset.win;
          if (act === 'min') window.deskShell.minimize();
          else if (act === 'max') window.deskShell.toggleMaximize();
          else if (act === 'close') window.deskShell.close();
        });
        (document.querySelector('header.topbar') || document.body).appendChild(box);
      })();
    `).catch(() => { /* a page that blocks scripts just keeps Alt+F4 */ });
  });
  return win;
}

function localUrl() {
  return `http://127.0.0.1:${serverPort}/`;
}

/** Whose page is this URL: this computer's hub, an added machine, or something else (SEC-09). */
function pageKind(url) {
  const machineOrigins = readMachines().flatMap((m) => [m.url, m.tailnetUrl]).concat([remoteHub, remoteReach]).filter(Boolean);
  return senderKind(url, { localOrigin: serverPort ? localUrl() : '', machineOrigins });
}

/** ipcMain.handle, but only for the pages allowed to make that call. */
function handle(channel, fn) {
  ipcMain.handle(channel, (event, ...args) => {
    const from = event?.senderFrame?.url || '';
    if (!mayUse(channel, pageKind(from))) {
      bootLog(`refused ${channel} from ${from.slice(0, 120)}`);
      return { ok: false, error: 'not allowed from this page' };
    }
    return fn(event, ...args);
  });
}

// The address actually in use for remoteHub (its Tailscale address when away).
let remoteReach = '';

function showWindow() {
  if (!win) {
    createWindowFor((remoteHub && remoteReach) || remoteHub || localUrl());
    return;
  }
  if (win.isMinimized()) win.restore();
  win.show();
  win.focus();
}

function machineLabel(url) {
  return readMachines().find((m) => m.url === url)?.name || url.replace(/^https?:\/\//, '');
}

/**
 * Point the window at another machine ('' = this computer). The bots, memory
 * and screen all come from that machine's server, so this IS the switch.
 */
async function switchTo(url, message = '') {
  const target = url ? normalizeHub(url) : '';
  if (url && !target) return { ok: false, error: '地址格式不对' };
  const reach = target ? await reachMachine(target) : '';
  if (target && !reach) {
    return { ok: false, error: L(`连不上 ${machineLabel(target)}（机器关机了，或网络不通）`, `Can't reach ${machineLabel(target)} (it's off, or the network is down)`) };
  }
  remoteHub = target;
  remoteReach = reach;
  pendingTask = String(message || '').trim() ? { machine: target, text: String(message).trim().slice(0, 4000) } : null;
  writeHub(target);
  if (target) rememberMachine(target, { lastUsed: new Date().toISOString() });
  bootLog(`switch → ${target || 'local'}`);
  refreshChrome();
  if (win && !win.isDestroyed()) {
    const next = new URL(reach || target || localUrl());
    next.searchParams.set('shell', 'desk');
    const seq = ++switchSeq;
    win.loadURL(next.toString()).catch((err) => {
      // ERR_ABORTED just means a newer switch replaced this one.
      if (seq === switchSeq) bootLog(`switch load error: ${err.code || err.message}`);
    });
    watchSwitch(seq, next.origin);
  } else {
    showWindow();
  }
  if (target) setTimeout(() => autoUpdateMachine(readMachines().find((m) => m.url === target)), 3000);
  return { ok: true };
}

let switchSeq = 0;

/**
 * Seen in the field: the switch was accepted, but the window kept showing
 * the old machine and no page ever loaded again. If the new machine's page has
 * not taken over in 10 s, open a fresh window on it in the same place.
 */
function watchSwitch(seq, origin) {
  setTimeout(() => {
    if (seq !== switchSeq || !win || win.isDestroyed()) return;
    let current = '';
    try { current = new URL(win.webContents.getURL()).origin; } catch { /* about:blank */ }
    if (current === origin && !win.webContents.isLoading()) return;
    bootLog(`switch stuck on ${current || 'nothing'} → reopening the window on ${origin}`);
    const old = win;
    const bounds = old.getBounds();
    const maximized = old.isMaximized();
    createWindowFor(remoteHub || localUrl(), bounds);
    if (maximized) win.maximize();
    old.destroy();
  }, 10000);
}

function machinesMenu() {
  return [
    { label: L('本机（这台电脑）', 'This computer'), type: 'radio', checked: !remoteHub, click: () => switchTo('') },
    ...readMachines().map((m) => ({
      label: m.name,
      type: 'radio',
      checked: m.url === remoteHub,
      click: () => switchTo(m.url).then((r) => { if (!r.ok) dialog.showErrorBox(L('切换失败', 'Switch failed'), r.error); }),
    })),
  ];
}

/** Tray and app menu both list the machines; rebuild them after any change. */
function refreshChrome() {
  if (win && !win.isDestroyed()) win.setTitle(remoteHub ? `${'Lamplit'} — ${machineLabel(remoteHub)}` : 'Lamplit');
  buildMenu();
  if (!tray) return;
  tray.setToolTip(remoteHub ? `${'Lamplit'} → ${machineLabel(remoteHub)}` : 'Lamplit');
  tray.setContextMenu(Menu.buildFromTemplate([
    { label: L('打开 Lamplit', 'Open Lamplit'), click: showWindow },
    { type: 'separator' },
    ...machinesMenu(),
    { type: 'separator' },
    { label: L('打开数据目录', 'Open data folder'), click: () => shell.openPath(HOME) },
    { label: L('退出', 'Quit'), click: () => quitNow() },
  ]));
}

function createTray() {
  const icon = nativeImage.createFromPath(path.join(__dirname, 'build', 'icon.png')).resize({ width: 16, height: 16 });
  tray = new Tray(icon);
  if (HUB_MODE) {
    // A headless hub has no window and no machine list, only its data folder.
    tray.setContextMenu(Menu.buildFromTemplate([
      { label: L('打开数据目录', 'Open data folder'), click: () => shell.openPath(HOME) },
      { label: L('退出', 'Quit'), click: () => quitNow() },
    ]));
    return;
  }
  tray.on('double-click', showWindow);
  refreshChrome();
}

function buildMenu() {
  if (HUB_MODE) return;
  Menu.setApplicationMenu(Menu.buildFromTemplate([
    {
      label: 'Lamplit',
      submenu: [
        { label: L('机器', 'Machines'), submenu: machinesMenu() },
        { type: 'separator' },
        { label: L('打开数据目录', 'Open data folder'), click: () => shell.openPath(HOME) },
        { label: L('重新加载界面', 'Reload'), accelerator: 'CmdOrCtrl+R', click: () => win?.reload() },
        { label: L('开发者工具', 'Developer tools'), accelerator: 'F12', click: () => win?.webContents.toggleDevTools() },
        { type: 'separator' },
        { label: L('退出', 'Quit'), accelerator: 'CmdOrCtrl+Q', click: () => quitNow() },
      ],
    },
    { label: L('编辑', 'Edit'), role: 'editMenu' },
    {
      label: L('视图', 'View'),
      submenu: [
        { role: 'resetZoom' }, { role: 'zoomIn' }, { role: 'zoomOut' },
        { type: 'separator' }, { role: 'togglefullscreen' },
      ],
    },
  ]));
}

// ---------------------------------------------------------------------------
// window controls (frameless window: the page asks, we act)
// ---------------------------------------------------------------------------

ipcMain.on('shell:minimize', (event) => {
  BrowserWindow.fromWebContents(event.sender)?.minimize();
});
ipcMain.on('shell:toggle-maximize', (event) => {
  const win = BrowserWindow.fromWebContents(event.sender);
  if (!win) return;
  if (win.isMaximized()) win.unmaximize();
  else win.maximize();
});
ipcMain.on('shell:close', (event) => {
  BrowserWindow.fromWebContents(event.sender)?.close();
});

// Machine list for the web UI (sidebar switcher, Settings → 机器).
handle('desk:list-machines', () => ({
  current: remoteHub || '',
  local: !remoteHub,
  // This computer's own hub: an app's sign-in comes back to it (loopback is the
  // only plain-http address apps accept) and it passes the answer on.
  localUrl: serverPort ? localUrl().replace(/\/+$/, '') : '',
  // each row may carry tailnetUrl: the same machine reached over Tailscale
  machines: readMachines(),
}));

// Sidebar badge: what is waiting on the machines this window is NOT showing.
// The page cannot reach them (other origins); this process has their cookies.
handle('desk:machines-attention', async () => {
  // Every few minutes: pick up Tailscale addresses (it may have been installed since).
  for (const m of readMachines()) learnTailnet(m.url);
  const others = [{ name: L('本机', 'This computer'), url: 'local', target: localUrl() }]
    .concat(readMachines().map((m) => ({ name: m.name, url: m.url, target: m.url })))
    .filter((m) => (m.url === 'local' ? Boolean(remoteHub) : m.url !== remoteHub));
  return Promise.all(others.map(async (m) => {
    try {
      // A remote machine may only answer on its Tailscale address (away from home).
      let base = String(m.target);
      if (m.url !== 'local' && !(await probeHub(base))) base = (await reachMachine(m.url)) || base;
      const res = await net.fetch(`${base.replace(/\/+$/, '')}/api/attention`, { signal: AbortSignal.timeout(6000) });
      if (!res.ok) return { name: m.name, url: m.url, reachable: false };
      const a = await res.json();
      return { name: m.name, url: m.url, reachable: true, needsYou: a.needsYou || 0, unread: a.unread || 0, working: a.working || 0 };
    } catch {
      return { name: m.name, url: m.url, reachable: false };
    }
  }));
});

// System notification from the page (a bot needs the human); clicking it
// brings the window back and tells the page what it was about.
const liveNotes = new Set();
handle('desk:clipboard-read', () => clipboard.readText());
handle('desk:open-external', async (_event, url) => {
  if (!/^https?:\/\//i.test(String(url))) return false;
  await shell.openExternal(String(url));
  return true;
});
handle('desk:clipboard-write', (_event, text) => { clipboard.writeText(String(text ?? '').slice(0, 100000)); return true; });

handle('desk:notify', (_event, { title = '', body = '', tag = '' } = {}) => {
  // The taskbar button flashes until the window is used: this works even when
  // Windows notifications are turned off (they often are).
  if (win && !win.isDestroyed() && !win.isFocused()) {
    win.flashFrame(true);
    win.once('focus', () => { if (!win.isDestroyed()) win.flashFrame(false); });
  }
  if (!Notification.isSupported()) return false;
  const note = new Notification({ title: String(title).slice(0, 120), body: String(body).slice(0, 240) });
  liveNotes.add(note);
  const forget = () => liveNotes.delete(note);
  note.on('click', () => {
    forget();
    showWindow();
    if (win && !win.isDestroyed()) {
      win.webContents.executeJavaScript(`window.deskNotificationClick && window.deskNotificationClick(${JSON.stringify(String(tag))})`).catch(() => {});
    }
  });
  note.on('close', forget);
  note.show();
  return true;
});

handle('desk:switch-hub', (_event, url, message) => switchTo(url, message));
handle('desk:use-local', (_event, message) => switchTo('', message));

// Settings → 手机和外网 → 允许手机连接. Rebinds the bundled server so phones on
// the home network or on Tailscale can reach it; pairing is still required.
handle('desk:set-remote', async (_event, allowRemote) => {
  const want = Boolean(allowRemote);
  if (HUB_MODE) {
    writeRemote(true);
    return { ok: true, remote: true, port: serverPort, host: HUB_HOST, hubMode: true };
  }
  writeRemote(want);
  const host = want ? HUB_HOST : '127.0.0.1';
  const result = await restartLocalServer(host);
  return { ok: true, remote: want, port: result.port, host };
});
// Handed over once, and only to the machine it was meant for.
handle('desk:take-pending-message', () => {
  if (!pendingTask || pendingTask.machine !== remoteHub) return '';
  const { text } = pendingTask;
  pendingTask = null;
  return text;
});

// A machine Desk just provisioned: remember it under the human's name and pair
// with the code its installer printed, so switching to it is one click.
handle('desk:add-machine', async (_event, { url, name, pairCode } = {}) => {
  const target = normalizeHub(url);
  if (!target) return { ok: false, error: '地址格式不对' };
  const paired = await pairWith(target, pairCode);
  rememberMachine(target, { name: String(name || '').trim().slice(0, 40) || undefined, addedAt: new Date().toISOString() });
  refreshChrome();
  return { ok: true, url: target, paired };
});

/*
 * One model for every machine: copy this computer's model settings (and key)
 * to each remote machine. Runs here, not in the page, because the page can
 * neither read the key nor talk to other machines; net.fetch carries the
 * pairing cookies this app already holds for each of them.
 */
handle('desk:sync-model', async () => {
  let model;
  try {
    const settings = JSON.parse(fs.readFileSync(path.join(HOME, 'config', 'settings.json'), 'utf8'));
    let apiKey = '';
    try { apiKey = String(JSON.parse(fs.readFileSync(path.join(HOME, 'data', 'secrets.json'), 'utf8')).apiKey || ''); } catch { /* no key */ }
    model = { provider: settings.provider, baseUrl: settings.baseUrl, model: settings.model, apiKey };
  } catch (err) {
    return { ok: false, error: L(`读不到这台电脑的模型设置：${err.message}`, `Can't read this computer's model settings: ${err.message}`) };
  }
  if (!model.provider || model.provider === 'mock') {
    return { ok: false, error: L('这台电脑还没配置真实模型，先在本机的「设置 → 模型」里配好。', 'This computer has no real model yet; set one up under Settings → Model on this computer first.') };
  }
  // The voice key rides along when this computer has one.
  let voice = null;
  try {
    const v = JSON.parse(fs.readFileSync(path.join(HOME, 'data', 'voice.json'), 'utf8'));
    if (v?.apiKey) voice = { baseUrl: v.baseUrl || '', model: v.model || '', apiKey: v.apiKey };
  } catch { /* no voice key here */ }
  let vision = null;
  try {
    const v = JSON.parse(fs.readFileSync(path.join(HOME, 'data', 'vision.json'), 'utf8'));
    if (v?.apiKey) vision = { baseUrl: v.baseUrl || '', model: v.model || '', apiKey: v.apiKey };
  } catch { /* no vision key here */ }
  const results = [];
  for (const machine of readMachines()) {
    const r = await putToMachine(machine.url, '/api/settings', model);
    if (r.ok && voice) {
      const v = await putToMachine(machine.url, '/api/voice', voice);
      if (!v.ok) Object.assign(r, { ok: false, error: L(`语音：${v.error}`, `voice: ${v.error}`) });
    }
    if (r.ok && vision) {
      const v = await putToMachine(machine.url, '/api/vision', vision);
      if (!v.ok) Object.assign(r, { ok: false, error: L(`看图：${v.error}`, `vision: ${v.error}`) });
    }
    results.push({ name: machine.name, ...r });
  }
  return { ok: true, model: `${model.provider} · ${model.model}`, voice: Boolean(voice), results };
});

// --- microphone for every machine -----------------------------------------
// A machine's page is plain http, where Chromium refuses the microphone. A
// hidden window loaded from a file (a secure context) records instead, so voice
// input works on a machine the moment it is added, with no restart.
let recorderWin = null;
async function recorderWindow() {
  if (recorderWin && !recorderWin.isDestroyed()) return recorderWin;
  recorderWin = new BrowserWindow({
    show: false,
    width: 200,
    height: 120,
    skipTaskbar: true,
    webPreferences: { contextIsolation: true, nodeIntegration: false, sandbox: true, backgroundThrottling: false },
  });
  recorderWin.on('closed', () => { recorderWin = null; });
  await recorderWin.loadFile(path.join(__dirname, 'recorder.html'));
  return recorderWin;
}
handle('desk:voice-start', async () => {
  try {
    const w = await recorderWindow();
    return await w.webContents.executeJavaScript('window.__start()');
  } catch (err) {
    return { error: 'Error', message: err.message };
  }
});
handle('desk:voice-stop', async () => {
  if (!recorderWin || recorderWin.isDestroyed()) return null;
  const out = await recorderWin.webContents.executeJavaScript('window.__stop()').catch(() => null);
  return out ? { mime: out.mime, bytes: Buffer.from(out.b64, 'base64') } : null;
});
handle('desk:voice-cancel', async () => {
  if (recorderWin && !recorderWin.isDestroyed()) await recorderWin.webContents.executeJavaScript('window.__cancel()').catch(() => null);
  return true;
});

/**
 * Setting up a machine always runs on THIS computer's hub, whichever machine
 * the window shows: a remote hub would install its own (possibly older) copy,
 * and re-adding a machine from its own page restarts the hub mid-install.
 */
/**
 * Open a file the bots made on this computer with its usual program, or show
 * it in its folder. Only inside this computer's workspace.
 */
handle('desk:open-file', async (_event, { rel = '', reveal = false } = {}) => {
  const root = path.resolve(HOME, 'workspace');
  const abs = path.resolve(root, String(rel).replace(/^workspace[\\/]/, ''));
  if (abs !== root && !abs.startsWith(root + path.sep)) return { ok: false, error: 'outside the workspace' };
  if (!fs.existsSync(abs)) return { ok: false, error: L('这台电脑上没有这个文件', 'No such file on this computer') };
  if (reveal) { shell.showItemInFolder(abs); return { ok: true }; }
  // A program a bot made is never run by a click (SEC-17).
  if (isProgramFile(abs)) {
    shell.showItemInFolder(abs);
    return { ok: true, message: L('这是程序文件，已在文件夹里选中，没有直接运行', 'This is a program file: it is selected in its folder, not run') };
  }
  const err = await shell.openPath(abs);
  return err ? { ok: false, error: err } : { ok: true };
});

handle('desk:local-provision', async (_event, { method = 'GET', path: apiPath = '', body } = {}) => {
  if (!/^\/api\/remote\/provision(\/[\w-]+)?$/.test(apiPath)) return { status: 400, json: { error: { message: 'bad path' } } };
  try {
    const res = await net.fetch(`${localUrl().replace(/\/$/, '')}${apiPath}`, {
      method,
      headers: body ? { 'content-type': 'application/json' } : {},
      body: body ? JSON.stringify(body) : undefined,
    });
    const text = await res.text();
    let json = null;
    try { json = JSON.parse(text); } catch { /* not json */ }
    return { status: res.status, json };
  } catch (err) {
    return { status: 0, json: { error: { message: err.message } } };
  }
});

// --- machines follow this app's version ------------------------------------
// After the human installs a new Nightshift, every machine it set up is
// brought to the same version on its own: this computer's hub packs itself
// and the machine swaps its code in and restarts (see src/selfupdate.mjs).
const updating = new Set();
const updateChecked = new Set();
// A busy machine (a 1-core VM running Windows Update) can take a while to answer.
const updateAttempts = new Map();

function versionCmp(a, b) {
  const pa = String(a || '0').split('.').map((x) => parseInt(x, 10) || 0);
  const pb = String(b || '0').split('.').map((x) => parseInt(x, 10) || 0);
  for (let i = 0; i < Math.max(pa.length, pb.length); i += 1) {
    const d = (pa[i] || 0) - (pb[i] || 0);
    if (d) return d > 0 ? 1 : -1;
  }
  return 0;
}

function notifyPage(text, bad = false) {
  if (!win || win.isDestroyed()) return;
  win.webContents.executeJavaScript(`window.deskNotify && window.deskNotify(${JSON.stringify(text)}, ${bad})`).catch(() => {});
}

async function cookieHeaderFor(url) {
  try {
    const list = await session.defaultSession.cookies.get({ url });
    return list.map((c) => `${c.name}=${c.value}`).join('; ');
  } catch {
    return '';
  }
}

async function autoUpdateMachine(machine) {
  const url = machine?.url;
  if (!url || HUB_MODE || updating.has(url) || updateChecked.has(url)) return;
  updating.add(url);
  const name = machine.name || url.replace(/^https?:\/\//, '');
  const mine = app.getVersion();
  try {
    // Away from home the machine may only answer on its Tailscale address.
    const base = (await reachMachine(url)) || url;
    const res = await net.fetch(`${base}/api/health`, { signal: AbortSignal.timeout(30000) }).catch(() => null);
    if (!res || !res.ok) {
      // Off, unpaired or too busy to answer: try again in 2 minutes, a few times.
      const n = (updateAttempts.get(url) || 0) + 1;
      updateAttempts.set(url, n);
      if (n < 5) setTimeout(() => autoUpdateMachine(machine), 2 * 60 * 1000);
      return;
    }
    const health = await res.json();
    updateChecked.add(url);
    // Remember where this machine can be reached from outside (Tailscale).
    const known = readMachines().find((m) => m.url === url)?.tailnetUrl || '';
    if ((health.tailnetUrl || '') !== known) patchMachine(url, { tailnetUrl: health.tailnetUrl || '' });
    if (versionCmp(health.version, mine) >= 0) { updateAttempts.delete(url); return; }
    if (!health.selfUpdate) {
      notifyPage(L(`「${name}」还是 ${health.version}：重新添加一次这台机器就能更新到 ${mine}，之后会自动更新`, `"${name}" is still on ${health.version}: add it again once to update it to ${mine}; after that it updates on its own`), true);
      return;
    }
    bootLog(`update ${url}: ${health.version} -> ${mine}`);
    notifyPage(L(`正在把「${name}」更新到 ${mine}…`, `Updating "${name}" to ${mine}…`));
    const r = await net.fetch(`${localUrl().replace(/\/$/, '')}/api/remote/push-update`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ url: base, cookie: await cookieHeaderFor(base) }),
    });
    const out = await r.json().catch(() => ({}));
    if (out.ok && out.updated) {
      updateAttempts.delete(url);
      bootLog(`update ${url}: now ${out.to}`);
      // A newer version may understand more of the shared list (its own name,
      // this computer's entry): share it again now, not in ten minutes.
      clearTimeout(sharePeersTimer);
      sharePeersTimer = setTimeout(() => sharePeers().catch(() => {}), 5000);
      if (remoteHub === url && win && !win.isDestroyed()) {
        win.webContents.reload();
        setTimeout(() => notifyPage(L(`「${name}」已更新到 ${out.to}`, `"${name}" is now on ${out.to}`)), 3000);
      } else {
        notifyPage(L(`「${name}」已更新到 ${out.to}`, `"${name}" is now on ${out.to}`));
      }
    } else if (out.busy) {
      // A bot is working there; try again in a few minutes.
      updateChecked.delete(url);
      setTimeout(() => autoUpdateMachine(machine), 5 * 60 * 1000);
    } else {
      const why = out.message || out.error?.message || L('未知原因', 'unknown reason');
      bootLog(`update ${url} failed: ${why}`);
      // A slow or briefly unreachable machine gets another go: every 2 minutes,
      // up to 5 times. "Add it again" is the one failure a retry cannot fix.
      const n = (updateAttempts.get(url) || 0) + 1;
      updateAttempts.set(url, n);
      if (!out.needsSetup && n < 5) {
        updateChecked.delete(url);
        setTimeout(() => autoUpdateMachine(machine), 2 * 60 * 1000);
      } else {
        notifyPage(L(`「${name}」没能自动更新：${why}`, `Could not update "${name}": ${why}`), true);
      }
    }
  } catch (err) {
    bootLog(`update ${url} failed: ${err.message}`);
  } finally {
    updating.delete(url);
  }
}

async function autoUpdateMachines() {
  for (const machine of readMachines()) await autoUpdateMachine(machine);
}

/** PUT JSON to a hub with this app's pairing cookie. -> {ok, error} */
async function putToMachine(url, apiPath, body) {
  try {
    const res = await net.fetch(`${url}${apiPath}`, {
      method: 'PUT',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify(body),
      signal: AbortSignal.timeout(8000),
    });
    return { ok: res.ok, error: res.ok ? '' : (res.status === 401 ? L('未配对', 'not paired') : `HTTP ${res.status}`) };
  } catch {
    return { ok: false, error: L('连不上', 'unreachable') };
  }
}

/**
 * A voice key saved on any machine goes to all of them (this computer too),
 * while the UI still holds it: hubs never hand a key back out.
 */
/** The same, for other write-only per-machine settings (vision). */
handle('desk:sync-config', async (_event, { path: apiPath = '', body = {} } = {}) => {
  if (!['/api/vision', '/api/voice', '/api/media/image', '/api/media/video'].includes(apiPath)) return { ok: false, error: 'bad path' };
  if (!body.apiKey) return { ok: false, error: L('没有密钥可同步', 'no key to sync') };
  const targets = [{ name: L('本机', 'This computer'), url: localUrl() }, ...readMachines()];
  const results = [];
  for (const machine of targets) {
    if (!machine.url) continue;
    results.push({ name: machine.name, ...(await putToMachine(machine.url.replace(/\/+$/, ''), apiPath, body)) });
  }
  return { ok: true, results };
});

handle('desk:sync-voice', async (_event, voice = {}) => {
  const body = { baseUrl: String(voice.baseUrl || ''), model: String(voice.model || ''), apiKey: String(voice.apiKey || '') };
  if (!body.apiKey) return { ok: false, error: L('没有密钥可同步', 'no key to sync') };
  const targets = [{ name: L('本机', 'This computer'), url: localUrl() }, ...readMachines()];
  const results = [];
  for (const machine of targets) {
    if (!machine.url) continue;
    results.push({ name: machine.name, ...(await putToMachine(machine.url.replace(/\/+$/, ''), '/api/voice', body)) });
  }
  return { ok: true, results };
});

handle('desk:rename-machine', (_event, { url, name } = {}) => {
  const target = normalizeHub(url);
  const clean = String(name || '').trim().slice(0, 40);
  if (!target || !clean) return { ok: false, error: '名字不能为空' };
  rememberMachine(target, { name: clean });
  refreshChrome();
  return { ok: true };
});

handle('desk:remove-machine', async (_event, url) => {
  const target = normalizeHub(url);
  writeMachines(readMachines().filter((m) => m.url !== target));
  if (target && target === remoteHub) await switchTo('');
  else refreshChrome();
  return { ok: true };
});

// ---------------------------------------------------------------------------
// lifecycle
// ---------------------------------------------------------------------------

// The microphone needs a secure context, and a machine's hub is plain http on
// the LAN. Chromium only reads this switch at startup, so a machine added in
// this run gets voice input after the next launch.
{
  const origins = readMachines()
    .map((m) => { try { return new URL(m.url).origin; } catch { return null; } })
    .filter((o) => o && o.startsWith('http://'));
  if (origins.length) app.commandLine.appendSwitch('unsafely-treat-insecure-origin-as-secure', origins.join(','));
}

/**
 * Quit for real, even when a page is frozen: app.quit() waits for every page
 * to agree to unload, and a hung page never answers.
 */
/** This computer's screen server, when Nightshift started it ({mod, state}). */
let localVnc = null;
/** Stop it, once (quit by any path). */
function stopLocalScreen() {
  const v = localVnc;
  localVnc = null;
  if (v?.state) {
    try { if (v.mod.stopLocalVnc(v.state)) bootLog('local screen: stopped'); } catch { /* gone */ }
  }
}

function quitNow() {
  quitting = true;
  bootLog('quit');
  if (child && !child.killed) {
    try { child.kill(); } catch { /* already gone */ }
  }
  stopLocalScreen();
  for (const w of BrowserWindow.getAllWindows()) {
    try { w.destroy(); } catch { /* already gone */ }
  }
  app.quit();
  setTimeout(() => app.exit(0), 1500).unref?.();
}

const gotLock = app.requestSingleInstanceLock();
if (!gotLock) {
  app.quit();
} else {
  app.on('second-instance', showWindow);
  // Windows only shows toasts for an app with an AppUserModelID (the installer's shortcut uses this one).
  if (process.platform === 'win32') app.setAppUserModelId('com.desk.assistant');

  // This computer's own screen (TightVNC, loopback only), started with
  // Nightshift and stopped when it quits; machines with the TightVNC service
  // keep theirs. In the background: a first run unpacks it (a 2 MB download).
  const startLocalVnc = () => {
    if (process.platform !== 'win32') return;
    import(pathToFileURL(path.join(SERVER_DIR, 'src', 'localvnc.mjs')).href)
      .then(async (m) => {
        localVnc = { mod: m, state: await m.ensureLocalVnc({ dir: path.join(HOME, 'vnc') }) };
        bootLog(`local screen: ${localVnc.state.mode}${localVnc.state.error ? ` (${localVnc.state.error})` : ''}${localVnc.state.retired?.length ? ` [${localVnc.state.retired.join(', ')}]` : ''}`);
      })
      .catch((err) => bootLog(`local screen: failed (${err.message})`));
  };

  app.whenReady().then(async () => {
    // Microphone, clipboard and notifications for hub pages only (SEC-09).
    const PAGE_PERMISSIONS = new Set(['media', 'clipboard-read', 'clipboard-sanitized-write', 'notifications', 'fullscreen', 'pointerLock', 'openExternal']);
    session.defaultSession.setPermissionRequestHandler((wc, permission, callback, details) => {
      const from = details?.requestingUrl || (wc && !wc.isDestroyed() ? wc.getURL() : '');
      callback(PAGE_PERMISSIONS.has(permission) && pageKind(from) !== 'other');
    });
    startLocalVnc();
    try {
      // Hub mode: no window, bind the network, stay in the tray. This is what
      // runs on the idle PC / VM; the other devices connect to it.
      if (HUB_MODE) {
        await prepareHome();
        const port = await startServer({ host: HUB_HOST, pinned: true });
        serverPort = port;
        console.log(`[desk] HUB MODE on http://${HUB_HOST}:${port}/ (home: ${HOME})`);
        createTray();
        tray?.setToolTip(`Lamplit Hub :${port}`);
        // Keep the process alive with no windows.
        app.dock?.hide?.();
        return;
      }

      // This computer's server always runs: it is the "本机" machine, and
      // switching back to it must be instant.
      if (DEV_URL) {
        console.log('[desk] dev mode, loading', DEV_URL);
      } else {
        await prepareHome();
        // 允许手机连接 was on last time: come back up bound to the network.
        const port = await startServer({ host: savedRemote() ? HUB_HOST : '127.0.0.1' });
        console.log(`[desk] server ready on http://127.0.0.1:${port}/ (home: ${HOME})`);
      }

      // Reopen the machine used last time. If it does not answer (the VM is
      // asleep), start on this computer; the machine list still has it.
      const candidate = normalizeHub(process.env.DESK_HUB_URL || '') || readHub();
      // Away from home the LAN address does not answer: try its Tailscale address.
      const reach = candidate && !DEV_URL ? await reachMachine(candidate) : '';
      if (reach) {
        remoteHub = candidate;
        remoteReach = reach;
        rememberMachine(candidate);
        bootLog(`remote → ${reach}`);
      } else if (candidate) {
        bootLog(`hub unreachable → local (${candidate})`);
      }
      createWindowFor(DEV_URL || reach || localUrl());
      createTray();
      setTimeout(() => autoUpdateMachines().catch(() => {}), 8000);
      // Machines learn about each other now and every 10 minutes (new pairings, new addresses).
      setTimeout(() => sharePeers().catch(() => {}), 15000);
      setInterval(() => sharePeers().catch(() => {}), 10 * 60 * 1000);
      // A machine that was off when this app started (a VM booted later) is
      // updated once it answers: look again every 10 minutes. Machines already
      // checked are skipped inside autoUpdateMachine.
      setInterval(() => { updateAttempts.clear(); autoUpdateMachines().catch(() => {}); }, 10 * 60 * 1000);
    } catch (err) {
      dialog.showErrorBox(L('Lamplit 启动失败', 'Lamplit failed to start'), String(err?.stack || err));
      app.quit();
    }
  });

  app.on('window-all-closed', () => {
    // keep running in the tray on Windows/Linux; macOS hides anyway
    if (process.platform === 'darwin') return;
    if (!tray) app.quit();
  });

  app.on('before-quit', () => { quitting = true; });

  app.on('will-quit', () => {
    if (child && !child.killed) {
      try { child.kill(); } catch { /* already gone */ }
    }
    // The screen server goes with Nightshift (only the copy it started).
    stopLocalScreen();
  });

  app.on('activate', showWindow);
}
