/**
 * bots.mjs - the bot registry.
 *
 * A bot is a durable teammate, not a chat session: it has an id, a display name,
 * an avatar (shape + colour + an optional uploaded image), a role, its own tool
 * grants, its own skill grants, its own approval policy, its own memory
 * directory and its own append-only session log. Deleting a bot removes it from
 * the roster but keeps its memory on disk, because "I deleted the teammate"
 * should not mean "I lost what it learned".
 *
 * Bots live as one JSON file per bot in config/bots/, which makes them diffable,
 * hand-editable, and easy to seed in a repo. Uploaded avatar images are the one
 * thing that is not JSON: they live in data/avatars/<botId>.<ext> and the bot
 * file only records the shape and colour.
 */

import path from 'node:path';
import fsp from 'node:fs/promises';
import {
  P,
  readJson,
  writeJsonAtomic,
  writeFileAtomic,
  listFiles,
  nowIso,
  uid,
  readJsonlTail,
  sessionFile,
} from './store.mjs';
import { DEFAULT_DENY_PATTERNS } from './approvals.mjs';
import { readSkill } from './skills.mjs';
import { repairGroupsAfterBotDelete } from './groups.mjs';

function localTimezone() {
  try {
    return Intl.DateTimeFormat().resolvedOptions().timeZone || 'UTC';
  } catch {
    return 'UTC';
  }
}

export const DEFAULT_ASSISTANT_CONFIG = {
  name: 'My Assistant',
  persona:
    'A calm, competent teammate. You do the work instead of describing it, you say what you actually did, and you ask before doing anything irreversible.',
  timezone: localTimezone(),
  primaryBotId: 'chief',
  policy: {
    autoApproveMedium: false,
    denyPatterns: DEFAULT_DENY_PATTERNS,
    approvalTimeoutMs: 600000,
  },
};

const AVATAR_COLORS = ['#7c5cff', '#22c55e', '#f59e0b', '#38bdf8', '#f472b6', '#a3e635', '#fb7185', '#c084fc'];

// ---------------------------------------------------------------------------
// avatars
// ---------------------------------------------------------------------------

/**
 * The shapes the UI knows how to draw. This list is a contract: it is what
 * `avatar.shape` is allowed to be, and the names must stay in sync with the
 * CSS/SVG in public/, so do not "improve" them here.
 */
export const AVATAR_SHAPES = [
  'squircle',
  'circle',
  'blob',
  'star',
  'flower',
  'hex',
  'octagon',
  'diamond',
  'arch',
  'leaf',
  'gem',
  'wave',
  'ring',
  'drop',
  'chip',
];

export const DEFAULT_AVATAR_SHAPE = 'squircle';
export const DEFAULT_AVATAR_COLOR = '#8b5cf6';
const AVATAR_COLOR_RE = /^#[0-9a-f]{6}$/i;

/** Uploaded images: what we accept in, and what we serve back out. */
export const AVATAR_MIME_TYPES = ['image/png', 'image/jpeg', 'image/webp'];
export const AVATAR_MAX_BYTES = 2 * 1024 * 1024;
const AVATAR_EXT_BY_MIME = { 'image/png': 'png', 'image/jpeg': 'jpg', 'image/webp': 'webp' };
const AVATAR_MIME_BY_EXT = { png: 'image/png', jpg: 'image/jpeg', webp: 'image/webp' };

/** Where the UI loads the bytes from. The UI appends ?v=<mtime> itself. */
export function avatarUrlFor(id) {
  return `/api/bots/${encodeURIComponent(String(id))}/avatar`;
}

function avatarStem(id) {
  // Same rule as sessionFile(): a bot id must never be able to escape its dir.
  return String(id).replace(/[^a-zA-Z0-9._-]/g, '_');
}

function normalizeColor(value) {
  const text = typeof value === 'string' ? value.trim() : '';
  return AVATAR_COLOR_RE.test(text) ? text.toLowerCase() : null;
}

/**
 * Coerce a stored avatar into the public shape, forgiving bad data.
 *
 * This is the read path: a hand-edited config/bots/<id>.json with
 * `avatar: {shape: "potato"}` must not take the roster down, so unknown values
 * degrade to the default instead of throwing. Input from HTTP is validated
 * strictly by parseAvatarInput() below.
 */
