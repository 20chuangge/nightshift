// The daily briefing: what happened on this machine in the last hours, as
// plain facts a bot can turn into a short morning note. Each hub answers for
// itself (GET /api/briefing/data); the briefing_collect tool asks this one and
// every peer machine, so one brief covers all of them.
//
// Facts only, kept small: per bot the turns that ran, how they ended and their
// summaries; what is waiting on the human; pages made; background videos;
// routines that failed. The bot writes the prose.

export const BRIEFING_TAG = '[每日简报]';

const clip = (s, n) => {
  const t = String(s || '').replace(/\s+/g, ' ').trim();
  return t.length > n ? `${t.slice(0, n - 1)}…` : t;
};

/**
 * -> {machine, since, until, bots:[...], waitingOnYou:[...], pages:[...], videos:[...], routines:[...]}
 * Every dependency is optional so a hub missing one still answers.
 */
export async function collectBriefing({
  hours = 24,
  now = Date.now(),
  machine = '',
  listBots,
  readSession,
  approvals,
  attention,
  pages,
  videoJobs,
  routines,
} = {}) {
  const h = Math.min(Math.max(Number(hours) || 24, 1), 24 * 7);
  const since = now - h * 3600 * 1000;
  const inWindow = (ts) => { const t = Date.parse(ts); return Number.isFinite(t) && t >= since && t <= now; };
  const bots = typeof listBots === 'function' ? await listBots().catch(() => []) : [];
  const nameOf = new Map(bots.map((b) => [b.id, b.name]));

  const perBot = [];
  for (const bot of bots) {
    const records = typeof readSession === 'function' ? await readSession(bot.id).catch(() => []) : [];
    const asked = new Map(); // turnId -> what started it
    for (const r of records) if (r.kind === 'user' && r.turnId && !asked.has(r.turnId)) asked.set(r.turnId, r);
    const turns = records.filter((r) => r.kind === 'turn' && inWindow(r.endedAt || r.ts))
      // The briefing does not report on itself.
      .filter((r) => !String(asked.get(r.turnId)?.text || '').startsWith(BRIEFING_TAG));
    if (!turns.length) continue;
    const count = (s) => turns.filter((t) => t.status === s).length;
    perBot.push({
      id: bot.id,
      name: bot.name,
      turns: turns.length,
      done: count('success'),
      failed: turns.filter((t) => t.status === 'failed' || t.status === 'error').length,
      waiting: count('needs_approval') + count('needs_attention'),
      // Newest first; what was asked and how it ended.
      work: turns.slice(-8).reverse().map((t) => ({
        at: t.endedAt || t.ts,
        from: asked.get(t.turnId)?.source || t.source || 'chat',
        asked: clip(asked.get(t.turnId)?.text, 120),
        status: t.status,
        result: clip(t.summary, 200),
      })),
    });
  }

  const waitingOnYou = [];
  if (approvals?.list) {
    for (const a of approvals.list({ status: 'pending', limit: 20 })) {
      waitingOnYou.push({ kind: 'approval', bot: nameOf.get(a.botId) || a.botId, what: clip(`${a.toolName || ''} ${a.reason || ''}`, 160), since: a.createdAt });
    }
  }
  if (attention?.snapshot) {
    for (const [key, item] of Object.entries(attention.snapshot().items || {})) {
      if (!item.waiting) continue;
      const [kind, id] = key.split(':');
      waitingOnYou.push({ kind: item.waiting.kind, bot: kind === 'bot' ? (nameOf.get(id) || id) : `群 ${id}`, what: clip(item.waiting.text, 160) });
    }
  }

  const pageList = pages?.list ? (await pages.list().catch(() => [])).filter((p) => inWindow(p.updatedAt)).slice(0, 12)
    .map((p) => ({ title: p.title, path: p.path, by: p.botName || '', at: p.updatedAt })) : [];

  const videos = videoJobs?.list ? videoJobs.list().filter((j) => inWindow(new Date(j.doneAt || j.createdAt).toISOString()))
    .map((j) => ({ bot: nameOf.get(j.botId) || j.botId, state: j.state, prompt: clip(j.prompt, 80), path: j.path || '', error: j.error || '' })).slice(0, 10) : [];

  const routineList = routines?.list ? routines.list().filter((r) => r.preset !== 'briefing').map((r) => {
    const runs = (r.runs || []).filter((x) => inWindow(x.endedAt || x.startedAt));
    return {
      name: r.name,
      bot: nameOf.get(r.botId) || r.botId,
      enabled: r.enabled,
      schedule: r.schedule,
      ranInWindow: runs.length,
      failed: runs.filter((x) => x.status === 'failed').length,
      lastResult: clip(runs.at(-1)?.summary, 160),
      nextRun: r.nextRun,
    };
  }).filter((r) => r.enabled || r.ranInWindow) : [];

  return {
    machine,
    since: new Date(since).toISOString(),
    until: new Date(now).toISOString(),
    bots: perBot,
    waitingOnYou,
    pages: pageList,
    videos,
    routines: routineList,
  };
}

/** The routine instruction the daily briefing runs with. */
export function briefingInstruction() {
  return `${BRIEFING_TAG} 调用 briefing_collect，拿到过去 24 小时所有机器上的情况，给我写一份早间简报：
1. 先写需要我处理的：待审批、等我登录或接管、失败的任务（写清是哪台机器、哪个机器人、什么事）。
2. 再写完成了什么：按机器、按机器人，一件事一句话；做出的页面和文件写出路径。
3. 最后一句写今天还会自动跑的定时任务。
没有内容的部分直接省略；全都没有就只说一句「过去 24 小时没有新动静」。整体不超过 15 行，只写简报本身，不要解释你怎么查的。`;
}
