/**
 * clipboard.mjs - read and write the clipboard of a bot's screen on this hub.
 *
 * Why not just the viewer: the VNC clipboard message is Latin-1 (RFB 6.4.6),
 * and x11vnc / wayvnc / TightVNC do not speak noVNC's UTF-8 extension, so any
 * Chinese text arrives as "?". The hub sits next to the screen, so it can put
 * the real text there with the screen's own clipboard tool:
 *   X11      xclip -selection clipboard (or xsel --clipboard)
 *   Wayland  wl-copy / wl-paste (wl-clipboard)
 *   Windows  Set-Clipboard / Get-Clipboard, only when the hub runs in the
 *            signed-in desktop session (a service session has its own clipboard).
 *
 * The text goes through stdin, never a command line.
 */

import { spawn, spawnSync } from 'node:child_process';

export const CLIPBOARD_MAX_CHARS = 100000;
const TIMEOUT_MS = 8000;

function has(bin) {
  try {
    return spawnSync('sh', ['-c', `command -v ${bin}`], { encoding: 'utf8', timeout: 4000 }).status === 0;
  } catch {
    return false;
  }
}

const PS = ['-NoProfile', '-NonInteractive', '-ExecutionPolicy', 'Bypass', '-Command'];

/**
 * Which commands reach this screen. `env` is desktopEnv(botId) on Linux.
 * -> {set: [file, args], get: [file, args], via} or {error, reason}
 */
export function clipboardTool(env = {}, { platform = process.platform, exists = has, sessionName = process.env.SESSIONNAME } = {}) {
  // Tests: a stand-in that keeps the text in a file (never the real clipboard).
  const fake = process.env.DESK_CLIP_FAKE;
  if (fake) return { via: 'fake', set: [process.execPath, [fake, 'set']], get: [process.execPath, [fake, 'get']] };
  if (platform === 'win32') {
    // A scheduled task (S4U) or service has no SESSIONNAME and its own,
    // invisible clipboard; writing there would look fine and do nothing.
    if (!sessionName) return { error: 'CLIP_NO_SESSION', reason: 'the hub runs without a signed-in desktop session' };
    return {
      via: 'powershell',
      set: ['powershell.exe', [...PS, '[Console]::InputEncoding=[Text.Encoding]::UTF8; Set-Clipboard -Value ([Console]::In.ReadToEnd())']],
      get: ['powershell.exe', [...PS, '[Console]::OutputEncoding=[Text.Encoding]::UTF8; $t=Get-Clipboard -Raw; if($t){[Console]::Out.Write($t)}']],
    };
  }
  if (env.WAYLAND_DISPLAY) {
    if (!exists('wl-copy') || !exists('wl-paste')) return { error: 'CLIP_TOOL_MISSING', reason: 'wl-clipboard is not installed', install: 'wl-clipboard' };
    return { via: 'wl-clipboard', set: ['wl-copy', []], get: ['wl-paste', ['--no-newline']] };
  }
  if (env.DISPLAY) {
    if (exists('xclip')) return { via: 'xclip', set: ['xclip', ['-selection', 'clipboard', '-i']], get: ['xclip', ['-selection', 'clipboard', '-o']] };
    if (exists('xsel')) return { via: 'xsel', set: ['xsel', ['--clipboard', '--input']], get: ['xsel', ['--clipboard', '--output']] };
    return { error: 'CLIP_TOOL_MISSING', reason: 'xclip is not installed', install: 'xclip' };
  }
  return { error: 'CLIP_NO_DESKTOP', reason: 'this bot has no screen running' };
}

/**
 * Machines set up before the setup script installed the clipboard tool: try
 * once to add it the same way other hub tasks do (sudo -n, no prompt). Quietly
 * gives up when sudo needs a password.
 */
const installTried = new Set();
export function installClipTool(pkg, { platform = process.platform } = {}) {
  if (platform === 'win32' || !pkg || installTried.has(pkg)) return Promise.resolve(false);
  installTried.add(pkg);
  return sudoInstall(pkg, { timeoutMs: 300000 });
}

/**
 * Install packages the way other hub tasks do (sudo -n, never a prompt): apt
 * (refresh and retry; Ubuntu with an unreachable archive gets a domestic
 * mirror in a list of its own) or dnf. `dnf` overrides what dnf installs
 * (e.g. a group). -> true when the command succeeded.
 */
