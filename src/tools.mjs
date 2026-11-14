/**
 * tools.mjs - what a bot can actually do.
 *
 * Every tool is { name, description, parameters (JSON Schema), risk, run(args, ctx) }.
 *
 * `risk` is either a string or a function `(args) => {risk, reason}`. The function
 * form exists because context changes everything: writing notes/plan.md is LOW,
 * writing ../outside-note.md is HIGH. The registry declares the *minimum* risk;
 * approvals.mjs applies the policy on top and can only ever escalate.
 *
 * run() gets a context:
 *   { bot, config, workspaceDir, turnId, unattended, signal, emit, depth }
 * and returns a JSON-serializable object. Throwing an Error with .code marks the
 * call as failed; the agent turns it into a tool result the model can read.
 */

import os from 'node:os';
import path from 'node:path';
import fsp from 'node:fs/promises';
import { spawn } from 'node:child_process';
import { RISK } from './approvals.mjs';
import { childEnv } from './childenv.mjs';
import { describeImage, imageMime } from './vision.mjs';
import { fitForVision } from './imagefit.mjs';
import { generateImages, generateVideo, submitVideo } from './media.mjs';

// Bot-to-bot hand-offs (bot_message): how deep a chain may go (chief -> director
// -> writer -> ...), and how many hand-offs one task may make in total.
export const MAX_HANDOFF_DEPTH = 3;
export const MAX_HANDOFFS = 12;
// How this machine marks its own bots in a hand-off chain that crosses machines.
const SELF_TAG = os.hostname();
import { listVault, revealVault } from './vault.mjs';
import { askPeerBot, resolveRemoteMember, isRemoteMember } from './crossmachine.mjs';
import { runWinUi, WINUI_ACTIONS } from './winui.mjs';
import { CLI_AGENTS, CLI_AGENT_IDS, newTaskDir, runCliAgent } from './cliagents.mjs';

const hostOf = (u) => { try { return new URL(u).hostname.toLowerCase(); } catch { return ''; } };
/** Same site: equal hosts, or one is a subdomain of the other's registrable part (passport.jd.com ~ www.jd.com). */
function sameSite(a, b) {
  const x = hostOf(a);
  const y = hostOf(b);
  if (!x || !y) return false;
  if (x === y) return true;
  // IP addresses and single-label hosts must match exactly.
  const isIp = (h) => /^[\d.]+$/.test(h) || h.includes(':');
  if (isIp(x) || isIp(y) || !x.includes('.') || !y.includes('.')) return false;
  const base = (h) => h.split('.').slice(-2).join('.');
  return base(x) === base(y);
}
import { getBrowserManager } from './browser.mjs';
import { grantsForNewBot, isRequestable } from './abilities.mjs';
import { fetchPublic } from './netguard.mjs';
import { realPathOf } from './realpath.mjs';

const MAX_SHELL_OUTPUT = 20000;
const MAX_FILE_READ = 200000;

// ---------------------------------------------------------------------------
// helpers
// ---------------------------------------------------------------------------

export function toolError(code, message, details) {
  const err = new Error(message);
  err.code = code;
  if (details) err.details = details;
  return err;
}

function truncate(text, max) {
  const s = String(text ?? '');
  if (s.length <= max) return { text: s, truncated: false, originalLength: s.length };
  return { text: `${s.slice(0, max)}\n... [truncated ${s.length - max} chars]`, truncated: true, originalLength: s.length };
}

/**
 * Resolve a user/model supplied path against the shared workspace and report
 * whether it stayed inside. This is the load-bearing privacy check: the same
 * function decides risk and decides what gets written.
 */
function resolvePath(workspaceDir, input) {
  const raw = String(input ?? '.').trim() || '.';
  const abs = path.resolve(workspaceDir, raw);
  const wsWithSep = workspaceDir.endsWith(path.sep) ? workspaceDir : workspaceDir + path.sep;
  // Inside by name, and inside where links and junctions really lead (SEC-18).
  const realWs = realPathOf(workspaceDir);
  const realAbs = realPathOf(abs);
  const realWsSep = realWs.endsWith(path.sep) ? realWs : realWs + path.sep;
  const cmp = (s) => (process.platform === 'win32' ? s.toLowerCase() : s);
  const inWorkspace = (abs === workspaceDir || abs.startsWith(wsWithSep))
    && (cmp(realAbs) === cmp(realWs) || cmp(realAbs).startsWith(cmp(realWsSep)));
  return { abs, raw, inWorkspace, rel: path.relative(workspaceDir, abs) || '.' };
}

// Tools that change the computer or the team. Handing one of them to a bot
// goes past tool_request (which always asks), so it asks too (SEC-05).
const SENSITIVE_GRANTS = new Set(['shell', 'fs_delete', 'desktop_ui', 'browser_eval', 'browser_fill_secret',
  'bot_create', 'bot_update', 'bot_delete', 'settings_update', 'file_send', 'cli_agent_run', 'mcp_call']);
const GRANT_LABELS = { shell: '命令行', fs_delete: '删除文件', desktop_ui: '操作桌面', browser_eval: '在网页里运行脚本',
  browser_fill_secret: '填写保险箱里的密码', bot_create: '新建机器人', bot_update: '修改机器人', bot_delete: '删除机器人',
  settings_update: '修改设置', file_send: '发送文件', cli_agent_run: '编程助手', mcp_call: '连接应用' };
const grantLabel = (names) => names.map((n) => GRANT_LABELS[n] || n).join('、');

function outsideReason(resolved) {
  return `path resolves outside the shared workspace (${resolved.abs})`;
}

/** Risk helper: LOW inside the workspace, `outside` outside it. */
function workspaceRisk(insideRisk, outsideRisk) {
  return (args, ctx) => {
    const resolved = resolvePath(ctx.workspaceDir, args?.path);
    return resolved.inWorkspace ? { risk: insideRisk } : { risk: outsideRisk, reason: outsideReason(resolved) };
  };
}

function isPrivateHost(hostname) {
  const host = String(hostname || '').toLowerCase().replace(/^\[|\]$/g, '');
  if (!host) return true;
  if (host === 'localhost' || host.endsWith('.localhost') || host === '::1' || host === '0:0:0:0:0:0:0:1') return true;

  // Single-label hostnames are almost always the LAN (intranet, router, nas).
  if (!host.includes('.') && !host.includes(':')) return true;

  const v4 = host.match(/^(\d{1,3})\.(\d{1,3})\.(\d{1,3})\.(\d{1,3})$/);
  if (v4) {
    const [a, b] = [Number(v4[1]), Number(v4[2])];
    if (a === 10) return true;
    if (a === 127) return true;
    if (a === 0) return true;
    if (a === 169 && b === 254) return true;
    if (a === 192 && b === 168) return true;
    if (a === 172 && b >= 16 && b <= 31) return true;
  }
  if (host.startsWith('fc') || host.startsWith('fd') || host.startsWith('fe80')) return true; // IPv6 ULA/link-local
  return false;
}

// ---------------------------------------------------------------------------
// shell
// ---------------------------------------------------------------------------

/**
 * Run a command through the platform shell (cmd.exe on Windows, /bin/sh
 * elsewhere), with the shared workspace as cwd. Output is capped and the child
 * is killed on timeout or cancellation.
 *
 * Known limitation: with shell:true the child is the shell, so a grandchild
 * process may outlive a kill on Windows. The README lists this.
 */
/**
 * Windows consoles default to the ANSI code page (GBK on Chinese Windows), and
 * reading that as UTF-8 turned every Chinese word into "\uFFFD\uFFFD". The command
 * runs under "chcp 65001" (UTF-8) first; anything that still writes the local
 * code page is decoded with it.
 */
function windowsAnsiEncoding() {
  const locale = (() => { try { return Intl.DateTimeFormat().resolvedOptions().locale; } catch { return ''; } })();
  if (/^zh-(TW|HK|MO)|zh-Hant/i.test(locale)) return 'big5';
  if (/^zh/i.test(locale)) return 'gbk';
  if (/^ja/i.test(locale)) return 'shift_jis';
  if (/^ko/i.test(locale)) return 'euc-kr';
  return 'windows-1252';
}

function decodeOutput(buffer) {
  const utf8 = buffer.toString('utf8');
  if (process.platform !== 'win32' || !utf8.includes('\uFFFD')) return utf8;
  try {
    return new TextDecoder(windowsAnsiEncoding()).decode(buffer);
  } catch {
    return utf8;
  }
}

function runShellCommand(command, { cwd, timeoutMs, signal, maxOutput = MAX_SHELL_OUTPUT }) {
  return new Promise((resolve) => {
    let settled = false;
    // Raw bytes, decoded once at the end: a multi-byte character may be split
    // across chunks, and the right decoder is only known for the whole output.
    const out = { stdout: [], stderr: [], bytes: { stdout: 0, stderr: 0 } };
    let truncated = false;
    let timedOut = false;

    const finish = (payload) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      resolve(payload);
    };

    // Never hand the hub's settings, keys or the user's secrets to a command (SEC-12).
    const env = childEnv();

    const child = spawn(process.platform === 'win32' ? `chcp 65001 >nul & ${command}` : command, {
      shell: true,
      cwd,
      windowsHide: true,
      env,
      // Its own process group on Linux/macOS, so a timeout ends everything it started.
      detached: process.platform !== 'win32',
    });

    // maxOutput is in characters; 4 bytes per character is the UTF-8 worst case.
    const maxBytes = maxOutput * 4;
    const append = (which, chunk) => {
      const room = maxBytes - out.bytes[which];
      if (room <= 0) { truncated = true; return; }
      const slice = chunk.length > room ? chunk.subarray(0, room) : chunk;
      if (slice.length < chunk.length) truncated = true;
      out[which].push(slice);
      out.bytes[which] += slice.length;
    };
    const text = (which) => {
      const decoded = decodeOutput(Buffer.concat(out[which]));
      if (decoded.length > maxOutput) truncated = true;
      return decoded;
    };

    child.stdout.on('data', (c) => append('stdout', c));
    child.stderr.on('data', (c) => append('stderr', c));

    // The whole tree: the shell and whatever it started (seen: "start ... node
    // proxy.mjs" kept running after a timeout killed only cmd.exe).
    const kill = () => {
      try {
        if (process.platform === 'win32') spawn('taskkill', ['/pid', String(child.pid), '/T', '/F'], { windowsHide: true, stdio: 'ignore' }).on('error', () => {});
        else process.kill(-child.pid, 'SIGKILL');
      } catch {
        try { child.kill(); } catch { /* already gone */ }
      }
    };

    let exitCode = null;
    let exitSignal = null;
    let exited = false;
    let lingering = false;
    const done = () => {
      if (signal) signal.removeEventListener('abort', onAbort);
      finish({
        ok: exitCode === 0 && !timedOut,
        exitCode,
        signal: exitSignal || null,
        timedOut,
        stdout: truncate(text('stdout'), maxOutput).text,
        stderr: truncate(text('stderr'), maxOutput).text,
        truncated,
        ...(lingering ? { note: 'The command ended but a program it started is still running in the background (it kept the output open). Its later output is not shown; if it is a server, check it with another command (a port, a log file) instead of waiting on it.' } : {}),
        command,
        cwd,
      });
    };

    const timer = setTimeout(() => {
      timedOut = true;
      kill();
      // Whatever still holds the output open must not keep the turn waiting.
      setTimeout(() => { exitCode = exitCode ?? null; done(); }, 3000).unref?.();
    }, Math.max(1000, Number(timeoutMs) || 30000));

    const onAbort = () => {
      kill();
      setTimeout(done, 3000).unref?.();
    };
    if (signal) {
      if (signal.aborted) onAbort();
      else signal.addEventListener('abort', onAbort, { once: true });
    }

    child.on('error', (err) => {
      finish({ ok: false, error: { code: 'SHELL_SPAWN_FAILED', message: err.message }, stdout: text('stdout'), stderr: text('stderr'), timedOut });
    });

    // Normally the output closes with the command. When something it started
    // in the background keeps the output open, the command still counts as
    // finished a moment after it exits.
    child.on('exit', (code, sig) => {
      exited = true;
      exitCode = code;
      exitSignal = sig;
      setTimeout(() => {
        if (settled) return;
        lingering = true;
        child.stdout?.destroy();
        child.stderr?.destroy();
        done();
      }, 1500).unref?.();
    });
    child.on('close', (code, sig) => {
      if (!exited) { exitCode = code; exitSignal = sig; }
      done();
    });
  });
}

// ---------------------------------------------------------------------------
// Registry
// ---------------------------------------------------------------------------

/**
 * @param {object} deps
 * @param {string} deps.workspaceDir
 * @param {object} deps.config
 * @param {() => object} deps.getRuntime   late-bound AgentRuntime (bot_message needs it)
 * @param {() => object} deps.getRoutines  late-bound RoutineStore
 */
