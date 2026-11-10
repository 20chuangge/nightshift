#!/usr/bin/env node
/**
 * check-android-app.mjs - drive the Android build on a running emulator/device.
 *
 * There is no need to look at a screenshot to know whether the app works: the
 * Capacitor WebView is a Chrome, so we attach to it over CDP, read the DOM, run
 * JS, and only then decide. (Headless emulators often paint black even when the
 * page is fine - `adb screencap` lies, the DOM does not.)
 *
 * Prerequisite: an emulator or device is connected (`adb devices`) and the debug
 * APK is installed. The script only forwards the WebView's devtools socket.
 *
 *   node scripts/check-android-app.mjs                        # dump state
 *   node scripts/check-android-app.mjs --hub http://10.0.2.2:14390
 *   node scripts/check-android-app.mjs --js "document.title"
 *   node scripts/check-android-app.mjs --shot .uiv1-shots/android.png
 */
import { spawn } from 'node:child_process';
import fs from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const REPO = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const ADB = process.env.ADB || path.join(REPO, '..', '_tools', 'android-sdk', 'platform-tools', 'adb.exe');
const PACKAGE = 'com.desk.assistant';
const PORT = Number(process.env.APP_CDP_PORT || 9223);
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

function arg(name, fallback = '') {
  const index = process.argv.indexOf(`--${name}`);
  return index === -1 ? fallback : process.argv[index + 1] || '';
}

/** The device to talk to: --serial, or ADB_SERIAL, or the only one attached. */
const SERIAL = arg('serial') || process.env.ADB_SERIAL || '';

function adb(args) {
  const full = SERIAL ? ['-s', SERIAL, ...args] : args;
  return new Promise((resolve) => {
    const proc = spawn(ADB, full, { windowsHide: true });
    let out = '';
    proc.stdout.on('data', (c) => (out += c.toString()));
    proc.stderr.on('data', (c) => (out += c.toString()));
    proc.on('close', () => resolve(out.trim()));
  });
}

class Cdp {
  constructor(url) {
    this.ws = new WebSocket(url);
    this.id = 0;
    this.pending = new Map();
    this.ws.addEventListener('message', (event) => {
      const msg = JSON.parse(event.data);
      if (msg.id && this.pending.has(msg.id)) {
        const { resolve } = this.pending.get(msg.id);
        this.pending.delete(msg.id);
        resolve(msg);
      }
    });
  }
  open() {
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => reject(new Error('devtools socket never opened')), 8000);
      this.ws.addEventListener('open', () => { clearTimeout(timer); resolve(); }, { once: true });
      this.ws.addEventListener('error', (err) => { clearTimeout(timer); reject(err); }, { once: true });
    });
  }
  send(method, params = {}) {
    const id = ++this.id;
    this.ws.send(JSON.stringify({ id, method, params }));
    return new Promise((resolve) => this.pending.set(id, { resolve }));
  }
  async evaluate(expression) {
    const result = await this.send('Runtime.evaluate', { expression, awaitPromise: true, returnByValue: true });
    if (result.result?.exceptionDetails) return `ERROR: ${result.result.exceptionDetails.exception?.description || 'exception'}`;
    return result.result?.result?.value;
  }
}

const main = async () => {
  const devices = await adb(['devices']);
  const attached = devices
    .split(/\r?\n/)
    .map((line) => line.trim().split(/\s+/))
    .filter((parts) => parts.length === 2 && parts[1] === 'device')
    .map((parts) => parts[0]);
  if (!attached.length) throw new Error(`no emulator/device attached:\n${devices}`);
  if (!SERIAL && attached.length > 1) {
    throw new Error(`more than one device attached (${attached.join(', ')}); pass --serial <id>`);
  }
  const pid = (await adb(['shell', 'pidof', PACKAGE])) || '';
  if (!pid) throw new Error(`${PACKAGE} is not running (install it, or start it with adb shell am start -n ${PACKAGE}/.MainActivity)`);

  await adb(['forward', `tcp:${PORT}`, `localabstract:webview_devtools_remote_${pid}`]);
  await sleep(1200);

  let target = null;
  for (let i = 0; i < 20; i += 1) {
    try {
      const list = await (await fetch(`http://127.0.0.1:${PORT}/json/list`)).json();
      target = list.find((t) => t.type === 'page');
      if (target) break;
    } catch {
      /* not up yet */
    }
    await sleep(300);
  }
  if (!target) throw new Error('the WebView devtools endpoint never answered');

  const page = new Cdp(target.webSocketDebuggerUrl);
  await page.open();
  await page.send('Runtime.enable');

  const hub = arg('hub');
  if (hub) {
    console.log('navigating to', hub);
    await page.evaluate(`(() => {
      const input = document.getElementById('hub-url');
      if (!input) { location.assign(${JSON.stringify(hub)} + '/'); return 'typed into location'; }
      input.value = ${JSON.stringify(hub)};
      document.getElementById('connect-form').dispatchEvent(new Event('submit', { cancelable: true, bubbles: true }));
      return 'submitted';
    })()`);
    await sleep(6000);
  }

  const js = arg('js');
  const jsFile = arg('jsfile');
  const script = jsFile ? await fs.readFile(path.isAbsolute(jsFile) ? jsFile : path.join(REPO, jsFile), 'utf8') : js;
  if (script) {
    console.log(JSON.stringify(await page.evaluate(script), null, 2));
  } else {
    const state = await page.evaluate(`JSON.stringify({
      url: location.href,
      title: document.title,
      hasCapacitor: typeof window.Capacitor,
      plugins: window.Capacitor ? Object.keys(window.Capacitor.Plugins || {}) : [],
      shell: window.__deskShell ? window.__deskShell.state() : null,
      text: (document.body?.innerText || '').replace(/\\s+/g, ' ').slice(0, 400),
    })`);
    console.log(state);
  }

  const shot = arg('shot');
  if (shot) {
    const out = path.isAbsolute(shot) ? shot : path.join(REPO, shot);
    const { result } = await page.send('Page.captureScreenshot', { format: 'png' });
    await fs.mkdir(path.dirname(out), { recursive: true });
    await fs.writeFile(out, Buffer.from(result.data, 'base64'));
    console.log(`screenshot -> ${out}`);
  }

  page.ws.close();
};

main().catch((err) => {
  console.error('FAILED', err.message);
  process.exitCode = 1;
});
