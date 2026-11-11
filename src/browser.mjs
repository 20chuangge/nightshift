/**
 * browser.mjs - real browser automation over CDP, with a persistent browser.
 *
 * The product story: the assistant runs on another machine (an idle PC or a
 * cloud VM). The user watches from their laptop/phone while the bot actually
 * drives a browser there - opens pages, clicks, types into forms, downloads a
 * file. That means a *long-lived* Chromium process with a *persistent profile*
 * (the "signed-in browser" the product sells), driven over the DevTools
 * protocol, not a throwaway headless tab per call.
 *
 * Zero dependencies: Node >= 22 ships a global WebSocket, which is all CDP needs.
 * On an older Node every tool returns a structured {code:'unsupported'} answer
 * instead of throwing.
 *
 * Why the page-level websocket and not Target.attachToTarget: one page, one
 * socket, no session ids to juggle. The browser-level socket is opened only for
 * the few Browser.* domains (downloads, close).
 *
 * Everything here returns plain objects. Infrastructure problems (no browser,
 * unsupported Node, launch failure) come back as
 *   { ok:false, error:{ code, message }, hint? }
 * so a tool call can never crash a turn.
 */

import fs from 'node:fs';
import fsp from 'node:fs/promises';
import path from 'node:path';
import net from 'node:net';
import os from 'node:os';
import { spawn, execFile } from 'node:child_process';

import { P } from './store.mjs';
import { MiniWebSocket } from './ws-client.mjs';

// ---------------------------------------------------------------------------
// small utilities
// ---------------------------------------------------------------------------

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

function errorResult(code, message, extra = {}) {
  return { ok: false, error: { code, message }, ...extra };
}

function stamp() {
  return new Date().toISOString().replace(/[:.]/g, '-');
}

/** Keep the workspace as the only place artifacts can land. */
function resolveInWorkspace(workspaceDir, relative) {
  const abs = path.resolve(workspaceDir, relative);
  const root = workspaceDir.endsWith(path.sep) ? workspaceDir : workspaceDir + path.sep;
  const inside = abs === workspaceDir || abs.startsWith(root);
  return { abs, inside, rel: path.relative(workspaceDir, abs).split(path.sep).join('/') };
}

function isHttpUrl(value) {
  try {
    const u = new URL(String(value));
    return u.protocol === 'http:' || u.protocol === 'https:';
  } catch {
    return false;
  }
}

/**
 * Move a downloaded file into place. Windows keeps a handle on a file for a
 * moment after Chrome finishes writing it, so a plain rename can throw EBUSY;
 * retry, then fall back to copy + best-effort delete.
 */
async function moveFileWithRetry(source, dest, { attempts = 6 } = {}) {
  for (let attempt = 0; attempt < attempts; attempt += 1) {
    try {
      await fsp.rename(source, dest);
      return;
    } catch (err) {
      const recoverable = ['EXDEV', 'EPERM', 'EBUSY', 'EACCES'].includes(err.code);
      if (!recoverable) throw err;
      try {
        await fsp.copyFile(source, dest);
        await fsp.rm(source, { force: true }).catch(() => {});
        return;
      } catch {
        /* still locked: back off and retry */
      }
      await sleep(150 * (attempt + 1));
    }
  }
  await fsp.copyFile(source, dest);
}

// ---------------------------------------------------------------------------
// discovery: which Chromium do we drive?
// ---------------------------------------------------------------------------

/**
 * Detection order (as specified):
 *   1. CHROME_PATH override (must exist, else a clear not_configured)
 *   2. C:\Program Files\Google\Chrome\Application\chrome.exe
 *   3. C:\Program Files (x86)\Microsoft\Edge\Application\msedge.exe
 *   4. %LOCALAPPDATA%\Google\Chrome\Application\chrome.exe
 * then the usual Linux/macOS locations, so the same build runs on a VM.
 */
export function browserCandidates() {
  const list = [];
  if (process.platform === 'win32') {
    list.push('C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe');
    list.push('C:\\Program Files (x86)\\Microsoft\\Edge\\Application\\msedge.exe');
    if (process.env.LOCALAPPDATA) {
      list.push(path.join(process.env.LOCALAPPDATA, 'Google', 'Chrome', 'Application', 'chrome.exe'));
    }
    if (process.env['ProgramFiles(x86)']) {
      list.push(path.join(process.env['ProgramFiles(x86)'], 'Google', 'Chrome', 'Application', 'chrome.exe'));
    }
  }
  // Linux / macOS (the cloud-VM half of the product)
  list.push(
    '/usr/bin/google-chrome',
    '/usr/bin/google-chrome-stable',
    '/usr/bin/chromium',
    '/usr/bin/chromium-browser',
    '/usr/bin/microsoft-edge',
    '/snap/bin/chromium',
    '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome',
    '/Applications/Microsoft Edge.app/Contents/MacOS/Microsoft Edge',
  );
  return list;
}

/**
 * @returns {{path: string|null, source: string, checked: string[], skipped?: string}}
 */
export function detectBrowserExecutable() {
  const override = (process.env.CHROME_PATH || '').trim();
  if (override) {
    if (fs.existsSync(override)) {
      return { path: override, source: 'CHROME_PATH', checked: [override] };
    }
    return {
      path: null,
      source: 'CHROME_PATH',
      checked: [override],
      skipped: `CHROME_PATH points at ${override}, which does not exist`,
    };
  }
  const candidates = browserCandidates();
  for (const candidate of candidates) {
    try {
      if (fs.existsSync(candidate)) return { path: candidate, source: 'auto-detect', checked: candidates };
    } catch {
      /* unreadable path: keep looking */
    }
  }
  return { path: null, source: 'auto-detect', checked: candidates };
}

/** CDP needs a WebSocket. Node >= 22 has one built in; older runtimes (notably
 *  the Electron-bundled Node 20 that the desktop shell spawns) get the small
 *  RFC 6455 client in ws-client.mjs instead. */
export function browserSupport() {
  const major = Number(String(process.versions.node).split('.')[0]);
  if (!Number.isFinite(major) || major < 18) {
    return {
      supported: false,
      reason: `this is Node ${process.versions.node}; the browser driver needs Node >= 18`,
    };
  }
  return { supported: true, transport: typeof globalThis.WebSocket === 'function' ? 'native' : 'shim' };
}

export function profileDir(key = '') {
  // One profile per bot: cookies and logins must not leak between bots that are
  // supposed to be separate assistants on separate desktops.
  if (!key) return path.join(P.dataDir, 'browser-profile');
  const safe = String(key).replace(/[^a-zA-Z0-9_-]/g, '');
  return path.join(P.dataDir, 'browser-profiles', safe || 'bot');
}

function stateFile() {
  return path.join(P.dataDir, 'browser-state.json');
}

function installHint() {
  return (
    'Install Google Chrome, or Microsoft Edge (both are Chromium based), or point CHROME_PATH at a chrome.exe/msedge/chromium binary. ' +
    'On a headless Linux VM also install xvfb, or set BROWSER_HEADLESS=1.'
  );
}

/**
 * Launch flags. Windowed by default because the whole point is that the user
 * *watches* the bot work; headless is opt-in via BROWSER_HEADLESS=1 (and the
 * only option on a VM without a display).
 */
