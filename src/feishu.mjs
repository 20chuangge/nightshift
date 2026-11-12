/**
 * feishu.mjs - talk to a machine's assistant from Feishu (Lark), on the phone,
 * from anywhere.
 *
 * Feishu's "long connection" mode: this hub opens a WebSocket *out* to Feishu,
 * so the machine needs no public address, port or tunnel. Events come in as
 * protobuf frames (pbbp2.Frame), replies go out over the normal REST API.
 *
 * Who may use it: nobody until they pair. The first message from a Feishu user
 * must contain the pairing code shown in Settings → 飞书; after that their
 * open_id is allowed. Everyone else is told how to pair and nothing runs.
 *
 * data/feishu.json {enabled, appId, appSecret, botId, pairCode, users:[{openId, since, target}]}
 *
 * Who answers: each person has a current target ({botId, machine, name}; none =
 * the primary bot). "@名字 …" talks to that bot and makes it the target, so the
 * next messages need no "@"; "切换" lists every bot (this machine and the
 * others) to pick by number; "/home" goes back to the primary. Every answer
 * starts with 【name · machine】 so it is clear who is talking.
 *
 * A pinned instance (o.pinned) is a separate Feishu app bound to one bot: all
 * its messages go to that bot, no routing commands, and in a group it only
 * answers when it is @-mentioned.
 * The secret is write-only: publicFeishu() reports hasSecret only.
 */

import crypto from 'node:crypto';
import fsp from 'node:fs/promises';
import path from 'node:path';
import { readJson, writeJsonAtomic } from './store.mjs';
import { MiniWebSocket } from './ws-client.mjs';

const OPEN = 'https://open.feishu.cn';

// ---------------------------------------------------------------------------
// protobuf: just the pbbp2.Frame Feishu's long connection uses
//   Frame { uint64 SeqID=1; uint64 LogID=2; int32 service=3; int32 method=4;
//           repeated Header headers=5; string payload_encoding=6;
//           string payload_type=7; bytes payload=8; string LogIDNew=9; }
//   Header { string key=1; string value=2; }
// ---------------------------------------------------------------------------

function readVarint(buf, pos) {
  let result = 0n;
  let shift = 0n;
  for (;;) {
    const b = buf[pos++];
    result |= BigInt(b & 0x7f) << shift;
    if (!(b & 0x80)) return [result, pos];
    shift += 7n;
  }
}

function writeVarint(value) {
  let v = BigInt(value);
  const out = [];
  do {
    let b = Number(v & 0x7fn);
    v >>= 7n;
    if (v) b |= 0x80;
    out.push(b);
  } while (v);
  return Buffer.from(out);
}

function decodeFields(buf) {
  const fields = [];
  let pos = 0;
  while (pos < buf.length) {
    let tag;
    [tag, pos] = readVarint(buf, pos);
    const field = Number(tag >> 3n);
    const wire = Number(tag & 7n);
    if (wire === 0) {
      let v;
      [v, pos] = readVarint(buf, pos);
      fields.push([field, v]);
    } else if (wire === 2) {
      let len;
      [len, pos] = readVarint(buf, pos);
      fields.push([field, buf.subarray(pos, pos + Number(len))]);
      pos += Number(len);
    } else if (wire === 1) { pos += 8; } else if (wire === 5) { pos += 4; } else {
      throw new Error(`protobuf: wire type ${wire} not supported`);
    }
  }
  return fields;
}

export function decodeFrame(buf) {
  const frame = { SeqID: 0n, LogID: 0n, service: 0, method: 0, headers: [], payload: Buffer.alloc(0) };
  for (const [f, v] of decodeFields(buf)) {
    if (f === 1) frame.SeqID = v;
    else if (f === 2) frame.LogID = v;
    else if (f === 3) frame.service = Number(v);
    else if (f === 4) frame.method = Number(v);
    else if (f === 5) {
      const h = { key: '', value: '' };
      for (const [hf, hv] of decodeFields(v)) {
        if (hf === 1) h.key = hv.toString('utf8');
        else if (hf === 2) h.value = hv.toString('utf8');
      }
      frame.headers.push(h);
    } else if (f === 6) frame.payloadEncoding = v.toString('utf8');
    else if (f === 7) frame.payloadType = v.toString('utf8');
    else if (f === 8) frame.payload = Buffer.from(v);
    else if (f === 9) frame.LogIDNew = v.toString('utf8');
  }
  return frame;
}

