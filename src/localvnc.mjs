/**
 * localvnc.mjs - this Windows computer's own screen, for the live view and
 * takeover, the same way every added machine has one.
 *
 * Added machines get TightVNC as a Windows service (hub/setup-windows.ps1).
 * The computer the desktop app runs on gets it as an ordinary program instead,
 * owned by Nightshift: no administrator rights, started when Nightshift starts
 * and stopped when it quits.
 *
 *   ensureLocalVnc({dir}) at startup:
 *     - a tvnserver service exists       -> leave it (mode 'service')
 *     - an old hand-made copy in the workspace (a bot set one up, with a
 *       "DeskVncServer" startup entry) -> stop it, remove that entry
 *     - something else listens on 5900   -> leave it (mode 'other')
 *     - else: unpack the TightVNC MSI into <dir> once (msiexec /a: no install,
 *       no admin; the MSI must carry GlavSoft's valid signature), set it to
 *       loopback only, start "tvnserver -run"            (mode 'own')
 *   stopLocalVnc(state) at quit: "tvnserver -controlapp -shutdown", then the
 *   process itself if it is still there.
 *
 * Loopback only and no VNC password, as on the added machines: the hub's
 * authenticated relay is the only way in from outside.
 */

import fs from 'node:fs';
import fsp from 'node:fs/promises';
import net from 'node:net';
import os from 'node:os';
import path from 'node:path';
import { spawn, spawnSync } from 'node:child_process';

export const VNC_PORT = 5900;
/** The startup entry a bot made by hand before Nightshift did this itself. */
export const LEGACY_RUN_VALUE = 'DeskVncServer';
const RUN_KEY = 'HKCU\\Software\\Microsoft\\Windows\\CurrentVersion\\Run';
const SERVER_KEY = 'HKCU\\Software\\TightVNC\\Server';
/** Loopback only, no VNC password (the hub relay authenticates), no web page, no tray icon. */
export const SAFE_SETTINGS = [
  ['LoopbackOnly', 1], ['AllowLoopback', 1], ['UseVncAuthentication', 0],
  ['AcceptHttpConnections', 0], ['RfbPort', VNC_PORT], ['RemoveWallpaper', 0], ['RunControlInterface', 0],
];

const quiet = { windowsHide: true, encoding: 'utf8', timeout: 20000 };

export function portOpen(port, host = '127.0.0.1', timeoutMs = 1500) {
  return new Promise((resolve) => {
    const sock = net.connect({ port, host });
    const done = (v) => { sock.destroy(); resolve(v); };
    sock.setTimeout(timeoutMs, () => done(false));
    sock.once('connect', () => done(true));
    sock.once('error', () => done(false));
  });
}

/** Where msiexec /a puts the server inside <dir>. */
export const exeIn = (dir) => path.join(dir, 'PFiles', 'TightVNC', 'tvnserver.exe');

/** Is a part of the path a hand-made copy in a bot workspace? */
export const isLegacyCopy = (p) => /[\\/]Desk[\\/]workspace[\\/]tools[\\/]tightvnc[\\/]/i.test(String(p || ''));

/**
 * Run a small PowerShell script; values go in through environment variables,
 * so no path ever has to be quoted or survive a code page. -> stdout
 */
function ps(script, env = {}) {
  const res = spawnSync('powershell.exe', ['-NoProfile', '-NonInteractive', '-ExecutionPolicy', 'Bypass', '-Command',
    `[Console]::OutputEncoding=[Text.Encoding]::UTF8; ${script}`], { ...quiet, env: { ...process.env, ...env } });
  return String(res.stdout || '').trim();
}

/** Running tvnserver programs: [{pid, path}]. */
export function tvnProcesses() {
  const out = ps("Get-CimInstance Win32_Process -Filter \"Name='tvnserver.exe'\" | ForEach-Object { [pscustomobject]@{ pid = $_.ProcessId; path = $_.ExecutablePath; cmd = $_.CommandLine } } | ConvertTo-Json -Compress");
  if (!out) return [];
  try { const j = JSON.parse(out); return (Array.isArray(j) ? j : [j]).map((p) => ({ pid: p.pid, path: p.path || '', cmd: p.cmd || '' })); } catch { return []; }
}

