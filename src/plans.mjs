/**
 * plans.mjs - a group's task board.
 *
 * When a request in a group needs real work, the coordinator splits it with
 * group_plan into tasks, each owned by one member (on this machine or another).
 * The runtime (agent.mjs runPlan) then runs the tasks itself - in parallel when
 * they do not depend on each other - so members actually do their parts
 * instead of the coordinator doing everything. Owners can hand a task to
 * someone else (task_handoff) or ask the human (task_ask_human).
 *
 * data/groups/plans/<planId>.json
 *   {id, groupId, request, coordinatorId, status, createdAt, updatedAt,
 *    tasks:[{id, title, owner, brief, deliverable, needs:[taskId], status,
 *            result, question, answer, handoffFrom, startedAt, endedAt}]}
 *
 * plan.status: running | waiting (a task waits for the human) | done | stopped
 * task.status: todo | doing | waiting_human | done | failed | skipped | stopped
 */

import path from 'node:path';
import { P, readJson, writeJsonAtomic, uid, nowIso } from './store.mjs';

const DIR = () => path.join(P.dataDir, 'groups', 'plans');
const file = (planId) => path.join(DIR(), `${String(planId).replace(/[^\w-]/g, '')}.json`);

export const TASK_STATUS_TEXT = {
  todo: '待开始', doing: '进行中', waiting_human: '等你回复', done: '完成', failed: '没做成', skipped: '跳过', stopped: '已停止',
};

/** The member a name or id means (exact id, exact name, then a unique partial name). */
export function resolveMember(members, ref) {
  const r = String(ref || '').trim().replace(/^@/, '');
  if (!r) return null;
  const lower = r.toLowerCase();
  return members.find((m) => m.id === r)
    || members.find((m) => String(m.name || '').toLowerCase() === lower)
    || (() => { const hits = members.filter((m) => String(m.name || '').toLowerCase().includes(lower)); return hits.length === 1 ? hits[0] : null; })();
}

/**
 * A plan from group_plan's arguments, checked against the group: every task
 * needs a title and an owner who is a member; `needs` names earlier tasks
 * (by number, 1-based, or by id). -> {plan} or {error}
 */
export function makePlan({ group, request, coordinatorId, tasks }) {
  const members = group.members || [];
  const list = Array.isArray(tasks) ? tasks.slice(0, 12) : [];
  if (!list.length) return { error: 'tasks 不能为空：至少分一项任务' };
  const out = [];
  for (let i = 0; i < list.length; i += 1) {
    const t = list[i] || {};
    const title = String(t.title || '').trim().slice(0, 120);
    if (!title) return { error: `第 ${i + 1} 项没有 title` };
    const owner = resolveMember(members, t.owner);
    if (!owner) return { error: `第 ${i + 1} 项的负责人「${t.owner || ''}」不是这个群的成员（成员：${members.map((m) => m.name).join('、')}）` };
    out.push({
      id: `t${i + 1}`,
      title,
      owner: owner.id,
      brief: String(t.brief || '').trim().slice(0, 2000),
      deliverable: String(t.deliverable || '').trim().slice(0, 400),
      needsRaw: Array.isArray(t.needs) ? t.needs : [],
      status: 'todo',
      result: '',
    });
  }
  for (const t of out) {
    t.needs = [...new Set(t.needsRaw.map((n) => (typeof n === 'number' || /^\d+$/.test(String(n)) ? `t${Number(n)}` : String(n)))
      .filter((id) => id !== t.id && out.some((o) => o.id === id && Number(o.id.slice(1)) < Number(t.id.slice(1)))))];
    delete t.needsRaw;
  }
  const now = nowIso();
  return {
    plan: {
      id: uid('plan'),
      groupId: group.id,
      request: String(request || '').slice(0, 4000),
      coordinatorId,
      status: 'running',
      createdAt: now,
      updatedAt: now,
      tasks: out,
    },
  };
}

export async function savePlan(plan) {
  plan.updatedAt = nowIso();
  await writeJsonAtomic(file(plan.id), plan);
  return plan;
}

export async function loadPlan(planId) {
  return readJson(file(planId), null);
}

/** Tasks that can start now: not started, and everything they need is done. */
export function readyTasks(plan) {
  const done = new Set(plan.tasks.filter((t) => t.status === 'done').map((t) => t.id));
  return plan.tasks.filter((t) => t.status === 'todo' && t.needs.every((id) => done.has(id)));
}

/** Tasks that can never start (something they need failed or was skipped): marked skipped. */
export function skipBlocked(plan) {
  let changed = true;
  while (changed) {
    changed = false;
    const dead = new Set(plan.tasks.filter((t) => ['failed', 'skipped', 'stopped'].includes(t.status)).map((t) => t.id));
    for (const t of plan.tasks) {
      if (t.status === 'todo' && t.needs.some((id) => dead.has(id))) { t.status = 'skipped'; t.result = '它依赖的任务没做成，所以跳过了。'; changed = true; }
    }
  }
}

/** One line per task, for the group transcript and the coordinator. */
export function planText(plan, names) {
  const nameOf = (id) => names.get(id) || id;
  return plan.tasks.map((t, i) => `${i + 1}. ${t.title} —— ${nameOf(t.owner)}${t.needs.length ? `（等 ${t.needs.map((n) => n.slice(1)).join('、')} 完成）` : ''}`).join('\n');
}