function normalizeAvatar(raw, fallbackColor) {
  const source = raw && typeof raw === 'object' && !Array.isArray(raw) ? raw : {};
  const shapeText = String(source.shape ?? '').toLowerCase();
  return {
    shape: AVATAR_SHAPES.includes(shapeText) ? shapeText : DEFAULT_AVATAR_SHAPE,
    color: normalizeColor(source.color) || normalizeColor(fallbackColor) || DEFAULT_AVATAR_COLOR,
    // Filled in from the filesystem by withAvatarImage() / listBots(); never
    // written back to the bot file.
    hasImage: false,
    imageUrl: null,
  };
}

/**
 * Validate the `avatar` member of a create/patch body.
 * @returns {{shape?: string, color?: string}|null} null when the body has no avatar
 * @throws {Error} 400 AVATAR_INVALID / AVATAR_BAD_SHAPE / AVATAR_BAD_COLOR
 */
function parseAvatarInput(input) {
  const raw = input && typeof input === 'object' ? input.avatar : undefined;
  if (raw === undefined) return null;
  if (raw === null || typeof raw !== 'object' || Array.isArray(raw)) {
    throw httpError(400, 'AVATAR_INVALID', 'avatar must be an object like {shape:"circle", color:"#22c55e"}');
  }

  const out = {};
  if (raw.shape !== undefined) {
    const shape = String(raw.shape).trim().toLowerCase();
    if (!AVATAR_SHAPES.includes(shape)) {
      throw httpError(400, 'AVATAR_BAD_SHAPE', `avatar.shape must be one of: ${AVATAR_SHAPES.join(', ')}`);
    }
    out.shape = shape;
  }
  if (raw.color !== undefined) {
    const color = normalizeColor(raw.color);
    if (!color) {
      throw httpError(400, 'AVATAR_BAD_COLOR', 'avatar.color must be a six-digit hex colour like "#8b5cf6"');
    }
    out.color = color;
  }
  return out;
}

/** One image per bot: find the file whoever wrote it last, whatever its format. */
export async function findAvatarFile(id) {
  const stem = avatarStem(id);
  for (const ext of Object.keys(AVATAR_MIME_BY_EXT)) {
    const file = path.join(P.avatarsDir, `${stem}.${ext}`);
    try {
      const stat = await fsp.stat(file);
      if (stat.isFile()) return { file, ext, mime: AVATAR_MIME_BY_EXT[ext] };
    } catch (err) {
      if (err.code !== 'ENOENT') throw err;
    }
  }
  return null;
}

/** ext -> mime, for the GET route. */
export function avatarMimeForExt(ext) {
  return AVATAR_MIME_BY_EXT[String(ext).toLowerCase()] || 'application/octet-stream';
}

/** Replace whatever image the bot had with these bytes (extension follows MIME). */
export async function saveAvatarImage(id, bytes, mime) {
  const ext = AVATAR_EXT_BY_MIME[mime];
  if (!ext) throw httpError(400, 'AVATAR_BAD_TYPE', `avatar must be one of: ${AVATAR_MIME_TYPES.join(', ')}`);
  await removeAvatarImage(id);
  await writeFileAtomic(path.join(P.avatarsDir, `${avatarStem(id)}.${ext}`), bytes);
  return avatarUrlFor(id);
}

/** Delete the image, if any. Returns whether there was one. */
export async function removeAvatarImage(id) {
  const found = await findAvatarFile(id);
  if (!found) return false;
  await fsp.rm(found.file, { force: true });
  return true;
}

/** The avatar as the API shows it: stored shape/colour plus the image facts. */
async function withAvatarImage(bot) {
  const found = await findAvatarFile(bot.id);
  return {
    ...bot,
    avatar: { ...bot.avatar, hasImage: Boolean(found), imageUrl: found ? avatarUrlFor(bot.id) : null },
  };
}

/**
 * What one bot file is allowed to contain. hasImage/imageUrl are derived from
 * the filesystem, so persisting them would only create a second source of truth
 * that can go stale.
 */
function forStorage(bot) {
  return { ...bot, avatar: { shape: bot.avatar.shape, color: bot.avatar.color } };
}

// ---------------------------------------------------------------------------
// previews (what the sidebar shows under the name)
// ---------------------------------------------------------------------------

