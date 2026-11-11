#!/usr/bin/env node
/**
 * smoke-remote-mock.mjs - drive "add a machine" end to end against a fake SSH
 * host, so the whole chain (auth -> OS detection -> sudo -> SFTP upload ->
 * setup script -> pairing code -> port probe -> verdict) is regression-tested
 * without a real VM.
 *
 * It boots a local ssh2 server (exec + SFTP) plus a TCP listener that stands
 * in for the new hub, then runs scripts/verify-remote-setup.mjs against them
 * with throwaway credentials. No real machine is contacted or modified.
 */

import crypto from 'node:crypto';
import net from 'node:net';
import path from 'node:path';
import { spawn } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import ssh2 from 'ssh2';

const { Server, utils: { sftp: { STATUS_CODE } } } = ssh2;

const REPO = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const USER = 'ubuntu';
const PASSWORD = 'mock-pass';

const { privateKey } = crypto.generateKeyPairSync('rsa', {
  modulusLength: 2048,
  publicKeyEncoding: { type: 'spki', format: 'pem' },
  privateKeyEncoding: { type: 'pkcs1', format: 'pem' },
});

/** What setup-linux.sh prints. The URL carries a NAT-internal address on purpose. */
const setupLog = (hubOk) => [
  '[desk] 1/7 识别系统',
  '[desk] Ubuntu 24.04 LTS（apt），程序目录 /opt/desk-hub，运行账号 ubuntu',
  '[desk] 2/7 Node.js',
  '[desk] 3/7 每个 Bot 的桌面（Xvfb、x11vnc、websockify、noVNC、XFCE、Chromium）',
  '[desk] 4/7 程序 → /opt/desk-hub',
  '[desk] 5/7 运行账号与 desk-hub.service',
  '[desk] 6/7 启动并放行端口 4390',
  '[desk] 7/7 自检',
  'DESK_OS=Ubuntu 24.04 LTS',
  'DESK_HUB_URL=http://10.0.2.15:4390',
  'DESK_PAIR_CODE=12345678',
  'DESK_APP_DIR=/opt/desk-hub',
  `DESK_HUB_OK=${hubOk ? 1 : 0}`,
  // a fresh machine: desktop and browser still installing in the background
  'DESK_DESKTOP_OK=pending',
].join('\n');

/** What setup-windows.ps1 prints. */
const windowsLog = [
  '[desk] 1/7 识别系统',
  '[desk] Microsoft Windows 11 专业版 10.0.26100（x64），程序目录 C:\\ProgramData\\Nightshift\\hub，运行账号 owner',
  '[desk] 2/7 Node.js',
  '[desk] 3/7 程序 → C:\\ProgramData\\Nightshift\\hub',
  '[desk] 4/7 计划任务 NightshiftHub',
  '[desk] 5/7 桌面：TightVNC（只听本机，经 Hub 配对后才能看和接管）',
  '[desk] 6/7 放行端口 4390，接电源时不睡眠',
  '[desk] 7/7 启动并自检',
  'DESK_OS=Microsoft Windows 11 专业版 10.0.26100',
  'DESK_HUB_URL=http://192.168.1.50:4390',
  'DESK_PAIR_CODE=87654321',
  'DESK_APP_DIR=C:\\ProgramData\\Nightshift\\hub',
  'DESK_HUB_OK=1',
  'DESK_DESKTOP_OK=1',
].join('\n');

let scenario = 'linux';
const seen = [];
const uploads = [];

