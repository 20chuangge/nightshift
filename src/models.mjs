// Extra models, so each bot can use its own (a cheap one for chores, a strong
// one for hard work). The machine's model in Settings stays the default; a bot
// with no model of its own, or whose model is gone, uses that.
//
//   config/models.json      [{id, label, provider, baseUrl, model}]   no keys
//   data/model-keys.json    {id: apiKey}                               write-only
//
// Keys go in and never come out: the API reports hasKey only.

import fsp from 'node:fs/promises';
import path from 'node:path';
import { P, readJson, writeJsonAtomic } from './store.mjs';
import { validateSettings, createModelFromSettings, hasKey, loadSettings, loadSecret } from './settings.mjs';
import { providerNeedsKey } from './providers.mjs';

const MAX_PROFILES = 20;
const profilesFile = () => path.join(path.dirname(P.settingsFile), 'models.json');
const keysFile = () => path.join(P.dataDir, 'model-keys.json');

function modelError(status, code, message) {
  const err = new Error(message);
  err.status = status;
  err.code = code;
  return err;
}

const slug = (s) => String(s || '').toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '').slice(0, 32);

export async function listProfiles() {
  const raw = await readJson(profilesFile(), []);
  return Array.isArray(raw) ? raw.filter((p) => p && p.id && p.provider && p.model) : [];
}

/** Same provider as the machine's default and no key of its own: borrow that key. */
async function keyFor(profile, keys) {
  const own = keys[profile.id];
  if (hasKey(own)) return own;
  const def = await loadSettings();
  return def.provider === profile.provider ? await loadSecret() : '';
}

async function readKeys() {
  const raw = await readJson(keysFile(), {});
  return raw && typeof raw === 'object' ? raw : {};
}

/** What the API may show: everything but the key. */
export async function publicProfiles() {
  const keys = await readKeys();
  const out = [];
  for (const p of await listProfiles()) {
    const own = hasKey(keys[p.id]);
    out.push({ ...p, hasKey: own || hasKey(await keyFor(p, keys)) || !providerNeedsKey(p.provider), sharedKey: !own && hasKey(await keyFor(p, keys)) });
  }
  return out;
}

/**
 * Create (no id) or update a model. An empty apiKey on update keeps the old one.
 * -> the public profile
 */
export async function saveProfile({ id, label, provider, baseUrl, model, apiKey } = {}) {
  const profiles = await listProfiles();
  const current = id ? profiles.find((p) => p.id === id) : null;
  if (id && !current) throw modelError(404, 'MODEL_NOT_FOUND', `no model "${id}"`);
  // Same rules as the machine's model (known provider, sane URL and name).
  const clean = validateSettings({
    provider: provider ?? current?.provider,
    baseUrl: baseUrl ?? current?.baseUrl,
    model: model ?? current?.model,
  });
  if (clean.provider === 'mock') throw modelError(400, 'INVALID_PROVIDER', 'pick a real provider');
  const name = String(label ?? current?.label ?? '').trim().slice(0, 40) || clean.model;
  let next;
  if (current) {
    next = { ...current, label: name, provider: clean.provider, baseUrl: clean.baseUrl, model: clean.model };
    profiles[profiles.indexOf(current)] = next;
  } else {
    if (profiles.length >= MAX_PROFILES) throw modelError(400, 'TOO_MANY_MODELS', `at most ${MAX_PROFILES} models`);
    let newId = slug(`${clean.provider}-${clean.model}`) || 'model';
    for (let n = 2; profiles.some((p) => p.id === newId); n += 1) newId = `${slug(`${clean.provider}-${clean.model}`)}-${n}`;
    next = { id: newId, label: name, provider: clean.provider, baseUrl: clean.baseUrl, model: clean.model };
    profiles.push(next);
  }
  await writeJsonAtomic(profilesFile(), profiles);
  if (typeof apiKey === 'string' && apiKey.trim()) {
    const keys = await readKeys();
    keys[next.id] = apiKey.trim();
    await writeJsonAtomic(keysFile(), keys);
    try { await fsp.chmod(keysFile(), 0o600); } catch { /* Windows */ }
  }
  invalidate();
  return (await publicProfiles()).find((p) => p.id === next.id);
}

export async function deleteProfile(id) {
  const profiles = await listProfiles();
  if (!profiles.some((p) => p.id === id)) throw modelError(404, 'MODEL_NOT_FOUND', `no model "${id}"`);
  await writeJsonAtomic(profilesFile(), profiles.filter((p) => p.id !== id));
  const keys = await readKeys();
  if (id in keys) { delete keys[id]; await writeJsonAtomic(keysFile(), keys); }
  invalidate();
  return { ok: true };
}

// --- clients, cached per model until something changes -------------------------

let cache = new Map();
let cacheStamp = '';
function invalidate() { cache = new Map(); cacheStamp = ''; }

/** Changed on disk (another process, a restore): start over. */
async function checkStamp() {
  const stamp = await Promise.all([profilesFile(), keysFile()].map((f) => fsp.stat(f).then((s) => s.mtimeMs, () => 0)));
  const now = stamp.join('|');
  if (now !== cacheStamp) { cache = new Map(); cacheStamp = now; }
}

/**
 * The client a bot talks to: its own model when it has one that works,
 * otherwise null (the caller uses the machine's default).
 */
export async function modelForBot(bot) {
  const id = String(bot?.model || '');
  if (!id) return null;
  await checkStamp();
  if (cache.has(id)) return cache.get(id);
  const profile = (await listProfiles()).find((p) => p.id === id);
  let client = null;
  if (profile) {
    const key = await keyFor(profile, await readKeys());
    if (hasKey(key) || !providerNeedsKey(profile.provider)) {
      client = createModelFromSettings({ provider: profile.provider, baseUrl: profile.baseUrl, model: profile.model }, key);
      if (client.provider === 'mock') client = null;
    }
  }
  cache.set(id, client);
  return client;
}

/** A one-off client for "test this model" before or after saving. */
export async function testClient({ id, provider, baseUrl, model, apiKey } = {}) {
  const current = id ? (await listProfiles()).find((p) => p.id === id) : null;
  const clean = validateSettings({ provider: provider ?? current?.provider, baseUrl: baseUrl ?? current?.baseUrl, model: model ?? current?.model });
  const key = (typeof apiKey === 'string' && apiKey.trim()) || await keyFor({ id: id || '', provider: clean.provider }, await readKeys());
  return createModelFromSettings(clean, key);
}