const PREVIEW_MAX_CHARS = 120;
// Start with the last 32 KB and only widen when that tail holds no real message.
// A turn with many tool cards leaves a lot of noise at the end of the log, so
// "read 32 KB and give up" would show an empty preview exactly on busy bots.
const PREVIEW_WINDOWS = [32 * 1024, 128 * 1024, 512 * 1024, 2 * 1024 * 1024];

/** One line, at most PREVIEW_MAX_CHARS characters (code points, so emoji count as one). */
function previewText(value) {
  const flat = String(value ?? '').replace(/\s+/g, ' ').trim();
  if (!flat) return null;
  const chars = Array.from(flat);
  return chars.length > PREVIEW_MAX_CHARS ? chars.slice(0, PREVIEW_MAX_CHARS).join('') : flat;
}

/** Newest user/assistant record with text, scanning backwards. */
function pickPreview(records) {
  for (let i = records.length - 1; i >= 0; i -= 1) {
    const record = records[i];
    if (!record || (record.kind !== 'user' && record.kind !== 'assistant')) continue;
    const text = previewText(record.text);
    if (!text) continue;
    return { text, ts: record.ts || null, kind: record.kind };
  }
  return null;
}

/**
 * The last meaningful message this bot sent or received.
 *
 * "Meaningful" is user/assistant text: tool cards, approval cards and turn
 * status rows are noise in a sidebar. The session log is append-only and can be
 * huge, so only its tail is read (see readJsonlTail), widening the window when
 * the tail is all tool output. 2 MB of pure noise at the very end is the point
 * where we give up and show nothing rather than read the whole transcript.
 *
 * Never throws: a roster endpoint must not fail because one log is unreadable.
 */
export async function lastMessagePreview(botId) {
  const file = sessionFile(botId);
  let size;
  try {
    size = (await fsp.stat(file)).size;
  } catch {
    return null; // no transcript yet (or no permission): no preview
  }
  if (!size) return null;

  for (const window of PREVIEW_WINDOWS) {
    const records = await readJsonlTail(file, { windowBytes: window, maxBytes: window }).catch(() => []);
    const found = pickPreview(records);
    if (found) return found;
    if (size <= window) return null; // that window already held the whole file
  }
  return null;
}


/** Merge the shipped config with defaults, so a partial file still boots. */
export async function loadAssistantConfig() {
  const raw = (await readJson(P.assistantConfig, {})) || {};
  return {
    ...DEFAULT_ASSISTANT_CONFIG,
    ...raw,
    policy: {
      ...DEFAULT_ASSISTANT_CONFIG.policy,
      ...(raw.policy || {}),
    },
  };
}

export async function writeAssistantConfig(config) {
  await writeJsonAtomic(P.assistantConfig, config);
}

function botFile(id) {
  const safe = String(id).replace(/[^a-zA-Z0-9._-]/g, '_');
  return path.join(P.botsDir, `${safe}.json`);
}

function slugifyId(value) {
  return String(value || '')
    .trim()
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, 40);
}

function normalizeBot(raw, index) {
  const id = slugifyId(raw.id || raw.name) || `bot-${index}`;
  const policy = raw.policy || {};
  // avatarColor stays for every older client (and older bot files); the avatar's
  // colour falls back to it so a legacy bot keeps the colour people recognise.
  const avatarColor = String(raw.avatarColor || AVATAR_COLORS[index % AVATAR_COLORS.length]);
  return {
    id,
    name: String(raw.name || id),
    avatarColor,
    avatar: normalizeAvatar(raw.avatar, avatarColor),
    role: String(raw.role || ''),
    persona: String(raw.persona || ''),
    primary: Boolean(raw.primary),
    // Tool grants: an empty list means "use the default grant set" only when the
    // file explicitly omits the key; an explicit [] means the bot can do nothing.
    tools: Array.isArray(raw.tools) ? raw.tools.map(String) : [],
    skills: Array.isArray(raw.skills) ? raw.skills.map(String) : [],
    // Tools the human took away: a later release's grant migration must not
    // hand them back.
    revokedTools: Array.isArray(raw.revokedTools) ? raw.revokedTools.map(String) : [],
    // Its own model (an id from Settings → 模型), or '' for the machine's default.
    model: String(raw.model || '').slice(0, 40),
    // Its own voice for replies read aloud (a voice id of the speech service), or '' for the machine's.
    voice: String(raw.voice || '').trim().slice(0, 120),
    // Kept through edits: without it, renaming a built-in bot re-ran the
    // grant migration on the next start.
    ...(raw.seedGrantsVersion ? { seedGrantsVersion: Number(raw.seedGrantsVersion) } : {}),
    policy: {
      autoApproveMedium: policy.autoApproveMedium ?? false,
      denyPatterns: Array.isArray(policy.denyPatterns) ? policy.denyPatterns.map(String) : [],
      maxSteps: Number(policy.maxSteps || 80),
      maxTurnMs: Number(policy.maxTurnMs || 30 * 60 * 1000),
    },
    createdAt: raw.createdAt || nowIso(),
  };
}

