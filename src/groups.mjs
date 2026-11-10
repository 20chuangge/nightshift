/**
 * groups.mjs - durable group chats.
 *
 * A group is a small roster (2-6 bots, exactly one of them the coordinator) plus
 * an append-only transcript, stored the same boring way as sessions:
 *
 *   data/groups/<id>.json    {id, name, members:[botId], coordinatorId, createdAt, updatedAt}
 *   data/groups/<id>.jsonl   one JSON object per message, never rewritten
 *
 * This module is deliberately storage-only: it does not know how to read the bot
 * registry. Callers resolve bot ids/names to ids and check existence; that keeps
 * the module importable from the bot registry itself (deleteBot repairs groups)
 * without a circular import.
 *
 * v1 group semantics, spelled out because they are a product decision:
 *   - the human posts into the group; only the *coordinator* starts a turn
 *   - other members run only when the coordinator messages them with
 *     bot_message, and their words reach the group through group_post
 *   - every message in the transcript is visible to the human and to members
 */

import path from 'node:path';
import fsp from 'node:fs/promises';
import {
  P,
  readJson,
  writeJsonAtomic,
  readJsonl,
  readJsonlTail,
  appendJsonl,
  listFiles,
  nowIso,
  uid,
} from './store.mjs';

export const GROUP_MIN_MEMBERS = 2;
export const GROUP_MAX_MEMBERS = 6;

/** Message kinds the transcript (and the UI) understands. */
export const GROUP_MESSAGE_KINDS = ['user', 'assistant', 'tool', 'status'];

const PREVIEW_MAX_CHARS = 120;
// Same widening strategy as the sidebar preview for bots: only a small tail is
// read, and it grows when the tail is all tool cards.
const PREVIEW_WINDOWS = [32 * 1024, 128 * 1024, 512 * 1024, 2 * 1024 * 1024];

function groupError(status, code, message) {
  const err = new Error(message);
  err.status = status;
  err.code = code;
  return err;
}

function safeId(id) {
  // Same guard as sessionFile(): an id must never escape data/groups/.
  return String(id).replace(/[^a-zA-Z0-9._-]/g, '_');
}

export function groupFile(id) {
  return path.join(P.groupsDir, `${safeId(id)}.json`);
}

export function groupMessagesFile(id) {
  return path.join(P.groupsDir, `${safeId(id)}.jsonl`);
}

function slugifyId(value) {
  return String(value || '')
    .trim()
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, 40);
}

async function uniqueGroupId(name) {
  const base = slugifyId(name) || 'group';
  let id = base;
  for (let suffix = 2; suffix < 100; suffix += 1) {
    const taken = await fsp.stat(groupFile(id)).then(() => true).catch(() => false);
    if (!taken) return id;
    id = `${base}-${suffix}`;
  }
  return `${base}-${uid('g').slice(2, 8)}`;
}

/** Dedupe + trim a member list: ["ops", "researcher", "ops"] -> ["ops", "researcher"]. */
export function normalizeMemberIds(input) {
  const out = [];
  for (const raw of Array.isArray(input) ? input : []) {
    const id = String(raw ?? '').trim();
    if (id && !out.includes(id)) out.push(id);
  }
  return out;
}

/**
 * 2-6 members, no more, no fewer. Exported so the REST layer and the tools can
 * report a size problem before they try to resolve names (a caller that passed
 * one member should hear "too few", not "unknown bot").
 */
export function assertMemberCount(members) {
  const list = Array.isArray(members) ? members : [];
  if (list.length < GROUP_MIN_MEMBERS) {
    throw groupError(
      400,
      'GROUP_MEMBER_COUNT',
      `a group needs at least ${GROUP_MIN_MEMBERS} members; got ${list.length}`,
    );
  }
  if (list.length > GROUP_MAX_MEMBERS) {
    throw groupError(
      400,
      'GROUP_MEMBER_COUNT',
      `a group can hold at most ${GROUP_MAX_MEMBERS} members; got ${list.length}`,
    );
  }
}

