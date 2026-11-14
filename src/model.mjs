/**
 * model.mjs - the only module that talks to an LLM.
 *
 * Two providers:
 *   mock   deterministic scripted planner, zero network, zero API keys.
 *          This is the default and the mode the smoke test exercises.
 *   openai any OpenAI-compatible /chat/completions endpoint (real mode is
 *          opt-in through settings or ASSIST_MODEL_PROVIDER=openai).
 *
 * The rest of the app only ever sees:
 *   model.complete(messages, { tools, signal, onDelta })
 *     -> { content, toolCalls, finishReason, usage }
 * where toolCalls is [{ id, name, arguments }] with arguments already parsed.
 *
 * Streaming: when the caller passes an `onDelta` callback the real provider
 * asks for `stream: true`, parses the SSE `data:` frames as they arrive and
 * calls `onDelta({ text })` for every content delta before the call resolves.
 * Tool-call arguments also arrive as deltas; they are re-assembled by index and
 * returned in the same final shape as the non-streaming path. The mock emits
 * the same deltas (from its scripted answer) so the whole pipeline - provider
 * to agent to SSE to the browser - is exercised offline.
 */

import fs from 'node:fs';
import path from 'node:path';
import { providerKind } from './providers.mjs';
import { createAnthropicClient } from './anthropic.mjs';

const DEFAULT_BASE_URL = 'https://api.openai.com/v1';
const DEFAULT_MODEL = 'gpt-4o-mini';

/**
 * Opt-in wire capture: ASSIST_DEBUG_WIRE=1 appends every request and response
 * summary to <data>/wire.jsonl. Provider quirks (reasoning fields, tool-call
 * shapes) are impossible to diagnose from the outside, so this is the cheap
 * version of a packet capture. Never enabled by default.
 */
function debugWire(entry) {
  if (!process.env.ASSIST_DEBUG_WIRE) return;
  try {
    const dir = env('ASSIST_DATA_DIR', path.resolve(process.cwd(), 'data'));
    fs.mkdirSync(dir, { recursive: true });
    fs.appendFileSync(path.join(dir, 'wire.jsonl'), `${JSON.stringify({ ts: Date.now(), ...entry })}\n`);
  } catch {
    /* debugging must never break a turn */
  }
}

function env(name, fallback = '') {
  const v = process.env[name];
  return v === undefined || v === '' ? fallback : v;
}

// ---------------------------------------------------------------------------
// Public factory
// ---------------------------------------------------------------------------

export function createModel({ provider, baseUrl, apiKey, model, timeoutMs } = {}) {
  const chosen = (provider || env('ASSIST_MODEL_PROVIDER', 'mock')).toLowerCase();
  const cfg = {
    provider: chosen,
    baseUrl: baseUrl || env('ASSIST_BASE_URL', DEFAULT_BASE_URL).replace(/\/+$/, ''),
    apiKey: apiKey || env('ASSIST_API_KEY', ''),
    model: model || env('ASSIST_MODEL', DEFAULT_MODEL),
    timeoutMs: timeoutMs || Number(env('ASSIST_MODEL_TIMEOUT_MS', '120000')),
  };

  if (chosen === 'mock') {
    return {
      ...cfg,
      // There is no model behind the mock; label it as what it is.
      model: 'scripted-planner',
      /** No tools needed: the mock reads keywords out of the transcript. */
      async complete(messages, opts = {}) {
        const result = mockComplete(messages);
        await emitMockDeltas(result.content, opts.onDelta);
        // A deterministic stand-in so the cost ledger has real numbers to add
        // up in tests and demos (roughly four characters per token).
        const promptTokens = Math.max(12, Math.ceil(messages.reduce((n, m) => n + String(m.content ?? '').length, 0) / 4));
        const completionTokens = Math.max(6, Math.ceil(String(result.content || '').length / 4));
        return {
          ...result,
          usage: { prompt_tokens: promptTokens, completion_tokens: completionTokens, total_tokens: promptTokens + completionTokens },
        };
      },
    };
  }

  // The provider catalogue decides the wire format: Claude speaks its own
  // protocol, everything else (/including unknown/custom names/) is assumed to
  // be OpenAI-compatible, which is what nearly every gateway exposes.
  const kind = providerKind(chosen);
  if (kind === 'anthropic') {
    return createAnthropicClient({ baseUrl: cfg.baseUrl, apiKey: cfg.apiKey, model: cfg.model, timeoutMs: cfg.timeoutMs });
  }

  return {
    ...cfg,
    async complete(messages, opts = {}) {
      return openAiComplete(cfg, messages, opts);
    },
  };
}

