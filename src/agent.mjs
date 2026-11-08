/**
 * agent.mjs - one turn of one bot.
 *
 * The loop is deliberately small and boring:
 *   build prompt -> call model -> execute tool calls (through approvals) ->
 *   feed results back -> repeat -> finish.
 *
 * Bounds that matter:
 *   - max 12 steps           (config per bot, so a runaway loop costs little)
 *   - 5 minute wall clock    (a stuck tool cannot hold a turn forever)
 *   - one hand-off hop       (enforced in tools.bot_message, not here)
 *
 * Everything observable is emitted on the event bus, which the server forwards
 * over SSE. The same events are appended to the session log, so a browser that
 * reloads mid-turn still sees the transcript.
 */

import path from 'node:path';
import fsp from 'node:fs/promises';
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
import { effectivePolicy, classify, DECISION } from './approvals.mjs';

const MAX_TOOL_OUTPUT = 12000;
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
    .map((member) => `${member.name} (${member.id}) - ${member.role || 'no role set'}`)
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
      `You speak first when nobody was @mentioned. If the request (or part of it) belongs to other members - including "how is everyone doing" / progress questions - answer only your own part in a line or two, then @mention each member who should answer, using the exact name (${others}). Every member you @mention answers right after you, in the group. Do not answer for them.`,
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
  '- Never ask for passwords, verification codes or card numbers in chat, and never type them for the human.',
  '- Never expose the desktop to the network (VNC/x11vnc/websockify on 0.0.0.0, port forwarding, remote-desktop software, VNC passwords). The app already gives the human secure access.',
  '- Purchases: you may research, compare and put things in the cart; the human confirms and pays during a takeover.',
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

export class AgentRuntime {
  constructor({ config, registry, model, bots, groups, memory, skills, approvals, bus, getApp }) {
    this.config = config;
    this.registry = registry;
    this.model = model;
    this.bots = bots;
    // Late-bound product state (settings, UI state). Only the primary bot's
    // settings/ui tools read it; a runtime without it still runs every turn.
    this.getApp = typeof getApp === 'function' ? getApp : () => null;
    // Group chats are optional: a runtime without them still runs 1:1 turns, and
    // the group tools answer GROUPS_UNAVAILABLE instead of pretending.
    this.groups = groups || null;
    this.memory = memory;
    this.skills = skills;
    this.approvals = approvals;
    this.bus = bus;
    /** @type {Map<string, {controller: AbortController, botId: string}>} */
    this.active = new Map();
  }

  /** Swap the model client after settings change (provider / key / endpoint). */
  setModel(model) {
    this.model = model;
  }