// ---------------------------------------------------------------------------
// rosters
// ---------------------------------------------------------------------------

export async function listGroups() {
  const files = await listFiles(P.groupsDir, (name) => name.endsWith('.json'));
  const out = [];
  for (const file of files) {
    const raw = await readJson(path.join(P.groupsDir, file), null);
    if (!raw) continue;
    out.push(normalizeGroup({ id: path.basename(file, '.json'), ...raw }));
  }
  out.sort((a, b) => a.name.localeCompare(b.name) || a.id.localeCompare(b.id));
  return out;
}

/** Members on other machines are "botId@machine"; what we know of them (name, role) is kept with the group. */
export const isRemoteId = (id) => String(id || '').includes('@');
function keepRemotes(remotes, members) {
  const out = {};
  for (const id of members) {
    if (!isRemoteId(id)) continue;
    const r = remotes?.[id] || {};
    const at = id.lastIndexOf('@');
    out[id] = {
      botId: String(r.botId || id.slice(0, at)),
      machine: String(r.machine || id.slice(at + 1)),
      name: String(r.name || id.slice(0, at)).slice(0, 60),
      role: String(r.role || '').slice(0, 200),
    };
  }
  return out;
}
const firstLocal = (members) => members.find((id) => !isRemoteId(id)) || null;

function normalizeGroup(raw) {
  const members = normalizeMemberIds(raw.members);
  const coordinatorId = raw.coordinatorId && members.includes(raw.coordinatorId) ? String(raw.coordinatorId) : null;
  return {
    id: safeId(raw.id),
    name: String(raw.name || raw.id || 'Group'),
    members,
    remotes: keepRemotes(raw.remotes, members),
    coordinatorId,
    createdAt: raw.createdAt || nowIso(),
    updatedAt: raw.updatedAt || raw.createdAt || nowIso(),
  };
}

export async function getGroup(id) {
  const raw = await readJson(groupFile(id), null);
  if (!raw) return null;
  return normalizeGroup({ id, ...raw });
}

export async function createGroup({ name, members, coordinatorId, remotes } = {}) {
  const cleanName = String(name ?? '').trim();
  if (!cleanName) throw groupError(400, 'GROUP_NAME_REQUIRED', 'a group needs a name');
  if (cleanName.length > 80) throw groupError(400, 'GROUP_NAME_TOO_LONG', 'a group name is limited to 80 characters');

  const memberIds = normalizeMemberIds(members);
  assertMemberCount(memberIds);

  // The group runs on this machine, so the bot that speaks first must live here.
  if (!firstLocal(memberIds)) throw groupError(400, 'GROUP_NEEDS_LOCAL', '群里至少要有一位这台机器上的机器人（由它来协调）');
  const wanted = String(coordinatorId ?? '').trim();
  const coordinator = wanted || firstLocal(memberIds);
  if (!memberIds.includes(coordinator) || isRemoteId(coordinator)) {
    throw groupError(400, 'GROUP_BAD_COORDINATOR', `coordinator "${coordinator}" must be a group member on this machine`);
  }

  const id = await uniqueGroupId(cleanName);
  const timestamp = nowIso();
  const group = {
    id,
    name: cleanName,
    members: memberIds,
    remotes: keepRemotes(remotes, memberIds),
    coordinatorId: coordinator,
    createdAt: timestamp,
    updatedAt: timestamp,
  };
  await writeJsonAtomic(groupFile(id), group);
  return group;
}

