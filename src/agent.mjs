/**
 * agent.mjs - one turn of one bot.
 *
 * The loop is deliberately small and boring:
 *   build prompt -> call model -> execute tool calls (through approvals) ->
 *   feed results back -> repeat -> finish.
 *
 * Bounds that matter:
 *   - max 80 steps           (bot policy can raise it to 200, so a real task fits)
 *   - 30 minute wall clock   (a stuck tool cannot hold a turn forever)
 *   - bounded hand-offs      (depth, per-task budget, no hand-back: tools.bot_message)
 *
 * Everything observable is emitted on the event bus, which the server forwards
 * over SSE. The same events are appended to the session log, so a browser that
 * reloads mid-turn still sees the transcript.
 */

import path from 'node:path';
import fsp from 'node:fs/promises';
import fsSync from 'node:fs';
import {
  P,
  uid,
  nowIso,
  audit,
  appendJsonl,
  readJsonl,
  readJsonSync,
  writeJsonSyncAtomic,
  listFiles,
  sessionFile,
  turnFile,
} from './store.mjs';
import { effectivePolicy, classify, DECISION, machineMode, mediumRunsUnasked } from './approvals.mjs';
import { judgeRules, applyRules, RULE_EXEMPT } from './rules.mjs';
import { checkBoundary } from './boundary.mjs';
import { noteUsage } from './usage.mjs';

const MAX_TOOL_OUTPUT = 12000;

/**
 * Tool-result clearing (context engineering): in a long turn every earlier
 * tool output rides along in every later model call, which costs tokens and
 * dulls the model. Keep the last KEEP results whole; older ones shrink to a
 * short head with a note. The call records (what was done) stay intact.
 */
export function trimOldToolOutputs(messages, { keep = 6, head = 600 } = {}) {
  const toolIdx = [];
  for (let i = 0; i < messages.length; i += 1) if (messages[i]?.role === 'tool') toolIdx.push(i);
  for (const i of toolIdx.slice(0, Math.max(0, toolIdx.length - keep))) {
    const c = String(messages[i].content || '');
    if (c.length <= head + 80 || c.endsWith('…(earlier output trimmed; read the file or run it again if you need it)')) continue;
    messages[i] = { ...messages[i], content: `${c.slice(0, head)} …(earlier output trimmed; read the file or run it again if you need it)` };
  }
  return messages;
}
const RECOVERY_NOTE =
  'The server stopped while this turn was running, so it did not finish. Nothing is resumed automatically - ' +
  'check the workspace for partial changes (files written before the stop are kept) and ask me again. ' +
  'If the turn was waiting for an approval, that card is still in Activity.';

/**
 * The group-chat section of the system prompt.
 *
 * v1 semantics: the coordinator is the only bot that runs a turn when the human
 * posts; everyone else runs only when it messages them privately, and their
 * words reach the group through group_post. The "Group id" line is deliberately
 * machine-readable: the offline mock planner keys off it.
 */
function renderGroupSection(bot, group, groupRole) {
  const coordinator = groupRole === 'coordinator';
  const speaker = groupRole === 'speaker';
  const members = (group.members || [])
    .map((member) => `${member.name} (${member.id}) - ${member.role || 'no role set'}${Array.isArray(member.tools) ? ` [can: ${abilitySummary(member.tools)}]` : ''}${member.remote ? ` [works on the machine "${member.remote.machine}"; @mention it like the others, its files are fetched here when it names them]` : ''}`)
    .join('; ');
  const others = (group.members || []).filter((m) => m.id !== bot.id).map((m) => `@${m.name}`).join(' ');
  const lines = [
    '## Group chat',
    `Group id: ${group.id} (you are ${coordinator ? 'the coordinator' : speaker ? 'a member asked to answer' : 'a member'}; your bot id is ${bot.id}).`,
    `You are in the group chat "${group.name}". Members: ${members}.`,
  ];
  if (coordinator || speaker) {
    lines.push(
      "The human's message went to the whole group. Your final answer is posted to the group automatically, under your name: just answer. Do not repeat it with group_post (use group_post only for a short update in the middle of long work).",
      'Write in the language the human uses. Keep it short. Never start a message with your own name or a [tag].',
    );
  }
  if (coordinator) {
    lines.push(
      `You speak first when nobody was @mentioned. Questions and progress checks ("how is everyone doing"): answer only your own part in a line or two, then @mention each member who should answer, using the exact name (${others}). Every member you @mention answers right after you, in the group. Do not answer for them.`,
      'Real work (something to make, research, fix or produce) whose parts match the members\' roles: do NOT do their parts yourself. Call group_plan first: split it into tasks with an owner each (by role), a self-contained brief, the deliverable, and the order (needs). The runtime then starts every member on its task - in parallel where possible - and asks you to put the results together. Only when the whole job is one small step that splitting would slow down, do it yourself and say in one line why you did not split it.',
    );
  } else if (groupRole === 'task') {
    lines.push(
      'You own one task on this group\'s task board (below). Do it completely with your tools - that is your job here, not advice. Your final answer is posted to the group as your task report: the result itself, and the paths of the files you made (they are passed on to whoever needs them).',
      'If you need one piece from a teammate (a number, a check, a file) and keep the rest, call task_ask_member - your task resumes with their result; never just @mention them in your report. If the task does not fit your role and another member\'s role fits it better, call task_handoff to that member right away - do not ask the human whether to hand it on, and do not attempt it badly. Call task_ask_human only for what only the human can decide or supply (a preference, a choice between options, missing facts). Do not do other members\' tasks.',
    );
  } else if (speaker) {
    lines.push('You were @mentioned, so answer your own part only: what you own, where it stands, what you need. Other members answer for themselves.');
  } else {
    lines.push(
      'You were pulled into this group by a teammate with a private bot_message. Your final answer goes back to that teammate, not to the group.',
      `If a short status line would help the whole group, you may post one with group_post {group: "${group.id}", text: "..."}.`,
    );
  }
  return lines.join('\n');
}

/** Members a message @mentions, in the order mentioned; "@所有人" / "@everyone" means all of them. */
export function mentionedMembers(text, members) {
  const raw = String(text || '');
  if (/@(所有人|全体成员|全体|everyone|all)(?![\w\u4e00-\u9fff])/i.test(raw)) return [...members];
  const hits = [];
  for (const m of members) {
    const name = String(m.name || '').trim();
    if (!name) continue;
    const esc = name.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
    const at = raw.search(new RegExp(`@${esc}(?![\\w\\u4e00-\\u9fff])`, 'i'));
    if (at >= 0) hits.push({ m, at });
  }
  return hits.sort((a, b) => a.at - b.at).map((h) => h.m);
}

/** Models sometimes sign a group message "[Writer] ..."; the UI already shows who spoke. */
function stripOwnTag(text, name) {
  const t = String(text || '');
  const esc = String(name || '').replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  return esc ? t.replace(new RegExp(`^\\s*[\\[【]\\s*${esc}\\s*[\\]】]\\s*[:：]?\\s*`, 'i'), '') : t;
}

/** How the human and the bot share the screen (Grok-Bot style hand-over). */
const TAKEOVER_RULES = [
  '## Your screen and the human',
  'The human can watch your desktop live and take it over from this app (right panel -> 电脑 -> 接管桌面). That is how they log in, type passwords, scan QR codes, pass CAPTCHAs or pay.',
  '- When a site needs any of those: open the page in your own browser (browser_open), then call request_takeover with one short sentence saying exactly what they should do. Your turn ends there; you continue when they say so.',
  '- Logins: first call vault_list. If the site is there, fill the fields with browser_fill_secret (you never see the values). If not, call request_login - a secure form saves what the human types into the vault.',
  '- QR codes, SMS or e-mail codes, CAPTCHA and payment: use request_takeover.',
  '- Only request_takeover puts the 接管屏幕 button in the chat: always call it, never just write "点下面的「接管屏幕」" yourself.',
  '- Never ask for passwords, verification codes or card numbers in chat, and never type a password with browser_type.',
  '- Never expose the desktop to the network (VNC/x11vnc/websockify on 0.0.0.0, port forwarding, remote-desktop software, VNC passwords). The app already gives the human secure access.',
  '- Purchases: you may research, compare and put things in the cart; the human confirms and pays during a takeover.',
  '- Approvals: describe them only from what actually happened (a tool result, an approval card). Never say a step was approved or that you asked when that did not happen.',
  '',
];

/** The human's machines, as their desktop app reported them. */
function machinesSection(ui) {
  const machines = ui?.machines || [];
  if (machines.length < 2) return [];
  return [
    '## The human\'s machines',
    ...machines.map((m) => `- ${m.name} (${m.url === 'local' ? 'their own computer' : m.url})${m.current ? ' <- this chat runs here' : ''}`),
    'Each machine has its own bots, files and desktops. When the human asks for something on another machine, call machine_switch with a complete task for the assistant there; do not SSH in yourself.',
    '',
  ];
}

/**
 * Did the human ask for something to be run, and does the reply read like the
 * output of running it? Used only when the turn called no tool at all.
 */
export function looksLikeMadeUpRun(userText, reply, canRun) {
  if (!canRun) return false;
  const asked = /执行|运行|跑一下|跑下|命令|run\b|execute|sudo |bash |`[^`]+`|\$ /i.test(userText);
  if (!asked) return false;
  return /```|exit(code)?\s*[=:]\s*\d|退出码|执行完成|输出如下|原样输出|命令输出|stdout|已执行|运行结果/i.test(reply);
}

/**
 * Claim checking ("tool receipts"): a final answer is held against what this
 * turn actually did. Deterministic, no second model call:
 *   - a file it says it wrote / saved / that is "at" a path must exist;
 *   - "ran / executed" needs a command-running call that succeeded;
 *   - "sent / submitted" needs a sending call (not checked in a group, where
 *     the answer itself is what gets posted).
 * receipts: [{name, args, ok}] of this turn. -> [problem, ...] (Chinese, for the bot)
 */
