#!/usr/bin/env node
/**
 * verify-remote-setup.mjs - end-to-end acceptance run for "add a machine":
 * SSH in, install a hub with hub/setup-linux.sh, check it really runs.
 *
 * Credentials come from the environment only: they are never written to argv,
 * files, or the report.
 *
 *   DESK_TARGET_HOST=192.168.100.134 DESK_TARGET_USER=ubuntu \
 *   DESK_TARGET_PASS=... node scripts/verify-remote-setup.mjs
 *
 * Optional: DESK_SSH_PORT (22), DESK_HUB_PORT (4390),
 *           DESK_VERIFY_OUT (write the JSON report to this path).
 *
 * Flow: read-only SSH preflight -> the real createProvisioner (OS detection,
 * upload, sudo, install, pairing code) -> poll the job -> SSH postflight
 * checks -> verdict PASS / FAIL / UNSUPPORTED.
 *
 * WARNING: the setup script installs packages, writes a systemd unit and a
 * sudoers entry on the target. Only run this against a machine you are
 * explicitly allowed to reconfigure.
 */

import { Client } from 'ssh2';
import fsp from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';

const {
  DESK_TARGET_HOST,
  DESK_TARGET_USER,
  DESK_TARGET_PASS,
  DESK_SSH_PORT = '22',
  DESK_HUB_PORT = '4390',
  DESK_VERIFY_OUT,
} = process.env;

const missing = ['DESK_TARGET_HOST', 'DESK_TARGET_USER', 'DESK_TARGET_PASS'].filter((key) => !process.env[key]);
if (missing.length) {
  console.error(`缺少环境变量: ${missing.join(', ')}`);
  console.error('用法: DESK_TARGET_HOST=... DESK_TARGET_USER=... DESK_TARGET_PASS=... node scripts/verify-remote-setup.mjs');
  process.exit(2);
}

// Isolate the run so an acceptance test never touches real user data.
process.env.ASSIST_HOME = await fsp.mkdtemp(path.join(os.tmpdir(), 'desk-verify-'));
const { createProvisioner } = await import('../src/remote.mjs');

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

function connect() {
  return new Promise((resolve, reject) => {
    const client = new Client();
    client.once('ready', () => resolve(client));
    client.once('error', reject);
    client.connect({
      host: DESK_TARGET_HOST,
      port: Number(DESK_SSH_PORT),
      username: DESK_TARGET_USER,
      password: DESK_TARGET_PASS,
      readyTimeout: 45000,
    });
  });
}

function exec(client, command) {
  return new Promise((resolve, reject) => {
    client.exec(command, (err, stream) => {
      if (err) return reject(err);
      let output = '';
      const consume = (chunk) => { output += chunk.toString('utf8'); };
      stream.on('data', consume);
      stream.stderr?.on('data', consume);
      stream.on('close', (code) => resolve({ code: code ?? 0, output: output.trim() }));
    });
  });
}

async function inspect(client, label, commands) {
  const result = {};
  console.log(`\n=== ${label} ===`);
  for (const [key, command] of Object.entries(commands)) {
    try {
      const { code, output } = await exec(client, command);
      result[key] = { code, output: output.slice(0, 2000) };
      console.log(`  ${key}: ${output.slice(0, 300).replace(/\s+/g, ' ') || '(empty)'}`);
    } catch (err) {
      result[key] = { code: -1, output: String(err.message) };
      console.log(`  ${key}: ERROR ${err.message}`);
    }
  }
  return result;
}

const PREFLIGHT = {
  kernel: 'uname -s',
  os: '. /etc/os-release 2>/dev/null; echo "$PRETTY_NAME"',
  uid: 'id -u',
  sudo: 'sudo -n true >/dev/null 2>&1 && echo passwordless || echo needs-password',
  packageManager: 'for p in apt-get dnf yum; do command -v "$p" >/dev/null 2>&1 && echo "$p"; done',
  node: 'node -v 2>/dev/null || echo none',
  desktopTools: 'for t in Xvfb x11vnc websockify openbox xfce4-session gnome-session; do command -v "$t" >/dev/null 2>&1 && echo "$t"; done',
  memory: "awk '/MemTotal/ {print int($2/1024) \" MB\"}' /proc/meminfo",
};

const port = Number(DESK_HUB_PORT);
const POSTFLIGHT = {
  service: 'systemctl is-active desk-hub 2>&1',
  enabled: 'systemctl is-enabled desk-hub 2>&1',
  health: `(curl -fsS -m 3 http://127.0.0.1:${port}/api/health || wget -qO- -T 3 http://127.0.0.1:${port}/api/health) 2>/dev/null || echo unreachable`,
  unit: "sed -n 's/^WorkingDirectory=//p;s/^ExecStart=//p' /etc/systemd/system/desk-hub.service 2>/dev/null || echo missing",
  sessionHelper: 'ls -l /usr/local/bin/desk-bot-session 2>/dev/null || echo missing',
  desktopTools: 'for t in Xvfb x11vnc websockify openbox xfce4-session gnome-session; do command -v "$t" >/dev/null 2>&1 && echo "$t"; done',
  sudoers: 'ls /etc/sudoers.d/desk-hub 2>/dev/null || echo missing',
};
// Windows: works from cmd.exe or PowerShell as the OpenSSH default shell.
const ps = (script) => `powershell -NoProfile -Command "${script}"`;
const POSTFLIGHT_WINDOWS = {
  task: ps('(Get-ScheduledTask -TaskName NightshiftHub).State'),
  health: ps(`(Invoke-WebRequest -UseBasicParsing -TimeoutSec 5 http://127.0.0.1:${port}/api/health).Content`),
  policy: ps(`(Invoke-WebRequest -UseBasicParsing -TimeoutSec 5 http://127.0.0.1:${port}/api/policy).Content`),
  firewall: ps("(Get-NetFirewallRule -DisplayName 'Nightshift Hub').Enabled"),
  vnc: ps('(Get-NetTCPConnection -LocalPort 5900 -State Listen -ErrorAction SilentlyContinue).LocalAddress'),
};