export async function updateGroup(id, patch = {}) {
  const current = await getGroup(id);
  if (!current) throw groupError(404, 'GROUP_NOT_FOUND', `no group with id "${id}"`);

  const next = { ...current };

  if (patch.name !== undefined) {
    const cleanName = String(patch.name ?? '').trim();
    if (!cleanName) throw groupError(400, 'GROUP_NAME_REQUIRED', 'a group needs a name');
    next.name = cleanName.slice(0, 80);
  }

  if (patch.members !== undefined) {
    next.members = normalizeMemberIds(patch.members);
    assertMemberCount(next.members);
    if (!firstLocal(next.members)) throw groupError(400, 'GROUP_NEEDS_LOCAL', '群里至少要有一位这台机器上的机器人（由它来协调）');
    next.remotes = keepRemotes({ ...current.remotes, ...(patch.remotes || {}) }, next.members);
  }

  if (patch.coordinatorId !== undefined) {
    const coordinator = String(patch.coordinatorId ?? '').trim();
    if (!next.members.includes(coordinator) || isRemoteId(coordinator)) {
      throw groupError(400, 'GROUP_BAD_COORDINATOR', `coordinator "${coordinator}" must be a group member on this machine`);
    }
    next.coordinatorId = coordinator;
  } else if (!next.members.includes(next.coordinatorId)) {
    // The patch removed the coordinator from the roster: promote the first
    // remaining member on this machine instead of leaving a dangling id behind.
    next.coordinatorId = firstLocal(next.members);
  }

  next.updatedAt = nowIso();
  await writeJsonAtomic(groupFile(next.id), next);
  return next;
}

/** Delete the roster and its transcript. Memory of the bots is untouched. */
export async function deleteGroup(id) {
  const current = await getGroup(id);
  if (!current) throw groupError(404, 'GROUP_NOT_FOUND', `no group with id "${id}"`);
  await fsp.rm(groupFile(current.id), { force: true });
  await fsp.rm(groupMessagesFile(current.id), { force: true });
  return { id: current.id, name: current.name, deleted: true };
}

/**
 * Remove a deleted bot from every group, promoting the first remaining member
 * when it was the coordinator. Called by bots.deleteBot, so both the REST route
 * and the bot_delete tool repair the rosters automatically.
 *
 * A group that drops below two members is kept (its transcript is not data we
 * are allowed to throw away silently): it simply refuses to run a turn with a
 * clear GROUP_TOO_SMALL until somebody adds a member.
 */
export async function repairGroupsAfterBotDelete(botId) {
  const repaired = [];
  for (const group of await listGroups()) {
    if (!group.members.includes(botId)) continue;
    const members = group.members.filter((id) => id !== botId);
    const previousCoordinatorId = group.coordinatorId;
    const nextCoordinatorId = members.includes(group.coordinatorId) ? group.coordinatorId : firstLocal(members);
    const next = { ...group, members, coordinatorId: nextCoordinatorId, updatedAt: nowIso() };
    await writeJsonAtomic(groupFile(group.id), next);
    repaired.push({
      id: group.id,
      name: group.name,
      members,
      coordinatorId: nextCoordinatorId,
      previousCoordinatorId,
      coordinatorPromoted: previousCoordinatorId !== nextCoordinatorId,
    });
  }
  return repaired;
}

/**
 * Why this group cannot run a turn right now, or null when it can.
 * Returned instead of thrown so the HTTP layer and the tools can word it their
 * own way, but the codes are the contract.
 */
export function groupRunBlocker(group) {
  if (!group) return { status: 404, code: 'GROUP_NOT_FOUND', message: 'no such group' };
  if (group.members.length < GROUP_MIN_MEMBERS) {
    return {
      status: 409,
      code: 'GROUP_TOO_SMALL',
      message: `"${group.name}" has ${group.members.length} member(s); a group needs at least ${GROUP_MIN_MEMBERS}. Add a bot to it first.`,
    };
  }
  if (!group.coordinatorId || !group.members.includes(group.coordinatorId)) {
    return {
      status: 409,
      code: 'GROUP_NO_COORDINATOR',
      message: `"${group.name}" has no coordinator among its members; pick one with PATCH /api/groups/${group.id}.`,
    };
  }
  return null;
}

// ---------------------------------------------------------------------------
// transcript
// ---------------------------------------------------------------------------

/**
 * Append one message and return it with its id/timestamp.
 * `kind` is user|assistant|tool|status, `from` is 'user' or a bot id. turnId is
 * stored so the runtime can tell whether the coordinator already spoke in this
 * turn, but it is not part of the public shape.
 */
