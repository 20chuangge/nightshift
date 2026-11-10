/**
 * Visual check of 设置 → 手机和外网 without a human: boots the working-tree hub on
 * a throw-away home, drives Chrome over CDP, screenshots the QR dialog.
 *
 *   node scripts/_check-phone-ui.mjs
 *
 * Leaves screenshots in .uiv1-shots/ (gitignored) and prints what it saw.
 */
import { spawn } from 'node:child_process';
import fsp from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const REPO = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const OUT = path.join(REPO, '.uiv1-shots');
const PORT = 14399;
const CDP = 9333;
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

async function seed(home) {
  for (const dir of ['config', 'skills', 'public', 'workspace']) {
    await fsp.cp(path.join(REPO, dir), path.join(home, dir), { recursive: true }).catch(() => {});
  }
  await fsp.mkdir(path.join(home, 'data'), { recursive: true });
}

async function bootHub(home) {
  const proc = spawn(process.execPath, [path.join(REPO, 'src', 'server.mjs')], {
    env: {
      ...process.env,
      ASSIST_HOME: home,
      ASSIST_DATA_DIR: path.join(home, 'data'),
      ASSIST_WORKSPACE_DIR: path.join(home, 'workspace'),
      ASSIST_MODEL_PROVIDER: 'mock',
      HOST: '0.0.0.0',
      ASSIST_ALLOW_REMOTE: '1',
      PORT: String(PORT),
      CHROME_PATH: path.join(home, 'no-such-browser.exe'),
    },
    stdio: ['ignore', 'pipe', 'pipe'],
    windowsHide: true,
  });
  let out = '';
  await new Promise((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error(`hub did not start: ${out.slice(-800)}`)), 20000);
    proc.stdout.on('data', (chunk) => {
      out += chunk.toString('utf8');
      if (/"event":"ready"/.test(out)) {
        clearTimeout(timer);
        resolve();
      }
    });
    proc.stderr.on('data', (chunk) => {
      out += chunk.toString('utf8');
    });
    proc.on('exit', (code) => reject(new Error(`hub exited ${code}: ${out.slice(-800)}`)));
  });
  return proc;
}

const CHROME_CANDIDATES = [
  'C:/Program Files/Google/Chrome/Application/chrome.exe',
  'C:/Program Files (x86)/Google/Chrome/Application/chrome.exe',
  'C:/Program Files (x86)/Microsoft/Edge/Application/msedge.exe',
  'C:/Program Files/Microsoft/Edge/Application/msedge.exe',
];

async function findChrome() {
  for (const candidate of CHROME_CANDIDATES) {
    if (await fsp.stat(candidate).then(() => true).catch(() => false)) return candidate;
  }
  throw new Error('no Chrome/Edge found');
}

class Cdp {
  constructor(url) {
    this.ws = new WebSocket(url);
    this.id = 0;
    this.pending = new Map();
    this.ws.addEventListener('message', (event) => {
      const msg = JSON.parse(event.data);
      if (msg.id && this.pending.has(msg.id)) {
        const { resolve, reject } = this.pending.get(msg.id);
        this.pending.delete(msg.id);
        if (msg.error) reject(new Error(JSON.stringify(msg.error)));
        else resolve(msg.result);
      }
    });
  }

  open() {
    return new Promise((resolve, reject) => {
      this.ws.addEventListener('open', resolve, { once: true });
      this.ws.addEventListener('error', reject, { once: true });
    });
  }

  send(method, params = {}) {
    const id = ++this.id;
    this.ws.send(JSON.stringify({ id, method, params }));
    return new Promise((resolve, reject) => this.pending.set(id, { resolve, reject }));
  }

  async evaluate(expression) {
    const result = await this.send('Runtime.evaluate', {
      expression,
      awaitPromise: true,
      returnByValue: true,
    });
    if (result.exceptionDetails) throw new Error(JSON.stringify(result.exceptionDetails).slice(0, 300));
    return result.result?.value;
  }

  async shot(file) {
    const { data } = await this.send('Page.captureScreenshot', { format: 'png' });
    await fsp.writeFile(file, Buffer.from(data, 'base64'));
  }
}

