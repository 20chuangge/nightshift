/**
 * mcp.mjs - connect MCP servers (Model Context Protocol) the human adds, so
 * their tools become tools the bots can use.
 *
 * Two transports, JSON-RPC 2.0 written out by hand (no SDK dependency):
 *   stdio            spawn(command, args); one JSON message per line
 *   Streamable HTTP  POST to the URL; the answer is JSON or an SSE stream;
 *                    Mcp-Session-Id is kept and sent back
 *
 * Handshake: initialize -> notifications/initialized -> tools/list (paged).
 * Calls: tools/call, 120 s. tools/list_changed re-reads the list.
 *
 * Config: data/mcp.json [{id, name, transport, command, args, env, url,
 * headers, secretRef, enabled, trust, bots}]. Secrets (API keys, tokens) are
 * never in that file: they sit in the vault entry `secretRef`, and the config
 * says where they go with ${名字} in args, env values or header values. They
 * are filled in only when the server is started; GET /api/mcp shows names.
 */

import fsp from 'node:fs/promises';
import path from 'node:path';
import { spawn } from 'node:child_process';
import { P, readJson, writeJsonAtomic } from './store.mjs';
import { childEnv } from './childenv.mjs';
import { putVault, deleteVault, revealVault, listVault } from './vault.mjs';
import crypto from 'node:crypto';
import { discoverOAuth, registerClient, authorizeUrl, exchangeCode, refreshAccess, pkcePair } from './mcpauth.mjs';

export const MCP_PROTOCOL = '2025-06-18';
export const MCP_CALL_TIMEOUT_MS = 120000;
const INIT_TIMEOUT_MS = 60000; // npx may download the package the first time
const MAX_RETRIES = 5;
const FILE = () => path.join(P.dataDir, 'mcp.json');
const SECRET_RE = /\$\{([^}]{1,40})\}/g;

/** Ready-made servers; each official package / URL checked against its own docs. */
export const MCP_PRESETS = [
  {
    id: 'filesystem', name: '文件系统', transport: 'stdio', command: 'npx',
    args: ['-y', '@modelcontextprotocol/server-filesystem', '{workspace}'], secrets: [],
    note: '读写一个文件夹（默认是工作区）。',
  },
  {
    id: 'feishu', name: '飞书', transport: 'stdio', command: 'npx',
    args: ['-y', '@larksuiteoapi/lark-mcp', 'mcp', '-a', '${APP_ID}', '-s', '${APP_SECRET}'], secrets: ['APP_ID', 'APP_SECRET'],
    note: '飞书官方 MCP（@larksuiteoapi/lark-mcp，测试版）。在飞书开放平台建一个应用，填它的 App ID 和 App Secret，并给应用开要用的权限。',
  },
  {
    id: 'github', name: 'GitHub', transport: 'http', url: 'https://api.githubcopilot.com/mcp/',
    headers: { Authorization: 'Bearer ${TOKEN}' }, secrets: ['TOKEN'],
    note: 'GitHub 官方远程 MCP。在 GitHub → Settings → Developer settings 建一个 Personal access token 填进来。',
  },
  {
    id: 'notion', name: 'Notion', transport: 'stdio', command: 'npx',
    args: ['-y', '@notionhq/notion-mcp-server'], env: { NOTION_TOKEN: '${NOTION_TOKEN}' }, secrets: ['NOTION_TOKEN'],
    note: 'Notion 官方 MCP。在 notion.so/my-integrations 建一个集成拿到 token，再把要用的页面分享给这个集成。',
  },
];

/**
 * The app catalog (Settings → 连接应用): one 「连接」 per app. `auth` says what
 * that button does:
 *   oauth   the app's own sign-in page (MCP OAuth with dynamic registration)
 *   token   a small box for a personal token, with where to make one
 *   feishu  the App ID / Secret already set in Settings → 飞书, read at start
 *   none    nothing to sign in
 * The custom form below the catalog stays for anything not listed.
 */
export const MCP_CATALOG = [
  {
    id: 'notion', name: 'Notion', category: '效率', badge: 'N', color: '#111111',
    desc: '读写你的 Notion 页面和数据库', auth: 'oauth', transport: 'http', url: 'https://mcp.notion.com/mcp',
    help: '会打开 Notion 的授权页：选要给机器人看的页面，点「允许」。',
  },
  {
    id: 'github', name: 'GitHub', category: '开发', badge: 'GH', color: '#24292f',
    desc: '仓库、Issue、Pull Request', auth: 'token', transport: 'http', url: 'https://api.githubcopilot.com/mcp/',
    headers: { Authorization: 'Bearer ${TOKEN}' }, secret: 'TOKEN',
    help: '在 GitHub 建一个 Personal access token（Fine-grained 就行，选要给的仓库和权限），贴到下面。',
    tokenUrl: 'https://github.com/settings/personal-access-tokens/new',
  },
  {
    id: 'gitlab', name: 'GitLab', category: '开发', badge: 'GL', color: '#fc6d26',
    desc: '项目、Issue、合并请求、流水线（GitLab 官方 MCP）', auth: 'oauth', transport: 'http', url: 'https://gitlab.com/api/v4/mcp',
    help: '会打开 GitLab 的授权页，点「Authorize」（会提示这是未验证的动态应用，属正常）。用不了时，请顶层群组的所有者在群组设置里打开「允许访问 MCP 服务器」。自建的 GitLab 用下面「自己添加」，地址填 https://你的GitLab地址/api/v4/mcp。',
  },
  {
    id: 'baidu-pan', name: '百度网盘', category: '存储', badge: '百', color: '#06a7ff',
    desc: '查找、整理、分享网盘里的文件（百度网盘官方 MCP）', auth: 'token', transport: 'sse', url: 'https://mcp-pan.baidu.com/sse?access_token=${TOKEN}', secret: 'TOKEN',
    help: '点「去获取」会打开百度的授权页，登录后点「授权」；跳转后的网址里 access_token= 后面那一串就是，复制贴到下面。它大约一个月过期，过期后重新获取一次。从本机上传文件到网盘这一项官方只在本地模式提供，这里没有。',
    tokenLabel: '去获取 token ↗',
    tokenUrl: 'https://openapi.baidu.com/oauth/2.0/authorize?response_type=token&client_id=QHOuRXiepJBMjtk0esLhrPoNlQyYd0mF&redirect_uri=oob&scope=basic,netdisk',
  },
  {
    id: 'runway', name: 'Runway', category: '创作', badge: 'R', color: '#0b0b0b',
    desc: '生成图片和视频（Runway 官方 MCP，用你账户里的额度）', auth: 'oauth', transport: 'http', url: 'https://mcp.runwayml.com/mcp',
    help: '会打开 Runway 的登录授权页，登录后点允许。生成会用掉你 Runway 账户里的额度。',
  },
  {
    id: 'suno', name: 'Suno', category: '创作', badge: 'S', color: '#1a1a1a',
    desc: '写歌、生成音乐（Suno 官方 MCP，测试版）', auth: 'oauth', transport: 'http', url: 'https://api.suno.com/mcp',
    help: 'Suno 的 MCP 还在内测：先在 suno.com/mcp 申请开通，通过后再点「连接」，在 Suno 的页面登录授权。生成的歌用你 Suno 套餐里的额度。',
  },
  {
    id: 'email', name: '邮箱', category: '通信', badge: '邮', color: '#0f9d58',
    desc: '收信、查信、读信、发信（QQ、163、126、Gmail 等，用授权码，可以连多个邮箱）', auth: 'mail', transport: 'internal', module: 'mail',
    env: { MAILBOXES: '${MAILBOXES}' },
    help: '填邮箱地址和「授权码」（不是登录密码）。QQ 邮箱：设置 → 账号 → 开启 IMAP/SMTP 服务，按提示生成授权码。163 / 126：设置 → POP3/SMTP/IMAP → 开启 IMAP/SMTP，按提示设置授权码。Gmail：先开两步验证，再到 Google 账号的「应用专用密码」生成一个。长明自己连邮箱服务器，不经过别的服务；授权码加密存在这台机器的保险箱里。发信每次都会先问你。',
  },
  {
    id: 'feishu', name: '飞书', category: '通信', badge: '飞', color: '#3370ff',
    desc: '消息、文档、多维表格、日历（飞书官方 MCP，测试版）', auth: 'feishu', transport: 'stdio', command: 'npx',
    args: ['-y', '@larksuiteoapi/lark-mcp', 'mcp', '-a', '${APP_ID}', '-s', '${APP_SECRET}'],
    help: '用「设置 → 飞书」里那个应用的 App ID 和 App Secret。能用哪些功能取决于你在飞书开放平台给这个应用开的权限。',
  },
  {
    id: 'filesystem', name: '文件系统', category: '本机', badge: '文', color: '#5b6474',
    desc: '读写工作区里的文件', auth: 'none', transport: 'stdio', command: 'npx',
    args: ['-y', '@modelcontextprotocol/server-filesystem', '{workspace}'],
    help: '第一次连接会用 npx 下载官方的 @modelcontextprotocol/server-filesystem。',
  },
];