/** id -> image extension, from a single readdir, so listing N bots stays O(1) syscalls. */
async function avatarFilesByBot() {
  const map = new Map();
  for (const name of await listFiles(P.avatarsDir)) {
    const dot = name.lastIndexOf('.');
    if (dot <= 0) continue;
    const ext = name.slice(dot + 1).toLowerCase();
    if (!AVATAR_MIME_BY_EXT[ext]) continue;
    map.set(name.slice(0, dot), ext);
  }
  return map;
}

/**
 * Seed grants that ship with the app.
 *
 * Why this exists: bot configs are only seeded on first run (copy-if-missing),
 * so a new release that adds a tool would never reach existing installs — the
 * bot silently loses the new capability and the model tells the user "I can't".
 * Bump `version` whenever a new tool must be granted to a built-in bot; the
 * migration only ever ADDS tools, never removes ones the user granted.
 */
export const SEED_GRANTS = {
  chief: {
    version: 6,
    tools: [
      'machine_list', 'machine_switch',
      'bot_create', 'bot_update', 'bot_delete',
      'group_create', 'group_update', 'group_delete', 'group_list', 'group_post',
      'settings_get', 'settings_update', 'ui_get', 'ui_set',
      'shell', 'fs_delete', 'browser_open',
      'desktop_ui',
      // Claude Code / Codex on the human's subscription; every call still asks.
      'cli_agent_run',
    ],
    // The primary bot is the human's single point of contact; it may change
    // product settings without a second confirmation. HIGH risk still asks,
    // and the denylist still wins.
    policy: { autoApproveMedium: true },
  },
  ops: { version: 2, tools: ['group_post', 'browser_open'] },
  researcher: { version: 2, tools: ['group_post', 'browser_open'] },
};

/**
 * Built-in bot text that has changed between releases: [old defaults..., current].
 * Only text that is still an old default is replaced - anything the human
 * typed themselves is left alone. The primary bot went from "总管" (a
 * coordinator over two specialists) to one assistant that does the work.
 */
const BUILTIN_TEXT = {
  chief: {
    name: ['Chief', '总管', '助理'],
    role: ['Coordinator. Splits work, hands tasks to the right specialist, and reports back in one place.',
      '协调者。拆分工作，把任务交给合适的人，并在一处汇总结果。',
      "你的助理。说一句要做什么，它自己把事情办完。"],
    persona: ["You are the primary bot. You prefer delegating to a specialist over doing everything yourself, but you will read and write files when that is quicker. You always end with what changed, not what you intend to do. 始终使用简体中文回答；技术名词、命令、路径、代码和报错原文保持原样。",
      "You are the human's one assistant on this machine. When they say what they want, you do it end to end yourself: run commands, use the browser, edit files, change settings, schedule routines. Never send them to a settings page for something your tools can do. Create another bot only when a role will recur (for example a daily report writer), and a group only when several such bots must work together; do one-off work yourself. You always end with what changed, not what you intend to do. 始终使用简体中文回答；技术名词、命令、路径、代码和报错原文保持原样。"],
  },
  ops: {
    name: ['Ops', '运维'],
    role: ['Runs commands, keeps the workspace tidy, and asks before anything irreversible.',
      '执行命令，保持工作区整洁；任何不可逆的操作都先询问。'],
  },
  researcher: {
    name: ['Researcher', '研究'],
    role: ['Reads the web and the workspace, then writes the short version. No shell access, by design.',
      '阅读网页与工作区，然后写出简短版本。按设计不接触 shell。'],
  },
};