// ---------------------------------------------------------------------------
// Deltas
// ---------------------------------------------------------------------------

/**
 * Call the caller-supplied delta sink. A broken sink must never kill a turn
 * (the agent's sink emits on the event bus, which is already defensive; this is
 * belt and braces for anyone embedding the model client).
 */
function emitDelta(onDelta, text) {
  if (typeof onDelta !== 'function' || !text) return;
  try {
    onDelta({ text });
  } catch {
    /* ignore a broken consumer */
  }
}

function chunkText(text, size = 24) {
  const out = [];
  for (let i = 0; i < text.length; i += size) out.push(text.slice(i, i + size));
  return out;
}

/**
 * The mock streams its answer the same way a real provider would: several
 * deltas in order, yielding to the event loop between them so the SSE writes
 * actually flush between chunks. The smoke test asserts the ordering.
 */
async function emitMockDeltas(content, onDelta) {
  if (typeof onDelta !== 'function' || !content) return;
  for (const chunk of chunkText(String(content))) {
    emitDelta(onDelta, chunk);
    await new Promise((resolve) => setImmediate(resolve));
  }
}

// ---------------------------------------------------------------------------
// Real provider: OpenAI-compatible chat completions
// ---------------------------------------------------------------------------

function toWireMessages(messages) {
  return messages.map((m) => {
    if (m.role === 'assistant') {
      const out = { role: 'assistant', content: m.content || null };
      if (Array.isArray(m.tool_calls) && m.tool_calls.length) out.tool_calls = m.tool_calls;
      // DeepSeek (and other "thinking" models) require the assistant's
      // reasoning_content to be echoed back on the next request that follows a
      // tool result. Dropping it earns a 400:
      //   "The `reasoning_content` in the thinking mode must be passed back to the API."
      // We only ever carry this field when the provider produced one, so plain
      // OpenAI-compatible endpoints never see an unknown key.
      if (typeof m.reasoning_content === 'string' && m.reasoning_content) {
        out.reasoning_content = m.reasoning_content;
      }
      return out;
    }
    if (m.role === 'tool') {
      return { role: 'tool', tool_call_id: m.tool_call_id, content: String(m.content ?? '') };
    }
    return { role: m.role, content: typeof m.content === 'string' ? m.content : JSON.stringify(m.content ?? '') };
  });
}

async function openAiComplete(cfg, messages, opts = {}) {
  if (!cfg.apiKey) {
    throw new Error('ASSIST_API_KEY is required when ASSIST_MODEL_PROVIDER=openai');
  }

  const { tools, temperature = 0.2, maxTokens = 4096 } = opts;
  const body = {
    model: cfg.model,
    messages: toWireMessages(messages),
    temperature,
    max_tokens: maxTokens,
  };
  debugWire({ kind: 'request', model: cfg.model, messages: body.messages, tools: (tools || []).map((t) => t.function?.name) });
  if (tools && tools.length) {
    body.tools = tools;
    body.tool_choice = 'auto';
  }

  // Streaming is not a mode flag the app stores: it is simply "did the caller
  // ask for deltas?". That keeps one code path for callers that only want the
  // final message (e.g. the settings connection test).
  if (typeof opts.onDelta === 'function') {
    return openAiStream(cfg, body, opts);
  }
  return openAiJson(cfg, body, opts);
}

function requestSignal(cfg, signal, timeoutMs) {
  const timeout = AbortSignal.timeout(Number(timeoutMs) || cfg.timeoutMs);
  // AbortSignal.any landed in Node 20.3; fall back to the plain timeout on
  // 20.0-20.2 so an early-20 runtime still works.
  return signal && typeof AbortSignal.any === 'function' ? AbortSignal.any([signal, timeout]) : timeout;
}

/** Provider hiccups worth another try: rate limits and server-side errors. */
const RETRY_STATUS = new Set([429, 500, 502, 503, 504, 529]);
const RETRY_DELAYS_MS = [1500, 4000];

