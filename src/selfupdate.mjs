/**
 * selfupdate.mjs - a machine's hub replaces its own code with a newer build.
 *
 * The desktop app (through this computer's hub) uploads the same package it
 * would install over SSH. This hub:
 *   1. unpacks it next to itself (.update/<stamp>/new)
 *   2. test-starts the new server on a throwaway home and port; a build that
 *      cannot even start never replaces a working one
 *   3. swaps the code in, keeping the old code in .update/backup
 *   4. exits; systemd (Restart=always) or the Windows launcher loop starts
 *      the new code
 *
 * Code only. Bots (config/), data/, workspace/ and the human's own skills are
 * never touched; skills/ is merged (new built-in files added or refreshed).
 * Anything that needs root (new system packages, a new service definition) is
 * a "setup" change: the package carries a higher setup version and the client
 * asks the human to add the machine again instead.
 */

import { execFile, spawn } from 'node:child_process';
import fs from 'node:fs';
import fsp from 'node:fs/promises';
import path from 'node:path';
import { appRoot } from './bundle.mjs';

/** Entries replaced as a whole. */
const CODE = ['src', 'public', 'hub', 'node_modules', 'package.json'];

function updateError(code, message, status = 400) {
  const err = new Error(message);
  err.code = code;
  err.status = status;
  return err;
}

/** Setup version this machine was installed with (written by the setup scripts). */
export function installedSetupVersion(root = appRoot()) {
  try {
    const n = Number(fs.readFileSync(path.join(root, '.setup-version'), 'utf8').trim());
    return Number.isFinite(n) && n > 0 ? n : 1;
  } catch {
    return 1; // machines set up before the file existed
  }
}

/** Setup version the scripts shipped with this build would install. */
export function shippedSetupVersion(root = appRoot()) {
  let best = 1;
  for (const name of ['setup-linux.sh', 'setup-windows.ps1']) {
    try {
      const m = /SETUP_VERSION\s*=\s*(\d+)/.exec(fs.readFileSync(path.join(root, 'hub', name), 'utf8'));
      if (m) best = Math.max(best, Number(m[1]));
    } catch { /* not shipped */ }
  }
  return best;
}

/** -1 / 0 / 1 for dotted versions ("1.2.10" > "1.2.9"). */
export function compareVersions(a, b) {
  const pa = String(a || '0').split('.').map((x) => parseInt(x, 10) || 0);
  const pb = String(b || '0').split('.').map((x) => parseInt(x, 10) || 0);
  for (let i = 0; i < Math.max(pa.length, pb.length); i += 1) {
    const d = (pa[i] || 0) - (pb[i] || 0);
    if (d) return d > 0 ? 1 : -1;
  }
  return 0;
}

function run(cmd, args, opts) {
  return new Promise((resolve, reject) => {
    execFile(cmd, args, { maxBuffer: 8 * 1024 * 1024, ...opts }, (err, stdout, stderr) => {
      if (err) reject(new Error(String(stderr || err.message).slice(0, 300)));
      else resolve(stdout);
    });
  });
}

/** Start the new server on a scratch home and port; resolve when it says it is ready. */
function trialBoot(newRoot, scratch, timeoutMs = 25000) {
  return new Promise((resolve, reject) => {
    const env = {
      ...process.env,
      ASSIST_HOME: scratch,
      ASSIST_DATA_DIR: path.join(scratch, 'data'),
      ASSIST_WORKSPACE_DIR: path.join(scratch, 'workspace'),
      ASSIST_MODEL_PROVIDER: 'mock',
      PORT: '0',
      HOST: '127.0.0.1',
    };
    const child = spawn(process.execPath, [path.join(newRoot, 'src', 'server.mjs')], { env, stdio: ['ignore', 'pipe', 'pipe'] });
    let out = '';
    let errText = '';
    const done = (fn, value) => {
      clearTimeout(timer);
      try { child.kill(); } catch { /* gone */ }
      fn(value);
    };
    const timer = setTimeout(() => done(reject, new Error('新版本 25 秒内没有启动起来')), timeoutMs);
    child.stdout.on('data', (b) => {
      out += b;
      if (/"event"\s*:\s*"ready"/.test(out)) done(resolve);
    });
    child.stderr.on('data', (b) => { errText = `${errText}${b}`.slice(-2000); });
    child.on('exit', (code) => {
      const line = errText.split('\n').map((l) => l.trim()).find((l) => /Error|error:/.test(l)) || errText.trim().split('\n').pop() || '';
      done(reject, new Error(`新版本启动失败（退出码 ${code}）：${line.slice(0, 200)}`));
    });
  });
}

