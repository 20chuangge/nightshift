/**
 * Token usage ledger and cost estimates.
 *
 * One JSONL line per model call, aggregated on read. Prices are per million
 * tokens and live in data/usage-settings.json; an unpriced model still counts
 * tokens but contributes no money, so the UI can say what is missing instead
 * of inventing a number. A daily money threshold writes one audit entry per
 * day (data/usage-alert.json remembers the day, so it cannot spam).
 */
import path from 'node:path';
import { P, nowIso, readJsonl, readJsonSync, appendJsonl, writeJsonSyncAtomic } from './store.mjs';

const ledgerFile = () => path.join(P.dataDir, 'usage.jsonl');
const settingsFile = () => path.join(P.dataDir, 'usage-settings.json');
const alertFile = () => path.join(P.dataDir, 'usage-alert.json');

const round = (n, digits = 4) => Math.round(n * 10 ** digits) / 10 ** digits;

export function localDay(date = new Date()) {
  const y = date.getFullYear();
  const m = String(date.getMonth() + 1).padStart(2, '0');
  const d = String(date.getDate()).padStart(2, '0');
  return `${y}-${m}-${d}`;
}

function cleanSettings(raw) {
  const prices = {};
  for (const [model, value] of Object.entries(raw?.prices || {})) {
    const name = String(model || '').trim().slice(0, 80);
    if (!name) continue;
    const inPrice = Number(value?.in);
    const outPrice = Number(value?.out);
    if (!Number.isFinite(inPrice) || !Number.isFinite(outPrice) || inPrice < 0 || outPrice < 0) continue;
    prices[name] = { in: round(inPrice), out: round(outPrice) };
  }
  const limit = Number(raw?.dailyAlert);
  return {
    currency: raw?.currency === 'USD' ? 'USD' : 'CNY',
    prices,
    dailyAlert: Number.isFinite(limit) && limit > 0 ? limit : 0,
  };
}

export function readUsageSettings() {
  return cleanSettings(readJsonSync(settingsFile(), null));
}

/** Today's alert, when one was already raised (null otherwise). */
export function readUsageAlert() {
  const alert = readJsonSync(alertFile(), null);
  return alert && alert.day === localDay() ? alert : null;
}

export async function saveUsageSettings(patch = {}) {
  const current = readUsageSettings();
  const next = cleanSettings({
    currency: patch.currency ?? current.currency,
    prices: patch.prices ?? current.prices,
    dailyAlert: patch.dailyAlert ?? current.dailyAlert,
  });
  writeJsonSyncAtomic(settingsFile(), next);
  return next;
}

function normalizeUsage(usage) {
  if (!usage) return null;
  const prompt = Math.max(0, Number(usage.prompt_tokens) || 0);
  const completion = Math.max(0, Number(usage.completion_tokens) || 0);
  const total = Math.max(prompt + completion, Number(usage.total_tokens) || 0);
  return total ? { prompt, completion, total } : null;
}

/**
 * Append one call. A provider that reports no usage still gets a line, with
 * null tokens: the call happened, but inventing a token count would make the
 * estimate a lie. Returns the record.
 */
export async function recordUsage({ botId = '', provider = '', model = '', usage = null, source = '' } = {}) {
  const counts = normalizeUsage(usage);
  const record = {
    ts: nowIso(),
    day: localDay(),
    botId: String(botId || ''),
    provider: String(provider || ''),
    model: String(model || ''),
    prompt: counts ? counts.prompt : null,
    completion: counts ? counts.completion : null,
    total: counts ? counts.total : null,
    source: String(source || '').slice(0, 20),
  };
  await appendJsonl(ledgerFile(), record);
  return record;
}

export async function readUsageRecords() {
  return readJsonl(ledgerFile());
}

/** Records for the last `days` local days (today included). */
export function recentRecords(records, days = 30) {
  const span = Math.min(Math.max(Number(days) || 30, 1), 365);
  const first = new Date();
  first.setDate(first.getDate() - (span - 1));
  const from = localDay(first);
  return records.filter((r) => r.day >= from);
}

export function summarizeUsage(records, settings = readUsageSettings()) {
  const byBot = new Map();
  const byDay = new Map();
  const byModel = new Map();
  const totals = { tokens: 0, prompt: 0, completion: 0, cost: 0, calls: 0, unpricedTokens: 0, callsWithoutUsage: 0 };
  const bump = (map, key, r, cost, tokens) => {
    const entry = map.get(key) || {
      key, tokens: 0, prompt: 0, completion: 0, cost: 0, calls: 0, unpricedTokens: 0, callsWithoutUsage: 0,
    };
    entry.calls += 1;
    if (tokens == null) entry.callsWithoutUsage += 1;
    else {
      entry.tokens += tokens;
      entry.prompt += Number(r.prompt) || 0;
      entry.completion += Number(r.completion) || 0;
      if (cost == null) entry.unpricedTokens += tokens;
      else entry.cost += cost;
    }
    map.set(key, entry);
  };
  for (const r of records) {
    const tokens = Number.isFinite(r.total) ? Number(r.total) : null;
    const price = settings.prices?.[r.model];
    const cost = price && tokens != null
      ? ((Number(r.prompt) || 0) * price.in + (Number(r.completion) || 0) * price.out) / 1_000_000
      : null;
    totals.calls += 1;
    if (tokens == null) totals.callsWithoutUsage += 1;
    else {
      totals.tokens += tokens;
      totals.prompt += Number(r.prompt) || 0;
      totals.completion += Number(r.completion) || 0;
      if (cost == null) totals.unpricedTokens += tokens;
      else totals.cost += cost;
    }
    bump(byBot, r.botId || '—', r, cost, tokens);
    bump(byDay, r.day, r, cost, tokens);
    bump(byModel, r.model || '(未知)', r, cost, tokens);
  }
  const finish = (entry) => ({ ...entry, cost: round(entry.cost) });
  return {
    totals: finish(totals),
    byBot: [...byBot.values()].map(finish).sort((a, b) => b.tokens - a.tokens),
    byDay: [...byDay.values()].map(finish).sort((a, b) => (a.key < b.key ? -1 : 1)),
    byModel: [...byModel.values()].map(finish).sort((a, b) => b.tokens - a.tokens),
  };
}

/**
 * Record a call and raise the once-a-day cost alert when the local day's
 * estimate first crosses the threshold. Money only counts for priced models.
 */
export async function noteUsage(entry, { audit = async () => {}, bus = null } = {}) {
  const record = await recordUsage(entry);
  if (!record) return null;
  const settings = readUsageSettings();
  if (!settings.dailyAlert) return record;
  const records = recentRecords(await readUsageRecords(), 1).filter((r) => r.day === record.day);
  const today = summarizeUsage(records, settings).totals;
  if (today.cost < settings.dailyAlert) return record;
  const previous = readJsonSync(alertFile(), null);
  if (previous?.day === record.day) return record;
  writeJsonSyncAtomic(alertFile(), { day: record.day, cost: today.cost, limit: settings.dailyAlert });
  await audit({ kind: 'usage.alert', day: record.day, cost: today.cost, limit: settings.dailyAlert, currency: settings.currency });
  bus?.emit({ type: 'usage.alert', day: record.day, cost: today.cost, limit: settings.dailyAlert, currency: settings.currency });
  return record;
}
