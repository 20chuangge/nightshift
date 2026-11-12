/**
 * cliagents.mjs - hand a programming task to an official coding CLI that the
 * human logged into on this machine (Claude Code with a Pro/Max plan, Codex
 * CLI with ChatGPT), so the work runs on that subscription.
 *
 * What this module never does: read, copy or forward those tools' login data.
 * It only runs the official command. "Logged in?" comes from each tool's own
 * status command (claude auth status --json, codex login status).
 *
 * Flags, from `--help` of Claude Code 2.1.322 and Codex CLI 0.167.2:
 *   claude -p --output-format json --permission-mode acceptEdits
 *          --permission-prompts none --no-session-persistence
 *          [--allowedTools Bash,PowerShell]          (task on stdin, cwd = dir)
 *     acceptEdits: file edits in the working folder go through; anything that
 *     would ask (running commands unless allowed, places outside the folder)
 *     is refused because nobody answers prompts (--permission-prompts none).
 *   codex exec --cd <dir> --sandbox workspace-write --skip-git-repo-check
 *          --ephemeral --color never -o <dir>/last-message.txt -   (task on stdin)
 *     workspace-write: its commands may write only inside <dir>.
 *
 * The task text goes through stdin, never a command line or a shell.
 */

import fs from 'node:fs';
import fsp from 'node:fs/promises';
import path from 'node:path';
import { spawn, spawnSync } from 'node:child_process';

export const CLI_AGENT_TIMEOUT_MS = 20 * 60 * 1000;
export const CLI_TAIL_CHARS = 8000;

export const CLI_AGENTS = {
  claude: {
    label: 'Claude Code',
    bin: 'claude',
    install: 'npm install -g @anthropic-ai/claude-code',
    login: 'claude（第一次运行时按提示用 Claude Pro / Max 账号登录）',
    statusArgs: ['auth', 'status', '--json'],
    loggedIn: (out, code) => {
      try { return Boolean(JSON.parse(out).loggedIn); } catch { return code === 0 && /logged in/i.test(out) && !/not logged in/i.test(out); }
    },
    args: ({ allowShell }) => [
      '-p', '--output-format', 'json',
      '--permission-mode', 'acceptEdits',
      '--permission-prompts', 'none',
      '--no-session-persistence',
      // Its command tool is Bash on Linux/macOS and PowerShell on Windows (seen:
      // a Windows run refused "PowerShell: python hello.py" with only Bash allowed).
      ...(allowShell ? ['--allowedTools', 'Bash,PowerShell'] : []),
    ],
  },
  codex: {
    label: 'Codex CLI',
    bin: 'codex',
    install: 'npm install -g @openai/codex',
    login: 'codex login（用 ChatGPT 账号登录）',
    statusArgs: ['login', 'status'],
    loggedIn: (out, code) => code === 0 && !/not logged in/i.test(out),
    args: ({ dir }) => [
      'exec', '--cd', dir,
      '--sandbox', 'workspace-write',
      '--skip-git-repo-check', '--ephemeral', '--color', 'never',
      '-o', path.join(dir, 'last-message.txt'),
      '-',
    ],
  },
};