async function exists(p) {
  try { await fsp.access(p); return true; } catch { return false; }
}

/** Move a path, falling back to copy + delete when rename is refused (Windows locks). */
async function movePath(from, to) {
  try {
    await fsp.rename(from, to);
  } catch {
    await fsp.cp(from, to, { recursive: true, force: true });
    await fsp.rm(from, { recursive: true, force: true });
  }
}

/** Copy new built-in skills over; files only the human has stay. */
async function mergeSkills(fromDir, toDir) {
  if (!(await exists(fromDir))) return;
  await fsp.cp(fromDir, toDir, { recursive: true, force: true });
}

/**
 * Validate, test-start and install a package. Returns {from, to} once the code
 * on disk is the new one; the caller then exits so the supervisor restarts it.
 */
export async function applyUpdate({ bytes, currentVersion, root = appRoot(), log = () => {} }) {
  if (!bytes?.length) throw updateError('UPDATE_EMPTY', '没有收到更新包');
  const work = path.join(root, '.update', new Date().toISOString().replace(/[:.]/g, '-'));
  const newRoot = path.join(work, 'new');
  await fsp.mkdir(newRoot, { recursive: true });
  try {
    await fsp.writeFile(path.join(work, 'pkg.tar.gz'), bytes);
    // Relative names with cwd: GNU tar reads "C:\..." as host:path.
    await run('tar', ['-xzf', 'pkg.tar.gz', '-C', 'new'], { cwd: work });

    let next;
    try {
      next = JSON.parse(await fsp.readFile(path.join(newRoot, 'package.json'), 'utf8'));
    } catch {
      throw updateError('UPDATE_BAD_PACKAGE', '更新包里没有 package.json');
    }
    if (!(await exists(path.join(newRoot, 'src', 'server.mjs'))) || !(await exists(path.join(newRoot, 'public')))) {
      throw updateError('UPDATE_BAD_PACKAGE', '更新包不完整');
    }
    if (compareVersions(next.version, currentVersion) <= 0) {
      throw updateError('UPDATE_NOT_NEWER', `这台机器已经是 ${currentVersion}，不用更新`, 409);
    }
    const needSetup = shippedSetupVersion(newRoot);
    if (needSetup > installedSetupVersion(root)) {
      throw updateError('UPDATE_NEEDS_SETUP', '这次更新需要改动系统组件，请重新添加一次这台机器', 409);
    }

    log(`[update] test-starting ${next.version}`);
    await trialBoot(newRoot, path.join(work, 'trial'));

    // Swap. Anything that fails puts the old code back.
    const backup = path.join(root, '.update', 'backup');
    await fsp.rm(backup, { recursive: true, force: true });
    await fsp.mkdir(backup, { recursive: true });
    const moved = [];
    try {
      for (const entry of CODE) {
        const live = path.join(root, entry);
        const incoming = path.join(newRoot, entry);
        if (!(await exists(incoming))) continue;
        if (await exists(live)) await movePath(live, path.join(backup, entry));
        moved.push(entry);
        await movePath(incoming, live);
      }
      await mergeSkills(path.join(newRoot, 'skills'), path.join(root, 'skills'));
    } catch (err) {
      log(`[update] swap failed, restoring: ${err.message}`);
      for (const entry of moved.reverse()) {
        await fsp.rm(path.join(root, entry), { recursive: true, force: true }).catch(() => {});
        await movePath(path.join(backup, entry), path.join(root, entry)).catch(() => {});
      }
      throw updateError('UPDATE_SWAP_FAILED', `替换程序文件失败，已恢复原版本：${err.message}`, 500);
    }
    await fsp.writeFile(
      path.join(root, '.update', 'last.json'),
      `${JSON.stringify({ from: currentVersion, to: next.version, at: new Date().toISOString() }, null, 2)}\n`,
    );
    log(`[update] ${currentVersion} -> ${next.version} installed; restarting`);
    return { from: currentVersion, to: next.version };
  } finally {
    await fsp.rm(work, { recursive: true, force: true }).catch(() => {});
  }
}

export const UPDATE_MAX_BYTES = 120 * 1024 * 1024;
