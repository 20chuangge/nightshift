/**
 * vault.mjs - logins and other secrets the human hands to the bots, kept on
 * this machine and never shown to a model.
 *
 *   data/vault.key    32 random bytes (0600), made on first use
 *   data/vault.json   {entries:[{id, name, site, fields:{label: {iv, tag, data}}, createdAt, updatedAt}]}
 *
 * Values are encrypted with AES-256-GCM. That makes a copied vault.json
 * useless on its own; it is not protection against someone who controls the
 * whole machine (the key sits next to it) - the settings page says so.
 *
 * Nothing in this module returns a value to an HTTP client or a tool result.
 * reveal() is only for the browser tool that types the value into a page.
 */

import crypto from 'node:crypto';
import fsp from 'node:fs/promises';
import path from 'node:path';
import { P, readJson, writeJsonAtomic, nowIso, uid } from './store.mjs';

const KEY_FILE = () => path.join(P.dataDir, 'vault.key');
const VAULT_FILE = () => path.join(P.dataDir, 'vault.json');
const MAX_ENTRIES = 200;
const MAX_FIELDS = 8;
const MAX_VALUE = 2000;

function vaultError(status, code, message) {
  const err = new Error(message);
  err.status = status;
  err.code = code;
  return err;
}

let keyCache = null;
async function key() {
  if (keyCache) return keyCache;
  try {
    const raw = await fsp.readFile(KEY_FILE());
    if (raw.length === 32) { keyCache = raw; return keyCache; }
  } catch { /* first use */ }
  const fresh = crypto.randomBytes(32);
  await fsp.mkdir(P.dataDir, { recursive: true });
  await fsp.writeFile(KEY_FILE(), fresh, { mode: 0o600 });
  try { await fsp.chmod(KEY_FILE(), 0o600); } catch { /* Windows */ }
  keyCache = fresh;
  return keyCache;
}

async function seal(value) {
  const iv = crypto.randomBytes(12);
  const cipher = crypto.createCipheriv('aes-256-gcm', await key(), iv);
  const data = Buffer.concat([cipher.update(String(value), 'utf8'), cipher.final()]);
  return { iv: iv.toString('base64'), tag: cipher.getAuthTag().toString('base64'), data: data.toString('base64') };
}

async function open(box) {
  const decipher = crypto.createDecipheriv('aes-256-gcm', await key(), Buffer.from(box.iv, 'base64'));
  decipher.setAuthTag(Buffer.from(box.tag, 'base64'));
  return Buffer.concat([decipher.update(Buffer.from(box.data, 'base64')), decipher.final()]).toString('utf8');
}

async function load() {
  const raw = await readJson(VAULT_FILE(), null);
  return Array.isArray(raw?.entries) ? raw.entries : [];
}

async function save(entries) {
  await writeJsonAtomic(VAULT_FILE(), { entries, updatedAt: nowIso() });
  try { await fsp.chmod(VAULT_FILE(), 0o600); } catch { /* Windows */ }
}

/** What anyone may see: names, site and which fields exist. Never values. */
function publicEntry(e) {
  return { id: e.id, name: e.name, site: e.site || '', fields: Object.keys(e.fields || {}), createdAt: e.createdAt, updatedAt: e.updatedAt };
}

const cleanName = (v) => String(v || '').trim().replace(/[\\/]+/g, '-').slice(0, 60);
const cleanLabel = (v) => String(v || '').trim().slice(0, 30);

export async function listVault() {
  return (await load()).map(publicEntry);
}

/** Find by id or by name (case-insensitive). */
function find(entries, ref) {
  const key = String(ref || '').trim().toLowerCase();
  return entries.find((e) => e.id === ref) || entries.find((e) => e.name.toLowerCase() === key) || null;
}

/**
 * Create or update an entry. values: {label: value}; an empty value leaves
 * that field unchanged on an update.
 */
export async function putVault({ id = null, name, site = '', values = {} }) {
  const entries = await load();
  const label = cleanName(name);
  let entry = id ? entries.find((e) => e.id === id) : find(entries, label);
  if (!entry && !label) throw vaultError(400, 'VAULT_BAD_NAME', '给这条起个名字，比如「京东」');
  const pairs = Object.entries(values || {}).map(([k, v]) => [cleanLabel(k), String(v ?? '')]).filter(([k]) => k);
  if (pairs.length > MAX_FIELDS) throw vaultError(400, 'VAULT_TOO_MANY_FIELDS', `最多 ${MAX_FIELDS} 项`);
  if (pairs.some(([, v]) => v.length > MAX_VALUE)) throw vaultError(400, 'VAULT_VALUE_TOO_LONG', '内容太长');
  if (!entry) {
    if (entries.length >= MAX_ENTRIES) throw vaultError(400, 'VAULT_FULL', `保险箱最多 ${MAX_ENTRIES} 条`);
    if (!pairs.some(([, v]) => v)) throw vaultError(400, 'VAULT_EMPTY', '至少填一项');
    entry = { id: uid('vault'), name: label, site: String(site || '').slice(0, 300), fields: {}, createdAt: nowIso(), updatedAt: nowIso() };
    entries.push(entry);
  } else {
    if (label) entry.name = label;
    if (site) entry.site = String(site).slice(0, 300);
  }
  for (const [k, v] of pairs) {
    if (v) entry.fields[k] = await seal(v);
  }
  entry.updatedAt = nowIso();
  await save(entries);
  return publicEntry(entry);
}

export async function deleteVault(id) {
  const entries = await load();
  const next = entries.filter((e) => e.id !== id);
  if (next.length === entries.length) throw vaultError(404, 'VAULT_NOT_FOUND', '保险箱里没有这一条');
  await save(next);
  return { ok: true };
}

/**
 * The value itself - only for code that types it into a page. Field matching
 * is forgiving: "password" finds 密码, "账号" finds username.
 */
export async function revealVault(ref, field) {
  const entry = find(await load(), ref);
  if (!entry) throw vaultError(404, 'VAULT_NOT_FOUND', `保险箱里没有「${ref}」`);
  const want = String(field || '').trim().toLowerCase();
  const aliases = {
    password: ['password', 'pass', 'pwd', '密码', '口令'],
    username: ['username', 'user', 'account', 'login', 'email', 'phone', '账号', '用户名', '邮箱', '手机号', '手机'],
  };
  const group = Object.values(aliases).find((list) => list.includes(want)) || [want];
  const label = Object.keys(entry.fields).find((k) => k.toLowerCase() === want)
    || Object.keys(entry.fields).find((k) => group.includes(k.toLowerCase()));
  if (!label) throw vaultError(404, 'VAULT_NO_FIELD', `「${entry.name}」里没有「${field}」，有：${Object.keys(entry.fields).join('、')}`);
  return { entry: publicEntry(entry), field: label, value: await open(entry.fields[label]) };
}