/** Where the command lives, or ''. Override with DESK_CLI_<NAME> (tests use a fake). */
export function findCli(name) {
  const override = process.env[`DESK_CLI_${name.toUpperCase()}`];
  if (override) return fs.existsSync(override) ? override : '';
  const bin = CLI_AGENTS[name]?.bin;
  if (!bin) return '';
  try {
    const res = process.platform === 'win32'
      ? spawnSync('where.exe', [bin], { encoding: 'utf8', windowsHide: true, timeout: 8000 })
      : spawnSync('sh', ['-c', `command -v ${bin}`], { encoding: 'utf8', timeout: 8000 });
    const hits = res.status === 0 ? String(res.stdout || '').split(/\r?\n/).map((s) => s.trim()).filter(Boolean) : [];
    // Windows: prefer a real .exe, then the npm .cmd shim.
    const onPath = hits.find((h) => /\.exe$/i.test(h)) || hits.find((h) => /\.cmd$/i.test(h)) || hits[0] || '';
    if (onPath) return onPath;
  } catch {
    /* fall through to the usual install places */
  }
  // Not on PATH (npm's global folder often is not on Windows, and the hub may
  // run as a service with a short PATH): look where the installers put it.
  const home = process.env.USERPROFILE || process.env.HOME || '';
  const places = process.platform === 'win32'
    ? [
      path.join(process.env.APPDATA || path.join(home, 'AppData', 'Roaming'), 'npm', `${bin}.cmd`),
      path.join(home, '.local', 'bin', `${bin}.exe`),
    ]
    : [
      path.join(home, '.local', 'bin', bin),
      path.join(home, '.npm-global', 'bin', bin),
      `/usr/local/bin/${bin}`,
      `/usr/bin/${bin}`,
    ];
  return places.find((p) => { try { return fs.statSync(p).isFile(); } catch { return false; } }) || '';
}

/**
 * Start a command without a shell where possible. An npm .cmd shim on Windows
 * needs cmd.exe: every argument is ours (fixed flags and a workspace path), and
 * each is quoted; the task itself never reaches the command line.
 */
