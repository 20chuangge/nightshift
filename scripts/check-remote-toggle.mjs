/**
 * Drives the running desktop app (needs --remote-debugging-port=9222) and flips
 * Settings → 手机和外网 → 允许手机连接 off and on again, checking at each step
 * what /api/health says about the bind address.
 *
 *   node scripts/_check-remote-toggle.mjs
 */
const CDP = 9222;
const HUB = 'http://127.0.0.1:14390';
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

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
      const timer = setTimeout(() => reject(new Error('CDP socket never opened')), 8000);
      this.ws.addEventListener('open', () => { clearTimeout(timer); resolve(); }, { once: true });
      this.ws.addEventListener('error', (err) => { clearTimeout(timer); reject(err); }, { once: true });
    });
  }

  send(method, params = {}, timeoutMs = 30000) {
    const id = ++this.id;
    this.ws.send(JSON.stringify({ id, method, params }));
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => reject(new Error(`${method} timed out`)), timeoutMs);
      this.pending.set(id, {
        resolve: (value) => { clearTimeout(timer); resolve(value); },
        reject: (err) => { clearTimeout(timer); reject(err); },
      });
    });
  }

  async evaluate(expression, timeoutMs = 30000) {
    const result = await this.send('Runtime.evaluate', { expression, awaitPromise: true, returnByValue: true }, timeoutMs);
    if (result.exceptionDetails) throw new Error(JSON.stringify(result.exceptionDetails).slice(0, 400));
    return result.result?.value;
  }
}

async function health() {
  const res = await fetch(`${HUB}/api/health`);
  return res.json();
}

const main = async () => {
  const list = await (await fetch(`http://127.0.0.1:${CDP}/json/list`)).json();
  const target = list.find((t) => t.type === 'page' && /127\.0\.0\.1:14390/.test(t.url));
  if (!target) throw new Error(`no app page in CDP list: ${list.map((t) => t.url).join(', ')}`);

  const page = new Cdp(target.webSocketDebuggerUrl);
  await page.open();
  await page.send('Runtime.enable');

  const before = await health();
  console.log('before:', JSON.stringify({ lanUrl: before.lanUrl, tailnetUrl: before.tailnetUrl, version: before.version }));

  const ui = await page.evaluate(`(() => {
    const btn = document.getElementById('settings-btn');
    if (btn) btn.click();
    const nav = document.querySelector('[data-set-target="sec-pair"]');
    if (nav) nav.click();
    const wrap = document.getElementById('allow-remote-wrap');
    const box = document.getElementById('allow-remote');
    return {
      hasDeskBridge: typeof window.desk?.setRemote === 'function',
      wrapHidden: wrap ? wrap.hidden : null,
      checked: box ? box.checked : null,
    };
  })()`);
  console.log('ui:', JSON.stringify(ui));

  // Off
  await page.evaluate("document.getElementById('allow-remote').click()");
  await sleep(6000);
  const off = await health();
  console.log('after off:', JSON.stringify({ lanUrl: off.lanUrl, tailnetUrl: off.tailnetUrl }));

  const afterOffUi = await page.evaluate(`(() => {
    const btn = document.getElementById('settings-btn');
    if (btn) btn.click();
    const nav = document.querySelector('[data-set-target="sec-pair"]');
    if (nav) nav.click();
    return { checked: document.getElementById('allow-remote')?.checked, hint: document.getElementById('phone-connect-hint')?.textContent };
  })()`);
  console.log('ui after off:', JSON.stringify(afterOffUi));

  // On again
  await page.evaluate("document.getElementById('allow-remote').click()");
  await sleep(6000);
  const on = await health();
  console.log('after on:', JSON.stringify({ lanUrl: on.lanUrl, tailnetUrl: on.tailnetUrl }));

  const afterOnUi = await page.evaluate(`(() => {
    const btn = document.getElementById('settings-btn');
    if (btn) btn.click();
    const nav = document.querySelector('[data-set-target="sec-pair"]');
    if (nav) nav.click();
    return { checked: document.getElementById('allow-remote')?.checked, hint: document.getElementById('phone-connect-hint')?.textContent };
  })()`);
  console.log('ui after on:', JSON.stringify(afterOnUi));

  if (!off.lanUrl && on.lanUrl && ui.checked === true && afterOnUi.checked === true) {
    console.log('RESULT the switch really rebinds the hub both ways');
  } else {
    console.log('RESULT something is off — inspect the lines above');
    process.exitCode = 1;
  }
};

main().catch((err) => {
  console.error('FAILED', err.message);
  process.exitCode = 1;
});