const main = async () => {
  await fsp.mkdir(OUT, { recursive: true });
  const home = await fsp.mkdtemp(path.join(os.tmpdir(), 'desk-phone-ui-'));
  await seed(home);
  const hub = await bootHub(home);
  const chrome = await findChrome();
  const profile = await fsp.mkdtemp(path.join(os.tmpdir(), 'desk-chrome-'));
  const browser = spawn(chrome, [
    '--headless=new',
    `--remote-debugging-port=${CDP}`,
    `--user-data-dir=${profile}`,
    '--window-size=1280,900',
    '--no-first-run',
    '--disable-gpu',
    'about:blank',
  ], { stdio: 'ignore', windowsHide: true });

  try {
    // Wait for the CDP endpoint, then attach to the first page.
    let target = null;
    for (let i = 0; i < 60; i += 1) {
      try {
        const res = await fetch(`http://127.0.0.1:${CDP}/json/list`);
        const list = await res.json();
        target = list.find((t) => t.type === 'page');
        if (target) break;
      } catch {
        /* not up yet */
      }
      await sleep(250);
    }
    if (!target) throw new Error('CDP endpoint never appeared');

    const page = new Cdp(target.webSocketDebuggerUrl);
    await page.open();
    await page.send('Page.enable');
    await page.send('Runtime.enable');
    const errors = [];
    page.ws.addEventListener('message', (event) => {
      const msg = JSON.parse(event.data);
      if (msg.method === 'Runtime.exceptionThrown') {
        errors.push(msg.params.exceptionDetails?.exception?.description || 'exception');
      }
    });

    await page.send('Page.navigate', { url: `http://127.0.0.1:${PORT}/` });
    await sleep(2500);

    const vendor = await page.evaluate('typeof window.qrcode');
    console.log('window.qrcode:', vendor);

    // The whole app lives in a closure, so drive it the way a human does: clicks.
    await page.evaluate("document.getElementById('settings-btn').click()");
    await sleep(500);
    await page.evaluate("document.querySelector('[data-set-target=\"sec-pair\"]').click()");
    await sleep(500);
    const seen = await page.evaluate(`(() => ({
      drawerOpen: document.getElementById('settings-drawer')?.classList.contains('open'),
      remoteWrapHidden: document.getElementById('allow-remote-wrap')?.hidden,
      url: document.getElementById('pair-url')?.textContent,
      devicesEmpty: !document.getElementById('device-empty')?.hidden,
      hint: document.getElementById('phone-connect-hint')?.textContent,
    }))()`);
    console.log('settings:', JSON.stringify(seen));

    // Mint a link and draw the QR exactly like the button does.
    await page.evaluate("document.getElementById('phone-connect').click()");
    await sleep(1200);
    const qr = await page.evaluate(`(() => ({
      modalOpen: document.getElementById('pair-modal')?.classList.contains('open'),
      svg: Boolean(document.querySelector('#qr-box svg')),
      rects: document.querySelectorAll('#qr-box svg rect').length,
      url: document.getElementById('qr-url')?.textContent || '',
      count: document.getElementById('qr-count')?.textContent || '',
      tabs: document.getElementById('pair-tabs')?.textContent || '',
      tabsHidden: document.getElementById('pair-tabs')?.hidden,
      error: document.getElementById('qr-error')?.hidden ? '' : document.getElementById('qr-error')?.textContent,
    }))()`);
    console.log('qr:', JSON.stringify(qr));
    await sleep(300);
    await page.shot(path.join(OUT, 'phone-qr.png'));

    // Pair a fake phone through the API, then look at the device list.
    const token = new URL(qr.url).searchParams.get('pair');
    const paired = await fetch(`http://127.0.0.1:${PORT}/api/pair`, {
      method: 'POST',
      headers: { 'content-type': 'application/json', 'user-agent': 'Mozilla/5.0 (iPhone; CPU iPhone OS 17_0 like Mac OS X)' },
      body: JSON.stringify({ code: token }),
    });
    console.log('pair status:', paired.status);
    await page.evaluate("document.getElementById('pair-modal-close').click()");
    await page.evaluate("document.getElementById('settings-close').click()");
    await sleep(300);
    await page.evaluate("document.getElementById('settings-btn').click()");
    await sleep(400);
    await page.evaluate("document.querySelector('[data-set-target=\"sec-pair\"]').click()");
    await sleep(800);
    const devices = await page.evaluate(`(() => ({
      rows: document.querySelectorAll('#device-list .device-item').length,
      name: document.querySelector('#device-list .device-name')?.textContent || '',
      meta: document.querySelector('#device-list .device-meta')?.textContent || '',
      emptyHidden: document.getElementById('device-empty')?.hidden,
    }))()`);
    console.log('devices:', JSON.stringify(devices));
    await page.shot(path.join(OUT, 'phone-settings.png'));

    // A phone-shaped viewport must not scroll sideways.
    await page.send('Emulation.setDeviceMetricsOverride', {
      width: 375, height: 812, deviceScaleFactor: 2, mobile: true,
    });
    await sleep(500);
    const narrow = await page.evaluate(`(() => ({
      overflow: document.documentElement.scrollWidth - document.documentElement.clientWidth,
      drawerOpen: document.getElementById('settings-drawer')?.classList.contains('open'),
    }))()`);
    console.log('narrow:', JSON.stringify(narrow));
    await page.shot(path.join(OUT, 'phone-narrow.png'));

    console.log('page errors:', JSON.stringify(errors.slice(0, 5)));
  } finally {
    browser.kill();
    hub.kill();
    await fsp.rm(home, { recursive: true, force: true }).catch(() => {});
    await fsp.rm(profile, { recursive: true, force: true }).catch(() => {});
  }
};

main().catch((err) => {
  console.error('FAILED', err.message);
  process.exitCode = 1;
});
