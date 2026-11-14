/**
 * mail.mjs - 邮箱: read and send mail over IMAP / SMTP with the mailbox's
 * authorization code (QQ, 163, 126, Gmail app password ...), no dependencies.
 *
 * It is a connected app like the others (Settings → 连接应用 → 邮箱), but it
 * runs inside the hub instead of as a separate program: createMailServer()
 * answers the same JSON-RPC an MCP server would (initialize, tools/list,
 * tools/call), so per-bot access, "ask before each call" and the activity log
 * work exactly as for every other app. Reading is marked read-only; sending
 * and marking are not, so they ask first unless the human says otherwise.
 *
 * Each call opens its own IMAP / SMTP connection and closes it: nothing stays
 * logged in, and a dropped connection cannot wedge the next call.
 */

import tls from 'node:tls';
import net from 'node:net';
import path from 'node:path';
import fsp from 'node:fs/promises';
import crypto from 'node:crypto';

const TIMEOUT_MS = 30000;

// ---------------------------------------------------------------------------
// providers

/** Servers of the common mailboxes, by the address's domain. */
export const MAIL_PROVIDERS = {
  'qq.com': { imap: 'imap.qq.com:993', smtp: 'smtp.qq.com:465', name: 'QQ 邮箱' },
  'foxmail.com': { imap: 'imap.qq.com:993', smtp: 'smtp.qq.com:465', name: 'Foxmail' },
  'vip.qq.com': { imap: 'imap.qq.com:993', smtp: 'smtp.qq.com:465', name: 'QQ 邮箱' },
  '163.com': { imap: 'imap.163.com:993', smtp: 'smtp.163.com:465', name: '网易 163 邮箱' },
  '126.com': { imap: 'imap.126.com:993', smtp: 'smtp.126.com:465', name: '网易 126 邮箱' },
  'yeah.net': { imap: 'imap.yeah.net:993', smtp: 'smtp.yeah.net:465', name: '网易 yeah.net' },
  'vip.163.com': { imap: 'imap.vip.163.com:993', smtp: 'smtp.vip.163.com:465', name: '网易 VIP 邮箱' },
  'gmail.com': { imap: 'imap.gmail.com:993', smtp: 'smtp.gmail.com:465', name: 'Gmail' },
  'googlemail.com': { imap: 'imap.gmail.com:993', smtp: 'smtp.gmail.com:465', name: 'Gmail' },
  '139.com': { imap: 'imap.139.com:993', smtp: 'smtp.139.com:465', name: '139 邮箱' },
  'sina.com': { imap: 'imap.sina.com:993', smtp: 'smtp.sina.com:465', name: '新浪邮箱' },
  'sina.cn': { imap: 'imap.sina.cn:993', smtp: 'smtp.sina.cn:465', name: '新浪邮箱' },
  'aliyun.com': { imap: 'imap.aliyun.com:993', smtp: 'smtp.aliyun.com:465', name: '阿里邮箱' },
  'icloud.com': { imap: 'imap.mail.me.com:993', smtp: 'smtp.mail.me.com:587', name: 'iCloud 邮箱' },
  'me.com': { imap: 'imap.mail.me.com:993', smtp: 'smtp.mail.me.com:587', name: 'iCloud 邮箱' },
};

/** Microsoft turned off password (and app-password) sign-in for these. */
const NO_PASSWORD_LOGIN = /@(outlook|hotmail|live|msn)\.[a-z.]+$/i;

function hostPort(s, defPort) {
  const m = String(s || '').trim().match(/^([^:\s]+)(?::(\d+))?$/);
  return m ? { host: m[1], port: Number(m[2] || defPort) } : null;
}

/** {email, pass, imap:{host,port}, smtp:{host,port}, name} from what the human typed. */
export function resolveAccount({ email, pass, imap = '', smtp = '' } = {}) {
  const addr = String(email || '').trim();
  if (!/^[^@\s]+@[^@\s]+\.[^@\s]+$/.test(addr)) throw mailError('MAIL_BAD_ADDRESS', '邮箱地址不对');
  if (!String(pass || '').trim()) throw mailError('MAIL_NO_PASS', '没有填授权码');
  if (NO_PASSWORD_LOGIN.test(addr) && !imap) {
    throw mailError('MAIL_UNSUPPORTED', 'Outlook / Hotmail 已经不允许用密码或授权码登录第三方程序，暂时连不了');
  }
  const domain = addr.split('@')[1].toLowerCase();
  const p = MAIL_PROVIDERS[domain] || null;
  const i = hostPort(imap, 993) || (p && hostPort(p.imap, 993));
  const s = hostPort(smtp, 465) || (p && hostPort(p.smtp, 465));
  if (!i || !s) throw mailError('MAIL_NEED_SERVERS', `不认识「${domain}」：请填收信（IMAP）和发信（SMTP）服务器，比如 imap.example.com 和 smtp.example.com:465`);
  return { email: addr, pass: String(pass).trim(), imap: i, smtp: s, name: p?.name || domain };
}

function mailError(code, message) {
  return Object.assign(new Error(message), { code, status: 400 });
}

// ---------------------------------------------------------------------------
// text helpers

function decodeBytes(buf, charset = 'utf-8') {
  let cs = String(charset || 'utf-8').trim().toLowerCase().replace(/^"|"$/g, '');
  if (cs === 'gb2312' || cs === 'gbk' || cs === 'x-gbk' || cs === 'cp936') cs = 'gb18030';
  if (cs === 'us-ascii' || cs === 'ascii') cs = 'utf-8';
  try { return new TextDecoder(cs).decode(buf); } catch { /* unknown label */ }
  try { return new TextDecoder('utf-8').decode(buf); } catch { return Buffer.from(buf).toString('latin1'); }
}

/** Raw header bytes: UTF-8 when valid, else GB18030 (Chinese mail sometimes sends 8-bit headers). */
function decodeRawHeader(buf) {
  try { return new TextDecoder('utf-8', { fatal: true }).decode(buf); } catch { return decodeBytes(buf, 'gb18030'); }
}

function qpDecode(s, header = false) {
  const t = header ? s.replace(/_/g, ' ') : s.replace(/=\r?\n/g, '');
  const bytes = [];
  for (let i = 0; i < t.length; i += 1) {
    if (t[i] === '=' && /^[0-9A-Fa-f]{2}$/.test(t.slice(i + 1, i + 3))) { bytes.push(parseInt(t.slice(i + 1, i + 3), 16)); i += 2; } else bytes.push(...Buffer.from(t[i], 'latin1'));
  }
  return Buffer.from(bytes);
}

