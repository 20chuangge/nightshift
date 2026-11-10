// Working across the human's machines: asking a bot on another machine to do
// something (a hand-off, a turn in a group, a message from Feishu) with the
// files the request names carried over, and the files its answer names
// brought back. Workspaces are separate per machine, so without this every
// bot had to remember file_send / file_fetch by itself.
//
//   askPeerBot(peers, peer, {botId, text, handoff, workspaceDir})
//     -> {status, turnId, reply, sent:[{from,to}], fetched:[{from,to}]}
//   resolveRemoteMember(peers, "编剧@Ubuntu" | "bot-id@Ubuntu" | "编剧")
//     -> {id:"bot-id@Ubuntu", info:{botId, machine, name, role}} | null

import fsp from 'node:fs/promises';
import path from 'node:path';

const MAX_FILE_BYTES = 25 * 1024 * 1024;
const PATH_RE = /(?:^|[\s`'"(（「：:，,])((?:[\w.\-一-鿿]+\/)+[\w.\-一-鿿]+\.[A-Za-z0-9]{1,6})(?=$|[\s`'")）」，。,;；:：、!！?？])/g;

/** Workspace-relative file paths a text names, in order, once each. */
export function pathsIn(text) {
  const out = [];
  for (const m of String(text || '').matchAll(PATH_RE)) {
    const rel = m[1].replace(/^\.\//, '').replace(/^workspace\//, '');
    if (!rel || rel.startsWith('/') || rel.includes('..') || out.includes(rel)) continue;
    out.push(rel);
  }
  return out;
}

const insideWorkspace = (workspaceDir, rel) => {
  const root = path.resolve(workspaceDir);
  const abs = path.resolve(root, rel);
  return abs.startsWith(root + path.sep) ? abs : null;
};

/** Upload the workspace files the text names to the peer. -> [{from, to}] */
export async function carryFilesOut(peers, peer, text, workspaceDir, { max = 8 } = {}) {
  const sent = [];
  if (!workspaceDir) return sent;
  for (const rel of pathsIn(text)) {
    if (sent.length >= max) break;
    const abs = insideWorkspace(workspaceDir, rel);
    if (!abs) continue;
    const st = await fsp.stat(abs).catch(() => null);
    if (!st?.isFile() || st.size > MAX_FILE_BYTES) continue;
    try {
      const bytes = await fsp.readFile(abs);
      const out = await peers.json(peer, 'POST', '/api/uploads', { raw: bytes, headers: { 'x-file-name': encodeURIComponent(path.basename(abs)) }, timeoutMs: 120000 });
      if (out?.path) sent.push({ from: rel, to: out.path });
    } catch { /* that one stays behind; the bot can still file_send it */ }
  }
  return sent;
}

/** What the bot over there is told about the files that came along. */
export function carriedNote(sent) {
  if (!sent.length) return '';
  return `\n\n（随这条消息带过来的文件，已经放在你这台机器的工作区里：\n${sent.map((f) => `- ${f.from} → ${f.to}`).join('\n')}\n上文写的是对方机器上的路径，请用箭头后面的路径。）`;
}

/** Fetch the files the reply names from the peer into from-machines/<machine>/<day>/. -> [{from, to}] */
export async function bringFilesBack(peers, peer, reply, workspaceDir, { skip = [], max = 6 } = {}) {
  const fetched = [];
  if (!workspaceDir) return fetched;
  const day = new Date().toISOString().slice(0, 10);
  const dir = path.posix.join('from-machines', String(peer.name).replace(/[\\/:*?"<>|]/g, '_'), day);
  for (const rel of pathsIn(reply)) {
    if (fetched.length >= max) break;
    // Pages are opened from that machine by the chat; what was just sent over is already here.
    if (skip.includes(rel) || /^pages\/[^/]+\.html$/.test(rel) || rel.startsWith('from-machines/')) continue;
    try {
      const res = await peers.call(peer, 'GET', `/api/workspace/file?path=${encodeURIComponent(rel)}`, { timeoutMs: 120000 });
      if (!res.ok) continue;
      const bytes = Buffer.from(await res.arrayBuffer());
      if (bytes.length > MAX_FILE_BYTES) continue;
      const to = path.posix.join(dir, path.posix.basename(rel));
      await fsp.mkdir(path.join(workspaceDir, dir), { recursive: true });
      await fsp.writeFile(path.join(workspaceDir, to), bytes);
      fetched.push({ from: rel, to });
    } catch { /* not a file there, or away: the path stays as written */ }
  }
  return fetched;
}

export function fetchedNote(fetched, machine) {
  if (!fetched.length) return '';
  return `\n\n（「${machine}」上的这些文件已经取回这台机器：${fetched.map((f) => `${f.from} → ${f.to}`).join('；')}）`;
}

/**
 * Run one turn of a bot on another machine and wait for its answer.
 * Files the text names go along; files the answer names come back.
 */
export async function askPeerBot(peers, peer, { botId, text, handoff, workspaceDir = '', signal = null, carry = true, timeoutMs = 30 * 60 * 1000, pollMs = 3000 } = {}) {
  const sent = carry ? await carryFilesOut(peers, peer, text, workspaceDir) : [];
  const started = await peers.json(peer, 'POST', `/api/bots/${encodeURIComponent(botId)}/message`, {
    body: { text: String(text || '') + carriedNote(sent), ...(handoff ? { handoff } : {}) },
    timeoutMs: 20000,
  });
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (signal?.aborted) throw Object.assign(new Error('cancelled'), { code: 'CANCELLED' });
    await new Promise((r) => setTimeout(r, pollMs));
    let msgs;
    try { msgs = await peers.json(peer, 'GET', `/api/bots/${encodeURIComponent(botId)}/messages?limit=60`, { timeoutMs: 15000, signal }); } catch { continue; }
    const mine = (msgs.messages || msgs || []).filter((m) => m.turnId === started.turnId);
    const done = mine.find((m) => m.role === 'status');
    if (!done) continue;
    const reply = mine.filter((m) => m.role === 'assistant').map((m) => m.text).join('\n\n').trim() || done.summary || '';
    const fetched = carry ? await bringFilesBack(peers, peer, reply, workspaceDir, { skip: sent.map((f) => f.to) }) : [];
    return { status: done.status || 'success', turnId: started.turnId, reply, sent, fetched };
  }
  throw Object.assign(new Error(`「${peer.name}」上的机器人 30 分钟还没做完`), { code: 'PEER_TIMEOUT' });
}

/** A group member (or Feishu target) on another machine, from "name@machine", "id@machine" or a bare name. */
export async function resolveRemoteMember(peers, ref) {
  if (!peers) return null;
  const raw = String(ref || '').trim();
  if (!raw) return null;
  const at = raw.lastIndexOf('@');
  const who = (at > 0 ? raw.slice(0, at) : raw).trim().toLowerCase();
  const where = at > 0 ? raw.slice(at + 1).trim().toLowerCase() : '';
  const hits = [];
  for (const m of await peers.rosters().catch(() => [])) {
    if (where && m.machine.toLowerCase() !== where) continue;
    for (const b of m.bots || []) {
      if (b.id.toLowerCase() === who || String(b.name).toLowerCase() === who) hits.push({ machine: m.machine, bot: b });
    }
  }
  // A bare name must be the only one of that name on the other machines.
  if (hits.length !== 1) return null;
  const { machine, bot } = hits[0];
  return { id: `${bot.id}@${machine}`, info: { botId: bot.id, machine, name: bot.name, role: bot.role || '' } };
}

export const isRemoteMember = (id) => String(id || '').includes('@');