let client;
const report = { host: DESK_TARGET_HOST, hubPort: port, startedAt: new Date().toISOString() };
try {
  console.log(`目标: ${DESK_TARGET_USER}@${DESK_TARGET_HOST}:${DESK_SSH_PORT}（Hub 端口 ${port}）`);
  client = await connect();
  report.preflight = await inspect(client, '预检（只读）', PREFLIGHT);
  client.end();
  client = null;

  console.log('\n=== 执行一键配置 ===');
  const provisioner = createProvisioner();
  let job = provisioner.start({
    host: DESK_TARGET_HOST,
    sshPort: Number(DESK_SSH_PORT),
    hubPort: port,
    username: DESK_TARGET_USER,
    password: DESK_TARGET_PASS,
  });
  let lastMessage = '';
  const deadline = Date.now() + 25 * 60 * 1000;
  while (job.state === 'running' && Date.now() < deadline) {
    await sleep(1500);
    job = provisioner.get(job.id);
    if (job.message !== lastMessage) {
      lastMessage = job.message;
      console.log(`  [${job.step || '-'}/${job.totalSteps || '-'}] ${job.message}`);
    }
  }
  report.job = { state: job.state, message: job.message, os: job.os, hubUrl: job.hubUrl, paired: Boolean(job.pairCode), log: job.log };
  console.log(`  hubUrl: ${job.hubUrl || '-'}`);

  if (job.state === 'error' && /认不出/.test(job.message)) {
    report.verdict = 'UNSUPPORTED';
    report.reason = job.message;
  } else if (job.state === 'error' || job.state === 'running') {
    report.verdict = 'FAIL';
    report.reason = job.state === 'running' ? '超时' : job.message;
  } else if (/windows/i.test(job.os || '')) {
    client = await connect();
    report.postflight = await inspect(client, '验收后检查（Windows）', POSTFLIGHT_WINDOWS);
    const pf = report.postflight;
    const checks = [
      ['计划任务 NightshiftHub 在运行', /\bRunning\b/.test(pf.task.output)],
      ['本机 /api/health 应答', /"ok"\s*:\s*true/.test(pf.health.output)],
      ['拿到了配对码', Boolean(job.pairCode)],
      ['按远程机器运行（自主模式）', /"mode"\s*:\s*"remote"/.test(pf.policy.output)],
      ['防火墙已放行端口', /\bTrue\b/.test(pf.firewall.output)],
      ['桌面服务（TightVNC）只听本机 127.0.0.1', /127\.0\.0\.1/.test(pf.vnc.output) && !/0\.0\.0\.0/.test(pf.vnc.output)],
    ];
    console.log('\n=== 结论检查 ===');
    for (const [name, ok] of checks) console.log(`  ${ok ? 'PASS' : 'FAIL'}  ${name}`);
    report.checks = Object.fromEntries(checks);
    report.verdict = checks.every(([, ok]) => ok) ? 'PASS' : 'FAIL';
    if (job.state === 'warning') report.warning = job.message;
  } else {
    client = await connect();
    report.postflight = await inspect(client, '验收后检查', POSTFLIGHT);
    const pf = report.postflight;
    const checks = [
      ['desk-hub 服务 active', pf.service.output.split(/\s+/)[0] === 'active'],
      ['desk-hub 开机自启', pf.enabled.output.split(/\s+/)[0] === 'enabled'],
      ['本机 /api/health 应答', /"ok"\s*:\s*true/.test(pf.health.output)],
      ['拿到了配对码', Boolean(job.pairCode)],
      ['每 Bot 桌面会话脚本已安装', !/missing/.test(pf.sessionHelper.output)],
      ['Bot 桌面需要的程序齐全（Xvfb、x11vnc、websockify、openbox 或 XFCE）', ['Xvfb', 'x11vnc', 'websockify'].every((t) => pf.desktopTools.output.includes(t)) && /openbox|xfce4-session/.test(pf.desktopTools.output)],
    ];
    console.log('\n=== 结论检查 ===');
    for (const [name, ok] of checks) console.log(`  ${ok ? 'PASS' : 'FAIL'}  ${name}`);
    report.checks = Object.fromEntries(checks);
    report.verdict = checks.every(([, ok]) => ok) ? 'PASS' : 'FAIL';
    if (job.state === 'warning') report.warning = job.message;
  }
} catch (err) {
  report.verdict = 'FAIL';
  report.reason = err.message;
} finally {
  try { client?.end(); } catch { /* gone */ }
}

report.finishedAt = new Date().toISOString();
console.log(`\n结论: ${report.verdict}${report.reason ? `（${report.reason}）` : ''}`);
if (DESK_VERIFY_OUT) await fsp.writeFile(DESK_VERIFY_OUT, `${JSON.stringify(report, null, 2)}\n`);
process.exitCode = report.verdict === 'PASS' ? 0 : report.verdict === 'UNSUPPORTED' ? 3 : 1;
