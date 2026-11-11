/**
 * desktops.mjs - one desktop per bot.
 *
 * The product claim is "bots with their own computer", so a bot must not share
 * a screen with its siblings: whatever bot A opens, bot B must not see. This
 * module gives every bot its own X display, its own VNC server and its own
 * noVNC bridge, all as children of the hub process (no systemd juggling).
 *
 *   bot  ── display :120+N  ── x11vnc 127.0.0.1:59<N>  ── websockify :61<N>
 *
 * Linux only: this needs Xvfb. On macOS/Windows the manager reports
 * unavailable and callers fall back to the single shared desktop, which is what
 * earlier versions had.
 *
 * Ports are derived from a stable index so they do not move between restarts;
 * allocation happens lazily (first time a bot's desktop is asked for).
 */

import { spawn, spawnSync } from 'node:child_process';
import fs from 'node:fs';
import fsp from 'node:fs/promises';
import net from 'node:net';
import path from 'node:path';

const BASE_DISPLAY = 120;      // :120 .. :159
const BASE_VNC_PORT = 5900 + 20; // 5920 ..
const BASE_WEB_PORT = 6100;    // 6100 ..
const MAX_BOTS = 40;

/** @type {Map<string, {display:number, vncPort:number, webPort:number, procs:object[], startedAt:string}>} */
const desktops = new Map();
let indexByBot = new Map();
let vncPassword = '';
let dataDir = '';

// Light: a window manager only (openbox) - a bot needs windows, not a panel
// and wallpaper. Measured on Ubuntu 24.04: about 150 MB per bot desktop against
// about 240 MB with XFCE (Xvfb + x11vnc + websockify are ~130 MB of either). Full: the
// XFCE desktop a human would recognise. Light falls back to full when openbox
// is not installed.
let desktopMode = process.env.DESK_DESKTOP_MODE === 'full' ? 'full' : 'light';
export function setDesktopMode(mode) { desktopMode = mode === 'full' ? 'full' : 'light'; return desktopMode; }
export function getDesktopMode() { return desktopMode; }
/** Is the full (XFCE) desktop installed here? */
export function fullDesktopInstalled() {
  if (process.platform === 'win32') return false;
  try { return spawnSync('sh', ['-c', 'command -v xfce4-session'], { encoding: 'utf8' }).status === 0; } catch { return false; }
}

// A desktop nobody used for this long is stopped (it starts again in about two
// seconds when needed; the bot's browser profile, logins included, is on disk).
export const DESKTOP_IDLE_MS = Math.max(1, Number(process.env.DESK_DESKTOP_IDLE_MIN) || 15) * 60 * 1000;
let hooks = { busy: () => false, beforeStop: async () => {} };
/** busy(botId) -> true while the bot's browser is working; beforeStop(botId) closes it cleanly. */
export function setDesktopHooks(next = {}) { hooks = { ...hooks, ...next }; }
let reaper = null;

/** Someone is using this bot's desktop now (the UI asked for it, a tool needs it). */
export function touchDesktop(botId) {
  const entry = desktops.get(botId);
  if (entry) entry.lastUsed = Date.now();
}

/** A viewer connected; call the returned function when it disconnects. */
export function desktopViewerOpened(botId) {
  const entry = desktops.get(botId);
  if (!entry) return () => {};
  entry.viewers = (entry.viewers || 0) + 1;
  entry.lastUsed = Date.now();
  let done = false;
  return () => {
    if (done) return;
    done = true;
    entry.viewers = Math.max(0, (entry.viewers || 1) - 1);
    entry.lastUsed = Date.now();
  };
}

/** Stop desktops nobody used for DESKTOP_IDLE_MS. -> the bot ids stopped. */
export async function reapIdleDesktops(now = Date.now()) {
  const stopped = [];
  for (const [botId, entry] of [...desktops]) {
    if ((entry.viewers || 0) > 0) continue;
    let busy = false;
    try { busy = Boolean(hooks.busy(botId)); } catch { /* treat as idle */ }
    if (busy) { entry.lastUsed = now; continue; }
    if (now - (entry.lastUsed || 0) < DESKTOP_IDLE_MS) continue;
    try { await hooks.beforeStop(botId); } catch { /* the desktop goes anyway */ }
    if (stopDesktop(botId)) stopped.push(botId);
  }
  if (stopped.length) console.log('[desktops] stopped idle desktops:', stopped.join(', '));
  return stopped;
}

