/**
 * approvals.mjs - the human-in-the-loop boundary.
 *
 * Three risk tiers, one rule set:
 *   LOW     auto-runs. Reading a file inside the workspace.
 *   MEDIUM  auto-runs only when the bot's policy says autoApproveMedium,
 *           otherwise it asks. Shell commands, network fetches, writes to the
 *           shared skill library.
 *   HIGH    always asks. Danger-denylisted shell commands, anything that touches
 *           the filesystem outside the shared workspace, sending messages on the
 *           user's behalf.
 *
 * There is exactly one decision function (classify) so the UI, the audit log and
 * the agent loop can never disagree about why something was allowed.
 */

import { uid, nowIso } from './store.mjs';

export const RISK = { LOW: 'LOW', MEDIUM: 'MEDIUM', HIGH: 'HIGH' };
export const DECISION = { AUTO: 'auto', ASK: 'ask', DENY: 'deny' };

/**
 * Danger denylist for the shell tool. Anything matching is promoted to HIGH,
 * i.e. it cannot run without a human clicking approve - regardless of what the
 * bot's policy says about medium-risk commands.
 *
 * These are intentionally broad and ugly: the point is to catch the obvious
 * catastrophes, not to be a sandbox. The README says so out loud.
 */
export const DEFAULT_DENY_PATTERNS = [
  'rm\\s+-rf',
  'rm\\s+-fr',
  '\\bdel\\s+/[sfq]\\b',
  '\\brmdir\\s+/s\\b',
  '\\bformat\\s+[a-z]:',
  '\\bmkfs\\b',
  '\\bdd\\s+if=',
  '\\b(shutdown|reboot|halt|poweroff)\\b',
  '\\bsudo\\b',
  '\\brunas\\b',
  '\\breg\\s+delete\\b',
  '\\bnet\\s+user\\b.*\\/add',
  '\\bcurl\\b[^|]*\\|\\s*(ba)?sh',
  '\\bwget\\b[^|]*\\|\\s*(ba)?sh',
  '\\biwr\\b[^|]*\\|\\s*iex',
  '\\bchmod\\s+777\\s+/',
  '\\b:(\\)\\s*\\{',
  '\\bgit\\s+push\\s+--force\\b',
  '\\bgit\\s+reset\\s+--hard\\b',
  '>\s*/dev/sd[a-z]',
  '\\bRemove-Item\\b.*-Recurse\\b',
];

/**
 * On a remote machine (an idle PC or VM given to the assistant) bots run with
 * sudo and without approval cards. Only what would cut the machine off or
 * wipe it still waits for a human: losing the box is not something a bot can
 * undo by itself.
 */
// A word only counts as the command when it is in command position: at the
// start, after ; & | ` ( or after sudo. "x11vnc -storepasswd ... /vnc/passwd"
// or "cat /etc/passwd" is not the passwd command (the old pattern blocked both).
const CMD = '(?:^|[;&|`(]\\s*|\\bsudo\\s+(?:-\\S+\\s+)*)';

export const REMOTE_DENY_PATTERNS = [
  '\\brm\\s+(-\\S+\\s+)*(/|/\\*|~|/home|/etc|/usr|/var|/boot|/opt/desk-hub)(\\s|$)', // rm of / or a system root
  `${CMD}mkfs`,
  '\\bdd\\b[^|;&]*\\bof=/dev/',
  '>\\s*/dev/(sd|nvme|vd|hd)[a-z]',
  `${CMD}(shutdown|poweroff|halt)\\b`,
  `${CMD}init\\s+0\\b`,
  '\\bsystemctl\\s+(stop|disable|mask|kill)\\s+(ssh|sshd|desk-hub)(\\.service)?\\b',
  '\\bufw\\s+(enable|default\\s+deny)\\b',
  '\\biptables\\b.*-P\\s+INPUT\\s+DROP',
  `${CMD}(passwd|userdel|deluser)\\b`,
  // The desktop is reached only through the paired hub: never open it to the network.
  '\\bx11vnc\\b.*\\s-listen\\s+(?!127\\.|localhost\\b)',
  '\\bwebsockify\\b.*\\b0\\.0\\.0\\.0:',
  'LoopbackOnly\\b.*\\b0\\b',
  '\\b:\\(\\)\\s*\\{',
  // Windows hubs
  '\\bformat(\\.com)?\\s+[a-z]:',
  '\\b(Format-Volume|Clear-Disk|Initialize-Disk|Stop-Computer)\\b',
  '\\bRemove-Item\\b.*\\s[a-z]:\\\\?(\\*)?(\\s|$)', // a whole drive
  '\\b(rd|rmdir)\\s+/s\\b.*\\s[a-z]:\\\\?(\\s|$)',
  '\\b(Stop-Service|Set-Service|sc(\\.exe)?\\s+(stop|config))\\b.*\\bsshd\\b',
  '\\b(Disable|Unregister|Stop)-ScheduledTask\\b.*NightshiftHub',
  '\\bnet\\s+user\\b.*\\/(delete|passwordreq)',
  '\\bSet-LocalUser\\b.*-Password\\b',
  '\\bnetsh\\s+advfirewall\\b.*\\bblock',
];