const CLAIM_FILE_RE = /([A-Za-z]:[\\/][^\s`'"“”「」（）()<>，。；]+?|(?:\.{0,2}\/)?[\w\u4e00-\u9fff.-]+(?:[\\/][\w\u4e00-\u9fff.-]+)*)\.(md|txt|html?|json|csv|png|jpe?g|gif|webp|svg|mp4|mov|webm|mp3|wav|ogg|pdf|docx?|xlsx?|pptx?|py|js|mjs|ts|sh|ya?ml|zip)\b/gi;
const CLAIM_SAVE_RE = /(写好|写入|写进|写了|存到|存在|存好|存进|保存|已存|生成|创建|落盘|导出|放在|位于|路径|文件在|saved|wrote|written|created|generated|exported)/i;
const RUN_TOOLS = /^(shell|cli_agent_run|desktop_ui|winui_|browser_|mcp__)/;
const SEND_TOOLS = /(send|post|message|reply|mail|notify|publish|push|create_issue|create_pull|comment)/i;
export function checkClaims(text, receipts, { workspaceDir = '', exists = (p) => fsSync.existsSync(p), group = false } = {}) {
  const out = [];
  // Quoted sentences are reported speech ("你说的「已发送给张三」…"), not claims: drop them
  // (a short quoted name or path stays). Sentences that deny something are not claims either.
  const t = String(text || '').replace(/「[^」]{16,}」|“[^”]{16,}”|"[^"\n]{16,}"/g, ' ');
  if (!t.trim()) return out;
  const NEG = /(不存在|没有|没能|未能|没写|没存|没做|没发|未生成|未发送|不成立|并非|失败|找不到|做不到|无法|not found|missing|failed|did not|didn't)/i;
  // What it is going to do ("风格定了之后会存到 essay.md") is a plan, not a claim (seen live).
  const FUTURE = /(会存|会写|会保存|会放|会生成|将存|将写|将保存|将会|准备|打算|待会|稍后|接下来|下一步|等[^。！？\n]{0,20}(后|再)|再存|再写|要存到|要写到|要保存|计划|will |going to|later)/i;
  const sentences = t.split(/(?<=[。！？!?；;\n])/);
  const claimed = (re) => sentences.some((x) => re.test(x) && !NEG.test(x) && !FUTURE.test(x));
  const okCalls = (receipts || []).filter((r) => r.ok !== false);
  // files
  const seen = new Set();
  for (const m of t.matchAll(CLAIM_FILE_RE)) {
    const raw = m[0].replace(/[\\/]+$/, '');
    if (seen.has(raw) || /^https?:/i.test(raw) || /\/\//.test(t.slice(Math.max(0, m.index - 8), m.index))) continue;
    seen.add(raw);
    const before = t.slice(Math.max(0, m.index - 24), m.index);
    const after = t.slice(m.index + raw.length, m.index + raw.length + 12);
    if (!CLAIM_SAVE_RE.test(before) && !CLAIM_SAVE_RE.test(after)) continue;
    // Saying it is NOT there, or did not get written, is an honest report.
    const sentence = sentences.find((x, k) => { const start = sentences.slice(0, k).join('').length; return m.index >= start && m.index < start + x.length; }) || '';
    if (NEG.test(before + after) || NEG.test(sentence) || FUTURE.test(sentence)) continue;
    // A path in the other machine family's form (a Linux path seen on Windows, or the reverse) cannot be checked here.
    if ((process.platform === 'win32' && raw.startsWith('/')) || (process.platform !== 'win32' && /^[A-Za-z]:[\\/]/.test(raw))) continue;
    const full = /^[A-Za-z]:[\\/]/.test(raw) || raw.startsWith('/') ? raw : path.join(workspaceDir || '.', raw.replace(/^\.\//, ''));
    if (!exists(full)) out.push(`说文件「${raw}」已经写好或在那里，但这个文件并不存在`);
  }
  // commands
  if (claimed(/(运行了|执行了|跑了|跑完了|已执行|已运行|执行结果|exit\s*code|退出码)/i) && !okCalls.some((r) => RUN_TOOLS.test(r.name) || r.name === 'mcp_call')) {
    out.push('说运行 / 执行了命令，但这一轮没有任何成功的执行类操作');
  }
  // sending
  if (!group && claimed(/(已发送|发送了|已发给|已经发给|发出去了|已通知|已提交|已推送)/)
    && !okCalls.some((r) => SEND_TOOLS.test(r.name) || (r.name === 'mcp_call' && SEND_TOOLS.test(String(r.args?.tool || ''))) || r.name === 'bot_message' || r.name === 'group_post')) {
    out.push('说已经发送 / 提交了，但这一轮没有任何发送类操作');
  }
  return out;
}

/** The human's other machines, whose bots this one can hand work to. */
function peersLine(peers, canHandOff) {
  if (!peers.length || !canHandOff) return [];
  return [`Teammates also work on the human's other machines: ${peers.map((p) => p.name).join(', ')}. bot_list shows who is there; hand them work with bot_message and its machine argument. Their files are separate: file_send what they need first, file_fetch what they made.`];
}

import { askPeerBot, fetchedNote } from './crossmachine.mjs';
import { makePlan, savePlan, loadPlan, readyTasks, skipBlocked, planText, resolveMember, listPlans, makeTask, updateStep, openSteps, doneSteps, taskText } from './plans.mjs';

/** A 1:1 task keeps going by itself at most this many turns before it asks the human. */
const TASK_MAX_CONTINUATIONS = 12;
const TASK_OPEN = ['running', 'waiting', 'stalled'];
/** Turns a direct chat goes on by itself at the step limit (no open checklist), per message from the human. */
const LIMIT_CONTINUATIONS = 6;
import { isRequestable, toolLabel, toolsForText, abilitySummary } from './abilities.mjs';

/**
 * A task report that hands a request to a teammate by @mention instead of
 * finishing ("@数据 帮算个数，回我就行"): the board treats it as task_ask_member.
 * -> {to, request} or null
 */
function askedByMention(res, task, owner, group) {
  if (!res || res.board || res.status !== 'success' || !owner || owner.remote) return null;
  const text = String(res.summary || '');
  const others = (group.members || []).filter((m) => m.id !== owner.id && m.id !== group.coordinatorId);
  const hit = mentionedMembers(text, others)[0];
  if (!hit) return null;
  // Asking, not just naming: a request word near the mention.
  if (!/帮|请|麻烦|回我|算一下|核对|给我|需要你|can you|please/i.test(text)) return null;
  return { to: hit.id, request: text.slice(0, 1500) };
}

/** Tools that act on the group's task board: handled by the runtime, not the registry. */
const GROUP_TOOLS = {
  group_plan: {
    name: 'group_plan',
    description: 'Split the human\'s request into tasks for the group members, so each member does its own part (they run in parallel when independent). Each task: a title, the owner (a member\'s name), a self-contained brief (what to do, the inputs and file paths, constraints), the deliverable, and which earlier tasks it needs (by number). Do not add a task for summarizing or assembling the results yourself: when every task is done you are asked to put the results together automatically. After this call, stop: the members are started for you.',
    parameters: {
      type: 'object',
      properties: {
        tasks: {
          type: 'array',
          items: {
            type: 'object',
            properties: {
              title: { type: 'string', description: 'Short task name.' },
              owner: { type: 'string', description: 'The member who does it (exact name).' },
              brief: { type: 'string', description: 'Everything the owner needs to do it without asking: goal, inputs, file paths, constraints.' },
              deliverable: { type: 'string', description: 'What to hand back (e.g. a file path and format).' },
              needs: { type: 'array', items: { type: 'integer' }, description: 'Numbers (1-based) of earlier tasks that must be done first.' },
            },
            required: ['title', 'owner', 'brief'],
          },
        },
      },
      required: ['tasks'],
    },
  },
  task_handoff: {
    name: 'task_handoff',
    description: 'Hand your task on the group\'s task board to another member who is better placed to do it. Say why and what you already found. Your turn ends.',
    parameters: { type: 'object', properties: { to: { type: 'string', description: 'The member\'s name.' }, note: { type: 'string', description: 'Why, and what you already did or found.' } }, required: ['to', 'note'] },
  },
  task_ask_member: {
    name: 'task_ask_member',
    description: 'Ask a teammate in the group for one piece your task needs (a number, a check, a file) while you keep ownership. The board gives them a helper task; when it is done your task starts again with their result. Your turn ends.',
    parameters: { type: 'object', properties: { to: { type: 'string', description: 'The member\'s name.' }, request: { type: 'string', description: 'Exactly what you need from them, with inputs and where to put the result.' } }, required: ['to', 'request'] },
  },
  task_ask_human: {
    name: 'task_ask_human',
    description: 'Ask the human a question your task cannot go on without: a preference, a choice between options, or facts only they have. Not for "should I hand this to someone else?" - use task_handoff for that. It is posted in the group; your task waits and continues with the answer. Your turn ends.',
    parameters: { type: 'object', properties: { question: { type: 'string' } }, required: ['question'] },
  },
};
GROUP_TOOLS.task_plan = {
  name: 'task_plan',
  description: 'For work of several steps (about 3 or more, or anything that may take more than a few minutes): write the steps down first. The human sees them as a checklist; your progress is kept, and you are kept going turn after turn until every step is done (also after a restart) - nobody has to say 继续. Calling it again replaces the current task (when the human changes the plan). Quick things need no task.',
  parameters: { type: 'object', properties: { goal: { type: 'string', description: 'The goal in one line, in the human\'s language.' }, steps: { type: 'array', items: { type: 'string' }, description: 'The steps in order, each a short concrete action with its result (e.g. "查 3 家竞品的定价，存到 research/pricing.md").' } }, required: ['goal', 'steps'] },
};
GROUP_TOOLS.task_step = {
  name: 'task_step',
  description: 'Mark a step of your current task: done (note = one line of what was made and where), doing, blocked (note = exactly what you need from the human; then ask it in your reply and stop - the task waits for their answer), skipped or failed (note = why).',
  parameters: { type: 'object', properties: { step: { type: 'integer', description: 'Step number, 1-based.' }, status: { type: 'string', enum: ['done', 'doing', 'blocked', 'skipped', 'failed'] }, note: { type: 'string' } }, required: ['step', 'status'] },
};
GROUP_TOOLS.task_end = {
  name: 'task_end',
  description: 'Close your current task: done=true when it is finished, false when the human called it off or moved on to something else.',
  parameters: { type: 'object', properties: { done: { type: 'boolean' }, note: { type: 'string' } }, required: ['done'] },
};
const SOLO_TASK_TOOLS = ['task_plan', 'task_step', 'task_end'];
const groupToolSchemas = (names) => names.map((n) => ({ type: 'function', function: { name: GROUP_TOOLS[n].name, description: GROUP_TOOLS[n].description, parameters: GROUP_TOOLS[n].parameters } }));

/**
 * A long answer to the human, as several chat messages: the lead (the answer
 * itself) first, then one message per section. Cut only between paragraphs,
 * never inside a code block, and never after a heading or a line ending in
 * a colon, so nothing is lost and each message reads on its own.
 */
export function splitReply(text, { min = 350, target = 600, maxParts = 5 } = {}) {
  const t = String(text || '');
  if (t.length < min) return [t];
  const blocks = [];
  let cur = [];
  let fence = false;
  for (const line of t.split('\n')) {
    if (/^\s*(```|~~~)/.test(line)) fence = !fence;
    if (!fence && !line.trim()) { if (cur.length) { blocks.push(cur.join('\n')); cur = []; } continue; }
    cur.push(line);
  }
  if (cur.length) blocks.push(cur.join('\n'));
  const firstLine = (b) => b.split('\n')[0].trim();
  const isHeading = (b) => /^#{1,6}\s/.test(firstLine(b)) || (/^\*\*[^*\n]{1,40}\*\*/.test(firstLine(b)) && firstLine(b).length <= 40);
  // A block that only introduces what follows stays with it.
  const leadsOn = (b) => (isHeading(b) && !b.includes('\n')) || /[:：]\s*$/.test(b);
  const parts = [];
  let part = [];
  for (const b of blocks) {
    const len = part.join('\n\n').length;
    const leadDone = parts.length === 0 && len >= 60;
    if (part.length && !leadsOn(part[part.length - 1]) && (isHeading(b) || len + b.length > target || leadDone)) {
      parts.push(part.join('\n\n'));
      part = [];
    }
    part.push(b);
  }
  if (part.length) parts.push(part.join('\n\n'));
  // A short closing line ("有问题再说") rides with the part before it.
  for (let i = parts.length - 1; i > 0; i -= 1) {
    if (parts[i].length < 50) { parts[i - 1] = `${parts[i - 1]}\n\n${parts[i]}`; parts.splice(i, 1); }
  }
  if (parts.length > maxParts) parts.splice(maxParts - 1, parts.length, parts.slice(maxParts - 1).join('\n\n'));
  return parts.length > 1 ? parts : [t];
}

/**
 * A step that reaches Nightshift's own secrets or internals: the vault (where
 * app codes and logins live) or its own modules run from a script. Seen on
 * Ubuntu: a bot cleaning a mailbox wrote a script that imported the mail
 * module and took the mailbox code out of the vault, so thousands of moves ran
 * as one unasked shell command instead of through the app's tools (which ask).
 * -> a reason when it does, else ''.
 */
const escRe = (t) => String(t).replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
const HUB_SRC_DIR = (() => {
  try { return path.dirname(decodeURIComponent(new URL(import.meta.url).pathname).replace(/^\/([A-Za-z]:)/, '$1')); } catch { return ''; }
})();
// Nightshift's own module files (a project of the human's has src/*.mjs of its own).
const HUB_MODULES = (() => {
  try { return fsSync.readdirSync(HUB_SRC_DIR).filter((f) => f.endsWith('.mjs')).map((f) => escRe(f.slice(0, -4))); } catch { return ['agent', 'mail', 'mcp', 'vault', 'tools', 'server']; }
})();
const HUB_ROOTS = ['desk-hub', ...(HUB_SRC_DIR ? [path.dirname(HUB_SRC_DIR), path.dirname(HUB_SRC_DIR).replace(/\\/g, '/')] : [])].map(escRe);
const HUB_MODULE = new RegExp(String.raw`\b(import|require)\b[\s\S]{0,400}?(${HUB_ROOTS.join('|')}|[\\/]src[\\/](${HUB_MODULES.join('|')})\.mjs)`, 'i');

export function reachesSecrets(name, args = {}) {
  const SECRET_FILES = /(vault\.(key|json|mjs)|secrets\.json|\brevealVault\b|\bputVault\b)/i;
  const text = name === 'shell' ? String(args.command || '')
    : name === 'fs_write' ? `${args.path || ''}\n${args.content || ''}`
      : name === 'fs_read' || name === 'fs_list' ? String(args.path || '')
        : '';
  if (!text) return '';
  if (SECRET_FILES.test(text)) return '要碰长明保险箱里的密钥或授权码（vault），每次都先问你';
  if (name !== 'fs_read' && name !== 'fs_list' && HUB_MODULE.test(text)) return '要在脚本里直接调用长明自己的模块（会绕过「连接应用」的审批），每次都先问你';
  return '';
}

/**
 * A message that only says "stop" ("停下", "别做了", "取消", "stop"): the work
 * stops for real, instead of the bot promising to (seen: "停下" -> "收到，我不会
 * 再往下做", and the task carried on). Short messages only; anything longer is
 * an instruction the bot reads.
 */
export function isStopWords(text) {
  const t = String(text || '').trim().replace(/[。！!.~～，,\s]+$/u, '');
  if (!t || t.length > 12) return false;
  return /^(请|你)?(先|快)?(停|停下|停下来|停止|停掉|停一下|停手|别(再)?(做|弄|搞|干|继续)了?|不要(再)?(做|弄|搞|干|继续)了?|不(做|弄|搞|干)了|取消(吧|任务|这个任务)?|算了|stop|cancel|abort)(吧|了|一下|吧别做了)?$/iu.test(t);
}

export class AgentRuntime {
  constructor({ config, registry, model, bots, groups, memory, skills, approvals, bus, getApp, getPeers }) {
    this.config = config;
    this.registry = registry;
    this.model = model;
    this.bots = bots;
    // Late-bound product state (settings, UI state). Only the primary bot's
    // settings/ui tools read it; a runtime without it still runs every turn.
    this.getApp = typeof getApp === 'function' ? getApp : () => null;
    this.getPeers = typeof getPeers === 'function' ? getPeers : () => null;
    // Group chats are optional: a runtime without them still runs 1:1 turns, and
    // the group tools answer GROUPS_UNAVAILABLE instead of pretending.
    this.groups = groups || null;
    this.memory = memory;
    this.skills = skills;
    this.approvals = approvals;
    this.bus = bus;
    /** @type {Map<string, {controller: AbortController, botId: string}>} */
    this.active = new Map();
    /** Turns speaking in a group: their talk lives in the group transcript only, not the bot's own chat. */
    this.groupTurns = new Set();
  }

  /** Swap the model client after settings change (provider / key / endpoint). */
  setModel(model) {
    this.model = model;
  }

  /** A bot's own model, when it has one that works; null means the default. */
  async modelFor() {
    return null;
  }


  activeTurns() {
    return [...this.active.entries()].map(([turnId, info]) => ({ turnId, botId: info.botId }));
  }

  /** The turn this bot is working on for the human right now (not a hand-off or a group turn), or null. */
  busyTurn(botId) {
    for (const [turnId, info] of this.active) {
      if (info.botId === botId && !info.depth && !info.group && !info.unattended) return { turnId, ...info };
    }
    return null;
  }

  /**
   * A message the human sent while the bot is busy: answered at once, in one
   * model call without tools (it knows what it is doing, for how long, and the
   * latest output), and handed to the running turn, which reads it before its
   * next step - "停", "换个办法" take effect there. -> {turnId, text}
   */
  /** A turn of this group in progress on this machine (whoever is speaking), or null. */
  busyGroupTurn(groupId) {
    for (const [turnId, info] of this.active) {
      // A group's self-introductions right after it is made are not work the human waits on.
      if (groupId && info.groupId === groupId && !info.kickoff) return { turnId, ...info };
    }
    return null;
  }

  async aside({ botId, text, turnId: providedTurnId = null, source = 'chat', group = null, busy: givenBusy = null }) {
    const busy = givenBusy || this.busyTurn(botId);
    const bot = await this.bots.getBot(busy?.remote && group?.coordinatorId ? group.coordinatorId : botId);
    if (!bot) throw httpError(404, 'BOT_NOT_FOUND', `no bot with id "${botId}"`);
    const turnId = providedTurnId || uid('turn');
    const said = String(text);
    // "停下" while it works: stop the turn and its task now, like the stop button.
    if (busy && !busy.remote && !group?.id && isStopWords(said)) {
      const running = this.active.get(busy.turnId);
      const task = this.activeTask(bot.id);
      if (task) { task.status = 'stopped'; task.endNote = '用户让停下'; await this.taskChanged(task); }
      running?.controller?.abort();
      const answer = `好，停下了${task ? `，任务「${task.goal}」不会再自动接着做` : ''}。已经做好的文件都还在；要接着做就跟我说。`;
      const ev = { botId: bot.id, botName: bot.name, turnId, source, depth: 0, parentTurnId: null, unattended: false, aside: true };
      await this.record(bot.id, { kind: 'user', text: said, turnId, source });
      this.bus.emit({ type: 'turn.start', ...ev, text: said });
      this.bus.emit({ type: 'message', ...ev, text: answer, final: true });
      await this.record(bot.id, { kind: 'assistant', text: answer, turnId, source, final: true });
      this.bus.emit({ type: 'turn.end', ...ev, status: 'success', summary: answer, steps: 0 });
      return { turnId, text: answer, stopped: true };
    }
    if (busy) this.active.get(busy.turnId)?.inbox.push(said);
    const now = Date.now();
    const secs = (ms) => `${Math.max(1, Math.round(ms / 1000))} 秒`;
    const step = busy?.step;
    const status = busy?.remote ? [
      `群里的「${busy.memberName}」正在另一台机器「${busy.machine}」上回答：「${String(busy.task || '').slice(0, 200)}」，已经 ${secs(now - busy.startedAt)}，还没回来。`,
      '你是这个群的协调者，替它说一下进度；用户这条消息会在它答完后交给群里接着处理。',
    ].join('\n') : busy ? [
      `用户交给你的事（他的原话，不代表你已经在照做）：「${String(busy.task || '').slice(0, 300)}」。从开始到现在 ${secs(now - busy.startedAt)}，已经做完 ${busy.steps || 0} 步。`,
      step ? `你此刻实际在做的（唯一可信）：调用工具 ${step.name}，参数 ${JSON.stringify(step.args || {}).slice(0, 300)}，这一步已经 ${secs(now - step.startedAt)}，还没结束。` : '你此刻实际在做的（唯一可信）：没有在跑工具，在想下一步怎么做（模型在思考）。',
      busy.last ? `上一步的结果（节选）：${busy.last}` : '',
      !group?.id && this.activeTask(bot.id) ? `任务「${this.activeTask(bot.id).goal}」的进度：\n${taskText(this.activeTask(bot.id))}` : '',
    ].filter(Boolean).join('\n') : '你手上没有正在做的事。';
    const model = (await this.modelFor(bot).catch(() => null)) || this.model;
    const baseEvent = { botId: bot.id, botName: bot.name, turnId, source, depth: 0, parentTurnId: null, unattended: false, aside: true, ...(group?.id ? { groupId: group.id } : {}) };
    // In a group the exchange belongs to the group's transcript, not the bot's own chat.
    if (group?.id) await this.recordGroupMessage(group.id, { kind: 'user', from: 'user', text: said, turnId });
    else await this.record(bot.id, { kind: 'user', text: said, turnId, source });
    this.bus.emit({ type: 'turn.start', ...baseEvent, text: said });
    let answer = '';
    // Said from the status alone, when the model gives nothing back.
    const plain = () => busy?.remote
      ? `收到。「${busy.memberName}」正在「${busy.machine}」上处理，已经 ${secs(now - busy.startedAt)}；它答完后，群里接着处理你这条。`
      : busy
        ? `收到。我正在做「${String(busy.task || '').slice(0, 40)}」${step ? `，这一步（${step.name}）已经 ${secs(now - step.startedAt)}` : ''}，这条消息我会在这一步结束后接着看。`
        : '收到。';
    try {
      const history = group?.id && this.groups
        ? (await this.groups.loadGroupHistory(group.id, { names: new Map((group.members || []).map((m) => [m.id, m.name])) }).catch(() => [])).slice(-8)
        : await this.loadHistory(bot.id, 8);
      const response = await model.complete([
        { role: 'system', content: [
          `你是「${bot.name}」。${bot.role || ''}`,
          group?.id ? `这是群「${group.name || ''}」：你在群里替大家做一件事时，用户在群里又发来一条消息。现在不能用任何工具，只用一两句话直接在群里回答他。` : '你正在做一件事，用户在你干活时发来一条消息。现在不能用任何工具，只用一两句话直接回答他。',
          '他问进度、为什么慢：只按「你此刻实际在做的」那一行说在做什么、做了多久；可以按那个工具和参数解释为什么要这么久（例如在下载、在编译、在等网页）。用户交给你的事只是他的原话，没写在那一行里的就是还没做，不能说成正在做。不要编造状态里没有的信息。',
          '他让你停下、改做法或补充要求：说你会在当前这一步结束后照办（这条消息已经转给手上的那件事）；要立刻停，告诉他点输入框旁边的停止按钮。',
          '他问的和手上的事无关：简短回答；需要动手的，说做完手上的事再来。',
          '',
          status,
        ].join('\n') },
        ...history,
        { role: 'user', content: said },
      ], { tools: [] });
      noteUsage({ botId: bot.id, provider: model.provider || '', model: model.model || '', usage: response.usage, source }, { audit, bus: this.bus }).catch(() => {});
      answer = String(response.content || '').trim() || plain();
    } catch (err) {
      answer = busy ? plain() : `没能回答：${err.message}`;
    }
    this.bus.emit({ type: 'message', ...baseEvent, text: answer, final: true });
    if (group?.id) await this.recordGroupMessage(group.id, { kind: 'assistant', from: bot.id, text: answer, turnId });
    else await this.record(bot.id, { kind: 'assistant', text: answer, turnId, source, final: true });
    this.bus.emit({ type: 'turn.end', ...baseEvent, status: 'success', summary: answer.slice(0, 200), steps: 0 });
    return { turnId, text: answer };
  }

  cancel(turnId) {
    const entry = this.active.get(turnId);
    if (!entry) return false;
    entry.controller.abort();
    this.approvals.cancelForTurn(turnId, 'turn cancelled by the user');
    return true;
  }

  cancelAll(reason = 'server shutting down') {
    for (const [turnId, entry] of this.active) {
      entry.controller.abort();
      this.approvals.cancelForTurn(turnId, reason);
    }
  }

  // -------------------------------------------------------------------------
  // system prompt
  // -------------------------------------------------------------------------

  /**
   * Coding assistants on the human's own subscription that are installed and
   * logged in here (set by the server: [{id, label, model}]). Big programming
   * work is cheaper there than on the chat model's API.
   */
  subscriptionCodingLines(bot) {
    const ready = this.cliReady || [];
    if (!ready.length || !this.registry.isGranted?.(bot, 'cli_agent_run')) return [];
    const list = ready.map((a) => `${a.label} (agent "${a.id}"${a.model ? `, model ${a.model}` : ''})`).join(', ');
    return [
      '## Big programming work: the human\'s subscription',
      `Logged in on this machine: ${list}. They run on the human's own subscription, not on your paid API.`,
      'When the human asks for real programming (a new program, page or script of more than a few dozen lines, a feature across several files, debugging a project), do not write it all yourself: say in one line that you will hand it to one of these (name it) and do so with cli_agent_run - it asks the human first. Small edits, one-line fixes and quick scripts: do them yourself. If they say to do it yourself, do.',
      '',
    ];
  }

  async buildSystemPrompt(bot, { unattended, group = null, groupRole = 'coordinator', depth = 0, task = null }) {
    // Talking with the human directly (not a group, not a routine, not a teammate's request).
    const direct = !unattended && !group && !depth;
    const [memoryDigest, skillsDigest, toolDigest] = await Promise.all([
      this.memory.renderMemoryDigest({ botId: bot.id, limit: 8 }),
      this.skills.renderSkillsDigest(bot.skills || []),
      Promise.resolve(this.registry.renderToolDigest(bot)),
    ]);

    const others = (await this.bots.listBots()).filter((b) => b.id !== bot.id);
    const teamLine = others.length
      ? others.map((b) => `${b.name} (${b.id}) - ${b.role || 'no role set'}`).join('\n')
      : '(no other bots yet)';

    // The human's interface language wins over a persona's "reply in Chinese".
    const lang = this.getApp()?.uiState?.lang;
    return [
      `You are ${bot.name}, ${bot.role || 'a member of the team'}.`,
      bot.persona || '',
      ...(lang === 'en'
        ? ['The human uses the English interface: reply in English, whatever the persona above says about language, unless they write to you in another language.']
        : []),
      '',
      '## The team',
      bot.primary
        ? 'You are the primary bot. You coordinate: split work, hand tasks to the right teammate with bot_message, and report back to the human.'
        : 'You are a specialist bot. Do your part of the work and report back concisely. When part of a job belongs to a teammate (see the team below), hand it to them with bot_message - give them the inputs and file paths they need - and put their results together; you get each reply back. Never hand work back to the bot that gave it to you.',
      teamLine,
      ...peersLine(this.getPeers()?.list?.() || [], this.registry.isGranted(bot, 'bot_message')),
      '',
      ...(group ? [renderGroupSection(bot, group, groupRole), ''] : []),
      ...(!direct ? [] : task ? [
        '## Your current task (the human sees it as a checklist)',
        `Goal: ${task.goal}`,
        taskText(task),
        task.status === 'waiting'
          ? 'It waits for the human (a step is blocked on their answer). If this message answers it or says go on, mark that step doing or done with task_step and carry on; if they moved on to something else, call task_end(done=false) and answer what they asked.'
          : task.status === 'stalled'
            ? 'It stopped because it was not moving. If the human says go on (继续) or gives a new direction, mark the step you work on with task_step and carry on; if they moved on to something else, call task_end(done=false).'
            : 'Work through the open steps in order. Mark each with task_step as soon as it is done (one line: what was made and where). A step that needs the human (a decision, a login, facts only they have): mark it blocked with the question and ask it. You are started again automatically while steps are open, so never stop to ask "要不要继续". When every step is done, give the human the result.',
        '',
      ] : [
        '## Longer work',
        'For work of several steps (about 3 or more, or anything that may take more than a few minutes), call task_plan with the steps first. The human sees a checklist, your progress is kept, and you are kept going until every step is done - nobody has to say 继续. Quick things need no task.',
        '',
      ]),
      ...this.subscriptionCodingLines(bot),
      '## One shared computer',
      `Every bot sees the same workspace directory: ${this.config.workspaceDir || 'workspace/'}.`,
      'A file you write is immediately visible to every other bot and to the human. Anything outside that directory is somebody else\'s data and needs a human approval.',
      'Memory is different: it is per bot. Only the small shared facts file is common to everyone.',
      '',
      '## What you remember',
      memoryDigest,
      '',
      '## Skills you can use',
      skillsDigest,
      'Call skill_read(name) to load the full steps before you follow one.',
      '',
      '## Tools you have',
      toolDigest,
      ...(() => {
        const missing = this.registry.all().map((t) => t.name).filter((n) => isRequestable(n) && !this.registry.isGranted(bot, n));
        return missing.length
          ? [`Tools you do not have yet: ${missing.join(', ')}. If the work needs one, ask the human with tool_request (it shows them a card) and carry on once granted - never answer that you cannot do it because a tool is missing, and never drop the work.`]
          : [];
      })(),
      '',
      ...machinesSection(this.getApp()?.uiState),
      ...TAKEOVER_RULES,
      ...(effectivePolicy(this.config.policy).mode === 'remote'
        ? ['## This machine', 'This is a remote machine dedicated to you. You may use sudo (it needs no password) and install what you need. Act without asking; only commands that could cut the machine off or wipe it wait for a human.', '']
        : ['## This machine', "This is the human's own computer. Anything that changes it beyond the workspace waits for their approval.", '']),
      '## Approval boundary',
      'Every tool call is classified before it runs:',
      '- LOW runs immediately.',
      `- MEDIUM runs only if your policy auto-approves it (yours: ${bot.policy?.autoApproveMedium ? 'yes' : 'no'}), otherwise a human is asked. Even then, a shell command that may change something asks unless this machine is set to 放手; commands that only look (ls, df, ps | grep, cat) do not.`,
      '- HIGH always asks a human. Writes outside the workspace and denylisted shell commands are HIGH.',
      unattended
        ? 'This turn is UNATTENDED (a routine fired). Nobody is watching, so a HIGH-risk action will NOT wait: the run will stop and report that it needs approval.'
        : 'If a call is waiting for approval, the turn is paused until the human decides.',
      '',
      '## How to work',
      '- Do the work with tools; do not describe what you would do.',
      ...(direct
        ? [
          '- The human sees only your messages, not your tool calls. When the request needs more than a quick step or two (research, several commands, making files), put ONE short sentence in your first reply, next to the tool calls: what you are about to do and roughly how long (e.g. "好，我先查一下 X 的资料，大概一两分钟。"). It reaches them at once, so they are not left waiting. Skip it for quick things. Apart from that one line, never narrate your steps ("next I will", "接着我来"): work, then give the result.',
          '- The result: put the answer or conclusion first, in 1-3 sentences of its own. Details, steps and lists come after. A long answer is shown as several messages, cut at your paragraphs and headings, so give each section a short heading and keep it self-contained. Leave nothing important out. If you must ask something, ask it and stop.',
        ]
        : [
          '- The human sees only your messages, not your tool calls. Never narrate your steps, never say "let me check", "next I will", "先看一下", "接着我来". Work silently and speak once.',
          '- One turn = at most one short message, delivered when you have the result or need a decision. If you must ask something, ask it in that message and stop.',
        ]),
      '- Read the workspace before assuming what is in it.',
      '- A connected app (mail, GitHub, Notion, ...) is used only through its own tools. Never script around one: do not import Nightshift\'s own modules or read its vault, secrets or codes - that skips the human\'s approval. If a tool is too slow for a big job, use it in batches.',
      '- Bulk changes to someone\'s data (mail, files, records): change only what should change. Never move everything out and then move the keepers back; check the list of what you will touch first.',
      '- Save durable facts with memory_write (scope "shared" for things the whole team should know).',
      '- Save a procedure that worked as a skill with skill_save, so the next run is cheaper.',
      bot.primary
        ? '- You can change the whole app: settings_get/settings_update for model and timezone, ui_get/ui_set for theme, timezone mode and the controlled machine, and group_create/group_update/group_delete for team chats. When the human asks for a change, do it; do not tell them to open Settings.'
        : '',
      '- When the task is done, call task_finish. Your last message (or the summary, if you wrote nothing else) must give the human the result itself: what was made, the key content when it is short, and where it is (file paths, page). Never only "done" or a list of steps.',
      '- If you are blocked, say exactly what you need. Do not invent tool output.',
    ]
      .filter((line) => line !== undefined && line !== null)
      .join('\n');
  }

  // -------------------------------------------------------------------------
  // history
  // -------------------------------------------------------------------------

  async loadHistory(botId, limit = 16) {
    const records = await readJsonl(sessionFile(botId));
    const usable = [];
    for (const r of records) {
      if (!((r.kind === 'user' || r.kind === 'assistant') && r.text)) continue;
      const prev = usable[usable.length - 1];
      // An opening line and a reply cut into parts belong to one answer.
      if (prev && r.kind === 'assistant' && prev.kind === 'assistant' && r.turnId && prev.turnId === r.turnId) prev.text = `${prev.text}\n\n${r.text}`;
      else usable.push({ kind: r.kind, text: String(r.text), turnId: r.turnId });
    }
    return usable.slice(-limit).map((r) => ({ role: r.kind, content: r.text }));
  }

  async record(botId, record) {
    if (record?.turnId && this.groupTurns.has(record.turnId)) return;
    try {
      await appendJsonl(sessionFile(botId), { ts: nowIso(), ...record });
    } catch (err) {
      console.error('[session] append failed:', err.message);
    }
  }

  /**
   * Append one message to a group transcript and push it to open group streams.
   * Never throws: a group-log problem must not break the turn that is speaking.
   */
  async recordGroupMessage(groupId, record) {
    if (!this.groups) return null;
    try {
      const message = await this.groups.appendGroupMessage(groupId, record);
      this.bus.emit({ type: 'group.message', groupId, message: this.groups.publicGroupMessage(message) });
      return message;
    } catch (err) {
      console.error('[group] could not append a message:', err.message);
      return null;
    }
  }

  // -------------------------------------------------------------------------
  // the turn
  // -------------------------------------------------------------------------

  /**
   * Run one turn to completion.
   * @returns {{turnId: string, status: string, summary: string, steps: number}}
   */
  async runTurn({
    botId,
    text,
    source = 'chat',
    unattended = false,
    depth = 0,
    // Hand-offs: the bots waiting above this one, and the task's shared budget.
    chain = null,
    handoffBudget = null,
    parentTurnId = null,
    signal = null,
    turnId: providedTurnId = null,
    // Group chats: `group` = {id, name, coordinatorId, members:[{id,name,role}]}.
    // The coordinator's turn owns the group transcript; a member's turn (started
    // by bot_message from a group turn) only writes when it uses group_post.
    group = null,
    groupRole = 'coordinator',
    // Later speakers in one group exchange must not post the human's message again.
    recordUser = true,
    // Said to the model with the text but not shown in the chat (a routine's "last result").
    hiddenNote = '',
    // A new group's round of introductions (not a request from the human).
    kickoff = false,
    // Group coordinator turns that must not plan again (introductions, the final summary).
    noPlan = false,
  }) {
    const bot = await this.bots.getBot(botId);
    const turnModel = (await this.modelFor(bot).catch(() => null)) || this.model;
    if (!bot) throw httpError(404, 'BOT_NOT_FOUND', `no bot with id "${botId}"`);

    const groupContext = group?.id && this.groups ? group : null;
    // The coordinator and any member the human (or the coordinator) @mentioned
    // speak in the group directly; a member reached by bot_message does not.
    const coordinatorTurn = Boolean(groupContext && (groupRole === 'coordinator' || groupRole === 'speaker' || groupRole === 'task'));
    // Task-board tools this turn may use.
    // Talking with the human directly: longer work becomes a task that keeps itself going.
    const direct = !groupContext && !depth && !unattended;
    const boardTools = !groupContext ? (direct ? SOLO_TASK_TOOLS : []) : groupRole === 'coordinator' && !noPlan && !kickoff ? ['group_plan'] : groupRole === 'task' ? ['task_handoff', 'task_ask_member', 'task_ask_human'] : [];
    let boardOutcome = null;

    // The HTTP layer mints the id so it can hand it back before the turn starts.
    const turnId = providedTurnId || uid('turn');
    const controller = new AbortController();
    if (signal) {
      if (signal.aborted) controller.abort();
      else signal.addEventListener('abort', () => controller.abort(), { once: true });
    }
    // What it is doing, for a message the human sends meanwhile (aside()): the
    // task, the step in progress, the latest result, and the human's new words.
    if (coordinatorTurn) this.groupTurns.add(turnId);
    this.active.set(turnId, { controller, botId: bot.id, task: String(text).slice(0, 400), startedAt: Date.now(), steps: 0, step: null, last: '', inbox: [], depth, group: Boolean(group?.id), groupId: group?.id || null, kickoff, unattended });
    const live = this.active.get(turnId);

    // Work until done, like comparable agents: a step is one tool call, and
    // real work (search, open, read, fix, check) easily takes dozens. The old
    // per-bot 12 / 5 min were floors, not ceilings; what stops a runaway turn
    // now is the loop check below and the time budget.
    const maxSteps = Math.min(Math.max(Number(bot.policy?.maxSteps) || 0, 80), 200);
    const maxTurnMs = Math.max(Number(bot.policy?.maxTurnMs) || 0, 30 * 60 * 1000);
    const deadline = Date.now() + maxTurnMs;
    const startedAt = nowIso();
    // Cut off by the step limit with no open checklist: the next turn starts by itself (set below).
    let autoContinue = null;
    // A message from the human starts the count of those automatic turns again.
    if (source !== 'task') this.limitRuns?.delete(botId);

    // Crash-recovery breadcrumb: write the turn as "running" *before* anything
    // can block, so a hard kill still leaves an explanation behind. The write is
    // synchronous on purpose (see store.writeJsonSyncAtomic).
    const persistTurn = (patch) => {
      try {
        writeJsonSyncAtomic(turnFile(turnId), {
          id: turnId,
          botId: bot.id,
          botName: bot.name,
          text: String(text).slice(0, 4000),
          source,
          unattended,
          depth,
          parentTurnId,
          groupId: group?.id || null,
          startedAt,
          updatedAt: nowIso(),
          ...patch,
        });
      } catch (err) {
        console.error('[turn] could not persist turn file:', err.message);
      }
    };
    persistTurn({ status: 'running', steps: 0 });

    // Every event of a coordinator's group turn carries groupId, so a client can
    // follow one group over SSE without seeing other turns.
    const baseEvent = {
      botId: bot.id,
      botName: bot.name,
      turnId,
      source,
      depth,
      parentTurnId,
      unattended,
      ...(coordinatorTurn ? { groupId: group.id } : {}),
    };
    this.bus.emit({ type: 'turn.start', ...baseEvent, text });

    let status = 'success';
    let summary = '';
    let steps = 0;
    let toolsRun = 0;
    let finished = false;
    let waitingFor = null;
    // "停下" from the human: the open task ends now, whatever the bot replies.
    let stoppedByHuman = false;

    try {
      // The human's words come in while a task waits on them: they are the answer.
      let task = direct ? this.activeTask(bot.id) : null;
      if (task && source !== 'task' && isStopWords(text)) {
        task.status = 'stopped';
        task.endNote = '用户让停下';
        await this.taskChanged(task);
        task = null;
        stoppedByHuman = true;
      }
      if (task && source !== 'task') {
        const waiting = task.tasks.find((t) => t.status === 'waiting_human');
        if (waiting && !waiting.answer) { waiting.answer = String(text).slice(0, 1000); await this.taskChanged(task); }
      }
      const systemPrompt = await this.buildSystemPrompt(bot, { unattended, group: groupContext, groupRole, depth, task });
      // A group turn replays the group transcript (not the bot's 1:1 history), so
      // the coordinator can follow the conversation it is answering.
      const history = coordinatorTurn
        ? await this.groups.loadGroupHistory(group.id, {
            names: new Map((group.members || []).map((member) => [member.id, member.name])),
          })
        : await this.loadHistory(bot.id);
      const messages = [
        { role: 'system', content: systemPrompt },
        ...history,
        { role: 'user', content: String(text) + (hiddenNote ? `\n\n${hiddenNote}` : '')
          + (stoppedByHuman ? '\n\n（系统：你手上的任务已经按用户的话停止了，不会再自动接着做。用一句话确认已经停下，说清做到了哪一步、留下了什么；不要再调用工具。）' : '') },
      ];

      if (recordUser) await this.record(bot.id, { kind: 'user', text: String(text), turnId, source });
      if (coordinatorTurn && recordUser) {
        await this.recordGroupMessage(group.id, { kind: 'user', from: 'user', text: String(text), turnId });
      }

      const ctx = {
        bot,
        config: this.config,
        workspaceDir: this.config.workspaceDir,
        turnId,
        unattended,
        depth,
        chain: chain || [bot.id],
        handoffBudget: handoffBudget || null,
        signal: controller.signal,
        // Long tools (video) report what they are waiting for; the chat shows it.
        progress: (text) => this.bus.emit({ type: 'tool.progress', ...baseEvent, text: String(text || '').slice(0, 120) }),
        memory: this.memory,
        skills: this.skills,
        bots: this.bots,
        groups: this.groups,
        app: this.getApp(),
        group: groupContext ? { ...groupContext, role: groupRole } : null,
        groupTurn: coordinatorTurn,
        emit: (event) => this.bus.emit({ ...baseEvent, ...event }),
      };

      const trail = [];
      let fabricationNudged = false;
      // What this turn really did, for checking the final answer's claims.
      const receipts = [];
      // One send-back per turn, shared by the final answer and a task_finish summary.
      const claimState = { nudged: false };
      ctx.receipts = receipts;
      ctx.claimState = claimState;
      // Answers that came back empty (seen live: all 4096 output tokens spent thinking).
      let emptyNudges = 0;
      // Exact repeats of the same call (name + arguments) mean it is stuck.
      const recentCalls = [];
      let stuck = null;
      while (steps < maxSteps) {
        if (controller.signal.aborted) {
          status = 'cancelled';
          summary = 'Turn cancelled.';
          break;
        }
        // Said by the human while this turn worked: read before the next step.
        while (live.inbox.length) {
          messages.push({ role: 'user', content: `（你干活时，用户又发来一条消息，已经先简短回过他了：）\n${live.inbox.shift()}\n（照这句话调整：让你停就收尾停下，让你改就改；和手上的事无关的，做完再处理。）` });
        }
        if (Date.now() > deadline) {
          status = 'timeout';
          summary = `Turn hit its ${Math.round(maxTurnMs / 1000)}s budget after ${steps} step(s).`;
          break;
        }

        // Deltas are emitted while the provider is still producing them. The
        // offset is a character index, so a client can order/concatenate them
        // even if it joined the stream late.
        let deltaOffset = 0;
        const onDelta = (delta) => {
          const chunk = String(delta?.text ?? '');
          if (!chunk) return;
          this.bus.emit({ type: 'message.delta', ...baseEvent, text: chunk, index: deltaOffset });
          deltaOffset += chunk.length;
        };

        // A long turn piles up tool output: only the latest results stay whole.
        trimOldToolOutputs(messages);

        let response;
        try {
          response = await turnModel.complete(messages, {
            tools: [...this.registry.schemasFor(bot), ...groupToolSchemas(boardTools)],
            signal: controller.signal,
            onDelta,
          });
        } catch (err) {
          if (controller.signal.aborted) {
            // A cancel mid-stream surfaces as an abort, not a model failure.
            status = 'cancelled';
            summary = 'Turn cancelled.';
            break;
          }
          status = 'failed';
          summary = `Model error: ${err.message}`;
          this.bus.emit({ type: 'error', ...baseEvent, message: summary });
          break;
        }

        // Cost accounting is a side ledger: a write failure must not fail a turn.
        noteUsage(
          { botId: bot.id, provider: turnModel.provider || '', model: turnModel.model || '', usage: response.usage, source: baseEvent.source },
          { audit, bus: this.bus },
        ).catch(() => {});

        // Nothing at all came back - no words, no tool call - most often because
        // the output limit ran out while it was thinking, or in one long call.
        // Say so and let it try again, instead of ending the turn with no answer.
        if (!response.toolCalls?.length && !String(response.content || '').trim() && emptyNudges < 2 && steps < maxSteps - 1) {
          emptyNudges += 1;
          messages.push({ role: 'user', content: response.finishReason === 'length'
            ? '（系统）你上一次的输出超过了单次输出上限，被截断了，什么都没留下（没有回答，也没有工具调用）。少想多做：直接调用工具动手；长内容分几次用 fs_write 写（后面几次用 mode "append"）；最后的回答简短。'
            : '（系统）你上一次什么都没有返回（没有回答，也没有工具调用）。接着把事情做完：需要动手就调用工具，做完就给出结果。' });
          continue;
        }

        // A reply that reports running something, in a turn that ran nothing,
        // is made up (the model copying earlier output from the chat). Take
        // it back and make it actually run the tool, once.
        if (!response.toolCalls?.length && !trail.length && !fabricationNudged
          && looksLikeMadeUpRun(String(text), String(response.content || ''), this.registry.isGranted(bot, 'shell'))) {
          fabricationNudged = true;
          this.bus.emit({ type: 'message.retract', ...baseEvent });
          messages.push({ role: 'assistant', content: response.content || '' });
          messages.push({ role: 'user', content: '（系统检查）你这一轮没有调用任何工具，却写出了执行结果。不要照着聊天记录或记忆编造输出。用户要你执行的命令，现在就调用 shell 真的执行，再按真实输出回答；做不了就直接说做不了。' });
          continue;
        }

        // The final answer, held against this turn's receipts: a claim with
        // nothing behind it is sent back once to be corrected; if it stays,
        // the answer carries a visible note.
        if (!response.toolCalls?.length && response.content && response.content.trim()) {
          const problems = checkClaims(String(response.content), receipts, { workspaceDir: this.config.workspaceDir, group: Boolean(groupContext) });
          if (problems.length && !claimState.nudged && steps < maxSteps - 1) {
            claimState.nudged = true;
            this.bus.emit({ type: 'message.retract', ...baseEvent });
            messages.push({ role: 'assistant', content: response.content || '' });
            messages.push({ role: 'user', content: `（系统核对）你的回答和这一轮的实际操作对不上：\n- ${problems.join('\n- ')}\n只更正上面这几条，其余说法不用改、也不要重做已经做完的事：做了的才说做了，没做到的直接说没做到；确实还需要做的，现在用工具去做，再按真实结果回答。` });
            continue;
          }
          if (problems.length) {
            response.content = `${response.content}\n\n⚠ 核对：这些说法在这一轮的操作记录里找不到依据——${problems.join('；')}。`;
            audit({ kind: 'claims.unverified', botId: bot.id, turnId, problems }).catch(() => {});
          }
        }

        // What the model said in this very step: a task_finish in the same
        // step must not repeat it as a second message.
        ctx.spokeThisStep = Boolean(response.content && response.content.trim());
        ctx.spokenText = ctx.spokeThisStep ? String(response.content) : '';
        const replyParts = !response.toolCalls?.length && !groupContext && !depth && !unattended && response.content ? splitReply(response.content) : [];
        if (replyParts.length > 1) {
          // The streamed bubble becomes the first part; the rest follow as their own messages.
          for (const [i, part] of replyParts.entries()) {
            this.bus.emit({ type: 'message', ...baseEvent, text: part, final: true, part: i + 1, parts: replyParts.length });
            await this.record(bot.id, { kind: 'assistant', text: part, turnId, source: baseEvent.source, final: true, part: i + 1, parts: replyParts.length });
          }
        } else if (response.content && response.content.trim()) {
          if (deltaOffset === 0) {
            // This provider did not stream (or answered in one piece). Keep the
            // UI alive by chunking the finished text instead of dumping it.
            await this.streamText(baseEvent, bot, turnId, response.content);
          } else {
            // The deltas already reached the browser; just close the message.
            this.bus.emit({ type: 'message', ...baseEvent, text: response.content, final: true });
            await this.record(bot.id, {
              kind: 'assistant',
              text: response.content,
              turnId,
              source: baseEvent.source,
              final: true,
            });
          }
        }

        if (!response.toolCalls?.length) {
          // Plain answer with no tool call: that is the end of the turn.
          messages.push({
            role: 'assistant',
            content: response.content || '',
            ...(response.reasoningContent ? { reasoning_content: response.reasoningContent } : {}),
          });
          summary = response.content?.trim() || '(no answer)';
          // The model sometimes copies an earlier "需要你接管一下屏幕…点「接管屏幕」"
          // reply instead of calling request_takeover, which leaves no button.
          // That sentence only ever comes from our own template, so honour it.
          if (/「接管屏幕」/.test(summary) && /我弄好了，继续/.test(summary)) {
            const reason = (summary.match(/接管一下屏幕[：:]\s*([^\n]+)/) || [])[1]?.trim() || '完成这一步';
            const callId = `auto_takeover_${turnId}`;
            this.bus.emit({ type: 'tool.result', ...baseEvent, callId, name: 'request_takeover', args: JSON.stringify({ reason }), ok: true, risk: 'LOW', result: { waiting: true, reason } });
            await this.record(bot.id, { kind: 'tool', name: 'request_takeover', args: { reason }, ok: true, risk: 'LOW', output: { waiting: true, reason }, turnId });
            waitingFor = 'takeover';
          }
          break;
        }

        // Exactly ONE assistant message per model reply, carrying the text and
        // the tool calls together. Splitting them into
        //   [assistant(text), assistant(tool_calls)]
        // is what DeepSeek's thinking mode rejects with
        //   "The `reasoning_content` in the thinking mode must be passed back to the API."
        // (verified against the live API: the two-message shape 400s, the merged
        // shape 200s, with or without reasoning_content).
        messages.push({
          role: 'assistant',
          content: response.content || '',
          // Thinking models want their chain of thought replayed verbatim when
          // the next request carries the tool result.
          ...(response.reasoningContent ? { reasoning_content: response.reasoningContent } : {}),
          tool_calls: response.toolCalls.map((call) => ({
            id: call.id,
            type: 'function',
            function: { name: call.name, arguments: JSON.stringify(call.arguments || {}) },
          })),
        });

        for (const call of response.toolCalls) {
          toolsRun += 1;
          live.step = { name: call.name, args: call.arguments || call.args || {}, startedAt: Date.now() };
          const outcome = boardTools.includes(call.name)
            ? await this.boardToolCall({ call, ctx, bot, group: groupContext, messages, baseEvent, turnId, request: String(text) })
            : await this.executeToolCall({ call, ctx, bot, turnId, baseEvent, messages });
          live.step = null;
          { const m = messages[messages.length - 1]; live.last = m?.role === 'tool' ? String(m.content || '').slice(-400) : ''; }
          trail.push(outcome?.ok === false ? `${call.name}✗` : call.name);
          receipts.push({ name: call.name, args: call.arguments || call.args || {}, ok: outcome?.ok !== false && !outcome?.error });
          if (trail.length > 12) trail.shift();
          recentCalls.push(`${call.name} ${JSON.stringify(call.args ?? call.arguments ?? '')}`);
          if (recentCalls.length > 3) recentCalls.shift();
          if (!stuck && recentCalls.length === 3 && recentCalls.every((c) => c === recentCalls[0])) stuck = call.name;
          // Roster edits made by a tool are invisible to every other window
          // (and to the sidebar of the very window that ran it), so announce
          // them. The UI re-reads /api/bots instead of guessing the diff.
          if (/^(bot_create|bot_update|bot_delete|group_create|group_update|group_delete)$/.test(call.name)) {
            this.bus.emit({
              type: 'roster.changed',
              scope: call.name.startsWith('group') ? 'groups' : 'bots',
              action: call.name,
              by: bot.id,
              turnId,
            });
          }
          // Handing the screen to the human ends the turn: nothing to do until
          // they finish (they press "我弄好了，继续" in the card).
          if (call.name === 'request_login' && outcome?.ok !== false) {
            const what = String((call.arguments || call.args || {}).name || '').trim() || '这个网站';
            summary = `等你填写「${what}」的登录信息`;
            waitingFor = 'login';
            await this.streamText(baseEvent, bot, turnId, `需要「${what}」的登录信息。\n\n在下面的表单里填写，内容会加密存进这台机器的保险箱，我看不到；填好后点「保存并继续」。`);
            finished = true;
            break;
          }
          if (call.name === 'request_takeover' && outcome?.ok !== false) {
            const what = String((call.arguments || call.args || {}).reason || '').trim() || '完成这一步';
            summary = `等你接管屏幕：${what}`;
            waitingFor = 'takeover';
            await this.streamText(baseEvent, bot, turnId, `需要你接管一下屏幕：${what}\n\n点下面的「接管屏幕」，弄好后点「我弄好了，继续」。`);
            finished = true;
            break;
          }
          if (outcome.termination) {
            status = outcome.termination;
            summary = outcome.summary || summary;
            finished = true;
            break;
          }
          if (outcome.board) {
            boardOutcome = outcome.board;
            summary = outcome.board.say || summary;
            finished = true;
            break;
          }
          if (outcome.finalSummary) {
            summary = outcome.finalSummary;
            finished = true;
            break;
          }
        }

        steps += 1;
        live.steps = steps;
        if (finished) break;
        if (status === 'needs_approval') break;
        if (stuck) {
          status = 'max_steps';
          summary = `Stopped: repeated ${stuck} three times.`;
          const note = `同一个操作（${stuck}）原样重复了 3 次，看起来卡住了，我先停下。\n\n告诉我换个思路，或者回一句「继续」让我再试。`;
          await this.record(bot.id, { kind: 'assistant', text: note, turnId, source, system: true });
          this.bus.emit({ type: 'message', ...baseEvent, text: note, final: true, system: true });
          break;
        }
      }

      if (!finished && !stuck && status === 'success' && steps >= maxSteps) {
        status = 'max_steps';
        const last = trail.slice(-4).join(' → ') || '（没有工具调用）';
        summary = `Stopped after ${maxSteps} steps.`;
        // Say it in the chat, not only in the status row: a silent stop looks
        // like a crash.
        // With a task the note says what really happens next (seen: every step
        // done, yet "回一句「继续」" - and an open task goes on by itself anyway).
        const tsk = direct ? this.tasks?.get(bot.id) : null;
        const open = tsk ? openSteps(tsk).length : 0;
        const taskGoesOn = Boolean(tsk && tsk.status === 'running' && open);
        // Without an open checklist (none, or every step ticked while work went
        // on - seen on Ubuntu) a direct chat goes on by itself too, a few times
        // per message from the human; going round in circles stopped it earlier.
        const used = this.limitRuns?.get(bot.id) || 0;
        if (direct && !taskGoesOn && used < LIMIT_CONTINUATIONS) autoContinue = { goal: tsk && tsk.status === 'done' ? tsk.goal : '' };
        const note = taskGoesOn
          ? `这一轮已经做了 ${steps} 步，到了单轮的上限。任务「${tsk.goal}」还有 ${open} 步没做完，我会自动接着做，不用回「继续」。`
          : autoContinue
            ? `这一轮已经做了 ${steps} 步，到了单轮的上限。我会自动接着做（第 ${used + 1} 次，最多 ${LIMIT_CONTINUATIONS} 次），做完就告诉你结果，不用回「继续」；要停就点停止或直接说。`
            : `这件事已经做了 ${steps} 步还没完成${used ? `（已经自动接着做了 ${used} 次）` : ''}，我先停一下，免得白白消耗额度。\n\n`
              + `最后几步：${last}\n\n`
              + '如果还要继续，回一句「继续」我就接着做；如果方向不对，告诉我该改哪里。';
        await this.record(bot.id, { kind: 'assistant', text: note, turnId, source, system: true });
        this.bus.emit({ type: 'message', ...baseEvent, text: note, final: true, system: true });
      }

      if (status === 'needs_approval') {
        // An unattended run must not hang and must not silently swallow the need
        // for a human: say it out loud in the chat.
        const note =
          `${summary} Nobody was watching, so this routine stopped instead of waiting. ` +
          'Approve it in the Activity tab, then run the routine again.';
        await this.record(bot.id, { kind: 'assistant', text: note, turnId, source, system: true });
        this.bus.emit({ type: 'message', ...baseEvent, text: note, final: true, system: true });
      }

      return { turnId, status, summary: summary || statusText(status), steps, ...(boardOutcome ? { board: boardOutcome } : {}) };
    } catch (err) {
      status = 'failed';
      summary = `Turn failed: ${err.message}`;
      this.bus.emit({ type: 'error', ...baseEvent, message: summary });
      return { turnId, status, summary, steps };
    } finally {
      this.active.delete(turnId);
      const endedAt = nowIso();
      await this.record(bot.id, {
        kind: 'turn',
        turnId,
        status,
        summary,
        startedAt,
        endedAt,
        steps,
        source,
      });
      if (coordinatorTurn) {
        // A group turn must never be silent: if the coordinator did not speak in
        // the group with group_post, its final answer becomes the group message
        // (checked against the transcript so it is never posted twice).
        if (status !== 'cancelled' && summary) {
          const spoke = await this.groups.hasAssistantMessage(group.id, turnId, bot.id).catch(() => false);
          if (!spoke) {
            await this.recordGroupMessage(group.id, { kind: 'assistant', from: bot.id, text: stripOwnTag(summary, bot.name), turnId });
          }
        }
        await this.recordGroupMessage(group.id, { kind: 'status', from: bot.id, status, turnId });
      }
      // "done" covers every finished outcome; a run that parked itself for a
      // human is the only one that needs the UI to draw attention to it.
      persistTurn({
        status: turnFileStatus(status),
        resultStatus: status,
        summary: summary || statusText(status),
        steps,
        endedAt,
      });
      this.bus.emit({
        type: 'turn.end',
        ...baseEvent,
        status,
        summary: summary || statusText(status),
        steps,
        startedAt,
        endedAt,
        ...(waitingFor ? { waitingFor } : {}),
      });
      this.groupTurns.delete(turnId);
      if (direct) this.afterTaskTurn(bot.id, status, waitingFor, { fromHuman: source !== 'task', toolsRun }).catch(() => {});
      // Cut off by the step limit with no open checklist: the next turn starts
      // by itself. The bot decides - finished: say the result; not: go on.
      if (autoContinue) {
        this.limitRuns = this.limitRuns || new Map();
        const n = (this.limitRuns.get(bot.id) || 0) + 1;
        this.limitRuns.set(bot.id, n);
        const what = autoContinue.goal ? `任务「${autoContinue.goal}」` : `用户交给你的事（他的原话：「${String(text).slice(0, 300)}」）`;
        const timer = setTimeout(() => this.runTurn({
          botId: bot.id,
          source: 'task',
          recordUser: false,
          text: `（系统自动发起，用户没有发新消息；第 ${n} 次自动接着做）${what}，上一轮做到单轮步数上限被打断了。先看清楚做到了哪一步（工作区的文件、你的笔记、刚才的结果），不要重做已经做完的事，也不用开场白：\n- 如果已经做完：用几句话告诉用户结果（做成了什么、在哪里、多少、有没有没做成的），不要再调用工具；\n- 如果还没做完：接着做，做完再给结果。批量的活尽量用一次能处理很多的工具，少走步数。`,
        }).catch(() => {}), this.taskDelayMs ?? 1500);
        timer.unref?.();
      }
    }
  }

  /**
   * One human message in a group, the way people expect a group to work:
   *   - members the human @mentions answer, in that order ("@所有人" = everyone)
   *   - nobody mentioned: the coordinator answers, and any member it @mentions
   *     answers right after it (progress questions reach every owner)
   * Speakers run one after another so the transcript reads in order.
   */
  async runGroupMessage({ group, text, turnId = null, recordUser = true, kickoff = false }) {
    const members = group.members || [];
    const byId = new Map(members.map((m) => [m.id, m]));
    const asked = mentionedMembers(text, members);
    const first = asked.length ? asked : [byId.get(group.coordinatorId) || members[0]].filter(Boolean);
    const queue = first.map((m) => ({ member: m, role: asked.length ? 'speaker' : 'coordinator' }));
    const done = new Set();
    let record = recordUser;
    let id = turnId;
    while (queue.length && done.size < 6) {
      const { member, role, prompt } = queue.shift();
      if (done.has(member.id)) continue;
      done.add(member.id);
      const result = member.remote ? await this.runRemoteGroupTurn({ group, member, text: prompt || text, role, turnId: id, recordUser: record }) : await this.runTurn({
        botId: member.id,
        text: prompt || text,
        source: 'group',
        turnId: id || undefined,
        group,
        groupRole: role,
        recordUser: record,
        kickoff,
      }).catch((err) => {
        this.bus.emit({ type: 'error', groupId: group.id, turnId: id, message: err.message });
        return null;
      });
      record = false;
      id = null;
      // The coordinator split the work: the task board runs it (and it sums up at the end).
      if (role === 'coordinator' && result?.board?.plan) {
        const plan = result.board.plan;
        await this.recordGroupMessage(group.id, { kind: 'plan', from: member.id, planId: plan.id, text: planText(plan, new Map(members.map((m) => [m.id, m.name]))) });
        await this.runPlan(group, plan);
        break;
      }
      // The coordinator handed parts of the request to teammates by @name.
      if (!kickoff && role === 'coordinator' && result?.turnId) {
        const said = (await this.groups.readGroupMessages(group.id, { limit: 40 }).catch(() => []))
          .filter((m) => m.turnId === result.turnId && m.from === member.id && (m.kind || 'assistant') === 'assistant')
          .map((m) => m.text)
          .join('\n');
        for (const next of mentionedMembers(said, members.filter((m) => m.id !== member.id))) {
          queue.push({
            member: next,
            role: 'speaker',
            prompt: `${member.name} 在群里点名请你回答。用户原话：${text}`,
          });
        }
      }
    }
  }

  /**
   * group_plan / task_handoff / task_ask_human: checked and answered here;
   * the outcome ends the turn and tells the caller what to do next.
   */
  async boardToolCall({ call, bot, group, messages, baseEvent, turnId, request }) {
    if (SOLO_TASK_TOOLS.includes(call.name)) return this.soloToolCall({ call, bot, messages, baseEvent, turnId, request });
    const args = call.arguments || {};
    const members = group.members || [];
    let result;
    let board = null;
    if (call.name === 'group_plan') {
      const made = makePlan({ group, request, coordinatorId: bot.id, tasks: args.tasks });
      if (made.error) result = { error: { code: 'BAD_PLAN', message: made.error } };
      else {
        const names = new Map(members.map((m) => [m.id, m.name]));
        const owners = [...new Set(made.plan.tasks.map((t) => names.get(t.owner) || t.owner))];
        result = { ok: true, planId: made.plan.id, tasks: made.plan.tasks.length };
        board = { plan: made.plan, say: `分成 ${made.plan.tasks.length} 项，由${owners.join('、')}分别负责，做完我来汇总。` };
      }
    } else if (call.name === 'task_ask_member') {
      const to = resolveMember(members, args.to);
      const request = String(args.request || '').trim();
      if (!to || to.id === bot.id) result = { error: { code: 'BAD_MEMBER', message: `「${args.to || ''}」不是群里的其他成员（成员：${members.map((m) => m.name).join('、')}）` } };
      else if (!request) result = { error: { code: 'NO_REQUEST', message: 'request 不能为空' } };
      else { result = { ok: true }; board = { askMember: { to: to.id, request: request.slice(0, 1500) }, say: `@${to.name} 请帮个忙：${request.slice(0, 400)}` }; }
    } else if (call.name === 'task_handoff') {
      const to = resolveMember(members, args.to);
      if (!to || to.id === bot.id) result = { error: { code: 'BAD_MEMBER', message: `「${args.to || ''}」不是群里的其他成员（成员：${members.map((m) => m.name).join('、')}）` } };
      else { result = { ok: true }; board = { handoff: { to: to.id, note: String(args.note || '').slice(0, 800) }, say: `这项交给「${to.name}」：${String(args.note || '').slice(0, 300)}` }; }
    } else {
      const question = String(args.question || '').trim();
      if (!question) result = { error: { code: 'NO_QUESTION', message: 'question 不能为空' } };
      else { result = { ok: true }; board = { askHuman: question.slice(0, 1000), say: `需要你回复一下：${question.slice(0, 1000)}` }; }
    }
    this.pushToolResult(messages, call, result);
    this.bus.emit({ type: 'tool.result', ...baseEvent, callId: call.id, name: call.name, args: truncateJson(args, 2000), ok: !result.error, risk: 'LOW', result });
    return board ? { board } : {};
  }

  // ---- 1:1 tasks ------------------------------------------------------------

  /** The bot's open task (running, waiting for the human, or stopped for lack of progress), or null. */
  activeTask(botId) {
    const t = this.tasks?.get(botId);
    return t && TASK_OPEN.includes(t.status) ? t : null;
  }

  /** A task changed: save it and tell the bot's windows. */
  async taskChanged(plan) {
    await savePlan(plan).catch(() => {});
    this.bus.emit({ type: 'bot.plan', botId: plan.botId, plan });
  }

  async soloToolCall({ call, bot, messages, baseEvent, turnId, request }) {
    const args = call.arguments || {};
    this.tasks = this.tasks || new Map();
    const cur = this.activeTask(bot.id);
    let result;
    if (call.name === 'task_plan') {
      const made = makeTask({ botId: bot.id, request, goal: args.goal, steps: args.steps });
      if (made.error) result = { error: { code: 'BAD_TASK', message: made.error } };
      else {
        if (cur) { cur.status = 'replaced'; await this.taskChanged(cur); }
        this.tasks.set(bot.id, made.plan);
        await this.record(bot.id, { kind: 'plan', planId: made.plan.id, text: `任务：${made.plan.goal}`, turnId });
        await this.taskChanged(made.plan);
        result = { ok: true, steps: made.plan.tasks.length, next: 'Start on step 1 now. Mark each step with task_step when it is done; you are started again automatically until every step is done.' };
      }
    } else if (!cur) {
      result = { error: { code: 'NO_TASK', message: 'there is no open task: call task_plan first' } };
    } else if (call.name === 'task_step') {
      const r = updateStep(cur, args);
      if (r.error) result = { error: { code: 'BAD_STEP', message: r.error } };
      else {
        // The human answered or said go on: the task runs again, with a fresh budget.
        if (args.status !== 'blocked' && (cur.status === 'waiting' || cur.status === 'stalled')) {
          cur.status = 'running'; cur.stalls = 0; cur.continuations = 0; cur.lastDone = doneSteps(cur);
        }
        const open = openSteps(cur).length;
        if (!open && cur.status === 'running') cur.status = 'done';
        await this.taskChanged(cur);
        result = {
          ok: true,
          open,
          ...(cur.status === 'waiting' ? { next: 'Ask the human your question in your reply now and stop; the task waits for their answer.' } : open ? {} : { next: 'Every step is done: give the human the result (what was made, where it is).' }),
        };
      }
    } else {
      cur.status = args.done ? 'done' : 'stopped';
      if (args.note) cur.endNote = String(args.note).slice(0, 500);
      await this.taskChanged(cur);
      result = { ok: true };
    }
    this.pushToolResult(messages, call, result);
    this.bus.emit({ type: 'tool.result', ...baseEvent, callId: call.id, name: call.name, args: truncateJson(args, 2000), ok: !result.error, risk: 'LOW', result });
    await this.record(bot.id, { kind: 'tool', name: call.name, args, ok: !result.error, risk: 'LOW', output: result, turnId });
    return {};
  }

  /** A direct turn ended: keep an open task going, park it, or stop it. */
  async afterTaskTurn(botId, status, waitingFor, { fromHuman = false, toolsRun = 1 } = {}) {
    const plan = this.activeTask(botId);
    if (!plan) return;
    if (status === 'cancelled') { plan.status = 'stopped'; await this.taskChanged(plan); return; }
    // The human answered a parked task and the bot got back to work: it goes on by itself again.
    if (fromHuman && toolsRun && !waitingFor && (plan.status === 'waiting' || plan.status === 'stalled') && status === 'success') {
      plan.status = 'running'; plan.stalls = 0; plan.continuations = 0; plan.lastDone = doneSteps(plan);
      await this.taskChanged(plan);
    }
    if (plan.status !== 'running') return;
    if (waitingFor) { plan.status = 'waiting'; await this.taskChanged(plan); return; }
    // The human said something and the bot only talked (a question, "why so
    // slow", "wait"): the task waits for them instead of carrying on by itself
    // (seen: after "停下" it answered "I will stop" and went on anyway). Their
    // next message, or a step marked done, sets it going again.
    if (fromHuman && !toolsRun) { plan.status = 'waiting'; await this.taskChanged(plan); return; }
    if (status === 'failed') return; // a model error: the next message (or a restart) picks it up
    const timer = setTimeout(() => this.continueTask(botId).catch((err) => this.bus.emit({ type: 'error', botId, message: err.message })), this.taskDelayMs ?? 1500);
    timer.unref?.();
  }

  /** Start the next turn of an open task, or stop it when it is not moving. */
  async continueTask(botId) {
    const plan = this.activeTask(botId);
    if (!plan || plan.status !== 'running') return;
    // The human is talking to it right now: that turn's end comes back here.
    if ([...this.active.values()].some((info) => info.botId === botId)) return;
    if (!openSteps(plan).length) { plan.status = 'done'; await this.taskChanged(plan); return; }
    const done = doneSteps(plan);
    // Only turns it took on by itself count: the planning turn often just writes the plan (seen live).
    plan.stalls = done > (plan.lastDone || 0) || !plan.continuations ? 0 : (plan.stalls || 0) + 1;
    plan.lastDone = done;
    let text;
    if (plan.stalls >= 2 || (plan.continuations || 0) >= TASK_MAX_CONTINUATIONS) {
      plan.status = 'stalled';
      await this.taskChanged(plan);
      text = `（系统自动发起，用户没有发新消息）任务「${plan.goal}」${plan.stalls >= 2 ? '连续两轮没有新完成的步骤' : `已经自动接着做了 ${plan.continuations} 轮`}，先停下来。进度：\n${taskText(plan)}\n用两三句话告诉用户：做到哪了、卡在哪、需要他做什么；他回一句「继续」或给个新方向就会接着做。这一轮不要再调用工具。`;
    } else {
      plan.continuations = (plan.continuations || 0) + 1;
      await this.taskChanged(plan);
      text = `（任务继续，系统自动发起，用户没有发新消息）目标：${plan.goal}\n进度：\n${taskText(plan)}\n接着做下一个没完成的步骤，不用开场白，不要重做已经完成的步骤；每做完一步马上用 task_step 标记。全部做完后给用户最终结果（结果本身和文件路径）。`;
    }
    await this.runTurn({ botId, text, source: 'task', recordUser: false });
  }

  /** After a restart: open tasks from the last day are picked up again. */
  async resumeTasks({ delayMs = 20000 } = {}) {
    this.tasks = this.tasks || new Map();
    const cutoff = Date.now() - 24 * 3600 * 1000;
    const open = (await listPlans()).filter((p) => p.kind === 'task' && TASK_OPEN.includes(p.status) && Date.parse(p.updatedAt || 0) > cutoff)
      .sort((a, b) => Date.parse(a.updatedAt) - Date.parse(b.updatedAt));
    for (const p of open) this.tasks.set(p.botId, p); // the newest per bot wins
    const running = [...this.tasks.values()].filter((p) => p.status === 'running');
    for (const p of running) {
      const timer = setTimeout(() => this.continueTask(p.botId).catch(() => {}), delayMs);
      timer.unref?.();
    }
    return running.length;
  }

  /** The task board a group is working through (or waiting on), from memory or disk. */
  async groupPlan(groupId) {
    this.plans = this.plans || new Map();
    return this.plans.get(groupId) || null;
  }

  /** A plan changed: save it and tell the group's windows. */
  async boardChanged(plan) {
    this.plans = this.plans || new Map();
    this.plans.set(plan.groupId, plan);
    await savePlan(plan).catch(() => {});
    this.bus.emit({ type: 'group.plan', groupId: plan.groupId, plan });
  }

  /**
   * Work through a group's task board: start every task whose inputs are done
   * (at most three at once), each by its owner - here, or on its own machine -
   * then ask the coordinator to put the results together. A task waiting for
   * the human parks the board until they answer (answerBoard).
   */
  async runPlan(group, plan) {
    const members = group.members || [];
    const byId = new Map(members.map((m) => [m.id, m]));
    const names = new Map(members.map((m) => [m.id, m.name]));
    plan.status = 'running';
    await this.boardChanged(plan);
    const running = new Map();
    for (;;) {
      skipBlocked(plan);
      if (plan.status === 'stopped') break;
      for (const t of readyTasks(plan)) {
        if (running.size >= 3) break;
        if (running.has(t.id)) continue;
        running.set(t.id, this.runPlanTask(group, plan, t, byId, names).finally(() => running.delete(t.id)));
      }
      if (!running.size) break;
      // Wake up when a task ends - or when the human answers a waiting task (answerBoard).
      this.planWakers = this.planWakers || new Map();
      await Promise.race([...running.values(), new Promise((resolve) => this.planWakers.set(plan.id, resolve))]);
    }
    this.planWakers?.delete(plan.id);
    if (plan.status === 'stopped') { await this.boardChanged(plan); return; }
    if (plan.tasks.some((t) => t.status === 'waiting_human')) {
      plan.status = 'waiting';
      await this.boardChanged(plan);
      return;
    }
    // Everyone is done: the coordinator puts it together for the human.
    const report = plan.tasks.map((t, i) => `${i + 1}. ${t.title}（${names.get(t.owner) || t.owner}，${t.status === 'done' ? '完成' : t.status === 'skipped' ? '跳过' : '没做成'}）：${String(t.result || '').slice(0, 1500)}`).join('\n\n');
    await this.runTurn({
      botId: plan.coordinatorId,
      text: `（任务板做完了）用户的原始请求：${plan.request}\n\n各项结果：\n${report}\n\n把这些结果整合成交给用户的最终答复：结果本身、文件路径；没做成的说明原因和下一步。不要再分工。`,
      source: 'group',
      group,
      groupRole: 'coordinator',
      recordUser: false,
      noPlan: true,
    }).catch((err) => this.bus.emit({ type: 'error', groupId: group.id, message: err.message }));
    plan.status = 'done';
    await this.boardChanged(plan);
  }

  /** One task, by its owner. A hand-off or a question for the human comes back as the task's new state. */
  async runPlanTask(group, plan, task, byId, names) {
    const owner = byId.get(task.owner);
    task.status = 'doing';
    task.startedAt = nowIso();
    await this.boardChanged(plan);
    const inputs = task.needs.map((id) => plan.tasks.find((t) => t.id === id)).filter(Boolean)
      .map((t) => `- ${t.title}（${names.get(t.owner) || t.owner}）的结果：${String(t.result || '').slice(0, 1500)}`).join('\n');
    const prompt = [
      `（群「${group.name}」的任务板）用户的原始请求：${plan.request}`,
      `你负责的任务：${task.title}`,
      task.brief ? `要求：${task.brief}` : '',
      task.deliverable ? `交付：${task.deliverable}` : '',
      inputs ? `前面几项的结果（可以直接用）：\n${inputs}` : '',
      task.handoffFrom ? `这项是「${names.get(task.handoffFrom) || task.handoffFrom}」交给你的：${task.handoffNote || ''}` : '',
      task.question ? `你之前问过用户：${task.question}\n用户的回答：${task.answer || '（没有回答）'}` : '',
      (() => {
        if (!owner || owner.remote || !Array.isArray(owner.tools)) return '';
        const lack = toolsForText(`${task.title} ${task.brief || ''} ${task.deliverable || ''}`).filter((n) => !owner.tools.includes(n));
        return lack.length ? `这项多半要用 ${lack.map(toolLabel).join('、')}，你还没有：先用 tool_request 向用户申请（说明这项任务要用），批了就接着做；不批再想别的办法或说明做不了的原因。` : '';
      })(),
      '把这项做完，然后用一段话汇报结果和文件路径。',
    ].filter(Boolean).join('\n\n');
    let res;
    if (!owner) res = { status: 'failed', summary: '负责人已经不在群里' };
    else if (owner.remote) res = await this.runRemoteGroupTurn({ group, member: owner, text: prompt, role: 'task' });
    else {
      res = await this.runTurn({ botId: owner.id, text: prompt, source: 'group', group, groupRole: 'task', recordUser: false })
        .catch((err) => ({ status: 'failed', summary: err.message }));
    }
    task.endedAt = nowIso();
    // Hand-offs: as many as there are other members (each may take it once);
    // passing it back to someone who already passed it on is going round in
    // circles - stop and leave it to the coordinator.
    const handoffLimit = Math.max(3, (group.members || []).length - 1);
    const backTo = res?.board?.handoff && (task.handedBy || []).includes(res.board.handoff.to);
    if (res?.board?.handoff && ((task.handoffs || 0) >= handoffLimit || backTo)) {
      task.status = 'failed';
      task.result = backTo
        ? `这项在成员之间来回推（又要交回给「${names.get(res.board.handoff.to) || res.board.handoff.to}」），停下来等协调者处理。`
        : `这项已经被移交了 ${task.handoffs} 次，停下来等协调者处理。`;
    } else if (res?.board?.handoff) {
      task.handoffs = (task.handoffs || 0) + 1;
      task.handedBy = [...new Set([...(task.handedBy || []), task.owner])];
      task.handoffFrom = task.owner;
      task.handoffNote = res.board.handoff.note;
      task.owner = res.board.handoff.to;
      task.status = 'todo';
      task.question = '';
    } else if ((res?.board?.askMember || askedByMention(res, task, owner, group)) && (task.helps || 0) < 3) {
      const ask = res.board?.askMember || askedByMention(res, task, owner, group);
      const helper = {
        id: `t${plan.tasks.length + 1}`,
        title: `协助「${task.title}」`.slice(0, 120),
        owner: ask.to,
        brief: `「${names.get(task.owner) || task.owner}」在做「${task.title}」，请你帮忙：${ask.request}`,
        deliverable: '把结果直接写在你的汇报里（有文件就写路径）',
        needs: [],
        status: 'todo',
        result: '',
        helperFor: task.id,
      };
      plan.tasks.push(helper);
      task.helps = (task.helps || 0) + 1;
      task.needs = [...new Set([...task.needs, helper.id])];
      task.status = 'todo';
    } else if (res?.board?.askHuman) {
      task.status = 'waiting_human';
      task.question = res.board.askHuman;
      task.answer = '';
    } else if (res?.status === 'cancelled') {
      task.status = 'stopped';
      plan.status = 'stopped';
      for (const t of plan.tasks) if (t.status === 'todo') t.status = 'stopped';
    } else {
      // A turn that ended with nothing to show did not do the task.
      const empty = !String(res?.summary || '').trim() || String(res?.summary).trim() === '(no answer)';
      task.status = res?.status === 'success' && !empty ? 'done' : 'failed';
      task.result = empty ? '没有给出任何结果（回答是空的）。' : String(res?.summary || '').slice(0, 4000);
    }
    await this.boardChanged(plan);
  }

  /** The human answered a task's question: it goes back to work, the board goes on. -> true when it took the message */
  async answerBoard(group, text) {
    const plan = await this.groupPlan(group.id);
    // A task asked the human: the next thing they say in the group is the answer,
    // even while other tasks are still running.
    const waiting = plan && ['waiting', 'running'].includes(plan.status) && plan.tasks.find((t) => t.status === 'waiting_human');
    if (!waiting) return false;
    await this.recordGroupMessage(group.id, { kind: 'user', from: 'user', text: String(text) });
    waiting.answer = String(text).slice(0, 2000);
    waiting.status = 'todo';
    await this.boardChanged(plan);
    const wake = this.planWakers?.get(plan.id);
    if (plan.status === 'running' && wake) wake();
    else this.runPlan(group, plan).catch((err) => this.bus.emit({ type: 'error', groupId: group.id, message: err.message }));
    return true;
  }

  /**
   * A group member that lives on another machine takes its turn there: it gets
   * the recent group conversation, and its answer is posted here under its name.
   */
  async runRemoteGroupTurn({ group, member, text, role, turnId = null, recordUser = false }) {
    const id = turnId || uid('turn');
    if (recordUser) await this.recordGroupMessage(group.id, { kind: 'user', from: 'user', text: String(text), turnId: id });
    const base = { botId: member.id, botName: member.name, turnId: id, source: 'group', groupId: group.id };
    const startedAt = nowIso();
    this.bus.emit({ type: 'turn.start', ...base, text });
    let status = 'success';
    let summary = '';
    let remoteKey = null;
    try {
      const peers = this.getPeers();
      const peer = peers?.find(member.remote.machine);
      if (!peer) throw new Error(`这台机器不认识「${member.remote.machine}」（在长明客户端里添加那台机器后再试）`);
      const names = new Map((group.members || []).map((m) => [m.id, m.name]));
      const recent = (await this.groups.readGroupMessages(group.id, { limit: 14 }).catch(() => []))
        .filter((m) => (m.kind === 'user' || m.kind === 'assistant') && m.text)
        .map((m) => `${m.from === 'user' ? '用户' : (names.get(m.from) || m.from)}：${String(m.text).slice(0, 600)}`)
        .join('\n');
      const who = (group.members || []).map((m) => `${m.name}（${m.role || '成员'}）`).join('、');
      const prompt = `（你是群聊「${group.name}」的成员，这个群在另一台机器上；成员：${who}。${role === 'speaker' ? '现在点名请你回答。' : ''}你的回答会以你的名字发到群里：只回答你负责的部分，简短；做出的文件写出路径，会自动取到群所在的机器。）\n\n最近的群聊：\n${recent || '（还没有消息）'}\n\n现在要你回答的话：${text}`;
      // While it answers there, a new group message gets a quick status reply here and waits (see below).
      remoteKey = `remote_${id || uid('turn')}`;
      this.active?.set(remoteKey, { controller: new AbortController(), botId: member.id, remote: true, machine: member.remote.machine, memberName: member.name, task: String(text).slice(0, 300), startedAt: Date.now(), steps: 0, step: null, last: '', inbox: [], depth: 0, group: true, groupId: group.id, kickoff: role === 'kickoff' });
      const r = await askPeerBot(peers, peer, {
        botId: member.remote.botId,
        text: prompt,
        handoff: { depth: 1, chain: [`group:${group.id}`, member.remote.botId], budgetLeft: 4, from: { bot: `群「${group.name}」` } },
        workspaceDir: this.config.workspaceDir,
      });
      status = r.status === 'success' ? 'success' : (r.status || 'failed');
      summary = r.reply || '';
      await this.recordGroupMessage(group.id, { kind: 'assistant', from: member.id, text: (r.reply || '（没有回答）') + fetchedNote(r.fetched, member.remote.machine), turnId: id });
    } catch (err) {
      status = 'failed';
      summary = err.message;
      await this.recordGroupMessage(group.id, { kind: 'assistant', from: member.id, text: `（没能联系上「${member.remote.machine}」上的${member.name}：${err.message}）`, turnId: id });
    }
    this.bus.emit({ type: 'turn.end', ...base, status, summary, steps: 0, startedAt, endedAt: nowIso() });
    // Messages sent while it was away: the group takes them up now, in order.
    const waiting = remoteKey ? (this.active?.get(remoteKey)?.inbox || []) : [];
    if (remoteKey) this.active?.delete(remoteKey);
    for (const said of waiting) {
      this.runGroupMessage({ group, text: said, recordUser: false }).catch((err) => this.bus.emit({ type: 'error', groupId: group.id, message: err.message }));
    }
    return { turnId: id, status, summary };
  }

  /** Kick off a just-created group by id (resolves member names; skipped in demo mode). */
  async kickoffGroup(groupId) {
    if (!this.groups || this.model?.provider === 'mock') return;
    const group = await this.groups.getGroup(groupId).catch(() => null);
    if (!group) return;
    const members = [];
    for (const id of group.members || []) {
      const far = group.remotes?.[id];
      if (far) { members.push({ id, name: far.name, role: far.role, remote: { machine: far.machine, botId: far.botId } }); continue; }
      const bot = await this.bots.getBot(id).catch(() => null);
      if (bot) members.push({ id: bot.id, name: bot.name, role: bot.role });
    }
    if (members.length < 2) return;
    await this.runGroupKickoff({ id: group.id, name: group.name, coordinatorId: group.coordinatorId, members });
  }

  /** A new group says hello: each member, in order, states its job and where it stands. */
  async runGroupKickoff(group) {
    const prompt = '（这个群刚建好）请用一两句话向大家介绍：你在这个群里负责什么、现在的进度、下一步要做什么。不要 @ 别人。';
    const everyone = (group.members || []).map((m) => `@${m.name}`).join(' ');
    await this.runGroupMessage({ group, text: `${everyone} ${prompt}`, recordUser: false, kickoff: true });
  }

  /**
   * Emit a completed assistant message as a series of deltas (the UI renders
   * them as a stream) followed by a final message event. This is the fallback
   * for text that did not arrive as deltas from the provider (closing
   * task_finish summaries, non-streaming providers). No artificial delay: the
   * mock answers instantly and a fake typewriter effect would just be lies.
   */
  async streamText(baseEvent, bot, turnId, content, { split = false } = {}) {
    const text = String(content);
    // A long answer to the human (also a task_finish summary): several messages.
    const parts = split ? splitReply(text) : [text];
    if (parts.length > 1) {
      for (const [i, part] of parts.entries()) {
        this.bus.emit({ type: 'message', ...baseEvent, text: part, final: true, part: i + 1, parts: parts.length });
        await this.record(bot.id, { kind: 'assistant', text: part, turnId, source: baseEvent.source, final: true, part: i + 1, parts: parts.length });
      }
      return;
    }
    const CHUNK = 28;
    for (let i = 0; i < text.length; i += CHUNK) {
      this.bus.emit({ type: 'message.delta', ...baseEvent, text: text.slice(i, i + CHUNK), index: i });
    }
    this.bus.emit({ type: 'message', ...baseEvent, text, final: true });
    await this.record(bot.id, { kind: 'assistant', text, turnId, source: baseEvent.source, final: true });
  }

  /**
   * Classify, maybe ask, then run one tool call. Returns
   *   { finalSummary }  -> task_finish happened
   *   { termination }  -> needs_approval (unattended) or cancelled
   */
  async executeToolCall({ call, ctx, bot, turnId, baseEvent, messages }) {
    // mcp_call is a way to reach a connected app's tool that did not fit in the
    // request: from here on it IS that tool (grant, approval, record).
    if (call.name === 'mcp_call' && String(call.arguments?.tool || '').startsWith('mcp__')) {
      const inner = call.arguments.arguments;
      call = { ...call, name: String(call.arguments.tool), arguments: inner && typeof inner === 'object' && !Array.isArray(inner) ? inner : {} };
    }
    const name = call.name;
    const args = call.arguments || {};
    const tool = this.registry.get(name);
    // An app tool in use: it rides along directly in this bot's next requests.
    if (tool?.mcp) this.registry.noteMcpUse?.(bot.id, name);

    // The call was cut off (too long for one answer): say how to do it in parts.
    if (args.__truncated && tool) {
      const result = { error: { code: 'ARGS_TRUNCATED', message: `your ${name} call was cut off: its arguments (${args.__length} characters so far) were too long for one answer and arrived incomplete. Do it in parts: write the long content to a workspace file with fs_write (mode "append" for the next parts), then pass that file${name === 'page_save' ? ' with page_save\'s file argument' : ''}. Do not send the same long call again.` } };
      this.pushToolResult(messages, call, result);
      this.bus.emit({ type: 'tool.result', ...baseEvent, name, ok: false, result });
      await this.record(bot.id, { kind: 'tool', name, args: { truncated: true }, ok: false, output: result, turnId });
      return {};
    }

    // Unknown tool: tell the model rather than crashing the turn.
    if (!tool) {
      const result = { error: { code: 'UNKNOWN_TOOL', message: `there is no tool named "${name}"` } };
      this.pushToolResult(messages, call, result);
      this.bus.emit({ type: 'tool.result', ...baseEvent, name, ok: false, result });
      await this.record(bot.id, { kind: 'tool', name, args, ok: false, output: result, turnId });
      return {};
    }

    const granted = this.registry.isGranted(bot, name);
    const riskInfo = typeof tool.risk === 'function' ? tool.risk(args, ctx) : { risk: tool.risk };

    // Whole-machine autonomy: on a remote machine by default, on this computer
    // only when the human turns it on. The denylist still asks either way.
    const machine = effectivePolicy(this.config.policy);
    let verdict = classify(name, args, {
      baseRisk: riskInfo.risk,
      granted,
      // "careful" means every bot asks, including a trusted one.
      // A trusted bot's shell command runs unasked only when it just looks (SEC-04).
      autoApproveMedium: mediumRunsUnasked({ careful: machine.careful, autonomous: machine.autonomous, trusted: Boolean(bot.policy?.autoApproveMedium), toolName: name, args }),
      autoApproveAll: machine.autonomous,
      // A bot keeps a copy of the list from when it was made; it adds to the
      // machine's list (built-in + the human's words), never replaces it.
      denyPatterns: [...new Set([...machine.denyPatterns, ...(bot.policy?.denyPatterns || [])])],
      extraRiskReason: riskInfo.reason || '',
      unattended: ctx.unattended,
    });

    // Pictures and videos cost money: the human's choice for them wins over the level; a one-sentence rule below can still ask.
    const generate = this.config.policy?.generate;
    if ((name === 'image_generate' || name === 'video_generate') && verdict.decision !== DECISION.DENY) {
      if (generate === 'ask') verdict = { ...verdict, decision: DECISION.ASK, reason: '按你的设置，生成图片、视频前先问你（会产生费用）' };
      else if (generate === 'auto') verdict = { ...verdict, decision: DECISION.AUTO, reason: '按你的设置，生成图片、视频不用问' };
    }

    // The human's one-sentence rules, matched by meaning.
    const rules = Array.isArray(this.config.policy?.rules) ? this.config.policy.rules : [];
    if (rules.length && verdict.decision !== DECISION.DENY && !RULE_EXEMPT.has(name)) {
      try {
        verdict = applyRules(verdict, await judgeRules({ rules, toolName: name, args, model: this.model }), DECISION);
      } catch (err) {
        // Could not check: with any "ask first" rule on the books, ask.
        if (rules.some((r) => r.action === 'ask') && verdict.decision === DECISION.AUTO) {
          verdict = { ...verdict, decision: DECISION.ASK, reason: `没能对照你的规则（${err.message}），先问你` };
        }
      }
    }

    // The machine's boundary (opened folders, sudo) comes last: no approval
    // level or "直接做" rule lets a bot past it without the human.
    // "主助理完全信任": the primary bot is not fenced (sudo, places outside the
    // workspace). The level and the dangerous-command list above still apply,
    // so formatting a disk or deleting system folders keeps asking.
    const trusted = Boolean(this.config.policy?.trustPrimary) && Boolean(bot.primary || (this.config.primaryBotId && bot.id === this.config.primaryBotId));
    if (verdict.decision !== DECISION.DENY && !trusted) {
      const fence = checkBoundary(name, args, { workspaceDir: this.config.workspaceDir, policy: this.config.policy || {}, remote: machineMode() === 'remote' });
      if (fence?.decision === 'deny') verdict = { ...verdict, decision: DECISION.DENY, risk: 'HIGH', reason: fence.reason, code: fence.code };
      else if (fence) verdict = { ...verdict, decision: DECISION.ASK, risk: 'HIGH', reason: fence.reason, code: fence.code };
    }

    // Handing work to Claude Code / Codex: another program that changes files on
    // the human's subscription. It asks every time - no level, rule or trust
    // setting turns that into "auto" (a "deny" still denies).
    if (name === 'tool_request' && verdict.decision !== DECISION.DENY) {
      const want = (Array.isArray(args?.tools) ? args.tools : []).map(String).filter((n) => isRequestable(n) && !this.registry.isGranted(bot, n));
      verdict = { ...verdict, decision: DECISION.ASK, risk: want.includes('shell') || want.includes('fs_delete') || want.includes('desktop_ui') ? 'HIGH' : 'MEDIUM',
        reason: `给「${bot.name}」加上：${want.map(toolLabel).join('、') || '（都已经有了）'}。原因：${String(args?.reason || '').trim().replace(/[。.！!；;]+$/, '').slice(0, 200) || '没说'}。同意后一直有效，可以在机器人设置里关掉；有风险的操作照样会先问你。` };
    }
    // Nightshift's own secrets and modules: asked every time - on a remote
    // machine, for a trusted bot, at any level. Only "deny" stays a deny.
    const secretReason = reachesSecrets(name, args);
    if (secretReason && verdict.decision !== DECISION.DENY) verdict = { ...verdict, decision: DECISION.ASK, risk: 'HIGH', reason: secretReason };
    if (name === 'cli_agent_run' && verdict.decision === DECISION.AUTO) {
      verdict = { ...verdict, decision: DECISION.ASK, risk: 'HIGH', reason: `交给 ${args?.agent === 'codex' ? 'Codex' : 'Claude Code'}（用你的订阅额度，会在工作区里写文件${args?.allowShell ? '、运行命令' : ''}），每次都先问你` };
    }

    // A connected app (MCP) the human has not marked "always allow": every
    // call that may change something asks, whatever the level. A read-only
    // tool (the server says so) is let through like other look-only tools.
    if (tool.mcp && verdict.decision === DECISION.AUTO) {
      const t = this.registry.mcpTrust?.(name);
      if (t && t.trust !== 'always' && !t.readOnly) {
        verdict = { ...verdict, decision: DECISION.ASK, reason: `用「${t.server}」的 ${t.tool}（连接应用，设成「始终允许」后就不再问）` };
      }
    }

    this.bus.emit({
      type: 'tool.call',
      ...baseEvent,
      callId: call.id,
      name,
      args,
      risk: verdict.risk,
      decision: verdict.decision,
      reason: verdict.reason,
    });

    // 1. Hard deny (not granted).
    if (verdict.decision === DECISION.DENY) {
      const askable = !granted && isRequestable(name);
      const result = { error: { code: verdict.code || 'TOOL_NOT_GRANTED', message: askable ? `${verdict.reason} - ask the human for it with tool_request({tools:["${name}"], reason}) and carry on once granted` : verdict.reason } };
      this.pushToolResult(messages, call, result);
      this.bus.emit({ type: 'tool.result', ...baseEvent, callId: call.id, name, ok: false, denied: true, result });
      await this.record(bot.id, { kind: 'tool', name, args, ok: false, denied: true, reason: verdict.reason, output: result, turnId });
      await audit({ kind: 'tool.denied', botId: bot.id, turnId, tool: name, args, reason: verdict.reason });
      return {};
    }

    // 2. Ask a human.
    if (verdict.decision === DECISION.ASK) {
      const pending = this.approvals.request({
        turnId,
        botId: bot.id,
        toolName: name,
        args,
        risk: verdict.risk,
        reason: verdict.reason,
        unattended: ctx.unattended,
      });

      // approvals.request() exposes the record synchronously so the UI can show
      // the card without waiting for the decision.
      const request = pending.record || null;
      this.bus.emit({
        type: 'approval.request',
        ...baseEvent,
        approvalId: request?.id || null,
        callId: call.id,
        tool: name,
        args,
        risk: verdict.risk,
        reason: verdict.reason,
      });

      const resolution = await pending;
      this.bus.emit({
        type: 'approval.resolved',
        ...baseEvent,
        approvalId: resolution.approval?.id || request?.id || null,
        tool: name,
        decision: resolution.decision,
        note: resolution.note || '',
      });

      // Keep the decision in the transcript, so a reloaded page still shows what
      // was asked and what the human said.
      await this.record(bot.id, {
        kind: 'approval',
        approvalId: resolution.approval?.id || request?.id || null,
        toolName: name,
        risk: verdict.risk,
        reason: verdict.reason,
        decision: resolution.decision,
        note: resolution.note || '',
        args: truncateJson(args, 2000),
        turnId,
      });

      if (resolution.decision === 'needs_approval') {
        // Unattended: park it and stop cleanly.
        const result = {
          error: {
            code: 'APPROVAL_REQUIRED',
            message: `unattended run paused: "${name}" is ${verdict.risk} risk and needs a human`,
          },
        };
        this.pushToolResult(messages, call, result);
        this.bus.emit({ type: 'tool.result', ...baseEvent, callId: call.id, name, ok: false, result });
        await this.record(bot.id, {
          kind: 'tool',
          name,
          args,
          ok: false,
          risk: verdict.risk,
          needsApproval: true,
          output: result,
          turnId,
        });
        return {
          termination: 'needs_approval',
          summary: `Paused: ${name} needs a human (${verdict.risk} risk).`,
        };
      }

      if (resolution.decision !== 'approved') {
        const result = {
          error: {
            code: 'APPROVAL_DENIED',
            message: `the human did not approve "${name}" (${resolution.decision})${resolution.note ? `: ${resolution.note}` : ''}`,
          },
        };
        this.pushToolResult(messages, call, result);
        this.bus.emit({ type: 'tool.result', ...baseEvent, callId: call.id, name, ok: false, result });
        await this.record(bot.id, {
          kind: 'tool',
          name,
          args,
          ok: false,
          risk: verdict.risk,
          denied: true,
          reason: resolution.decision,
          output: result,
          turnId,
        });
        await audit({ kind: 'tool.approval_denied', botId: bot.id, turnId, tool: name, risk: verdict.risk, decision: resolution.decision });
        return {};
      }
    }

    // 3. Run it.
    let result;
    let ok = true;
    try {
      result = await tool.run(args, ctx);
      ok = result?.ok !== false && !result?.error;
    } catch (err) {
      ok = false;
      result = { error: { code: err.code || 'TOOL_FAILED', message: err.message, details: err.details } };
    }

    this.pushToolResult(messages, call, result);
    this.bus.emit({ type: 'tool.result', ...baseEvent, callId: call.id, name, args: truncateJson(args, 2000), ok, risk: verdict.risk, result });
    await this.record(bot.id, {
      kind: 'tool',
      name,
      args,
      ok,
      risk: verdict.risk,
      output: result,
      turnId,
    });
    // The group transcript gets a compact chip per tool (no output): enough for
    // the human to see what the coordinator did, without dumping file contents.
    if (ctx.groupTurn && name !== 'task_finish') {
      await this.recordGroupMessage(ctx.group.id, { kind: 'tool', from: bot.id, name, turnId });
    }
    await audit({
      kind: 'tool.run',
      botId: bot.id,
      turnId,
      tool: name,
      risk: verdict.risk,
      decision: verdict.decision,
      ok,
      args,
      result: summarizeForAudit(result),
    });

    if (name === 'task_finish' && ok) {
      let finalSummary = String(result?.summary || 'Done.');
      // Held against this turn's receipts like a plain final answer: the words the
      // human gets (what it said in this step, else the summary). A mismatch is
      // sent back once - the turn goes on - and flagged if it stays.
      if (ctx?.receipts) {
        const said = ctx.spokeThisStep ? ctx.spokenText : finalSummary;
        const problems = checkClaims(said, ctx.receipts, { workspaceDir: this.config.workspaceDir, group: Boolean(ctx.group) });
        if (problems.length && !ctx.claimState?.nudged) {
          ctx.claimState.nudged = true;
          messages.push({ role: 'user', content: `（系统核对）你收尾时说的和这一轮的实际操作对不上：\n- ${problems.join('\n- ')}\n只更正上面这几条，其余说法不用改、也不要重做已经做完的事：做了的才说做了，没做到的直接说没做到；确实还需要做的，现在用工具去做，然后再调用 task_finish。` });
          return {};
        }
        if (problems.length) {
          const note = `⚠ 核对：这些说法在这一轮的操作记录里找不到依据——${problems.join('；')}。`;
          if (ctx.spokeThisStep) {
            // Its words are already on screen: the note follows them.
            this.bus.emit({ type: 'message', ...baseEvent, text: note, final: true, system: true });
            await this.record(bot.id, { kind: 'assistant', text: note, turnId, source: baseEvent.source, final: true, system: true });
          } else finalSummary = `${finalSummary}\n\n${note}`;
          audit({ kind: 'claims.unverified', botId: bot.id, turnId, problems, via: 'task_finish' }).catch(() => {});
        }
      }
      // The closing summary is ordinary assistant text: stream it like any other
      // answer so the UI does not have a special case for "task finished".
      // When the model already answered in the same step, that answer is the
      // reply; the summary only names the turn (no second, repeated bubble).
      if (!ctx?.spokeThisStep) await this.streamText(baseEvent, bot, turnId, finalSummary, { split: !ctx?.group && !ctx?.depth && !ctx?.unattended });
      return { finalSummary };
    }

    return {};
  }

  pushToolResult(messages, call, result) {
    let content;
    try {
      content = JSON.stringify(result);
    } catch {
      content = JSON.stringify({ error: { message: 'tool result was not serializable' } });
    }
    messages.push({
      role: 'tool',
      tool_call_id: call.id,
      content: content.length > MAX_TOOL_OUTPUT ? `${content.slice(0, MAX_TOOL_OUTPUT)}...` : content,
    });
  }
}

function summarizeForAudit(result) {
  try {
    const json = JSON.stringify(result);
    return json.length > 1200 ? `${json.slice(0, 1200)}...` : json;
  } catch {
    return '(unserialisable)';
  }
}

function truncateJson(value, max) {
  try {
    const json = JSON.stringify(value);
    return json.length > max ? `${json.slice(0, max)}...` : json;
  } catch {
    return '{}';
  }
}

function statusText(status) {
  switch (status) {
    case 'success':
      return 'Done.';
    case 'needs_approval':
      return 'Paused: waiting for a human approval.';
    case 'timeout':
      return 'Stopped: ran out of time.';
    case 'cancelled':
      return 'Cancelled.';
    case 'max_steps':
      return 'Stopped: hit the step limit.';
    default:
      return 'Finished.';
  }
}

/** A turn file only needs to distinguish "still running", "finished" and "a human is needed". */
function turnFileStatus(status) {
  return status === 'needs_approval' ? 'needs_attention' : 'done';
}

/**
 * Boot-time crash recovery.
 *
 * Every turn writes data/turns/<id>.json as `running` and rewrites it when it
 * ends. A file still saying `running` therefore means the process died
 * mid-turn. We cannot resume that work (the provider call, the tool promises
 * and the model transcript are gone), so the honest thing is to mark the turn
 * `needs_attention`, say so in the bot's transcript - which is what the UI's
 * message log renders - and let the human decide what to do next.
 *
 * @returns {Promise<object[]>} the recovered turn records
 */
export async function recoverInterruptedTurns({ bus = null } = {}) {
  let names;
  try {
    names = await listFiles(P.turnsDir, (name) => name.endsWith('.json'));
  } catch {
    return [];
  }

  const recovered = [];
  const doneFiles = [];
  // A bot with an open task goes on by itself (resumeTasks): say that instead.
  const cutoff = Date.now() - 24 * 3600 * 1000;
  const openTasks = new Map((await listPlans().catch(() => []))
    .filter((p) => p.kind === 'task' && p.status === 'running' && Date.parse(p.updatedAt || 0) > cutoff).map((p) => [p.botId, p]));

  for (const name of names) {
    const file = path.join(P.turnsDir, name);
    const record = readJsonSync(file, null);
    if (!record || !record.id) continue;

    if (record.status === 'running') {
      const recoveredAt = nowIso();
      const updated = {
        ...record,
        status: 'needs_attention',
        interrupted: true,
        recoveredAt,
        note: RECOVERY_NOTE,
        updatedAt: recoveredAt,
      };
      try {
        writeJsonSyncAtomic(file, updated);
      } catch (err) {
        console.error('[recovery] could not rewrite turn file:', err.message);
      }

      if (record.botId) {
        try {
          await appendJsonl(sessionFile(record.botId), {
            ts: recoveredAt,
            kind: 'assistant',
            text: openTasks.has(record.botId)
              ? `应用重启时这一轮被打断了。任务「${openTasks.get(record.botId).goal}」会在半分钟内自动接着做，已经写好的文件都还在。`
              : '应用重启时这一轮被打断了，没有做完，也不会自动重做。已经写好的文件都还在工作区里；需要的话再跟我说一次。如果它当时在等你批准，那张卡片还在「动态」里。',
            system: true,
            recovered: true,
            turnId: record.id,
            source: record.source || 'chat',
          });
          await appendJsonl(sessionFile(record.botId), {
            ts: recoveredAt,
            kind: 'turn',
            turnId: record.id,
            status: 'needs_attention',
            summary: RECOVERY_NOTE,
            startedAt: record.startedAt || null,
            endedAt: recoveredAt,
            steps: Number(record.steps) || 0,
            source: record.source || 'chat',
            recovered: true,
          });
        } catch (err) {
          console.error('[recovery] could not append to the transcript:', err.message);
        }
      }

      recovered.push(updated);
      if (bus) {
        try {
          bus.emit({
            type: 'turn.recovered',
            turnId: record.id,
            botId: record.botId,
            status: 'needs_attention',
            note: RECOVERY_NOTE,
          });
        } catch {
          /* the bus is defensive already */
        }
      }
    } else if (record.status === 'done' && record.endedAt) {
      doneFiles.push({ file, endedAt: Date.parse(record.endedAt) || 0 });
    }
  }

  // Housekeeping: finished turn files are diagnostics, not history. Keep a week
  // and a hard cap so data/turns/ cannot grow without bound.
  doneFiles.sort((a, b) => b.endedAt - a.endedAt);
  const weekAgo = Date.now() - 7 * 24 * 60 * 60 * 1000;
  for (const [index, entry] of doneFiles.entries()) {
    if (entry.endedAt > weekAgo && index < 500) continue;
    try {
      await fsp.rm(entry.file, { force: true });
    } catch {
      /* best effort */
    }
  }

  return recovered;
}

function httpError(status, code, message) {
  const err = new Error(message);
  err.status = status;
  err.code = code;
  return err;
}