function startReaper() {
  if (reaper) return;
  reaper = setInterval(() => { reapIdleDesktops().catch(() => {}); }, 60 * 1000);
  if (typeof reaper.unref === 'function') reaper.unref();
}

/** For tests: put an entry in the table without starting processes. */
export function _testDesktopEntry(botId) { return desktops.get(botId) || null; }
export function _testAddDesktop(botId, entry) { desktops.set(botId, { procs: [], viewers: 0, lastUsed: Date.now(), ...entry }); }

function hasBinary(bin) {
  try {
    const res = spawnSync('sh', ['-c', `command -v ${bin}`], { encoding: 'utf8' });
    return res.status === 0 && Boolean(String(res.stdout || '').trim());
  } catch {
    return false;
  }
}

/*
 * Windows: one desktop, the machine's console (login screen or the signed-in
 * session), served by the TightVNC service that hub/setup-windows.ps1 installs
 * on 127.0.0.1 only. Every bot shares it. The hub bridges WebSocket to it
 * itself (no websockify on Windows). Its presence is probed in the background
 * because desktopSupport() is synchronous.
 */
const WINDOWS_VNC_PORT = Number(process.env.DESK_VNC_PORT) || 5900;
let windowsVnc = { up: false, checkedAt: 0 };

function probeWindowsVnc() {
  portOpen(WINDOWS_VNC_PORT).then((up) => { windowsVnc = { up, checkedAt: Date.now() }; });
}
if (process.platform === 'win32') {
  probeWindowsVnc();
  setInterval(probeWindowsVnc, 15000).unref();
}

function windowsDesktop(botId) {
  return {
    botId,
    display: 'console',
    shared: true,
    vncPort: WINDOWS_VNC_PORT,
    webPort: null,
    running: windowsVnc.up,
    url: windowsVnc.up ? viewerUrl(botId) : null,
  };
}

/** Same-origin noVNC page, connecting back through the hub's relay. The path
 *  must start with "/": noVNC resolves it against the page, and a relative one
 *  would land under /novnc/. */
export function viewerUrl(botId) {
  return `/novnc/vnc.html?autoconnect=1&resize=scale&reconnect=1&reconnect_delay=2000&path=${encodeURIComponent(`/api/bots/${encodeURIComponent(botId)}/desktop/ws`)}`;
}

/** Whether per-bot desktops can work on this machine at all. */
export function desktopSupport() {
  if (process.platform === 'win32') {
    return windowsVnc.up
      ? { available: true, shared: true, reason: '' }
      : { available: false, reason: 'no desktop server on this Windows machine (TightVNC, installed by setup-windows.ps1)' };
  }
  // Escape hatch: per-bot desktops spawn X/DBus/session managers inside the hub
  // process, which is fine on some hosts and fatal on others. DESK_PER_BOT_DESKTOPS=0
  // falls back to the machine's single desktop while that is investigated.
  if (process.env.DESK_PER_BOT_DESKTOPS === '0') {
    return { available: false, reason: 'per-bot desktops disabled by DESK_PER_BOT_DESKTOPS=0' };
  }
  if (process.platform !== 'linux') {
    return { available: false, reason: 'per-bot desktops need Linux (Xvfb + x11vnc)' };
  }
  const backend = desktopBackend();
  if (backend === 'wayland') return { available: true, reason: '', backend };
  const missing = ['Xvfb', 'x11vnc', 'websockify'].filter((b) => !hasBinary(b));
  if (missing.length) {
    // Say the install command of this machine's package manager. Rocky/RHEL 10
    // have no X11 stack at all: there the screens are Wayland (cage + wayvnc).
    const hint = hasBinary('apt-get')
      ? 'apt install xvfb x11vnc novnc websockify'
      : hasBinary('dnf') ? 'dnf install cage wayvnc novnc python3-websockify; dnf upgrade liblc3' : 'install Xvfb, x11vnc, noVNC and websockify';
    return { available: false, reason: `missing ${missing.join(', ')} (${hint})` };
  }
  return { available: true, reason: '', backend };
}