/**
 * Approval levels a human picks per machine:
 *   careful  - every medium and high risk action asks, for every bot
 *   standard - high risk asks; medium asks unless the bot is trusted (today's default)
 *   auto     - everything runs; only the danger list still asks
 */
export const APPROVAL_LEVELS = ['careful', 'standard', 'auto'];

/** A plain phrase the human typed ("git push") as a whole-word pattern. */
export function phraseToPattern(text) {
  const words = String(text || '').trim().split(/\s+/).filter(Boolean).map((w) => w.replace(/[.*+?^${}()|[\]\\]/g, '\\$&'));
  if (!words.length) return '';
  return `(?:^|[^\\w-])${words.join('\\s+')}(?![\\w-])`;
}

/** 'remote' on a machine set up by hub/setup-linux.sh, 'local' otherwise. */
export function machineMode() {
  return process.env.DESK_MACHINE_MODE === 'remote' ? 'remote' : 'local';
}

/**
 * The approval policy that actually applies here. On this computer the human
 * opts into autonomy (autoApproveAll); on a remote machine autonomy is the
 * default and can be switched off (remoteAutonomy: false).
 */
export function effectivePolicy(configPolicy = {}) {
  const mode = machineMode();
  const remote = mode === 'remote';
  // Older configs only had the on/off switch: map it onto the levels.
  const legacyAuto = remote ? configPolicy.remoteAutonomy !== false : Boolean(configPolicy.autoApproveAll);
  const level = APPROVAL_LEVELS.includes(configPolicy.level) ? configPolicy.level : (legacyAuto ? 'auto' : 'standard');
  const builtin = remote
    ? REMOTE_DENY_PATTERNS
    : (configPolicy.denyPatterns?.length ? configPolicy.denyPatterns : DEFAULT_DENY_PATTERNS);
  // The human's own additions never replace the built-in floor.
  const extra = (configPolicy.extraDeny || []).map((e) => e?.pattern).filter(Boolean);
  return {
    mode,
    level,
    autonomous: level === 'auto',
    careful: level === 'careful',
    builtinDeny: builtin,
    extraDeny: configPolicy.extraDeny || [],
    denyPatterns: [...builtin, ...extra],
  };
}

/** Which deny patterns match this shell command (for the audit "reason"). */
export function matchedDenyPatterns(command, patterns = DEFAULT_DENY_PATTERNS) {
  const text = String(command || '');
  const hits = [];
  for (const p of patterns) {
    try {
      if (new RegExp(p, 'i').test(text)) hits.push(p);
    } catch {
      /* ignore malformed patterns */
    }
  }
  return hits;
}

/**
 * Decide what happens to one tool call.
 *
 * @param {string} toolName
 * @param {object} args
 * @param {object} policy {
 *   baseRisk: 'LOW'|'MEDIUM'|'HIGH',   // from the registry, already escalated by the tool
 *   granted: boolean,                  // is this tool granted to this bot?
 *   autoApproveMedium: boolean,
 *   denyPatterns: string[],
 *   unattended: boolean,
 *   extraRiskReason?: string           // e.g. "path is outside the shared workspace"
 * }
 * @returns {{risk: string, decision: string, reason: string}}
 */