// --------------------------------------------------------------------------
// names

/** mcp__<server>__<tool>, only [A-Za-z0-9_-], at most 64 characters. */
export function mcpToolName(serverId, toolName) {
  const clean = (s) => String(s || '').replace(/[^A-Za-z0-9_-]/g, '_');
  const name = `mcp__${clean(serverId)}__${clean(toolName)}`;
  return name.length <= 64 ? name : `${name.slice(0, 55)}_${hash(name).slice(0, 8)}`;
}

function hash(s) {
  let h = 2166136261;
  for (const ch of String(s)) { h ^= ch.charCodeAt(0); h = Math.imul(h, 16777619); }
  return (h >>> 0).toString(16).padStart(8, '0');
}

/** A schema the model APIs accept: an object, without $schema / $id noise. */
export function cleanSchema(schema) {
  const s = schema && typeof schema === 'object' ? JSON.parse(JSON.stringify(schema)) : {};
  const strip = (o) => {
    if (!o || typeof o !== 'object') return;
    delete o.$schema;
    delete o.$id;
    for (const v of Object.values(o)) strip(v);
  };
  strip(s);
  if (s.type !== 'object') return { type: 'object', properties: {} };
  if (!s.properties) s.properties = {};
  return s;
}

/** Fill ${名字} from the secret values; names without a value stay empty. */
export function fillSecrets(value, secrets) {
  return String(value ?? '').replace(SECRET_RE, (_, k) => (secrets[k.trim()] ?? ''));
}

/** Every ${名字} the config uses. */
export function secretNames(cfg) {
  const out = new Set();
  const scan = (v) => { for (const m of String(v ?? '').matchAll(SECRET_RE)) out.add(m[1].trim()); };
  (cfg.args || []).forEach(scan);
  Object.values(cfg.env || {}).forEach(scan);
  Object.values(cfg.headers || {}).forEach(scan);
  scan(cfg.url);
  return [...out];
}

// --------------------------------------------------------------------------
// transports

/** One MCP server connection. emit(event) reports state and list changes. */
export class McpClient {
  constructor(cfg, { secrets = {}, workspaceDir = '', clientVersion = '0', onNotify = () => {} } = {}) {
    this.cfg = cfg;
    this.secrets = secrets;
    this.workspaceDir = workspaceDir;
    this.clientVersion = clientVersion;
    this.onNotify = onNotify;
    this.nextId = 1;
    this.pending = new Map();
    this.child = null;
    this.sessionId = '';
    this.closed = false;
    this.stderrTail = '';
    this.serverInfo = null;
  }