  activeTurns() {
    return [...this.active.entries()].map(([turnId, info]) => ({ turnId, botId: info.botId }));
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

  async buildSystemPrompt(bot, { unattended, group = null, groupRole = 'coordinator' }) {
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
        : 'You are a specialist bot. Do your part of the work and report back concisely.',
      teamLine,
      '',
      ...(group ? [renderGroupSection(bot, group, groupRole), ''] : []),
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
      '',
      ...machinesSection(this.getApp()?.uiState),
      ...TAKEOVER_RULES,
      ...(effectivePolicy(this.config.policy).mode === 'remote'
        ? ['## This machine', 'This is a remote machine dedicated to you. You may use sudo (it needs no password) and install what you need. Act without asking; only commands that could cut the machine off or wipe it wait for a human.', '']
        : ['## This machine', "This is the human's own computer. Anything that changes it beyond the workspace waits for their approval.", '']),
      '## Approval boundary',
      'Every tool call is classified before it runs:',
      '- LOW runs immediately.',
      `- MEDIUM runs only if your policy auto-approves it (yours: ${bot.policy?.autoApproveMedium ? 'yes' : 'no'}), otherwise a human is asked.`,
      '- HIGH always asks a human. Writes outside the workspace and denylisted shell commands are HIGH.',
      unattended
        ? 'This turn is UNATTENDED (a routine fired). Nobody is watching, so a HIGH-risk action will NOT wait: the run will stop and report that it needs approval.'
        : 'If a call is waiting for approval, the turn is paused until the human decides.',
      '',
      '## How to work',
      '- Do the work with tools; do not describe what you would do.',
      '- The human sees only your messages, not your tool calls. Never narrate your steps, never say "let me check", "next I will", "先看一下", "接着我来". Work silently and speak once.',
      '- One turn = at most one short message, delivered when you have the result or need a decision. If you must ask something, ask it in that message and stop.',
      '- Read the workspace before assuming what is in it.',
      '- Save durable facts with memory_write (scope "shared" for things the whole team should know).',
      '- Save a procedure that worked as a skill with skill_save, so the next run is cheaper.',
      bot.primary
        ? '- You can change the whole app: settings_get/settings_update for model and timezone, ui_get/ui_set for theme, timezone mode and the controlled machine, and group_create/group_update/group_delete for team chats. When the human asks for a change, do it; do not tell them to open Settings.'
        : '',
      '- When the task is done, call task_finish with a one or two sentence summary of what actually changed.',
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
    const usable = records.filter((r) => (r.kind === 'user' || r.kind === 'assistant') && r.text);
    return usable.slice(-limit).map((r) => ({ role: r.kind, content: String(r.text) }));
  }

  async record(botId, record) {
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
  }) {
    const bot = await this.bots.getBot(botId);
    if (!bot) throw httpError(404, 'BOT_NOT_FOUND', `no bot with id "${botId}"`);

    const groupContext = group?.id && this.groups ? group : null;
    // The coordinator and any member the human (or the coordinator) @mentioned
    // speak in the group directly; a member reached by bot_message does not.
    const coordinatorTurn = Boolean(groupContext && (groupRole === 'coordinator' || groupRole === 'speaker'));

    // The HTTP layer mints the id so it can hand it back before the turn starts.
    const turnId = providedTurnId || uid('turn');
    const controller = new AbortController();
    if (signal) {
      if (signal.aborted) controller.abort();
      else signal.addEventListener('abort', () => controller.abort(), { once: true });
    }
    this.active.set(turnId, { controller, botId: bot.id });

    // Work until done, like comparable agents: a step is one tool call, and
    // real work (search, open, read, fix, check) easily takes dozens. The old
    // per-bot 12 / 5 min were floors, not ceilings; what stops a runaway turn
    // now is the loop check below and the time budget.
    const maxSteps = Math.min(Math.max(Number(bot.policy?.maxSteps) || 0, 80), 200);
    const maxTurnMs = Math.max(Number(bot.policy?.maxTurnMs) || 0, 30 * 60 * 1000);
    const deadline = Date.now() + maxTurnMs;
    const startedAt = nowIso();

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
    let finished = false;

    try {
      const systemPrompt = await this.buildSystemPrompt(bot, { unattended, group: groupContext, groupRole });
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
        { role: 'user', content: String(text) },
      ];

      await this.record(bot.id, { kind: 'user', text: String(text), turnId, source });
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
        signal: controller.signal,
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
      // Exact repeats of the same call (name + arguments) mean it is stuck.
      const recentCalls = [];
      let stuck = null;
      while (steps < maxSteps) {
        if (controller.signal.aborted) {
          status = 'cancelled';
          summary = 'Turn cancelled.';
          break;
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

        let response;
        try {
          response = await this.model.complete(messages, {
            tools: this.registry.schemasFor(bot),
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

        if (response.content && response.content.trim()) {
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
          const outcome = await this.executeToolCall({ call, ctx, bot, turnId, baseEvent, messages });
          trail.push(outcome?.ok === false ? `${call.name}✗` : call.name);
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
          if (call.name === 'request_takeover' && outcome?.ok !== false) {
            const what = String(call.args?.reason || '').trim() || '完成这一步';
            summary = `等你接管屏幕：${what}`;
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
          if (outcome.finalSummary) {
            summary = outcome.finalSummary;
            finished = true;
            break;
          }
        }

        steps += 1;
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
        const note =
          `这件事已经做了 ${steps} 步还没完成，我先停一下，免得白白消耗额度。\n\n`
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

      return { turnId, status, summary: summary || statusText(status), steps };
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
      });
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
      const result = await this.runTurn({
        botId: member.id,
        text: prompt || text,
        source: 'group',
        turnId: id || undefined,
        group,
        groupRole: role,
        recordUser: record,
      }).catch((err) => {
        this.bus.emit({ type: 'error', groupId: group.id, turnId: id, message: err.message });
        return null;
      });
      record = false;
      id = null;
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

  /** Kick off a just-created group by id (resolves member names; skipped in demo mode). */
  async kickoffGroup(groupId) {
    if (!this.groups || this.model?.provider === 'mock') return;
    const group = await this.groups.getGroup(groupId).catch(() => null);
    if (!group) return;
    const members = [];
    for (const id of group.members || []) {
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
  async streamText(baseEvent, bot, turnId, content) {
    const text = String(content);
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
    const name = call.name;
    const args = call.arguments || {};
    const tool = this.registry.get(name);

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
    const verdict = classify(name, args, {
      baseRisk: riskInfo.risk,
      granted,
      autoApproveMedium: Boolean(bot.policy?.autoApproveMedium) || machine.autonomous,
      autoApproveAll: machine.autonomous,
      denyPatterns: bot.policy?.denyPatterns?.length ? bot.policy.denyPatterns : machine.denyPatterns,
      extraRiskReason: riskInfo.reason || '',
      unattended: ctx.unattended,
    });

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
      const result = { error: { code: 'TOOL_NOT_GRANTED', message: verdict.reason } };
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
    this.bus.emit({ type: 'tool.result', ...baseEvent, callId: call.id, name, ok, risk: verdict.risk, result });
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
      const finalSummary = String(result?.summary || 'Done.');
      // The closing summary is ordinary assistant text: stream it like any other
      // answer so the UI does not have a special case for "task finished".
      await this.streamText(baseEvent, bot, turnId, finalSummary);
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
            text: `[Recovered after restart] ${RECOVERY_NOTE}`,
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