export function createRegistry(deps) {
  const tools = new Map();

  const add = (tool) => {
    tools.set(tool.name, tool);
    return tool;
  };

  // --- filesystem ---------------------------------------------------------

  add({
    name: 'fs_list',
    description: 'List a directory in the shared workspace. Directories first, sizes included.',
    risk: workspaceRisk(RISK.LOW, RISK.MEDIUM),
    parameters: {
      type: 'object',
      properties: {
        path: { type: 'string', description: 'Directory relative to the workspace root. Default ".".' },
      },
      additionalProperties: false,
    },
    async run(args, ctx) {
      const r = resolvePath(ctx.workspaceDir, args?.path);
      const stat = await fsp.stat(r.abs).catch(() => null);
      if (!stat) throw toolError('FS_NOT_FOUND', `no such path: ${r.rel}`);
      if (!stat.isDirectory()) throw toolError('FS_NOT_DIR', `${r.rel} is a file, not a directory`);

      const names = await fsp.readdir(r.abs, { withFileTypes: true });
      const entries = [];
      for (const entry of names.slice(0, 500)) {
        const info = await fsp.stat(path.join(r.abs, entry.name)).catch(() => null);
        entries.push({
          name: entry.name,
          type: entry.isDirectory() ? 'dir' : 'file',
          size: info?.size ?? null,
          modified: info ? new Date(info.mtimeMs).toISOString() : null,
        });
      }
      entries.sort((a, b) => (a.type === b.type ? a.name.localeCompare(b.name) : a.type === 'dir' ? -1 : 1));
      return { path: r.rel, count: entries.length, entries };
    },
  });

  add({
    name: 'vault_list',
    description: 'List the logins the human saved in this machine\'s vault: names, websites and which fields each has (never the values). Check it before asking the human to log in.',
    risk: RISK.LOW,
    parameters: { type: 'object', properties: {}, additionalProperties: false },
    async run() {
      return { entries: await listVault() };
    },
  });

  add({
    name: 'request_login',
    description:
      'Ask the human for a login you do not have yet. The chat shows a secure form; what they type goes straight into this machine\'s vault - you never see it. Use it when a site needs a username and password and vault_list has no entry for it. Your turn ends; when they reply, use browser_fill_secret with the entry name. For QR codes, SMS codes, CAPTCHA or payment use request_takeover instead.',
    risk: RISK.LOW,
    parameters: {
      type: 'object',
      properties: {
        name: { type: 'string', description: 'Short name for the vault entry, e.g. "京东".' },
        site: { type: 'string', description: 'The login page URL.' },
        fields: { type: 'array', items: { type: 'string' }, description: 'Field labels to ask for (default ["账号", "密码"]).' },
      },
      required: ['name'],
      additionalProperties: false,
    },
    async run(args) {
      const fields = (Array.isArray(args?.fields) && args.fields.length ? args.fields : ['账号', '密码']).map(String).slice(0, 6);
      return { waiting: true, name: String(args?.name || '').slice(0, 60), site: String(args?.site || '').slice(0, 300), fields };
    },
  });

  add({
    name: 'browser_fill_secret',
    description:
      'Type a value from the vault (a password, an account name) into a field on the current page, without the value ever reaching you. Give the vault entry name and the field ("账号"/"username", "密码"/"password"), plus the field ref from browser_snapshot or a CSS selector. It only works on the website the entry was saved for. The result says it was filled, never what was filled.',
    risk: RISK.LOW,
    parameters: {
      type: 'object',
      properties: {
        entry: { type: 'string', description: 'Vault entry name, e.g. "京东".' },
        field: { type: 'string', description: 'Which value: "账号"/"username" or "密码"/"password" (or the label used when it was saved).' },
        ref: { type: 'string', description: 'Element ref from browser_snapshot, e.g. "@e3".' },
        selector: { type: 'string', description: 'CSS selector, when you have no ref.' },
        submit: { type: 'boolean', description: 'Press Enter afterwards.' },
      },
      required: ['entry', 'field'],
      additionalProperties: false,
    },
    async run(args, ctx) {
      let secret;
      try {
        secret = await revealVault(args.entry, args.field);
      } catch (err) {
        throw toolError(err.code || 'VAULT_ERROR', err.message);
      }
      const mgr = browserManager(ctx);
      // Never type a saved password into a different site (phishing, a page
      // that talked the bot into it): the page must be on the entry's domain.
      if (secret.entry.site) {
        let here = '';
        try { here = String(await mgr.currentUrl()); } catch { /* checked below */ }
        if (!sameSite(here, secret.entry.site)) {
          throw toolError('VAULT_WRONG_SITE', `「${secret.entry.name}」是给 ${hostOf(secret.entry.site)} 的，当前页面是 ${hostOf(here) || '未知'}，不填。`);
        }
      }
      const result = await mgr.type({ ref: args.ref, selector: args.selector, text: secret.value, submit: Boolean(args.submit) });
      // The result must not carry the value back: keep only what is safe.
      const scrub = (v) => (typeof v === 'string' ? v.split(secret.value).join('•••') : v);
      const safe = {};
      for (const [k, v] of Object.entries(result || {})) {
        if (/^(value|actual|text|typed)$/i.test(k)) continue;
        safe[k] = typeof v === 'object' && v !== null ? JSON.parse(scrub(JSON.stringify(v))) : scrub(v);
      }
      return { ...safe, filled: !result?.error, entry: secret.entry.name, field: secret.field, length: secret.value.length };
    },
  });

  add({
    name: 'request_takeover',
    description:
      'Hand your screen to the human for a step only they should do: logging in, typing a password or verification code, scanning a QR code, a CAPTCHA, or paying. First open the page in your browser; then call this with one short sentence of what they should do (e.g. "在打开的京东页面登录你的账号"). The chat shows a card with a 接管屏幕 button; your turn ends, and you continue when they reply.',
    risk: RISK.LOW,
    parameters: {
      type: 'object',
      properties: {
        reason: { type: 'string', description: 'What the human should do, one short sentence in their language.' },
      },
      required: ['reason'],
      additionalProperties: false,
    },
    async run(args) {
      return { waiting: true, reason: String(args?.reason || '').slice(0, 300) };
    },
  });

  add({
    name: 'image_view',
    description:
      'Look at an image in the workspace (an attachment the human sent, a screenshot you took) and get a description of it, including any text in it. Ask a specific question (e.g. "这个报错弹窗写了什么？", "表格第三列的数字", "登录按钮在哪"): the answer comes back in a few seconds. Asking it to describe and transcribe everything makes it write for about a minute - do that only when you really need all of it. Use it whenever the human sends an image or you need to know what a screenshot shows - you cannot see images otherwise.',
    risk: RISK.LOW,
    parameters: {
      type: 'object',
      properties: {
        path: { type: 'string', description: 'Image path relative to the workspace root, e.g. uploads/2026-11-08/a.png or artifacts/shot.png.' },
        question: { type: 'string', description: 'What you want to know about it (optional; default: a short description with the important text).' },
      },
      required: ['path'],
      additionalProperties: false,
    },
    async run(args, ctx) {
      if (!args?.path) throw toolError('FS_BAD_ARGS', 'image_view needs a path');
      const r = resolvePath(ctx.workspaceDir, args.path);
      const mime = imageMime(r.abs);
      if (!mime) throw toolError('IMAGE_BAD_TYPE', `${r.rel} is not an image (png, jpg, gif, webp, bmp)`);
      let bytes;
      try {
        bytes = await fsp.readFile(r.abs);
      } catch (err) {
        if (err.code === 'ENOENT') throw toolError('FS_NOT_FOUND', `no such file: ${r.rel}`);
        throw err;
      }
      const service = typeof deps.getVision === 'function' ? deps.getVision() : null;
      // The model reads by pixels: a long side over 1568 costs time and money and
      // adds nothing (see imagefit.mjs). The file on disk stays as it is.
      const fit = fitForVision(bytes, mime);
      try {
        const seen = await describeImage(service, fit.bytes, fit.mime, args.question);
        const size = (s) => (s.w ? `${s.w}x${s.h} ` : '') + `${Math.round(s.bytes / 1024)} KB`;
        return {
          path: r.rel,
          model: seen.model,
          description: seen.text,
          sent: fit.changed ? `${size(fit.from)} -> ${size(fit.to)}` : size(fit.from),
          seconds: Math.round(seen.latencyMs / 100) / 10,
        };
      } catch (err) {
        throw toolError(err.code || 'VISION_FAILED', err.message);
      }
    },
  });

  add({
    name: 'image_generate',
    description:
      'Make pictures from a description (posters, illustrations, product shots, avatars, storyboard frames). The images are saved in the workspace under generated/ and shown in the chat when you mention their paths in your reply. Write the prompt in detail (subject, style, composition, lighting, colours); Chinese is fine. Costs a little money per image.',
    risk: RISK.MEDIUM,
    parameters: {
      type: 'object',
      properties: {
        prompt: { type: 'string', description: 'What to draw, in detail.' },
        size: { type: 'string', enum: ['1024x1024', '960x1280', '768x1024', '720x1280', '1280x720', '1024x768'], description: 'Width x height (default 1024x1024; 720x1280 for phone-screen portrait, 1280x720 for landscape).' },
        count: { type: 'number', description: 'How many (1-4, default 1).' },
        negativePrompt: { type: 'string', description: 'What to avoid (optional).' },
      },
      required: ['prompt'],
      additionalProperties: false,
    },
    async run(args, ctx) {
      const service = typeof deps.getMedia === 'function' ? deps.getMedia('image') : null;
      try {
        const out = await generateImages(service, args || {}, { workspaceDir: ctx.workspaceDir });
        return { paths: out.paths, model: out.model, seconds: Math.round(out.latencyMs / 1000), note: 'Mention each path in your reply so the human sees the images.' };
      } catch (err) {
        throw toolError(err.code || 'IMAGE_FAILED', err.message);
      }
    },
  });

  add({
    name: 'video_generate',
    description:
      'Make a short video clip (about 5 seconds) from a description, optionally starting from a workspace image as the first frame. It is made in the background: this returns at once, you tell the human it is on its way (usually 3-15 minutes), and when it is ready you get a new turn with the mp4 path (under generated/) to show them. Costs noticeably more than an image: make one clip unless asked for more.',
    risk: RISK.MEDIUM,
    parameters: {
      type: 'object',
      properties: {
        prompt: { type: 'string', description: 'What happens in the clip: subject, action, camera movement, style.' },
        image: { type: 'string', description: 'Optional workspace image to animate (first frame), e.g. generated/2026-11-08/image-x.png.' },
        size: { type: 'string', enum: ['1280x720', '720x1280', '960x960'], description: 'Default 1280x720 (landscape).' },
      },
      required: ['prompt'],
      additionalProperties: false,
    },
    async run(args, ctx) {
      const service = typeof deps.getMedia === 'function' ? deps.getMedia('video') : null;
      let imageDataUrl = '';
      if (args?.image) {
        const r = resolvePath(ctx.workspaceDir, args.image);
        const mime = imageMime(r.abs);
        if (!mime) throw toolError('IMAGE_BAD_TYPE', `${r.rel} is not an image`);
        try { imageDataUrl = `data:${mime};base64,${(await fsp.readFile(r.abs)).toString('base64')}`; } catch { throw toolError('FS_NOT_FOUND', `no such file: ${r.rel}`); }
      }
      const jobs = typeof deps.getVideoJobs === 'function' ? deps.getVideoJobs() : null;
      try {
        if (jobs) {
          // Background: a video can sit in the provider's queue for a long time.
          const task = await submitVideo(service, { prompt: args?.prompt, size: args?.size, imageDataUrl });
          // Made for a teammate: the bot the human is talking to hears when it is ready, too.
          const origin = Array.isArray(ctx.chain) ? ctx.chain[0] : null;
          const reportTo = origin && !String(origin).includes('@') && origin !== ctx.bot?.id ? origin : null;
          const job = await jobs.add({ botId: ctx.bot?.id, groupId: ctx.group?.id || null, prompt: args?.prompt, task, reportTo });
          return {
            submitted: true,
            job: job.id,
            model: task.model,
            note: 'The video is being made in the background (usually 3-15 minutes, longer when the service is busy). Tell the human that now and end your turn; when it is ready you will get a new turn with the file path to show them.',
          };
        }
        const out = await generateVideo(service, { prompt: args?.prompt, size: args?.size, imageDataUrl }, { workspaceDir: ctx.workspaceDir, signal: ctx.signal });
        return { path: out.path, model: out.model, seconds: Math.round(out.latencyMs / 1000), note: 'Mention the path in your reply so the human can play it.' };
      } catch (err) {
        throw toolError(err.code || 'VIDEO_FAILED', err.message);
      }
    },
  });

  add({
    name: 'fs_read',
    description: 'Read a UTF-8 text file. Large files are truncated.',
    risk: workspaceRisk(RISK.LOW, RISK.MEDIUM),
    parameters: {
      type: 'object',
      properties: {
        path: { type: 'string', description: 'File path relative to the workspace root.' },
        maxBytes: { type: 'number', description: `Cap on characters returned (default ${MAX_FILE_READ}).` },
      },
      required: ['path'],
      additionalProperties: false,
    },
    async run(args, ctx) {
      const r = resolvePath(ctx.workspaceDir, args?.path);
      if (!args?.path) throw toolError('FS_BAD_ARGS', 'fs_read needs a path');
      const limited = Math.min(Number(args?.maxBytes) || MAX_FILE_READ, 1000000);
      let raw;
      try {
        raw = await fsp.readFile(r.abs, 'utf8');
      } catch (err) {
        if (err.code === 'ENOENT') throw toolError('FS_NOT_FOUND', `no such file: ${r.rel}`);
        if (err.code === 'EISDIR') throw toolError('FS_IS_DIR', `${r.rel} is a directory; use fs_list`);
        throw err;
      }
      const clipped = truncate(raw, limited);
      return {
        path: r.rel,
        bytes: raw.length,
        content: clipped.text,
        truncated: clipped.truncated,
      };
    },
  });

  add({
    name: 'fs_write',
    description:
      'Write UTF-8 text to a file, creating parent directories. Overwrites by default. Paths outside the shared workspace need human approval.',
    risk: workspaceRisk(RISK.LOW, RISK.HIGH),
    parameters: {
      type: 'object',
      properties: {
        path: { type: 'string', description: 'File path relative to the workspace root.' },
        content: { type: 'string', description: 'Full file contents.' },
        mode: { type: 'string', enum: ['overwrite', 'append'], description: 'Default overwrite.' },
      },
      required: ['path', 'content'],
      additionalProperties: false,
    },
    async run(args, ctx) {
      const r = resolvePath(ctx.workspaceDir, args?.path);
      if (!args?.path) throw toolError('FS_BAD_ARGS', 'fs_write needs a path');
      const content = String(args?.content ?? '');
      await fsp.mkdir(path.dirname(r.abs), { recursive: true });
      if (args?.mode === 'append') await fsp.appendFile(r.abs, content, 'utf8');
      else await fsp.writeFile(r.abs, content, 'utf8');
      return {
        path: r.rel,
        bytes: Buffer.byteLength(content, 'utf8'),
        inWorkspace: r.inWorkspace,
        mode: args?.mode === 'append' ? 'append' : 'overwrite',
      };
    },
  });

  add({
    name: 'fs_mkdir',
    description: 'Create a directory (recursive) inside the shared workspace.',
    risk: workspaceRisk(RISK.LOW, RISK.HIGH),
    parameters: {
      type: 'object',
      properties: { path: { type: 'string', description: 'Directory path relative to the workspace root.' } },
      required: ['path'],
      additionalProperties: false,
    },
    async run(args, ctx) {
      const r = resolvePath(ctx.workspaceDir, args?.path);
      if (!args?.path) throw toolError('FS_BAD_ARGS', 'fs_mkdir needs a path');
      await fsp.mkdir(r.abs, { recursive: true });
      return { path: r.rel, created: true, inWorkspace: r.inWorkspace };
    },
  });

  add({
    name: 'fs_delete',
    description:
      'Delete a file or directory. Directories need recursive=true. Deletion outside the workspace is HIGH risk and always asks.',
    risk: workspaceRisk(RISK.MEDIUM, RISK.HIGH),
    parameters: {
      type: 'object',
      properties: {
        path: { type: 'string', description: 'Path relative to the workspace root.' },
        recursive: { type: 'boolean', description: 'Required for directories.' },
      },
      required: ['path'],
      additionalProperties: false,
    },
    async run(args, ctx) {
      const r = resolvePath(ctx.workspaceDir, args?.path);
      if (!args?.path) throw toolError('FS_BAD_ARGS', 'fs_delete needs a path');
      if (r.abs === ctx.workspaceDir) throw toolError('FS_REFUSED', 'refusing to delete the workspace root');
      const stat = await fsp.stat(r.abs).catch(() => null);
      if (!stat) throw toolError('FS_NOT_FOUND', `no such path: ${r.rel}`);
      if (stat.isDirectory() && !args?.recursive) {
        throw toolError('FS_NEEDS_RECURSIVE', `${r.rel} is a directory; pass recursive=true to remove it`);
      }
      await fsp.rm(r.abs, { recursive: Boolean(args?.recursive), force: false });
      return { path: r.rel, deleted: true, recursive: Boolean(args?.recursive) };
    },
  });

  // --- shell --------------------------------------------------------------

  add({
    name: 'shell',
    description:
      'Run a shell command with the shared workspace as the working directory. Output is truncated. Commands matching the danger denylist always require human approval.',
    // Base MEDIUM: auto-approved only when the bot's policy says so. approvals.mjs
    // promotes denylisted commands to HIGH.
    risk: RISK.MEDIUM,
    parameters: {
      type: 'object',
      properties: {
        command: { type: 'string', description: 'Command line, run through the platform shell.' },
        timeoutMs: { type: 'number', description: 'Kill after this many ms (default 30000, max 120000).' },
      },
      required: ['command'],
      additionalProperties: false,
    },
    async run(args, ctx) {
      const command = String(args?.command ?? '').trim();
      if (!command) throw toolError('SHELL_BAD_ARGS', 'shell needs a command');
      const timeoutMs = Math.min(Math.max(Number(args?.timeoutMs) || 30000, 1000), 120000);
      return runShellCommand(command, {
        cwd: ctx.workspaceDir,
        timeoutMs,
        signal: ctx.signal,
      });
    },
  });

  // --- coding CLIs on the human's own subscription (Claude Code, Codex, Cursor, Qoder)
  add({
    name: 'cli_agent_run',
    description:
      'Hand a programming task to an official coding assistant installed and logged in on this machine - Claude Code (agent "claude", the human\'s Claude Pro/Max plan), Codex CLI (agent "codex", their ChatGPT plan), Cursor (agent "cursor", their Cursor plan) or Qoder (agent "qoder", their Qoder plan) - so the work uses that subscription instead of paid API calls. ' +
      'model picks one of that tool\'s models (e.g. "opus" for Claude Code); leave it out to use the one the human chose in settings. Name a model only when the human asked for one or the task clearly needs a stronger or cheaper one. ' +
      'It works in its own folder inside the workspace (default cli-tasks/<date>-<id>/) and may create and edit files there. Set allowShell when it must run commands (run tests, execute a script); the human sees that on the approval card. ' +
      'Every call asks the human first. It can take up to 20 minutes; the stop button ends it. You get its summary, the last part of its output (the full log is output.log in the folder) and the files it left. ' +
      'Write the task completely: what to build, in which language, how to check it works. Use it for code; do small edits yourself.',
    risk: RISK.HIGH,
    parameters: {
      type: 'object',
      properties: {
        agent: { type: 'string', enum: CLI_AGENT_IDS, description: 'claude = Claude Code, codex = Codex CLI, cursor = Cursor CLI, qoder = Qoder CLI.' },
        model: { type: 'string', description: 'Optional model name for that tool (default: the human\'s choice in settings).' },
        task: { type: 'string', description: 'The whole task, in plain words (Chinese is fine).' },
        dir: { type: 'string', description: 'Folder in the workspace to work in (optional; default a new cli-tasks/<date>-<id>/).' },
        allowShell: { type: 'boolean', description: 'Let it run commands (tests, scripts). Default false: it only reads and edits files in the folder.' },
      },
      required: ['agent', 'task'],
      additionalProperties: false,
    },
    async run(args, ctx) {
      const agent = String(args?.agent || '');
      const task = String(args?.task || '').trim();
      if (!CLI_AGENTS[agent]) throw toolError('CLI_BAD_ARGS', `agent must be one of: ${CLI_AGENT_IDS.join(', ')}`);
      if (!task) throw toolError('CLI_BAD_ARGS', 'cli_agent_run needs a task');
      let dir;
      if (args?.dir) {
        const r = resolvePath(ctx.workspaceDir, args.dir);
        // Its own folder inside the workspace, never the workspace itself or beyond.
        if (!r.inWorkspace || r.abs === path.resolve(ctx.workspaceDir)) throw toolError('CLI_DIR_OUTSIDE', `the folder must be a subfolder of the workspace (got ${r.abs})`);
        dir = r.abs;
      } else {
        dir = newTaskDir(ctx.workspaceDir);
      }
      try {
        const res = await runCliAgent({ agent, task, dir, allowShell: Boolean(args?.allowShell), model: args?.model, signal: ctx.signal });
        return { ...res, dir: path.relative(ctx.workspaceDir, res.dir), outputFile: path.relative(ctx.workspaceDir, res.outputFile) };
      } catch (err) {
        throw toolError(err.code || 'CLI_FAILED', err.message);
      }
    },
  });

  // --- desktop programs on Windows (no real mouse: several bots at once) ---

  if (process.platform === 'win32' || process.env.DESK_WINUI_TOOL === '1') {
    add({
      name: 'desktop_ui',
      description:
        'Work a desktop program on this Windows machine in the background, through its accessibility interface: no real mouse or keyboard, so the human keeps working and other bots can do the same in other windows. ' +
        'Actions: windows (list open windows), controls (buttons, menus and text boxes of one window), click (press a button/menu/checkbox by its name or id), type (set the text of a text box; without target: the first editable box), read (all the text a window shows). ' +
        'Start a program with the shell tool first (for example "start notepad"). Programs without an accessibility interface (games, some drawing apps) cannot be worked this way; say so.',
      // Looking is free; pressing and typing change things the human may care about.
      risk: (args) => (args?.action === 'click' || args?.action === 'type' ? { risk: RISK.MEDIUM } : { risk: RISK.LOW }),
      parameters: {
        type: 'object',
        properties: {
          action: { type: 'string', enum: WINUI_ACTIONS },
          window: { type: 'string', description: 'Part of the window title (not for "windows").' },
          target: { type: 'string', description: 'Name or automation id of the control (click; optional for type).' },
          text: { type: 'string', description: 'The text to put in the box (type).' },
        },
        required: ['action'],
        additionalProperties: false,
      },
      async run(args, ctx) {
        const action = String(args?.action || '');
        if (action !== 'windows' && !String(args?.window || '').trim()) throw toolError('DESKTOP_UI_BAD_ARGS', 'say which window (part of its title)');
        if (action === 'click' && !String(args?.target || '').trim()) throw toolError('DESKTOP_UI_BAD_ARGS', 'say which button or menu to press');
        if (action === 'type' && typeof args?.text !== 'string') throw toolError('DESKTOP_UI_BAD_ARGS', 'say what text to type');
        try {
          return await runWinUi({ action, window: args.window, target: args.target, text: args.text }, { signal: ctx.signal });
        } catch (err) {
          throw toolError('DESKTOP_UI_FAILED', err.message);
        }
      },
    });
  }

  // --- network ------------------------------------------------------------

  add({
    name: 'http_fetch',
    description:
      'HTTP GET/POST a public URL. Private networks (localhost, 10/8, 192.168/16, 172.16/12, link-local) are blocked unless ALLOW_PRIVATE=1.',
    risk: RISK.MEDIUM,
    parameters: {
      type: 'object',
      properties: {
        url: { type: 'string', description: 'Absolute http(s) URL.' },
        method: { type: 'string', enum: ['GET', 'POST'], description: 'Default GET.' },
        headers: { type: 'object', description: 'Extra request headers.' },
        body: { type: 'string', description: 'Request body for POST.' },
        maxBytes: { type: 'number', description: 'Cap on response characters (default 100000).' },
      },
      required: ['url'],
      additionalProperties: false,
    },
    async run(args) {
      let target;
      try {
        target = new URL(String(args?.url || ''));
      } catch {
        throw toolError('HTTP_BAD_URL', `not a valid URL: ${args?.url}`);
      }
      if (!['http:', 'https:'].includes(target.protocol)) {
        throw toolError('HTTP_BAD_URL', 'only http and https are supported');
      }
      if (isPrivateHost(target.hostname) && process.env.ALLOW_PRIVATE !== '1') {
        throw toolError(
          'PRIVATE_HOST_BLOCKED',
          `${target.hostname} is a private or loopback address. Set ALLOW_PRIVATE=1 to allow LAN fetches.`,
        );
      }

      const method = String(args?.method || 'GET').toUpperCase();
      const maxBytes = Math.min(Number(args?.maxBytes) || 100000, 2000000);
      const headers = { 'user-agent': 'personal-assistant/1.0 (+local)', ...(args?.headers || {}) };

      // The name is resolved and every redirect checked, so a public-looking
      // address cannot lead into the home network (SEC-11).
      let res;
      try {
        res = await fetchPublic(target.href, {
          method,
          headers,
          body: method === 'POST' ? String(args?.body ?? '') : undefined,
          signal: AbortSignal.timeout(20000),
        });
      } catch (err) {
        if (err.code === 'PRIVATE_HOST_BLOCKED') throw toolError('PRIVATE_HOST_BLOCKED', err.message);
        throw toolError('HTTP_FAILED', `request failed: ${err.message}`);
      }

      const contentType = res.headers.get('content-type') || '';
      const raw = await res.text();
      const clipped = truncate(raw, maxBytes);
      return {
        url: res.finalUrl || res.url || target.href,
        status: res.status,
        ok: res.ok,
        contentType,
        bytes: raw.length,
        body: clipped.text,
        truncated: clipped.truncated,
      };
    },
  });

  // --- browser ------------------------------------------------------------
  // One browser session per process (a singleton), so a snapshot and the click
  // that uses one of its refs hit the same page inside a single turn.

  const browserManager = (ctx) => getBrowserManager(ctx?.bot?.id || '');

  add({
    name: 'browser_open',
    description:
      'Open a URL in the persistent browser on this machine and return the page title and url. Reuses one long-lived Chromium process with a saved profile, so logins and cookies survive between calls and restarts. ' +
      'LOW risk: navigating is not destructive. Use browser_snapshot afterwards to see what the page contains.',
    risk: RISK.LOW,
    parameters: {
      type: 'object',
      properties: { url: { type: 'string', description: 'Absolute http(s) URL.' } },
      required: ['url'],
      additionalProperties: false,
    },
    run: async (args, ctx) => {
      // On a Linux hub with per-bot desktops, the window must open on THIS
      // bot's display, so make sure the display exists before Chrome starts.
      try {
        const { desktopSupport, ensureDesktop } = await import('./desktops.mjs');
        if (desktopSupport().available && ctx?.bot?.id) await ensureDesktop(ctx.bot.id);
      } catch { /* fall back to the shared desktop */ }
      return browserManager(ctx).open(args);
    },
  });

  add({
    name: 'browser_snapshot',
    description:
      'Read the page the browser is on: visible text (script/style stripped, capped at 8000 chars) plus every interactive element with a stable ref. ' +
      'Each element looks like {ref:"@e3", tag, role, name, visible}. Always snapshot before clicking or typing; refs from an older page state fail with STALE_REF, so take a new snapshot after the page changes.',
    risk: RISK.LOW,
    parameters: { type: 'object', properties: {}, additionalProperties: false },
    run: (_args, ctx) => browserManager(ctx).snapshot(),
  });

  add({
    name: 'browser_click',
    description:
      'Click an element by ref from the latest snapshot ("@e3") or by CSS selector. Uses real mouse events at the element centre, then waits for the page to settle. ' +
      'MEDIUM risk because a click can submit a form or start a payment.',
    risk: RISK.MEDIUM,
    parameters: {
      type: 'object',
      properties: {
        ref: { type: 'string', description: 'Element ref from browser_snapshot, e.g. "@e3".' },
        selector: { type: 'string', description: 'CSS selector, used when you have no ref.' },
      },
      additionalProperties: false,
    },
    run: (args, ctx) => browserManager(ctx).click(args),
  });

  add({
    name: 'browser_type',
    description:
      'Focus a field (ref from the snapshot, or a CSS selector), clear it, type the text, and optionally press Enter to submit. Returns the value the field actually holds, so you can check it took. ' +
      'MEDIUM risk because typing into a form can change real state.',
    risk: RISK.MEDIUM,
    parameters: {
      type: 'object',
      properties: {
        ref: { type: 'string', description: 'Element ref from browser_snapshot, e.g. "@e2".' },
        selector: { type: 'string', description: 'CSS selector, used when you have no ref.' },
        text: { type: 'string', description: 'Text to type into the field.' },
        submit: { type: 'boolean', description: 'Press Enter after typing (default false).' },
      },
      required: ['text'],
      additionalProperties: false,
    },
    run: (args, ctx) => browserManager(ctx).type(args),
  });

  add({
    name: 'browser_screenshot',
    description:
      'Save a PNG of the current page to workspace/artifacts/<timestamp>.png (or a path you pass, inside the workspace) and return its relative path. ' +
      'Use it to show the human what the page looks like. LOW risk: it only reads the screen.',
    risk: RISK.LOW,
    parameters: {
      type: 'object',
      properties: { path: { type: 'string', description: 'Optional workspace-relative PNG path.' } },
      additionalProperties: false,
    },
    run: (args, ctx) => browserManager(ctx).screenshot(args, ctx),
  });

  add({
    name: 'browser_download',
    description:
      'Download a URL through the browser (it carries the profile\'s cookies) into workspace/downloads and return the file path and byte count. ' +
      'Use an optional path to rename it. MEDIUM risk because it pulls a file onto this machine.',
    risk: RISK.MEDIUM,
    parameters: {
      type: 'object',
      properties: {
        url: { type: 'string', description: 'Absolute http(s) URL of the file.' },
        path: { type: 'string', description: 'Optional workspace-relative destination path.' },
      },
      required: ['url'],
      additionalProperties: false,
    },
    run: (args, ctx) => browserManager(ctx).download(args, ctx),
  });

  add({
    name: 'browser_eval',
    description:
      'Run a JavaScript expression in the page and return its JSON value. Powerful and dangerous: it runs with the logged-in session\'s privileges. ' +
      'HIGH risk, so it always needs a human approval. Prefer snapshot/click/type when they can do the job.',
    risk: RISK.HIGH,
    parameters: {
      type: 'object',
      properties: { expression: { type: 'string', description: 'JavaScript expression; the value is returned as JSON.' } },
      required: ['expression'],
      additionalProperties: false,
    },
    run: (args, ctx) => browserManager(ctx).evaluate(args),
  });

  add({
    name: 'browser_close',
    description: 'Close the browser process this installation is driving. The saved profile stays on disk, so the next run keeps its logins.',
    risk: RISK.LOW,
    parameters: { type: 'object', properties: {}, additionalProperties: false },
    run: (_args, ctx) => browserManager(ctx).close(),
  });

  add({
    name: 'browser_status',
    description: 'Report whether a browser is running, its pid, profile directory, CDP url and which executable was detected. Use it to check the setup before trying to drive a page.',
    risk: RISK.LOW,
    parameters: { type: 'object', properties: {}, additionalProperties: false },
    run: (_args, ctx) => browserManager(ctx).status(),
  });

  // --- memory -------------------------------------------------------------

  add({
    name: 'memory_write',
    description:
      'Append one durable fact to memory. scope="bot" (default) writes to this bot only; scope="shared" writes a fact every bot may use.',
    risk: RISK.LOW,
    parameters: {
      type: 'object',
      properties: {
        text: { type: 'string', description: 'The fact to remember. One sentence, plain language.' },
        scope: { type: 'string', enum: ['bot', 'shared'], description: 'Default "bot".' },
      },
      required: ['text'],
      additionalProperties: false,
    },
    async run(args, ctx) {
      const scope = args?.scope === 'shared' ? 'shared' : ctx.bot.id;
      const saved = await ctx.memory.appendMemory(scope, String(args?.text ?? ''));
      return { saved: true, scope: scope === 'shared' ? 'shared' : 'bot', entry: saved };
    },
  });

  add({
    name: 'memory_read',
    description: 'Search this bot\'s memory (plus shared facts) by keywords, newest-relevant first.',
    risk: RISK.LOW,
    parameters: {
      type: 'object',
      properties: {
        query: { type: 'string', description: 'Keywords. Empty returns the most recent entries.' },
        limit: { type: 'number', description: 'Max entries (default 8).' },
      },
      additionalProperties: false,
    },
    async run(args, ctx) {
      const entries = await ctx.memory.retrieve({
        botId: ctx.bot.id,
        query: String(args?.query || ''),
        limit: Math.min(Number(args?.limit) || 8, 50),
      });
      return {
        count: entries.length,
        entries: entries.map((e) => ({ text: e.text, when: e.ts ? new Date(e.ts).toISOString() : null, scope: e.source })),
      };
    },
  });

  // --- skills -------------------------------------------------------------

  add({
    name: 'skill_list',
    description: 'List the shared skill library (name, description, when to use).',
    risk: RISK.LOW,
    parameters: { type: 'object', properties: {}, additionalProperties: false },
    async run(_args, ctx) {
      const all = await ctx.skills.listSkills();
      return {
        count: all.length,
        skills: all.map((s) => ({
          name: s.name,
          slug: s.slug,
          description: s.description,
          when_to_use: s.when_to_use,
          granted: (ctx.bot.skills || []).includes(s.slug) || (ctx.bot.skills || []).includes(s.name),
        })),
      };
    },
  });

  add({
    name: 'skill_read',
    description: 'Read one skill in full, including its steps, validation and approval notes.',
    risk: RISK.LOW,
    parameters: {
      type: 'object',
      properties: { name: { type: 'string', description: 'Skill name or slug.' } },
      required: ['name'],
      additionalProperties: false,
    },
    async run(args, ctx) {
      const skill = await ctx.skills.readSkill(String(args?.name || ''));
      if (!skill) throw toolError('SKILL_NOT_FOUND', `no skill named "${args?.name}"`);
      return {
        name: skill.name,
        slug: skill.slug,
        description: skill.description,
        when_to_use: skill.when_to_use,
        steps: skill.steps,
        validation: skill.validation,
        output: skill.output,
        approval_notes: skill.approval_notes,
        body: skill.body.slice(0, 6000),
      };
    },
  });

  add({
    name: 'skill_save',
    description:
      'Save a reusable procedure as a new skill file in the shared library. All of name, description, when_to_use, steps, validation, output and approval_notes are required.',
    risk: RISK.MEDIUM,
    parameters: {
      type: 'object',
      properties: {
        name: { type: 'string', description: 'Human name, e.g. "Workspace sweep".' },
        description: { type: 'string' },
        when_to_use: { type: 'string' },
        steps: { type: 'array', items: { type: 'string' }, description: 'Ordered steps.' },
        validation: { type: 'string', description: 'How to check the skill worked.' },
        output: { type: 'string', description: 'What the skill produces.' },
        approval_notes: { type: 'string', description: 'What needs human approval.' },
        body: { type: 'string', description: 'Optional markdown body explaining the procedure.' },
      },
      required: ['name', 'description', 'when_to_use', 'steps', 'validation', 'output', 'approval_notes'],
      additionalProperties: false,
    },
    async run(args, ctx) {
      const saved = await ctx.skills.saveSkill(args || {});
      return { saved: true, name: saved.name, slug: saved.slug, file: saved.file, replaced: saved.replaced };
    },
  });

  // --- routines -----------------------------------------------------------

  add({
    name: 'routine_create',
    description:
      'Schedule a recurring instruction for a bot. schedule is a 5-field cron expression or "every N minutes"/"every N hours". For "check X and tell me when it changes" set onlyChanges: runs with nothing new stay quiet. pushFeishu also sends each result to the human\'s Feishu.',
    risk: RISK.MEDIUM,
    parameters: {
      type: 'object',
      properties: {
        name: { type: 'string' },
        instruction: { type: 'string', description: 'The prompt to run each time.' },
        schedule: { type: 'string', description: 'e.g. "0 9 * * 1-5" or "every 30 minutes".' },
        botId: { type: 'string', description: 'Defaults to the calling bot.' },
        timezone: { type: 'string', description: 'IANA timezone, defaults to the assistant timezone.' },
        enabled: { type: 'boolean' },
        onlyChanges: { type: 'boolean', description: 'Tell the human only when the result changed since the last run.' },
        pushFeishu: { type: 'boolean', description: 'Also send each (non-quiet) result to the human on Feishu.' },
      },
      required: ['instruction', 'schedule'],
      additionalProperties: false,
    },
    async run(args, ctx) {
      const routines = deps.getRoutines();
      const routine = await routines.create({
        botId: args?.botId || ctx.bot.id,
        name: args?.name || 'Scheduled task',
        instruction: args?.instruction,
        schedule: args?.schedule,
        timezone: args?.timezone,
        enabled: args?.enabled !== false,
        onlyChanges: Boolean(args?.onlyChanges),
        pushFeishu: Boolean(args?.pushFeishu),
      });
      return { created: true, routine: publicRoutine(routine) };
    },
  });

  add({
    name: 'routine_list',
    description: 'List routines with their schedule, enabled flag, next run and last result.',
    risk: RISK.LOW,
    parameters: { type: 'object', properties: {}, additionalProperties: false },
    async run() {
      const routines = deps.getRoutines();
      return { count: routines.list().length, routines: routines.list().map(publicRoutine) };
    },
  });

  add({
    name: 'routine_run',
    description: 'Queue a routine to run now, unattended. Returns immediately; the run is recorded in the routine history.',
    risk: RISK.MEDIUM,
    parameters: {
      type: 'object',
      properties: { id: { type: 'string', description: 'Routine id.' } },
      required: ['id'],
      additionalProperties: false,
    },
    async run(args) {
      const routines = deps.getRoutines();
      const routine = routines.get(String(args?.id || ''));
      if (!routine) throw toolError('ROUTINE_NOT_FOUND', `no routine with id "${args?.id}"`);
      // Queue instead of awaiting: a tool call inside a turn must not start a
      // nested turn in the same stack.
      setImmediate(() => {
        routines.runNow(routine.id, { trigger: 'manual' }).catch((err) => {
          console.error('[routine_run] failed:', err.message);
        });
      });
      return { queued: true, routineId: routine.id, nextRun: routine.nextRun };
    },
  });

  // --- bots ---------------------------------------------------------------

  add({
    name: 'bot_list',
    description: 'List the bots on the team: the ones on this machine (with what they may do) and, under otherMachines, the ones on the human\'s other machines (hand them work with bot_message and its machine argument).',
    risk: RISK.LOW,
    parameters: { type: 'object', properties: {}, additionalProperties: false },
    async run(_args, ctx) {
      const bots = await ctx.bots.listBots();
      const peers = typeof deps.getPeers === 'function' ? deps.getPeers() : null;
      const otherMachines = peers ? await peers.rosters().catch(() => []) : [];
      return {
        bots: bots.map((b) => ({
          id: b.id,
          name: b.name,
          role: b.role,
          primary: b.primary,
          tools: b.tools,
          isMe: b.id === ctx.bot.id,
        })),
        ...(otherMachines.length ? { otherMachines } : {}),
      };
    },
  });

  /**
   * bot_message to a bot on another machine: run its turn there (over the
   * peer link the desktop client set up), wait, bring the reply back. The
   * same depth / budget / no-hand-back rules travel with the task.
   */
  async function handOffToPeer(args, ctx) {
    const peers = typeof deps.getPeers === 'function' ? deps.getPeers() : null;
    const peer = peers?.find(args.machine);
    if (!peer) throw toolError('PEER_NOT_FOUND', `no machine called "${args.machine}"; bot_list shows the machines this one can reach`);
    if ((ctx.depth || 0) >= MAX_HANDOFF_DEPTH) {
      throw toolError('BOT_DEPTH_EXCEEDED', `hand-offs go at most ${MAX_HANDOFF_DEPTH} levels deep and this is the last one: do this part yourself`);
    }
    const budget = ctx.handoffBudget || { left: MAX_HANDOFFS };
    if (budget.left <= 0) throw toolError('BOT_HANDOFF_BUDGET', `this task already used its ${MAX_HANDOFFS} hand-offs: do the rest yourself and report what is left`);
    let roster;
    try { roster = await peers.json(peer, 'GET', '/api/bots', { timeoutMs: 15000 }); } catch (err) { throw toolError(err.code || 'PEER_ERROR', err.message); }
    const want = String(args.botId || '').trim().toLowerCase();
    const list = roster.bots || roster || [];
    const target = list.find((b) => b.id.toLowerCase() === want) || list.find((b) => String(b.name).toLowerCase() === want)
      || list.find((b) => String(b.name).toLowerCase().includes(want));
    if (!target) throw toolError('BOT_NOT_FOUND', `「${peer.name}」上没有「${args.botId}」；那台机器上有：${list.map((b) => `${b.name}（${b.id}）`).join('、')}`);
    budget.left -= 1;
    // Chain entries from this machine carry this machine's tag, so the other
    // side can tell its own bots from ours.
    const chain = (Array.isArray(ctx.chain) && ctx.chain.length ? ctx.chain : [ctx.bot.id]).map((c) => (c.includes('@') ? c : `${c}@${SELF_TAG}`));
    // The files the request names go along; the files the answer names come back.
    let r;
    try {
      r = await askPeerBot(peers, peer, {
        botId: target.id,
        text: String(args.text || ''),
        handoff: { depth: (ctx.depth || 0) + 1, chain: [...chain, target.id], budgetLeft: budget.left, from: { bot: ctx.bot.name } },
        workspaceDir: ctx.workspaceDir,
        signal: ctx.signal,
      });
    } catch (err) { throw toolError(err.code || 'PEER_ERROR', err.message); }
    return {
      machine: peer.name,
      botId: target.id,
      botName: target.name,
      status: r.status,
      turnId: r.turnId,
      reply: r.reply || '(no reply)',
      ...(r.sent.length ? { filesSent: r.sent } : {}),
      ...(r.fetched.length ? { filesFetched: r.fetched } : {}),
      note: r.fetched.length
        ? `The files its answer names were fetched to this machine (filesFetched: use the "to" paths). Tell the human the result and where it is now.`
        : `Files it made stay on 「${peer.name}」 unless its answer named them: file_fetch what the human needs, then tell them the result and where it is now.`,
    };
  }

  add({
    name: 'briefing_collect',
    description: 'Gather what happened in the last hours on this machine and every other machine of the human: per bot the work that ran and how it ended, what is waiting on the human (approvals, logins, takeovers), pages made, background videos, routines. Use it to write a daily briefing or answer "what happened while I was away".',
    risk: RISK.LOW,
    parameters: {
      type: 'object',
      properties: { hours: { type: 'number', description: 'How far back, in hours (default 24).' } },
      additionalProperties: false,
    },
    async run(args) {
      const hours = Math.min(Math.max(Number(args?.hours) || 24, 1), 168);
      const local = typeof deps.getBriefing === 'function' ? deps.getBriefing() : null;
      if (!local) throw toolError('BRIEFING_UNAVAILABLE', 'the briefing is not available here');
      const machines = [await local(hours)];
      const peers = typeof deps.getPeers === 'function' ? deps.getPeers() : null;
      const unreachable = [];
      for (const p of peers ? peers.list() : []) {
        try {
          machines.push(await peers.json(peers.find(p.name), 'GET', `/api/briefing/data?hours=${hours}`, { timeoutMs: 15000 }));
        } catch (err) { unreachable.push({ machine: p.name, why: err.message }); }
      }
      return { hours, machines, ...(unreachable.length ? { unreachable } : {}) };
    },
  });

  add({
    name: 'page_save',
    description: 'Save a report, dashboard, tracker or any result worth keeping as a web page in the page library (pages/ in the workspace). The human sees it as a card in the chat and can open it again later from the page library. Give a whole HTML document or just the body (html), or - for a long page - write it to a workspace file first with fs_write (in parts with mode "append") and pass file. Inline CSS/JS is fine, images in the workspace are embedded. To update a page, save again with the same name. Write the returned path in your reply.',
    risk: RISK.LOW,
    parameters: {
      type: 'object',
      properties: {
        title: { type: 'string', description: 'Page title shown in the library.' },
        html: { type: 'string', description: 'The page: a full HTML document or body HTML. For a long page use file instead.' },
        file: { type: 'string', description: 'Workspace path of an HTML file you already wrote (for long pages).' },
        name: { type: 'string', description: 'Optional file name (letters, digits, dashes), e.g. "weekly-sales". Same name = update that page.' },
      },
      required: ['title'],
      additionalProperties: false,
    },
    async run(args, ctx) {
      const pages = typeof deps.getPages === 'function' ? deps.getPages() : null;
      if (!pages) throw toolError('PAGES_UNAVAILABLE', 'the page library is not available here');
      let html = args?.html;
      if (!html && args?.file) {
        const r = resolvePath(ctx.workspaceDir, args.file);
        if (!r.inWorkspace) throw toolError('FS_OUTSIDE_WORKSPACE', 'file must be in the workspace');
        try { html = await fsp.readFile(r.abs, 'utf8'); } catch { throw toolError('FS_NOT_FOUND', `no such file: ${r.rel}`); }
      }
      if (!String(html || '').trim()) throw toolError('PAGE_EMPTY', 'the page is empty: give html, or write the page to a workspace file (fs_write, in parts if long) and pass file');
      try {
        const out = await pages.save({ title: args?.title, html, name: args?.name, bot: ctx.bot });
        return { ...out, note: 'Write this path in your reply; it shows as a card the human can open.' };
      } catch (err) { throw toolError(err.code || 'PAGE_FAILED', err.message); }
    },
  });

  add({
    name: 'file_send',
    description: 'Copy a file from this machine\'s workspace to another machine\'s workspace (before handing a bot there work that needs it). Returns the path on the other machine. Up to 25 MB.',
    risk: RISK.LOW,
    parameters: {
      type: 'object',
      properties: {
        machine: { type: 'string', description: 'The other machine\'s name (see bot_list otherMachines).' },
        path: { type: 'string', description: 'Workspace-relative path of the file here.' },
      },
      required: ['machine', 'path'],
      additionalProperties: false,
    },
    async run(args, ctx) {
      const peers = typeof deps.getPeers === 'function' ? deps.getPeers() : null;
      const peer = peers?.find(args?.machine);
      if (!peer) throw toolError('PEER_NOT_FOUND', `no machine called "${args?.machine}"`);
      const r = resolvePath(ctx.workspaceDir, args.path);
      if (!r.inWorkspace) throw toolError('FS_OUTSIDE_WORKSPACE', 'only files in the workspace can be sent');
      let bytes;
      try { bytes = await fsp.readFile(r.abs); } catch { throw toolError('FS_NOT_FOUND', `no such file: ${r.rel}`); }
      if (bytes.length > 25 * 1024 * 1024) throw toolError('FILE_TOO_LARGE', 'files over 25 MB cannot be sent');
      try {
        const out = await peers.json(peer, 'POST', '/api/uploads', { raw: bytes, headers: { 'x-file-name': encodeURIComponent(path.basename(r.abs)) }, timeoutMs: 120000 });
        return { machine: peer.name, path: out.path, bytes: bytes.length };
      } catch (err) { throw toolError(err.code || 'PEER_ERROR', err.message); }
    },
  });

  add({
    name: 'file_fetch',
    description: 'Copy a file from another machine\'s workspace into this machine\'s workspace (a result a bot there made). Returns the path here.',
    risk: RISK.LOW,
    parameters: {
      type: 'object',
      properties: {
        machine: { type: 'string', description: 'The other machine\'s name.' },
        path: { type: 'string', description: 'Workspace-relative path on that machine (as its bot reported it).' },
      },
      required: ['machine', 'path'],
      additionalProperties: false,
    },
    async run(args, ctx) {
      const peers = typeof deps.getPeers === 'function' ? deps.getPeers() : null;
      const peer = peers?.find(args?.machine);
      if (!peer) throw toolError('PEER_NOT_FOUND', `no machine called "${args?.machine}"`);
      const rel = String(args.path || '').replace(/^\.\//, '').replace(/^workspace\//, '');
      let res;
      try { res = await peers.call(peer, 'GET', `/api/workspace/file?path=${encodeURIComponent(rel)}`, { timeoutMs: 120000 }); } catch (err) { throw toolError(err.code || 'PEER_ERROR', err.message); }
      if (!res.ok) throw toolError('FS_NOT_FOUND', `「${peer.name}」上没有这个文件：${rel}`);
      const bytes = Buffer.from(await res.arrayBuffer());
      const day = new Date().toISOString().slice(0, 10);
      const destRel = path.posix.join('from-machines', String(peer.name).replace(/[\\/:*?"<>|]/g, '_'), day, path.posix.basename(rel));
      await fsp.mkdir(path.join(ctx.workspaceDir, path.posix.dirname(destRel)), { recursive: true });
      await fsp.writeFile(path.join(ctx.workspaceDir, destRel), bytes);
      return { machine: peer.name, path: destRel, bytes: bytes.length, note: 'Now on this machine at this path: tell the human the path (and the content, if short).' };
    },
  });

  add({
    name: 'bot_message',
    description:
      'Send a task to another bot and wait for its reply. This is how work is handed off: the other bot runs its own turn, with its own tools, memory and approval boundary, and may hand parts on to its own teammates. Give it everything it needs (goal, inputs, file paths, what to deliver). For a bot on another machine, also give machine (its name from bot_list otherMachines); workspaces are separate, but workspace files you name by path in the text are sent along automatically and the files its answer names are fetched back (file_send / file_fetch are for anything else). Hand-offs go up to 3 levels deep and 12 per task; you cannot hand work back to a bot that is waiting on you - return your result instead.',
    // LOW: internal coordination between teammates that share one workspace. The
    // "sending messages always asks" rule in the reference product is about
    // outward-facing channels (email, chat to a human); there is no such tool
    // here. Hand-offs are bounded in run(): depth, a per-task budget, and no
    // hand-off back up the chain (that bot is waiting on this one: deadlock).
    risk: RISK.LOW,
    parameters: {
      type: 'object',
      properties: {
        botId: { type: 'string', description: 'Target bot id (or name).' },
        text: { type: 'string', description: 'What you are asking them to do.' },
        machine: { type: 'string', description: 'Only for a bot on another machine: that machine\'s name (see bot_list otherMachines).' },
      },
      required: ['botId', 'text'],
      additionalProperties: false,
    },
    async run(args, ctx) {
      const targetId = String(args?.botId || '');
      if (args?.machine) return handOffToPeer(args, ctx);
      if (targetId === ctx.bot.id) throw toolError('BOT_SELF_MESSAGE', 'a bot cannot message itself; just do the work');
      if ((ctx.depth || 0) >= MAX_HANDOFF_DEPTH) {
        throw toolError('BOT_DEPTH_EXCEEDED', `hand-offs go at most ${MAX_HANDOFF_DEPTH} levels deep and this is the last one: do this part yourself`);
      }
      const target = await ctx.bots.getBot(targetId);
      if (!target) throw toolError('BOT_NOT_FOUND', `no bot with id "${targetId}"`);
      // Everyone above this bot on the chain is waiting for it; handing work
      // back to one of them would make both wait for each other forever.
      const chain = Array.isArray(ctx.chain) && ctx.chain.length ? ctx.chain : [ctx.bot.id];
      if (chain.includes(target.id) || chain.includes(`${target.id}@${SELF_TAG}`)) {
        throw toolError('BOT_IN_CHAIN', `${target.name} is waiting for your result (the work came from them, or through them). Do not hand it back: finish your part and return it as your final answer.`);
      }
      const budget = ctx.handoffBudget || { left: MAX_HANDOFFS };
      if (budget.left <= 0) {
        throw toolError('BOT_HANDOFF_BUDGET', `this task already used its ${MAX_HANDOFFS} hand-offs: do the rest yourself and report what is left`);
      }
      budget.left -= 1;

      const runtime = deps.getRuntime();
      const result = await runtime.runTurn({
        botId: target.id,
        text: String(args?.text || ''),
        source: 'bot',
        depth: (ctx.depth || 0) + 1,
        chain: [...chain, target.id],
        handoffBudget: budget,
        unattended: ctx.unattended,
        parentTurnId: ctx.turnId,
        // A hand-off from inside a group hands the group context down too: the
        // teammate then knows the group id and can answer the whole group with
        // group_post instead of only replying privately.
        ...(ctx.group && ctx.groupTurn ? { group: ctx.group, groupRole: 'member' } : {}),
      });
      return {
        botId: target.id,
        botName: target.name,
        status: result.status,
        turnId: result.turnId,
        reply: result.summary || '(no reply)',
      };
    },
  });

  // --- asking for a tool ------------------------------------------------------
  //
  // A bot that finds it lacks a tool asks the human here instead of answering
  // "I can't". Always asks (the runtime turns AUTO into ASK for it); a yes adds
  // the tools to the bot for good, and they are usable from its next step.

  add({
    name: 'tool_request',
    description:
      'Ask the human to give you tools you do not have yet but need for the work in hand (e.g. shell to run a command, browser_open to use a browser, fs_delete to remove files). The human sees a card and decides; on yes the tools are yours from your next step, so carry on with the work. Use this instead of saying you cannot do something because a tool is missing.',
    risk: RISK.MEDIUM,
    parameters: {
      type: 'object',
      properties: {
        tools: { type: 'array', items: { type: 'string' }, description: 'Tool names you need.' },
        reason: { type: 'string', description: 'One sentence: what you need them for.' },
      },
      required: ['tools', 'reason'],
      additionalProperties: false,
    },
    async run(args, ctx) {
      if (typeof ctx.bots?.updateBot !== 'function') throw toolError('BOTS_API_UNAVAILABLE', 'this runtime cannot change grants');
      const wanted = [...new Set((Array.isArray(args?.tools) ? args.tools : []).map(String))];
      const unknown = wanted.filter((n) => !tools.has(n));
      const refused = wanted.filter((n) => tools.has(n) && !isRequestable(n));
      const add = wanted.filter((n) => tools.has(n) && isRequestable(n) && !(ctx.bot.tools || []).includes(n));
      if (add.length) {
        const updated = await ctx.bots.updateBot(ctx.bot.id, { tools: [...new Set([...(ctx.bot.tools || []), ...add])] });
        // The turn's bot object is what the next model call reads its tools from.
        ctx.bot.tools = updated.tools;
        ctx.bot.revokedTools = updated.revokedTools;
      }
      return {
        granted: add,
        ...(unknown.length ? { unknown } : {}),
        ...(refused.length ? { notRequestable: refused, note: 'these stay with the primary bot; ask it with bot_message or tell the human' } : {}),
        next: add.length ? 'granted: use them now and carry on with the work' : 'nothing new was granted',
      };
    },
  });

  // --- roster management ---------------------------------------------------
  //
  // MEDIUM: creating a teammate or reshaping the team is a real change, so it
  // goes through the same approval boundary as other medium-risk writes. HIGH:
  // deleting a bot throws away its transcript and its group seats, so a human
  // must say yes every single time, even when the bot auto-approves medium work.

  add({
    name: 'bot_create',
    description:
      'Create a new teammate bot on this machine. It appears in the roster immediately with its own memory and its own transcript. It gets the tools every teammate needs automatically (read/write its workspace files, fetch pages, notes, group_post) plus shell / browser_open when its role plainly calls for them; list in tools anything else its job needs (e.g. fs_delete, bot_message, routine_create) - not more. Tell the human in one line what it can do. Later it can ask the human for a missing tool itself. Name it in the language the human writes in (Chinese conversation -> a Chinese name such as 编剧 or 美术). When the human asks for a team, first list the bots you would create (name + job, keep it to the fewest that cover the work) and ask before creating more than one; create a group only if the human asks for one or agrees.',
    risk: RISK.MEDIUM,
    // A new bot that gets risky tools spelled out asks even a trusted bot.
    escalate: (args) => {
      const risky = (Array.isArray(args?.tools) ? args.tools : []).map(String).filter((t) => SENSITIVE_GRANTS.has(t));
      return risky.length ? { risk: RISK.HIGH, reason: `新机器人要带上：${grantLabel(risky)}` } : null;
    },
    parameters: {
      type: 'object',
      properties: {
        name: { type: 'string', description: 'Display name; the id is derived from it.' },
        role: { type: 'string', description: 'One line about what this bot is for.' },
        tools: {
          type: 'array',
          items: { type: 'string' },
          description: 'Tool grants, by tool name (see the tool list). Defaults to none.',
        },
        skills: { type: 'array', items: { type: 'string' }, description: 'Skill grants, by skill name.' },
        avatar: {
          type: 'object',
          description: 'Optional avatar look: {shape, color}.',
          properties: {
            shape: { type: 'string', description: 'squircle|circle|blob|star|flower|hex|octagon|diamond|arch|leaf|gem|wave|ring|drop|chip' },
            color: { type: 'string', description: 'Six-digit hex colour, e.g. "#22c55e".' },
          },
          additionalProperties: false,
        },
      },
      required: ['name'],
      additionalProperties: false,
    },
    async run(args, ctx) {
      if (typeof ctx.bots?.createBot !== 'function') {
        throw toolError('BOTS_API_UNAVAILABLE', 'this runtime cannot create bots');
      }
      const name = String(args?.name ?? '').trim();
      if (!name) throw toolError('BOT_INVALID', 'a bot needs a name');

      const created = await ctx.bots.createBot({
        name,
        role: String(args?.role ?? ''),
        // What every teammate needs, what its role calls for, and what was asked for.
        tools: grantsForNewBot({ role: args?.role, requested: Array.isArray(args?.tools) ? args.tools : [], known: new Set(tools.keys()) }),
        skills: Array.isArray(args?.skills) ? args.skills : [],
        ...(args?.avatar && typeof args.avatar === 'object' ? { avatar: args.avatar } : {}),
      });
      return {
        created: true,
        bot: {
          id: created.id,
          name: created.name,
          role: created.role,
          tools: created.tools,
          skills: created.skills,
          avatar: created.avatar,
        },
      };
    },
  });

  add({
    name: 'bot_update',
    description:
      'Change an existing bot: its display name, role, tool grants, skill grants or avatar look. Ids are immutable; to rename the id, create a new bot.',
    risk: RISK.MEDIUM,
    // Adding a risky tool to any bot (itself included) asks, like tool_request does.
    escalate: async (args, ctx) => {
      if (!Array.isArray(args?.tools)) return null;
      const current = new Set((await ctx?.bots?.getBot?.(String(args?.id || '')))?.tools || []);
      const added = args.tools.map(String).filter((t) => !current.has(t) && SENSITIVE_GRANTS.has(t));
      return added.length ? { risk: RISK.HIGH, reason: `要给机器人加上：${grantLabel(added)}` } : null;
    },
    parameters: {
      type: 'object',
      properties: {
        id: { type: 'string', description: 'Target bot id.' },
        name: { type: 'string', description: 'New display name.' },
        role: { type: 'string', description: 'New role line.' },
        tools: { type: 'array', items: { type: 'string' }, description: 'Replacement tool grants.' },
        skills: { type: 'array', items: { type: 'string' }, description: 'Replacement skill grants.' },
        avatar: {
          type: 'object',
          description: 'Avatar look to merge: {shape?, color?}.',
          properties: {
            shape: { type: 'string' },
            color: { type: 'string' },
          },
          additionalProperties: false,
        },
      },
      required: ['id'],
      additionalProperties: false,
    },
    async run(args, ctx) {
      if (typeof ctx.bots?.updateBot !== 'function') {
        throw toolError('BOTS_API_UNAVAILABLE', 'this runtime cannot update bots');
      }
      const id = String(args?.id ?? '').trim();
      if (!id) throw toolError('BOT_INVALID', 'id is required');

      const patch = {};
      if (args?.name !== undefined) patch.name = String(args.name);
      if (args?.role !== undefined) patch.role = String(args.role);
      if (args?.tools !== undefined) patch.tools = Array.isArray(args.tools) ? args.tools.map(String) : [];
      if (args?.skills !== undefined) patch.skills = Array.isArray(args.skills) ? args.skills.map(String) : [];
      if (args?.avatar !== undefined && typeof args.avatar === 'object' && args.avatar !== null) patch.avatar = args.avatar;
      if (!Object.keys(patch).length) {
        throw toolError('BOT_NOTHING_TO_UPDATE', 'nothing to change: pass name, role, tools, skills or avatar');
      }

      const updated = await ctx.bots.updateBot(id, patch);
      return {
        updated: true,
        bot: {
          id: updated.id,
          name: updated.name,
          role: updated.role,
          tools: updated.tools,
          skills: updated.skills,
          avatar: updated.avatar,
        },
      };
    },
  });

  add({
    name: 'bot_delete',
    description:
      'Delete a teammate bot permanently. Its transcript and its seats in group chats are removed; its memory file stays on disk. The primary bot cannot be deleted. This is HIGH risk and always asks a human first.',
    risk: RISK.HIGH,
    parameters: {
      type: 'object',
      properties: { id: { type: 'string', description: 'Bot id to delete.' } },
      required: ['id'],
      additionalProperties: false,
    },
    async run(args, ctx) {
      if (typeof ctx.bots?.deleteBot !== 'function') {
        throw toolError('BOTS_API_UNAVAILABLE', 'this runtime cannot delete bots');
      }
      const id = String(args?.id ?? '').trim();
      if (!id) throw toolError('BOT_INVALID', 'id is required');

      const target = await ctx.bots.getBot(id);
      if (!target) throw toolError('BOT_NOT_FOUND', `no bot with id "${id}"`);
      if (target.primary || ctx.config?.primaryBotId === id) {
        throw toolError(
          'BOT_PRIMARY_PROTECTED',
          `"${target.name}" is the primary bot; promote another bot first, then delete this one`,
        );
      }
      if (id === ctx.bot?.id) {
        throw toolError('BOT_SELF_DELETE', 'a bot cannot delete itself; ask another bot or the human to do it');
      }

      const result = await ctx.bots.deleteBot(id, ctx.config);
      return {
        deleted: true,
        id,
        name: target.name,
        groupsRepaired: result.groupsRepaired || [],
      };
    },
  });

  // --- groups --------------------------------------------------------------

  add({
    name: 'group_create',
    description:
      'Create a group chat with 2-6 teammates and one coordinator. The coordinator is the bot that runs a turn when the human posts in the group; the others speak through group_post when it messages them.',
    risk: RISK.MEDIUM,
    parameters: {
      type: 'object',
      properties: {
        name: { type: 'string', description: 'Group name, shown to the human.' },
        members: {
          type: 'array',
          items: { type: 'string' },
          description: '2-6 members, by bot id or display name. A bot on another machine: "name@machine" (see bot_list otherMachines).',
        },
        coordinator: { type: 'string', description: 'Bot id or name that runs the group turns. Defaults to the first member.' },
      },
      required: ['name', 'members'],
      additionalProperties: false,
    },
    async run(args, ctx) {
      if (typeof ctx.groups?.createGroup !== 'function') {
        throw toolError('GROUPS_UNAVAILABLE', 'this runtime has no group store');
      }
      const bots = await ctx.bots.listBots();
      const resolve = (ref) => {
        const key = String(ref ?? '').trim().toLowerCase();
        if (!key) return null;
        return bots.find((b) => b.id.toLowerCase() === key || b.name.toLowerCase() === key) || null;
      };

      // Size first: passing one member should read as "too few members", even if
      // that member does not exist yet.
      const rawMembers = Array.isArray(args?.members) ? args.members : [];
      if (typeof ctx.groups.assertMemberCount === 'function' && typeof ctx.groups.normalizeMemberIds === 'function') {
        ctx.groups.assertMemberCount(ctx.groups.normalizeMemberIds(rawMembers));
      }

      const members = [];
      const unknown = [];
      const remotes = {};
      const peers = typeof deps.getPeers === 'function' ? deps.getPeers() : null;
      for (const ref of Array.isArray(args?.members) ? args.members : []) {
        const bot = isRemoteMember(ref) ? null : resolve(ref);
        // Not here: maybe a bot on one of the human's other machines.
        const far = bot ? null : await resolveRemoteMember(peers, ref);
        if (bot) { if (!members.includes(bot.id)) members.push(bot.id); }
        else if (far) { if (!members.includes(far.id)) members.push(far.id); remotes[far.id] = far.info; }
        else unknown.push(String(ref));
      }
      if (unknown.length) throw toolError('GROUP_UNKNOWN_MEMBER', `no bot matches: ${unknown.join(', ')}`);

      let coordinatorId;
      if (args?.coordinator !== undefined && String(args.coordinator).trim() !== '') {
        const bot = resolve(args.coordinator);
        if (!bot) throw toolError('GROUP_UNKNOWN_MEMBER', `no bot matches "${args.coordinator}"`);
        coordinatorId = bot.id;
      }

      const group = await ctx.groups.createGroup({ name: args?.name, members, coordinatorId, remotes });
      // Members introduce themselves in the new group once this turn has moved on.
      setTimeout(() => {
        try { deps.getRuntime()?.kickoffGroup?.(group.id)?.catch?.(() => {}); } catch { /* no runtime in unit tests */ }
      }, 0);
      return {
        created: true,
        group: {
          id: group.id,
          name: group.name,
          members: group.members,
          coordinatorId: group.coordinatorId,
        },
      };
    },
  });

  add({
    name: 'group_post',
    description:
      'Say something in a group chat. Every message posted here is shown to the human and to all group members, so keep it short and useful.',
    risk: RISK.LOW,
    parameters: {
      type: 'object',
      properties: {
        group: { type: 'string', description: 'Group id.' },
        text: { type: 'string', description: 'What to say in the group, in one short message.' },
      },
      required: ['group', 'text'],
      additionalProperties: false,
    },
    async run(args, ctx) {
      if (typeof ctx.groups?.appendGroupMessage !== 'function') {
        throw toolError('GROUPS_UNAVAILABLE', 'this runtime has no group store');
      }
      const groupId = String(args?.group ?? '').trim();
      const text = String(args?.text ?? '').trim();
      if (!groupId) throw toolError('GROUP_REQUIRED', 'group id is required');
      if (!text) throw toolError('EMPTY_MESSAGE', 'text is required');
      if (text.length > 8000) throw toolError('MESSAGE_TOO_LONG', 'a group message is limited to 8000 characters');

      const group = await ctx.groups.getGroup(groupId);
      if (!group) throw toolError('GROUP_NOT_FOUND', `no group with id "${groupId}"`);
      if (!group.members.includes(ctx.bot.id)) {
        throw toolError('GROUP_MEMBER_REQUIRED', `you are not a member of "${group.name}"`);
      }

      const message = await ctx.groups.appendGroupMessage(group.id, {
        kind: 'assistant',
        from: ctx.bot.id,
        text,
        turnId: ctx.turnId,
      });
      // Push it to open group streams immediately; the transcript is the source
      // of truth, this is just the live view.
      ctx.emit({ type: 'group.message', groupId: group.id, message: ctx.groups.publicGroupMessage(message) });
      return { posted: true, groupId: group.id, groupName: group.name, messageId: message.id };
    },
  });

  add({
    name: 'group_list',
    description: 'List every group chat with its members, coordinator and last update time.',
    risk: RISK.LOW,
    parameters: { type: 'object', properties: {}, additionalProperties: false },
    async run(_args, ctx) {
      if (typeof ctx.groups?.listGroups !== 'function') {
        throw toolError('GROUPS_UNAVAILABLE', 'this runtime has no group store');
      }
      const list = await ctx.groups.listGroups();
      const bots = await ctx.bots.listBots();
      const nameOf = (id) => bots.find((b) => b.id === id)?.name || id;
      return {
        count: list.length,
        groups: list.map((g) => ({
          id: g.id,
          name: g.name,
          members: g.members.map(nameOf),
          coordinator: nameOf(g.coordinatorId),
          updatedAt: g.updatedAt,
        })),
      };
    },
  });

  add({
    name: 'group_update',
    description:
      'Rename a group, replace its member list, or choose a new coordinator. Pass only what should change. Members are bot ids or display names.',
    risk: RISK.MEDIUM,
    parameters: {
      type: 'object',
      properties: {
        group: { type: 'string', description: 'Group id.' },
        name: { type: 'string', description: 'New group name.' },
        members: { type: 'array', items: { type: 'string' }, description: 'New member list (2-6).' },
        coordinator: { type: 'string', description: 'Bot id or name that runs group turns.' },
      },
      required: ['group'],
      additionalProperties: false,
    },
    async run(args, ctx) {
      if (typeof ctx.groups?.updateGroup !== 'function') {
        throw toolError('GROUPS_UNAVAILABLE', 'this runtime has no group store');
      }
      const groupId = String(args?.group ?? '').trim();
      const current = await ctx.groups.getGroup(groupId);
      if (!current) throw toolError('GROUP_NOT_FOUND', `no group with id "${groupId}"`);

      const bots = await ctx.bots.listBots();
      const resolve = (ref) => {
        const key = String(ref ?? '').trim().toLowerCase();
        if (!key) return null;
        return bots.find((b) => b.id.toLowerCase() === key || b.name.toLowerCase() === key) || null;
      };

      const patch = {};
      if (args?.name !== undefined) patch.name = args.name;
      if (args?.members !== undefined) {
        const rawMembers = Array.isArray(args.members) ? args.members : [];
        if (typeof ctx.groups.assertMemberCount === 'function' && typeof ctx.groups.normalizeMemberIds === 'function') {
          ctx.groups.assertMemberCount(ctx.groups.normalizeMemberIds(rawMembers));
        }
        const members = [];
        const unknown = [];
        const remotes = {};
        const peers = typeof deps.getPeers === 'function' ? deps.getPeers() : null;
        for (const ref of rawMembers) {
          const bot = isRemoteMember(ref) ? null : resolve(ref);
          const kept = current?.remotes?.[ref];
          const far = bot ? null : (kept ? { id: ref, info: kept } : await resolveRemoteMember(peers, ref));
          if (bot) { if (!members.includes(bot.id)) members.push(bot.id); }
          else if (far) { if (!members.includes(far.id)) members.push(far.id); remotes[far.id] = far.info; }
          else unknown.push(String(ref));
        }
        if (unknown.length) throw toolError('GROUP_UNKNOWN_MEMBER', `no bot matches: ${unknown.join(', ')}`);
        patch.members = members;
        patch.remotes = remotes;
      }
      if (args?.coordinator !== undefined && String(args.coordinator).trim() !== '') {
        const bot = resolve(args.coordinator);
        if (!bot) throw toolError('GROUP_UNKNOWN_MEMBER', `no bot matches "${args.coordinator}"`);
        patch.coordinatorId = bot.id;
      }
      if (!Object.keys(patch).length) throw toolError('GROUP_PATCH_EMPTY', 'pass a new name, members or coordinator');

      const updated = await ctx.groups.updateGroup(current.id, patch);
      return {
        updated: true,
        group: {
          id: updated.id,
          name: updated.name,
          members: updated.members,
          coordinatorId: updated.coordinatorId,
        },
      };
    },
  });

  add({
    name: 'group_delete',
    description: 'Delete a group chat and its transcript. This cannot be undone. Bot memory is untouched.',
    risk: RISK.MEDIUM,
    parameters: {
      type: 'object',
      properties: { group: { type: 'string', description: 'Group id.' } },
      required: ['group'],
      additionalProperties: false,
    },
    async run(args, ctx) {
      if (typeof ctx.groups?.deleteGroup !== 'function') {
        throw toolError('GROUPS_UNAVAILABLE', 'this runtime has no group store');
      }
      const groupId = String(args?.group ?? '').trim();
      if (!groupId) throw toolError('GROUP_REQUIRED', 'group id is required');
      const removed = await ctx.groups.deleteGroup(groupId);
      return { deleted: true, id: removed.id, name: removed.name };
    },
  });

  // --- product settings (primary bot only) --------------------------------
  // These tools change the same state as the Settings dialog. They are granted
  // to the primary bot; the approval layer still sees every call.

  add({
    name: 'settings_get',
    description: 'Read the app settings: model provider, endpoint, model name, API key presence, and timezone.',
    risk: RISK.LOW,
    parameters: { type: 'object', properties: {}, additionalProperties: false },
    async run(_args, ctx) {
      if (!ctx.app?.settingsView) throw toolError('APP_UNAVAILABLE', 'settings are not available in this runtime');
      return ctx.app.settingsView();
    },
  });

  add({
    name: 'settings_update',
    description:
      'Change model settings or the app timezone. Pass only what should change. provider is "mock" or "openai"; baseUrl is the OpenAI-compatible endpoint; apiKey is write-only. timezone is an IANA name such as Asia/Shanghai, or "" to unset.',
    risk: RISK.MEDIUM,
    parameters: {
      type: 'object',
      properties: {
        provider: { type: 'string', enum: ['mock', 'openai'] },
        baseUrl: { type: 'string', description: 'OpenAI-compatible base URL, e.g. https://api.deepseek.com/v1' },
        model: { type: 'string', description: 'Model name, e.g. deepseek-chat' },
        apiKey: { type: 'string', description: 'API key. Write-only; never echoed back.' },
        timezone: { type: 'string', description: 'IANA timezone, or "" to unset.' },
      },
      additionalProperties: false,
    },
    async run(args, ctx) {
      if (!ctx.app?.updateSettings) throw toolError('APP_UNAVAILABLE', 'settings are not available in this runtime');
      const patch = {};
      for (const key of ['provider', 'baseUrl', 'model', 'apiKey', 'timezone']) {
        if (args?.[key] !== undefined) patch[key] = args[key];
      }
      if (!Object.keys(patch).length) throw toolError('SETTINGS_EMPTY', 'pass at least one setting');
      await ctx.app.updateSettings(patch);
      // A timezone change is also a visible UI change; keep the open window in
      // step instead of letting the Settings panel disagree with the server.
      if (patch.timezone !== undefined) {
        ctx.app.applyUi(patch.timezone
          ? { timezoneMode: 'manual', timezone: patch.timezone }
          : { timezoneMode: 'local' });
      }
      return ctx.app.settingsView();
    },
  });

  add({
    name: 'ui_get',
    description:
      'Read the current UI state the human sees: theme, timezone mode/zone, which machine is selected for remote control, and whether the side panel is open.',
    risk: RISK.LOW,
    parameters: { type: 'object', properties: {}, additionalProperties: false },
    async run(_args, ctx) {
      if (!ctx.app?.uiView) throw toolError('APP_UNAVAILABLE', 'UI state is not available in this runtime');
      return ctx.app.uiView();
    },
  });

  add({
    name: 'ui_set',
    description:
      'Change what the human sees, live in every open window. theme is dark/light/system. timezoneMode is local (this device) / target (the machine the bots run on) / manual; with manual also pass timezone (IANA). panelOpen/tab control the side panel (activity|computer|skills|routines|memory).',
    risk: RISK.LOW,
    parameters: {
      type: 'object',
      properties: {
        theme: { type: 'string', enum: ['dark', 'light', 'system'] },
        timezoneMode: { type: 'string', enum: ['local', 'target', 'manual'] },
        timezone: { type: 'string', description: 'IANA zone, used when timezoneMode is manual.' },
        panelOpen: { type: 'boolean' },
        tab: { type: 'string', enum: ['activity', 'computer', 'skills', 'routines', 'memory'] },
      },
      additionalProperties: false,
    },
    async run(args, ctx) {
      if (!ctx.app?.applyUi) throw toolError('APP_UNAVAILABLE', 'UI state is not available in this runtime');
      const patch = {};
      for (const key of ['theme', 'timezoneMode', 'timezone', 'panelOpen', 'tab']) {
        if (args?.[key] !== undefined) patch[key] = args[key];
      }
      if (!Object.keys(patch).length) throw toolError('UI_PATCH_EMPTY', 'pass at least one UI setting');
      return ctx.app.applyUi(patch, { by: ctx.bot?.id });
    },
  });

  // --- machines -----------------------------------------------------------
  // The machine list lives in the human's desktop app; the window reports it.

  add({
    name: 'machine_list',
    description: 'List the machines the human can switch between (from their desktop app): name, address, and which one this chat is on. Each machine has its own bots.',
    risk: RISK.LOW,
    parameters: { type: 'object', properties: {}, additionalProperties: false },
    async run(_args, ctx) {
      const ui = ctx.app?.uiView?.() || {};
      const machines = ui.machines || [];
      if (!machines.length) {
        return { machines: [], note: 'No machine list: the human is not in the desktop app, or it has not reported yet. Ask them to switch machines from the top-left of the window.' };
      }
      return { machines, current: ui.machine || null };
    },
  });

  add({
    name: 'machine_switch',
    description: 'Move work to another machine: switch the human\'s window to it and hand the task to that machine\'s primary bot, which then does it there. Use this instead of SSH when the human asks for something on another of their machines. machine is a name or address from machine_list; task is the full instruction for the bot over there (it does not see this conversation).',
    risk: RISK.MEDIUM,
    parameters: {
      type: 'object',
      properties: {
        machine: { type: 'string', description: 'Machine name or address from machine_list.' },
        task: { type: 'string', description: 'Complete instruction for that machine\'s assistant.' },
      },
      required: ['machine'],
      additionalProperties: false,
    },
    async run(args, ctx) {
      if (!ctx.app?.applyUi) throw toolError('APP_UNAVAILABLE', 'the window is not connected');
      const machines = ctx.app.uiView?.().machines || [];
      const wanted = String(args?.machine || '').trim().toLowerCase();
      const match = machines.find((m) => m.name.toLowerCase() === wanted || m.url.toLowerCase() === wanted)
        || machines.find((m) => m.name.toLowerCase().includes(wanted) || m.url.toLowerCase().includes(wanted));
      if (!match) {
        throw toolError('MACHINE_NOT_FOUND', `no machine "${args?.machine}"; known: ${machines.map((m) => m.name).join(', ') || 'none reported'}`);
      }
      if (match.current) return { ok: true, machine: match.name, note: 'already on this machine; do the task here' };
      ctx.app.applyUi({ switchMachine: { target: match.url, message: String(args?.task || '') } }, { by: ctx.bot?.id });
      return { ok: true, machine: match.name, handedOff: Boolean(args?.task) };
    },
  });

  // --- control ------------------------------------------------------------

  add({
    name: 'task_finish',
    description: 'Declare the task complete. If you have not already written your answer this step, the summary IS what the human reads: give the result itself (the key content, the file paths or page where it is), not just "done".',
    risk: RISK.LOW,
    parameters: {
      type: 'object',
      properties: { summary: { type: 'string', description: 'The result for the human: what was made or changed, the key content, and where it is (paths). Short, but never just "done".' } },
      required: ['summary'],
      additionalProperties: false,
    },
    async run(args) {
      return { finished: true, summary: String(args?.summary || 'Done.') };
    },
  });

  // --- registry surface ---------------------------------------------------

  // --- connected apps (MCP), past the per-request tool limit ----------------
  // Model APIs take at most 128 tools a request; one app can bring 80. Past
  // MAX_DIRECT_TOOLS the rest are reached through these two (the agent turns
  // mcp_call into the real tool before checking it, so approvals are the same).
  add({
    name: 'mcp_find_tools',
    description: 'Find tools of the connected apps (MCP) that are not in your tool list: give words for what you want to do (e.g. "notion search", "create page"). Returns tool names, what they do and their parameters; call one with mcp_call.',
    risk: RISK.LOW,
    parameters: {
      type: 'object',
      properties: {
        query: { type: 'string', description: 'What you want to do, a few words.' },
      },
      required: ['query'],
      additionalProperties: false,
    },
    async run(args, ctx) {
      let words = String(args?.query || '').toLowerCase().split(/[\s,，、]+/).filter(Boolean);
      let mine = api.grantedFor(ctx?.bot).filter((t) => t.mcp);
      // An app named in the query (「飞书 发消息」, "notion search", 「飞书消息」):
      // only that app's tools, ranked by the other words.
      const appOf = (t) => (String(t.description).match(/^［([^］]+)］/)?.[1] || '').toLowerCase();
      const apps = [...new Set(mine.map(appOf).filter(Boolean))].sort((a, b) => b.length - a.length);
      const named = new Set();
      words = words.map((w) => {
        const app = apps.find((a) => w.includes(a));
        if (!app) return w;
        named.add(app);
        return w.replace(app, '');
      }).filter(Boolean);
      if (named.size) mine = mine.filter((t) => named.has(appOf(t)));
      const score = (t) => words.reduce((n, w) => n + (t.name.toLowerCase().includes(w) ? 2 : 0) + (String(t.description).toLowerCase().includes(w) ? 1 : 0), 0);
      const hits = mine.map((t) => [score(t), t]).filter(([n]) => n > 0 || (named.size && !words.length))
        .sort((a, b) => b[0] - a[0] || Number(Boolean(b[1].mcp.readOnly)) - Number(Boolean(a[1].mcp.readOnly))).slice(0, 12).map(([, t]) => t);
      return {
        count: hits.length,
        tools: hits.map((t) => ({ name: t.name, description: String(t.description).slice(0, 400), readOnly: Boolean(t.mcp.readOnly), parameters: t.parameters })),
        ...(hits.length ? {} : { note: `no match; the connected apps have ${mine.length} tools - try other words` }),
      };
    },
  });

  add({
    name: 'mcp_call',
    description: 'Call a tool of a connected app (MCP) by its full name (mcp__...), found with mcp_find_tools. Same checks and approvals as calling it directly.',
    risk: RISK.LOW,
    parameters: {
      type: 'object',
      properties: {
        tool: { type: 'string', description: 'The full tool name, e.g. mcp__m1a2b__notion-search.' },
        arguments: { type: 'object', description: 'Its arguments, as its parameters say.' },
      },
      required: ['tool'],
      additionalProperties: false,
    },
    async run() {
      // The agent replaces this call with the tool it names before running anything.
      throw toolError('MCP_CALL_UNRESOLVED', 'mcp_call needs "tool": a full mcp__... name from mcp_find_tools');
    },
  });

  const MAX_DIRECT_TOOLS = 110;
  // Connected apps bring many tools (Notion 77, GitHub 46), and every tool's
  // schema goes out with every model call: with four apps a call carried ~62k
  // prompt tokens instead of ~14k. So app tools are on demand: a few apps' worth
  // goes direct; past that only the ones this bot used lately do, and the rest
  // are found with mcp_find_tools and called with mcp_call.
  const MCP_DIRECT_ALL = 24;
  const MCP_RECENT_MAX = 12;
  /** botId -> app tool names it used, most recent last */
  const recentMcp = new Map();

  /** This bot's tools for one request: its own, plus app tools as above. */
  function requestTools(bot) {
    const granted = api.grantedFor(bot);
    const own = granted.filter((t) => !t.mcp && t.name !== 'mcp_find_tools' && t.name !== 'mcp_call');
    const apps = granted.filter((t) => t.mcp);
    if (apps.length <= MCP_DIRECT_ALL && own.length + apps.length <= MAX_DIRECT_TOOLS) return { direct: [...own, ...apps], hidden: [] };
    const recent = new Set((recentMcp.get(bot?.id) || []).slice(-MCP_RECENT_MAX));
    const direct = apps.filter((t) => recent.has(t.name));
    const hidden = apps.filter((t) => !recent.has(t.name));
    return { direct: [...own, ...direct, tools.get('mcp_find_tools'), tools.get('mcp_call')], hidden };
  }

  const api = {
    tools,
    /** An app tool this bot just used: it goes direct in its next requests. */
    noteMcpUse(botId, name) {
      if (!botId || !String(name).startsWith('mcp__')) return;
      const list = (recentMcp.get(botId) || []).filter((n) => n !== name);
      list.push(name);
      recentMcp.set(botId, list.slice(-MCP_RECENT_MAX));
    },
    get(name) {
      return tools.get(name) || null;
    },
    all() {
      return [...tools.values()];
    },
    /**
     * Only what this bot was granted. task_finish is always available.
     *
     * Browser tools are one session capability: a bot that can open a page can
     * also snapshot/click/type it, otherwise the grant would be useless. Each
     * action still carries its own risk, so MEDIUM/HIGH still stop for a human.
     */
    grantedFor(bot) {
      return api.all().filter((t) => api.isGranted(bot, t.name));
    },
    isGranted(bot, name) {
      // Read-only and workspace-only: every bot may look at the images it is sent.
      if (name === 'task_finish' || name === 'tool_request' || name === 'page_save' || name === 'briefing_collect' || name === 'image_view' || name === 'image_generate' || name === 'video_generate' || name === 'request_takeover' || name === 'request_login' || name === 'vault_list') return true;
      // Tools of connected MCP servers: Settings → 连接应用 says which bots get them.
      if (name.startsWith('mcp__')) return Boolean(api.mcpGate?.(bot, name));
      if (name === 'mcp_find_tools' || name === 'mcp_call') return [...tools.keys()].some((n) => n.startsWith('mcp__') && api.mcpGate?.(bot, n));
      const grants = new Set(bot?.tools || []);
      if (grants.has(name)) return true;
      if (name.startsWith('browser_') && grants.has('browser_open')) return true;
      // Handing work to another machine needs moving its inputs and results.
      if ((name === 'file_send' || name === 'file_fetch') && grants.has('bot_message')) return true;
      return false;
    },
    /** OpenAI function-tool schemas for the model call. */
    schemasFor(bot) {
      return requestTools(bot).direct.map((t) => ({
        type: 'function',
        function: { name: t.name, description: t.description, parameters: t.parameters },
      }));
    },
    /** Human-readable tool list for the system prompt. */
    renderToolDigest(bot) {
      const { direct, hidden } = requestTools(bot);
      // One line per app (its name, how many tools, a few of them), not one per tool.
      const byApp = new Map();
      for (const t of hidden) {
        const app = String(t.description).match(/^［([^］]+)］/)?.[1] || 'app';
        if (!byApp.has(app)) byApp.set(app, []);
        byApp.get(app).push(t.mcp?.tool || t.name);
      }
      const more = byApp.size
        ? `\n- Connected apps (find a tool with mcp_find_tools, e.g. "notion search", then call it with mcp_call):\n${[...byApp].map(([app, names]) => `  - ${app}: ${names.length} tools, e.g. ${names.slice(0, 4).join(', ')}`).join('\n')}`
        : '';
      return direct
        .map((t) => {
          const risk = typeof t.risk === 'string' ? t.risk : 'LOW/HIGH depending on arguments';
          // A connected app can bring dozens of tools: one line each here; the
          // full description is in the tool schema.
          if (t.mcp) return `- ${t.name}: ${String(t.description).split(/(?<=[.。!！?？])\s/)[0].slice(0, 140)}`;
          return `- ${t.name} (${risk}): ${t.description}`;
        })
        .join('\n') + more;
    },
  };

  return api;
}

function publicRoutine(routine) {
  return {
    id: routine.id,
    botId: routine.botId,
    name: routine.name,
    instruction: routine.instruction,
    schedule: routine.schedule,
    timezone: routine.timezone,
    enabled: routine.enabled,
    lastRun: routine.lastRun,
    nextRun: routine.nextRun,
    lastStatus: routine.lastStatus,
    runs: routine.runs.slice(-5),
    onlyChanges: Boolean(routine.onlyChanges),
    pushFeishu: Boolean(routine.pushFeishu),
  };
}

export { resolvePath, isPrivateHost, runShellCommand, MAX_SHELL_OUTPUT };