export function hasVncService() {
  const res = spawnSync('sc.exe', ['query', 'tvnserver'], quiet);
  return res.status === 0 && /SERVICE_NAME/i.test(String(res.stdout || ''));
}

/** The value of the old startup entry, or ''. */
export function legacyRunEntry() {
  const res = spawnSync('reg.exe', ['query', RUN_KEY, '/v', LEGACY_RUN_VALUE], quiet);
  return res.status === 0 ? String(res.stdout || '') : '';
}

/** Ask a TightVNC program to shut its running server down; then end it if it is still there. */
function shutdown(exe, pid) {
  if (exe && fs.existsSync(exe)) spawnSync(exe, ['-controlapp', '-shutdown'], { ...quiet, timeout: 8000 });
  if (pid) {
    const still = tvnProcesses().some((p) => p.pid === pid);
    if (still) spawnSync('taskkill', ['/pid', String(pid), '/T', '/F'], quiet);
  }
}

/**
 * The bot's hand-made copy: stop it and remove its startup entry, so the one
 * Nightshift owns takes over. Only an entry pointing into a bot workspace is
 * touched. -> what was done
 */
export function retireLegacyCopy() {
  const done = [];
  const entry = legacyRunEntry();
  if (entry && isLegacyCopy(entry)) {
    const r = spawnSync('reg.exe', ['delete', RUN_KEY, '/v', LEGACY_RUN_VALUE, '/f'], quiet);
    if (r.status === 0) done.push('removed startup entry');
  }
  for (const p of tvnProcesses().filter((x) => isLegacyCopy(x.path) && !/-controlapp/i.test(x.cmd))) {
    shutdown(p.path, p.pid);
    done.push(`stopped ${p.pid}`);
  }
  return done;
}

/**
 * The TightVNC MSI, downloaded once on this computer and cached in the temp
 * dir (also what machine installs upload to a new Windows machine).
 * DESK_VNC_MSI points at a file to use instead (tests, offline installs).
 * -> {file, bytes} or null when DESK_VNC_MSI names no file.
 */
export async function tightVncInstaller({ fetchImpl = fetch } = {}) {
  const override = process.env.DESK_VNC_MSI;
  if (override) {
    const st = await fsp.stat(override).catch(() => null);
    return st?.isFile() ? { file: override, bytes: st.size } : null;
  }
  const dir = path.join(os.tmpdir(), 'nightshift-cache');
  await fsp.mkdir(dir, { recursive: true });
  const cached = (await fsp.readdir(dir).catch(() => [])).filter((n) => /^tightvnc-[\d.]+-gpl-setup-64bit\.msi$/.test(n)).sort().pop();
  if (cached) {
    const st = await fsp.stat(path.join(dir, cached));
    if (st.size > 1024 * 1024) return { file: path.join(dir, cached), bytes: st.size };
  }
  let url = 'https://www.tightvnc.com/download/2.8.90/tightvnc-2.8.90-gpl-setup-64bit.msi';
  try {
    const page = await (await fetchImpl('https://www.tightvnc.com/download.php', { signal: AbortSignal.timeout(15000) })).text();
    const m = /\/download\/([0-9.]+)\/tightvnc-[0-9.]+-gpl-setup-64bit\.msi/.exec(page);
    if (m) url = `https://www.tightvnc.com${m[0]}`;
  } catch { /* keep the known version */ }
  const res = await fetchImpl(url, { signal: AbortSignal.timeout(120000) });
  if (!res.ok) throw new Error(`HTTP ${res.status}`);
  const bytes = Buffer.from(await res.arrayBuffer());
  if (bytes.length < 1024 * 1024) throw new Error('installer too small');
  const file = path.join(dir, path.basename(new URL(url).pathname));
  await fsp.writeFile(`${file}.part`, bytes);
  await fsp.rename(`${file}.part`, file);
  return { file, bytes: bytes.length };
}

/** GlavSoft's valid Authenticode signature on the MSI (there is no published checksum). */
export function signedByGlavSoft(file) {
  const out = ps('$s = Get-AuthenticodeSignature -LiteralPath $env:DESK_SIG_FILE; "$($s.Status)|$($s.SignerCertificate.Subject)"', { DESK_SIG_FILE: file });
  const [status, subject = ''] = out.split('|');
  return status === 'Valid' && /GlavSoft/i.test(subject);
}