// ---------------------------------------------------------------------------
// Windows remote machines: show the browser on the signed-in desktop
// ---------------------------------------------------------------------------
//
// A Windows machine's hub runs in session 0 (a scheduled task), where no window
// can be seen, so its browser used to be headless and the human could not take
// over a login. When someone is signed in at the console (what the takeover
// view shows) and it is the hub's own account, the browser is started in that
// interactive session through a one-off scheduled task (/IT needs no password
// for the task owner) and attached over its debugging port like any other.

let consoleUserCache = { at: 0, user: null };

/** "MACHINE\\user" signed in at the console, or null (cached 30 s). */
export async function windowsConsoleUser() {
  if (process.platform !== 'win32') return null;
  if (Date.now() - consoleUserCache.at < 30000) return consoleUserCache.user;
  const user = await new Promise((resolve) => {
    execFile('powershell.exe', ['-NoProfile', '-NonInteractive', '-Command', '(Get-CimInstance Win32_ComputerSystem).UserName'],
      // Slow, busy machines (a 1-core VM running Windows Update) need the time.
      { timeout: 60000, windowsHide: true }, (err, stdout) => resolve(err ? null : String(stdout || '').trim() || null));
  });
  consoleUserCache = { at: Date.now(), user };
  return user;
}

/** True when this process has no desktop of its own (Windows session 0). */
function inWindowsServiceSession() {
  return process.platform === 'win32' && !process.env.SESSIONNAME;
}

const sameAccount = (a, b) => String(a || '').split('\\').pop().toLowerCase() === String(b || '').split('\\').pop().toLowerCase();

