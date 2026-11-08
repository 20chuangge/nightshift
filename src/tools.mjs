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

import path from 'node:path';
import fsp from 'node:fs/promises';
import { spawn } from 'node:child_process';
import { RISK } from './approvals.mjs';
import { describeImage, imageMime } from './vision.mjs';
import { generateImages, generateVideo, submitVideo } from './media.mjs';
import { listVault, revealVault } from './vault.mjs';

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
  const inWorkspace = abs === workspaceDir || abs.startsWith(wsWithSep);
  return { abs, raw, inWorkspace, rel: path.relative(workspaceDir, abs) || '.' };
}

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

    // Never hand the model's API key to a shell command.
    const env = { ...process.env };
    delete env.ASSIST_API_KEY;

    const child = spawn(process.platform === 'win32' ? `chcp 65001 >nul & ${command}` : command, {
      shell: true,
      cwd,
      windowsHide: true,
      env,
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

    const kill = () => {
      try {
        child.kill();
      } catch {
        /* already gone */
      }
    };

    const timer = setTimeout(() => {
      timedOut = true;
      kill();
    }, Math.max(1000, Number(timeoutMs) || 30000));

    const onAbort = () => kill();
    if (signal) {
      if (signal.aborted) kill();
      else signal.addEventListener('abort', onAbort, { once: true });
    }

    child.on('error', (err) => {
      finish({ ok: false, error: { code: 'SHELL_SPAWN_FAILED', message: err.message }, stdout: text('stdout'), stderr: text('stderr'), timedOut });
    });

    child.on('close', (code, sig) => {
      if (signal) signal.removeEventListener('abort', onAbort);
      finish({
        ok: code === 0 && !timedOut,
        exitCode: code,
        signal: sig || null,
        timedOut,
        stdout: truncate(text('stdout'), maxOutput).text,
        stderr: truncate(text('stderr'), maxOutput).text,
        truncated,
        command,
        cwd,
      });
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
      'Look at an image in the workspace (an attachment the human sent, a screenshot you took) and get a description of it, including any text in it. Ask a specific question when you need something specific (e.g. "这个报错弹窗写了什么？", "表格第三列的数字"). Use it whenever the human sends an image or you need to know what a screenshot shows - you cannot see images otherwise.',
    risk: RISK.LOW,
    parameters: {
      type: 'object',
      properties: {
        path: { type: 'string', description: 'Image path relative to the workspace root, e.g. uploads/2026-11-08/a.png or artifacts/shot.png.' },
        question: { type: 'string', description: 'What you want to know about it (optional; default: describe everything and transcribe the text).' },
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
      try {
        const seen = await describeImage(service, bytes, mime, args.question);
        return { path: r.rel, model: seen.model, description: seen.text };
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
          const job = await jobs.add({ botId: ctx.bot?.id, groupId: ctx.group?.id || null, prompt: args?.prompt, task });
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

      let res;
      try {
        res = await fetch(target.href, {
          method,
          headers,
          body: method === 'POST' ? String(args?.body ?? '') : undefined,
          signal: AbortSignal.timeout(20000),
          redirect: 'follow',
        });
      } catch (err) {
        throw toolError('HTTP_FAILED', `request failed: ${err.message}`);
      }

      const contentType = res.headers.get('content-type') || '';
      const raw = await res.text();
      const clipped = truncate(raw, maxBytes);
      return {
        url: res.url || target.href,
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
      'Schedule a recurring instruction for a bot. schedule is a 5-field cron expression or "every N minutes"/"every N hours".',
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
    description: 'List the other bots on the team with their role and what they are allowed to do.',
    risk: RISK.LOW,
    parameters: { type: 'object', properties: {}, additionalProperties: false },
    async run(_args, ctx) {
      const bots = await ctx.bots.listBots();
      return {
        bots: bots.map((b) => ({
          id: b.id,
          name: b.name,
          role: b.role,
          primary: b.primary,
          tools: b.tools,
          isMe: b.id === ctx.bot.id,
        })),
      };
    },
  });

  add({
    name: 'bot_message',
    description:
      'Send a task to another bot and wait for its reply. This is how work is handed off: the other bot runs its own turn, with its own tools, memory and approval boundary.',
    // LOW: internal coordination between teammates that share one workspace. The
    // "sending messages always asks" rule in the reference product is about
    // outward-facing channels (email, chat to a human); there is no such tool
    // here. Hand-off depth is capped at one hop in run(), so this cannot spiral.
    risk: RISK.LOW,
    parameters: {
      type: 'object',
      properties: {
        botId: { type: 'string', description: 'Target bot id.' },
        text: { type: 'string', description: 'What you are asking them to do.' },
      },
      required: ['botId', 'text'],
      additionalProperties: false,
    },
    async run(args, ctx) {
      const targetId = String(args?.botId || '');
      if (targetId === ctx.bot.id) throw toolError('BOT_SELF_MESSAGE', 'a bot cannot message itself; just do the work');
      if ((ctx.depth || 0) >= 1) {
        throw toolError('BOT_DEPTH_EXCEEDED', 'bot-to-bot hand-off is limited to one hop to keep turns bounded');
      }
      const target = await ctx.bots.getBot(targetId);
      if (!target) throw toolError('BOT_NOT_FOUND', `no bot with id "${targetId}"`);

      const runtime = deps.getRuntime();
      const result = await runtime.runTurn({
        botId: target.id,
        text: String(args?.text || ''),
        source: 'bot',
        depth: (ctx.depth || 0) + 1,
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

  // --- roster management ---------------------------------------------------
  //
  // MEDIUM: creating a teammate or reshaping the team is a real change, so it
  // goes through the same approval boundary as other medium-risk writes. HIGH:
  // deleting a bot throws away its transcript and its group seats, so a human
  // must say yes every single time, even when the bot auto-approves medium work.

  add({
    name: 'bot_create',
    description:
      'Create a new teammate bot on this machine. It appears in the roster immediately with its own memory and its own transcript. Give it only the tools it needs; defaults to none. Name it in the language the human writes in (Chinese conversation -> a Chinese name such as 编剧 or 美术). When the human asks for a team, first list the bots you would create (name + job, keep it to the fewest that cover the work) and ask before creating more than one; create a group only if the human asks for one or agrees.',
    risk: RISK.MEDIUM,
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
        tools: Array.isArray(args?.tools) ? args.tools : [],
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
          description: '2-6 members, by bot id or display name.',
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
      for (const ref of Array.isArray(args?.members) ? args.members : []) {
        const bot = resolve(ref);
        if (!bot) unknown.push(String(ref));
        else if (!members.includes(bot.id)) members.push(bot.id);
      }
      if (unknown.length) throw toolError('GROUP_UNKNOWN_MEMBER', `no bot matches: ${unknown.join(', ')}`);

      let coordinatorId;
      if (args?.coordinator !== undefined && String(args.coordinator).trim() !== '') {
        const bot = resolve(args.coordinator);
        if (!bot) throw toolError('GROUP_UNKNOWN_MEMBER', `no bot matches "${args.coordinator}"`);
        coordinatorId = bot.id;
      }

      const group = await ctx.groups.createGroup({ name: args?.name, members, coordinatorId });
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
        for (const ref of rawMembers) {
          const bot = resolve(ref);
          if (!bot) unknown.push(String(ref));
          else if (!members.includes(bot.id)) members.push(bot.id);
        }
        if (unknown.length) throw toolError('GROUP_UNKNOWN_MEMBER', `no bot matches: ${unknown.join(', ')}`);
        patch.members = members;
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
    description: 'Declare the task complete. Provide a short summary of what you actually did.',
    risk: RISK.LOW,
    parameters: {
      type: 'object',
      properties: { summary: { type: 'string', description: 'What changed, in one or two sentences.' } },
      required: ['summary'],
      additionalProperties: false,
    },
    async run(args) {
      return { finished: true, summary: String(args?.summary || 'Done.') };
    },
  });

  // --- registry surface ---------------------------------------------------

  const api = {
    tools,
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
      if (name === 'task_finish' || name === 'image_view' || name === 'image_generate' || name === 'video_generate' || name === 'request_takeover' || name === 'request_login' || name === 'vault_list') return true;
      const grants = new Set(bot?.tools || []);
      if (grants.has(name)) return true;
      if (name.startsWith('browser_') && grants.has('browser_open')) return true;
      return false;
    },
    /** OpenAI function-tool schemas for the model call. */
    schemasFor(bot) {
      return api.grantedFor(bot).map((t) => ({
        type: 'function',
        function: { name: t.name, description: t.description, parameters: t.parameters },
      }));
    },
    /** Human-readable tool list for the system prompt. */
    renderToolDigest(bot) {
      return api
        .grantedFor(bot)
        .map((t) => {
          const risk = typeof t.risk === 'string' ? t.risk : 'LOW/HIGH depending on arguments';
          return `- ${t.name} (${risk}): ${t.description}`;
        })
        .join('\n');
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
  };
}

export { resolvePath, isPrivateHost, runShellCommand, MAX_SHELL_OUTPUT };