export function encodeFrame(frame) {
  const parts = [];
  const varintField = (n, v) => { parts.push(writeVarint((n << 3) | 0), writeVarint(v)); };
  const bytesField = (n, b) => { const buf = Buffer.isBuffer(b) ? b : Buffer.from(String(b), 'utf8'); parts.push(writeVarint((n << 3) | 2), writeVarint(buf.length), buf); };
  varintField(1, frame.SeqID || 0n);
  varintField(2, frame.LogID || 0n);
  varintField(3, frame.service || 0);
  varintField(4, frame.method || 0);
  for (const h of frame.headers || []) {
    const inner = Buffer.concat([writeVarint((1 << 3) | 2), writeVarint(Buffer.byteLength(h.key)), Buffer.from(h.key), writeVarint((2 << 3) | 2), writeVarint(Buffer.byteLength(h.value)), Buffer.from(h.value)]);
    bytesField(5, inner);
  }
  if (frame.payloadEncoding) bytesField(6, frame.payloadEncoding);
  if (frame.payloadType) bytesField(7, frame.payloadType);
  if (frame.payload?.length) bytesField(8, frame.payload);
  if (frame.LogIDNew) bytesField(9, frame.LogIDNew);
  return Buffer.concat(parts);
}

const headerOf = (frame, key) => frame.headers.find((h) => h.key === key)?.value;

// ---------------------------------------------------------------------------
// settings
// ---------------------------------------------------------------------------

const newPairCode = () => String(crypto.randomInt(100000, 1000000));

export async function loadFeishu(file) {
  const raw = await readJson(file, null);
  const r = raw && typeof raw === 'object' ? raw : {};
  return {
    enabled: Boolean(r.enabled),
    appId: String(r.appId || ''),
    appSecret: String(r.appSecret || ''),
    botId: String(r.botId || ''),
    pairCode: /^\d{6}$/.test(String(r.pairCode)) ? String(r.pairCode) : newPairCode(),
    users: Array.isArray(r.users) ? r.users.filter((u) => u && u.openId).map((u) => ({
      openId: String(u.openId),
      since: u.since || null,
      target: u.target && u.target.botId ? { botId: String(u.target.botId), machine: String(u.target.machine || ''), name: String(u.target.name || u.target.botId) } : null,
    })) : [],
  };
}

async function saveFeishuFile(file, cfg) {
  await writeJsonAtomic(file, { ...cfg, updatedAt: new Date().toISOString() });
  try { await fsp.chmod(file, 0o600); } catch { /* Windows */ }
}

// ---------------------------------------------------------------------------
// the connection
// ---------------------------------------------------------------------------

/**
 * @param {object} o
 *   file        data/feishu.json
 *   bus         event bus (turn / message / approval events)
 *   runtime     {runTurn}
 *   approvals   {pending(), resolve(id, decision)}
 *   getBots     () => bots (to pick the primary when none is set, and for "@name")
 *   resolveRemote / askRemote / listRemote   bots on the human's other machines ("@name", "@name@machine")
 *   workspaceDir
 *   machineName () => string
 *   pinned      {botId, machine, name}: this app is bound to one bot (machine '' = this one)
 *   fetchImpl, WebSocketImpl, openUrl   (tests)
 */