export function classify(toolName, args, policy = {}) {
  const {
    baseRisk = RISK.MEDIUM,
    granted = true,
    autoApproveMedium = false,
    denyPatterns = DEFAULT_DENY_PATTERNS,
    extraRiskReason = '',
  } = policy;

  // 1. Tool grants are an allow-list, not a hint.
  if (!granted) {
    return {
      risk: RISK.HIGH,
      decision: DECISION.DENY,
      reason: `${toolName} is not granted to this bot`,
    };
  }

  let risk = baseRisk;
  let reason = extraRiskReason;
  let denylisted = false;

  // 2. Hard escalations that override whatever the tool declared.
  if (toolName === 'shell') {
    const hits = matchedDenyPatterns(args?.command, denyPatterns);
    if (hits.length) {
      risk = RISK.HIGH;
      denylisted = true;
      reason = `command matches danger denylist (${hits.slice(0, 2).join(', ')})`;
    }
  }
  if (!reason) {
    reason = risk === RISK.LOW ? 'low-risk tool' : risk === RISK.MEDIUM ? 'medium-risk tool' : 'high-risk tool';
  }

  // 3. Risk -> decision.
  //
  // `autoApproveAll` is for a machine the human has dedicated to the assistant
  // (an idle PC or a cloud VM). It removes the *prompt*, not the *guard*: the
  // denylist still escalates to HIGH and is still denied below, and every
  // decision keeps landing in the audit log so nothing runs unrecorded.
  const autonomous = policy.autoApproveAll === true;
  if (risk === RISK.HIGH) {
    if (autonomous && !denylisted) {
      return { risk, decision: DECISION.AUTO, reason: `${reason}; auto-approved (autonomous mode)` };
    }
    return { risk, decision: DECISION.ASK, reason };
  }
  if (risk === RISK.MEDIUM) {
    return autoApproveMedium || autonomous
      ? { risk, decision: DECISION.AUTO, reason: `${reason}; auto-approved by policy` }
      : { risk, decision: DECISION.ASK, reason };
  }
  return { risk, decision: DECISION.AUTO, reason };
}

/**
 * Pending-approval queue.
 *
 * The agent loop awaits `request(...)`. The HTTP layer resolves it when the
 * human clicks approve/deny. A 10-minute timer denies by timeout so a forgotten
 * card cannot hold a turn open forever (the timer is unref'd so it never keeps
 * the process alive on its own).
 */
export class ApprovalQueue {
  constructor({ timeoutMs = 10 * 60 * 1000, onAudit = async () => {}, onPersist = () => {} } = {}) {
    this.timeoutMs = timeoutMs;
    this.onAudit = onAudit;
    /**
     * Called with the list of records still waiting for a human, every time
     * that list changes. The server writes it to data/pending.json so a crash
     * does not lose the decision the human was about to make.
     */
    this.onPersist = onPersist;
    /** @type {Map<string, object>} */
    this.records = new Map();
    this.waiters = new Map(); // id -> {resolve, timer}
  }

  /** Everything a human still has to look at. */
  pendingRecords() {
    return [...this.records.values()]
      .filter((record) => record.status === 'pending' || record.status === 'awaiting_human')
      .sort((a, b) => (a.createdAt < b.createdAt ? -1 : 1));
  }

  persist() {
    try {
      this.onPersist(this.pendingRecords());
    } catch (err) {
      console.error('[approvals] persist failed:', err.message);
    }
  }

  /**
   * Rehydrate approvals that were still pending when the process died.
   *
   * They have no waiter (the turn that asked is gone), so `decide` records the
   * human's answer instead of resuming work - see restore + decide below.
   */
  restore(records = []) {
    let restored = 0;
    for (const saved of records) {
      if (!saved?.id || !saved.toolName) continue;
      if (saved.status !== 'pending' && saved.status !== 'awaiting_human') continue;
      if (this.records.has(saved.id)) continue;

      const record = {
        ...saved,
        restored: true,
        restoredAt: nowIso(),
      };
      this.records.set(record.id, record);
      restored += 1;

      // Give a restored card the same appeal window as a fresh one.
      const timer = setTimeout(() => {
        this.settle(record.id, 'timeout', 'approval window expired after a restart');
      }, this.timeoutMs);
      if (typeof timer.unref === 'function') timer.unref();
    }
    if (restored) this.persist();
    return restored;
  }

  /**
   * Ask for permission. Resolves with {decision:'approved'|'denied'|'timeout', note}.
   *
   * In unattended mode (a routine firing while nobody is watching) we do NOT
   * block: we park a pending record, hand back 'needs_approval', and let the
   * routine report that in chat. That is the honest behaviour - a scheduled run
   * should never hang for ten minutes pretending to work.
   */
  request({ turnId, botId, toolName, args, risk, reason, unattended = false }) {
    const id = uid('ap');
    const record = {
      id,
      turnId,
      botId,
      toolName,
      args: truncateArgs(args),
      risk,
      reason,
      status: 'pending',
      createdAt: nowIso(),
      decidedAt: null,
      note: '',
      unattended,
    };
    this.records.set(id, record);
    void this.onAudit({ kind: 'approval.requested', ...record });

    if (unattended) {
      record.status = 'awaiting_human';
      const parked = Promise.resolve({ approval: record, decision: 'needs_approval', note: '' });
      // Callers need the record id synchronously to push it to the UI, even
      // though the decision itself is asynchronous.
      parked.record = record;
      this.persist();
      return parked;
    }

    const promise = new Promise((resolve) => {
      const timer = setTimeout(() => {
        this.settle(id, 'timeout', 'no response within the approval window');
        // settle() resolves the waiter; nothing else to do here.
      }, this.timeoutMs);
      // Do not let a pending approval keep a headless process alive.
      if (typeof timer.unref === 'function') timer.unref();
      this.waiters.set(id, { resolve, timer });
    });
    promise.record = record;
    this.persist();
    return promise;
  }