/** Idempotent language migration for untouched built-in bots. */
export async function migrateBuiltinNames() {
  let changed = 0;
  for (const [id, spec] of Object.entries(BUILTIN_TEXT)) {
    const file = path.join(P.botsDir, `${id}.json`);
    let bot;
    try {
      bot = JSON.parse(await fsp.readFile(file, 'utf8'));
    } catch {
      continue; // deleted by the user: respect that
    }
    let touched = false;
    for (const [field, versions] of Object.entries(spec)) {
      const current = versions[versions.length - 1];
      if (bot[field] !== current && versions.slice(0, -1).includes(bot[field])) {
        bot[field] = current;
        touched = true;
      }
    }
    if (!touched) continue;
    await writeJsonAtomic(file, bot);
    changed += 1;
  }
  return changed;
}

/** Idempotent, additive migration for the built-in bots. Returns how many changed. */
export async function migrateSeedGrants() {
  let changed = 0;
  for (const [id, spec] of Object.entries(SEED_GRANTS)) {
    const file = path.join(P.botsDir, `${id}.json`);
    let bot;
    try {
      bot = JSON.parse(await fsp.readFile(file, 'utf8'));
    } catch {
      continue; // deleted by the user: respect that, do not resurrect it
    }
    if (Number(bot.seedGrantsVersion || 0) >= spec.version) continue;
    const tools = new Set(Array.isArray(bot.tools) ? bot.tools : []);
    const before = tools.size;
    const revoked = new Set(Array.isArray(bot.revokedTools) ? bot.revokedTools : []);
    for (const tool of spec.tools) if (!revoked.has(tool)) tools.add(tool);
    bot.tools = [...tools];
    if (spec.policy && typeof spec.policy === 'object') {
      bot.policy = { ...(bot.policy || {}), ...spec.policy };
    }
    bot.seedGrantsVersion = spec.version;
    await fsp.writeFile(file, `${JSON.stringify(bot, null, 2)}\n`);
    if (tools.size !== before) changed += 1;
  }
  return changed;
}

/** All bots, in a stable order (primary first, then alphabetical). */
export async function listBots() {
  const files = await listFiles(P.botsDir, (n) => n.endsWith('.json'));
  const images = await avatarFilesByBot();
  const bots = [];
  for (const [index, file] of files.entries()) {
    const raw = await readJson(path.join(P.botsDir, file), null);
    if (!raw) continue;
    const bot = normalizeBot({ id: path.basename(file, '.json'), ...raw }, index);
    const hasImage = images.has(avatarStem(bot.id));
    bots.push({
      ...bot,
      avatar: { ...bot.avatar, hasImage, imageUrl: hasImage ? avatarUrlFor(bot.id) : null },
    });
  }
  bots.sort((a, b) => Number(b.primary) - Number(a.primary) || a.name.localeCompare(b.name));
  return bots;
}

export async function getBot(id) {
  const raw = await readJson(botFile(id), null);
  if (!raw) return null;
  return withAvatarImage(normalizeBot({ id, ...raw }, 0));
}

/** The coordinator. Falls back to the first bot if the configured one is gone. */
export async function getPrimaryBot(config) {
  const bots = await listBots();
  if (!bots.length) return null;
  const wanted = config?.primaryBotId;
  return bots.find((b) => b.id === wanted) || bots.find((b) => b.primary) || bots[0];
}

export async function createBot(input = {}) {
  const name = String(input.name || '').trim();
  if (!name) {
    throw httpError(400, 'BOT_INVALID', 'a bot needs a name');
  }
  // A name in Chinese (or any non-Latin script) keeps its name; only the id,
  // which goes into file names and URLs, is made up.
  const id = slugifyId(input.id || name) || `bot-${Math.random().toString(36).slice(2, 8)}`;

  const existing = await readJson(botFile(id), null);
  if (existing) throw httpError(409, 'BOT_EXISTS', `a bot with id "${id}" already exists`);

  // Validate the avatar before anything is written, so a bad request cannot
  // leave half a bot behind.
  const avatarPatch = parseAvatarInput(input);

  const bots = await listBots();
  const avatarColor =
    normalizeColor(input.avatarColor) || avatarPatch?.color || AVATAR_COLORS[bots.length % AVATAR_COLORS.length];
  const bot = normalizeBot(
    {
      ...input,
      id,
      name,
      created: nowIso(),
      avatarColor,
      avatar: { ...(avatarPatch || {}), color: avatarPatch?.color || avatarColor },
      primary: false,
    },
    bots.length,
  );

  await writeJsonAtomic(botFile(id), forStorage(bot));
  return bot;
}

