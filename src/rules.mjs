/**
 * rules.mjs - the human's one-sentence rules ("发邮件先问我", "装软件直接做").
 *
 * Rules are matched by meaning, not by keywords: before an action runs, the
 * chat model is asked which rules (if any) the action falls under. One short
 * call per action, only when rules exist; identical actions are cached.
 *
 * How a match changes the decision (applied in agent.mjs):
 *   - an "ask" rule always asks, at any approval level
 *   - an "allow" rule removes an approval prompt, but never overrides the
 *     danger list or a missing ability
 *   - "ask" wins when both kinds match
 */

const CACHE_MAX = 300;
const cache = new Map();

/** Tools that are the bot talking to the human or to itself, never an action. */
export const RULE_EXEMPT = new Set(['task_finish', 'request_takeover', 'image_view']);

export function normalizeRule(input) {
  const text = String(input?.text || '').trim().slice(0, 120);
  const action = input?.action === 'allow' ? 'allow' : 'ask';
  return text ? { text, action } : null;
}

function cacheKey(rules, toolName, args) {
  return JSON.stringify([rules.map((r) => `${r.id}:${r.action}:${r.text}`), toolName, args]).slice(0, 6000);
}

/**
 * Which rules this action falls under.
 * @returns {Promise<Array<{id, text, action}>>}
 */
export async function judgeRules({ rules, toolName, args, model }) {
  if (!rules?.length || !model) return [];
  const key = cacheKey(rules, toolName, args);
  if (cache.has(key)) return cache.get(key);

  const list = rules.map((r, i) => `${i + 1}. ${r.text}`).join('\n');
  let argText = '';
  try { argText = JSON.stringify(args ?? {}); } catch { argText = String(args); }
  const messages = [
    {
      role: 'system',
      content: [
        'You check whether an action an AI assistant is about to take on a computer falls under any of the human\'s rules.',
        'Judge by meaning, not by matching words: "发邮件先问我" covers an SMTP command or a script that sends mail; "不许动 D 盘" covers writing, deleting or moving files under D:\\ but not reading a web page.',
        'A rule applies only when the action clearly does what the rule talks about.',
        'Reply with JSON only, nothing else: {"rules": [numbers of every rule that applies]} - an empty list when none applies.',
      ].join('\n'),
    },
    { role: 'user', content: `Rules:\n${list}\n\nAction: ${toolName} ${argText.slice(0, 2000)}` },
  ];
  const res = await model.complete(messages, { temperature: 0, maxTokens: 120 });
  const text = String(res?.content || '');
  const m = /"rules"\s*:\s*\[([^\]]*)\]/.exec(text);
  const nums = m ? m[1].split(/[^\d]+/).filter(Boolean).map(Number) : [];
  const hits = [...new Set(nums)].map((n) => rules[n - 1]).filter(Boolean);
  if (cache.size >= CACHE_MAX) cache.delete(cache.keys().next().value);
  cache.set(key, hits);
  return hits;
}

/**
 * Apply rule matches to a verdict from approvals.classify().
 * @param {object} verdict  {risk, decision, reason}
 * @param {Array} hits      rules that applied
 */
export function applyRules(verdict, hits, DECISION) {
  if (!hits.length || verdict.decision === DECISION.DENY) return verdict;
  const ask = hits.find((r) => r.action === 'ask');
  if (ask) return { ...verdict, decision: DECISION.ASK, reason: `你的规则「${ask.text}」：先问你`, rule: ask.id };
  const allow = hits.find((r) => r.action === 'allow');
  const dangerous = /denylist/.test(String(verdict.reason || ''));
  if (allow && verdict.decision === DECISION.ASK && !dangerous) {
    return { ...verdict, decision: DECISION.AUTO, reason: `你的规则「${allow.text}」：直接做`, rule: allow.id };
  }
  return verdict;
}