function launch(file, args, options) {
  if (process.platform === 'win32' && /\.(cmd|bat)$/i.test(file)) {
    const quote = (a) => (/[\s"&|<>^()%!]/.test(a) ? `"${String(a).replace(/"/g, '""')}"` : a);
    const line = [quote(file), ...args.map(quote)].join(' ');
    return spawn(process.env.ComSpec || 'cmd.exe', ['/d', '/s', '/c', `"${line}"`], { ...options, windowsVerbatimArguments: true });
  }
  return spawn(file, args, options);
}

function killTree(child) {
  if (!child || child.exitCode !== null) return;
  try {
    if (process.platform === 'win32') spawnSync('taskkill', ['/pid', String(child.pid), '/T', '/F'], { windowsHide: true, timeout: 10000 });
    else process.kill(-child.pid, 'SIGTERM');
  } catch {
    try { child.kill('SIGKILL'); } catch { /* gone */ }
  }
}

function cleanEnv() {
  // Our own model key must not leak into another program.
  const env = { ...process.env };
  delete env.ASSIST_API_KEY;
  return env;
}

/** Run one command with a time limit. -> {code, out} */
function runQuick(file, args, timeoutMs = 20000) {
  return new Promise((resolve) => {
    let out = '';
    let child;
    try {
      child = launch(file, args, { windowsHide: true, env: cleanEnv(), detached: process.platform !== 'win32' });
    } catch (err) {
      resolve({ code: -1, out: String(err.message) });
      return;
    }
    const timer = setTimeout(() => killTree(child), timeoutMs);
    child.stdout?.on('data', (c) => { out += c; });
    child.stderr?.on('data', (c) => { out += c; });
    child.on('error', (err) => { clearTimeout(timer); resolve({ code: -1, out: String(err.message) }); });
    child.on('close', (code) => { clearTimeout(timer); resolve({ code, out }); });
    child.stdin?.end();
  });
}

/** Which coding CLIs this machine has, and whether each is logged in. */
export async function detectCliAgents() {
  const result = [];
  for (const [id, spec] of Object.entries(CLI_AGENTS)) {
    const file = findCli(id);
    if (!file) { result.push({ id, label: spec.label, installed: false, loggedIn: false, install: spec.install, login: spec.login }); continue; }
    const status = await runQuick(file, spec.statusArgs);
    result.push({ id, label: spec.label, installed: true, loggedIn: spec.loggedIn(status.out, status.code), install: spec.install, login: spec.login });
  }
  return result;
}

/** A fresh task folder under the workspace: cli-tasks/<date>-<id>. */
export function newTaskDir(workspaceDir) {
  const day = new Date().toISOString().slice(0, 10);
  const id = Math.random().toString(36).slice(2, 8);
  return path.join(workspaceDir, 'cli-tasks', `${day}-${id}`);
}

/**
 * Run the task. -> {agent, dir, exitCode, timedOut, stopped, seconds, summary, outputTail, outputFile, files}
 * `dir` must already be checked to be inside the workspace by the caller.
 */
export async function runCliAgent({ agent, task, dir, allowShell = false, signal, timeoutMs = CLI_AGENT_TIMEOUT_MS }) {
  const spec = CLI_AGENTS[agent];
  if (!spec) throw Object.assign(new Error(`unknown agent "${agent}" (claude or codex)`), { code: 'CLI_UNKNOWN' });
  const file = findCli(agent);
  if (!file) throw Object.assign(new Error(`这台机器上没有装 ${spec.label}。装法：${spec.install}，然后自己登录一次：${spec.login}`), { code: 'CLI_NOT_INSTALLED' });
  await fsp.mkdir(dir, { recursive: true });
  const logFile = path.join(dir, 'output.log');
  const log = fs.createWriteStream(logFile);
  const started = Date.now();
  let tail = '';
  let timedOut = false;
  let stopped = false;
  const child = launch(file, spec.args({ dir, allowShell }), {
    cwd: dir,
    windowsHide: true,
    env: cleanEnv(),
    detached: process.platform !== 'win32',
  });
  const onData = (chunk) => {
    log.write(chunk);
    tail = (tail + chunk.toString('utf8')).slice(-CLI_TAIL_CHARS * 2);
  };
  child.stdout?.on('data', onData);
  child.stderr?.on('data', onData);
  child.stdin?.on('error', () => {});
  child.stdin?.end(`${String(task)}\n`);
  const timer = setTimeout(() => { timedOut = true; killTree(child); }, timeoutMs);
  const onAbort = () => { stopped = true; killTree(child); };
  if (signal) {
    if (signal.aborted) onAbort();
    else signal.addEventListener('abort', onAbort, { once: true });
  }
  const exitCode = await new Promise((resolve) => {
    child.on('error', (err) => { onData(Buffer.from(`\n[desk] could not start: ${err.message}\n`)); resolve(-1); });
    child.on('close', (code) => resolve(code));
  });
  clearTimeout(timer);
  signal?.removeEventListener?.('abort', onAbort);
  await new Promise((r) => log.end(r));

  // What the agent says it did: Claude's JSON result, or Codex's last message.
  let summary = '';
  let denied = [];
  if (agent === 'claude') {
    // --output-format json prints one JSON object; take the last line that is one.
    for (const line of tail.split(/\r?\n/).reverse()) {
      const t = line.trim();
      if (!t.startsWith('{')) continue;
      try {
        const j = JSON.parse(t);
        if (typeof j.result === 'string') {
          summary = j.result;
          // What it was not allowed to do: the bot should know, not guess.
          denied = (j.permission_denials || []).slice(0, 10).map((d) => `${d.tool_name}: ${String(d.tool_input?.command || d.tool_input?.file_path || JSON.stringify(d.tool_input || {})).slice(0, 160)}`);
          break;
        }
      } catch { /* not it */ }
    }
  } else {
    try { summary = (await fsp.readFile(path.join(dir, 'last-message.txt'), 'utf8')).trim(); } catch { /* none */ }
  }
  let files = [];
  try {
    files = (await fsp.readdir(dir)).filter((f) => !['output.log', 'last-message.txt'].includes(f)).slice(0, 50);
  } catch { /* gone */ }
  return {
    agent,
    dir,
    exitCode,
    timedOut,
    stopped,
    seconds: Math.round((Date.now() - started) / 100) / 10,
    summary: summary.slice(0, 4000),
    ...(denied.length ? { denied, deniedNote: 'Claude Code was not allowed to do these (no prompts; commands only with allowShell). Do them yourself or call again with allowShell.' } : {}),
    outputTail: tail.slice(-CLI_TAIL_CHARS),
    outputFile: logFile,
    files,
  };
}