export function createFeishu(o) {
  const fetchImpl = o.fetchImpl || fetch;
  const WS = o.WebSocketImpl || MiniWebSocket;
  const openUrl = o.openUrl || OPEN;
  let cfg = null;
  let ws = null;
  let status = { connected: false, error: '', since: null };
  let pingTimer = null;
  let retryTimer = null;
  let retryDelay = 5000;
  let serviceId = 0;
  let token = { value: '', until: 0 };
  let stopped = true;
  const seenEvents = new Map(); // event_id -> time (Feishu redelivers)
  const parts = new Map(); // message_id -> [payload parts] (split frames)
  const feishuTurns = new Map(); // turnId -> {messageId, chatId, texts: []}
  const lastChat = new Map(); // botId -> {chatId, messageId, at}
  const waitingApproval = new Map(); // chatId -> approvalId
  const picks = new Map(); // openId -> {list, until} after "切换"
  let unsubscribe = null;

  const log = (...a) => console.log('[feishu]', ...a);

  // ---------------------------------------------------------------- REST
  async function tenantToken() {
    if (token.value && Date.now() < token.until) return token.value;
    const res = await fetchImpl(`${openUrl}/open-apis/auth/v3/tenant_access_token/internal`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ app_id: cfg.appId, app_secret: cfg.appSecret }),
      signal: AbortSignal.timeout(15000),
    });
    const j = await res.json().catch(() => ({}));
    if (j.code !== 0 || !j.tenant_access_token) throw new Error(`飞书拒绝了 App ID / App Secret：${j.msg || res.status}`);
    token = { value: j.tenant_access_token, until: Date.now() + (Number(j.expire || 7200) - 300) * 1000 };
    return token.value;
  }

  async function api(method, apiPath, body, { form = null } = {}) {
    const t = await tenantToken();
    const res = await fetchImpl(`${openUrl}${apiPath}`, {
      method,
      headers: { authorization: `Bearer ${t}`, ...(form ? {} : { 'content-type': 'application/json; charset=utf-8' }) },
      body: form || (body ? JSON.stringify(body) : undefined),
      signal: AbortSignal.timeout(60000),
    });
    const j = await res.json().catch(() => ({}));
    if (j.code !== 0) throw new Error(`飞书接口 ${apiPath} 出错：${j.msg || res.status}`);
    return j.data || {};
  }

  /** Reply in the thread of the message that asked (falls back to the chat). */
  async function send(to, msgType, content) {
    const body = { msg_type: msgType, content: JSON.stringify(content) };
    // A message nobody asked for (a routine's result) goes to the person directly.
    if (to.openId && !to.chatId) return api('POST', '/open-apis/im/v1/messages?receive_id_type=open_id', { ...body, receive_id: to.openId });
    try {
      if (to.messageId) return await api('POST', `/open-apis/im/v1/messages/${encodeURIComponent(to.messageId)}/reply`, body);
    } catch (err) { log('reply failed, sending to chat:', err.message); }
    return api('POST', '/open-apis/im/v1/messages?receive_id_type=chat_id', { ...body, receive_id: to.chatId });
  }

  const sendText = (to, text) => send(to, 'post', { zh_cn: { content: [[{ tag: 'md', text: String(text).slice(0, 25000) }]] } });

  async function sendFile(to, rel) {
    const abs = path.join(o.workspaceDir, rel);
    const bytes = await fsp.readFile(abs);
    const name = path.basename(rel);
    if (/\.(png|jpe?g|gif|webp)$/i.test(rel)) {
      const form = new FormData();
      form.append('image_type', 'message');
      form.append('image', new Blob([bytes]), name);
      const { image_key: key } = await api('POST', '/open-apis/im/v1/images', null, { form });
      return send(to, 'image', { image_key: key });
    }
    const form = new FormData();
    form.append('file_type', /\.mp4$/i.test(rel) ? 'mp4' : 'stream');
    form.append('file_name', name);
    form.append('file', new Blob([bytes]), name);
    const { file_key: key } = await api('POST', '/open-apis/im/v1/files', null, { form });
    return send(to, 'file', { file_key: key });
  }

  /** A voice message the human sent: its bytes (Opus in Ogg). */
  async function downloadAudio(messageId, fileKey) {
    const t = await tenantToken();
    const res = await fetchImpl(`${openUrl}/open-apis/im/v1/messages/${encodeURIComponent(messageId)}/resources/${encodeURIComponent(fileKey)}?type=file`, {
      headers: { authorization: `Bearer ${t}` },
      signal: AbortSignal.timeout(60000),
    });
    if (!res.ok) throw new Error(`下载飞书语音失败：HTTP ${res.status}`);
    return Buffer.from(await res.arrayBuffer());
  }

  /** Answer with a voice message too (the human spoke): Opus upload + audio message. */
  async function sendVoice(to, text) {
    if (typeof o.speak !== 'function') return false;
    const { bytes, durationMs } = await o.speak(text, to.botId);
    const form = new FormData();
    form.append('file_type', 'opus');
    form.append('file_name', 'reply.opus');
    if (durationMs) form.append('duration', String(durationMs));
    form.append('file', new Blob([bytes]), 'reply.opus');
    const { file_key: key } = await api('POST', '/open-apis/im/v1/files', null, { form });
    await send(to, 'audio', { file_key: key });
    return true;
  }

  async function downloadImage(messageId, imageKey) {
    const t = await tenantToken();
    const res = await fetchImpl(`${openUrl}/open-apis/im/v1/messages/${encodeURIComponent(messageId)}/resources/${encodeURIComponent(imageKey)}?type=image`, {
      headers: { authorization: `Bearer ${t}` },
      signal: AbortSignal.timeout(60000),
    });
    if (!res.ok) throw new Error(`下载飞书图片失败：HTTP ${res.status}`);
    const bytes = Buffer.from(await res.arrayBuffer());
    const day = new Date().toISOString().slice(0, 10);
    const rel = path.posix.join('uploads', day, `feishu-${Date.now().toString(36)}.png`);
    await fsp.mkdir(path.join(o.workspaceDir, path.dirname(rel)), { recursive: true });
    await fsp.writeFile(path.join(o.workspaceDir, rel), bytes);
    return rel;
  }

  // ---------------------------------------------------------------- messages in
  const botId = () => cfg.botId || (o.getBots?.() || []).find((b) => b.primary)?.id || 'chief';

  function textOf(message) {
    let c = {};
    try { c = JSON.parse(message.content || '{}'); } catch { /* keep {} */ }
    if (message.message_type === 'text') return String(c.text || '').replace(/@_user_\d+/g, '').trim();
    if (message.message_type === 'post') {
      const blocks = c.content || c.zh_cn?.content || [];
      return blocks.flat().map((n) => n.text || '').join('').replace(/@_user_\d+/g, '').trim();
    }
    return '';
  }

  const here = () => o.machineName?.() || '这台机器';
  const localBot = (id) => (o.getBots?.() || []).find((b) => b.id === id);
  const primaryTarget = () => ({ botId: botId(), machine: '', name: localBot(botId())?.name || '助理' });
  const labelOf = (t) => `【${t.name} · ${t.machine || here()}】`;
  const sayWho = (t) => `${t.name}（${t.machine || here()}）`;

  /** Every bot this person can switch to: this machine first, then the others. */
  async function allTargets() {
    const list = (o.getBots?.() || []).map((b) => ({ botId: b.id, machine: '', name: b.name }));
    const far = typeof o.listRemote === 'function' ? await o.listRemote().catch(() => []) : [];
    for (const m of far) for (const b of m.bots || []) list.push({ botId: b.id, machine: m.machine, name: b.name });
    return list;
  }

  /** The person's target, if it still exists; otherwise the primary bot. */
  function currentTarget(user) {
    const t = user?.target;
    if (!t) return primaryTarget();
    if (!t.machine && !localBot(t.botId)) return primaryTarget();
    return t;
  }

  async function setTarget(user, target) {
    const same = (a, b) => (a?.botId || '') === (b?.botId || '') && (a?.machine || '') === (b?.machine || '');
    const isPrimary = !target || (!target.machine && target.botId === botId());
    const next = isPrimary ? null : target;
    if (same(user.target, next)) return;
    user.target = next;
    await saveFeishuFile(o.file, cfg);
  }

  /** Send the message to one bot: a turn here, or a hand-off to another machine. */
  async function dispatch(to, target, full, spoken) {
    const label = o.pinned ? '' : labelOf(target);
    if (target.machine) {
      if (typeof o.askRemote !== 'function') { await sendText(to, `这台机器连不上「${target.machine}」。`); return; }
      await sendText(to, `已转给「${target.machine}」上的${target.name}，做完把结果发给你。`).catch(() => {});
      try {
        const r = await o.askRemote({ machine: target.machine, botId: target.botId, text: full });
        const reply = r.reply || '（没有回答）';
        await deliver(to, [label ? `${label}\n${reply}` : reply], '', (r.fetched || []).map((x) => x.to));
      } catch (err) {
        await sendText(to, `没能联系上「${target.machine}」上的${target.name}：${err.message}`).catch(() => {});
      }
      return;
    }
    const id = target.botId;
    const turnId = `turn_${crypto.randomBytes(6).toString('hex')}`;
    feishuTurns.set(turnId, { ...to, botId: id, texts: [], spoken, label });
    lastChat.set(id, { ...to, at: Date.now() });
    o.runtime.runTurn({ botId: id, text: `${full}\n\n（这条消息来自飞书，用户在手机上；回复会发回飞书。飞书这条通道能收文字、图片和语音：你回复里写到的工作区图片和视频，会作为真正的图片、视频发过去；用户发语音来时，你的文字回复也会自动附一条语音。所以别说飞书只能发文字。）`, source: 'feishu', turnId })
      .catch(async (err) => {
        feishuTurns.delete(turnId);
        await sendText(to, `没能开始：${err.message}`).catch(() => {});
      });
  }

  const YES = /^(批准|同意|可以|好|行|ok|yes|允许|确认)[。!！.]*$/i;
  const NO = /^(拒绝|不行|不要|别|no|取消)[。!！.]*$/i;

  async function onMessage(event) {
    const message = event.message || {};
    const sender = event.sender?.sender_id?.open_id || '';
    const to = { chatId: message.chat_id, messageId: message.message_id };
    if (!sender || event.sender?.sender_type === 'app') return;
    // A bot of its own in a group answers only when someone @-mentions it.
    if (o.pinned && message.chat_type === 'group' && !(message.mentions || []).length) return;
    const text = textOf(message);

    // Pairing: nothing runs for someone this machine has not met.
    if (!cfg.users.some((u) => u.openId === sender)) {
      if (text.includes(cfg.pairCode)) {
        cfg.users.push({ openId: sender, since: new Date().toISOString() });
        cfg.pairCode = newPairCode(); // one code, one person
        await saveFeishuFile(o.file, cfg);
        o.bus?.emit({ type: 'feishu.changed' });
        await sendText(to, o.pinned
          ? `已连接到「${o.pinned.machine || here()}」的${o.pinned.name}。直接发消息给我就行，图片和语音也可以。`
          : `已连接到「${here()}」的助理。直接发消息给我就行，图片和语音也可以。发「切换」可以换别的机器人。`);
      } else {
        await sendText(to, '还没配对：在电脑上的夜班里打开「设置 → 飞书」，把配对码发给我。');
      }
      return;
    }

    // A yes / no while an approval waits in this chat answers it.
    const pendingId = waitingApproval.get(message.chat_id);
    if (pendingId && (YES.test(text) || NO.test(text))) {
      waitingApproval.delete(message.chat_id);
      try {
        await o.approvals.resolve(pendingId, YES.test(text) ? 'approved' : 'denied');
        await sendText(to, YES.test(text) ? '好，继续。' : '好，不做了。');
      } catch (err) {
        await sendText(to, `这个审批已经处理过了（${err.message}）。`);
      }
      return;
    }

    let full = text;
    if (message.message_type === 'image') {
      let c = {};
      try { c = JSON.parse(message.content || '{}'); } catch { /* */ }
      try {
        const rel = await downloadImage(message.message_id, c.image_key);
        full = `（飞书发来一张图片）\n\n[附件] 都在共享工作区里：\n- ${rel}（图片）\n（图片的内容要用 image_view 工具看。）`;
      } catch (err) {
        await sendText(to, err.message);
        return;
      }
    }
    let spoken = false;
    if (message.message_type === 'audio') {
      let c = {};
      try { c = JSON.parse(message.content || '{}'); } catch { /* */ }
      if (typeof o.transcribe !== 'function') { await sendText(to, '这台机器还没配语音服务，先发文字吧（在夜班「设置 → 模型 → 语音输入」里配）。'); return; }
      try {
        const bytes = await downloadAudio(message.message_id, c.file_key);
        const { text: heard } = await o.transcribe(bytes, 'audio/ogg');
        if (!String(heard || '').trim()) { await sendText(to, '没听清，再说一次？'); return; }
        full = `（飞书语音，转写成文字）${heard}`;
        spoken = true;
      } catch (err) {
        await sendText(to, `语音没能转成文字：${err.message}`);
        return;
      }
    }
    if (!full) {
      await sendText(to, '目前能收文字、图片和语音。');
      return;
    }

    const user = cfg.users.find((u) => u.openId === sender);
    // A Feishu app of its own: everything goes to its bot.
    if (o.pinned) { await dispatch(to, o.pinned, full, spoken); return; }
    const said = full.trim();

    // "机器人列表": who can be reached with @name.
    if (/^(机器人列表|有哪些机器人|\/bots)$/i.test(said)) {
      const names = (o.getBots?.() || []).map((b) => b.name);
      const far = typeof o.listRemote === 'function' ? await o.listRemote().catch(() => []) : [];
      const lines = [`这台机器：${names.join('、') || '（没有）'}`, ...far.map((m) => `「${m.machine}」：${(m.bots || []).map((b) => b.name).join('、') || '（没有）'}`)];
      await sendText(to, `${lines.join('\n')}\n\n现在在跟 ${sayWho(currentTarget(user))} 说话。发「切换」按编号换人；或者消息开头写「@名字」，之后的消息都发给它（别的机器上重名时写「@名字@机器名」）；发「/home」回到主助理。`);
      return;
    }

    // "/home": back to the primary bot.
    if (/^(\/home|回主助理|找主助理)$/i.test(said)) {
      await setTarget(user, null);
      await sendText(to, `接下来发给 ${sayWho(primaryTarget())}。`);
      return;
    }

    // "切换": a numbered list of every bot; the next message "2" picks one.
    if (/^(切换|换人|\/to)$/i.test(said)) {
      const list = await allTargets();
      picks.set(sender, { list, until: Date.now() + 5 * 60 * 1000 });
      const now = currentTarget(user);
      const lines = list.map((t, n) => `${n + 1}. ${t.name}（${t.machine || here()}）${t.botId === now.botId && (t.machine || '') === (now.machine || '') ? ' ← 现在' : ''}`);
      await sendText(to, `回一个数字换人（5 分钟内有效）：\n${lines.join('\n')}`);
      return;
    }
    const pick = picks.get(sender);
    if (pick && /^\d{1,3}$/.test(said)) {
      picks.delete(sender);
      if (Date.now() > pick.until) { await sendText(to, '这个列表过期了，再发一次「切换」。'); return; }
      const chosen = pick.list[Number(said) - 1];
      if (!chosen) { await sendText(to, `没有第 ${said} 个，再发一次「切换」看看列表。`); return; }
      await setTarget(user, chosen);
      await sendText(to, `接下来发给 ${sayWho(chosen)}。发「切换」可以换人，「/home」回到主助理。`);
      return;
    }

    // "@编剧 写个开头": that bot answers, and stays the one this person talks
    // to. On this machine or, when it is not here (or "@编剧@Ubuntu" says
    // where), on one of the other machines. An unknown name goes to the target.
    let target = currentTarget(user);
    const at = spoken ? null : /^[@＠]([^\s@＠，,:：]{1,30})(?:[@＠]([^\s，,:：]{1,30}))?[\s，,:：]*/.exec(full);
    if (at) {
      const want = at[1].toLowerCase();
      const rest = full.slice(at[0].length).trim();
      const local = at[2] ? null : (o.getBots?.() || []).find((b) => b.id.toLowerCase() === want || String(b.name).toLowerCase() === want);
      let found = local ? { botId: local.id, machine: '', name: local.name } : null;
      if (!found && typeof o.resolveRemote === 'function') {
        const far = await o.resolveRemote(at[2] ? `${at[1]}@${at[2]}` : at[1]).catch(() => null);
        if (far) found = { botId: far.info.botId, machine: far.info.machine, name: far.info.name };
      }
      if (found) {
        await setTarget(user, found);
        target = found;
        if (!rest) { await sendText(to, `接下来发给 ${sayWho(found)}。发「切换」可以换人，「/home」回到主助理。`); return; }
        full = rest;
      }
    }
    await dispatch(to, target, full, spoken);
  }

  // ---------------------------------------------------------------- results out
  const MEDIA = /(?:^|[\s`'"(（「：:，,])((?:[\w.-]+\/)+[\w.-]+\.(?:png|jpe?g|gif|webp|mp4))(?=$|[\s`'")）」，。,.;；:：、!！?？])/gi;

  function stripPaths(text, files) {
    let out = String(text || '');
    for (const rel of files) {
      const esc = rel.replace(/[.*+?^${}()|[\]\\/]/g, '\\$&');
      // `path`, (path), 「path」 or a bare path; with its "路径：" label if any
      out = out.replace(new RegExp(`(?:(?:图片|视频|文件)?路径[：:]\\s*)?[\`「(（]?(?:\\./|workspace/)?${esc}[\`」)）]?`, 'g'), '');
    }
    return out.replace(/[ \t]+\n/g, '\n').replace(/\n{3,}/g, '\n\n').replace(/^[：:，,\s]+|[：:，,\s]+$/g, '').trim();
  }

  async function deliver(to, texts, summary, extraFiles = []) {
    const text = texts.join('\n\n').trim() || String(summary || '').trim();
    // extraFiles: fetched from another machine for this answer (pictures and videos are sent as such).
    const files = extraFiles.filter((rel) => /\.(png|jpe?g|gif|webp|mp4)$/i.test(rel)).slice(0, 4);
    for (const m of text.matchAll(MEDIA)) {
      const rel = m[1].replace(/^\.\//, '').replace(/^workspace\//, '');
      if (!files.includes(rel) && files.length < 4) files.push(rel);
    }
    // The pictures and videos go as real messages; their paths on this
    // machine mean nothing on a phone, so the text leaves them out.
    const shown = stripPaths(text, files);
    if (shown) await sendText(to, shown);
    for (const rel of files) await sendFile(to, rel).catch((err) => log('could not send', rel, err.message));
  }

  function onBus(ev) {
    if (!cfg || !ev?.turnId) return;
    const turn = feishuTurns.get(ev.turnId);
    if (ev.type === 'message' && turn && ev.text && !ev.system) turn.texts.push(String(ev.text));
    if (ev.type === 'approval.request' && turn && ev.approvalId) {
      waitingApproval.set(turn.chatId, ev.approvalId);
      const detail = ev.args ? `\n\`${String(typeof ev.args === 'string' ? ev.args : JSON.stringify(ev.args)).slice(0, 300)}\`` : '';
      sendText(turn, `「${ev.botName || '助理'}」想要：${ev.tool}${detail}\n回复「批准」或「拒绝」。`).catch(() => {});
    }
    if (ev.type === 'turn.end') {
      if (turn) {
        feishuTurns.delete(ev.turnId);
        let extra = '';
        if (ev.waitingFor === 'takeover') extra = '\n\n（这一步要在电脑上的夜班里接管屏幕来完成。）';
        if (ev.waitingFor === 'login') extra = '\n\n（需要在电脑上的夜班里填写登录信息，密码不要发在飞书里。）';
        const said = turn.texts.concat(extra ? [extra] : []).join('\n\n').trim() || String(ev.summary || '').trim();
        deliver(turn, [turn.label && said ? `${turn.label}\n${said}` : said], '')
          // Asked by voice: the answer comes back as a voice message as well.
          .then(() => (turn.spoken ? sendVoice(turn, turn.texts.join('\n\n').trim() || String(ev.summary || '')).catch((err) => log('voice reply failed:', err.message)) : null))
          .catch((err) => log('deliver failed:', err.message));
        return;
      }
      // A background job (a finished video) reports to the bot: pass it on to
      // the Feishu chat that last talked to that bot, if that was recent.
      const recent = lastChat.get(ev.botId);
      if (ev.source === 'media' && recent && Date.now() - recent.at < 6 * 3600 * 1000) {
        const texts = [];
        // the texts of that turn were not collected; the summary is enough here
        deliver({ chatId: recent.chatId }, texts, ev.summary).catch(() => {});
      }
    }
  }

  // ---------------------------------------------------------------- long connection
  function handleFrame(buf) {
    let frame;
    try { frame = decodeFrame(buf); } catch (err) { log('bad frame:', err.message); return; }
    const type = headerOf(frame, 'type');
    if (frame.method === 0) { // control: pong (may carry new config)
      if (type === 'pong' && frame.payload?.length) {
        try { const c = JSON.parse(frame.payload.toString('utf8')); if (c.PingInterval) schedulePing(c.PingInterval * 1000); } catch { /* */ }
      }
      return;
    }
    // data frame: maybe split in parts
    const msgId = headerOf(frame, 'message_id') || '';
    const sum = Number(headerOf(frame, 'sum') || 1);
    const seq = Number(headerOf(frame, 'seq') || 0);
    let payload = frame.payload;
    if (sum > 1) {
      const got = parts.get(msgId) || new Array(sum);
      got[seq] = frame.payload;
      parts.set(msgId, got);
      if (got.filter(Boolean).length < sum) return;
      parts.delete(msgId);
      payload = Buffer.concat(got);
    }
    // Acknowledge at once (Feishu redelivers otherwise).
    const ack = { ...frame, headers: [...frame.headers, { key: 'biz_rt', value: '0' }], payload: Buffer.from(JSON.stringify({ code: 200, headers: {}, data: '' })) };
    try { ws.send(encodeFrame(ack)); } catch { /* reconnect will follow */ }
    if (type !== 'event') return;
    let data;
    try { data = JSON.parse(payload.toString('utf8')); } catch { return; }
    const eventId = data.header?.event_id;
    if (eventId) {
      if (seenEvents.has(eventId)) return;
      seenEvents.set(eventId, Date.now());
      if (seenEvents.size > 500) for (const [k, t] of seenEvents) if (Date.now() - t > 3600000) seenEvents.delete(k);
    }
    if (data.header?.event_type === 'im.message.receive_v1') {
      onMessage(data.event || {}).catch((err) => log('message failed:', err.message));
    }
  }

  function schedulePing(ms) {
    clearInterval(pingTimer);
    pingTimer = setInterval(() => {
      try { ws?.send(encodeFrame({ method: 0, service: serviceId, headers: [{ key: 'type', value: 'ping' }] })); } catch { /* */ }
    }, Math.max(10000, ms));
    if (typeof pingTimer.unref === 'function') pingTimer.unref();
  }

  async function connect() {
    if (stopped) return;
    clearTimeout(retryTimer);
    try {
      const res = await fetchImpl(`${openUrl}/callback/ws/endpoint`, {
        method: 'POST',
        headers: { 'content-type': 'application/json', locale: 'zh' },
        body: JSON.stringify({ AppID: cfg.appId, AppSecret: cfg.appSecret }),
        signal: AbortSignal.timeout(15000),
      });
      const j = await res.json().catch(() => ({}));
      if (j.code !== 0 || !j.data?.URL) throw new Error(j.code === 1000040343 || /app/i.test(j.msg || '') ? `飞书拒绝了连接：${j.msg}` : `飞书没有给出连接地址：${j.msg || res.status}`);
      const url = new URL(j.data.URL);
      serviceId = Number(url.searchParams.get('service_id') || 0);
      ws = new WS(j.data.URL);
      ws.addEventListener('open', () => {
        status = { connected: true, error: '', since: new Date().toISOString() };
        retryDelay = 5000;
        schedulePing((j.data.ClientConfig?.PingInterval || 120) * 1000);
        log('connected');
        o.bus?.emit({ type: 'feishu.changed' });
      });
      ws.addEventListener('message', (e) => { if (Buffer.isBuffer(e.data) || e.data instanceof Uint8Array) handleFrame(Buffer.from(e.data)); });
      const down = (why) => {
        if (status.connected || !status.error) status = { connected: false, error: why || '连接断开了，正在重连', since: null };
        clearInterval(pingTimer);
        o.bus?.emit({ type: 'feishu.changed' });
        if (!stopped) { retryTimer = setTimeout(connect, retryDelay); retryDelay = Math.min(retryDelay * 2, 120000); }
      };
      ws.addEventListener('close', () => down());
      ws.addEventListener('error', (e) => down(`连接出错：${e?.message || e?.error?.message || ''}`));
    } catch (err) {
      status = { connected: false, error: err.message, since: null };
      o.bus?.emit({ type: 'feishu.changed' });
      if (!stopped) { retryTimer = setTimeout(connect, retryDelay); retryDelay = Math.min(retryDelay * 2, 120000); }
    }
  }

  function stop() {
    stopped = true;
    clearInterval(pingTimer);
    clearTimeout(retryTimer);
    try { ws?.close(); } catch { /* */ }
    ws = null;
    status = { connected: false, error: '', since: null };
  }

  function start() {
    stop();
    if (!cfg.enabled || !cfg.appId || !cfg.appSecret) return;
    stopped = false;
    token = { value: '', until: 0 };
    connect();
  }

  return {
    async load() {
      cfg = await loadFeishu(o.file);
      if (!unsubscribe && o.bus) unsubscribe = o.bus.subscribe(onBus) || null;
      start();
    },
    /** Patch {enabled?, appId?, appSecret?, botId?, newPairCode?}; appSecret "" keeps the old one. */
    async update(patch = {}) {
      const before = `${cfg.appId}|${cfg.appSecret}|${cfg.enabled}`;
      if (patch.appId !== undefined) cfg.appId = String(patch.appId || '').trim().slice(0, 64);
      if (typeof patch.appSecret === 'string' && patch.appSecret.trim()) cfg.appSecret = patch.appSecret.trim();
      if (patch.botId !== undefined) cfg.botId = String(patch.botId || '').slice(0, 64);
      if (patch.enabled !== undefined) cfg.enabled = Boolean(patch.enabled);
      if (patch.newPairCode) cfg.pairCode = newPairCode();
      if (patch.clearSecret) cfg.appSecret = '';
      await saveFeishuFile(o.file, cfg);
      // Reconnect only when what the connection uses changed: saving the same
      // settings again must not drop a working connection.
      const changed = `${cfg.appId}|${cfg.appSecret}|${cfg.enabled}` !== before;
      if (changed || (cfg.enabled && !status.connected && !ws)) start();
      return this.view();
    },
    async unpair(openId) {
      cfg.users = cfg.users.filter((u) => u.openId !== openId);
      await saveFeishuFile(o.file, cfg);
      return this.view();
    },
    view() {
      return {
        enabled: cfg.enabled,
        appId: cfg.appId,
        hasSecret: Boolean(cfg.appSecret),
        botId: cfg.botId,
        pairCode: cfg.pairCode,
        users: cfg.users.map((u) => ({ openId: u.openId, since: u.since, talkingTo: u.target ? sayWho(u.target) : '' })),
        pinned: o.pinned || null,
        connected: status.connected,
        error: status.error,
        since: status.since,
      };
    },
    stop,
    /** Stop for good (a pinned app being removed). */
    dispose() {
      stop();
      if (typeof unsubscribe === 'function') unsubscribe();
      unsubscribe = null;
    },
    /** Send a text (and the pictures/videos it names) to everyone paired. -> how many got it */
    async push(text) {
      if (!cfg?.enabled || !cfg.appId || !cfg.appSecret || !cfg.users?.length) return 0;
      let sent = 0;
      for (const u of cfg.users) {
        try { await deliver({ openId: u.openId }, [String(text || '')], ''); sent += 1; } catch (err) { log('push failed:', err.message); }
      }
      return sent;
    },
    // tests
    _handleFrame: handleFrame,
    _onBus: onBus,
    _stripPaths: stripPaths,
  };
}