async function postChat(cfg, body, composed, { stream }) {
  // Retries happen before any reply byte is read, so a stream never repeats.
  for (let attempt = 0; ; attempt += 1) {
    const canRetry = attempt < RETRY_DELAYS_MS.length && !composed?.aborted;
    let res;
    try {
      res = await fetch(`${cfg.baseUrl}/chat/completions`, {
        method: 'POST',
        headers: {
          'content-type': 'application/json',
          accept: stream ? 'text/event-stream' : 'application/json',
          authorization: `Bearer ${cfg.apiKey}`,
        },
        body: JSON.stringify(body),
        signal: composed,
      });
    } catch (err) {
      if (canRetry && !composed?.aborted) {
        await waitFor(RETRY_DELAYS_MS[attempt], composed);
        continue;
      }
      // Surface a model error the agent loop can report instead of crashing a turn.
      throw new Error(`model request failed: ${err.message}`);
    }

    if (res.ok) return res;
    const text = await res.text().catch(() => '');
    if (canRetry && RETRY_STATUS.has(res.status)) {
      await waitFor(RETRY_DELAYS_MS[attempt], composed);
      continue;
    }
    throw new Error(`model HTTP ${res.status}: ${text.slice(0, 400)}`);
  }
}

function waitFor(ms, signal) {
  return new Promise((resolve) => {
    const timer = setTimeout(resolve, ms);
    signal?.addEventListener?.('abort', () => { clearTimeout(timer); resolve(); }, { once: true });
  });
}

/** Non-streaming `/chat/completions` (kept for compatibility and for tests). */
async function openAiJson(cfg, body, { signal, timeoutMs } = {}) {
  const res = await postChat(cfg, body, requestSignal(cfg, signal, timeoutMs), { stream: false });
  const json = await res.json();
  const choice = json?.choices?.[0] || {};
  const msg = choice.message || {};
  const toolCalls = (msg.tool_calls || []).map((call) => ({
    id: call.id || `call_${Math.random().toString(36).slice(2, 10)}`,
    name: call.function?.name || '',
    arguments: toolArgs(call.function?.arguments),
  }));

  return {
    content: typeof msg.content === 'string' ? msg.content : '',
    toolCalls,
    reasoningContent: typeof msg.reasoning_content === 'string' ? msg.reasoning_content : '',
    finishReason: choice.finish_reason || 'stop',
    usage: json.usage || null,
  };
}

/**
 * True streaming: POST with `stream: true`, read the body as it arrives and
 * turn each SSE line into a delta.
 *
 * What the wire actually looks like (OpenAI-compatible):
 *   data: {"choices":[{"index":0,"delta":{"role":"assistant"}}]}
 *   data: {"choices":[{"index":0,"delta":{"content":"Hel"}}]}
 *   data: {"choices":[{"index":0,"delta":{"tool_calls":[{"index":0,"id":"call_1",
 *            "type":"function","function":{"name":"fs_list","arguments":""}}]}}]}
 *   data: {"choices":[{"index":0,"delta":{"tool_calls":[{"index":0,
 *            "function":{"arguments":"{\"path\":"}}]}}]}
 *   data: {"choices":[{"index":0,"delta":{},"finish_reason":"tool_calls"}]}
 *   data: [DONE]
 *
 * Notes on the parser: SSE accepts CRLF or LF, and one frame can be split
 * across TCP chunks (or several frames can arrive in one chunk), so we buffer
 * bytes and parse complete lines. TextDecoder with stream:true keeps multi-byte
 * UTF-8 characters whole when a chunk boundary falls inside one.
 */
