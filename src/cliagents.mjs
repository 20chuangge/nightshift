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
 * Cursor CLI and Qoder CLI (from their docs, docs.cursor.com/cli and
 * docs.qoder.cn/cli):
 *   agent -p --output-format json --trust --workspace <dir> [--force] [--model m] <prompt>
 *     print mode writes files in the workspace but refuses commands; --force
 *     lets it run them (allowShell).
 *   qodercn -p -o json -w <dir> --permission-mode accept_edits|bypass_permissions [-m m] <prompt>
 *     (Qoder CN; the global build is "qoder", same flags)
 * Their prompt is a fixed line of ours ("read TASK.md and do it"); the task
 * itself is written to TASK.md in the folder.
 *
 * The task text goes through stdin (or TASK.md), never a command line or a shell.
 *
 * Models: every one takes a model name (--model / -m). Cursor and Qoder list
 * theirs (agent models, qodercn --list-models); the human picks a default per
 * tool in settings (data/cliagents.json) and a bot may name one per call.
 */

import fs from 'node:fs';
import fsp from 'node:fs/promises';
import path from 'node:path';
import { spawn, spawnSync } from 'node:child_process';
import { P, readJson, writeJsonAtomic } from './store.mjs';

export const CLI_AGENT_TIMEOUT_MS = 20 * 60 * 1000;
export const CLI_TAIL_CHARS = 8000;

/** The fixed prompt for tools that get the task from TASK.md. */
export const TASK_FILE = 'TASK.md';
const FILE_PROMPT = `Read the file ${TASK_FILE} in the current folder and do the task it describes. Work only inside this folder.`;

/** A program says it is logged in: exit 0 and nothing like "not logged in". */
const saysLoggedIn = (out, code) => code === 0 && !/not (logged|signed|authenticated)|unauthenticated|log ?in (first|required)|please (log|sign) ?in|未登录|请先登录/i.test(out);

export const CLI_AGENTS = {
  claude: {
    label: 'Claude Code',
    plan: 'Claude Pro / Max',
    bin: 'claude',
    install: 'npm install -g @anthropic-ai/claude-code',
    login: 'claude（第一次运行时按提示用 Claude Pro / Max 账号登录）',
    statusArgs: ['auth', 'status', '--json'],
    loggedIn: (out, code) => {
      try { return Boolean(JSON.parse(out).loggedIn); } catch { return code === 0 && /logged in/i.test(out) && !/not logged in/i.test(out); }
    },
    // Aliases Claude Code takes for its current models; any full model name works too.
    models: ['sonnet', 'opus', 'haiku'],
    args: ({ allowShell, model }) => [
      '-p', '--output-format', 'json',
      '--permission-mode', 'acceptEdits',
      '--permission-prompts', 'none',
      '--no-session-persistence',
      // Its command tool is Bash on Linux/macOS and PowerShell on Windows (seen:
      // a Windows run refused "PowerShell: python hello.py" with only Bash allowed).
      ...(allowShell ? ['--allowedTools', 'Bash,PowerShell'] : []),
      ...(model ? ['--model', model] : []),
    ],
  },
  codex: {
    label: 'Codex CLI',
    plan: 'ChatGPT',
    bin: 'codex',
    install: 'npm install -g @openai/codex',
    login: 'codex login（用 ChatGPT 账号登录）',
    statusArgs: ['login', 'status'],
    loggedIn: (out, code) => code === 0 && !/not logged in/i.test(out),
    models: [],
    args: ({ dir, model }) => [
      'exec', '--cd', dir,
      '--sandbox', 'workspace-write',
      '--skip-git-repo-check', '--ephemeral', '--color', 'never',
      '-o', path.join(dir, 'last-message.txt'),
      ...(model ? ['--model', model] : []),
      '-',
    ],
  },
  cursor: {
    label: 'Cursor',
    plan: 'Cursor',
    bin: 'agent',
    bins: ['agent', 'cursor-agent'],
    // Where its Windows installer puts it when that is not on PATH yet.
    places: (home) => [
      path.join(process.env.LOCALAPPDATA || path.join(home, 'AppData', 'Local'), 'cursor-agent', 'agent.cmd'),
      path.join(process.env.LOCALAPPDATA || path.join(home, 'AppData', 'Local'), 'cursor-agent', 'cursor-agent.cmd'),
    ],
    install: "PowerShell 里运行：irm 'https://cursor.com/install?win32=true' | iex（Mac / Linux：curl https://cursor.com/install -fsS | bash）",
    login: 'agent login（用 Cursor 账号登录）',
    statusArgs: ['status'],
    loggedIn: saysLoggedIn,
    listArgs: ['models'],
    promptFile: true,
    models: [],
    args: ({ dir, allowShell, model }) => [
      '-p', '--output-format', 'json',
      '--trust', '--workspace', dir,
      ...(allowShell ? ['--force'] : []),
      ...(model ? ['--model', model] : []),
      FILE_PROMPT,
    ],
  },
  qoder: {
    label: 'Qoder',
    plan: 'Qoder',
    bin: 'qoderclicn',
    // Qoder CN first, then the global build. The CN installer puts the real
    // program at ~/.qoder-cn/bin/qoderclicn/qoderclicn.exe; "qodercn" is a
    // PowerShell dispatcher in front of it (~/.qoder-cn/entry/qodercn.cmd).
    bins: ['qoderclicn', 'qodercn', 'qoder', 'qodercli'],
    places: (home) => [
      path.join(home, '.qoder-cn', 'bin', 'qoderclicn', process.platform === 'win32' ? 'qoderclicn.exe' : 'qoderclicn'),
      path.join(home, '.qoder-cn', 'entry', process.platform === 'win32' ? 'qodercn.cmd' : 'qodercn'),
      path.join(home, '.qoder', 'bin', 'qodercli', process.platform === 'win32' ? 'qodercli.exe' : 'qodercli'),
      path.join(home, '.qoder', 'bin', 'qoder.exe'),
      path.join(home, '.local', 'bin', 'qodercn.exe'),
      path.join(home, '.local', 'bin', 'qoder.exe'),
    ],
    install: 'PowerShell 里运行：irm https://static.qoder.com.cn/qoder-cli-cn/install.ps1 | iex（国际版：irm https://qoder.com/install.ps1 | iex）',
    login: 'qodercn login（国际版是 qoder login，用 Qoder 账号登录）',
    statusArgs: ['status'],
    loggedIn: saysLoggedIn,
    listArgs: ['--list-models'],
    promptFile: true,
    models: ['auto'],
    args: ({ dir, allowShell, model }) => [
      '-p', '-o', 'json',
      '-w', dir,
      '--permission-mode', allowShell ? 'bypass_permissions' : 'accept_edits',
      ...(model ? ['-m', model] : []),
      FILE_PROMPT,
    ],
  },
};