/*
 * Two ways to give a bot a screen on Linux:
 *  - x11: Xvfb + a window manager + x11vnc (Ubuntu, Debian, EL 8/9).
 *  - wayland: cage, a one-window Wayland compositor, on its headless backend,
 *    with wayvnc (Rocky / RHEL 10, which ship no Xvfb or x11vnc at all). The
 *    bot's browser fills the screen; there is no desktop around it.
 * X11 wins when both are installed. The answer is cached: it is asked a lot.
 */
let backendCache = null;
export function desktopBackend() {
  if (process.env.DESK_DESKTOP_BACKEND === 'x11' || process.env.DESK_DESKTOP_BACKEND === 'wayland') return process.env.DESK_DESKTOP_BACKEND;
  if (backendCache && Date.now() - backendCache.at < 60000) return backendCache.value;
  let value = 'x11';
  if (process.platform === 'linux' && !(hasBinary('Xvfb') && hasBinary('x11vnc'))
    && hasBinary('cage') && hasBinary('wayvnc')) value = 'wayland';
  backendCache = { value, at: Date.now() };
  return value;
}

export function configure({ dataDir: dir, password } = {}) {
  if (dir) dataDir = dir;
  if (typeof password === 'string' && password) vncPassword = password;
}

/** Reuse the desktop password the installer already stored, if any. */
async function loadPassword() {
  if (vncPassword) return vncPassword;
  try {
    const raw = JSON.parse(await fsp.readFile(path.join(dataDir, 'vnc.json'), 'utf8'));
    vncPassword = String(raw.password || '');
  } catch { /* not configured: VNC stays passwordless on 127.0.0.1 only */ }
  return vncPassword;
}

async function passwordFile() {
  const pass = await loadPassword();
  if (!pass) return '';
  const file = path.join(dataDir, 'desktops.passwd');
  if (!fs.existsSync(file)) {
    await fsp.mkdir(dataDir, { recursive: true });
    const res = spawnSync('x11vnc', ['-storepasswd', pass, file], { encoding: 'utf8' });
    if (res.status !== 0) return '';
    try { await fsp.chmod(file, 0o600); } catch { /* best effort */ }
  }
  return file;
}

/** Best effort: pkill anything left over from a previous hub process. */
function childLog(botId, name) {
  try {
    const dir = path.join(dataDir || process.cwd(), 'desktop-logs');
    fs.mkdirSync(dir, { recursive: true });
    return fs.openSync(path.join(dir, `${botId}-${name}.log`), 'a');
  } catch {
    return 'ignore';
  }
}

/** spawn() that never lets a child error crash the hub (EACCES/ENOENT). */
function spawnChild(cmd, args, options = {}) {
  let child;
  try {
    child = spawn(cmd, args, options);
  } catch (err) {
    return { killed: false, exitCode: -1, failed: String(err.message) };
  }
  child.on('error', () => { /* logged by absence of the process; never fatal */ });
  return child;
}

function killByPattern(pattern) {
  try {
    spawnSync('pkill', ['-f', pattern], { stdio: 'ignore' });
  } catch { /* pkill missing: the bind will fail loudly instead */ }
}

function stableIndex(botId) {
  if (indexByBot.has(botId)) return indexByBot.get(botId);
  const used = new Set(indexByBot.values());
  let index = 0;
  while (used.has(index) && index < MAX_BOTS) index += 1;
  if (index >= MAX_BOTS) index = MAX_BOTS - 1;
  indexByBot.set(botId, index);
  return index;
}

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

async function portOpen(port, host = '127.0.0.1') {
  return new Promise((resolve) => {
    const socket = net.connect({ port, host }, () => { socket.destroy(); resolve(true); });
    socket.on('error', () => resolve(false));
    socket.setTimeout(800, () => { socket.destroy(); resolve(false); });
  });
}

/** Xvfb with -nolisten tcp is only visible as a unix socket. */
function displayReady(display) {
  return fs.existsSync(`/tmp/.X11-unix/X${display}`);
}

/**
 * Start (or reuse) the desktop for a bot. Returns the viewer URL.
 * Idempotent: calling it repeatedly is how the UI polls.
 */
// One start per bot at a time. Right after a hub restart the UI asks for the
// screen several times at once; overlapping starts killed each other's
// processes and wiped the shared runtime directory (one even reported the
// screen as not running).
const starting = new Map();
export async function ensureDesktop(botId) {
  if (starting.has(botId)) return starting.get(botId);
  const run = ensureDesktopOnce(botId).finally(() => starting.delete(botId));
  starting.set(botId, run);
  return run;
}