/** -> [exitCode, output] */
function respond(command) {
  seen.push(command.split('\n')[0].slice(0, 300));
  const windows = scenario === 'windows';
  if (command === 'uname -s') return windows || scenario === 'alien' ? [127, "'uname' is not recognized\n"] : [0, 'Linux\n'];
  if (command === 'ver') return windows ? [0, 'Microsoft Windows [Version 10.0.26100.1]\n'] : [127, ''];
  if (command.includes('OSVersion.VersionString')) return [127, ''];
  if (command.includes('-File desk-setup.ps1')) return [0, `${windowsLog}\n`];
  if (command.includes('Get-ScheduledTask')) return [0, 'Running\n'];
  if (command.includes('/api/policy')) return [0, '{"mode":"remote","autoApproveAll":true}\n'];
  if (command.includes('Get-NetFirewallRule')) return [0, 'True\n'];
  if (command.includes('-LocalPort 5900')) return [0, '127.0.0.1\n'];
  if (command === 'id -u') return [0, '1000\n'];
  if (command === 'uname -m') return [0, 'x86_64\n'];
  if (command === "sudo -S -p '' -v") return [0, ''];
  if (command.includes('bash /tmp/desk-setup.sh')) return [0, `${setupLog(scenario !== 'broken')}\n`];
  if (command.includes('systemctl is-active')) return [0, 'active\n'];
  if (command.includes('systemctl is-enabled')) return [0, 'enabled\n'];
  if (command.includes('/api/health')) return [0, '{"ok":true,"version":"1.0.0"}\n'];
  if (command.includes('desk-bot-session')) return [0, '-rwxr-xr-x 1 root root 600 /usr/local/bin/desk-bot-session\n'];
  if (command.includes('PRETTY_NAME')) return [0, 'Ubuntu 24.04 LTS\n'];
  if (command.includes('for t in Xvfb')) return [0, 'Xvfb\nx11vnc\nwebsockify\nopenbox\n'];
  return [0, ''];
}

const ssh = new Server({ hostKeys: [privateKey] }, (client) => {
  client.on('authentication', (ctx) => {
    if (ctx.method === 'password' && ctx.username === USER && ctx.password === PASSWORD) ctx.accept();
    else ctx.reject(['password']);
  });
  client.on('ready', () => {
    client.on('session', (accept) => {
      const session = accept();
      session.on('exec', (acceptExec, _reject, info) => {
        const stream = acceptExec();
        const [code, output] = respond(info.command);
        stream.write(output);
        stream.exit(code);
        stream.end();
      });
      // Just enough SFTP for fastPut: open, write, close.
      session.on('sftp', (acceptSftp) => {
        const sftp = acceptSftp();
        let next = 0;
        const files = new Map();
        sftp.on('OPEN', (reqid, filename) => {
          const handle = Buffer.alloc(4);
          handle.writeUInt32BE(next++, 0);
          files.set(handle.toString('hex'), { filename, bytes: 0, head: null });
          sftp.handle(reqid, handle);
        });
        sftp.on('WRITE', (reqid, handle, _offset, data) => {
          const file = files.get(handle.toString('hex'));
          if (file) {
            if (file.head === null) file.head = Buffer.from(data.subarray(0, 3));
            file.bytes += data.length;
          }
          sftp.status(reqid, STATUS_CODE.OK);
        });
        sftp.on('CLOSE', (reqid, handle) => {
          const file = files.get(handle.toString('hex'));
          if (file) uploads.push(file);
          sftp.status(reqid, STATUS_CODE.OK);
        });
        for (const op of ['FSTAT', 'SETSTAT', 'FSETSTAT', 'STAT', 'LSTAT']) {
          sftp.on(op, (reqid) => sftp.status(reqid, STATUS_CODE.OK));
        }
      });
    });
  });
});

const listen = (server) => new Promise((resolve) => {
  server.listen(0, '127.0.0.1', () => resolve(server.address().port));
});

// A stand-in TightVNC installer, so the test never downloads the real one.
const fakeMsi = path.join((await import('node:os')).tmpdir(), `fake-tightvnc-${process.pid}.msi`);
(await import('node:fs')).writeFileSync(fakeMsi, Buffer.alloc(4096, 7));

const fakeHub = net.createServer((socket) => socket.end());
const [sshPort, hubPort] = await Promise.all([listen(ssh), listen(fakeHub)]);
console.log(`模拟 SSH :${sshPort} / 模拟 Hub :${hubPort}`);

async function runVerify(name) {
  scenario = name;
  seen.length = 0;
  uploads.length = 0;
  const child = spawn(process.execPath, ['scripts/verify-remote-setup.mjs'], {
    cwd: REPO,
    env: {
      ...process.env,
      DESK_TARGET_HOST: '127.0.0.1',
      DESK_TARGET_USER: USER,
      DESK_TARGET_PASS: PASSWORD,
      DESK_SSH_PORT: String(sshPort),
      DESK_HUB_PORT: String(hubPort),
      DESK_VNC_MSI: fakeMsi,
    },
  });
  let output = '';
  child.stdout.on('data', (chunk) => { output += chunk; });
  child.stderr.on('data', (chunk) => { output += chunk; });
  const code = await new Promise((resolve) => child.on('close', resolve));
  process.stdout.write(output);
  return { code, output, seen: [...seen], uploads: [...uploads] };
}

