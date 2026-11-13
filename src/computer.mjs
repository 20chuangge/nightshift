/**
 * computer.mjs - "看那台机器" 的最小实现。
 *
 * Hub 可能是一台 Windows 或者一台 Linux（VM / 云主机）。这个模块只做三件事：
 *   1. 报机器的身体数据（CPU/内存/磁盘/uptime/热门进程）
 *   2. 截一张当前屏幕（有桌面会话时才可能成功，无头机器返回明确的 501）
 *   3. 报浏览器（CDP）的状态，方便在面板里把它关掉
 *
 * 零依赖：Windows 用 PowerShell + System.Drawing，Linux 依次试
 * grim / gnome-screenshot / scrot / import。
 */
import os from 'node:os';
import fs from 'node:fs';
import fsp from 'node:fs/promises';
import path from 'node:path';
import { spawn } from 'node:child_process';

/** Run a command and collect stdout as text. Never throws on a non-zero exit. */
function run(cmd, args, { timeoutMs = 8000 } = {}) {
  return new Promise((resolve) => {
    let child;
    try {
      child = spawn(cmd, args, { windowsHide: true });
    } catch (err) {
      resolve({ code: -1, stdout: '', stderr: String(err.message || err) });
      return;
    }
    let out = '';
    let err = '';
    const timer = setTimeout(() => {
      try { child.kill(); } catch { /* gone */ }
    }, timeoutMs);
    child.stdout?.on('data', (b) => { out += b.toString(); });
    child.stderr?.on('data', (b) => { err += b.toString(); });
    child.on('error', (e) => { clearTimeout(timer); resolve({ code: -1, stdout: out, stderr: String(e.message || e) }); });
    child.on('close', (code) => { clearTimeout(timer); resolve({ code: code ?? -1, stdout: out, stderr: err }); });
  });
}

function diskInfo() {
  try {
    // Node >= 18.15: statfs works on Windows and Linux.
    const st = fs.statfsSync('/');
    const total = Number(st.bsize) * Number(st.blocks);
    const free = Number(st.bsize) * Number(st.bavail ?? st.bfree);
    return { path: '/', totalBytes: total, freeBytes: free };
  } catch {
    try {
      const st = fs.statfsSync(process.platform === 'win32' ? 'C:\\' : '/');
      const total = Number(st.bsize) * Number(st.blocks);
      const free = Number(st.bsize) * Number(st.bavail ?? st.bfree);
      return { path: process.platform === 'win32' ? 'C:\\' : '/', totalBytes: total, freeBytes: free };
    } catch {
      return null;
    }
  }
}

/*
 * The computer pane polls every few seconds and every poll used to start a
 * process-list command; on Windows that is a PowerShell each time, which pins
 * a 1-core machine. One lookup per 30 s, shared by everyone who asks.
 */
const PROCESS_TTL_MS = 30_000;
let processCache = { at: 0, value: [], pending: null };

async function topProcesses() {
  if (processCache.pending) return processCache.pending;
  if (Date.now() - processCache.at < PROCESS_TTL_MS) return processCache.value;
  processCache.pending = readTopProcesses()
    .then((value) => { processCache = { at: Date.now(), value, pending: null }; return value; })
    .catch(() => { processCache.pending = null; return processCache.value; });
  return processCache.pending;
}

async function readTopProcesses() {
  if (process.platform === 'win32') {
    const ps = await run('powershell', [
      '-NoProfile', '-Command',
      "Get-Process | Sort-Object -Property CPU -Descending | Select-Object -First 6 Name,Id,CPU,WS | ConvertTo-Json -Compress",
    ]);
    if (ps.code !== 0) return [];
    try {
      const rows = JSON.parse(ps.stdout.trim() || '[]');
      return (Array.isArray(rows) ? rows : [rows]).map((r) => ({
        name: r.Name, pid: r.Id, cpuSec: Math.round(Number(r.CPU) || 0), memBytes: Number(r.WS) || 0,
      }));
    } catch {
      return [];
    }
  }
  const ps = await run('ps', ['-eo', 'pid,comm,%cpu,%mem', '--sort=-%cpu']);
  if (ps.code !== 0) return [];
  return ps.stdout
    .split('\n')
    .slice(1, 7)
    .map((line) => line.trim().split(/\s+/))
    .filter((parts) => parts.length >= 4)
    .map(([pid, comm, cpu, mem]) => ({
      name: comm, pid: Number(pid), cpuPercent: Number(cpu), memPercent: Number(mem),
    }));
}

/** Whether a screen capture is even conceivable on this machine. */
function displayAvailable() {
  // Interactive Windows sessions set SESSIONNAME (Console, RDP-Tcp#…). A hub
  // started by the NightshiftHub task runs in session 0, which has no screen.
  if (process.platform === 'win32') return Boolean(process.env.SESSIONNAME);
  return Boolean(process.env.DISPLAY || process.env.WAYLAND_DISPLAY);
}

/**
 * Capture the whole screen into `target` (png). Returns {ok, tool} or {ok:false, reason}.
 * Linux order matters: grim (Wayland) → gnome-screenshot → scrot → import (X11).
 */