  /**
   * Human decision from the UI/API. Returns the updated record, or null.
   *
   * A record parked by an unattended run ("awaiting_human") can still be
   * decided - we record the human's answer for the audit trail and flag it as
   * late, but we do NOT resume the finished run. Re-running the routine is the
   * explicit way to continue; see README "what this replica does NOT do".
   */
  decide(id, decision, note = '', by = 'human') {
    const record = this.records.get(id);
    if (!record) return null;
    const normalized = normalizeDecision(decision);
    if (!normalized) return { ...record, error: `unknown decision "${decision}"` };

    if (record.status === 'awaiting_human') {
      record.status = normalized === 'approved' ? 'approved' : 'denied';
      record.decidedAt = nowIso();
      record.note = String(note || '');
      record.by = by;
      record.late = true;
      this.records.set(id, record);
      void this.onAudit({ kind: 'approval.resolved', ...record });
      this.persist();
      return { ...record, late: true };
    }

    if (record.status !== 'pending') return { ...record, error: `approval already ${record.status}` };

    this.settle(id, normalized, note, by);
    return this.records.get(id);
  }

  settle(id, decision, note = '', by = 'system') {
    const record = this.records.get(id);
    if (!record) return null;
    if (record.status !== 'pending') return record;

    record.status = decision === 'approved' ? 'approved' : decision === 'timeout' ? 'timeout' : 'denied';
    record.decidedAt = nowIso();
    record.note = String(note || '');
    record.by = by;
    // A card that outlived its turn is answered after the fact: record it, but
    // do not pretend the run picked the decision up.
    if (record.restored) record.late = true;
    this.records.set(id, record);
    void this.onAudit({ kind: 'approval.resolved', ...record });
    this.persist();

    const waiter = this.waiters.get(id);
    if (waiter) {
      clearTimeout(waiter.timer);
      this.waiters.delete(id);
      waiter.resolve({ approval: record, decision: record.status, note: record.note });
    }
    return record;
  }

  get(id) {
    return this.records.get(id) || null;
  }

  list({ status, botId, limit = 100 } = {}) {
    let out = [...this.records.values()];
    // "pending" means "a human still has something to do", which includes the
    // cards an unattended routine parked instead of waiting for.
    if (status === 'pending') out = out.filter((r) => r.status === 'pending' || r.status === 'awaiting_human');
    else if (status === 'history') out = out.filter((r) => r.status !== 'pending' && r.status !== 'awaiting_human');
    else if (status) out = out.filter((r) => r.status === status);
    if (botId) out = out.filter((r) => r.botId === botId);
    out.sort((a, b) => (a.createdAt < b.createdAt ? 1 : -1));
    return out.slice(0, limit);
  }

  /**
   * Shutdown path.
   *
   * Do not silently deny cards the human never saw: unblock the turns that are
   * being cancelled anyway, but leave the records pending (and on disk) so the
   * next boot can show them again. Crash recovery and a clean restart then
   * behave the same way.
   */
  shutdown(reason = 'server shutting down') {
    for (const record of [...this.records.values()]) {
      if (record.status !== 'pending' && record.status !== 'awaiting_human') continue;
      record.interruptedAt = nowIso();
      record.interruptedReason = String(reason);
      const waiter = this.waiters.get(record.id);
      if (waiter) {
        clearTimeout(waiter.timer);
        this.waiters.delete(record.id);
        waiter.resolve({ approval: record, decision: 'denied', note: reason });
      }
    }
    this.persist();
  }

  /** Resolve any waiter belonging to a cancelled turn. */
  cancelForTurn(turnId, reason = 'turn cancelled') {
    for (const record of this.records.values()) {
      if (record.turnId === turnId && record.status === 'pending') {
        this.settle(record.id, 'denied', reason, 'system');
      }
    }
  }
}

function normalizeDecision(value) {
  const v = String(value || '').toLowerCase();
  if (['approve', 'approved', 'allow', 'yes', 'approve_once'].includes(v)) return 'approved';
  if (['deny', 'denied', 'reject', 'no'].includes(v)) return 'denied';
  return null;
}

function truncateArgs(args) {
  try {
    const json = JSON.stringify(args ?? {});
    return json.length > 4000 ? `${json.slice(0, 4000)}...` : json;
  } catch {
    return '{}';
  }
}