export async function updateBot(id, patch = {}) {
  const current = await readJson(botFile(id), null);
  if (!current) throw httpError(404, 'BOT_NOT_FOUND', `no bot with id "${id}"`);

  // PATCH {avatar:{color}} must keep the shape the bot already had, so merge
  // into the stored avatar instead of replacing the whole object.
  const avatarPatch = parseAvatarInput(patch);
  const currentAvatar = normalizeAvatar(current.avatar, current.avatarColor);

  // Abilities switched off in the UI are remembered as revoked; switching one
  // back on clears it.
  let revokedTools = Array.isArray(current.revokedTools) ? current.revokedTools : [];
  if (Array.isArray(patch.tools)) {
    const next = new Set(patch.tools.map(String));
    const removed = (current.tools || []).filter((t) => !next.has(t));
    revokedTools = [...new Set([...revokedTools, ...removed])].filter((t) => !next.has(t));
  }

  const merged = normalizeBot(
    {
      ...current,
      ...patch,
      revokedTools,
      id, // ids are immutable
      avatarColor: avatarPatch?.color || current.avatarColor,
      avatar: { ...currentAvatar, ...(avatarPatch || {}) },
      policy: { ...(current.policy || {}), ...(patch.policy || {}) },
    },
    0,
  );

  await writeJsonAtomic(botFile(id), forStorage(merged));
  return withAvatarImage(merged);
}

/**
 * Delete a bot. If it was the primary, promote the next bot and tell the config,
 * so the roster is never leaderless. Its avatar image goes with it; its memory
 * and its transcript stay.
 *
 * Group rosters are repaired here rather than in the routes, so the REST route
 * and the bot_delete tool cannot diverge: a deleted member is removed from every
 * group, and a group led by it gets a remaining member promoted (or no
 * coordinator, which the API reports as GROUP_NO_COORDINATOR).
 */
export async function deleteBot(id, config) {
  const file = botFile(id);
  const current = await readJson(file, null);
  if (!current) throw httpError(404, 'BOT_NOT_FOUND', `no bot with id "${id}"`);

  await fsp.rm(file, { force: true });
  await removeAvatarImage(id).catch(() => {});

  const groupsRepaired = await repairGroupsAfterBotDelete(id).catch((err) => {
    console.error('[bots] could not repair groups after deleting a bot:', err.message);
    return [];
  });

  let nextPrimary = null;
  if (config && config.primaryBotId === id) {
    const remaining = await listBots();
    nextPrimary = remaining[0]?.id || null;
    await writeAssistantConfig({ ...config, primaryBotId: nextPrimary });
  }
  return { id, deleted: true, nextPrimaryId: nextPrimary, groupsRepaired };
}

/** Flip the coordinator flag. There is exactly one primary at a time. */
export async function setPrimaryBot(id, config) {
  const target = await getBot(id);
  if (!target) throw httpError(404, 'BOT_NOT_FOUND', `no bot with id "${id}"`);

  const bots = await listBots();
  for (const bot of bots) {
    const shouldBePrimary = bot.id === id;
    if (bot.primary !== shouldBePrimary) {
      await writeJsonAtomic(botFile(bot.id), forStorage({ ...bot, primary: shouldBePrimary }));
    }
  }
  const nextConfig = { ...(config || (await loadAssistantConfig())), primaryBotId: id };
  await writeAssistantConfig(nextConfig);
  return getBot(id);
}

/** Memory directory for a bot (created on demand by memory.mjs, exposed for the UI). */
export function memoryDirFor(id) {
  return path.join(P.memoryDir, String(id).replace(/[^a-zA-Z0-9._-]/g, '_'));
}

/**
 * Resolve the bot's granted skills to full skill records. Unknown grants are
 * ignored (the library may have been edited by hand) rather than throwing.
 */
export async function resolveSkills(bot) {
  const out = [];
  for (const name of bot.skills || []) {
    const skill = await readSkill(name);
    if (skill) out.push(skill);
  }
  return out;
}

export function httpError(status, code, message) {
  const err = new Error(message);
  err.status = status;
  err.code = code;
  return err;
}

export { uid, AVATAR_COLORS, slugifyId };