/** Unpack the MSI into <dir> (msiexec /a: files only, nothing installed, no admin). */
export async function unpack(dir, { installer = tightVncInstaller } = {}) {
  if (fs.existsSync(exeIn(dir))) return exeIn(dir);
  const msi = await installer();
  if (!msi) throw new Error('no TightVNC installer');
  if (!signedByGlavSoft(msi.file)) throw new Error('TightVNC 安装包签名不对，不用');
  await fsp.mkdir(dir, { recursive: true });
  const r = spawnSync('msiexec.exe', ['/a', msi.file, '/qn', `TARGETDIR=${dir}`], { ...quiet, timeout: 180000 });
  if (!fs.existsSync(exeIn(dir))) throw new Error(`msiexec /a 退出码 ${r.status}`);
  return exeIn(dir);
}

/** Loopback only, no password, no web page, no tray icon (per user: HKCU). */
export function configure() {
  for (const [name, value] of SAFE_SETTINGS) {
    spawnSync('reg.exe', ['add', SERVER_KEY, '/v', name, '/t', 'REG_DWORD', '/d', String(value), '/f'], quiet);
  }
}

async function waitPort(port, ms) {
  const until = Date.now() + ms;
  while (Date.now() < until) {
    if (await portOpen(port)) return true;
    await new Promise((r) => setTimeout(r, 500));
  }
  return false;
}

/**
 * Make sure this computer's screen can be seen. Never throws.
 * -> {mode:'off'|'service'|'other'|'own'|'failed', exe?, pid?, retired?, error?}
 */
export async function ensureLocalVnc({ dir, installer } = {}) {
  if (process.platform !== 'win32' || process.env.DESK_LOCAL_VNC === '0') return { mode: 'off' };
  try {
    if (hasVncService()) return { mode: 'service' };
    const retired = retireLegacyCopy();
    const exe = exeIn(dir);
    // Ours still running (Nightshift ended without its quit, e.g. a crash): keep it.
    const ours = tvnProcesses().find((p) => p.path && path.resolve(p.path) === path.resolve(exe) && !/-controlapp/i.test(p.cmd));
    if (ours) return { mode: 'own', exe, pid: ours.pid, retired };
    if (await portOpen(VNC_PORT)) return { mode: 'other', retired };
    await unpack(dir, { installer });
    configure();
    const child = spawn(exe, ['-run'], { detached: true, stdio: 'ignore', windowsHide: true });
    child.on('error', () => {});
    child.unref();
    const up = await waitPort(VNC_PORT, 15000);
    return up ? { mode: 'own', exe, pid: child.pid, retired } : { mode: 'failed', error: 'TightVNC 启动了但 5900 端口没起来', retired };
  } catch (err) {
    return { mode: 'failed', error: err.message };
  }
}

// ---------------------------------------------------------------------------
// Which screen it shows. A machine with two or three monitors shows them side
// by side as one wide picture; TightVNC can share one of them instead:
//   tvnserver -controlservice|-controlapp -shareprimary | -sharedisplay N | -sharefull
// Every Windows machine Nightshift sets up has TightVNC, so this works on all
// of them (the service on added machines, the program on this computer).
// ---------------------------------------------------------------------------

/** Async PowerShell (the hub must not block on it). -> stdout */
function psAsync(script, env = {}, timeoutMs = 20000) {
  return new Promise((resolve) => {
    let out = '';
    let child;
    try {
      child = spawn('powershell.exe', ['-NoProfile', '-NonInteractive', '-ExecutionPolicy', 'Bypass', '-Command',
        `[Console]::OutputEncoding=[Text.Encoding]::UTF8; ${script}`], { windowsHide: true, env: { ...process.env, ...env } });
    } catch { resolve(''); return; }
    const timer = setTimeout(() => { try { child.kill(); } catch { /* gone */ } }, timeoutMs);
    child.stdout.on('data', (c) => { out += c; });
    child.on('error', () => { clearTimeout(timer); resolve(''); });
    child.on('close', () => { clearTimeout(timer); resolve(out.trim()); });
  });
}

