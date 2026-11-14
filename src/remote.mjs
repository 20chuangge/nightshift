/**
 * remote.mjs - turn a machine you can SSH into into a Desk machine.
 *
 * The human gives an address and an SSH account. We find out what the target
 * runs, upload the app and the one setup script for that OS, run it with sudo,
 * and hand back the new hub's address and pairing code. Nothing is required on
 * the target beforehand, and the SSH password is held in memory for this one
 * job only - it is never persisted or logged.
 *
 * Linux (apt and dnf/yum families) runs hub/setup-linux.sh with sudo; Windows
 * (OpenSSH server, admin account) runs hub/setup-windows.ps1.
 */

import net from 'node:net';
// The TightVNC MSI (cached here, uploaded to new Windows machines; also this computer's own screen).
import { tightVncInstaller } from './localvnc.mjs';
import crypto from 'node:crypto';
import os from 'node:os';
import path from 'node:path';
import fsp from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import { uid, nowIso } from './store.mjs';
import { packApp, cleanupPack } from './bundle.mjs';

// ssh2 is only needed when this machine PROVISIONS another one. Importing it
// eagerly would make a freshly deployed hub crash on boot when node_modules was
// not shipped, so load it on first use instead.
let ssh2Module = null;
async function loadSsh2() {
  if (!ssh2Module) {
    try {
      ssh2Module = await import('ssh2');
    } catch {
      throw remoteError('REMOTE_NO_SSH2', '这台机器上没有 ssh2 依赖，无法再远程配置别的机器；请在留灯客户端里操作。');
    }
  }
  return ssh2Module;
}

const HERE = path.dirname(fileURLToPath(import.meta.url));
const SETUP_SCRIPTS = {
  linux: path.join(HERE, '..', 'hub', 'setup-linux.sh'),
  windows: path.join(HERE, '..', 'hub', 'setup-windows.ps1'),
};
// A freshly restored machine downloads everything (Node, a desktop, a browser)
// and may be sharing its package lock with the OS's own updates: give it an hour.
const JOB_TIMEOUT_MS = 60 * 60 * 1000;

/** Setup scripts tag their lines "[desk]"; the human only needs the words. */
const cleanLine = (text) => String(text).replace(/^\s*\[desk\]\s*/, '').replace(/^警告：/, '⚠ ');

/** A Tailscale device name from the machine's name: letters, digits, dashes (or none). */
export function tailscaleDeviceName(name) {
  return String(name || '').toLowerCase().replace(/[^a-z0-9-]+/g, '-').replace(/^-+|-+$/g, '').slice(0, 60);
}

function remoteError(code, message) {
  const err = new Error(message);
  err.code = code;
  err.status = 400;
  return err;
}

/** Hostnames/IPs only. The value becomes an SSH target, never a shell string. */
export function assertHost(host) {
  const value = String(host ?? '').trim();
  if (!value || value.length > 253) throw remoteError('REMOTE_BAD_HOST', 'a machine address is required');
  if (!/^[A-Za-z0-9._:-]+$/.test(value)) throw remoteError('REMOTE_BAD_HOST', `"${value}" is not a valid host`);
  if (value.startsWith('-')) throw remoteError('REMOTE_BAD_HOST', 'host must not start with "-"');
  return value;
}

function assertPort(value, fallback, name) {
  const port = value === undefined || value === null || value === '' ? fallback : Number(value);
  if (!Number.isInteger(port) || port < 1 || port > 65535) {
    throw remoteError('REMOTE_BAD_PORT', `${name} must be a TCP port between 1 and 65535`);
  }
  return port;
}

function assertCredential(value, name) {
  const text = String(value ?? '');
  if (!text) throw remoteError('REMOTE_CREDENTIALS', `${name} is required`);
  if (text.includes('\n') || text.includes('\r')) {
    throw remoteError('REMOTE_CREDENTIALS', `${name} must not contain a newline`);
  }
  return text;
}