export async function captureScreen(target) {
  await fsp.mkdir(path.dirname(target), { recursive: true });
  if (process.platform === 'win32' && !displayAvailable()) {
    return { ok: false, reason: '这台 Windows 上的长明在后台运行（没人登录也能干活），没有屏幕可以截；Bot 的浏览器在后台无界面运行。' };
  }
  if (process.platform === 'win32') {
    const script = [
      'Add-Type -AssemblyName System.Windows.Forms,System.Drawing;',
      '$b=[System.Windows.Forms.Screen]::PrimaryScreen.Bounds;',
      '$bmp=New-Object System.Drawing.Bitmap $b.Width,$b.Height;',
      '$g=[System.Drawing.Graphics]::FromImage($bmp);',
      '$g.CopyFromScreen($b.Location,[System.Drawing.Point]::Empty,$b.Size);',
      `$bmp.Save('${target.replace(/'/g, "''")}',[System.Drawing.Imaging.ImageFormat]::Png);`,
    ].join(' ');
    const ps = await run('powershell', ['-NoProfile', '-NonInteractive', '-Command', script], { timeoutMs: 15000 });
    if (ps.code === 0 && fs.existsSync(target)) return { ok: true, tool: 'powershell' };
    return { ok: false, reason: (ps.stderr || ps.stdout || 'powershell capture failed').trim().slice(0, 300) };
  }

  if (!displayAvailable()) {
    return { ok: false, reason: 'no DISPLAY on this machine (headless hub); run it with a desktop session or Xvfb' };
  }

  const attempts = [
    ['grim', [target]],
    ['gnome-screenshot', ['-f', target]],
    ['scrot', ['-o', target]],
    ['import', ['-window', 'root', target]],
  ];
  const tried = [];
  for (const [cmd, args] of attempts) {
    const res = await run(cmd, args, { timeoutMs: 15000 });
    if (res.code === 0 && fs.existsSync(target)) return { ok: true, tool: cmd };
    tried.push(`${cmd}:${res.code}`);
  }
  return { ok: false, reason: `no capture tool worked (${tried.join(', ')}); install scrot or imagemagick` };
}

/** First non-internal IPv4 — the address other devices should use. */
export function lanAddress() {
  const nets = os.networkInterfaces();
  for (const list of Object.values(nets)) {
    for (const net of list || []) {
      if (net.family === 'IPv4' && !net.internal) return net.address;
    }
  }
  return '127.0.0.1';
}

/**
 * Where the machine's shared desktop viewer lives, for hubs without per-bot
 * desktops (noVNC on 6080 by convention). Overriding DESK_VNC_URL lets a tunnel
 * or a different port win without touching the UI.
 */
export function desktopUrl() {
  // Only a viewer someone actually set up. Advertising :6080 on every machine
  // was why Windows showed a black, never-connecting preview.
  return process.env.DESK_VNC_URL || null;
}

/** The JSON body behind GET /api/computer. */
export async function computerSnapshot({ screenshotPath } = {}) {
  const load = os.loadavg();
  const cpus = os.cpus();
  const processList = await topProcesses();
  return {
    host: {
      platform: process.platform,
      release: os.release(),
      arch: process.arch,
      hostname: os.hostname(),
      timezone: Intl.DateTimeFormat().resolvedOptions().timeZone || '',
      node: process.versions.node,
      uptimeSec: Math.round(os.uptime()),
      displayAvailable: displayAvailable(),
      screen: screenshotPath ? { available: true, path: screenshotPath } : { available: false },
    },
    cpu: {
      cores: cpus.length,
      model: cpus[0]?.model?.trim() || '',
      load1: Number(load[0]?.toFixed?.(2) ?? load[0] ?? 0),
      // Windows has no real loadavg; derive a coarse percentage from the busy
      // ticks of the last two samples instead of reporting a lie.
      usagePercent: cpuUsagePercent(cpus),
    },
    memory: {
      totalBytes: os.totalmem(),
      freeBytes: os.freemem(),
      usedPercent: Math.round(((os.totalmem() - os.freemem()) / os.totalmem()) * 1000) / 10,
    },
    disk: diskInfo(),
    processes: processList,
    desktop: { url: desktopUrl(), lanAddress: lanAddress() },
  };
}

let lastCpuSample = null;
/** Coarse CPU usage from cumulative tick deltas (works on Windows too). */
function cpuUsagePercent(cpus) {
  const now = cpus.reduce((acc, c) => {
    const t = c.times;
    acc.idle += t.idle;
    acc.total += t.user + t.nice + t.sys + t.idle + t.irq;
    return acc;
  }, { idle: 0, total: 0 });

  const prev = lastCpuSample;
  lastCpuSample = now;
  if (!prev) return 0;
  const total = now.total - prev.total;
  const idle = now.idle - prev.idle;
  if (total <= 0) return 0;
  return Math.max(0, Math.min(100, Math.round((1 - idle / total) * 1000) / 10));
}