const linux = await runVerify('linux');
const windows = await runVerify('windows');
const broken = await runVerify('broken');
const alien = await runVerify('alien');

const checks = [
  ['Linux：验收以 PASS 退出', linux.code === 0 && /结论: PASS/.test(linux.output)],
  ['Linux：先识别了系统', linux.seen.includes('uname -s')],
  ['Linux：检查了 sudo', linux.seen.some((c) => c.includes('sudo -S -p'))],
  ['Linux：经 SFTP 上传了程序包和安装脚本', ['/tmp/desk-hub.tar.gz', '/tmp/desk-setup.sh'].every((f) => linux.uploads.some((u) => u.filename === f && u.bytes > 0))],
  ['Linux：执行的是 setup-linux.sh（带端口和程序包）', linux.seen.some((c) => /bash \/tmp\/desk-setup\.sh --port '\d+' --pkg \/tmp\/desk-hub\.tar\.gz/.test(c))],
  ['Linux：地址用 SSH 连得到的那个，不用对方报的内网 IP', /hubUrl: http:\/\/127\.0\.0\.1:/.test(linux.output)],
  ['Windows：验收以 PASS 退出', windows.code === 0 && /结论: PASS/.test(windows.output)],
  ['Windows：不走 sudo', !windows.seen.some((c) => c.includes('sudo -S'))],
  ['Windows：程序包和 ps1 传到账号主目录', ['desk-hub.tar.gz', 'desk-setup.ps1'].every((f) => windows.uploads.some((u) => u.filename === f && u.bytes > 0))],
  ['Windows：ps1 带 UTF-8 BOM（PowerShell 5.1 才不会乱码）', windows.uploads.some((u) => u.filename === 'desk-setup.ps1' && u.head && u.head.equals(Buffer.from([0xef, 0xbb, 0xbf])))],
  ['Windows：用 Windows PowerShell 执行，带端口和程序包', windows.seen.some((c) => /^powershell -NoProfile -ExecutionPolicy Bypass -File desk-setup\.ps1 -Port \d+ -Pkg desk-hub\.tar\.gz/.test(c))],
  ['Windows：TightVNC 安装包由客户端带过去，脚本用它（不在目标机下载）', windows.uploads.some((u) => u.filename === 'desk-tightvnc.msi' && u.bytes === 4096) && windows.seen.some((c) => / -VncMsi desk-tightvnc.msi/.test(c))],
  ['Windows：检查了计划任务、防火墙和远程模式', ['Get-ScheduledTask', 'Get-NetFirewallRule', '/api/policy'].every((k) => windows.seen.some((c) => c.includes(k)))],
  ['Linux：Node 由客户端带过去（不在目标机下载）', linux.uploads.some((u) => u.filename === '/tmp/desk-node.tar.gz' && u.bytes > 10 * 1024 * 1024) && linux.seen.some((c) => / --node \/tmp\/desk-node\.tar\.gz/.test(c))],
  ['Linux：桌面在后台继续装（pending）不算失败', linux.code === 0 && !/桌面相关的程序没装全/.test(linux.output)],
  ['Windows：Node 由客户端带过去（不在目标机下载）', windows.uploads.some((u) => u.filename === 'desk-node.zip' && u.bytes > 10 * 1024 * 1024) && windows.seen.some((c) => / -NodeZip desk-node\.zip/.test(c))],
  ['既不是 Linux 也不是 Windows：UNSUPPORTED，什么都没传', alien.code === 3 && /结论: UNSUPPORTED/.test(alien.output) && alien.uploads.length === 0],
  ['Hub 没起来：判 FAIL，不误报成功', broken.code === 1 && /结论: FAIL/.test(broken.output)],
];

console.log('\n=== 模拟验收链路 ===');
for (const [name, ok] of checks) console.log(`  ${ok ? 'PASS' : 'FAIL'}  ${name}`);

ssh.close();
fakeHub.close();
(await import('node:fs')).rmSync(fakeMsi, { force: true });
process.exitCode = checks.every(([, ok]) => ok) ? 0 : 1;