async function openAiStream(cfg, body, { signal, timeoutMs, onDelta }) {
  const res = await postChat(
    cfg,
    { ...body, stream: true },
    requestSignal(cfg, signal, timeoutMs),
    { stream: true },
  );

  if (!res.body) throw new Error('model response had no body');

  const reader = res.body.getReader();
  const decoder = new TextDecoder();
  let buffer = '';
  let content = '';
  let reasoning = ''; // DeepSeek thinking models: delta.reasoning_content
  let finishReason = 'stop';
  let usage = null;
  const calls = new Map(); // index -> {id, name, arguments}
  let sawDone = false;

  const handleData = (payload) => {
    const trimmed = payload.trim();
    if (!trimmed) return;
    if (trimmed === '[DONE]') {
      sawDone = true;
      return;
    }
    let json;
    try {
      json = JSON.parse(trimmed);
    } catch {
      // A provider that emits non-JSON keep-alive text must not break the turn.
      return;
    }
    if (json?.error) {
      throw new Error(`model stream error: ${json.error.message || JSON.stringify(json.error)}`);
    }
    if (json?.usage) usage = json.usage;
    const choice = json?.choices?.[0];
    if (!choice) return;
    const delta = choice.delta || {};

    // Thinking models stream the chain of thought before the answer. It is not
    // shown to the user, but it must be kept: the next request has to echo it
    // back when a tool call was involved.
    if (typeof delta.reasoning_content === 'string' && delta.reasoning_content) {
      reasoning += delta.reasoning_content;
    } else if (typeof delta.reasoning === 'string' && delta.reasoning) {
      reasoning += delta.reasoning;
    }

    if (typeof delta.content === 'string' && delta.content) {
      content += delta.content;
      emitDelta(onDelta, delta.content);
    }

    if (Array.isArray(delta.tool_calls)) {
      for (const part of delta.tool_calls) {
        const index = Number.isInteger(part.index) ? part.index : 0;
        const entry = calls.get(index) || { id: '', name: '', arguments: '' };
        if (part.id) entry.id = part.id;
        if (part.function?.name) entry.name = part.function.name;
        if (typeof part.function?.arguments === 'string') {
          // Arguments arrive in fragments; concatenate in order.
          entry.arguments += part.function.arguments;
        }
        calls.set(index, entry);
      }
    }

    if (choice.finish_reason) finishReason = choice.finish_reason;
  };

  const pumpLines = () => {
    let newline;
    while ((newline = buffer.indexOf('\n')) !== -1) {
      const line = buffer.slice(0, newline).replace(/\r$/, '');
      buffer = buffer.slice(newline + 1);
      if (!line.startsWith('data:')) continue; // comment / event: / heartbeat
      handleData(line.slice(5));
    }
  };

  try {
    while (!sawDone) {
      const { value, done } = await reader.read();
      if (done) break;
      buffer += decoder.decode(value, { stream: true });
      pumpLines();
    }
    // Flush a trailing frame that had no final newline and any buffered UTF-8.
    buffer += decoder.decode();
    pumpLines();
    if (buffer.startsWith('data:')) handleData(buffer.slice(5));
  } catch (err) {
    // Preserve the abort/type so the agent can report it, but keep the prefix
    // consistent with the non-streaming path.
    throw err instanceof Error && /^model /.test(err.message)
      ? err
      : new Error(`model stream failed: ${err.message}`);
  } finally {
    try {
      await reader.cancel();
    } catch {
      /* already closed */
    }
  }

  const toolCalls = [...calls.entries()]
    .sort((a, b) => a[0] - b[0])
    .map(([index, entry]) => ({
      id: entry.id || `call_${index}`,
      name: entry.name || '',
      arguments: toolArgs(entry.arguments),
    }))
    .filter((call) => call.name);

  debugWire({
    kind: 'stream-result',
    content: content.slice(0, 200),
    contentLength: content.length,
    reasoningLength: reasoning.length,
    reasoningHead: reasoning.slice(0, 120),
    toolCalls: toolCalls.map((call) => call.name),
    finishReason,
  });
  return { content, toolCalls, reasoningContent: reasoning, finishReason, usage };
}

/**
 * A tool call's arguments. When the text does not parse - the model ran out of
 * output and the JSON was cut off - say so instead of passing {} (which made a
 * long page arrive "empty" and the bot retry the same thing).
 */
export function toolArgs(raw) {
  if (raw && typeof raw === 'object') return raw;
  if (typeof raw !== 'string' || !raw.trim()) return {};
  try {
    const v = JSON.parse(raw);
    return v && typeof v === 'object' ? v : {};
  } catch {
    return { __truncated: true, __length: raw.length };
  }
}

function safeParseJson(raw, fallback) {
  if (raw && typeof raw === 'object') return raw;
  if (typeof raw !== 'string' || !raw.trim()) return fallback;
  try {
    return JSON.parse(raw);
  } catch {
    return fallback;
  }
}

// ---------------------------------------------------------------------------
// Mock provider - a scripted planner, not a language model
// ---------------------------------------------------------------------------

/**
 * The mock plays a fixed "plan" per intent. It works out which step of the
 * plan it is on by counting tool results that arrived after the last user
 * message, which is exactly the information a real model would get from the
 * transcript. Deterministic by construction: same transcript, same next call.
 *
 * Intents are ordered; the first match wins. The plans deliberately avoid
 * anything that needs the network so the whole demo works offline.
 */