/** =?charset?B|Q?...?= words (RFC 2047); adjacent words are joined. */
export function decodeWords(s) {
  return String(s || '')
    .replace(/(=\?[^?]+\?[BbQq]\?[^?]*\?=)\s+(?==\?)/g, '$1')
    .replace(/=\?([^?]+)\?([BbQq])\?([^?]*)\?=/g, (_, cs, enc, text) => {
      try {
        const bytes = enc.toUpperCase() === 'B' ? Buffer.from(text, 'base64') : qpDecode(text, true);
        return decodeBytes(bytes, cs.split('*')[0]);
      } catch { return text; }
    });
}

function encodeWord(s) {
  return /^[\x20-\x7e]*$/.test(s) ? s : `=?UTF-8?B?${Buffer.from(s, 'utf8').toString('base64')}?=`;
}

function htmlToText(html) {
  return String(html || '')
    .replace(/<(script|style|head)[\s\S]*?<\/\1>/gi, '')
    .replace(/<br\s*\/?>/gi, '\n')
    .replace(/<\/(p|div|tr|li|h[1-6]|table|blockquote)>/gi, '\n')
    .replace(/<li[^>]*>/gi, '- ')
    .replace(/<[^>]+>/g, '')
    .replace(/&nbsp;/g, ' ').replace(/&lt;/g, '<').replace(/&gt;/g, '>').replace(/&quot;/g, '"').replace(/&#39;/g, "'")
    .replace(/&#(\d+);/g, (_, n) => String.fromCodePoint(Number(n)))
    .replace(/&amp;/g, '&')
    .replace(/[ \t]+\n/g, '\n').replace(/\n{3,}/g, '\n\n').trim();
}

// ---------------------------------------------------------------------------
// MIME

function parseHeaders(text) {
  const out = {};
  for (const line of text.replace(/\r?\n[ \t]+/g, ' ').split(/\r?\n/)) {
    const k = line.indexOf(':');
    if (k <= 0) continue;
    const name = line.slice(0, k).trim().toLowerCase();
    const value = line.slice(k + 1).trim();
    out[name] = out[name] ? `${out[name]}, ${value}` : value;
  }
  return out;
}

function headerParams(value) {
  const [main, ...rest] = String(value || '').split(';');
  const params = {};
  const star = {};
  for (const p of rest) {
    const k = p.indexOf('=');
    if (k < 0) continue;
    let name = p.slice(0, k).trim().toLowerCase();
    let v = p.slice(k + 1).trim().replace(/^"|"$/g, '');
    // filename*=UTF-8''%E6%96%87 (RFC 2231), possibly split as filename*0*=...
    if (name.endsWith('*')) {
      name = name.replace(/\*\d*\*?$/, '');
      const m = v.match(/^([^']*)'[^']*'(.*)$/);
      const pct = (t) => Buffer.from(t.replace(/%([0-9A-Fa-f]{2})|([\s\S])/g, (_, h, c) => (h ? String.fromCharCode(parseInt(h, 16)) : c)), 'latin1');
      try { v = m ? decodeBytes(pct(m[2]), m[1] || 'utf-8') : decodeBytes(pct(v), 'utf-8'); } catch { /* keep */ }
      // Pieces (filename*0*=, filename*1*=) join up; the starred form wins over the plain one.
      star[name] = (star[name] || '') + v;
    } else {
      const piece = /\*\d+$/.test(name);
      name = name.replace(/\*\d+$/, '');
      params[name] = (piece && params[name] ? params[name] : '') + decodeWords(v);
    }
  }
  Object.assign(params, star);
  return { value: main.trim().toLowerCase(), params };
}

function decodeBody(buf, cte) {
  const e = String(cte || '').toLowerCase().trim();
  if (e === 'base64') return Buffer.from(buf.toString('latin1').replace(/[^A-Za-z0-9+/=]/g, ''), 'base64');
  if (e === 'quoted-printable') return qpDecode(buf.toString('latin1'));
  return buf;
}

/** A message (bytes) -> {headers, text, html, attachments:[{filename, contentType, size, data}]} */
export function parseMessage(raw) {
  const buf = Buffer.isBuffer(raw) ? raw : Buffer.from(String(raw), 'utf8');
  const out = { headers: {}, text: '', html: '', attachments: [] };
  const walk = (part, depth) => {
    let split = part.indexOf('\r\n\r\n');
    let sep = 4;
    if (split < 0) { split = part.indexOf('\n\n'); sep = 2; }
    const headText = decodeRawHeader(split < 0 ? part : part.subarray(0, split));
    const body = split < 0 ? Buffer.alloc(0) : part.subarray(split + sep);
    const h = parseHeaders(headText);
    if (depth === 0) out.headers = h;
    const ct = headerParams(h['content-type'] || 'text/plain; charset=utf-8');
    const cd = headerParams(h['content-disposition'] || '');
    if (ct.value.startsWith('multipart/') && ct.params.boundary && depth < 8) {
      const b = Buffer.from(`--${ct.params.boundary}`, 'latin1');
      const pieces = [];
      let at = body.indexOf(b);
      while (at >= 0) {
        const start = at + b.length;
        if (body.subarray(start, start + 2).toString() === '--') break;
        const next = body.indexOf(b, start);
        let piece = body.subarray(start, next < 0 ? body.length : next);
        piece = piece.subarray(piece[0] === 13 ? 2 : piece[0] === 10 ? 1 : 0);
        if (piece.length >= 2 && piece[piece.length - 2] === 13) piece = piece.subarray(0, piece.length - 2);
        else if (piece.length && piece[piece.length - 1] === 10) piece = piece.subarray(0, piece.length - 1);
        pieces.push(piece);
        at = next;
      }
      for (const p of pieces) walk(p, depth + 1);
      return;
    }
    if (ct.value === 'message/rfc822' && depth < 8) { walk(decodeBody(body, h['content-transfer-encoding']), depth + 1); return; }
    const data = decodeBody(body, h['content-transfer-encoding']);
    const filename = cd.params.filename || ct.params.name || '';
    const isAttachment = cd.value === 'attachment' || (filename && !ct.value.startsWith('text/'));
    if (!isAttachment && ct.value === 'text/plain' && !out.text) out.text = decodeBytes(data, ct.params.charset);
    else if (!isAttachment && ct.value === 'text/html' && !out.html) out.html = decodeBytes(data, ct.params.charset);
    else if (filename || isAttachment) out.attachments.push({ filename: filename || `attachment-${out.attachments.length + 1}`, contentType: ct.value, size: data.length, data });
  };
  walk(buf, 0);
  return out;
}

/** "张三 <a@b.com>, c@d.com" -> ['a@b.com', 'c@d.com'] */
export function addressList(s) {
  const list = Array.isArray(s) ? s : String(s || '').split(/[,;，；]/);
  return list.map((x) => String(x).trim()).filter(Boolean)
    .map((x) => (x.match(/<([^>]+)>/) || [null, x])[1].trim())
    .filter((x) => /^[^@\s<>]+@[^@\s<>]+\.[^@\s<>]+$/.test(x));
}

function b64lines(buf) {
  return buf.toString('base64').replace(/.{1,76}/g, '$&\r\n');
}

/** A message ready for SMTP DATA. */
export function buildMessage({ from, to = [], cc = [], subject = '', text = '', attachments = [], inReplyTo = '', references = '' }) {
  const domain = String(from).split('@')[1] || 'localhost';
  const head = [
    `From: ${from}`,
    `To: ${to.join(', ')}`,
    ...(cc.length ? [`Cc: ${cc.join(', ')}`] : []),
    `Subject: ${encodeWord(String(subject))}`,
    `Date: ${new Date().toUTCString().replace('GMT', '+0000')}`,
    `Message-ID: <${crypto.randomUUID()}@${domain}>`,
    ...(inReplyTo ? [`In-Reply-To: ${inReplyTo}`, `References: ${[references, inReplyTo].filter(Boolean).join(' ')}`] : []),
    'MIME-Version: 1.0',
    'X-Mailer: Lamplit',
  ];
  const textPart = ['Content-Type: text/plain; charset=UTF-8', 'Content-Transfer-Encoding: base64', '', b64lines(Buffer.from(String(text).replace(/\r?\n/g, '\r\n'), 'utf8'))];
  if (!attachments.length) return [...head, ...textPart].join('\r\n');
  const boundary = `----=_ns_${crypto.randomBytes(12).toString('hex')}`;
  const parts = [...head, `Content-Type: multipart/mixed; boundary="${boundary}"`, '', 'This is a multi-part message in MIME format.', `--${boundary}`, ...textPart];
  for (const a of attachments) {
    const name = encodeWord(a.filename);
    const star = `UTF-8''${encodeURIComponent(a.filename)}`;
    parts.push(`--${boundary}`,
      `Content-Type: ${a.contentType || 'application/octet-stream'}; name="${name}"`,
      'Content-Transfer-Encoding: base64',
      `Content-Disposition: attachment; filename="${name}"; filename*=${star}`,
      '', b64lines(a.data));
  }
  parts.push(`--${boundary}--`, '');
  return parts.join('\r\n');
}

// ---------------------------------------------------------------------------
// modified UTF-7 (IMAP folder names: 已发送 is &XfJT0ZAB-)

export function utf7Decode(s) {
  return String(s).replace(/&([^-]*)-/g, (_, b) => {
    if (!b) return '&';
    const bytes = Buffer.from(b.replace(/,/g, '/'), 'base64');
    let out = '';
    for (let i = 0; i + 1 < bytes.length; i += 2) out += String.fromCharCode((bytes[i] << 8) | bytes[i + 1]);
    return out;
  });
}

export function utf7Encode(s) {
  return String(s).replace(/&/g, '&-').replace(/[^\x20-\x7e]+/g, (run) => {
    const b = Buffer.alloc(run.length * 2);
    for (let i = 0; i < run.length; i += 1) b.writeUInt16BE(run.charCodeAt(i), i * 2);
    return `&${b.toString('base64').replace(/=+$/, '').replace(/\//g, ',')}-`;
  });
}

// ---------------------------------------------------------------------------
// IMAP

function quote(s) {
  return `"${String(s).replace(/\\/g, '\\\\').replace(/"/g, '\\"')}"`;
}

export class Imap {
  constructor({ host, port = 993, secure = true, timeoutMs = TIMEOUT_MS, connect = null }) {
    Object.assign(this, { host, port, secure, timeoutMs, connectImpl: connect });
    this.tag = 0;
    this.buf = Buffer.alloc(0);
    this.item = null; // the response being read: {text, literals}
    this.need = 0; // bytes of a literal still to read
    this.waiter = null;
  }

  open() {
    return new Promise((resolve, reject) => {
      const onErr = (err) => reject(mailError('MAIL_CONNECT', `连不上收信服务器 ${this.host}:${this.port}（${err.message}）`));
      this.sock = this.connectImpl ? this.connectImpl()
        : this.secure ? tls.connect({ host: this.host, port: this.port, servername: this.host }) : net.connect({ host: this.host, port: this.port });
      this.sock.setTimeout(this.timeoutMs, () => this.sock.destroy(new Error('超时')));
      this.sock.once('error', onErr);
      this.sock.on('data', (d) => this.onData(d));
      this.sock.on('close', () => { if (this.waiter) this.waiter.reject(mailError('MAIL_CLOSED', '收信服务器断开了连接')); });
      this.waiter = { untagged: [], tag: '*greeting', resolve: () => { this.sock.off('error', onErr); this.sock.on('error', () => {}); resolve(); }, reject };
    });
  }

  onData(d) {
    this.buf = Buffer.concat([this.buf, d]);
    for (;;) {
      if (this.need) {
        if (this.buf.length < this.need) return;
        this.item.literals.push(this.buf.subarray(0, this.need));
        this.item.text += `\u0000${this.item.literals.length - 1}\u0000`;
        this.buf = this.buf.subarray(this.need);
        this.need = 0;
      }
      const nl = this.buf.indexOf('\r\n');
      if (nl < 0) return;
      const line = this.buf.subarray(0, nl).toString('utf8');
      this.buf = this.buf.subarray(nl + 2);
      if (!this.item) this.item = { text: '', literals: [] };
      this.item.text += line;
      const lit = line.match(/\{(\d+)\}$/);
      if (lit) { this.need = Number(lit[1]); if (!this.need) this.item.literals.push(Buffer.alloc(0)); continue; }
      const item = this.item;
      this.item = null;
      this.handle(item);
    }
  }

  handle(item) {
    const w = this.waiter;
    if (!w) return;
    if (w.tag === '*greeting') {
      if (/^\* (OK|PREAUTH)/i.test(item.text)) { this.waiter = null; w.resolve(); } else { this.waiter = null; w.reject(mailError('MAIL_CONNECT', `收信服务器拒绝了：${item.text.slice(0, 160)}`)); }
      return;
    }
    if (item.text.startsWith('+')) { w.onContinue?.(); return; }
    if (item.text.startsWith('* ')) { w.untagged.push(item); return; }
    if (item.text.startsWith(`${w.tag} `)) {
      this.waiter = null;
      const m = item.text.slice(w.tag.length + 1).match(/^(OK|NO|BAD)\s*(.*)$/i);
      const status = (m?.[1] || 'BAD').toUpperCase();
      if (status === 'OK') w.resolve({ untagged: w.untagged, text: m?.[2] || '' });
      else w.reject(Object.assign(mailError('MAIL_IMAP', m?.[2] || item.text), { status }));
    }
  }

  /** One command. Parts are strings, or Buffers sent as literals (non-ASCII search words, APPEND). */
  cmd(...parts) {
    const tag = `A${++this.tag}`;
    return new Promise((resolve, reject) => {
      const chunks = [];
      let cur = `${tag} `;
      for (const p of parts) {
        if (Buffer.isBuffer(p)) { chunks.push(Buffer.from(`${cur}{${p.length}}\r\n`, 'utf8')); chunks.push(p); cur = ''; } else cur += p;
      }
      chunks.push(Buffer.from(`${cur}\r\n`, 'utf8'));
      let i = 0;
      const next = () => {
        // Write up to (and including) the next literal header, then wait for "+".
        while (i < chunks.length) {
          const c = chunks[i++];
          this.sock.write(c);
          if (i < chunks.length && /\{\d+\}\r\n$/.test(c.toString('latin1'))) return;
        }
      };
      this.waiter = { tag, untagged: [], resolve, reject, onContinue: next };
      next();
    });
  }

  async login(user, pass) {
    try {
      await this.cmd(`LOGIN ${quote(user)} ${quote(pass)}`);
    } catch (err) {
      throw mailError('MAIL_AUTH', `登录被拒绝：${err.message}。请确认用的是邮箱的「授权码」（不是登录密码），并且邮箱设置里已经开启 IMAP/SMTP。`);
    }
    // 网易邮箱 (163 / 126 / yeah) refuse SELECT ("Unsafe Login") until the client says who it is.
    await this.cmd('ID ("name" "Lamplit" "version" "1.0" "vendor" "Lamplit")').catch(() => {});
    const cap = await this.cmd('CAPABILITY').catch(() => ({ untagged: [] }));
    this.caps = new Set((cap.untagged.find((x) => /^\* CAPABILITY/i.test(x.text))?.text || '').toUpperCase().split(/\s+/));
  }

  /** Move mail (UID set) to another folder: MOVE where the server has it, else copy then remove. */
  async move(set, target) {
    const to = quote(utf7Encode(target));
    if (this.caps?.has('MOVE')) { await this.cmd(`UID MOVE ${set} ${to}`); return; }
    await this.cmd(`UID COPY ${set} ${to}`);
    await this.remove(set);
  }

  /** Remove mail (UID set) from the open folder for good. */
  async remove(set) {
    await this.cmd(`UID STORE ${set} +FLAGS.SILENT (\\Deleted)`);
    // UID EXPUNGE takes out only these; a plain EXPUNGE would also take mail someone else flagged.
    if (this.caps?.has('UIDPLUS')) await this.cmd(`UID EXPUNGE ${set}`);
    else await this.cmd('EXPUNGE');
  }

  async folders() {
    const r = await this.cmd('LIST "" "*"');
    return r.untagged.map((it) => {
      const m = it.text.match(/^\* LIST \(([^)]*)\) (?:"[^"]*"|NIL) (.+)$/i);
      if (!m) return null;
      let raw = m[2].trim();
      if (/^\u0000\d+\u0000$/.test(raw)) raw = it.literals[Number(raw.slice(1, -1))].toString('utf8');
      raw = raw.replace(/^"|"$/g, '').replace(/\\"/g, '"');
      return { path: raw, name: utf7Decode(raw), flags: m[1].split(/\s+/).filter(Boolean) };
    }).filter((f) => f && !f.flags.some((x) => /\\Noselect/i.test(x)));
  }

  async open_(folder, readOnly = true) {
    const r = await this.cmd(`${readOnly ? 'EXAMINE' : 'SELECT'} ${quote(utf7Encode(folder))}`);
    const ex = r.untagged.map((x) => x.text.match(/^\* (\d+) EXISTS/i)).find(Boolean);
    return { exists: ex ? Number(ex[1]) : 0 };
  }

  /** Header summaries for a sequence set ("1:20") or, with uid, a UID set. */
  async summaries(set, { uid = false } = {}) {
    const r = await this.cmd(`${uid ? 'UID ' : ''}FETCH ${set} (UID FLAGS INTERNALDATE RFC822.SIZE BODY.PEEK[HEADER.FIELDS (FROM TO CC SUBJECT DATE MESSAGE-ID)])`);
    return r.untagged.filter((it) => /^\* \d+ FETCH/i.test(it.text)).map((it) => {
      const h = parseHeaders(decodeRawHeader(it.literals[0] || Buffer.alloc(0)));
      const flags = (it.text.match(/FLAGS \(([^)]*)\)/i) || [null, ''])[1];
      return {
        uid: Number((it.text.match(/UID (\d+)/i) || [])[1] || 0),
        from: decodeWords(h.from || ''),
        to: decodeWords(h.to || ''),
        subject: decodeWords(h.subject || '') || '（无主题）',
        date: h.date || (it.text.match(/INTERNALDATE "([^"]+)"/i) || [])[1] || '',
        unread: !/\\Seen/i.test(flags),
        size: Number((it.text.match(/RFC822\.SIZE (\d+)/i) || [])[1] || 0),
      };
    }).sort((a, b) => b.uid - a.uid);
  }

  async search(criteria) {
    const r = await this.cmd(...criteria);
    const line = r.untagged.find((x) => /^\* SEARCH/i.test(x.text));
    return line ? line.text.replace(/^\* SEARCH\s*/i, '').split(/\s+/).filter(Boolean).map(Number) : [];
  }

  async fetchRaw(uid) {
    const r = await this.cmd(`UID FETCH ${uid} (UID FLAGS BODY.PEEK[])`);
    const it = r.untagged.find((x) => /FETCH/i.test(x.text) && x.literals.length);
    if (!it) throw mailError('MAIL_NOT_FOUND', `这个文件夹里没有 uid 为 ${uid} 的邮件`);
    return { raw: it.literals[it.literals.length - 1], unread: !/\\Seen/i.test((it.text.match(/FLAGS \(([^)]*)\)/i) || [null, ''])[1]) };
  }

  async logout() {
    try { await Promise.race([this.cmd('LOGOUT'), new Promise((r) => setTimeout(r, 2000))]); } catch { /* fine */ }
    try { this.sock.end(); } catch { /* gone */ }
  }
}

// ---------------------------------------------------------------------------
// SMTP

export class Smtp {
  constructor({ host, port = 465, timeoutMs = TIMEOUT_MS, connect = null }) {
    Object.assign(this, { host, port, timeoutMs, connectImpl: connect });
    this.buf = '';
    this.lines = [];
    this.waiter = null;
  }

  attach(sock) {
    this.sock = sock;
    sock.setTimeout(this.timeoutMs, () => sock.destroy(new Error('超时')));
    sock.on('data', (d) => {
      this.buf += d.toString('utf8');
      let nl;
      while ((nl = this.buf.indexOf('\r\n')) >= 0) {
        const line = this.buf.slice(0, nl);
        this.buf = this.buf.slice(nl + 2);
        this.lines.push(line);
        if (/^\d{3} /.test(line) || /^\d{3}$/.test(line)) {
          const reply = { code: Number(line.slice(0, 3)), text: this.lines.join('\n') };
          this.lines = [];
          const w = this.waiter;
          this.waiter = null;
          w?.resolve(reply);
        }
      }
    });
    sock.on('error', (err) => { const w = this.waiter; this.waiter = null; w?.reject(mailError('MAIL_CONNECT', `发信服务器出错（${err.message}）`)); });
    sock.on('close', () => { const w = this.waiter; this.waiter = null; w?.reject(mailError('MAIL_CLOSED', '发信服务器断开了连接')); });
  }

  reply() {
    return new Promise((resolve, reject) => { this.waiter = { resolve, reject }; });
  }

  async send(line, expect) {
    const p = this.reply();
    this.sock.write(`${line}\r\n`);
    const r = await p;
    if (expect && !expect.includes(r.code)) throw Object.assign(mailError('MAIL_SMTP', r.text.slice(0, 300)), { smtp: r.code });
    return r;
  }

  async open() {
    const implicit = this.port === 465;
    const sock = this.connectImpl ? this.connectImpl()
      : implicit ? tls.connect({ host: this.host, port: this.port, servername: this.host }) : net.connect({ host: this.host, port: this.port });
    const greet = this.reply();
    this.attach(sock);
    const g = await greet.catch((err) => { throw mailError('MAIL_CONNECT', `连不上发信服务器 ${this.host}:${this.port}（${err.message}）`); });
    if (g.code !== 220) throw mailError('MAIL_SMTP', g.text.slice(0, 200));
    let ehlo = await this.send('EHLO nightshift.local', [250]);
    if (!implicit && !this.connectImpl) {
      if (!/STARTTLS/i.test(ehlo.text)) throw mailError('MAIL_SMTP', '发信服务器不支持加密连接（STARTTLS），不发');
      await this.send('STARTTLS', [220]);
      const secure = tls.connect({ socket: sock, servername: this.host });
      sock.removeAllListeners('data');
      await new Promise((resolve, reject) => { secure.once('secureConnect', resolve); secure.once('error', reject); });
      this.attach(secure);
      ehlo = await this.send('EHLO nightshift.local', [250]);
    }
    this.ehlo = ehlo.text;
  }

  async auth(user, pass) {
    try {
      if (/AUTH[ =][^\n]*PLAIN/i.test(this.ehlo)) {
        await this.send(`AUTH PLAIN ${Buffer.from(`\u0000${user}\u0000${pass}`, 'utf8').toString('base64')}`, [235]);
      } else {
        await this.send('AUTH LOGIN', [334]);
        await this.send(Buffer.from(user, 'utf8').toString('base64'), [334]);
        await this.send(Buffer.from(pass, 'utf8').toString('base64'), [235]);
      }
    } catch (err) {
      throw mailError('MAIL_AUTH', `发信登录被拒绝：${err.message}。请确认用的是授权码，并且邮箱设置里已经开启 SMTP。`);
    }
  }

  async mail(from, rcpts, data) {
    await this.send(`MAIL FROM:<${from}>`, [250]);
    for (const r of rcpts) await this.send(`RCPT TO:<${r}>`, [250, 251]);
    await this.send('DATA', [354]);
    const body = data.replace(/\r?\n/g, '\r\n').replace(/^\./gm, '..');
    const p = this.reply();
    this.sock.write(`${body}\r\n.\r\n`);
    const r = await p;
    if (r.code !== 250) throw mailError('MAIL_SMTP', r.text.slice(0, 300));
    return r.text;
  }

  async quit() {
    try { await Promise.race([this.send('QUIT'), new Promise((r) => setTimeout(r, 2000))]); } catch { /* fine */ }
    try { this.sock.end(); } catch { /* gone */ }
  }
}

// ---------------------------------------------------------------------------
// the app: tools a bot can use

const TOOLS = [
  {
    name: 'mail_accounts',
    description: 'The mailboxes connected here (addresses).',
    inputSchema: { type: 'object', properties: {} },
    annotations: { readOnlyHint: true },
  },
  {
    name: 'mail_folders',
    description: 'List the mailbox folders (收件箱, 已发送, 垃圾邮件 ...).',
    inputSchema: { type: 'object', properties: { account: { type: 'string', description: 'Which mailbox (its address, or part of it such as qq or 163). Omit when there is only one.' } } },
    annotations: { readOnlyHint: true },
  },
  {
    name: 'mail_list',
    description: 'The newest mail in a folder: uid, from, subject, date, unread. Use mail_read with the uid (and the account it is in) for the content. Without account, every mailbox is listed.',
    inputSchema: { type: 'object', properties: { account: { type: 'string', description: 'Which mailbox (its address, or part of it such as qq or 163). Omit when there is only one.' }, folder: { type: 'string', description: 'Folder, default INBOX.' }, limit: { type: 'integer', description: 'How many, default 20, at most 50.' }, unread_only: { type: 'boolean' } } },
    annotations: { readOnlyHint: true },
  },
  {
    name: 'mail_search',
    description: 'Find mail by sender, subject, words in the text, or date (YYYY-MM-DD). Newest first. Without account, every mailbox is searched.',
    inputSchema: {
      type: 'object',
      properties: {
        account: { type: 'string', description: 'Which mailbox (its address, or part of it such as qq or 163). Omit when there is only one.' },
        folder: { type: 'string' }, from: { type: 'string' }, subject: { type: 'string' }, text: { type: 'string', description: 'Words anywhere in the mail.' },
        since: { type: 'string', description: 'On or after this date, YYYY-MM-DD.' }, before: { type: 'string', description: 'Before this date, YYYY-MM-DD.' },
        unread_only: { type: 'boolean' }, limit: { type: 'integer', description: 'Default 20, at most 200.' },
        uids_only: { type: 'boolean', description: 'Only the count and the uids (for moving or deleting many at once).' },
      },
    },
    annotations: { readOnlyHint: true },
  },
  {
    name: 'mail_read',
    description: 'Read one mail by uid: headers, the text, and its attachments (names and sizes). save_attachments=true saves them to the workspace and returns the paths. Reading does not mark it as read.',
    inputSchema: { type: 'object', properties: { account: { type: 'string', description: 'Which mailbox (its address, or part of it such as qq or 163). Omit when there is only one.' }, uid: { type: 'integer' }, folder: { type: 'string' }, save_attachments: { type: 'boolean' }, max_chars: { type: 'integer', description: 'Cut the text after this many characters, default 8000.' } }, required: ['uid'] },
    annotations: { readOnlyHint: true },
  },
  {
    name: 'mail_send',
    description: 'Send a mail. account = the mailbox it is sent from (needed when there are several). to/cc: addresses (list or comma separated). attachments: workspace file paths. To reply, pass reply_to_uid (and folder) of the mail you answer: the subject gets "Re:" and the thread headers are set.',
    inputSchema: {
      type: 'object',
      properties: {
        account: { type: 'string', description: 'Which mailbox (its address, or part of it such as qq or 163). Omit when there is only one.' },
        to: { type: 'array', items: { type: 'string' } }, cc: { type: 'array', items: { type: 'string' } }, subject: { type: 'string' }, body: { type: 'string', description: 'Plain text.' },
        attachments: { type: 'array', items: { type: 'string' } }, reply_to_uid: { type: 'integer' }, folder: { type: 'string' },
      },
      required: ['to', 'body'],
    },
    annotations: { readOnlyHint: false, destructiveHint: false },
  },
  {
    name: 'mail_move',
    description: 'Move mail to another folder, e.g. to: "垃圾邮件" (spam), "已删除" (trash), "归档" (archive) or any folder mail_folders lists. folder = where it is now (default INBOX). Up to 500 uids at once. When cleaning up, move only the mail that should go - never move everything out and then move the keepers back.',
    inputSchema: { type: 'object', properties: { account: { type: 'string', description: 'Which mailbox (its address, or part of it such as qq or 163). Omit when there is only one.' }, uids: { type: 'array', items: { type: 'integer' } }, folder: { type: 'string' }, to: { type: 'string' } }, required: ['uids', 'to'] },
    annotations: { readOnlyHint: false, destructiveHint: false },
  },
  {
    name: 'mail_delete',
    description: 'Delete mail: it goes to the trash folder (已删除), where it can still be restored. permanent=true removes it for good - only when the human explicitly asked for permanent deletion; mail already in the trash is always removed for good. Up to 500 uids at once. Delete only the mail that should go; never delete everything and then restore the keepers.',
    inputSchema: { type: 'object', properties: { account: { type: 'string', description: 'Which mailbox (its address, or part of it such as qq or 163). Omit when there is only one.' }, uids: { type: 'array', items: { type: 'integer' } }, folder: { type: 'string', description: 'Where the mail is now, default INBOX.' }, permanent: { type: 'boolean' } }, required: ['uids'] },
    annotations: { readOnlyHint: false, destructiveHint: true },
  },
  {
    name: 'mail_mark',
    description: 'Mark mail as read or unread.',
    inputSchema: { type: 'object', properties: { account: { type: 'string', description: 'Which mailbox (its address, or part of it such as qq or 163). Omit when there is only one.' }, uids: { type: 'array', items: { type: 'integer' } }, folder: { type: 'string' }, read: { type: 'boolean' } }, required: ['uids', 'read'] },
    annotations: { readOnlyHint: false, destructiveHint: false },
  },
];

const IMAP_MONTHS = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];
function imapDate(s) {
  const m = String(s || '').match(/^(\d{4})-(\d{1,2})-(\d{1,2})$/);
  if (!m) throw mailError('MAIL_BAD_DATE', `日期要写成 YYYY-MM-DD：${s}`);
  return `${Number(m[3])}-${IMAP_MONTHS[Number(m[2]) - 1]}-${m[1]}`;
}

/** A search word: quoted when plain ASCII, else a literal (with CHARSET UTF-8). */
function word(s) {
  const v = String(s);
  return /^[\x20-\x7e]*$/.test(v) ? quote(v) : Buffer.from(v, 'utf8');
}

function line(m) {
  return `uid ${m.uid}${m.unread ? ' ·未读' : ''} | ${m.date} | ${m.from} | ${m.subject}`;
}

/**
 * The mailbox as an app. env: {EMAIL, PASS, IMAP, SMTP} (servers optional for
 * known mailboxes). -> {handle(jsonRpcMessage) -> response | null}
 */
/** The mailboxes in a connection: MAILBOXES (a JSON list), or the single EMAIL / PASS of 1.2.130. */
export function mailboxesFrom(env = {}) {
  let list = [];
  try { list = JSON.parse(env.MAILBOXES || '[]'); } catch { list = []; }
  if (!Array.isArray(list) || !list.length) list = env.EMAIL ? [{ EMAIL: env.EMAIL, PASS: env.PASS, IMAP: env.IMAP, SMTP: env.SMTP }] : [];
  return list.filter((b) => b && b.EMAIL);
}

export function createMailServer({ env = {}, workspaceDir = '', version = '0', imapImpl = null, smtpImpl = null } = {}) {
  const all = () => {
    const list = mailboxesFrom(env).map((b) => resolveAccount({ email: b.EMAIL, pass: b.PASS, imap: b.IMAP, smtp: b.SMTP }));
    if (!list.length) throw mailError('MAIL_NO_ACCOUNT', '还没有连邮箱');
    return list;
  };
  /** The mailboxes a call means. `one`: it must be a single one (read, mark, send). */
  const pick = (want, { one = false } = {}) => {
    const list = all();
    const w = String(want || '').trim().toLowerCase();
    if (!w) {
      if (list.length === 1 || !one) return list;
      throw mailError('MAIL_WHICH', `连了 ${list.length} 个邮箱（${list.map((a) => a.email).join('、')}），用 account 说是哪一个`);
    }
    const exact = list.filter((a) => a.email.toLowerCase() === w);
    const hits = exact.length ? exact : list.filter((a) => a.email.toLowerCase().includes(w) || a.name.toLowerCase().includes(w));
    if (hits.length === 1) return hits;
    throw mailError('MAIL_WHICH', hits.length ? `「${want}」对得上好几个邮箱（${hits.map((a) => a.email).join('、')}），写完整地址` : `没有连「${want}」这个邮箱，连了的是：${list.map((a) => a.email).join('、')}`);
  };

  const withImap = async (a, fn) => {
    const c = imapImpl ? imapImpl(a) : new Imap(a.imap);
    await c.open();
    try {
      await c.login(a.email, a.pass);
      return await fn(c, a);
    } finally { await c.logout(); }
  };

  const eachBox = async (boxes, fn) => {
    if (boxes.length === 1) return fn(boxes[0]);
    const parts = await Promise.all(boxes.map(async (a) => {
      try { return `【${a.email}】\n${await fn(a)}`; } catch (err) { return `【${a.email}】没查成：${err.message}`; }
    }));
    return parts.join('\n\n');
  };

  const uidList = (uids) => {
    const list = [...new Set((Array.isArray(uids) ? uids : String(uids || '').split(/[,\s]+/)).map(Number).filter((n) => Number.isInteger(n) && n > 0))];
    if (!list.length) throw mailError('MAIL_BAD_UID', '没有 uid');
    if (list.length > 500) throw mailError('MAIL_TOO_MANY', `一次最多 500 封，这次有 ${list.length} 封：分几次做`);
    return list;
  };

  const folderFor = async (c, wanted) => {
    const f = String(wanted || 'INBOX').trim();
    if (/^inbox$/i.test(f) || f === '收件箱') return 'INBOX';
    const list = await c.folders();
    const hit = list.find((x) => x.name === f || x.path === f)
      || list.find((x) => x.name.toLowerCase() === f.toLowerCase())
      || (/^(sent|已发送|发件箱)$/i.test(f) && list.find((x) => x.flags.some((y) => /\\Sent/i.test(y)) || /sent|已发送/i.test(x.name)))
      || (/^(spam|junk|垃圾邮件)/i.test(f) && list.find((x) => x.flags.some((y) => /\\Junk/i.test(y)) || /junk|spam|垃圾邮件/i.test(x.name)))
      || (/^(trash|deleted|已删除|删除|废纸篓|垃圾箱)/i.test(f) && list.find((x) => x.flags.some((y) => /\\Trash/i.test(y)) || /trash|deleted|已删除|废纸篓/i.test(x.name)))
      || (/^(archive|归档)/i.test(f) && list.find((x) => x.flags.some((y) => /\\(Archive|All)/i.test(y)) || /archive|归档/i.test(x.name)));
    if (!hit) throw mailError('MAIL_NO_FOLDER', `没有文件夹「${f}」，有：${list.map((x) => x.name).join('、')}`);
    return hit.name;
  };

  const tools = {
    async mail_accounts() {
      return all().map((a, i) => `${a.email}（${a.name}）${i === 0 ? ' · 默认' : ''}`).join('\n');
    },
    async mail_folders({ account } = {}) {
      const [a] = pick(account, { one: true });
      return withImap(a, async (c) => (await c.folders()).map((f) => `${f.name}${f.flags.filter((x) => /\\(Sent|Junk|Trash|Drafts|Archive)/i.test(x)).map((x) => ` (${x.slice(1)})`).join('')}`).join('\n'));
    },
    async mail_list({ account, folder, limit = 20, unread_only = false } = {}) {
      const n = Math.min(Math.max(Number(limit) || 20, 1), 50);
      return eachBox(pick(account), (a) => withImap(a, async (c) => {
        const name = await folderFor(c, folder);
        const { exists } = await c.open_(name);
        if (!exists) return `${a.email} 的「${name}」是空的。`;
        let rows;
        if (unread_only) {
          const uids = (await c.search(['UID SEARCH UNSEEN'])).slice(-n);
          rows = uids.length ? await c.summaries(uids.join(','), { uid: true }) : [];
        } else rows = await c.summaries(`${Math.max(1, exists - n + 1)}:${exists}`);
        return rows.length ? `「${name}」最新 ${rows.length} 封（共 ${exists} 封）：\n${rows.map(line).join('\n')}` : `「${name}」里没有${unread_only ? '未读' : ''}邮件。`;
      }));
    },
    async mail_search({ account, folder, from, subject, text, since, before, unread_only, limit = 20, uids_only = false } = {}) {
      const n = Math.min(Math.max(Number(limit) || 20, 1), uids_only ? 500 : 200);
      return eachBox(pick(account), (a) => withImap(a, async (c) => {
        const name = await folderFor(c, folder);
        await c.open_(name);
        const parts = [];
        const add = (key, v) => { if (v) parts.push(` ${key} `, word(v)); };
        add('FROM', from); add('SUBJECT', subject); add('TEXT', text);
        if (since) parts.push(` SINCE ${imapDate(since)}`);
        if (before) parts.push(` BEFORE ${imapDate(before)}`);
        if (unread_only) parts.push(' UNSEEN');
        if (!parts.length) parts.push(' ALL');
        const utf8 = parts.some((p) => Buffer.isBuffer(p));
        const all = await c.search([`UID SEARCH${utf8 ? ' CHARSET UTF-8' : ''}`, ...parts]);
        const uids = all.slice(-n);
        if (!uids.length) return `「${name}」里没有找到。`;
        if (uids_only) return `「${name}」里共找到 ${all.length} 封${all.length > uids.length ? `（这里给出最新的 ${uids.length} 封）` : ''}，uid：${[...uids].reverse().join(',')}`;
        return `找到 ${uids.length} 封（「${name}」）：\n${(await c.summaries(uids.join(','), { uid: true })).map(line).join('\n')}`;
      }));
    },
    async mail_read({ account, uid, folder, save_attachments = false, max_chars = 8000 } = {}) {
      if (!Number(uid)) throw mailError('MAIL_BAD_UID', 'uid 不对');
      const [a] = pick(account, { one: true });
      return withImap(a, async (c) => {
        const name = await folderFor(c, folder);
        await c.open_(name);
        const { raw } = await c.fetchRaw(Number(uid));
        const m = parseMessage(raw);
        const h = m.headers;
        let body = m.text || htmlToText(m.html);
        const cap = Math.min(Math.max(Number(max_chars) || 8000, 500), 40000);
        if (body.length > cap) body = `${body.slice(0, cap)}\n……（后面还有 ${body.length - cap} 字，没有显示）`;
        const saved = [];
        if (save_attachments && m.attachments.length && workspaceDir) {
          const dir = path.join('mail', new Date().toISOString().slice(0, 10), String(uid));
          await fsp.mkdir(path.join(workspaceDir, dir), { recursive: true });
          for (const a of m.attachments) {
            const safe = String(a.filename).replace(/[\\/:*?"<>|\u0000-\u001f]/g, '_').slice(0, 120) || 'attachment';
            await fsp.writeFile(path.join(workspaceDir, dir, safe), a.data);
            saved.push(path.join(dir, safe).split(path.sep).join('/'));
          }
        }
        return [
          `发件人：${decodeWords(h.from || '')}`,
          `收件人：${decodeWords(h.to || '')}`,
          ...(h.cc ? [`抄送：${decodeWords(h.cc)}`] : []),
          `主题：${decodeWords(h.subject || '') || '（无主题）'}`,
          `日期：${h.date || ''}`,
          ...(h['message-id'] ? [`Message-ID：${h['message-id']}`] : []),
          ...(m.attachments.length ? [`附件：${m.attachments.map((a, i) => `${a.filename}（${Math.ceil(a.size / 1024)} KB）${saved[i] ? ` → ${saved[i]}` : ''}`).join('；')}`] : []),
          '',
          body || '（没有正文）',
        ].join('\n');
      });
    },
    async mail_send({ account, to, cc = [], subject = '', body = '', attachments = [], reply_to_uid, folder } = {}) {
      const [a] = pick(account, { one: true });
      const rcptTo = addressList(to);
      const rcptCc = addressList(cc);
      if (!rcptTo.length) throw mailError('MAIL_NO_TO', '收件人地址不对');
      const files = [];
      for (const rel of (Array.isArray(attachments) ? attachments : [attachments]).filter(Boolean)) {
        const full = path.resolve(workspaceDir || '.', String(rel));
        if (workspaceDir && !full.startsWith(path.resolve(workspaceDir))) throw mailError('MAIL_ATTACH_OUTSIDE', `附件只能是工作区里的文件：${rel}`);
        const data = await fsp.readFile(full).catch(() => { throw mailError('MAIL_ATTACH_MISSING', `附件不存在：${rel}`); });
        if (data.length > 20 * 1024 * 1024) throw mailError('MAIL_ATTACH_BIG', `附件太大（超过 20 MB）：${rel}`);
        files.push({ filename: path.basename(full), data });
      }
      let subj = String(subject || '');
      let inReplyTo = '';
      let references = '';
      if (reply_to_uid) {
        const orig = await withImap(a, async (c) => { await c.open_(await folderFor(c, folder)); return parseMessage((await c.fetchRaw(Number(reply_to_uid))).raw).headers; });
        inReplyTo = orig['message-id'] || '';
        references = orig.references || '';
        if (!subj) subj = decodeWords(orig.subject || '');
        if (!/^re:/i.test(subj)) subj = `Re: ${subj}`;
      }
      const data = buildMessage({ from: a.email, to: rcptTo, cc: rcptCc, subject: subj, text: String(body), attachments: files, inReplyTo, references });
      const s = smtpImpl ? smtpImpl(a) : new Smtp(a.smtp);
      await s.open();
      try {
        await s.auth(a.email, a.pass);
        await s.mail(a.email, [...rcptTo, ...rcptCc], data);
      } finally { await s.quit(); }
      return `已发出：${a.email} → ${[...rcptTo, ...rcptCc].join('、')}，主题「${subj || '（无主题）'}」${files.length ? `，附件 ${files.map((f) => f.filename).join('、')}` : ''}。`;
    },
    async mail_move({ account, uids = [], folder, to } = {}) {
      const list = uidList(uids);
      const [a] = pick(account, { one: true });
      return withImap(a, async (c) => {
        const from = await folderFor(c, folder);
        const target = await folderFor(c, to);
        if (target === from) return `已经在「${from}」里了。`;
        await c.open_(from, false);
        await c.move(list.join(','), target);
        return `已把 ${list.length} 封从「${from}」移到「${target}」。`;
      });
    },
    async mail_delete({ account, uids = [], folder, permanent = false } = {}) {
      const list = uidList(uids);
      const [a] = pick(account, { one: true });
      return withImap(a, async (c) => {
        const from = await folderFor(c, folder);
        let trash = '';
        try { trash = await folderFor(c, 'trash'); } catch { /* none */ }
        await c.open_(from, false);
        if (permanent || (trash && trash === from)) {
          await c.remove(list.join(','));
          return `已永久删除 ${list.length} 封（「${from}」），不能恢复。`;
        }
        if (!trash) throw mailError('MAIL_NO_TRASH', '这个邮箱没有「已删除」文件夹；要永久删除，得明确说永久删除（permanent）');
        await c.move(list.join(','), trash);
        return `已删除 ${list.length} 封：移到了「${trash}」，需要的话还能从那里恢复。`;
      });
    },
    async mail_mark({ account, uids = [], folder, read = true } = {}) {
      const list = (Array.isArray(uids) ? uids : [uids]).map(Number).filter(Boolean);
      if (!list.length) throw mailError('MAIL_BAD_UID', '没有 uid');
      const [a] = pick(account, { one: true });
      return withImap(a, async (c) => {
        await c.open_(await folderFor(c, folder), false);
        await c.cmd(`UID STORE ${list.join(',')} ${read ? '+' : '-'}FLAGS.SILENT (\\Seen)`);
        return `已标成${read ? '已读' : '未读'}：${list.length} 封。`;
      });
    },
  };

  return {
    async handle(msg) {
      const reply = (result) => (msg.id === undefined ? null : { jsonrpc: '2.0', id: msg.id, result });
      const fail = (err) => (msg.id === undefined ? null : { jsonrpc: '2.0', id: msg.id, error: { code: -32000, message: err.message } });
      try {
        if (msg.method === 'initialize') {
          // Connecting checks the address and the code right away, so a wrong one shows in Settings.
          for (const a of all()) {
            await withImap(a, async () => {}).catch((err) => { throw mailError(err.code || 'MAIL_AUTH', all().length > 1 ? `${a.email}：${err.message}` : err.message); });
          }
          return reply({ protocolVersion: msg.params?.protocolVersion || '2025-06-18', capabilities: { tools: {} }, serverInfo: { name: 'nightshift-mail', version } });
        }
        if (msg.method === 'tools/list') return reply({ tools: TOOLS });
        if (msg.method === 'tools/call') {
          const fn = tools[msg.params?.name];
          if (!fn) return fail(new Error(`没有工具 ${msg.params?.name}`));
          try {
            return reply({ content: [{ type: 'text', text: String(await fn(msg.params?.arguments || {})) }] });
          } catch (err) {
            return reply({ content: [{ type: 'text', text: err.message }], isError: true });
          }
        }
        if (msg.method === 'ping') return reply({});
        return msg.id === undefined ? null : fail(new Error(`not supported: ${msg.method}`));
      } catch (err) {
        return fail(err);
      }
    },
  };
}

/** Can this one mailbox sign in? (Checked before it is added.) -> {ok} or {ok:false, message} */
export async function checkMailbox(box, { imapImpl = null } = {}) {
  const app = createMailServer({ env: { MAILBOXES: JSON.stringify([box]) }, imapImpl });
  const r = await app.handle({ jsonrpc: '2.0', id: 1, method: 'initialize', params: {} });
  return r.error ? { ok: false, message: r.error.message } : { ok: true };
}
