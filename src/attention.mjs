// Sidebar status: which bot or group is working, needs the human, or has a
// result the human has not looked at yet.
//
// Keys are "bot:<id>" (a 1:1 chat) or "group:<id>". Everything is derived
// from the event bus, so the tracker never has to be told about a turn:
//   working   turn.start .. turn.end (in memory: a restart ends every turn)
//   needsYou  an approval card is open, or the turn ended waiting for a login
//             or a takeover (kept until that chat's next turn starts)
//   unread    a turn ended after the human last looked at that chat
// "Looked at" is POST /api/attention/seen from whichever window shows the chat,
// so a phone and the desktop agree. Seen times and waits survive a restart.

import fsp from 'node:fs/promises';

const keyOf = (ev) => (ev.groupId ? `group:${ev.groupId}` : ev.botId ? `bot:${ev.botId}` : null);

export function createAttention({ file, bus }) {
  const working = new Map();      // key -> Set(turnId)
  const approvals = new Map();    // approvalId -> key
  const prevResult = new Map();   // key -> result time before the last turn ended
  let saved = { seen: {}, result: {}, waiting: {} };
  let saveTimer = null;
  let changeTimer = null;

  const persist = () => {
    clearTimeout(saveTimer);
    saveTimer = setTimeout(() => {
      fsp.writeFile(file, JSON.stringify(saved, null, 2), 'utf8').catch(() => {});
    }, 300);
    if (typeof saveTimer?.unref === 'function') saveTimer.unref();
  };

  // Several events land in the same instant (turn.end + message): one notice.
  const changed = () => {
    clearTimeout(changeTimer);
    changeTimer = setTimeout(() => bus.emit({ type: 'attention.changed' }), 150);
    if (typeof changeTimer?.unref === 'function') changeTimer.unref();
  };

  /** A bot or group was deleted: drop what it left behind. */
  function forget(key) {
    delete saved.seen[key];
    delete saved.result[key];
    delete saved.waiting[key];
    working.delete(key);
    for (const [id, k] of approvals) if (k === key) approvals.delete(id);
    persist();
    changed();
  }

  function onEvent(ev) {
    if (!ev || ev.type === 'attention.changed') return;
    const key = keyOf(ev);
    switch (ev.type) {
      case 'turn.start': {
        if (!key) return;
        if (!working.has(key)) working.set(key, new Set());
        working.get(key).add(ev.turnId || 'turn');
        // The human answered (or something else started a turn here): the
        // wait for a login or a takeover is over.
        if (saved.waiting[key]) { delete saved.waiting[key]; persist(); }
        changed();
        break;
      }
      case 'turn.end': {
        if (!key) return;
        const set = working.get(key);
        if (set) { set.delete(ev.turnId || 'turn'); if (!set.size) working.delete(key); }
        // A turn a teammate handed to another bot is still that bot's result.
        prevResult.set(key, saved.result[key] || 0);
        saved.result[key] = Date.parse(ev.ts) || Date.now();
        if (ev.waitingFor) saved.waiting[key] = { kind: ev.waitingFor, text: String(ev.summary || '').slice(0, 120) };
        persist();
        changed();
        break;
      }
      case 'approval.request':
        if (!key || !ev.approvalId) return;
        approvals.set(ev.approvalId, key);
        changed();
        break;
      case 'approval.resolved':
        if (ev.approvalId && approvals.delete(ev.approvalId)) changed();
        break;
      case 'roster.changed':
        // A deleted bot or group must not keep a badge on the sidebar.
        if (ev.action === 'delete' && key) { forget(key); break; }
        changed();
        break;
      default:
        break;
    }
  }

  return {
    async load() {
      try {
        const data = JSON.parse(await fsp.readFile(file, 'utf8'));
        saved = { seen: data.seen || {}, result: data.result || {}, waiting: data.waiting || {} };
      } catch { /* first run */ }
      bus.subscribe(onEvent);
    },

    /** -> {items: {key: {working, needsYou, unread, waiting?}}, needsYou, unread, working} */
    snapshot() {
      const keys = new Set([...working.keys(), ...approvals.values(), ...Object.keys(saved.waiting), ...Object.keys(saved.result)]);
      const items = {};
      const totals = { needsYou: 0, unread: 0, working: 0 };
      for (const key of keys) {
        const open = [...approvals.values()].filter((k) => k === key).length;
        const item = {
          working: working.has(key),
          needsYou: open > 0 || Boolean(saved.waiting[key]),
          unread: (saved.result[key] || 0) > (saved.seen[key] || 0),
        };
        if (open) item.approvals = open;
        if (saved.waiting[key]) item.waiting = saved.waiting[key];
        if (!item.working && !item.needsYou && !item.unread) continue;
        items[key] = item;
        if (item.needsYou) totals.needsYou += 1;
        if (item.unread) totals.unread += 1;
        if (item.working) totals.working += 1;
      }
      return { items, ...totals };
    },

    /** The human is looking at this chat now. */
    seen(key) {
      if (!/^(bot|group):[\w.-]{1,80}$/.test(String(key || ''))) return false;
      const before = (saved.result[key] || 0) > (saved.seen[key] || 0);
      saved.seen[key] = Date.now();
      persist();
      if (before) changed();
      return true;
    },

    forget,

    /** The last turn there had nothing new (a quiet routine run): no "new result" for it. */
    quiet(key) {
      if (!prevResult.has(key)) return false;
      const before = (saved.result[key] || 0) > (saved.seen[key] || 0);
      saved.result[key] = prevResult.get(key);
      if (!saved.result[key]) delete saved.result[key];
      persist();
      if (before) changed();
      return true;
    },

    /** Drop every key that is not a live bot or group (left from older versions). */
    prune(liveKeys) {
      const live = new Set(liveKeys);
      const stale = new Set([...Object.keys(saved.seen), ...Object.keys(saved.result), ...Object.keys(saved.waiting)].filter((k) => !live.has(k)));
      for (const key of stale) forget(key);
      return stale.size;
    },
  };
}