/**
 * The monitors, numbered the way TightVNC numbers them (1, 2, ...).
 * -> [{n, label, primary, width, height}] ([] when it cannot tell)
 * A hub started as a background task sees no screens of its own; then the
 * count of active monitors from WMI is used, without sizes.
 */
export async function listScreens() {
  if (process.platform !== 'win32') return [];
  const out = await psAsync([
    'Add-Type -AssemblyName System.Windows.Forms',
    '$s = @([System.Windows.Forms.Screen]::AllScreens | ForEach-Object { [pscustomobject]@{ primary = $_.Primary; w = $_.Bounds.Width; h = $_.Bounds.Height; x = $_.Bounds.X; y = $_.Bounds.Y } })',
    '$wmi = 0; try { $wmi = @(Get-CimInstance -Namespace root\\wmi -ClassName WmiMonitorBasicDisplayParams -ErrorAction Stop | Where-Object { $_.Active }).Count } catch { }',
    '[pscustomobject]@{ screens = $s; wmi = $wmi } | ConvertTo-Json -Compress -Depth 4',
  ].join('; '));
  let j;
  try { j = JSON.parse(out); } catch { return []; }
  const screens = (Array.isArray(j.screens) ? j.screens : j.screens ? [j.screens] : []);
  if (screens.length >= Math.max(1, j.wmi || 0)) {
    // Sizes are left out of the label: TightVNC shares physical pixels, Windows reports scaled ones.
    return screens.map((s, i) => ({ n: i + 1, primary: Boolean(s.primary), width: s.w, height: s.h, label: `屏幕 ${i + 1}${s.primary ? '（主屏）' : ''}` }));
  }
  return Array.from({ length: j.wmi }, (_, i) => ({ n: i + 1, primary: false, width: null, height: null, label: `屏幕 ${i + 1}` }));
}

/** The running TightVNC and how to talk to it. -> {exe, control} or null */
export async function runningVnc() {
  if (process.platform !== 'win32') return null;
  const out = await psAsync("Get-CimInstance Win32_Process -Filter \"Name='tvnserver.exe'\" | ForEach-Object { [pscustomobject]@{ path = $_.ExecutablePath; cmd = $_.CommandLine } } | ConvertTo-Json -Compress");
  let list = [];
  try { const j = JSON.parse(out); list = Array.isArray(j) ? j : [j]; } catch { return null; }
  const server = list.find((p) => /\s-(service|run)\b/i.test(p.cmd || '')) || list.find((p) => !/-controlapp/i.test(p.cmd || ''));
  if (!server?.path) return null;
  return { exe: server.path, control: /\s-service\b/i.test(server.cmd || '') ? '-controlservice' : '-controlapp' };
}

/** 'primary' | 'all' | a screen number -> the TightVNC command line. */
export function shareArgs(choice) {
  if (choice === 'all') return ['-sharefull'];
  const n = Number(choice);
  if (Number.isInteger(n) && n >= 1 && n <= 16) return ['-sharedisplay', String(n)];
  return ['-shareprimary'];
}

/** Tell the running TightVNC what to show. -> {ok, error?} */
export async function shareScreen(choice) {
  const vnc = await runningVnc();
  if (!vnc) return { ok: false, error: '这台电脑上没有在运行的 TightVNC' };
  return new Promise((resolve) => {
    const child = spawn(vnc.exe, [vnc.control, ...shareArgs(choice)], { windowsHide: true, stdio: 'ignore' });
    const timer = setTimeout(() => { try { child.kill(); } catch { /* gone */ } resolve({ ok: false, error: 'TightVNC 没有回应' }); }, 10000);
    child.on('error', (err) => { clearTimeout(timer); resolve({ ok: false, error: err.message }); });
    child.on('close', (code) => { clearTimeout(timer); resolve(code === 0 ? { ok: true } : { ok: false, error: `TightVNC 返回 ${code}` }); });
  });
}

/** Stop the copy Nightshift started (only that one). */
export function stopLocalVnc(state) {
  if (!state || state.mode !== 'own') return false;
  try { shutdown(state.exe, state.pid); } catch { /* gone */ }
  return true;
}