export const CLI_AGENT_IDS = Object.keys(CLI_AGENTS);

/** Where the command lives, or ''. Override with DESK_CLI_<NAME> (tests use a fake). */
export function findCli(name) {
  const override = process.env[`DESK_CLI_${name.toUpperCase()}`];
  if (override) return fs.existsSync(override) ? override : '';
  const spec = CLI_AGENTS[name];
  if (!spec) return '';
  for (const bin of spec.bins || [spec.bin]) {
    try {
      const res = process.platform === 'win32'
        ? spawnSync('where.exe', [bin], { encoding: 'utf8', windowsHide: true, timeout: 8000 })
        : spawnSync('sh', ['-c', `command -v ${bin}`], { encoding: 'utf8', timeout: 8000 });
      const hits = res.status === 0 ? String(res.stdout || '').split(/\r?\n/).map((s) => s.trim()).filter(Boolean) : [];
      // Windows: prefer a real .exe, then a .cmd shim. A bare name with no
      // extension there is a script for another shell; skip it.
      const onPath = process.platform === 'win32'
        ? hits.find((h) => /\.exe$/i.test(h)) || hits.find((h) => /\.(cmd|bat)$/i.test(h)) || ''
        : hits[0] || '';
      if (onPath) return onPath;
    } catch {
      /* next name, then the usual install places */
    }
  }
  const bin = spec.bin;
  // Not on PATH (npm's global folder often is not on Windows, and the hub may
  // run as a service with a short PATH): look where the installers put it.
  const home = process.env.USERPROFILE || process.env.HOME || '';
  const places = [...(spec.places ? spec.places(home) : []), ...(process.platform === 'win32'
    ? [
      path.join(process.env.APPDATA || path.join(home, 'AppData', 'Roaming'), 'npm', `${bin}.cmd`),
      path.join(home, '.local', 'bin', `${bin}.exe`),
    ]
    : [
      path.join(home, '.local', 'bin', bin),
      path.join(home, '.npm-global', 'bin', bin),
      `/usr/local/bin/${bin}`,
      `/usr/bin/${bin}`,
    ])];
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

/**
 * Model names in what a "list models" command printed: the first word of each
 * line that looks like one ("gpt-5", "claude-4.5-sonnet", "auto",
 * "Qwen3.8-Max"), skipping headings, rules and prose.
 */
export function parseModelList(out) {
  const seen = new Set();
  const list = [];
  for (const raw of String(out || '').replace(/\x1b\[[0-9;]*m/g, '').split(/\r?\n/)) {
    const line = raw.replace(/^[\s*•>\-|]+/, '').trim();
    if (!line || /^(available|models?|current|usage|tip|note|error|warning|loading|login|you)\b/i.test(line)) continue;
    const word = line.split(/[\s|,(（]+/)[0].replace(/[:：]$/, '');
    if (!/^[A-Za-z0-9][\w.:/-]{1,63}$/.test(word) || !/[a-z]/i.test(word) || /^(and|or|the|to|use|run|for|with|default)$/i.test(word)) continue;
    if (!seen.has(word)) { seen.add(word); list.push(word); }
    if (list.length >= 60) break;
  }
  return list;
}

/** Which coding CLIs this machine has, whether each is logged in, and its models. */
export async function detectCliAgents() {
  const config = await loadCliConfig();
  const result = [];
  for (const [id, spec] of Object.entries(CLI_AGENTS)) {
    const base = { id, label: spec.label, plan: spec.plan, install: spec.install, login: spec.login, model: config.models[id] || '' };
    const file = findCli(id);
    if (!file) { result.push({ ...base, installed: false, loggedIn: false, models: spec.models || [] }); continue; }
    const status = await runQuick(file, spec.statusArgs);
    const loggedIn = spec.loggedIn(status.out, status.code);
    let models = spec.models || [];
    if (spec.listArgs && loggedIn) {
      const listed = await runQuick(file, spec.listArgs, 30000);
      const names = listed.code === 0 ? parseModelList(listed.out) : [];
      // Its own list wins; a built-in name is kept only when it is not there in any case ("auto" vs "Auto").
      if (names.length) {
        const have = new Set(names.map((n) => n.toLowerCase()));
        models = [...(spec.models || []).filter((n) => !have.has(n.toLowerCase())), ...names];
      }
    }
    result.push({ ...base, installed: true, loggedIn, models });
  }
  return result;
}

// ---------------------------------------------------------------------------
// The human's default model per tool: data/cliagents.json {models:{cursor:'..'}}
// ---------------------------------------------------------------------------

const CONFIG_FILE = () => path.join(P.dataDir, 'cliagents.json');
const MODEL_NAME = /^[\w.:/@+-]{1,100}$/;

export async function loadCliConfig() {
  const raw = await readJson(CONFIG_FILE(), null);
  const models = {};
  for (const id of Object.keys(CLI_AGENTS)) {
    const m = String(raw?.models?.[id] || '').trim();
    if (MODEL_NAME.test(m)) models[id] = m;
  }
  return { models };
}

/** Set (or with '' clear) one tool's default model. -> the stored config */
export async function saveCliModel(agent, model) {
  if (!CLI_AGENTS[agent]) throw Object.assign(new Error(`unknown agent "${agent}"`), { code: 'CLI_UNKNOWN', status: 400 });
  const name = String(model || '').trim();
  if (name && !MODEL_NAME.test(name)) throw Object.assign(new Error('模型名只能有字母、数字和 . _ - : / @ +'), { code: 'CLI_BAD_MODEL', status: 400 });
  const config = await loadCliConfig();
  if (name) config.models[agent] = name; else delete config.models[agent];
  await writeJsonAtomic(CONFIG_FILE(), { ...config, updatedAt: new Date().toISOString() });
  return config;
}

/** A model name a bot passed: checked the same way, '' when it is not one. */
export function cleanModelName(model) {
  const name = String(model || '').trim();
  return MODEL_NAME.test(name) ? name : '';
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
export async function runCliAgent({ agent, task, dir, allowShell = false, model = '', signal, timeoutMs = CLI_AGENT_TIMEOUT_MS }) {
  const spec = CLI_AGENTS[agent];
  if (!spec) throw Object.assign(new Error(`unknown agent "${agent}" (${CLI_AGENT_IDS.join(', ')})`), { code: 'CLI_UNKNOWN' });
  const file = findCli(agent);
  if (!file) throw Object.assign(new Error(`这台机器上没有装 ${spec.label} 的命令行版。装法：${spec.install}，然后自己登录一次：${spec.login}`), { code: 'CLI_NOT_INSTALLED' });
  // No model named: the one the human picked in settings, else the tool's own default.
  const useModel = cleanModelName(model) || (await loadCliConfig()).models[agent] || '';
  await fsp.mkdir(dir, { recursive: true });
  if (spec.promptFile) await fsp.writeFile(path.join(dir, TASK_FILE), `${String(task)}\n`, 'utf8');
  const logFile = path.join(dir, 'output.log');
  const log = fs.createWriteStream(logFile);
  const started = Date.now();
  let tail = '';
  let timedOut = false;
  let stopped = false;
  const child = launch(file, spec.args({ dir, allowShell, model: useModel }), {
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
  child.stdin?.end(spec.promptFile ? '' : `${String(task)}\n`);
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
  if (agent !== 'codex') {
    // JSON output (Claude Code, Cursor, Qoder) prints one object with a
    // "result" text; take the last line that is one.
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
    // No JSON result (a tool that prints plain text): its last lines are the answer.
    if (!summary && exitCode === 0) summary = tail.trim().split(/\r?\n/).slice(-30).join('\n');
  } else {
    try { summary = (await fsp.readFile(path.join(dir, 'last-message.txt'), 'utf8')).trim(); } catch { /* none */ }
  }
  let files = [];
  try {
    files = (await fsp.readdir(dir)).filter((f) => !['output.log', 'last-message.txt', TASK_FILE].includes(f)).slice(0, 50);
  } catch { /* gone */ }
  return {
    agent,
    ...(useModel ? { model: useModel } : {}),
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