async function ensureDesktopOnce(botId) {
  if (process.platform === 'win32') {
    if (!botId) throw new Error('botId is required');
    if (!windowsVnc.up) { probeWindowsVnc(); windowsVnc.up = await portOpen(WINDOWS_VNC_PORT); }
    if (!windowsVnc.up) throw new Error(desktopSupport().reason);
    return { ...windowsDesktop(botId), started: false };
  }
  const support = desktopSupport();
  if (!support.available) throw new Error(support.reason);
  if (!botId) throw new Error('botId is required');

  const existing = desktops.get(botId);
  if (existing) {
    // The map is only a cache: the processes can be gone (killed by hand, OOM,
    // a host restart). A stale entry would hand the UI a dead viewer URL.
    const alive = existing.procs.every((proc) => !proc.killed && proc.exitCode === null)
      && (await portOpen(existing.vncPort))
      && (await portOpen(existing.webPort));
    if (alive) { existing.lastUsed = Date.now(); return { ...publicInfo(botId, existing), started: false }; }
    for (const proc of existing.procs) {
      try { proc.kill(); } catch { /* already gone */ }
    }
    desktops.delete(botId);
  }

  if (desktopBackend() === 'wayland') return startWaylandDesktop(botId);

  for (const pattern of ['Xvfb :' + (BASE_DISPLAY + stableIndex(botId)), 'x11vnc -display :' + (BASE_DISPLAY + stableIndex(botId))]) {
    killByPattern(pattern);
  }
  const index = stableIndex(botId);
  // Older hubs bound "websockify --web=… <port>" on every interface; kill
  // either form so the loopback-only bridge below can take the port.
  killByPattern(`websockify.* ${BASE_WEB_PORT + index} `);
  killByPattern(`websockify.*:${BASE_WEB_PORT + index} `);
  const display = BASE_DISPLAY + index;
  const vncPort = BASE_VNC_PORT + index;
  const webPort = BASE_WEB_PORT + index;
  const procs = [];

  // A killed Xvfb leaves /tmp/.X<N>-lock behind and the next one refuses to
  // start ("server is already active"), which shows up as a black viewer.
  try { fs.rmSync(`/tmp/.X${display}-lock`, { force: true }); } catch { /* fine */ }
  try { fs.rmSync(`/tmp/.X11-unix/X${display}`, { force: true }); } catch { /* fine */ }

  // 1) the virtual display
  procs.push(spawnChild('Xvfb', [`:${display}`, '-screen', '0', '1400x900x24', '-nolisten', 'tcp'], {
    stdio: ['ignore', childLog(botId, 'xvfb'), childLog(botId, 'xvfb')],
    detached: false,
  }));
  for (let i = 0; i < 40 && !displayReady(display); i += 1) await sleep(100);

  // A bare Xvfb is a black rectangle. Run a real session: XFCE when it is
  // installed (looks like a desktop), otherwise a window manager + terminal.
  const sessionEnv = {
    ...process.env,
    DISPLAY: `:${display}`,
    XDG_SESSION_TYPE: 'x11',
    XDG_CURRENT_DESKTOP: 'XFCE',
    XDG_RUNTIME_DIR: process.env.XDG_RUNTIME_DIR || `/run/user/${process.getuid?.() ?? 1000}`,
  };
  const have = (bin) => {
    try { return spawnSync('sh', ['-c', `command -v ${bin}`], { encoding: 'utf8' }).status === 0; }
    catch { return false; }
  };
  let sessionMode = 'full';
  // "Full" on a machine without XFCE (new installs only get openbox) would be a
  // black screen: use openbox and let Settings say how to get XFCE.
  const wantLight = desktopMode === 'light' || !have('xfce4-session');
  if (wantLight && have('openbox')) {
    // Light: openbox alone, with the same per-display runtime dir the full
    // session uses (a shared /run/user/<uid> confused the session with a
    // logged-in GNOME one).
    const runtime = `/tmp/desk-runtime-${process.getuid?.() ?? 1000}-${display}`;
    try { fs.mkdirSync(runtime, { recursive: true, mode: 0o700 }); } catch { /* exists */ }
    const lightEnv = { ...sessionEnv, XDG_RUNTIME_DIR: runtime, XDG_CURRENT_DESKTOP: 'openbox', GDK_BACKEND: 'x11', QT_QPA_PLATFORM: 'xcb', NO_AT_BRIDGE: '1' };
    delete lightEnv.WAYLAND_DISPLAY;
    delete lightEnv.DBUS_SESSION_BUS_ADDRESS;
    delete lightEnv.SESSION_MANAGER;
    if (have('xsetroot')) spawnChild('xsetroot', ['-solid', '#2b2b2b'], { stdio: 'ignore', env: lightEnv });
    procs.push(spawnChild('openbox', [], {
      stdio: ['ignore', childLog(botId, 'session'), childLog(botId, 'session')],
      env: lightEnv,
    }));
    sessionMode = 'light';
    await sleep(400);
  } else if (fs.existsSync('/usr/local/bin/desk-bot-session')) {
    procs.push(spawnChild('/usr/local/bin/desk-bot-session', [String(display)], {
      stdio: ['ignore', childLog(botId, 'session'), childLog(botId, 'session')],
      env: sessionEnv,
    }));
    await sleep(1500);
  } else if (have('xfce4-session') && have('dbus-launch')) {
    procs.push(spawnChild('dbus-launch', ['--exit-with-session', 'xfce4-session'], {
      stdio: ['ignore', childLog(botId, 'session'), childLog(botId, 'session')],
      env: sessionEnv,
    }));
    await sleep(1200);
  } else {
    for (const [bin, argv] of [['openbox', []], ['xterm', ['-fa', 'Monospace', '-fs', '11']]]) {
      if (!have(bin)) continue;
      procs.push(spawnChild(bin, argv, {
        stdio: ['ignore', childLog(botId, 'session'), childLog(botId, 'session')],
        env: sessionEnv,
      }));
      await sleep(300);
    }
  }

  // 2) VNC server on that display, localhost only
  // No VNC password on purpose: the display is bound to 127.0.0.1 and each bot
  // has its own websockify bridge, so "type a password to see your own bot"
  // would be friction with no real protection.
  const args = ['-display', `:${display}`, '-localhost', '-nopw', '-forever', '-shared', '-noxdamage', '-repeat', '-noshm', '-rfbport', String(vncPort)];
  procs.push(spawnChild('x11vnc', args, { stdio: ['ignore', childLog(botId, 'vnc'), childLog(botId, 'vnc')] }));
  for (let i = 0; i < 50 && !(await portOpen(vncPort)); i += 1) await sleep(100);

  // 3) WebSocket bridge for that one display, loopback only. Viewers never
  // reach it directly: the hub relays /api/bots/<id>/desktop/ws to it after
  // the same pairing check as the API, so nobody on the LAN can open a bot's
  // screen without being paired.
  procs.push(spawnChild('websockify', [`127.0.0.1:${webPort}`, `127.0.0.1:${vncPort}`], {
    stdio: ['ignore', childLog(botId, 'web'), childLog(botId, 'web')],
  }));
  for (let i = 0; i < 50 && !(await portOpen(webPort)); i += 1) await sleep(100);

  const entry = { display, vncPort, webPort, procs, startedAt: new Date().toISOString(), mode: sessionMode, viewers: 0, lastUsed: Date.now() };
  desktops.set(botId, entry);
  startReaper();
  return { ...publicInfo(botId, entry), started: true };
}