export async function appendGroupMessage(groupId, record = {}) {
  const kind = GROUP_MESSAGE_KINDS.includes(record.kind) ? record.kind : 'status';
  const message = {
    id: record.id || uid('msg'),
    ts: record.ts || nowIso(),
    kind,
    from: String(record.from || (kind === 'user' ? 'user' : 'unknown')),
    ...(record.text !== undefined && String(record.text).trim() ? { text: String(record.text) } : {}),
    ...(record.name ? { name: String(record.name) } : {}),
    ...(record.status ? { status: String(record.status) } : {}),
    ...(record.turnId ? { turnId: String(record.turnId) } : {}),
  };
  await appendJsonl(groupMessagesFile(groupId), message);
  return message;
}

/** The public message shape: exactly {id, ts, kind, from, text?, name?, status?}. */
export function publicGroupMessage(message) {
  return {
    id: message.id,
    ts: message.ts,
    kind: message.kind,
    from: message.from,
    ...(message.text !== undefined ? { text: message.text } : {}),
    ...(message.name !== undefined ? { name: message.name } : {}),
    ...(message.status !== undefined ? { status: message.status } : {}),
  };
}

export async function readGroupMessages(groupId, { limit = 200 } = {}) {
  const all = await readJsonl(groupMessagesFile(groupId));
  return limit > 0 ? all.slice(-limit) : all;
}

/** Did this bot already speak in this turn? Stops the runtime double-posting. */
export async function hasAssistantMessage(groupId, turnId, botId) {
  if (!turnId) return false;
  const records = await readJsonlTail(groupMessagesFile(groupId), {
    windowBytes: 32 * 1024,
    maxBytes: 256 * 1024,
  }).catch(() => []);
  return records.some(
    (record) => record.kind === 'assistant' && record.turnId === turnId && record.from === botId,
  );
}

/**
 * Prior group context for the coordinator's model call.
 *
 * Only user/assistant text is replayed. Another bot's words are attributed with
 * a [Name] prefix in an assistant message, because a chat-completions transcript
 * has no "third party" role; v1 accepts that approximation.
 */
export async function loadGroupHistory(groupId, { limit = 16, names = new Map() } = {}) {
  const records = await readJsonl(groupMessagesFile(groupId));
  const usable = records.filter(
    (record) => (record.kind === 'user' || record.kind === 'assistant') && record.text,
  );
  return usable.slice(-limit).map((record) => {
    if (record.kind === 'user') return { role: 'user', content: String(record.text) };
    const label = names.get(record.from);
    // The coordinator's own words are plain assistant text; a teammate's are
    // attributed so the model does not mistake them for its own.
    return { role: 'assistant', content: label ? `[${label}] ${record.text}` : String(record.text) };
  });
}

function previewText(value) {
  const flat = String(value ?? '').replace(/\s+/g, ' ').trim();
  if (!flat) return null;
  const chars = Array.from(flat);
  return chars.length > PREVIEW_MAX_CHARS ? chars.slice(0, PREVIEW_MAX_CHARS).join('') : flat;
}

/** {text, ts, from} of the last meaningful group message, or null. */
export async function lastGroupPreview(groupId) {
  const file = groupMessagesFile(groupId);
  let size;
  try {
    size = (await fsp.stat(file)).size;
  } catch {
    return null;
  }
  if (!size) return null;

  for (const window of PREVIEW_WINDOWS) {
    const records = await readJsonlTail(file, { windowBytes: window, maxBytes: window }).catch(() => []);
    for (let i = records.length - 1; i >= 0; i -= 1) {
      const record = records[i];
      if (!record || (record.kind !== 'user' && record.kind !== 'assistant')) continue;
      const text = previewText(record.text);
      if (!text) continue;
      return { text, ts: record.ts || null, from: record.from || (record.kind === 'user' ? 'user' : 'unknown') };
    }
    if (size <= window) return null;
  }
  return null;
}