/** One TCP reachability probe. Never throws. */
export function probeTcp(host, port, timeoutMs = 1800) {
  return new Promise((resolve) => {
    const started = Date.now();
    const socket = net.connect({ host, port });
    let settled = false;
    const finish = (reachable) => {
      if (settled) return;
      settled = true;
      socket.destroy();
      resolve({ reachable, latencyMs: Date.now() - started });
    };
    socket.setTimeout(timeoutMs);
    socket.once('connect', () => finish(true));
    socket.once('timeout', () => finish(false));
    socket.once('error', () => finish(false));
  });
}

// ---------------------------------------------------------------------------
// ssh helpers
// ---------------------------------------------------------------------------

function shellQuote(value) {
  return `'${String(value).replace(/'/g, `'\\''`)}'`;
}

/** SSH errors are accurate but unreadable; say what the human can act on. */
function friendlySshError(err) {
  const message = String(err?.message || '');
  if (/authentication methods failed|All configured/i.test(message)) {
    return 'SSH 账号或密码不对，或者这个账号禁止密码登录。';
  }
  if (/ECONNREFUSED/i.test(message)) {
    return '连不上 SSH 端口。确认机器已开机、SSH 服务在跑、端口没有写错。';
  }
  if (/ENOTFOUND|EAI_AGAIN/i.test(message)) {
    return '解析不到这个地址，检查 IP 或主机名。';
  }
  if (/timed out|ETIMEDOUT|timeout/i.test(message)) {
    return '连接 SSH 超时，检查两台机器是否在同一网络、防火墙是否放行。';
  }
  return message || '远程配置失败';
}

function connectSsh({ host, port, username, password }) {
  return new Promise(async (resolve, reject) => {
    const { Client } = await loadSsh2();
    const client = new Client();
    let settled = false;
    const finish = (err) => {
      if (settled) return;
      settled = true;
      if (err) {
        client.end();
        reject(err);
      } else {
        resolve(client);
      }
    };
    client.once('ready', () => finish(null));
    // `on`, not `once`: Windows OpenSSH resets the socket after refusing a
    // login, so a second 'error' follows the first. With no listener left,
    // Node treats it as unhandled and the whole server process dies.
    client.on('error', (err) => finish(err));
    client.connect({
      host,
      port,
      username,
      password,
      // Windows OpenSSH on a fresh VM can take 15-20 s to finish the handshake.
      readyTimeout: 45000,
      keepaliveInterval: 10000,
      keepaliveCountMax: 3,
    });
  });
}

/**
 * Upload a local file to the target over SFTP. Used for the app tarball: piping
 * a megabyte through `exec` stdin works but is fragile on slow links.
 */
function uploadFile(client, localPath, remotePath) {
  return new Promise((resolve, reject) => {
    client.sftp((err, sftp) => {
      if (err) {
        reject(remoteError('REMOTE_UPLOAD_FAILED', `SFTP 不可用：${err.message}`));
        return;
      }
      sftp.fastPut(localPath, remotePath, (putErr) => {
        sftp.end?.();
        if (putErr) reject(remoteError('REMOTE_UPLOAD_FAILED', `上传失败：${putErr.message}`));
        else resolve(true);
      });
    });
  });
}

/**
 * Exec one command, streaming output. `stdin` is written immediately (used for
 * the sudo password). Resolves with the exit code; throws on timeout.
 */
function execStream(client, command, { stdin = '', endInput = false, onLine = () => {}, timeoutMs = JOB_TIMEOUT_MS } = {}) {
  return new Promise((resolve, reject) => {
    let done = false;
    let output = '';
    let pending = '';
    const timer = setTimeout(() => {
      if (done) return;
      done = true;
      reject(remoteError('REMOTE_TIMEOUT', `那台机器上的安装超过 ${Math.round(timeoutMs / 60000)} 分钟还没结束（多半是下载太慢），它会在后台继续装完。过几分钟再点一次「连接并自动配置」，会等它装完再接着做。`));
    }, timeoutMs);

    client.exec(command, (err, stream) => {
      if (err) {
        clearTimeout(timer);
        done = true;
        reject(err);
        return;
      }
      const consume = (chunk) => {
        const text = chunk.toString('utf8');
        output += text;
        if (output.length > 200000) output = output.slice(-200000);
        pending += text;
        const lines = pending.split(/\r?\n/);
        pending = lines.pop() || '';
        for (const line of lines) onLine(line);
      };
      stream.on('data', consume);
      stream.stderr?.on('data', consume);
      stream.on('close', (code) => {
        clearTimeout(timer);
        if (pending) onLine(pending);
        if (done) return;
        done = true;
        resolve({ code: code ?? 0, output });
      });
      if (stdin) stream.write(stdin);
      // "sudo -S" reads one line and goes on; "cat > file" waits for the end of input.
      if (endInput) stream.end();
    });
  });
}

export { execStream as _execStream };

// ---------------------------------------------------------------------------
// provisioning jobs
// ---------------------------------------------------------------------------

/**
 * Give a freshly installed hub the same model as the machine that set it up,
 * so a new machine works the moment it is added. Pairs with the install's
 * code, then PUTs the settings; the key travels once, over the LAN, to the
 * hub that will use it.
 */
async function shareModel(hubUrl, pairCode, model, voice = null, vision = null) {
  const pair = await fetch(`${hubUrl}/api/pair`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ code: pairCode }),
    signal: AbortSignal.timeout(15000),
  });
  if (!pair.ok) throw new Error(`pair HTTP ${pair.status}`);
  const cookie = (pair.headers.get('set-cookie') || '').split(';')[0];
  const res = await fetch(`${hubUrl}/api/settings`, {
    method: 'PUT',
    headers: { 'content-type': 'application/json', cookie },
    body: JSON.stringify(model),
    signal: AbortSignal.timeout(15000),
  });
  if (!res.ok) throw new Error(`settings HTTP ${res.status}`);
  if (voice) {
    const v = await fetch(`${hubUrl}/api/voice`, {
      method: 'PUT',
      headers: { 'content-type': 'application/json', cookie },
      body: JSON.stringify(voice),
      signal: AbortSignal.timeout(15000),
    });
    if (!v.ok) throw new Error(`voice HTTP ${v.status}`);
  }
  if (vision) {
    const v = await fetch(`${hubUrl}/api/vision`, {
      method: 'PUT',
      headers: { 'content-type': 'application/json', cookie },
      body: JSON.stringify(vision),
      signal: AbortSignal.timeout(15000),
    });
    if (!v.ok) throw new Error(`vision HTTP ${v.status}`);
  }
}

/**
 * The Node.js build a target needs, downloaded once on this computer (checked
 * against the official SHA-256 list) and cached, then uploaded over the LAN:
 * a fresh machine downloading 30 MB from nodejs.org is often the slowest step
 * of an install. kind: 'linux' (tar.gz) | 'win' (zip); arch: x64 | arm64.
 * Returns {file, bytes} or null (the target then downloads it itself).
 */
export async function nodePackage(kind, arch = 'x64') {
  const ext = kind === 'win' ? 'zip' : 'tar.gz';
  const dir = path.join(os.tmpdir(), 'nightshift-cache');
  await fsp.mkdir(dir, { recursive: true });
  const re = new RegExp(`^node-v22\\.[0-9.]+-${kind}-${arch}\\.${ext.replace('.', '\\.')}$`);
  const cached = (await fsp.readdir(dir).catch(() => [])).filter((n) => re.test(n)).sort().pop();
  if (cached) {
    const st = await fsp.stat(path.join(dir, cached));
    if (st.size > 10 * 1024 * 1024) return { file: path.join(dir, cached), bytes: st.size };
  }
  for (const base of ['https://npmmirror.com/mirrors/node/latest-v22.x', 'https://nodejs.org/dist/latest-v22.x']) {
    try {
      const sums = await (await fetch(`${base}/SHASUMS256.txt`, { signal: AbortSignal.timeout(20000) })).text();
      const line = sums.split('\n').find((l) => re.test(l.trim().split(/\s+/).pop() || ''));
      if (!line) continue;
      const [hash, name] = line.trim().split(/\s+/);
      const res = await fetch(`${base}/${name}`, { signal: AbortSignal.timeout(300000) });
      if (!res.ok) continue;
      const bytes = Buffer.from(await res.arrayBuffer());
      if (crypto.createHash('sha256').update(bytes).digest('hex') !== hash.toLowerCase()) continue;
      const file = path.join(dir, name);
      await fsp.writeFile(`${file}.part`, bytes);
      await fsp.rename(`${file}.part`, file);
      return { file, bytes: bytes.length };
    } catch { /* next source */ }
  }
  return null;
}

/** modelToShare: () => {provider, baseUrl, model, apiKey} | null
 *  voiceToShare: () => {baseUrl, model, apiKey} | null  (speech-to-text) */
export function createProvisioner({ modelToShare = () => null, voiceToShare = () => null, visionToShare = () => null } = {}) {
  /** @type {Map<string, object>} */
  const jobs = new Map();

  const publicJob = (job) => ({
    id: job.id,
    state: job.state,
    message: job.message,
    step: job.step,
    totalSteps: job.totalSteps,
    address: job.address || '',
    os: job.os || '',
    hubPort: job.hubPort,
    hubUrl: job.hubUrl || '',
    pairCode: job.pairCode || '',
    modelShared: Boolean(job.modelShared),
    // How long each step took, to see what makes an install slow.
    timings: (job.timings || []).map((t) => ({ label: t.label, ms: t.ms })),
    desktopPending: Boolean(job.desktopPending),
    tailscale: job.tailscale || '',
    startedAt: job.startedAt,
    finishedAt: job.finishedAt || null,
    log: job.log.slice(-24),
  });

  /** Start timing a phase; the previous one ends here. */
  const phase = (job, label) => {
    const now = Date.now();
    job.timings = job.timings || [];
    const last = job.timings[job.timings.length - 1];
    if (last && last.ms === undefined) last.ms = now - last.at;
    if (label) job.timings.push({ label, at: now });
  };

  const setProgress = (job, message) => {
    job.message = message;
    // The setup scripts announce their steps as "[desk] 3/7 …".
    const scriptStep = /^(?:\[desk\]\s*)?(\d+\s*\/\s*\d+\s+.+)$/.exec(String(message).trim());
    if (scriptStep) phase(job, scriptStep[1].slice(0, 40));
    const match = /(\d+)\s*\/\s*(\d+)/.exec(message);
    if (match) {
      job.step = Number(match[1]);
      job.totalSteps = Number(match[2]);
    }
    job.log.push(message);
    if (job.log.length > 200) job.log.splice(0, job.log.length - 200);
  };

  /** 'linux' | 'windows' | 'unknown', from whatever shell answers. */
  async function detectOs(client) {
    const probe = await execStream(client, 'uname -s', { timeoutMs: 15000 }).catch(() => ({ code: 1, output: '' }));
    if (probe.code === 0 && /linux/i.test(probe.output)) return 'linux';
    // Git for Windows / MSYS put a uname on PATH.
    if (probe.code === 0 && /mingw|msys|cygwin|windows/i.test(probe.output)) return 'windows';
    if (probe.code === 0 && probe.output.trim()) return 'unknown';
    // Windows OpenSSH starts cmd.exe ("ver") or PowerShell (no "ver"); ask
    // powershell.exe directly, which answers from either.
    const win = await execStream(client, 'ver', { timeoutMs: 15000 }).catch(() => ({ code: 1, output: '' }));
    if (/windows/i.test(win.output)) return 'windows';
    const ps = await execStream(client, 'powershell -NoProfile -Command [Environment]::OSVersion.VersionString', { timeoutMs: 20000 })
      .catch(() => ({ code: 1, output: '' }));
    return /windows/i.test(ps.output) ? 'windows' : 'unknown';
  }

  /**
   * Windows: upload into the account's home (SFTP starts there; cmd.exe and
   * PowerShell sessions too), then run the script with Windows PowerShell.
   * The script itself refuses a non-admin account.
   */
  /** Windows: the Tailscale key into a file only administrators can read (from stdin, never a command line). -> its path or '' */
  async function putWindowsTailscaleKey(client, key) {
    const ps = "$k=[Console]::In.ReadToEnd().Trim(); $p=Join-Path $env:SystemRoot 'Temp\\desk-tailscale.key'; "
      + "Set-Content -Path $p -Value $k -NoNewline -Encoding ascii; "
      + "icacls $p /inheritance:r /grant:r 'Administrators:F' 'SYSTEM:F' | Out-Null; "
      + "if ((Get-Item $p).Length -gt 10) { Write-Output \"KEYPATH=$p\" } else { exit 1 }";
    const put = await execStream(client, `powershell -NoProfile -Command "${ps.replace(/"/g, '\\"')}"`, { stdin: `${key}\n`, endInput: true, timeoutMs: 30000 })
      .catch((err) => ({ code: 1, output: err.message }));
    const m = /KEYPATH=(.+)/.exec(put.output || '');
    return put.code === 0 && m ? m[1].trim() : '';
  }

  async function installWindows(client, job, packed, hubPort, { tailscaleKey = '', tailscaleName = '' } = {}) {
    await uploadFile(client, packed.file, 'desk-hub.tar.gz');
    // The desktop (TightVNC) installer comes from here, not from the target:
    // a freshly installed Windows often cannot validate tightvnc.com's
    // certificate ("未能为 SSL/TLS 安全通道建立信任关系"), and some networks
    // cannot reach it. The target still checks GlavSoft's signature.
    let vncArg = '';
    const msi = await tightVncInstaller().catch(() => null);
    if (msi) {
      setProgress(job, `上传桌面组件 TightVNC（${Math.max(1, Math.round(msi.bytes / 1024 / 1024))} MB）…`);
      await uploadFile(client, msi.file, 'desk-tightvnc.msi');
      vncArg = ' -VncMsi desk-tightvnc.msi';
    }
    let nodeArg = '';
    const nodeZip = await nodePackage('win', 'x64').catch(() => null);
    if (nodeZip) {
      setProgress(job, `上传 Node.js（${Math.max(1, Math.round(nodeZip.bytes / 1024 / 1024))} MB，目标机器不用再下载）…`);
      await uploadFile(client, nodeZip.file, 'desk-node.zip');
      nodeArg = ' -NodeZip desk-node.zip';
    }
    // PowerShell 5.1 reads a BOM-less script as the ANSI code page, which
    // garbles the Chinese progress text; ship it with a UTF-8 BOM.
    const source = await fsp.readFile(SETUP_SCRIPTS.windows);
    const bom = Buffer.from([0xef, 0xbb, 0xbf]);
    const withBom = path.join(os.tmpdir(), `desk-setup-${process.pid}-${Date.now()}.ps1`);
    await fsp.writeFile(withBom, source.subarray(0, 3).equals(bom) ? source : Buffer.concat([bom, source]));
    try {
      await uploadFile(client, withBom, 'desk-setup.ps1');
    } finally {
      fsp.rm(withBom, { force: true }).catch(() => {});
    }
    // Optional Tailscale: the key goes in a private file first; never skipped silently.
    const windowsTailscaleArgs = async () => {
      if (!tailscaleKey) return '';
      setProgress(job, '把 Tailscale 密钥交给那台机器…');
      const keyPath = await putWindowsTailscaleKey(client, tailscaleKey);
      if (!keyPath) { job.tailscale = 'Tailscale 没装：密钥没能交给那台机器'; return ''; }
      return ` -TailscaleKeyFile "${keyPath}"${tailscaleName ? ` -TailscaleName ${tailscaleName}` : ''}`;
    };
    setProgress(job, '安装并启动（首次 2-5 分钟）…');
    return execStream(
      client,
      `powershell -NoProfile -ExecutionPolicy Bypass -File desk-setup.ps1 -Port ${Number(hubPort)} -Pkg desk-hub.tar.gz${vncArg}${nodeArg}${await windowsTailscaleArgs()}`,
      {
        onLine: (line) => {
          const text = line.trim();
          if (text && !/^DESK_/.test(text)) setProgress(job, cleanLine(text).slice(0, 300));
        },
      },
    );
  }

  async function run(job, { host, sshPort, username, password, hubPort, tailscaleKey = '', tailscaleName = '', desktop = '' }) {
    let client = null;
    try {
      phase(job, '连接 SSH');
      setProgress(job, '正在连接 SSH…');
      client = await connectSsh({ host, port: sshPort, username, password });

      setProgress(job, '识别系统…');
      job.os = await detectOs(client);
      if (job.os !== 'linux' && job.os !== 'windows') {
        throw remoteError('REMOTE_UNSUPPORTED_OS', '认不出这台机器的系统（不是 Linux 也不是 Windows），暂时没法自动配置。');
      }
      const windows = job.os === 'windows';

      let sudoPrefix = '';
      let isRoot = false;
      if (!windows) {
        setProgress(job, '检查 sudo 权限…');
        const identity = await execStream(client, 'id -u', { timeoutMs: 15000 });
        isRoot = identity.output.trim().split(/\s+/).pop() === '0';
        if (!isRoot) {
          const check = await execStream(client, "sudo -S -p '' -v", { stdin: `${password}\n`, timeoutMs: 15000 });
          if (check.code !== 0) {
            throw remoteError('REMOTE_NO_SUDO', '这个 SSH 账号不能 sudo；请换一个管理员账号，或先给该账号 sudo 权限。');
          }
          sudoPrefix = "sudo -S -p '' ";
        }
      }

      phase(job, '打包并上传');
      setProgress(job, '打包留灯程序…');
      const packed = await packApp();
      try {
        setProgress(job, `上传程序（${Math.max(1, Math.round(packed.bytes / 1024 / 1024))} MB）…`);
        let result;
        if (windows) {
          result = await installWindows(client, job, packed, hubPort, { tailscaleKey, tailscaleName });
        } else {
          const remotePkg = '/tmp/desk-hub.tar.gz';
          const remoteScript = '/tmp/desk-setup.sh';
          await uploadFile(client, packed.file, remotePkg);
          await uploadFile(client, SETUP_SCRIPTS.linux, remoteScript);
          let nodeArg = '';
          const machine = await execStream(client, 'uname -m', { timeoutMs: 15000 }).catch(() => ({ output: '' }));
          const arch = /aarch64|arm64/.test(machine.output) ? 'arm64' : /x86_64|amd64/.test(machine.output) ? 'x64' : '';
          const nodeTar = arch ? await nodePackage('linux', arch).catch(() => null) : null;
          if (nodeTar) {
            setProgress(job, `上传 Node.js（${Math.max(1, Math.round(nodeTar.bytes / 1024 / 1024))} MB，目标机器不用再下载）…`);
            await uploadFile(client, nodeTar.file, '/tmp/desk-node.tar.gz');
            nodeArg = ' --node /tmp/desk-node.tar.gz';
          }

          // Optional Tailscale key: written over the SSH channel into a file only
          // this account can read (never a local file, never a command line).
          let tsArg = tailscaleName ? ` --tailscale-name ${shellQuote(tailscaleName)}` : '';
          if (tailscaleKey) {
            setProgress(job, '把 Tailscale 密钥交给那台机器…');
            const put = await execStream(client, 'umask 077; cat > /tmp/desk-tailscale.key && test -s /tmp/desk-tailscale.key', { stdin: `${tailscaleKey}\n`, endInput: true, timeoutMs: 15000 })
              .catch((err) => ({ code: 1, output: err.message }));
            if (put.code === 0) tsArg += ' --tailscale-key-file /tmp/desk-tailscale.key';
            // Never skip it silently: the human asked for it.
            else job.tailscale = `Tailscale 没装：密钥没能交给那台机器（${cleanLine(String(put.output || '')).slice(0, 120) || `exit ${put.code}`}）`;
          }

          setProgress(job, '安装并启动（首次 3-10 分钟）…');
          result = await execStream(
            client,
            `${sudoPrefix}bash ${remoteScript} --port ${shellQuote(String(hubPort))} --pkg ${remotePkg}${nodeArg}${tsArg}${desktop === 'full' || desktop === 'light' ? ` --desktop ${desktop}` : ''}`,
            {
              stdin: isRoot ? '' : `${password}\n`,
              onLine: (line) => {
                const text = line.trim();
                if (text && !/^DESK_/.test(text)) setProgress(job, cleanLine(text).slice(0, 300));
              },
            },
          );
        }
        const value = (key) => new RegExp(`^${key}=(.*)$`, 'm').exec(result.output)?.[1]?.trim() || '';
        // The address the script sees may be NAT-internal (a cloud VM); the one
        // we just reached over SSH is the one this client can use.
        job.hubUrl = `http://${host}:${hubPort}`;
        job.pairCode = /^\d{6,10}$/.test(value('DESK_PAIR_CODE')) ? value('DESK_PAIR_CODE') : '';
        if (value('DESK_OS')) job.os = value('DESK_OS');
        // The script checks its own work; trust its verdict over "exit 0".
        if (result.code !== 0 || value('DESK_HUB_OK') !== '1' || !job.pairCode) {
          const said = result.output.trim().split(/\r?\n/).filter((line) => line.trim() && !/^DESK_/.test(line));
          // The reason first (which check failed), then what the script said last.
          const why = value('DESK_HUB_OK') !== '1' ? '留灯服务没能启动起来或没有应答'
            : !job.pairCode ? '服务起来了，但没读到配对码'
              : `安装脚本出错（退出码 ${result.code}）`;
          const reason = said.filter((line) => /^\[desk\]/.test(line)).slice(-2).map(cleanLine);
          const tail = (reason.length ? reason : said.slice(-3).map(cleanLine)).join(' / ');
          throw remoteError('REMOTE_HUB_FAILED', `安装失败：${why}${tail ? `。${tail}` : ''}。再点一次「连接并自动配置」会接着装（已装好的部分不会重做）。`);
        }
        // "na": Windows has no per-bot desktops yet; its bots browse headless.
        // "pending": the desktop and browser are installing in the background
        // after the Hub came up (the slow part); not a failure.
        // Windows installs Tailscale in the foreground and says how it went.
        const tsDone = /^DESK_TS=(done|failed)\s*(\S*)/m.exec(result.output || '');
        if (tailscaleKey && !job.tailscale && tsDone) {
          job.tailscale = tsDone[1] === 'done'
            ? `Tailscale 装好了${tsDone[2] ? `：${tsDone[2]}` : ''}，在外面也能连上这台机器`
            : `Tailscale 没装好（${tsDone[2] === 'key' ? '密钥不对或已用过' : tsDone[2] === 'download' ? '下载不了 Tailscale' : tsDone[2] === 'launch' ? '安装程序没能启动' : tsDone[2] || '原因不明'}）：到这台机器的 设置 → 手机和外网 里点「装上 Tailscale」再试`;
        }
        if (tailscaleKey && !job.tailscale) {
          job.tailscale = /Tailscale 在后台安装/.test(result.output)
            ? 'Tailscale 正在后台安装并加入你的网络，几分钟后这台机器会出现 100 开头的地址'
            : 'Tailscale 没装：安装脚本没有收到密钥';
        }
        if (value('DESK_DESKTOP_OK') === 'pending') job.desktopPending = true;
        else if (!['1', 'na'].includes(value('DESK_DESKTOP_OK'))) {
          job.warning = '装好了，但桌面相关的程序没装全，Bot 的屏幕会是黑的';
        }
      } finally {
        cleanupPack(packed.file);
      }

      setProgress(job, '确认这台电脑能连上它…');
      let reachable = false;
      for (let attempt = 0; attempt < 10 && !reachable; attempt += 1) {
        reachable = (await probeTcp(host, hubPort, 1500)).reachable;
        if (!reachable) await new Promise((resolve) => setTimeout(resolve, 1500));
      }
      const model = reachable ? modelToShare() : null;
      if (model) {
        setProgress(job, '把模型设置同步过去…');
        try {
          await shareModel(job.hubUrl, job.pairCode, model, voiceToShare(), visionToShare());
          job.modelShared = true;
        } catch (err) {
          job.warning = job.warning || `装好了，但模型设置没同步过去（${err.message}）；切过去后在「设置 → 模型」里填一下。`;
        }
      }
      if (!reachable) {
        job.state = 'warning';
        job.message = `装好了，但从这台电脑连不上 ${host}:${hubPort}；检查两台机器之间的防火墙或安全组。`;
      } else if (job.warning) {
        job.state = 'warning';
        job.message = job.warning;
      } else {
        job.state = 'done';
        job.message = job.desktopPending ? '已就绪；机器人的桌面和浏览器在后台继续安装（约 3–8 分钟）。' : '已就绪。';
      }
      // The Tailscale outcome is always said, and a failure makes it a warning.
      if (job.tailscale) {
        job.message = `${job.message} ${job.tailscale}。`;
        if (/没装/.test(job.tailscale) && job.state === 'done') job.state = 'warning';
        job.log.push(job.tailscale);
      }
      phase(job, null);
      job.finishedAt = nowIso();
    } catch (err) {
      job.state = 'error';
      job.message = /^REMOTE_/.test(String(err?.code || '')) ? (err.message || '远程配置失败') : friendlySshError(err);
      job.finishedAt = nowIso();
      job.log.push(`error: ${job.message}`);
    } finally {
      try { client?.end(); } catch { /* already gone */ }
    }
  }

  return {
    start(input = {}) {
      const host = assertHost(input.host);
      const sshPort = assertPort(input.sshPort, 22, 'sshPort');
      const hubPort = assertPort(input.hubPort, 4390, 'hubPort');
      const username = assertCredential(input.username, 'SSH username');
      const password = assertCredential(input.password, 'SSH password');
      // Optional, Linux only: a Tailscale auth key (tskey-auth-…) to join the human's tailnet.
      const tailscaleKey = String(input.tailscaleKey || '').trim();
      // Only an auth key adds a device; an API access token (tskey-api-) looks alike but is refused by Tailscale.
      if (tailscaleKey && /^tskey-api-/.test(tailscaleKey)) {
        throw remoteError('REMOTE_BAD_TAILSCALE_KEY', '这是 Tailscale 的 API 访问令牌（tskey-api-），不能用来加设备：在 Tailscale 后台 Settings → Keys 里点「Generate auth key」，用 tskey-auth- 开头的那种。');
      }
      if (tailscaleKey && !/^tskey-auth-[A-Za-z0-9-]{10,200}$/.test(tailscaleKey)) {
        throw remoteError('REMOTE_BAD_TAILSCALE_KEY', 'Tailscale 密钥应该是 tskey-auth- 开头的 Auth key（在 Tailscale 后台 Settings → Keys 里点「Generate auth key」）。');
      }

      const job = {
        id: uid('prov'),
        state: 'running',
        message: '排队中…',
        step: 0,
        totalSteps: 7,
        address: host,
        os: '',
        hubPort,
        hubUrl: '',
        pairCode: '',
        startedAt: nowIso(),
        finishedAt: null,
        log: [],
      };
      jobs.set(job.id, job);
      // Drop old finished jobs so a long-running process does not grow forever.
      for (const [id, entry] of jobs) {
        if (entry.state !== 'running' && Date.now() - Date.parse(entry.startedAt) > 60 * 60 * 1000) {
          jobs.delete(id);
        }
      }
      run(job, { host, sshPort, username, password, hubPort, tailscaleKey, tailscaleName: tailscaleDeviceName(input.name || host), desktop: input.desktop === 'full' ? 'full' : input.desktop === 'light' ? 'light' : '' });
      return publicJob(job);
    },
    get(id) {
      const job = jobs.get(String(id || ''));
      return job ? publicJob(job) : null;
    },
    list() {
      return [...jobs.values()].map(publicJob);
    },
  };
}