/** The wayland command lines for one screen (also used to kill leftovers). */
export function waylandCommands({ display, webPort }) {
  return {
    // The "app" cage runs is a placeholder; its odd length makes the process
    // findable after a hub restart. The bot's browser joins as a client.
    cage: ['cage', ['-d', '--', 'sleep', `2147${display}000`]],
    // wayvnc speaks WebSocket itself (-w), on the bridge port the hub relays
    // to: no websockify. That one forks per viewer, and on a 1.6 GB Rocky VM
    // with Chromium running the fork failed with ENOMEM (a blank viewer).
    vnc: ['wayvnc', ['-w', '-r', '127.0.0.1', String(webPort)]],
  };
}

async function startWaylandDesktop(botId) {
  const index = stableIndex(botId);
  const display = BASE_DISPLAY + index;
  const vncPort = BASE_VNC_PORT + index;
  const webPort = BASE_WEB_PORT + index;
  const cmd = waylandCommands({ display, webPort });
  killByPattern(`sleep 2147${display}000$`);
  killByPattern(`wayvnc .*127.0.0.1 (${vncPort}|${webPort})$`);
  killByPattern(`websockify.* 127.0.0.1:${webPort} `);
  // Its own runtime dir: the Wayland socket lives there and nothing else
  // (a logged-in GNOME session) can be mistaken for it.
  const runtime = `/tmp/desk-wl-${process.getuid?.() ?? 1000}-${display}`;
  try { fs.rmSync(runtime, { recursive: true, force: true }); } catch { /* fine */ }
  fs.mkdirSync(runtime, { recursive: true, mode: 0o700 });
  const env = {
    ...process.env,
    XDG_RUNTIME_DIR: runtime,
    WLR_BACKENDS: 'headless',
    WLR_RENDERER: 'pixman',
    WLR_LIBINPUT_NO_DEVICES: '1',
    WLR_HEADLESS_OUTPUTS: '1',
  };
  delete env.DISPLAY;
  delete env.WAYLAND_DISPLAY;
  const procs = [];
  procs.push(spawnChild(cmd.cage[0], cmd.cage[1], { stdio: ['ignore', childLog(botId, 'session'), childLog(botId, 'session')], env }));
  let socket = '';
  for (let i = 0; i < 50 && !socket; i += 1) {
    await sleep(100);
    try { socket = fs.readdirSync(runtime).find((f) => /^wayland-\d+$/.test(f)) || ''; } catch { /* not yet */ }
  }
  const clientEnv = { ...env, WAYLAND_DISPLAY: socket || 'wayland-0' };
  procs.push(spawnChild(cmd.vnc[0], cmd.vnc[1], { stdio: ['ignore', childLog(botId, 'vnc'), childLog(botId, 'vnc')], env: clientEnv }));
  for (let i = 0; i < 50 && !(await portOpen(webPort)); i += 1) await sleep(100);
  // One port: the WebSocket one (the liveness check looks at both fields).
  const entry = {
    display, vncPort: webPort, webPort, procs, startedAt: new Date().toISOString(), mode: 'kiosk', viewers: 0, lastUsed: Date.now(),
    wayland: { display: clientEnv.WAYLAND_DISPLAY, runtime },
  };
  desktops.set(botId, entry);
  startReaper();
  return { ...publicInfo(botId, entry), started: true };
}