export function sudoInstall(pkg, { timeoutMs = 300000, dnf = '' } = {}) {
  if (process.platform === 'win32' || !pkg) return Promise.resolve(false);
  // An old package list answers 404 for the file: refresh it and try once more.
  // Ubuntu whose own archive is unreachable (seen: a proxy answering 404 for
  // it): the mirror setup-linux.sh uses, in a list of its own, so the
  // system's sources stay as they are.
  const apt = (o = '') => `sudo -n env DEBIAN_FRONTEND=noninteractive apt-get -o DPkg::Lock::Timeout=900 ${o} install -y -q ${pkg}`;
  const mirror = [
    '. /etc/os-release && [ "$ID" = ubuntu ] && [ -n "$VERSION_CODENAME" ]',
    'K=/usr/share/keyrings/ubuntu-archive-keyring.gpg && [ -f "$K" ]',
    'L=/tmp/desk-apt-mirror && sudo -n mkdir -p "$L/lists/partial"',
    'printf "deb [signed-by=%s] https://mirrors.aliyun.com/ubuntu %s main universe\\ndeb [signed-by=%s] https://mirrors.aliyun.com/ubuntu %s-updates main universe\\n" "$K" "$VERSION_CODENAME" "$K" "$VERSION_CODENAME" | sudo -n tee "$L/sources.list" >/dev/null',
    'M="-o Dir::Etc::SourceList=$L/sources.list -o Dir::Etc::SourceParts=/nonexistent -o Dir::State::Lists=$L/lists"',
    'sudo -n apt-get $M update -q',
    apt('$M'),
  ].join(' && ');
  const cmd = `if command -v apt-get >/dev/null; then ${apt()} || { sudo -n apt-get update -q && ${apt()}; } || { ${mirror}; }`
    + `; elif command -v dnf >/dev/null; then sudo -n dnf ${dnf || `install -y -q ${pkg}`}; else exit 1; fi`;
  return new Promise((resolve) => {
    let child;
    try { child = spawn('sh', ['-c', cmd], { stdio: 'ignore' }); } catch { resolve(false); return; }
    const timer = setTimeout(() => { try { child.kill(); } catch { /* gone */ } resolve(false); }, timeoutMs);
    child.on('error', () => { clearTimeout(timer); resolve(false); });
    child.on('exit', (code) => { clearTimeout(timer); resolve(code === 0); });
  });
}

async function toolFor(env, opts) {
  let tool = clipboardTool(env, opts);
  if (tool.error === 'CLIP_TOOL_MISSING' && !opts && await installClipTool(tool.install)) tool = clipboardTool(env, opts);
  return tool;
}

/** Put text on the screen's clipboard. -> {ok, via} or {ok: false, code, reason} */
export async function setClipboard(env, text, opts) {
  const tool = await toolFor(env, opts);
  if (tool.error) return Promise.resolve({ ok: false, code: tool.error, reason: tool.reason, install: tool.install });
  const value = String(text ?? '').slice(0, CLIPBOARD_MAX_CHARS);
  return new Promise((resolve) => {
    let child;
    try {
      // xclip and wl-copy fork a child that keeps serving the selection; it
      // inherits no pipe of ours (or 'close' would wait for it) and is let go.
      child = spawn(tool.set[0], tool.set[1], {
        env: { ...process.env, ...env },
        stdio: ['pipe', 'ignore', 'ignore'],
        windowsHide: true,
        detached: process.platform !== 'win32',
      });
    } catch (err) {
      resolve({ ok: false, code: 'CLIP_FAILED', reason: err.message });
      return;
    }
    const timer = setTimeout(() => { try { child.kill(); } catch { /* gone */ } resolve({ ok: false, code: 'CLIP_TIMEOUT', reason: 'timed out' }); }, TIMEOUT_MS);
    child.on('error', (err) => { clearTimeout(timer); resolve({ ok: false, code: 'CLIP_FAILED', reason: err.message }); });
    child.on('exit', (code) => {
      clearTimeout(timer);
      resolve(code === 0 ? { ok: true, via: tool.via } : { ok: false, code: 'CLIP_FAILED', reason: `${tool.via} exited with ${code}` });
    });
    child.unref?.();
    child.stdin.on('error', () => {});
    child.stdin.end(value, 'utf8');
  });
}

/** Read the screen's clipboard. -> {ok, text, via} or {ok: false, code, reason} */
export async function getClipboard(env, opts) {
  const tool = await toolFor(env, opts);
  if (tool.error) return Promise.resolve({ ok: false, code: tool.error, reason: tool.reason, install: tool.install });
  return new Promise((resolve) => {
    let child;
    try {
      child = spawn(tool.get[0], tool.get[1], { env: { ...process.env, ...env }, stdio: ['ignore', 'pipe', 'ignore'], windowsHide: true });
    } catch (err) {
      resolve({ ok: false, code: 'CLIP_FAILED', reason: err.message });
      return;
    }
    const chunks = [];
    let size = 0;
    const timer = setTimeout(() => { try { child.kill(); } catch { /* gone */ } }, TIMEOUT_MS);
    child.stdout.on('data', (c) => { if (size < CLIPBOARD_MAX_CHARS * 4) { chunks.push(c); size += c.length; } });
    child.on('error', (err) => { clearTimeout(timer); resolve({ ok: false, code: 'CLIP_FAILED', reason: err.message }); });
    child.on('close', (code) => {
      clearTimeout(timer);
      const text = Buffer.concat(chunks).toString('utf8').slice(0, CLIPBOARD_MAX_CHARS);
      // An empty clipboard makes xclip / wl-paste exit non-zero: that is "nothing", not a failure.
      resolve(code === 0 || !text ? { ok: true, text, via: tool.via } : { ok: false, code: 'CLIP_FAILED', reason: `${tool.via} exited with ${code}` });
    });
  });
}