  // --- stdio ---
  startStdio() {
    const fill = (v) => fillSecrets(String(v).replace('{workspace}', this.workspaceDir), this.secrets);
    const args = (this.cfg.args || []).map(fill);
    const env = childEnv(); // our keys are not theirs; theirs come from the app's own settings
    for (const [k, v] of Object.entries(this.cfg.env || {})) env[k] = fill(v);
    // The hub's own Node (Linux machines get one in their runtime folder, not on
    // PATH): npx / npm / node come from next to it, so 「npx …」 apps start there too.
    const nodeDir = path.dirname(process.execPath);
    const pathKey = Object.keys(env).find((k) => k.toUpperCase() === 'PATH') || 'PATH';
    if (!String(env[pathKey] || '').split(path.delimiter).includes(nodeDir)) env[pathKey] = [nodeDir, env[pathKey]].filter(Boolean).join(path.delimiter);
    let command = String(this.cfg.command || '').trim();
    if (!command) throw Object.assign(new Error('没有填命令'), { code: 'MCP_NO_COMMAND' });
    const opts = { env, stdio: ['pipe', 'pipe', 'pipe'], windowsHide: true, cwd: this.workspaceDir || undefined };
    if (process.platform === 'win32' && !/\.(exe|com)$/i.test(command)) {
      // npx / npm-installed commands are .cmd shims on Windows: go through
      // cmd.exe with every argument quoted (the values are the human's own).
      const quote = (a) => (/[\s"&|<>^()%!]/.test(a) ? `"${String(a).replace(/"/g, '""')}"` : a);
      const line = [command, ...args].map(quote).join(' ');
      this.child = spawn(process.env.ComSpec || 'cmd.exe', ['/d', '/s', '/c', `"${line}"`], { ...opts, windowsVerbatimArguments: true });
    } else {
      this.child = spawn(command, args, opts);
    }
    let buf = '';
    this.child.stdout.on('data', (chunk) => {
      buf += chunk.toString('utf8');
      let i;
      while ((i = buf.indexOf('\n')) >= 0) {
        const line = buf.slice(0, i).trim();
        buf = buf.slice(i + 1);
        if (line) this.receive(line);
      }
    });
    this.child.stderr.on('data', (c) => { this.stderrTail = (this.stderrTail + c.toString('utf8')).slice(-2000); });
    this.child.stdin.on('error', () => {});
    const gone = (why) => {
      const err = Object.assign(new Error(`${why}${this.stderrTail ? `：${this.stderrTail.trim().split('\n').slice(-3).join(' ')}` : ''}`), { code: 'MCP_EXITED' });
      for (const p of this.pending.values()) p.reject(err);
      this.pending.clear();
      if (!this.closed) this.onNotify({ type: 'closed', error: err.message });
    };
    this.child.on('error', (err) => gone(`启动失败（${err.message}）`));
    this.child.on('exit', (code) => gone(`进程退出（代码 ${code}）`));
  }

  writeStdio(msg) {
    this.child.stdin.write(`${JSON.stringify(msg)}\n`);
  }

  // --- Streamable HTTP ---
  async postHttp(msg, { timeoutMs }) {
    const url = fillSecrets(this.cfg.url, this.secrets);
    const headers = { 'content-type': 'application/json', accept: 'application/json, text/event-stream', 'mcp-protocol-version': MCP_PROTOCOL };
    for (const [k, v] of Object.entries(this.cfg.headers || {})) headers[k] = fillSecrets(v, this.secrets);
    if (this.sessionId) headers['mcp-session-id'] = this.sessionId;
    const res = await fetch(url, { method: 'POST', headers, body: JSON.stringify(msg), signal: AbortSignal.timeout(timeoutMs) });
    const sid = res.headers.get('mcp-session-id');
    if (sid) this.sessionId = sid;
    if (res.status === 202 || msg.id === undefined) return;
    if (!res.ok) {
      const text = (await res.text().catch(() => '')).slice(0, 300);
      const why = res.status === 401 || res.status === 403 ? '密钥不对或没有权限' : `HTTP ${res.status}`;
      throw Object.assign(new Error(`${why}${text ? `：${text}` : ''}`), { code: 'MCP_HTTP', status: res.status });
    }
    const type = res.headers.get('content-type') || '';
    if (type.includes('text/event-stream')) {
      // Read events until the answer to this request arrives.
      const text = await res.text();
      for (const block of text.split(/\r?\n\r?\n/)) {
        const data = block.split(/\r?\n/).filter((l) => l.startsWith('data:')).map((l) => l.slice(5).trimStart()).join('\n');
        if (data) this.receive(data);
      }
    } else {
      const body = await res.text();
      if (body.trim()) this.receive(body);
    }
  }

  // --- HTTP + SSE (the older remote form, e.g. 百度网盘): answers come over one
  // long GET stream; requests are POSTed to the address its first event names.
  startSse({ timeoutMs = INIT_TIMEOUT_MS } = {}) {
    const url = fillSecrets(this.cfg.url, this.secrets);
    const headers = { accept: 'text/event-stream' };
    for (const [k, v] of Object.entries(this.cfg.headers || {})) headers[k] = fillSecrets(v, this.secrets);
    this.sseAbort = new AbortController();
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => reject(Object.assign(new Error('连接后没有拿到消息地址'), { code: 'MCP_TIMEOUT' })), timeoutMs);
      const gone = (why) => {
        clearTimeout(timer);
        const err = Object.assign(new Error(why), { code: 'MCP_EXITED' });
        for (const p of this.pending.values()) p.reject(err);
        this.pending.clear();
        reject(err);
        if (!this.closed) this.onNotify({ type: 'closed', error: err.message });
      };
      fetch(url, { headers, signal: this.sseAbort.signal }).then(async (res) => {
        if (!res.ok) {
          const text = (await res.text().catch(() => '')).slice(0, 200);
          // 百度网盘 answers a bad or expired token with 400 "auth fail:token fail".
          const why = res.status === 401 || res.status === 403 || /auth fail|token fail|invalid.?token|expired/i.test(text) ? '密钥不对、过期了或没有权限' : `HTTP ${res.status}`;
          gone(`${why}${text ? `：${text}` : ''}`);
          return;
        }
        const reader = res.body.getReader();
        const dec = new TextDecoder();
        let buf = '';
        for (;;) {
          const { value, done } = await reader.read();
          if (done) break;
          buf += dec.decode(value, { stream: true });
          let k;
          while ((k = buf.search(/\r?\n\r?\n/)) >= 0) {
            const block = buf.slice(0, k);
            buf = buf.slice(k).replace(/^\r?\n\r?\n/, '');
            const lines = block.split(/\r?\n/);
            const event = (lines.find((l) => l.startsWith('event:')) || 'event: message').slice(6).trim();
            const data = lines.filter((l) => l.startsWith('data:')).map((l) => l.slice(5).trimStart()).join('\n');
            if (event === 'endpoint' && data) {
              this.postUrl = new URL(data, url).toString();
              clearTimeout(timer);
              resolve();
            } else if (data) this.receive(data);
          }
        }
        if (!this.closed) gone('连接断开了');
      }).catch((err) => { if (!this.closed) gone(`连接失败（${err.message}）`); });
    });
  }

  async postSse(msg, { timeoutMs }) {
    if (!this.postUrl) throw Object.assign(new Error('还没有连上'), { code: 'MCP_CLOSED' });
    const headers = { 'content-type': 'application/json' };
    for (const [k, v] of Object.entries(this.cfg.headers || {})) headers[k] = fillSecrets(v, this.secrets);
    const res = await fetch(this.postUrl, { method: 'POST', headers, body: JSON.stringify(msg), signal: AbortSignal.timeout(timeoutMs) });
    if (!res.ok && res.status !== 202) {
      const text = (await res.text().catch(() => '')).slice(0, 300);
      throw Object.assign(new Error(`HTTP ${res.status}${text ? `：${text}` : ''}`), { code: 'MCP_HTTP', status: res.status });
    }
    // Some servers answer right here as well as on the stream.
    const body = await res.text().catch(() => '');
    if (body.trim().startsWith('{') || body.trim().startsWith('[')) this.receive(body);
  }

  // --- JSON-RPC ---
  receive(line) {
    let msg;
    try { msg = JSON.parse(line); } catch { return; } // not ours (a log line)
    for (const m of Array.isArray(msg) ? msg : [msg]) {
      if (m.id !== undefined && (m.result !== undefined || m.error)) {
        const p = this.pending.get(m.id);
        if (!p) continue;
        this.pending.delete(m.id);
        if (m.error) p.reject(Object.assign(new Error(m.error.message || 'MCP error'), { code: 'MCP_RPC', rpc: m.error.code }));
        else p.resolve(m.result);
      } else if (m.method && m.id !== undefined) {
        // A request from the server (sampling, roots...): we offer none.
        this.send({ jsonrpc: '2.0', id: m.id, error: { code: -32601, message: 'not supported' } }).catch(() => {});
      } else if (m.method) {
        this.onNotify({ type: 'notification', method: m.method, params: m.params });
      }
    }
  }

  async send(msg, { timeoutMs = MCP_CALL_TIMEOUT_MS } = {}) {
    if (this.cfg.transport === 'internal') {
      const res = await this.internal.handle(msg);
      if (res) this.receive(JSON.stringify(res));
      return undefined;
    }
    if (this.cfg.transport === 'http') return this.postHttp(msg, { timeoutMs });
    if (this.cfg.transport === 'sse') return this.postSse(msg, { timeoutMs });
    return this.writeStdio(msg);
  }

  request(method, params, { timeoutMs = MCP_CALL_TIMEOUT_MS } = {}) {
    const id = this.nextId++;
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        this.pending.delete(id);
        reject(Object.assign(new Error(`${timeoutMs >= 1000 ? `${Math.round(timeoutMs / 1000)} 秒` : `${timeoutMs} 毫秒`}没有回应`), { code: 'MCP_TIMEOUT' }));
      }, timeoutMs);
      this.pending.set(id, {
        resolve: (v) => { clearTimeout(timer); resolve(v); },
        reject: (e) => { clearTimeout(timer); reject(e); },
      });
      Promise.resolve(this.send({ jsonrpc: '2.0', id, method, params }, { timeoutMs })).catch((err) => {
        const p = this.pending.get(id);
        if (p) { this.pending.delete(id); p.reject(err); }
      });
    });
  }

  notify(method, params) {
    return this.send({ jsonrpc: '2.0', method, ...(params ? { params } : {}) }).catch(() => {});
  }

  async connect() {
    if (this.cfg.transport === 'internal') {
      // Apps built into Nightshift (邮箱): the same JSON-RPC, answered in this process.
      const fill = (v) => fillSecrets(v, this.secrets);
      const env = Object.fromEntries(Object.entries(this.cfg.env || {}).map(([k, v]) => [k, fill(v)]));
      if (this.cfg.module !== 'mail') throw Object.assign(new Error(`没有内置应用「${this.cfg.module}」`), { code: 'MCP_NO_MODULE' });
      const { createMailServer } = await import('./mail.mjs');
      this.internal = createMailServer({ env, workspaceDir: this.workspaceDir, version: this.clientVersion });
    } else if (this.cfg.transport === 'sse') await this.startSse();
    else if (this.cfg.transport !== 'http') this.startStdio();
    const init = await this.request('initialize', {
      protocolVersion: MCP_PROTOCOL,
      capabilities: {},
      clientInfo: { name: 'nightshift', version: this.clientVersion },
    }, { timeoutMs: INIT_TIMEOUT_MS });
    this.serverInfo = init?.serverInfo || null;
    await this.notify('notifications/initialized');
    return init;
  }

  async listTools() {
    const tools = [];
    let cursor;
    for (let page = 0; page < 20; page += 1) {
      const res = await this.request('tools/list', cursor ? { cursor } : {});
      tools.push(...(res?.tools || []));
      cursor = res?.nextCursor;
      if (!cursor) break;
    }
    return tools;
  }

  callTool(name, args, opts) {
    return this.request('tools/call', { name, arguments: args || {} }, opts);
  }

  close() {
    this.closed = true;
    for (const p of this.pending.values()) p.reject(Object.assign(new Error('已断开'), { code: 'MCP_CLOSED' }));
    this.pending.clear();
    try { this.sseAbort?.abort(); } catch { /* gone */ }
    if (this.child && this.child.exitCode === null) {
      try {
        if (process.platform === 'win32') spawn('taskkill', ['/pid', String(this.child.pid), '/T', '/F'], { windowsHide: true });
        else this.child.kill();
      } catch { /* gone */ }
    }
    if (this.cfg.transport === 'http' && this.sessionId) {
      // Tell the server the session is over; it may ignore it.
      const headers = { 'mcp-session-id': this.sessionId };
      for (const [k, v] of Object.entries(this.cfg.headers || {})) headers[k] = fillSecrets(v, this.secrets);
      fetch(fillSecrets(this.cfg.url, this.secrets), { method: 'DELETE', headers, signal: AbortSignal.timeout(5000) }).catch(() => {});
    }
  }
}

// --------------------------------------------------------------------------
// results

/** MCP content -> what the bot sees. Images are saved into the workspace. */
export async function toolResultForBot(result, { workspaceDir, serverId }) {
  const parts = [];
  const files = [];
  for (const c of result?.content || []) {
    if (c.type === 'text') parts.push(String(c.text ?? ''));
    else if ((c.type === 'image' || c.type === 'audio') && c.data && workspaceDir) {
      const ext = String(c.mimeType || '').split('/')[1]?.replace(/[^a-z0-9]/gi, '') || (c.type === 'image' ? 'png' : 'bin');
      const rel = path.join('mcp', new Date().toISOString().slice(0, 10), `${serverId}-${Date.now()}-${files.length}.${ext}`);
      await fsp.mkdir(path.dirname(path.join(workspaceDir, rel)), { recursive: true });
      await fsp.writeFile(path.join(workspaceDir, rel), Buffer.from(c.data, 'base64'));
      files.push(rel.split(path.sep).join('/'));
    } else if (c.type === 'resource' && c.resource?.text) parts.push(String(c.resource.text));
    else if (c.type === 'resource_link' && c.uri) parts.push(`[${c.name || 'link'}] ${c.uri}`);
  }
  const text = parts.join('\n').slice(0, 40000);
  const out = { text };
  if (files.length) out.files = files;
  if (result?.structuredContent && !text) out.data = result.structuredContent;
  return out;
}

// --------------------------------------------------------------------------
// the manager: config, connections, tools

/** What makes two connections the same app: the web address, or the package npx / uvx runs. */
export function catalogKey(c) {
  if (!c) return '';
  if (c.transport === 'internal') return `internal:${c.module || ''}`;
  if (c.transport === 'http' || c.transport === 'sse') return String(c.url || '').trim().replace(/\?.*$/, '').replace(/\/+$/, '').toLowerCase();
  const cmd = path.basename(String(c.command || '')).replace(/\.(cmd|exe)$/i, '').toLowerCase();
  if (!['npx', 'uvx', 'bunx', 'pnpx'].includes(cmd)) return '';
  const pkg = (c.args || []).map(String).find((a) => !a.startsWith('-'));
  return pkg ? `${cmd}:${pkg.toLowerCase().replace(/@(latest|\d[\w.-]*)$/, '')}` : '';
}

const LOOPBACK = /^http:\/\/(127\.0\.0\.1|localhost|\[::1\]):\d{1,5}$/i;

/**
 * Where an app's sign-in page sends the browser back. Apps (Notion…) accept
 * only https or this computer's own loopback address, so:
 *   the page's own address when it is https or loopback;
 *   else `relay`, the loopback hub on the computer whose browser signs in
 *     (the desktop app working on another machine) - it passes the answer on;
 *   else this hub's https address on the internet (Funnel), when on;
 *   else null: there is no address the app would take.
 */
export function callbackBase(origin, relay, publicUrl) {
  const o = String(origin || '').replace(/\/+$/, '');
  if (/^https:\/\/[^/]+$/i.test(o) || LOOPBACK.test(o)) return o;
  const r = String(relay || '').replace(/\/+$/, '');
  if (LOOPBACK.test(r)) return r;
  const pub = String(publicUrl || '').replace(/\/+$/, '');
  if (/^https:\/\/[^/]+$/i.test(pub)) return pub;
  return null;
}

export function createMcpManager({
  registry, workspaceDir, version = '0', emit = () => {},
  makeClient = (cfg, opts) => new McpClient(cfg, opts),
  readFeishu = async () => null,
  catalog = MCP_CATALOG, // tests pass their own
  fetchImpl = fetch,
  publicUrl = () => null, // this hub's https address on the internet (Funnel), if on
  checkMailbox = null, // tests pass their own sign-in check for 邮箱
} = {}) {
  /** A config as update() input (what it is now, so only the secrets change). */
  const publicInput = (cfg) => ({ name: cfg.name, transport: cfg.transport, command: cfg.command, args: cfg.args, env: cfg.env, url: cfg.url, headers: cfg.headers, module: cfg.module });
  /** OAuth sign-ins waiting for their callback: state -> {...}. Ten minutes, used once. */
  const pendingAuth = new Map();
  /** id -> {cfg, client, state, error, tools:[], retries, timer} */
  const live = new Map();
  let configs = [];

  const publicCfg = (cfg) => {
    const l = live.get(cfg.id);
    return {
      id: cfg.id, name: cfg.name, transport: cfg.transport,
      command: cfg.command || '', args: cfg.args || [], env: cfg.env || {}, url: cfg.url || '', headers: cfg.headers || {},
      // Only names: the values are in the vault.
      // Signed in with OAuth or using the Feishu app from settings: nothing to type here.
      secrets: cfg.oauth || cfg.secretSource === 'feishu' ? [] : secretNames(cfg), hasSecrets: Boolean(cfg.secretRef || cfg.secretSource),
      enabled: cfg.enabled !== false, trust: cfg.trust === 'always' ? 'always' : 'ask', bots: cfg.bots || 'all',
      catalogId: cfg.catalogId || '', oauth: Boolean(cfg.oauth),
      ...(cfg.mailboxes ? { mailboxes: cfg.mailboxes } : {}),
      state: l?.state || (cfg.enabled === false ? 'off' : cfg.oauth && !cfg.secretRef ? 'needs_auth' : 'idle'),
      error: l?.error || (cfg.oauth && !cfg.secretRef ? '还没授权：点「连接」去那个应用的页面登录' : ''),
      tools: (l?.tools || []).map((t) => ({ name: t.name, description: String(t.description || '').slice(0, 200), readOnly: Boolean(t.annotations?.readOnlyHint) })),
      server: l?.client?.serverInfo || null,
    };
  };

  async function save() {
    await writeJsonAtomic(FILE(), configs);
  }

  async function secretsFor(cfg) {
    const names = secretNames(cfg);
    const out = {};
    // Feishu from the catalog: the app set up in Settings → 飞书, read now so a
    // changed secret there is used on the next connect.
    if (cfg.secretSource === 'feishu') {
      const f = await readFeishu().catch(() => null);
      return { APP_ID: f?.appId || '', APP_SECRET: f?.appSecret || '' };
    }
    if (!cfg.secretRef || !names.length) return out;
    for (const n of names) {
      try { out[n] = (await revealVault(cfg.secretRef, n)).value; } catch { /* missing: left empty */ }
    }
    return out;
  }

  async function vaultValue(cfg, field) {
    if (!cfg.secretRef) return '';
    try { return (await revealVault(cfg.secretRef, field)).value; } catch { return ''; }
  }

  /** OAuth: a new access token from the refresh token. false when that is not possible. */
  async function refreshOAuth(cfg) {
    const refreshToken = await vaultValue(cfg, 'REFRESH_TOKEN');
    if (!cfg.oauth || !refreshToken) return false;
    try {
      const tok = await refreshAccess({
        tokenEndpoint: cfg.oauth.tokenEndpoint, refreshToken, clientId: cfg.oauth.clientId,
        clientSecret: await vaultValue(cfg, 'CLIENT_SECRET'), resource: cfg.oauth.resource,
      }, { fetchImpl });
      await putVault({ id: cfg.secretRef, name: `MCP · ${cfg.name}`, values: { ACCESS_TOKEN: tok.accessToken, ...(tok.refreshToken ? { REFRESH_TOKEN: tok.refreshToken } : {}) } });
      cfg.oauth.expiresAt = tok.expiresAt;
      await save();
      return true;
    } catch {
      return false;
    }
  }

  function unregister(id) {
    const prefix = mcpToolName(id, '');
    for (const name of [...registry.tools.keys()]) if (name.startsWith(prefix)) registry.tools.delete(name);
  }

  function register(cfg, tools) {
    unregister(cfg.id);
    for (const t of tools) {
      const name = mcpToolName(cfg.id, t.name);
      const readOnly = Boolean(t.annotations?.readOnlyHint);
      registry.tools.set(name, {
        name,
        description: `［${cfg.name}］${String(t.description || t.title || t.name).slice(0, 900)}`,
        // "Always allow" or a read-only tool: LOW. Otherwise the agent asks.
        risk: () => ({ risk: readOnly || configs.find((c) => c.id === cfg.id)?.trust === 'always' ? 'LOW' : 'MEDIUM' }),
        parameters: cleanSchema(t.inputSchema),
        mcp: { serverId: cfg.id, tool: t.name, readOnly },
        async run(args, ctx) {
          const l = live.get(cfg.id);
          if (!l || l.state !== 'ready') {
            throw Object.assign(new Error(`「${cfg.name}」现在没连上${l?.error ? `（${l.error}）` : ''}`), { code: 'MCP_NOT_CONNECTED' });
          }
          let res;
          try {
            res = await l.client.callTool(t.name, args);
          } catch (err) {
            // The sign-in ran out mid-session: renew it in the background.
            if (l.cfg.oauth && (err.status === 401 || err.status === 403)) {
              start(l.cfg).catch(() => {});
              throw Object.assign(new Error(`「${cfg.name}」的登录刚过期，正在续期，等几秒再试一次`), { code: 'MCP_REAUTH' });
            }
            throw err;
          }
          const out = await toolResultForBot(res, { workspaceDir: ctx?.workspaceDir || workspaceDir, serverId: cfg.id });
          if (res?.isError) throw Object.assign(new Error(out.text || `${t.name} failed`), { code: 'MCP_TOOL_ERROR' });
          return out;
        },
      });
    }
  }

  async function start(cfg) {
    stop(cfg.id);
    if (cfg.enabled === false) return;
    const l = { cfg, state: 'connecting', error: '', tools: [], retries: live.get(cfg.id)?.retries || 0, client: null, timer: null };
    live.set(cfg.id, l);
    emit({ type: 'mcp.changed', id: cfg.id });
    if (cfg.oauth && !cfg.secretRef) {
      l.state = 'needs_auth';
      l.error = '还没授权：点「连接」去那个应用的页面登录';
      emit({ type: 'mcp.changed', id: cfg.id });
      return;
    }
    // An access token about to run out: renew it before connecting.
    if (cfg.oauth?.expiresAt && cfg.oauth.expiresAt < Date.now() + 120000) await refreshOAuth(cfg);
    try {
      await connectOnce(cfg, l);
    } catch (err) {
      if (live.get(cfg.id) !== l) return;
      try { l.client?.close(); } catch { /* fine */ }
      // Signed out on the app's side: renew once; if that fails, the human signs in again.
      if (cfg.oauth && (err.status === 401 || err.status === 403)) {
        if (!l.refreshed && await refreshOAuth(cfg)) {
          l.refreshed = true;
          try { await connectOnce(cfg, l); emit({ type: 'mcp.changed', id: cfg.id }); return; } catch (again) { err = again; }
        }
        l.state = 'needs_auth';
        l.error = '登录过期了：点「重新授权」再登录一次';
        emit({ type: 'mcp.changed', id: cfg.id });
        return;
      }
      l.state = 'failed';
      l.error = err.message;
      retry(cfg.id);
    }
    emit({ type: 'mcp.changed', id: cfg.id });
  }

  async function connectOnce(cfg, l) {
    {
      l.client = makeClient(cfg, {
        secrets: await secretsFor(cfg), workspaceDir, clientVersion: version,
        onNotify: (ev) => {
          if (ev.type === 'notification' && ev.method === 'notifications/tools/list_changed') refreshTools(cfg.id).catch(() => {});
          if (ev.type === 'closed' && live.get(cfg.id) === l && l.state !== 'stopped') { l.state = 'failed'; l.error = ev.error; unregister(cfg.id); emit({ type: 'mcp.changed', id: cfg.id }); retry(cfg.id); }
        },
      });
      await l.client.connect();
      l.tools = await l.client.listTools();
      if (live.get(cfg.id) !== l) return;
      register(cfg, l.tools);
      l.state = 'ready';
      l.error = '';
      l.retries = 0;
    }
  }

  function retry(id) {
    const l = live.get(id);
    if (!l || l.timer || l.retries >= MAX_RETRIES) return;
    const delay = Math.min(60000, 2000 * 2 ** l.retries);
    l.retries += 1;
    l.timer = setTimeout(() => { l.timer = null; if (live.get(id) === l) start(l.cfg).catch(() => {}); }, delay);
    l.timer.unref?.();
  }

  async function refreshTools(id) {
    const l = live.get(id);
    if (!l || l.state !== 'ready') return;
    l.tools = await l.client.listTools();
    register(l.cfg, l.tools);
    emit({ type: 'mcp.changed', id });
  }

  function stop(id) {
    const l = live.get(id);
    if (!l) return;
    l.state = 'stopped';
    if (l.timer) clearTimeout(l.timer);
    try { l.client?.close(); } catch { /* fine */ }
    unregister(id);
    live.delete(id);
  }

  function clean(input, old = {}) {
    const wanted = input.transport ?? old.transport;
    const urlIn = String(input.url ?? old.url ?? '');
    // A web address ending in /sse is the older HTTP+SSE form (百度网盘 and others).
    const transport = wanted === 'internal' ? 'internal' : wanted === 'sse' || (wanted === 'http' && /\/sse\/?(\?|$)/i.test(urlIn)) ? 'sse' : wanted === 'http' ? 'http' : 'stdio';
    const web = transport === 'http' || transport === 'sse';
    const strMap = (o) => Object.fromEntries(Object.entries(o && typeof o === 'object' ? o : {}).map(([k, v]) => [String(k).trim(), String(v ?? '')]).filter(([k]) => k).slice(0, 30));
    const cfg = {
      ...old,
      name: String(input.name ?? old.name ?? '').trim().slice(0, 40) || 'MCP',
      transport,
      command: transport === 'stdio' ? String(input.command ?? old.command ?? '').trim().slice(0, 300) : '',
      args: transport === 'stdio' ? (Array.isArray(input.args) ? input.args : old.args || []).map(String).slice(0, 40) : [],
      env: transport === 'stdio' || transport === 'internal' ? strMap(input.env ?? old.env) : {},
      module: transport === 'internal' ? String(input.module ?? old.module ?? '').slice(0, 40) : '',
      url: web ? urlIn.trim().slice(0, 500) : '',
      headers: web ? strMap(input.headers ?? old.headers) : {},
      enabled: input.enabled !== undefined ? Boolean(input.enabled) : old.enabled !== false,
      trust: (input.trust ?? old.trust) === 'always' ? 'always' : 'ask',
      bots: Array.isArray(input.bots) ? input.bots.map(String).slice(0, 50) : (input.bots === 'all' ? 'all' : old.bots || 'all'),
    };
    if (transport === 'stdio' && !cfg.command) throw Object.assign(new Error('填一下要运行的命令'), { status: 400, code: 'MCP_NO_COMMAND' });
    if (web && !/^https?:\/\//i.test(cfg.url)) throw Object.assign(new Error('网址要以 http:// 或 https:// 开头'), { status: 400, code: 'MCP_BAD_URL' });
    return cfg;
  }

  // A short id: it is part of every tool name (mcp__<id>__<tool>, at most 64).
  async function freshId() {
    let id;
    do { id = `m${crypto.randomBytes(4).toString('hex').slice(0, 5)}`; } while (configs.some((c) => c.id === id));
    return id;
  }

  /** Fields only the catalog sets: which entry it came from, where Feishu keys come from. */
  function keep(input) {
    const out = {};
    if (input.catalogId && catalog.some((e) => e.id === input.catalogId)) out.catalogId = input.catalogId;
    if (input.secretSource !== undefined) out.secretSource = input.secretSource === 'feishu' ? 'feishu' : '';
    if (Array.isArray(input.mailboxes)) out.mailboxes = input.mailboxes.map(String).slice(0, 20);
    return out;
  }

  /** Secret values go to the vault; only its id stays in the config. */
  async function storeSecrets(cfg, values) {
    const pairs = Object.entries(values && typeof values === 'object' ? values : {}).filter(([, v]) => String(v ?? '') !== '');
    if (!pairs.length) return;
    const entry = await putVault({ id: cfg.secretRef || null, name: `MCP · ${cfg.name}`, values: Object.fromEntries(pairs) });
    cfg.secretRef = entry.id;
  }

  const api = {
    presets: () => MCP_PRESETS,
    async load() {
      const raw = await readJson(FILE(), []);
      configs = Array.isArray(raw) ? raw.filter((c) => c && c.id) : [];
      // The vault entry may have been deleted by hand: forget the reference.
      if (configs.some((c) => c.secretRef)) {
        const ids = new Set((await listVault().catch(() => [])).map((e) => e.id));
        for (const c of configs) if (c.secretRef && !ids.has(c.secretRef)) delete c.secretRef;
      }
      // Added by hand before the catalog had it (the same package or address):
      // it becomes that catalog app, so the list shows it once, as 「已连接」.
      let adopted = false;
      for (const c of configs) {
        if (c.catalogId) continue;
        const e = catalog.find((x) => catalogKey(x) && catalogKey(x) === catalogKey(c) && !configs.some((o) => o.catalogId === x.id));
        if (e) { c.catalogId = e.id; adopted = true; }
      }
      if (adopted) await save();
      return configs;
    },
    async startAll() {
      await Promise.all(configs.filter((c) => c.enabled !== false).map((c) => start(c).catch(() => {})));
    },
    list() {
      return configs.map(publicCfg);
    },
    async add(input) {
      const cfg = { id: await freshId(), ...clean(input), ...keep(input) };
      await storeSecrets(cfg, input.secrets);
      configs.push(cfg);
      await save();
      start(cfg).catch(() => {});
      return publicCfg(cfg);
    },
    async update(id, input) {
      const i = configs.findIndex((c) => c.id === id);
      if (i < 0) throw Object.assign(new Error('没有这个连接'), { status: 404, code: 'MCP_NOT_FOUND' });
      const old = configs[i];
      const cfg = { ...clean(input, old), id, ...keep(input) };
      if (cfg.secretSource === 'feishu' && cfg.secretRef) { await deleteVault(cfg.secretRef).catch(() => {}); delete cfg.secretRef; }
      await storeSecrets(cfg, input.secrets);
      // Only who may use it / whether to ask changed: no need to reconnect.
      const how = (c) => JSON.stringify([c.transport, c.command, c.args, c.env, c.url, c.headers, c.enabled, c.secretRef, c.secretSource, c.name]);
      const reconnect = how(cfg) !== how(old) || Object.values(input.secrets || {}).some((v) => String(v ?? '') !== '');
      configs[i] = cfg;
      await save();
      if (cfg.enabled === false) stop(id);
      else if (reconnect || !live.has(id)) start(cfg).catch(() => {});
      else if (live.get(id)) live.get(id).cfg = cfg;
      emit({ type: 'mcp.changed', id });
      return publicCfg(cfg);
    },
    async remove(id) {
      const cfg = configs.find((c) => c.id === id);
      if (!cfg) throw Object.assign(new Error('没有这个连接'), { status: 404, code: 'MCP_NOT_FOUND' });
      stop(id);
      configs = configs.filter((c) => c.id !== id);
      await save();
      if (cfg.secretRef) await deleteVault(cfg.secretRef).catch(() => {});
      emit({ type: 'mcp.changed', id });
      return { ok: true };
    },
    /** Connect once from scratch and list the tools; the answer says what happened. */
    async test(id) {
      const cfg = configs.find((c) => c.id === id);
      if (!cfg) throw Object.assign(new Error('没有这个连接'), { status: 404, code: 'MCP_NOT_FOUND' });
      const l = live.get(id);
      if (l) l.retries = 0;
      await start({ ...cfg, enabled: true });
      return publicCfg(cfg);
    },
    /** The catalog with what is connected: [{...entry, serverId, state, tools}] */
    catalog() {
      return catalog.map((e) => {
        const cfg = configs.find((c) => c.catalogId === e.id);
        const pub = cfg ? publicCfg(cfg) : null;
        return {
          id: e.id, name: e.name, category: e.category, badge: e.badge, color: e.color, desc: e.desc,
          auth: e.auth, help: e.help, tokenUrl: e.tokenUrl || '', tokenLabel: e.tokenLabel || '',
          server: pub,
        };
      });
    },

    /**
     * 「连接」 in the catalog. -> {server} when connected (or connecting), or
     * {authorizeUrl, server} for an OAuth app: the page opens that URL.
     * `origin` is where this hub's page was opened (the callback comes back there).
     */
    async connectCatalog(catalogId, { origin = '', relay = '', token = '', appId = '', appSecret = '', fields = null } = {}) {
      const e = catalog.find((x) => x.id === catalogId);
      if (!e) throw Object.assign(new Error('目录里没有这个应用'), { status: 404, code: 'MCP_NOT_IN_CATALOG' });
      let cfg = configs.find((c) => c.catalogId === e.id);
      const base = { name: e.name, transport: e.transport, command: e.command, args: e.args, env: e.env, url: e.url, headers: e.headers, module: e.module };
      if (e.auth === 'mail') {
        // Several mailboxes in one connection: MAILBOXES (a JSON list) in the vault,
        // only the addresses in the config (for the list in Settings).
        const f = fields && typeof fields === 'object' ? fields : {};
        const mail = await import('./mail.mjs');
        let boxes = cfg?.secretRef ? mail.mailboxesFrom(await secretsFor(cfg)) : [];
        if (f.MAILBOXES) {
          // From another machine of the human's: the whole list, as it is there.
          boxes = mail.mailboxesFrom({ MAILBOXES: String(f.MAILBOXES) });
        } else {
          const typed = { EMAIL: String(f.EMAIL || '').trim(), PASS: String(f.PASS || '').replace(/\s+/g, ''), IMAP: String(f.IMAP || '').trim(), SMTP: String(f.SMTP || '').trim() };
          if (typed.EMAIL) {
            // Checked before anything is saved: a wrong address, an unknown mailbox
            // or a wrong code says so at once, and the mailboxes already there stay.
            mail.resolveAccount({ email: typed.EMAIL, pass: typed.PASS, imap: typed.IMAP, smtp: typed.SMTP });
            const probe = await (checkMailbox || mail.checkMailbox)(typed);
            if (!probe.ok) throw Object.assign(new Error(probe.message), { status: 400, code: 'MAIL_AUTH' });
            boxes = [...boxes.filter((b) => b.EMAIL.toLowerCase() !== typed.EMAIL.toLowerCase()), typed];
          }
        }
        if (!boxes.length) throw Object.assign(new Error('先填邮箱地址和授权码'), { status: 400, code: 'MAIL_NO_ACCOUNT' });
        const input = { ...base, enabled: true, secrets: { MAILBOXES: JSON.stringify(boxes) }, mailboxes: boxes.map((b) => b.EMAIL) };
        const server = cfg ? await api.update(cfg.id, input) : await api.add({ ...input, catalogId: e.id });
        return { server };
      }
      if (e.auth === 'token') {
        if (!String(token).trim() && !cfg?.secretRef) throw Object.assign(new Error('先把 token 贴进来'), { status: 400, code: 'MCP_TOKEN_NEEDED' });
        const secrets = String(token).trim() ? { [e.secret]: String(token).trim() } : undefined;
        const server = cfg ? await api.update(cfg.id, { ...base, enabled: true, secrets }) : await api.add({ ...base, secrets, catalogId: e.id });
        return { server };
      }
      if (e.auth === 'feishu') {
        const f = await readFeishu().catch(() => null);
        const typed = String(appId).trim() && String(appSecret).trim();
        if (!typed && !(f?.appId && f?.appSecret)) {
          throw Object.assign(new Error('还没有飞书应用：先在「设置 → 飞书」里填 App ID 和 App Secret，或者在这里直接填'), { status: 400, code: 'MCP_FEISHU_NEEDED' });
        }
        const extra = typed ? { secrets: { APP_ID: String(appId).trim(), APP_SECRET: String(appSecret).trim() }, secretSource: '' } : { secretSource: 'feishu' };
        const server = cfg ? await api.update(cfg.id, { ...base, enabled: true, ...extra }) : await api.add({ ...base, ...extra, catalogId: e.id });
        return { server };
      }
      if (e.auth === 'none') {
        const server = cfg ? await api.update(cfg.id, { ...base, enabled: true }) : await api.add({ ...base, catalogId: e.id });
        return { server };
      }
      // OAuth: register this hub with the app and hand back its sign-in page.
      if (!/^https?:\/\/[^/]+$/i.test(String(origin)) && !LOOPBACK.test(String(relay))) throw Object.assign(new Error('缺少页面地址（origin）'), { status: 400, code: 'MCP_ORIGIN_NEEDED' });
      const back = callbackBase(origin, relay, publicUrl());
      if (!back) {
        throw Object.assign(new Error(`「${e.name}」只接受 https 或本机地址的登录回跳，这台机器现在是 ${origin}。在电脑上的长明里连接（会同步到这台机器），或者在「手机和外网」里打开这台机器的外网访问再试。`), { status: 400, code: 'MCP_NEEDS_HTTPS' });
      }
      const redirectUri = `${back}/api/mcp/oauth/callback`;
      const found = await discoverOAuth(e.url, { fetchImpl, clientVersion: version });
      const client = await registerClient(found.meta, redirectUri, { fetchImpl });
      if (!cfg) {
        cfg = { id: await freshId(), ...clean({ ...base, enabled: true }), catalogId: e.id };
        configs.push(cfg);
      }
      cfg.oauth = { ...(cfg.oauth || {}), pending: true };
      await save();
      const { verifier, challenge } = pkcePair();
      const state = crypto.randomBytes(24).toString('base64url');
      for (const [k, v] of pendingAuth) if (v.at < Date.now() - 600000) pendingAuth.delete(k);
      pendingAuth.set(state, {
        id: cfg.id, at: Date.now(), verifier, redirectUri, resource: found.resource,
        clientId: client.client_id, clientSecret: client.client_secret, tokenEndpoint: found.meta.token_endpoint,
      });
      emit({ type: 'mcp.changed', id: cfg.id });
      return {
        authorizeUrl: authorizeUrl({ meta: found.meta, clientId: client.client_id, redirectUri, challenge, state, resource: found.resource, scopes: found.scopes }),
        server: publicCfg(cfg),
      };
    },

    /** Take one mailbox out of the 邮箱 connection; the last one out disconnects it. -> {server} or {removed:true} */
    async removeMailbox(address) {
      const cfg = configs.find((c) => c.catalogId === 'email');
      if (!cfg) throw Object.assign(new Error('还没有连邮箱'), { status: 404, code: 'MAIL_NO_ACCOUNT' });
      const { mailboxesFrom } = await import('./mail.mjs');
      const all = mailboxesFrom(await secretsFor(cfg));
      const left = all.filter((b) => b.EMAIL.toLowerCase() !== String(address || '').trim().toLowerCase());
      if (left.length === all.length) throw Object.assign(new Error(`没有连「${address}」`), { status: 404, code: 'MAIL_NOT_FOUND' });
      if (!left.length) { await api.remove(cfg.id); return { removed: true }; }
      const server = await api.update(cfg.id, { ...publicInput(cfg), secrets: { MAILBOXES: JSON.stringify(left) }, mailboxes: left.map((b) => b.EMAIL) });
      return { server };
    },

    /** Is this sign-in one this hub started? (Otherwise the callback is passed on to the other machines.) */
    hasPending(state) {
      const p = pendingAuth.get(String(state || ''));
      return Boolean(p && p.at >= Date.now() - 600000);
    },

    /**
     * What another machine needs to connect the same catalog app:
     * {catalogId, auth, token?|appId?,appSecret?} or null when it is not connected here.
     * OAuth apps carry nothing: each machine signs in for itself (refresh tokens
     * are used once, so two machines cannot share one).
     */
    async syncPayload(catalogId) {
      const e = catalog.find((x) => x.id === catalogId);
      const cfg = e && configs.find((c) => c.catalogId === e.id);
      if (!cfg) return null;
      if (e.auth === 'token') {
        const token = await vaultValue(cfg, e.secret);
        return token ? { catalogId: e.id, auth: e.auth, token } : null;
      }
      if (e.auth === 'mail') {
        const { mailboxesFrom } = await import('./mail.mjs');
        const boxes = mailboxesFrom(await secretsFor(cfg));
        return boxes.length ? { catalogId: e.id, auth: e.auth, fields: { MAILBOXES: JSON.stringify(boxes) } } : null;
      }
      if (e.auth === 'feishu') {
        const s = await secretsFor(cfg);
        return s.APP_ID && s.APP_SECRET ? { catalogId: e.id, auth: e.auth, appId: s.APP_ID, appSecret: s.APP_SECRET } : null;
      }
      return { catalogId: e.id, auth: e.auth };
    },

    /** The app sent the browser back. -> {ok, name} or {ok:false, message} */
    async oauthCallback({ state, code, error, error_description: errorDescription }) {
      const p = pendingAuth.get(String(state || ''));
      if (!p || p.at < Date.now() - 600000) return { ok: false, message: '这次授权已经过期或无效，回到长明再点一次「连接」。' };
      pendingAuth.delete(String(state));
      const cfg = configs.find((c) => c.id === p.id);
      if (!cfg) return { ok: false, message: '这个连接已经被删掉了。' };
      if (error || !code) return { ok: false, name: cfg.name, message: `没有授权（${errorDescription || error || '没有收到授权码'}）。` };
      try {
        const tok = await exchangeCode({
          tokenEndpoint: p.tokenEndpoint, code, redirectUri: p.redirectUri, clientId: p.clientId,
          clientSecret: p.clientSecret, verifier: p.verifier, resource: p.resource,
        }, { fetchImpl });
        const entry = await putVault({
          id: cfg.secretRef || null, name: `MCP · ${cfg.name}`,
          values: { ACCESS_TOKEN: tok.accessToken, ...(tok.refreshToken ? { REFRESH_TOKEN: tok.refreshToken } : {}), ...(p.clientSecret ? { CLIENT_SECRET: p.clientSecret } : {}) },
        });
        cfg.secretRef = entry.id;
        cfg.headers = { Authorization: 'Bearer ${ACCESS_TOKEN}' };
        cfg.oauth = { clientId: p.clientId, tokenEndpoint: p.tokenEndpoint, resource: p.resource, expiresAt: tok.expiresAt, redirectUri: p.redirectUri };
        cfg.enabled = true;
        await save();
        start(cfg).catch(() => {});
        return { ok: true, name: cfg.name };
      } catch (err) {
        return { ok: false, name: cfg.name, message: err.message };
      }
    },

    /** May this bot use the MCP tool `name`? */
    allowed(bot, name) {
      const t = registry.tools.get(name);
      if (!t?.mcp) return false;
      const cfg = configs.find((c) => c.id === t.mcp.serverId);
      if (!cfg || cfg.enabled === false) return false;
      return cfg.bots === 'all' || (Array.isArray(cfg.bots) && cfg.bots.includes(bot?.id));
    },
    /** 'always' | 'ask' for the server behind an MCP tool. */
    trustFor(name) {
      const t = registry.tools.get(name);
      const cfg = t?.mcp && configs.find((c) => c.id === t.mcp.serverId);
      return { trust: cfg?.trust === 'always' ? 'always' : 'ask', readOnly: Boolean(t?.mcp?.readOnly), server: cfg?.name || '', tool: t?.mcp?.tool || name };
    },
    stopAll() {
      for (const id of [...live.keys()]) stop(id);
    },
    _live: live,
  };
  return api;
}