function publicInfo(botId, entry) {
  return {
    botId,
    display: `:${entry.display}`,
    vncPort: entry.vncPort,
    webPort: entry.webPort,
    running: entry.procs.every((p) => !p.killed && p.exitCode === null),
    startedAt: entry.startedAt,
    mode: entry.mode || 'full',
    viewers: entry.viewers || 0,
    lastUsed: entry.lastUsed ? new Date(entry.lastUsed).toISOString() : null,
    // Same-origin viewer (the hub serves noVNC) that connects back through
    // the hub's authenticated relay; relative so it works from any address.
    url: viewerUrl(botId),
  };
}


/** Info for a bot's desktop without starting one. */
export function desktopInfo(botId) {
  if (process.platform === 'win32') return windowsDesktop(botId);
  const entry = desktops.get(botId);
  if (!entry) return { botId, running: false, display: null, url: null };
  return publicInfo(botId, entry);
}

/** What the browser/shell tools should put in the environment for this bot. */
export function desktopEnv(botId) {
  const entry = desktops.get(botId);
  if (!entry) return {};
  // Wayland screens: the browser connects to that compositor's socket.
  if (entry.wayland) return { WAYLAND_DISPLAY: entry.wayland.display, XDG_RUNTIME_DIR: entry.wayland.runtime };
  return { DISPLAY: `:${entry.display}` };
}

export function stopDesktop(botId) {
  const entry = desktops.get(botId);
  if (!entry) return false;
  for (const proc of entry.procs) {
    try { proc.kill(); } catch { /* already gone */ }
  }
  desktops.delete(botId);
  indexByBot.delete(botId);
  return true;
}

export function stopAllDesktops() {
  for (const botId of [...desktops.keys()]) stopDesktop(botId);
}

export function listDesktops() {
  return [...desktops.keys()].map((botId) => desktopInfo(botId));
}