/** Start the browser in the console user's session. Resolves true if the task ran. */
async function launchOnWindowsDesktop(exe, args, user) {
  const quote = (a) => (/[\s"]/.test(a) ? `"${a.replace(/"/g, '""')}"` : a);
  const script = path.join(P.dataDir, 'browser-desktop.cmd');
  await fsp.mkdir(P.dataDir, { recursive: true });
  // A .cmd file keeps the task's command line short (schtasks /TR is limited).
  await fsp.writeFile(script, `@echo off\r\nstart "" ${[exe, ...args].map(quote).join(' ')}\r\n`, 'utf8');
  const run = (cmdArgs) => new Promise((resolve) => {
    execFile('schtasks.exe', cmdArgs, { timeout: 20000, windowsHide: true }, (err, stdout, stderr) => resolve({ ok: !err, out: String(stdout || stderr || '') }));
  });
  const made = await run(['/Create', '/F', '/TN', 'NightshiftBrowser', '/SC', 'ONCE', '/ST', '00:00', '/IT', '/RU', user, '/TR', `"${script}"`]);
  if (!made.ok) return false;
  const started = await run(['/Run', '/TN', 'NightshiftBrowser']);
  return started.ok;
}

export function buildLaunchArgs({ port, profileDir: profile, headless = false, wayland = false, extraArgs = [] } = {}) {
  const args = [
    `--remote-debugging-port=${port}`,
    `--user-data-dir=${profile}`,
    '--no-first-run',
    '--no-default-browser-check',
    // Without this, navigator.webdriver is true and many sites serve a captcha.
    '--disable-blink-features=AutomationControlled',
    // Containers have a tiny /dev/shm; harmless elsewhere.
    '--disable-dev-shm-usage',
    '--no-service-autorun',
    // The bot's browser must not sign itself in with the Windows account (Edge
    // does that by default) or sync that account's passwords and history.
    '--disable-sync',
    '--disable-features=Translate,MediaRouter,msImplicitSignin,msEdgeImplicitSignin,msSyncConsent',
    // Several bots' windows share one Windows desktop and cover each other; a
    // covered or minimised window must keep full speed for the bot driving it.
    '--disable-backgrounding-occluded-windows',
    '--disable-renderer-backgrounding',
    '--disable-background-timer-throttling',
    // The hub stops a bot's browser when it restarts or the desktop idles out;
    // Chromium then offers "restore pages?" on the bot's screen every time.
    '--hide-crash-restore-bubble',
  ];
  if (headless) args.push('--headless=new', '--disable-gpu', '--hide-scrollbars');
  // A visible window otherwise carries a yellow bar across the top: "you are
  // using an unsupported command-line flag" (for the AutomationControlled one
  // above). --test-type is what test drivers pass to suppress that bar.
  else args.push('--test-type');
  // A Wayland-only screen (cage on Rocky/RHEL 10): draw natively, full screen.
  if (!headless && wayland) args.push('--ozone-platform=wayland', '--start-maximized');
  args.push(...extraArgs, 'about:blank');
  return args;
}

// ---------------------------------------------------------------------------
// CDP transport
// ---------------------------------------------------------------------------

/**
 * One websocket, request/response by id, events by method name.
 * `closed` is the only state anyone outside checks.
 */
class CdpConnection {
  constructor(ws, label) {
    this.ws = ws;
    this.label = label;
    this.nextId = 1;
    this.pending = new Map();
    this.listeners = new Map();
    this.closed = false;

    ws.addEventListener('message', (event) => this.onMessage(event));
    ws.addEventListener('close', () => this.onClose());
    ws.addEventListener('error', () => this.onClose());
  }

  static async connect(wsUrl, { timeoutMs = 10000, label = 'cdp' } = {}) {
    // Native WebSocket when the runtime has it; the in-repo RFC 6455 client
    // otherwise (Electron's Node 20). ASSIST_WS_SHIM=1 forces the shim so the
    // test suite exercises it even on Node 24.
    const useShim = process.env.ASSIST_WS_SHIM === '1' || typeof globalThis.WebSocket !== 'function';
    const WSCtor = useShim ? MiniWebSocket : globalThis.WebSocket;
    const ws = new WSCtor(wsUrl);
    await new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        try {
          ws.close();
        } catch {
          /* ignore */
        }
        reject(Object.assign(new Error(`timed out connecting to ${label}`), { code: 'CDP_CONNECT_TIMEOUT' }));
      }, timeoutMs);
      ws.addEventListener('open', () => {
        clearTimeout(timer);
        resolve();
      });
      ws.addEventListener('error', () => {
        clearTimeout(timer);
        reject(Object.assign(new Error(`could not connect to ${label}`), { code: 'CDP_CONNECT_FAILED' }));
      });
    });
    return new CdpConnection(ws, label);
  }

  onMessage(event) {
    let msg;
    try {
      msg = JSON.parse(typeof event.data === 'string' ? event.data : String(event.data));
    } catch {
      return;
    }
    if (msg.id !== undefined) {
      const waiter = this.pending.get(msg.id);
      if (!waiter) return;
      this.pending.delete(msg.id);
      clearTimeout(waiter.timer);
      if (msg.error) waiter.reject(Object.assign(new Error(msg.error.message || 'CDP error'), { code: 'CDP_ERROR', cdp: msg.error }));
      else waiter.resolve(msg.result);
      return;
    }
    if (msg.method) {
      const handlers = this.listeners.get(msg.method);
      if (handlers) {
        for (const fn of handlers) {
          try {
            fn(msg.params || {});
          } catch {
            /* a listener must never break the socket */
          }
        }
      }
    }
  }

  onClose() {
    this.closed = true;
    for (const [, waiter] of this.pending) {
      clearTimeout(waiter.timer);
      waiter.reject(Object.assign(new Error('CDP connection closed'), { code: 'CDP_CLOSED' }));
    }
    this.pending.clear();
  }

  on(method, handler) {
    if (!this.listeners.has(method)) this.listeners.set(method, new Set());
    this.listeners.get(method).add(handler);
    return () => this.listeners.get(method)?.delete(handler);
  }

  send(method, params = {}, { timeoutMs = 30000 } = {}) {
    if (this.closed) {
      return Promise.reject(Object.assign(new Error(`CDP connection (${this.label}) is closed`), { code: 'CDP_CLOSED' }));
    }
    const id = this.nextId++;
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        this.pending.delete(id);
        reject(Object.assign(new Error(`${method} timed out after ${timeoutMs}ms`), { code: 'CDP_TIMEOUT' }));
      }, timeoutMs);
      this.pending.set(id, { resolve, reject, timer });
      try {
        this.ws.send(JSON.stringify({ id, method, params }));
      } catch (err) {
        clearTimeout(timer);
        this.pending.delete(id);
        reject(Object.assign(new Error(`could not send ${method}: ${err.message}`), { code: 'CDP_SEND_FAILED' }));
      }
    });
  }

  close() {
    this.closed = true;
    try {
      this.ws.close();
    } catch {
      /* ignore */
    }
  }
}

async function fetchJson(url, timeoutMs = 2000) {
  try {
    const res = await fetch(url, { signal: AbortSignal.timeout(timeoutMs) });
    if (!res.ok) return null;
    return await res.json();
  } catch {
    return null;
  }
}

async function waitForVersion(port, timeoutMs) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    const version = await fetchJson(`http://127.0.0.1:${port}/json/version`, 1200);
    if (version?.webSocketDebuggerUrl) return version;
    await sleep(200);
  }
  return null;
}

function findFreePort() {
  return new Promise((resolve, reject) => {
    const server = net.createServer();
    server.unref();
    server.on('error', reject);
    server.listen(0, '127.0.0.1', () => {
      const { port } = server.address();
      server.close(() => resolve(port));
    });
  });
}

// ---------------------------------------------------------------------------
// page-side expressions
// ---------------------------------------------------------------------------

/**
 * Snapshot: visible text (script/style pruned) + interactive elements with refs.
 *
 * Refs are indices into window.__assistRefs. The registry survives across
 * snapshots *within the same document*, so a ref taken earlier keeps working as
 * long as the element is still attached. After a navigation the registry is
 * gone, and every stale ref then returns a STALE_REF error that tells the model
 * to take a new snapshot - which is the behaviour we want.
 */
const SNAPSHOT_EXPRESSION = `(() => {
  const MAX_TEXT = 8000;
  const MAX_ELEMENTS = 200;

  const visible = (el) => {
    const style = getComputedStyle(el);
    if (style.display === 'none' || style.visibility === 'hidden' || style.opacity === '0') return false;
    const rect = el.getBoundingClientRect();
    return rect.width > 0 && rect.height > 0;
  };

  const clean = (s) => String(s || '').replace(/\\s+/g, ' ').trim().slice(0, 120);

  const readableName = (el) => {
    const aria = el.getAttribute('aria-label');
    if (aria) return clean(aria);
    if (el.tagName === 'INPUT' || el.tagName === 'TEXTAREA' || el.tagName === 'SELECT') {
      const label = el.labels && el.labels[0] ? el.labels[0].innerText : '';
      return clean(label || el.getAttribute('placeholder') || el.getAttribute('title') || el.value || el.name || '');
    }
    return clean(el.innerText || el.getAttribute('title') || el.value || el.getAttribute('alt') || el.name || '');
  };

  const roleOf = (el) => {
    const explicit = el.getAttribute('role');
    if (explicit) return explicit;
    const map = { A: 'link', BUTTON: 'button', INPUT: el.type === 'checkbox' ? 'checkbox' : el.type === 'radio' ? 'radio' : 'textbox',
                  TEXTAREA: 'textbox', SELECT: 'combobox', SUMMARY: 'disclosure', FORM: 'form' };
    if (map[el.tagName]) return map[el.tagName];
    if (el.isContentEditable) return 'textbox';
    return el.tagName.toLowerCase();
  };

  const SELECTOR = 'a[href],button,input,textarea,select,summary,[role="button"],[role="link"],[role="checkbox"],[role="tab"],[role="menuitem"],[contenteditable=""],[contenteditable="true"],[onclick]';

  if (!window.__assistRefs) window.__assistRefs = [];
  const refs = window.__assistRefs;

  const elements = [];
  for (const el of document.querySelectorAll(SELECTOR)) {
    if (!visible(el)) continue;
    let index = refs.indexOf(el);
    if (index === -1) {
      if (refs.length > 800) refs.length = 0;
      refs.push(el);
      index = refs.length - 1;
    }
    elements.push({
      ref: '@e' + (index + 1),
      tag: el.tagName.toLowerCase(),
      role: roleOf(el),
      name: readableName(el),
      visible: true,
      disabled: Boolean(el.disabled),
      type: el.getAttribute('type') || null,
    });
    if (elements.length >= MAX_ELEMENTS) break;
  }

  // Text: walk the live DOM, skipping code-bearing nodes and inserting newlines
  // at block boundaries. Cloning the body and reading innerText loses layout
  // information (a detached node has no CSS boxes), which glued headings to
  // paragraphs; this walker keeps the page readable.
  const BLOCK = new Set(['ADDRESS','ARTICLE','ASIDE','BLOCKQUOTE','BR','DD','DIV','DL','DT','FIELDSET','FIGCAPTION','FIGURE','FOOTER','FORM','H1','H2','H3','H4','H5','H6','HEADER','HR','LI','MAIN','NAV','OL','P','PRE','SECTION','TABLE','TBODY','TD','TFOOT','TH','THEAD','TR','UL']);
  const SKIP = new Set(['SCRIPT','STYLE','NOSCRIPT','TEMPLATE','SVG','IFRAME','CANVAS','OBJECT']);
  const chunks = [];
  let visited = 0;
  const walk = (node) => {
    for (const child of node.childNodes) {
      if (visited++ > 20000) return;
      if (child.nodeType === 3) { chunks.push(child.nodeValue); continue; }
      if (child.nodeType !== 1) continue;
      const tag = child.tagName;
      if (SKIP.has(tag)) continue;
      const isBlock = BLOCK.has(tag);
      if (isBlock) chunks.push('\\n');
      walk(child);
      if (isBlock) chunks.push('\\n');
    }
  };
  if (document.body) walk(document.body);
  const text = chunks.join('')
    .replace(/[ \\t\\u00a0]+/g, ' ')
    .replace(/ *\\n */g, '\\n')
    .replace(/\\n{3,}/g, '\\n\\n')
    .trim();

  return {
    title: document.title || '',
    url: location.href,
    text: text.slice(0, MAX_TEXT),
    textLength: text.length,
    textTruncated: text.length > MAX_TEXT,
    elements,
    elementCount: elements.length,
  };
})()`;

/** Build the page-side resolver for one {ref|selector} target. */
function resolveExpression({ ref, selector }) {
  const refJson = JSON.stringify(ref ?? null);
  const selJson = JSON.stringify(selector ?? null);
  return `(() => {
  const REF = ${refJson};
  const SEL = ${selJson};
  let el = null;
  if (REF) {
    const m = String(REF).match(/^@?e(\\d+)$/i);
    if (!m) return { ok: false, code: 'BAD_REF', message: 'refs look like "@e3"; got ' + REF };
    const refs = window.__assistRefs;
    if (!refs) return { ok: false, code: 'STALE_REF', message: 'this page has no snapshot registry (it navigated); run browser_snapshot again' };
    el = refs[Number(m[1]) - 1] || null;
    if (!el) return { ok: false, code: 'STALE_REF', message: 'unknown ref ' + REF + '; run browser_snapshot again' };
    if (!el.isConnected) return { ok: false, code: 'STALE_REF', message: 'the element for ' + REF + ' left the DOM (page changed); run browser_snapshot again' };
  } else if (SEL) {
    try { el = document.querySelector(SEL); } catch (e) { return { ok: false, code: 'BAD_SELECTOR', message: e.message }; }
    if (!el) return { ok: false, code: 'ELEMENT_NOT_FOUND', message: 'nothing matches selector ' + SEL };
  } else {
    return { ok: false, code: 'BAD_ARGS', message: 'pass ref or selector' };
  }
  el.scrollIntoView({ block: 'center', inline: 'center', behavior: 'instant' });
  const r = el.getBoundingClientRect();
  if (r.width === 0 && r.height === 0) return { ok: false, code: 'ELEMENT_NOT_VISIBLE', message: 'the element has no layout box (hidden or zero-sized)' };
  const name = (el.getAttribute('aria-label') || el.innerText || el.value || el.getAttribute('placeholder') || el.name || '').replace(/\\s+/g, ' ').trim().slice(0, 80);
  return { ok: true, x: Math.round(r.left + r.width / 2), y: Math.round(r.top + r.height / 2),
           tag: el.tagName.toLowerCase(), name, editable: !el.disabled && !el.readOnly,
           isContentEditable: Boolean(el.isContentEditable) };
})()`;
}

// ---------------------------------------------------------------------------
// the manager
// ---------------------------------------------------------------------------

/** The Chrome process this module started, if any (killed on process exit). */
let launchedChild = null;
let exitHookRegistered = false;

function ensureExitHook() {
  if (exitHookRegistered) return;
  exitHookRegistered = true;
  process.once('exit', () => {
    try {
      launchedChild?.kill();
    } catch {
      /* already gone */
    }
  });
}

class BrowserManager {
  /** @param {{key?: string}} [options] key scopes the profile dir (one per bot) */
  constructor({ key = '' } = {}) {
    /** Which bot owns this browser; '' is the shared/legacy instance. */
    this.key = key;
    /** @type {null | {port:number,pid:number,child:object|null,exe:string,headless:boolean,adopted:boolean,browser:CdpConnection,page:CdpConnection,inFlight:number,lastActivity:number,pageUrl:string}} */
    this.session = null;
    this.launching = null;
    this.inFlight = 0;
    this.lastActivity = 0;
  }  // --- session lifecycle ---------------------------------------------------

  async ensureSession() {
    if (this.session && this.session.page && !this.session.page.closed) return this.session;
    if (this.launching) return this.launching;

    this.launching = this._boot().finally(() => {
      this.launching = null;
    });
    return this.launching;
  }

  async _boot() {
    // A dead page socket means the browser went away (or crashed); drop it.
    if (this.session) await this.teardown({ keepBrowser: false, silent: true });

    const executable = detectBrowserExecutable();
    if (!executable.path) {
      // A fresh Linux machine installs Chromium in the background after setup.
      let setup = null;
      try { setup = JSON.parse(fs.readFileSync(path.join(P.dataDir, 'desktop-setup.json'), 'utf8')); } catch { /* none */ }
      if (setup?.state === 'running') {
        throw Object.assign(new Error(`这台机器的浏览器还在后台安装（${setup.detail || '准备中'}），通常再过几分钟就好；告诉用户稍后再试，先做不需要浏览器的事。`), { code: 'browser_installing' });
      }
      throw Object.assign(
        new Error(executable.skipped || `no Chromium-based browser found. ${installHint()}`),
        { code: 'not_configured', checked: executable.checked, hint: installHint() },
      );
    }
    const support = browserSupport();
    if (!support.supported) {
      throw Object.assign(new Error(`${support.reason}. Browser automation is unavailable on this runtime.`), {
        code: 'unsupported',
        hint: 'Use Node >= 22 (or the desktop app, which bundles a newer runtime).',
      });
    }

    // Reuse a browser we launched before a server restart. This is what makes
    // the profile "persistent" across restarts instead of launching a second
    // Chrome onto a locked profile directory.
    const adopted = await this.tryAdopt();
    if (adopted) {
      this.session = adopted;
      return adopted;
    }

    const port = await findFreePort();
    let headless = process.env.BROWSER_HEADLESS === '1';
    const profile = profileDir(this.key);
    await fsp.mkdir(profile, { recursive: true });

    // Windows hub in session 0 with someone signed in at the console: put the
    // window on that desktop so the human can see it and take over.
    let onDesktop = false;
    if (inWindowsServiceSession()) {
      const user = await windowsConsoleUser().catch(() => null);
      if (user && sameAccount(user, os.userInfo().username)) {
        const desktopArgs = buildLaunchArgs({ port, profileDir: profile, headless: false });
        if (await launchOnWindowsDesktop(executable.path, desktopArgs, user)) {
          // Edge took 141 s on a 1-core VM with the CPU at 100%; a normal
          // machine needs about 2 s.
          const version = await waitForVersion(port, 150000);
          if (version) {
            const browser = await CdpConnection.connect(version.webSocketDebuggerUrl, { label: 'browser (desktop)' });
            const page = await this.attachPage(browser, port);
            this.session = {
              port, pid: 0, child: null, exe: executable.path, headless: false, adopted: false,
              display: 'console', profile, key: this.key, browser, page, pageUrl: 'about:blank', onDesktop: true,
            };
            this.inFlight = 0;
            this.lastActivity = Date.now();
            await fsp.writeFile(stateFile(), JSON.stringify({ port, pid: 0, executable: executable.path, headless: false, onDesktop: true, startedAt: new Date().toISOString() }, null, 2), 'utf8');
            return this.session;
          }
        }
      }
      // Nobody signed in (or another account): stay invisible and say so.
      headless = true;
      onDesktop = false;
    }

    // On a Linux hub with per-bot desktops, the window must appear on THIS
    // bot's X display; otherwise every bot would paint on the same screen.
    let display = '';
    let wayland = null;
    if (!headless && process.platform === 'linux') {
      try {
        const { desktopEnv } = await import('./desktops.mjs');
        const env = desktopEnv(this.key) || {};
        display = env.DISPLAY || '';
        // Rocky/RHEL 10 screens are Wayland (cage): no X display at all.
        if (env.WAYLAND_DISPLAY) wayland = env;
      } catch { /* desktops unavailable: fall back to the inherited display */ }
    }

    const args = buildLaunchArgs({ port, profileDir: profile, headless, wayland: Boolean(wayland) });
    let launchEnv = process.env;
    if (wayland) {
      launchEnv = { ...process.env, ...wayland };
      delete launchEnv.DISPLAY;
      display = `wayland:${wayland.WAYLAND_DISPLAY}`;
    } else if (display) {
      launchEnv = { ...process.env, DISPLAY: display };
    }
    let stderr = '';
    const launch = () => {
      const c = spawn(executable.path, args, {
        stdio: ['ignore', 'ignore', 'pipe'],
        windowsHide: true,
        env: launchEnv,
      });
      c.stderr?.on('data', (chunk) => {
        stderr = `${stderr}${chunk.toString('utf8')}`.slice(-4000);
      });
      c.on('error', () => {});
      // If the server dies, do not leave a browser orphaned on the machine. One
      // hook for the whole process, so repeated launches cannot leak listeners.
      launchedChild = c;
      ensureExitHook();
      return c;
    };
    let child = launch();

    let version = await waitForVersion(port, inWindowsServiceSession() ? 120000 : 25000);
    if (version && wayland) {
      // Seen on Rocky 10: after the hub restarted, Chromium opened its debug
      // port and then crashed (SIGSEGV) on that compositor every time, until
      // the bot's screen was restarted. So: give it a moment; if it is gone,
      // restart the screen once and launch again.
      await new Promise((r) => setTimeout(r, 1500));
      if (child.exitCode !== null || child.signalCode) {
        try {
          const desk = await import('./desktops.mjs');
          desk.stopDesktop(this.key);
          await desk.ensureDesktop(this.key);
          Object.assign(launchEnv, desk.desktopEnv(this.key) || {});
        } catch { /* the relaunch below reports what is wrong */ }
        child = launch();
        version = await waitForVersion(port, 25000);
      }
    }
    if (!version) {
      try {
        child.kill();
      } catch {
        /* ignore */
      }
      const detail = stderr.trim().split('\n').slice(-3).join(' / ');
      throw Object.assign(
        new Error(
          `Chrome started but never opened a debugging port on 127.0.0.1:${port}. ` +
            `Its profile may already be in use by another window (${profile}).${detail ? ` Chrome said: ${detail}` : ''}`,
        ),
        { code: 'browser_launch_failed' },
      );
    }

    const browser = await CdpConnection.connect(version.webSocketDebuggerUrl, { label: 'browser' });
    const page = await this.attachPage(browser, port);

    this.session = {
      port,
      pid: child.pid ?? 0,
      child,
      exe: executable.path,
      headless,
      adopted: false,
      display,
      profile,
      key: this.key,
      browser,
      page,
      pageUrl: 'about:blank',
    };
    this.inFlight = 0;
    this.lastActivity = Date.now();

    await fsp.mkdir(P.dataDir, { recursive: true });
    await fsp.writeFile(
      stateFile(),
      JSON.stringify({ port, pid: child.pid ?? 0, executable: executable.path, headless, startedAt: new Date().toISOString() }, null, 2),
      'utf8',
    );

    return this.session;
  }

  /** Reconnect to a browser this installation started earlier. */
  async tryAdopt() {
    let state;
    try {
      state = JSON.parse(await fsp.readFile(stateFile(), 'utf8'));
    } catch {
      return null;
    }
    if (!state?.port) return null;
    const version = await waitForVersion(state.port, 1200);
    if (!version?.webSocketDebuggerUrl) return null;
    try {
      const browser = await CdpConnection.connect(version.webSocketDebuggerUrl, { label: 'browser (adopted)' });
      const page = await this.attachPage(browser, state.port);
      return {
        port: state.port,
        pid: state.pid ?? 0,
        child: null,
        exe: state.executable || detectBrowserExecutable().path || '',
        headless: Boolean(state.headless),
        adopted: true,
        onDesktop: Boolean(state.onDesktop),
        browser,
        page,
        pageUrl: 'about:blank',
      };
    } catch {
      return null;
    }
  }

  /**
   * Attach to the single page we drive. We keep exactly one page for the whole
   * process, so a turn can take a snapshot and then click the ref it found.
   */
  async attachPage(browser, port) {
    let targets = (await fetchJson(`http://127.0.0.1:${port}/json/list`, 3000)) || [];
    let pageTarget = targets.find((t) => t.type === 'page' && t.webSocketDebuggerUrl);

    if (!pageTarget) {
      const created = await browser.send('Target.createTarget', { url: 'about:blank' });
      const deadline = Date.now() + 5000;
      while (Date.now() < deadline) {
        targets = (await fetchJson(`http://127.0.0.1:${port}/json/list`, 1500)) || [];
        pageTarget = targets.find((t) => t.id === created.targetId) || targets.find((t) => t.type === 'page');
        if (pageTarget?.webSocketDebuggerUrl) break;
        await sleep(120);
      }
    }
    if (!pageTarget?.webSocketDebuggerUrl) {
      throw Object.assign(new Error('the browser has no page target to drive'), { code: 'CDP_NO_PAGE' });
    }

    const page = await CdpConnection.connect(pageTarget.webSocketDebuggerUrl, { label: 'page' });
    await page.send('Page.enable');
    await page.send('Runtime.enable');
    await page.send('Network.enable', { maxTotalBufferSize: 20000000 });

    // Network bookkeeping feeds waitForIdle().
    page.on('Network.requestWillBeSent', () => {
      this.inFlight += 1;
      this.lastActivity = Date.now();
    });
    page.on('Network.loadingFinished', () => {
      this.inFlight = Math.max(0, this.inFlight - 1);
      this.lastActivity = Date.now();
    });
    page.on('Network.loadingFailed', () => {
      this.inFlight = Math.max(0, this.inFlight - 1);
      this.lastActivity = Date.now();
    });
    return page;
  }

  async teardown({ keepBrowser = false, silent = false } = {}) {
    const session = this.session;
    this.session = null;
    if (!session) return;
    for (const conn of [session.page, session.browser]) {
      try {
        conn?.close();
      } catch {
        /* ignore */
      }
    }
    if (!keepBrowser) {
      if (session.child) {
        try {
          session.child.kill();
        } catch {
          /* ignore */
        }
      } else if (session.adopted) {
        // We did not launch it; do not kill a process we do not own unless the
        // caller explicitly asked to close (that path sends Browser.close).
        if (!silent) {
          /* leave it running */
        }
      }
      await fsp.rm(stateFile(), { force: true }).catch(() => {});
    }
  }

  // --- page helpers --------------------------------------------------------

  async evaluateRaw(expression, { timeoutMs = 20000 } = {}) {
    const page = await this.ensurePage();
    const result = await page.send(
      'Runtime.evaluate',
      { expression, returnByValue: true, awaitPromise: true, userGesture: true },
      { timeoutMs },
    );
    if (result.exceptionDetails) {
      const message =
        result.exceptionDetails.exception?.description ||
        result.exceptionDetails.exception?.value ||
        result.exceptionDetails.text ||
        'evaluation failed';
      return { ok: false, error: { code: 'EVAL_ERROR', message: String(message).slice(0, 500) } };
    }
    return { ok: true, value: result.result?.value ?? null, type: result.result?.type || 'undefined' };
  }

  async ensurePage() {
    const session = await this.ensureSession();
    if (!session.page || session.page.closed) {
      // Page socket died but the browser is alive: re-attach once.
      session.page = await this.attachPage(session.browser, session.port);
    }
    return session.page;
  }

  /**
   * Wait until the page has no in-flight requests for a moment, capped.
   * SPA sites keep long-polling connections open, so the cap matters.
   */
  async waitForIdle({ timeoutMs = 8000, quietMs = 250 } = {}) {
    const deadline = Date.now() + timeoutMs;
    while (Date.now() < deadline) {
      if (this.inFlight <= 0 && Date.now() - this.lastActivity >= quietMs) return true;
      await sleep(80);
    }
    return false;
  }

  async waitForReadyState({ timeoutMs = 8000 } = {}) {
    const deadline = Date.now() + timeoutMs;
    while (Date.now() < deadline) {
      const res = await this.evaluateRaw('document.readyState').catch(() => null);
      if (res?.ok && res.value === 'complete') return true;
      await sleep(120);
    }
    return false;
  }

  async currentLocation() {
    const res = await this.evaluateRaw('({ url: location.href, title: document.title })').catch(() => null);
    return res?.ok ? res.value : null;
  }

  async goto(url, { waitForLoad = true } = {}) {
    const page = await this.ensurePage();
    this.inFlight = 0;
    this.lastActivity = Date.now();
    let nav;
    try {
      nav = await page.send('Page.navigate', { url }, { timeoutMs: 30000 });
    } catch (err) {
      return { ok: false, error: { code: 'NAVIGATION_FAILED', message: err.message } };
    }
    if (nav?.errorText) {
      return { ok: false, error: { code: 'NAVIGATION_FAILED', message: `${nav.errorText} (${url})` } };
    }
    if (waitForLoad) {
      await this.waitForReadyState({ timeoutMs: 12000 });
      await this.waitForIdle({ timeoutMs: 8000 });
      // Give client-side routers one more frame to paint.
      await sleep(120);
    }
    const location = await this.currentLocation();
    return { ok: true, url: location?.url || url, title: location?.title || '', frameId: nav?.frameId || null };
  }

  async resolveTarget(args) {
    const ref = args?.ref;
    const selector = args?.selector;
    if (!ref && !selector) {
      return { ok: false, error: { code: 'BAD_ARGS', message: 'pass either ref ("@e3") or selector ("#submit")' } };
    }
    const res = await this.evaluateRaw(resolveExpression({ ref, selector }));
    if (!res.ok) return res;
    if (!res.value?.ok) {
      return { ok: false, error: { code: res.value?.code || 'ELEMENT_NOT_FOUND', message: res.value?.message || 'could not resolve the element' } };
    }
    return { ok: true, target: res.value };
  }

  // --- tool surface --------------------------------------------------------

  /**
   * browser_open: navigate and report title/url. Keeps the old contract
   * (title/url) and adds what a real session knows.
   */
  async open(args) {
    const url = String(args?.url || '');
    if (!isHttpUrl(url)) {
      return errorResult('BROWSER_BAD_URL', `browser_open needs an absolute http(s) URL; got "${url}"`);
    }
    if (isPrivateHostname(url) && process.env.ALLOW_PRIVATE !== '1') {
      return errorResult(
        'PRIVATE_HOST_BLOCKED',
        `${new URL(url).hostname} is a private or loopback address. Set ALLOW_PRIVATE=1 to allow LAN/local addresses.`,
      );
    }
    try {
      const session = await this.ensureSession();
      const nav = await this.goto(url);
      if (!nav.ok) return nav;
      session.pageUrl = nav.url;
      return {
        ok: true,
        title: nav.title,
        url: nav.url,
        browser: {
          executable: session.exe,
          pid: session.pid,
          headless: session.headless,
          adopted: session.adopted,
          profile: session.profile || profileDir(this.key),
          // Which machine/display this browser is actually painting on. Without
          // it a bot cannot tell the user whether it is on the hub or the laptop.
          host: process.env.HOSTNAME || os.hostname(),
          display: session.display || process.env.DISPLAY || (process.platform === 'win32' ? 'win32' : ''),
          botId: this.key || null,
        },
      };
    } catch (err) {
      return browserFailure(err);
    }
  }

  async snapshot() {
    try {
      await this.ensureSession();
      const res = await this.evaluateRaw(SNAPSHOT_EXPRESSION);
      if (!res.ok) return res;
      const page = res.value || {};
      return {
        ok: true,
        title: page.title || '',
        url: page.url || '',
        text: page.text || '',
        textLength: page.textLength ?? 0,
        textTruncated: Boolean(page.textTruncated),
        elements: Array.isArray(page.elements) ? page.elements : [],
        elementCount: page.elementCount ?? 0,
        hint: 'click/type accept a ref like "@e3"; take a new snapshot after the page changes.',
      };
    } catch (err) {
      return browserFailure(err);
    }
  }

  async click(args) {
    try {
      await this.ensureSession();
      const resolved = await this.resolveTarget(args);
      if (!resolved.ok) return resolved;
      const page = await this.ensurePage();
      const { x, y, tag, name } = resolved.target;

      // Real input events, not el.click(): sites that check isTrusted work.
      await page.send('Input.dispatchMouseEvent', { type: 'mouseMoved', x, y, button: 'none', buttons: 0 });
      await page.send('Input.dispatchMouseEvent', { type: 'mousePressed', x, y, button: 'left', buttons: 1, clickCount: 1 });
      await page.send('Input.dispatchMouseEvent', { type: 'mouseReleased', x, y, button: 'left', buttons: 0, clickCount: 1 });

      // A click can navigate or fetch; wait for the dust to settle but never
      // forever.
      await sleep(120);
      await this.waitForReadyState({ timeoutMs: 6000 });
      await this.waitForIdle({ timeoutMs: 6000 });
      const location = await this.currentLocation();

      return {
        ok: true,
        clicked: { tag, name, x, y },
        url: location?.url || '',
        title: location?.title || '',
      };
    } catch (err) {
      return browserFailure(err);
    }
  }

  async type(args) {
    const text = String(args?.text ?? '');
    if (!text) return errorResult('BAD_ARGS', 'browser_type needs a non-empty "text"');
    if (text.length > 5000) return errorResult('BAD_ARGS', 'browser_type is limited to 5000 characters');

    try {
      await this.ensureSession();
      const resolved = await this.resolveTarget(args);
      if (!resolved.ok) return resolved;
      const page = await this.ensurePage();
      const { x, y, tag, name } = resolved.target;

      // Focus through a real mouse click at the element centre, then clear and
      // insert. insertText is a single trusted-ish text input, which is what
      // modern frameworks listen for.
      await page.send('Input.dispatchMouseEvent', { type: 'mousePressed', x, y, button: 'left', buttons: 1, clickCount: 1 });
      await page.send('Input.dispatchMouseEvent', { type: 'mouseReleased', x, y, button: 'left', buttons: 0, clickCount: 1 });
      await this.evaluateRaw(`(() => {
        const el = document.activeElement;
        if (!el) return false;
        if ('value' in el) { el.value = ''; el.dispatchEvent(new Event('input', { bubbles: true })); return true; }
        if (el.isContentEditable) { el.textContent = ''; return true; }
        return false;
      })()`);

      await page.send('Input.insertText', { text });

      // Verify, and fall back to per-character key events if the field ignored
      // insertText (some custom editors do).
      let actual = await this.readFieldValue();
      if (actual !== text) {
        await this.evaluateRaw(`(() => {
          const el = document.activeElement;
          if (!el) return false;
          if ('value' in el) { el.value = ''; } else if (el.isContentEditable) { el.textContent = ''; }
          return true;
        })()`);
        for (const ch of text) {
          await page.send('Input.dispatchKeyEvent', { type: 'char', text: ch, unmodifiedText: ch });
        }
        actual = await this.readFieldValue();
      }

      let submitted = false;
      if (args?.submit) {
        await page.send('Input.dispatchKeyEvent', {
          type: 'keyDown', key: 'Enter', code: 'Enter', windowsVirtualKeyCode: 13, nativeVirtualKeyCode: 13,
        });
        await page.send('Input.dispatchKeyEvent', {
          type: 'keyUp', key: 'Enter', code: 'Enter', windowsVirtualKeyCode: 13, nativeVirtualKeyCode: 13,
        });
        submitted = true;
        await sleep(120);
        await this.waitForReadyState({ timeoutMs: 6000 });
        await this.waitForIdle({ timeoutMs: 6000 });
      }

      const location = await this.currentLocation();
      return {
        ok: true,
        typed: { tag, name, text },
        value: actual ?? '',
        matched: actual === text,
        submitted,
        url: location?.url || '',
      };
    } catch (err) {
      return browserFailure(err);
    }
  }

  async readFieldValue() {
    const res = await this.evaluateRaw(`(() => {
      const el = document.activeElement;
      if (!el) return null;
      if ('value' in el && typeof el.value === 'string') return el.value;
      if (el.isContentEditable) return el.textContent || '';
      return null;
    })()`);
    return res.ok ? res.value : null;
  }

  async screenshot(args, ctx) {
    const workspaceDir = ctx?.workspaceDir || P.workspaceDir;
    try {
      await this.ensureSession();
      const page = await this.ensurePage();
      const shot = await page.send('Page.captureScreenshot', { format: 'png', fromSurface: true }, { timeoutMs: 20000 });
      if (!shot?.data) return errorResult('SCREENSHOT_FAILED', 'the browser returned no image data');
      const buffer = Buffer.from(shot.data, 'base64');

      const requested = String(args?.path || '').trim();
      const relative = requested || path.join('artifacts', `${stamp()}.png`);
      const target = resolveInWorkspace(workspaceDir, relative);
      if (!target.inside) {
        return errorResult('SCREENSHOT_PATH_OUTSIDE', `screenshots must stay inside the workspace; "${relative}" resolves to ${target.abs}`);
      }
      await fsp.mkdir(path.dirname(target.abs), { recursive: true });
      await fsp.writeFile(target.abs, buffer);

      let viewport = null;
      try {
        const metrics = await page.send('Page.getLayoutMetrics');
        viewport = {
          width: Math.round(metrics.cssLayoutViewport?.clientWidth || 0),
          height: Math.round(metrics.cssLayoutViewport?.clientHeight || 0),
        };
      } catch {
        /* optional */
      }

      return {
        ok: true,
        path: target.rel,
        absolutePath: target.abs,
        bytes: buffer.length,
        format: 'png',
        viewport,
      };
    } catch (err) {
      return browserFailure(err);
    }
  }

  /**
   * browser_download: let the browser fetch a URL and save it under
   * workspace/downloads. This is the "bot downloads the invoice for you" path -
   * it goes through the real browser, so it carries the profile's cookies.
   */
  async download(args, ctx) {
    const url = String(args?.url || '');
    if (!isHttpUrl(url)) return errorResult('BROWSER_BAD_URL', `browser_download needs an absolute http(s) URL; got "${url}"`);
    if (isPrivateHostname(url) && process.env.ALLOW_PRIVATE !== '1') {
      return errorResult('PRIVATE_HOST_BLOCKED', `${new URL(url).hostname} is a private or loopback address (set ALLOW_PRIVATE=1 to allow it)`);
    }

    const workspaceDir = ctx?.workspaceDir || P.workspaceDir;
    const downloadDir = path.join(workspaceDir, 'downloads');

    try {
      const session = await this.ensureSession();
      await fsp.mkdir(downloadDir, { recursive: true });
      const before = new Set(await fsp.readdir(downloadDir).catch(() => []));

      // Prefer the browser-level domain (current Chrome); fall back to the
      // older page-level one on builds that dropped it.
      let configured = false;
      try {
        await session.browser.send('Browser.setDownloadBehavior', {
          behavior: 'allow',
          downloadPath: downloadDir,
          eventsEnabled: true,
        }, { timeoutMs: 8000 });
        configured = true;
      } catch {
        configured = false;
      }
      if (!configured) {
        try {
          await session.page.send('Page.setDownloadBehavior', { behavior: 'allow', downloadPath: downloadDir }, { timeoutMs: 8000 });
          configured = true;
        } catch {
          configured = false;
        }
      }
      if (!configured) {
        return errorResult('DOWNLOAD_UNAVAILABLE', 'this browser refused to configure a download directory');
      }

      // Track this download through the browser's own events: they tell us the
      // filename Chrome chose and, crucially, when the file is actually complete.
      // Polling the directory alone can grab Chrome's own artifacts (it writes a
      // downloads.htm while a download is in flight).
      const tracker = { guid: null, filename: null, state: null, received: 0 };
      const startedAt = Date.now();
      const offBegin = session.browser.on('Browser.downloadWillBegin', (event) => {
        if (!tracker.guid) {
          tracker.guid = event.guid;
          tracker.filename = event.suggestedFilename || null;
        }
      });
      const offProgress = session.browser.on('Browser.downloadProgress', (event) => {
        if (event.guid === tracker.guid) {
          tracker.state = event.state;
          tracker.received = event.receivedBytes ?? 0;
        }
      });

      // Navigating to an attachment URL starts a download and Chrome reports the
      // navigation as ERR_ABORTED. That is the success case here, so only a real
      // network error is fatal.
      const page = await this.ensurePage();
      this.inFlight = 0;
      this.lastActivity = Date.now();
      const nav = await page.send('Page.navigate', { url }, { timeoutMs: 30000 }).catch((err) => ({
        errorText: err.message,
      }));

      let file = null;
      try {
        if (nav?.errorText && !/ERR_ABORTED/i.test(nav.errorText)) {
          return errorResult('NAVIGATION_FAILED', `${nav.errorText} (${url})`);
        }

        const completed = await this.waitForDownloadState(tracker, 60000);
        if (completed === 'canceled') {
          return errorResult('DOWNLOAD_CANCELED', 'the browser canceled the download');
        }
        file = await this.findDownloadedFile(downloadDir, before, tracker.filename, completed ? 8000 : 0, startedAt);
      } finally {
        offBegin();
        offProgress();
      }

      if (!file) {
        return errorResult('DOWNLOAD_TIMEOUT', 'no file appeared in the downloads folder within 60s', {
          downloadsDir: path.relative(workspaceDir, downloadDir).split(path.sep).join('/'),
        });
      }

      const source = path.join(downloadDir, file);
      const stat = await fsp.stat(source);

      let finalPath = source;
      let finalRel = path.relative(workspaceDir, source).split(path.sep).join('/');
      const requested = String(args?.path || '').trim();
      if (requested) {
        const target = resolveInWorkspace(workspaceDir, requested);
        if (!target.inside) {
          return errorResult('DOWNLOAD_PATH_OUTSIDE', `downloads must stay inside the workspace; "${requested}" resolves to ${target.abs}`);
        }
        await fsp.mkdir(path.dirname(target.abs), { recursive: true });
        await moveFileWithRetry(source, target.abs);
        finalPath = target.abs;
        finalRel = target.rel;
      }

      return {
        ok: true,
        path: finalRel,
        absolutePath: finalPath,
        filename: path.basename(finalPath),
        bytes: stat.size,
        url,
        downloadsDir: path.relative(workspaceDir, downloadDir).split(path.sep).join('/'),
      };
    } catch (err) {
      return browserFailure(err);
    }
  }

  /** Wait for the browser to say the current download finished. */
  async waitForDownloadState(tracker, timeoutMs) {
    const deadline = Date.now() + timeoutMs;
    while (Date.now() < deadline) {
      if (tracker.state === 'completed') return 'completed';
      if (tracker.state === 'canceled') return 'canceled';
      await sleep(100);
    }
    // No events at all (older Chromium): report 'unknown' and let the file scan
    // decide instead of failing outright.
    return tracker.guid ? 'timeout' : 'unknown';
  }

  /**
   * Find the file the browser just wrote.
   *
   * Chrome renames duplicate downloads to "name (1).ext", and it also drops its
   * own `downloads.htm` artwork into the folder, so "newest file" is not a safe
   * heuristic. We prefer the exact suggested filename, then a "stem (n).ext"
   * variant, and only fall back to the newest non-HTML file when the browser
   * gave us no name at all.
   */
  async findDownloadedFile(dir, before, expectedName, extraWaitMs = 4000, startedAt = 0) {
    const deadline = Date.now() + Math.max(extraWaitMs, 2000);
    let settled = null;

    while (Date.now() < deadline) {
      const names = (await fsp.readdir(dir).catch(() => [])).filter((n) => !n.endsWith('.crdownload') && !before.has(n));
      let chosen = null;

      if (expectedName) {
        const exact = names.find((n) => n === expectedName);
        if (exact) chosen = exact;
        if (!chosen) {
          const stem = expectedName.replace(/\.[^.]+$/, '');
          const ext = path.extname(expectedName);
          chosen = names.find((n) => n.startsWith(`${stem} (`) && (!ext || n.endsWith(ext))) || null;
        }
        // Chromium sometimes overwrites an existing file in place instead of
        // writing "name (1).ext"; accept that file if it was touched by this call.
        if (!chosen && startedAt) {
          const info = await fsp.stat(path.join(dir, expectedName)).catch(() => null);
          if (info && info.mtimeMs >= startedAt - 1500) chosen = expectedName;
        }
      }
      if (!chosen) {
        // No name from the browser: newest non-HTML file that is not a Chrome artifact.
        const candidates = [];
        for (const name of names) {
          if (/\.html?$/i.test(name)) continue;
          const info = await fsp.stat(path.join(dir, name)).catch(() => null);
          if (info?.size > 0) candidates.push({ name, size: info.size, mtime: info.mtimeMs });
        }
        candidates.sort((a, b) => b.mtime - a.mtime);
        chosen = candidates[0]?.name || null;
      }

      if (chosen) {
        const info = await fsp.stat(path.join(dir, chosen)).catch(() => null);
        if (info?.size > 0) {
          // Accept only once the size stops changing, so we never copy a
          // half-written file.
          if (settled && settled.name === chosen && settled.size === info.size) return chosen;
          settled = { name: chosen, size: info.size };
        }
      }
      await sleep(200);
    }
    return settled?.name || null;
  }

  async evaluate(args) {
    const expression = String(args?.expression || '');
    if (!expression.trim()) return errorResult('BAD_ARGS', 'browser_eval needs an expression');
    if (expression.length > 8000) return errorResult('BAD_ARGS', 'browser_eval is limited to 8000 characters');
    try {
      await this.ensureSession();
      const res = await this.evaluateRaw(expression, { timeoutMs: 30000 });
      if (!res.ok) return res;
      return { ok: true, value: res.value, type: res.type };
    } catch (err) {
      return browserFailure(err);
    }
  }

  async close() {
    const session = this.session;
    if (!session) {
      return { ok: true, closed: false, message: 'no browser session was running' };
    }
    const pid = session.pid;
    try {
      await session.browser?.send('Browser.close', {}, { timeoutMs: 3000 });
    } catch {
      /* older builds may not answer; the kill below covers it */
    }
    this.session = null;
    for (const conn of [session.page, session.browser]) {
      try {
        conn?.close();
      } catch {
        /* ignore */
      }
    }
    try {
      session.child?.kill();
    } catch {
      /* ignore */
    }
    await fsp.rm(stateFile(), { force: true }).catch(() => {});
    return { ok: true, closed: true, pid };
  }

  /** Where the page really is now (clicks and redirects move it). */
  async currentUrl() {
    await this.ensureSession();
    const r = await this.evaluateRaw('location.href');
    return r?.ok && r.value ? String(r.value) : (this.session?.pageUrl || '');
  }

  async status() {
    const executable = detectBrowserExecutable();
    const session = this.session;
    const running = Boolean(session && session.page && !session.page.closed);
    const out = {
      ok: true,
      running,
      pid: running ? session.pid : null,
      profileDir: profileDir(),
      cdpUrl: running ? `http://127.0.0.1:${session.port}` : null,
      headless: running ? session.headless : process.env.BROWSER_HEADLESS === '1',
      adopted: running ? session.adopted : false,
      executable: executable.path,
      detectedBy: executable.source,
      supported: browserSupport().supported,
      pageUrl: running ? session.pageUrl : null,
      // Windows remote machines: whether the human can see (and take over) this browser.
      ...(process.platform === 'win32' && !process.env.SESSIONNAME ? { visibleOnDesktop: Boolean(session?.onDesktop), takeoverNote: session?.onDesktop ? '' : '这台 Windows 机器上没有人登录桌面（或不是同一个账号），浏览器在后台无界面运行，接管时看不到它；需要用户登录桌面后重新打开浏览器。' } : {}),
    };
    if (!running) {
      out.checked = executable.checked.slice(0, 6);
      if (!executable.path) out.hint = installHint();
    }
    return out;
  }
}

// ---------------------------------------------------------------------------
// shared helpers
// ---------------------------------------------------------------------------

/** Same private-network rule as http_fetch, applied to browser URLs. */
export function isPrivateHostname(url) {
  let hostname;
  try {
    hostname = new URL(String(url)).hostname.toLowerCase();
  } catch {
    return false;
  }
  const host = hostname.replace(/^\[|\]$/g, '');
  if (host === 'localhost' || host.endsWith('.localhost') || host === '::1') return true;
  if (!host.includes('.') && !host.includes(':')) return true;
  const v4 = host.match(/^(\d{1,3})\.(\d{1,3})\.(\d{1,3})\.(\d{1,3})$/);
  if (v4) {
    const [a, b] = [Number(v4[1]), Number(v4[2])];
    if (a === 10 || a === 127 || a === 0) return true;
    if (a === 169 && b === 254) return true;
    if (a === 192 && b === 168) return true;
    if (a === 172 && b >= 16 && b <= 31) return true;
  }
  if (host.startsWith('fc') || host.startsWith('fd') || host.startsWith('fe80')) return true;
  return false;
}

/** Turn an exception from the manager into a structured tool result. */
function browserFailure(err) {
  const code = err?.code || 'browser_failed';
  if (code === 'not_configured') {
    return errorResult('not_configured', err.message, { hint: err.hint || installHint(), checked: err.checked });
  }
  if (code === 'unsupported') {
    return errorResult('unsupported', err.message, { hint: err.hint });
  }
  return errorResult(code, err?.message || 'browser operation failed');
}

// ---------------------------------------------------------------------------
// singleton
// ---------------------------------------------------------------------------

let manager = null;
const managers = new Map();

/**
 * One browser per bot. Tool calls reuse the same page, which is what lets
 * "snapshot then click @e3" work inside a single turn. Separate bots get
 * separate browsers on separate desktops, so bot A can never see bot B's tabs.
 */
export function getBrowserManager(key = '') {
  if (!key) {
    if (!manager) manager = new BrowserManager();
    return manager;
  }
  if (!managers.has(key)) managers.set(key, new BrowserManager({ key }));
  return managers.get(key);
}

/** All live managers, for status endpoints and shutdown. */
export function browserManagers() {
  return [...(manager ? [manager] : []), ...managers.values()];
}

export { BrowserManager, CdpConnection };

// Keep the OS import used: the Linux/VM docs mention the platform explicitly.
export const platformNote = () =>
  process.platform === 'win32'
    ? 'windowed Chrome by default; set BROWSER_HEADLESS=1 for a headless run'
    : `running on ${os.platform()}; a headless VM needs BROWSER_HEADLESS=1 or xvfb`;