const INTENTS = [
  { id: 'handoff', re: /\b(hand\s?off|delegate to|ask the (researcher|ops)|message the|send (it )?to the)\b/i },
  { id: 'routine', re: /\b(routine|schedule|recurr|every \d+ (minutes?|hours?)|cron)\b/i },
  { id: 'skill', re: /(\bsave\b.{0,30}\bskill\b)|(\bas a skill\b)|(\bskill\b.{0,20}\bsave\b)/i },
  { id: 'outside', re: /\b(outside (of )?the workspace|beyond the workspace|external file|wherever you like)\b/i },
  { id: 'shell', re: /\b(shell|terminal|run (the )?command|execute (a )?command|\bcmd\b)\b|(运行|执行|跑)[^。，,]{0,6}(命令|指令)|命令行/i },
  { id: 'memory', re: /\b(remember|memory|memorise|memorize|note that|keep in mind)\b|记住|记一下|别忘了/i },
  { id: 'read', re: /\b(read|open|cat|show me)\b.{0,40}(file|welcome|readme|note)|(读|打开)[^。，,]{0,10}(文件|welcome|readme|笔记)/i },
  { id: 'files', re: /\b(list|ls\b|what'?s in|workspace|directory|folder)\b|工作区|(列出|有哪些)[^。，,]{0,8}文件/i },
];

function detectIntent(text) {
  for (const intent of INTENTS) {
    if (intent.re.test(text)) return intent.id;
  }
  return 'chat';
}

/** Pull "every 30 minutes" or a raw five-field cron expression out of free text. */
function extractSchedule(text) {
  const interval = text.match(/every\s+(\d+)\s*(minutes?|hours?)/i);
  if (interval) {
    const unit = interval[2].toLowerCase().startsWith('h') ? 'hours' : 'minutes';
    return `every ${interval[1]} ${unit}`;
  }
  const cron = text.match(/((?:\*|\d+(?:[-,/]\d+)*)\s+){4}(?:\*|\d+(?:[-,/]\d+)*)/);
  if (cron) return cron[0].replace(/\s+/g, ' ').trim();
  return 'every 30 minutes';
}

function extractSkillName(text) {
  // "save this as a skill called inbox-triage: ..." -> "inbox-triage"
  const match = text.match(/skill\s*(?:called|named|:)?\s*["“']?([a-z0-9][a-z0-9 _-]{0,60})/i);
  if (!match) return 'workspace-sweep';
  const cleaned = match[1]
    .split(/[:.,\n]/)[0]
    .trim()
    .split(/\s+/)
    .slice(0, 4)
    .join(' ');
  return cleaned.length >= 3 ? cleaned : 'workspace-sweep';
}

function extractFileName(text) {
  const match = text.match(/([a-zA-Z0-9._/-]+\.(?:md|txt|json|mjs|js|csv|log))/);
  return match ? match[1] : 'welcome.md';
}

function extractBotId(text) {
  const match = text.match(/\b(researcher|ops|chief)\b/i);
  return match ? match[1].toLowerCase() : 'researcher';
}

/** One-line summary the model would have produced, used as the turn's answer. */
function shortQuote(text, max = 90) {
  const oneLine = text.replace(/\s+/g, ' ').trim();
  return oneLine.length > max ? `${oneLine.slice(0, max - 1)}...` : oneLine;
}

/**
 * Build the plan for an intent. Each step is either
 *   { tool, args }            -> ask the runtime to call a tool
 *   { content }               -> plain assistant text, ends the turn
 */
function mockPlan(text, botName) {
  const intent = detectIntent(text);
  // A Chinese message gets Chinese words back (BUG-04: a new user's first sight was English).
  const zh = /[\u4e00-\u9fff]/.test(String(text || ''));
  const say = (cn, en) => (zh ? cn : en);

  switch (intent) {
    case 'handoff':
      return [
        {
          tool: 'bot_message',
          args: {
            botId: extractBotId(text),
            text: 'Quick task: read welcome.md in the shared workspace and reply with the three most important lines.',
          },
        },
        {
          tool: 'task_finish',
          args: { summary: `Handed the task to ${extractBotId(text)} and relayed its reply back to you.` },
        },
      ];

    case 'routine':
      return [
        {
          tool: 'routine_create',
          args: {
            name: 'Scheduled check-in',
            instruction: 'Read welcome.md and summarise the three most important lines.',
            schedule: extractSchedule(text),
            enabled: true,
          },
        },
        {
          tool: 'routine_list',
          args: {},
        },
        {
          tool: 'task_finish',
          args: { summary: 'Created the routine and confirmed it appears in the schedule.' },
        },
      ];

    case 'skill':
      return [
        {
          tool: 'skill_save',
          args: {
            name: extractSkillName(text),
            description: 'Inspect the shared workspace and produce a short, skimmable status note.',
            when_to_use: 'When someone asks for a quick read on what is in the workspace right now.',
            steps: [
              'Call fs_list on the workspace root.',
              'Call fs_read on the two most relevant files.',
              'Write the summary to notes/status.md with fs_write.',
              'Call task_finish with the path you wrote.',
            ],
            validation: 'notes/status.md exists and is shorter than 40 lines.',
            output: 'A markdown note at notes/status.md plus a one-line summary in chat.',
            approval_notes: 'Writing inside the workspace is LOW risk; nothing outside it is touched.',
            body: [
              '# Workspace sweep',
              '',
              'A small procedure for turning "what is going on in here" into a note somebody can read.',
              '',
              '1. List the workspace, newest files first.',
              '2. Read the two files that look most load-bearing.',
              '3. Write `notes/status.md` with sections: What changed / What is blocked / Next step.',
              '4. Finish with a one-line summary that names the file you wrote.',
            ].join('\n'),
          },
        },
        {
          tool: 'task_finish',
          args: { summary: `Saved "${extractSkillName(text)}" to the shared skill library.` },
        },
      ];

    case 'outside':
      // Deliberately crosses the workspace boundary: this is the HIGH-risk path
      // the approval boundary exists for. The tool refuses to run until a human
      // says yes.
      return [
        {
          tool: 'fs_write',
          args: {
            path: path.join('..', 'outside-note.md'),
            content: [
              '# Note written outside the shared workspace',
              '',
              `Request: ${shortQuote(text, 160)}`,
              '',
              'This file lives outside workspace/, so writing it needed a human approval.',
              '',
            ].join('\n'),
          },
        },
        {
          tool: 'task_finish',
          args: { summary: 'Wrote the note outside the workspace once it was approved.' },
        },
      ];

    case 'shell':
      return [
        { tool: 'shell', args: { command: 'node --version', timeoutMs: 15000 } },
        {
          tool: 'task_finish',
          args: { summary: say('在工作区里运行了 `node --version`，结果在上面。', 'Ran `node --version` inside the shared workspace and reported the output.') },
        },
      ];

    case 'memory':
      return [
        { tool: 'memory_write', args: { text } },
        {
          tool: 'task_finish',
          args: { summary: say('记下了，下次聊天我还记得。', 'Saved that to my memory. I will still have it in the next conversation.') },
        },
      ];

    case 'read':
      return [
        { tool: 'fs_read', args: { path: extractFileName(text) } },
        {
          tool: 'task_finish',
          args: { summary: say(`读了工作区里的 ${extractFileName(text)}，要点在上面。`, `Read ${extractFileName(text)} from the shared workspace and summarised it above.`) },
        },
      ];

    case 'files':
      return [
        { tool: 'fs_list', args: { path: '.' } },
        {
          tool: 'fs_write',
          args: {
            path: path.join('notes', 'plan.md'),
            content: [
              '# Plan',
              '',
              '1. Inspect the shared workspace (done).',
              '2. Write this note so the other bots can see what I did.',
              '3. Save a memory entry so this survives the conversation.',
              '',
            ].join('\n'),
          },
        },
        { tool: 'memory_write', args: { text: `Ran a workspace sweep: ${shortQuote(text, 120)}` } },
        {
          tool: 'task_finish',
          args: {
            summary: say('看了工作区里的文件，写了 notes/plan.md，也记进了笔记。', 'Listed the shared workspace, wrote notes/plan.md, and saved a memory entry about it.'),
          },
        },
      ];

    default:
      return [
        {
          content: zh
            ? `我是${botName === 'the assistant' ? '助理' : botName}，现在是演示模式（还没接入真实模型）。` +
              '可以让我看看工作区有哪些文件、读一个文件、记住一件事、运行一个命令——这些都会真的调用工具，需要你同意的会先问你。' +
              '到 设置 → 模型 接入真实模型后，我就能听懂任何话。'
            : `I'm ${botName}, working out of the shared workspace. ` +
              'Ask me to read or list files, remember something, run a shell command, save a skill, ' +
              'create a routine, or hand a task to another bot - those all go through real tools and the approval boundary.',
        },
      ];
  }
}

/** Parse "You are <name>," out of the system prompt so replies feel bot-specific. */
function botNameFromMessages(messages) {
  const system = messages.find((m) => m.role === 'system');
  if (!system || typeof system.content !== 'string') return 'the assistant';
  const match = system.content.match(/You are\s+([A-Za-z\u4e00-\u9fff][A-Za-z0-9\u4e00-\u9fff _-]{0,30})[,.，。]/);
  return match ? match[1].trim() : 'the assistant';
}

/**
 * The agent appends a group section to the system prompt with a deliberately
 * machine-readable first line:
 *   Group id: <id> (you are the coordinator|a member; your bot id is <id>).
 * The mock keys off it so group turns can be demonstrated and tested offline.
 * (A real model just reads the prose underneath.)
 */
function groupFromMessages(messages) {
  const system = messages.find((m) => m.role === 'system');
  if (!system || typeof system.content !== 'string') return null;
  const match = system.content.match(
    /Group id: (\S+) \(you are (the coordinator|a member); your bot id is (\S+?)\)/,
  );
  if (!match) return null;
  const membersLine = system.content.split('\n').find((line) => line.startsWith('You are in the group chat'));
  // "Members: Chief (chief) - ...; Researcher (researcher) - ..."
  const ids = membersLine ? [...membersLine.matchAll(/\(([a-z0-9][a-z0-9._-]*)\)/gi)].map((m) => m[1]) : [];
  return {
    id: match[1],
    role: match[2] === 'the coordinator' ? 'coordinator' : 'member',
    selfId: match[3],
    others: ids.filter((id) => id !== match[3]),
  };
}

/**
 * A group turn. The coordinator says one thing, hands a short ask to one
 * teammate (who answers in the group with group_post), then finishes. A member
 * answers in the group and replies privately to the coordinator.
 */
function mockGroupPlan(group, botName, text) {
  if (group.role === 'coordinator' && group.others.length) {
    return [
      {
        tool: 'group_post',
        args: { group: group.id, text: `On it: ${shortQuote(text, 60)}. I will check with the team.` },
      },
      {
        tool: 'bot_message',
        args: {
          botId: group.others[0],
          text: `The group is working on: ${shortQuote(text, 80)}. One short opinion, please.`,
        },
      },
      { tool: 'task_finish', args: { summary: `Posted in the group and pulled in ${group.others[0]} for a second opinion.` } },
    ];
  }

  const spoken =
    group.role === 'coordinator'
      ? `On it: ${shortQuote(text, 60)}. I am following this up in the group.`
      : `I am ${botName}. Picked up the group task: ${shortQuote(text, 60)}.`;
  return [
    { tool: 'group_post', args: { group: group.id, text: spoken } },
    { tool: 'task_finish', args: { summary: `Posted in the group: ${shortQuote(spoken, 70)}` } },
  ];
}

function mockComplete(messages) {
  const lastUserIndex = messages.reduce(
    (acc, m, i) => (m.role === 'user' ? i : acc),
    -1,
  );
  const userText = lastUserIndex >= 0 ? String(messages[lastUserIndex].content ?? '') : '';
  const toolResultsSinceUser =
    lastUserIndex >= 0 ? messages.slice(lastUserIndex + 1).filter((m) => m.role === 'tool').length : 0;

  const botName = botNameFromMessages(messages);
  // A plain "talk to the group" message has no other intent: answer in the group.
  const group = groupFromMessages(messages);
  const plan =
    group && detectIntent(userText) === 'chat'
      ? mockGroupPlan(group, botName, userText)
      : mockPlan(userText, botName);
  const step = plan[Math.min(toolResultsSinceUser, plan.length - 1)];

  // Ran out of scripted steps without a task_finish: emit a plain closing line
  // so the loop terminates instead of spinning.
  if (toolResultsSinceUser >= plan.length) {
    return {
      content: 'That is everything I had planned for this task.',
      toolCalls: [],
      finishReason: 'stop',
    };
  }

  if (step.content !== undefined) {
    return { content: step.content, toolCalls: [], finishReason: 'stop' };
  }

  return {
    content: '',
    toolCalls: [
      {
        id: `call_${toolResultsSinceUser}_${step.tool}`,
        name: step.tool,
        arguments: step.args || {},
      },
    ],
    finishReason: 'tool_calls',
  };
}
