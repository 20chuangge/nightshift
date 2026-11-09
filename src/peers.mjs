// Other machines this hub can work with directly ("peers"). The desktop client
// knows every machine and holds a pairing token for each; it hands each hub the
// list of the others (name, LAN and Tailscale address, token). Hubs then talk
// to each other without the client: a bot here can hand work to a bot there
// and move files, even while the laptop is closed.
//
// data/peers.json [{name, url, tailnetUrl, token}] - tokens never leave through
// any route. This computer's own hub listens on loopback only, so other
// machines cannot call into it; it can still call out to them.

import fsp from 'node:fs/promises';
import { readJson, writeJsonAtomic } from './store.mjs';

const clean = (u) => String(u || '').trim().replace(/\/+$/, '');

export function createPeers({ file, fetchImpl = fetch } = {}) {
  let peers = [];
  const rosters = new Map(); // name -> {at, bots}

  async function save() {
    await writeJsonAtomic(file, peers);
    try { await fsp.chmod(file, 0o600); } catch { /* Windows */ }
  }

  /** The peer a bot means: by machine name (any case, partial ok) or address. */
  function find(ref) {
    const r = String(ref || '').trim().toLowerCase();
    if (!r) return null;
    return peers.find((p) => p.name.toLowerCase() === r || clean(p.url).toLowerCase() === clean(r))
      || peers.find((p) => p.name.toLowerCase().includes(r) || r.includes(p.name.toLowerCase()))
      || null;
  }

  /** One request to a peer: its LAN address first, then its Tailscale address. */
  async function call(peer, method, path, { body, raw, headers = {}, timeoutMs = 20000, signal } = {}) {
    let lastErr = null;
    for (const base of [peer.url, peer.tailnetUrl].filter(Boolean)) {
      try {
        const res = await fetchImpl(`${clean(base)}${path}`, {
          method,
          headers: { authorization: `Bearer ${peer.token}`, ...(body !== undefined ? { 'content-type': 'application/json' } : {}), ...headers },
          body: raw !== undefined ? raw : body !== undefined ? JSON.stringify(body) : undefined,
          signal: signal ? AbortSignal.any([signal, AbortSignal.timeout(timeoutMs)]) : AbortSignal.timeout(timeoutMs),
        });
        if (res.status === 401 || res.status === 403) throw Object.assign(new Error(`「${peer.name}」不认这台机器的凭据（需要在夜班客户端里重新配对那台机器）`), { code: 'PEER_UNAUTHORIZED' });
        return res;
      } catch (err) {
        if (err.code === 'PEER_UNAUTHORIZED' || signal?.aborted) throw err;
        lastErr = err;
      }
    }
    throw Object.assign(new Error(`连不上「${peer.name}」（${lastErr?.message || '没有可用地址'}）`), { code: 'PEER_UNREACHABLE' });
  }

  async function json(peer, method, path, opts) {
    const res = await call(peer, method, path, opts);
    const data = await res.json().catch(() => ({}));
    if (!res.ok) throw Object.assign(new Error(data?.error?.message || `「${peer.name}」返回 ${res.status}`), { code: data?.error?.code || 'PEER_ERROR' });
    return data;
  }

  return {
    async load() {
      const raw = await readJson(file, []);
      peers = Array.isArray(raw) ? raw.filter((p) => p && p.name && p.url && p.token) : [];
    },

    /** Replace the list (the desktop client sends it). */
    async set(list) {
      peers = (Array.isArray(list) ? list : []).slice(0, 30).map((p) => ({
        name: String(p?.name || '').trim().slice(0, 60),
        url: clean(p?.url),
        tailnetUrl: clean(p?.tailnetUrl),
        token: String(p?.token || '').trim(),
      })).filter((p) => p.name && /^https?:\/\//.test(p.url) && /^[A-Za-z0-9._~-]{8,200}$/.test(p.token));
      rosters.clear();
      await save();
      return this.list();
    },

    /** What a route or a bot may see: never the tokens. */
    list() {
      return peers.map((p) => ({ name: p.name, url: p.url, tailnetUrl: p.tailnetUrl || '' }));
    },

    find,
    call,
    json,

    /** The bots on every peer (cached 5 min; unreachable peers are skipped). */
    async rosters({ fresh = false } = {}) {
      const out = [];
      await Promise.all(peers.map(async (p) => {
        const hit = rosters.get(p.name);
        if (!fresh && hit && Date.now() - hit.at < 5 * 60 * 1000) { out.push({ machine: p.name, bots: hit.bots }); return; }
        try {
          const data = await json(p, 'GET', '/api/bots', { timeoutMs: 5000 });
          const bots = (data.bots || data || []).map((b) => ({ id: b.id, name: b.name, role: b.role || '', primary: Boolean(b.primary) }));
          rosters.set(p.name, { at: Date.now(), bots });
          out.push({ machine: p.name, bots });
        } catch { /* off or away */ }
      }));
      return out;
    },
  };
}
