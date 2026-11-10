/* launcher.js — the Desk mobile shell (launchpad).
 *
 * Job: remember which Desk hub this phone talks to, check that it answers, and
 * then open the hub's own UI at the top level of the WebView.
 *
 * Two decisions worth knowing about:
 *
 * 1. Top-level navigation, not an iframe. The hub authenticates a phone with an
 *    HttpOnly SameSite=Lax cookie (`desk_session`, set by POST /api/pair). A
 *    cross-site iframe never sends that cookie (the top-level site would be
 *    `localhost`, the frame `192.168.x.x`), so the UI inside a frame would sit
 *    on its pairing screen forever. A top-level navigation is first-party: same
 *    cookie rules as the desktop browser, and the hub needs no CORS support.
 *
 * 2. No token in Preferences. The session token is HttpOnly — page script can
 *    never read it, and the hub sends no CORS headers, so this launchpad cannot
 *    hold it either. What it stores is the hub URL; the hub's own pairing screen
 *    owns the credential. Typing the pairing code here just deep-links to
 *    `/?pair=CODE`, which the hub's UI consumes first-party.
 *
 * No bundler, no imports: native Capacitor injects `window.Capacitor.Plugins`,
 * and a plain-browser preview of www/ falls back to localStorage.
 */
(() => {
  'use strict';

  const KEYS = { hub: 'desk.hubUrl', hubs: 'desk.hubs', bot: 'desk.botId', tokenFor: (hub) => `desk.token:${hub}` };
  const PROBE_TIMEOUT_MS = 4500;
  const LONG_PRESS_MS = 550;

  const $ = (id) => document.getElementById(id);
  const dom = {
    screens: {
      connect: $('connect'),
      connected: $('connected'),
      booting: $('booting'),
      offline: $('offline'),
    },
    connectForm: $('connect-form'),
    connectError: $('connect-error'),
    connectBtn: $('connect-btn'),
    hubUrl: $('hub-url'),
    hubCode: $('hub-code'),
    pasteBtn: $('paste-btn'),
    scanBtn: $('scan-btn'),
    previewBtn: $('preview-btn'),
    machines: $('machines'),
    machineList: $('machine-list'),
    currentHub: $('current-hub'),
    currentStatus: $('current-status'),
    shellVersion: $('shell-version'),
    openBtn: $('open-btn'),
    changeBtn: $('change-btn'),
    forgetBtn: $('forget-btn'),
    bootingText: $('booting-text'),
    bootingUrl: $('booting-url'),
    bootingCancel: $('booting-cancel'),
    offlineDetail: $('offline-detail'),
    offlineUrl: $('offline-url'),
    offlineRetry: $('offline-retry'),
    offlineChange: $('offline-change'),
    foot: $('foot'),
  };

  // ---------------------------------------------------------------- platform
  const cap = window.Capacitor || null;
  const plugins = (cap && cap.Plugins) || {};
  const prefs = plugins.Preferences || null;
  const app = plugins.App || null;
  const scanner = plugins.BarcodeScanner || null;
  const isNative = Boolean(cap && typeof cap.isNativePlatform === 'function' && cap.isNativePlatform());

  /** @capacitor/preferences on device, localStorage when previewing in a browser. */
  const store = {
    async get(key) {
      if (prefs) {
        try {
          const res = await prefs.get({ key });
          if (res && typeof res.value === 'string') return res.value;
        } catch (err) {
          console.warn('[desk] Preferences.get failed, falling back', err);
        }
      }
      try {
        return window.localStorage.getItem(key);
      } catch {
        return null;
      }
    },
    async set(key, value) {
      if (prefs) {
        try {
          await prefs.set({ key, value });
          return;
        } catch (err) {
          console.warn('[desk] Preferences.set failed, falling back', err);
        }
      }
      try {
        window.localStorage.setItem(key, value);
      } catch (err) {
        console.warn('[desk] localStorage unavailable', err);
      }
    },
    async remove(key) {
      if (prefs) {
        try {
          await prefs.remove({ key });
        } catch (err) {
          console.warn('[desk] Preferences.remove failed', err);
        }
      }
      try {
        window.localStorage.removeItem(key);
      } catch {
        /* ignore */
      }
    },
  };

  // ------------------------------------------------------------------- state
  const state = {
    view: 'connect',
    hub: '',
    info: null,
    probeId: 0,
  };

  function show(view) {
    state.view = view;
    for (const [name, node] of Object.entries(dom.screens)) node.hidden = name !== view;
  }

  function setError(message) {
    if (!message) {
      dom.connectError.textContent = '';
      dom.connectError.classList.remove('show');
      return;
    }
    dom.connectError.textContent = message;
    dom.connectError.classList.add('show');
  }

  // ------------------------------------------------------------------- utils
  /** "192.168.1.23:4390" -> "http://192.168.1.23:4390"; validates scheme + path. */
  function normalizeHub(raw) {
    let text = String(raw || '').trim();
    if (!text) throw new Error('先填 Hub 地址。');
    if (!/^[a-z][a-z0-9+.-]*:\/\//i.test(text)) text = `http://${text}`;

    let url;
    try {
      url = new URL(text);
    } catch {
      throw new Error(`"${raw}" 不是合法地址。示例：http://192.168.1.23:4390`);
    }
    if (url.protocol !== 'http:' && url.protocol !== 'https:') {
      throw new Error('只支持 http:// 或 https:// 的 Hub。');
    }
    if (!url.hostname) throw new Error('这个地址里没有主机名。');

    // The Desk UI calls absolute paths (`/api/health`, `/api/stream`, ...), so a
    // hub behind a path prefix cannot work. Fail loudly rather than half-work.
    if (url.pathname.replace(/\/+$/, '')) {
      throw new Error('请填 Hub 根地址、不要带路径，例如 http://192.168.1.23:4390');
    }
    return url.origin;
  }

  function hubUrlFor(hub, code) {
    if (!code) return `${hub}/`;
    return `${hub}/?pair=${encodeURIComponent(String(code).replace(/\s+/g, ''))}`;
  }

  // ---------------------------------------------------------- saved machines
  /** This phone only stores hub URLs; the credential stays in the hub's cookie. */
  function hostLabel(hub) {
    try {
      return new URL(hub).host;
    } catch {
      return hub;
    }
  }

  async function readHubs() {
    try {
      const raw = JSON.parse((await store.get(KEYS.hubs)) || '[]');
      if (Array.isArray(raw)) {
        const list = raw.filter((h) => h && typeof h.url === 'string');
        if (list.length) return list;
      }
    } catch {
      /* corrupt list: fall through to the single-hub key */
    }
    // Older installs (and the very first pairing) only have one hub URL.
    const single = await store.get(KEYS.hub);
    return single ? [{ url: single, name: hostLabel(single) }] : [];
  }

  async function rememberHub(hub) {
    const hubs = (await readHubs()).filter((h) => h.url !== hub);
    hubs.unshift({ url: hub, name: hostLabel(hub), lastUsedAt: new Date().toISOString() });
    await store.set(KEYS.hubs, JSON.stringify(hubs.slice(0, 12)));
    await store.set(KEYS.hub, hub);
  }

  /** Rename a remembered hub in place (the hub told us its hostname). */
  async function rememberHubNamed(hub, name) {
    const hubs = await readHubs();
    const next = hubs.map((h) => (h.url === hub ? { ...h, name } : h));
    await store.set(KEYS.hubs, JSON.stringify(next));
  }

  /**
   * Fold in the machines the hub knows about (its peers). The phone has only
   * paired with some of them; the rest still belong in this list, with the hub
   * that can hand out an entry ("via"). Names learned here also replace the
   * address a previous handoff left behind.
   */
  async function mergePeerMachines() {
    const hubs = await readHubs();
    const byUrl = new Map(hubs.map((h) => [h.url, h]));
    const looksLikeAddress = (name) => !name || /^[\d.]+(:\d+)?$/.test(name) || /^\[/.test(name);
    for (const entry of hubs) {
      const token = await store.get(KEYS.tokenFor(entry.url)).catch(() => null);
      if (!token) continue;
      try {
        const res = await fetch(`${entry.url}/api/machines`, { headers: { authorization: `Bearer ${token}` } });
        if (!res.ok) continue;
        const data = await res.json();
        let changed = false;
        const next = [...hubs];
        for (const machine of data?.machines || []) {
          if (machine.self) continue;
          // A tailnet address works from anywhere; the LAN one may not be routable.
          const url = String(machine.tailnetUrl || machine.url || '').replace(/\/+$/, '');
          if (!url) continue;
          const known = byUrl.get(url);
          if (known) {
            if (machine.name && looksLikeAddress(known.name) && known.name !== machine.name) {
              known.name = machine.name;
              known.via = known.via || entry.url;
              changed = true;
            }
            continue;
          }
          const fresh = { url, name: machine.name, via: entry.url, viaName: entry.name || hostLabel(entry.url) };
          byUrl.set(url, fresh);
          next.push(fresh);
          changed = true;
        }
        if (changed) {
          await store.set(KEYS.hubs, JSON.stringify(next.slice(0, 12)));
          await renderMachines();
          return;
        }
      } catch {
        /* offline hub: nothing to learn from it */
      }
    }
  }

  async function forgetHub(hub) {    const hubs = (await readHubs()).filter((h) => h.url !== hub);
    await store.set(KEYS.hubs, JSON.stringify(hubs));
    if ((await store.get(KEYS.hub)) === hub) await store.remove(KEYS.hub);
  }

  /** Tap a machine to go in; long press offers to forget. */
  async function renderMachines() {
    if (!dom.machines || !dom.machineList) return;
    const hubs = await readHubs();
    dom.machines.hidden = hubs.length === 0;
    dom.machineList.textContent = '';
    for (const entry of hubs) {
      const row = document.createElement('div');
      row.className = 'machine';

      const dot = document.createElement('span');
      dot.className = 'dot';
      dot.dataset.url = entry.url;

      const who = document.createElement('div');
      who.className = 'who';
      const name = document.createElement('div');
      name.className = 'n';
      name.textContent = entry.name || hostLabel(entry.url);
      const url = document.createElement('div');
      url.className = 'u';
      url.textContent = entry.url;
      who.append(name, url);

      const tag = document.createElement('span');
      tag.className = 'pill warn';
      tag.textContent = '检测中';
      row.append(dot, who, tag);

      let timer = null;
      let longPressed = false;
      row.addEventListener('pointerdown', () => {
        longPressed = false;
        timer = setTimeout(async () => {
          timer = null;
          longPressed = true;
          // eslint-disable-next-line no-alert
          const ok = window.confirm(`从列表里删掉「${entry.url}」？\n电脑上的夜班不受影响。`);
          if (!ok) return;
          await forgetHub(entry.url);
          await renderMachines();
        }, LONG_PRESS_MS);
      });
      const cancel = () => {
        if (timer) {
          clearTimeout(timer);
          timer = null;
        }
      };
      row.addEventListener('pointerup', cancel);
      row.addEventListener('pointercancel', cancel);
      row.addEventListener('pointerleave', cancel);
      row.addEventListener('click', () => {
        if (longPressed) {
          longPressed = false;
          return;
        }
        void enterMachine(entry, tag);
      });

      dom.machineList.appendChild(row);
      // Show which ones answer right now, without blocking the render.
      void probe(entry.url).then(async (up) => {
        dot.classList.toggle('up', up);
        tag.className = `pill${up ? '' : ' warn'}`;
        tag.textContent = up ? '在线' : '离线';
        if (!up) return;
        // A hub we hold a token for can tell us its own name (hostname), which
        // is nicer in this list than an address.
        const token = await store.get(KEYS.tokenFor(entry.url)).catch(() => null);
        if (!token) return;
        try {
          const res = await fetch(`${entry.url}/api/machines`, { headers: { authorization: `Bearer ${token}` } });
          if (!res.ok) return;
          const data = await res.json();
          const mine = (data?.machines || []).find((m) => m.self);
          if (mine?.name && mine.name !== name.textContent) {
            name.textContent = mine.name;
            await rememberHubNamed(entry.url, mine.name);
          }
        } catch {
          /* keep the address */
        }
      });
    }
  }

  /**
   * Enter a machine. The full web UI is what the desktop shows, so that is what
   * opens - but the WebView needs its own session cookie there. If this phone
   * already holds a device token for that hub, trade it for a one-time pairing
   * link so the UI opens *inside*, not on its pairing screen.
   */
  /** Resolve a hub's own name (hostname) when all we stored was its address. */
  async function resolveMachineName(entry) {
    const looksLikeAddress = (name) => !name || /^[\d.]+(:\d+)?$/.test(name) || /^\[/.test(name);
    if (entry.name && !looksLikeAddress(entry.name)) return entry.name;
    const token = await store.get(KEYS.tokenFor(entry.url)).catch(() => null);
    if (!token) return entry.name || '';
    try {
      const res = await fetch(`${entry.url}/api/machines`, { headers: { authorization: `Bearer ${token}` } });
      if (res.ok) {
        const data = await res.json();
        const mine = (data?.machines || []).find((m) => m.self);
        if (mine?.name) {
          await rememberHubNamed(entry.url, mine.name);
          return mine.name;
        }
      }
    } catch {
      /* keep what we have */
    }
    return entry.name || '';
  }

  /**
   * Where did we come from? The target's machine switcher shows that machine as
   * an ordinary row, so coming in from the phone's home hub must say so - the
   * two hubs know each other only in one direction.
   */
  async function originFor(targetUrl) {
    const hubs = await readHubs();
    const via = hubs.find((h) => h.url === targetUrl)?.via;
    if (via) {
      const entry = hubs.find((h) => h.url === via) || { url: via, name: '' };
      return { url: via, name: await resolveMachineName(entry) };
    }
    const token = await store.get(KEYS.tokenFor(targetUrl)).catch(() => null);
    for (const entry of hubs) {
      if (entry.url === targetUrl) continue;
      const other = await store.get(KEYS.tokenFor(entry.url)).catch(() => null);
      if (!other) continue;
      // Prefer a hub that also has a token for us: the target can talk back.
      if (!token) {
        return { url: entry.url, name: await resolveMachineName(entry) };
      }
    }
    return null;
  }

  /** Append the "you came from here" hint the target's switcher renders. */
  function withOrigin(target, origin) {
    if (!origin) return target;
    try {
      const url = new URL(target);
      url.searchParams.set('from', origin.url);
      if (origin.name) url.searchParams.set('fromName', origin.name);
      return url.toString();
    } catch {
      return target;
    }
  }

  async function enterMachine(entry, tag) {
    const hub = entry.url;
    let up = await probe(hub);
    if (!up) {
      // A Tailscale address needs a moment after the VPN comes up; one retry
      // beats telling the user a machine is off when it is not.
      await new Promise((r) => setTimeout(r, 700));
      up = await probe(hub);
    }
    if (!up) {
      if (tag) {
        tag.className = 'pill warn';
        tag.textContent = '离线';
      }
      // eslint-disable-next-line no-alert
      window.alert(`「${entry.name || hub}」现在连不上（关机、休眠或不在同一个网络）。`);
      return;
    }
    await rememberHub(hub);
    const token = await store.get(KEYS.tokenFor(hub));
    // Whoever we came through gets a row in the target's switcher.
    const origin = await originFor(hub);
    if (token) {
      try {
        const res = await fetch(`${hub}/api/pairing/link`, {
          method: 'POST',
          headers: { authorization: `Bearer ${token}` },
        });
        if (res.ok) {
          const made = await res.json();
          const links = Array.isArray(made?.links) ? made.links : [];
          const target = links[0]?.url || made?.url;
          if (target) {
            await store.set(KEYS.hub, hub);
            window.location.assign(withOrigin(target, origin));
            return;
          }
        }
      } catch {
        /* fall back to the plain address below */
      }
    } else if (entry.via) {
      // Never paired with this machine directly: the hub that told us about it
      // can hand out a one-time door (its own credential never leaves the hub).
      try {
        const res = await fetch(`${entry.via}/api/machines/${encodeURIComponent(entry.name || '')}/handoff`, {
          method: 'POST',
          headers: { authorization: `Bearer ${(await store.get(KEYS.tokenFor(entry.via))) || ''}` },
        });
        if (res.ok) {
          const made = await res.json();
          if (made?.url) {
            await store.set(KEYS.hub, hub);
            window.location.assign(withOrigin(made.url, origin));
            return;
          }
        }
      } catch {
        /* fall through */
      }
    }
    await store.set(KEYS.hub, hub);
    window.location.assign(withOrigin(`${hub}/`, origin));
  }

  /**
   * Reachability probe. `no-cors` is deliberate: the hub sends no CORS headers,
   * so a normal fetch could never read a response. An opaque fetch still proves
   * a live HTTP listener, which is all "is it up?" needs. /api/auth is used
   * because it is the one API path that answers without a credential.
   */
  async function probe(hub) {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), PROBE_TIMEOUT_MS);
    try {
      await fetch(`${hub}/api/auth`, {
        mode: 'no-cors',
        cache: 'no-store',
        credentials: 'omit',
        signal: controller.signal,
      });
      return true;
    } catch {
      return false;
    } finally {
      clearTimeout(timer);
    }
  }

  async function loadInfo() {
    try {
      const res = await fetch('shell-info.json', { cache: 'no-store' });
      if (res.ok) state.info = await res.json();
    } catch {
      state.info = null;
    }
    return state.info;
  }

  function shellLabel() {
    const info = state.info;
    if (!info) return '未知';
    const when = String(info.builtAt || '').replace('T', ' ').replace(/\..*$/, '');
    return `v${info.shellVersion} · ${when} UTC`;
  }

  function setStatus(text, tone) {
    dom.currentStatus.textContent = text;
    dom.currentStatus.className = `pill${tone === 'warn' ? ' warn' : ''}`;
  }

  // ---------------------------------------------------------------- screens
  function showConnect(prefill) {
    setError('');
    dom.hubUrl.value = prefill !== undefined ? prefill : state.hub || '';
    dom.hubCode.value = '';
    show('connect');
    if (!prefill && !state.hub) dom.hubUrl.focus();
  }

  function showConnected() {
    // The app opens on the machine list: every hub this phone has paired with,
    // with its live state, so a switched-off computer is obvious instead of a
    // dead button.
    if (dom.currentHub) dom.currentHub.textContent = state.hub || '—';
    if (dom.shellVersion) dom.shellVersion.textContent = shellLabel();
    if (dom.currentStatus) setStatus('检测中…', 'warn');
    show('connected');
    void renderMachines().then(() => mergePeerMachines());
    void refreshStatus();
    // Keep the online/offline tags honest while this screen is open.
    if (showConnected._timer) clearInterval(showConnected._timer);
    showConnected._timer = setInterval(() => {
      if (state.view === 'connected') void renderMachines();
    }, 15000);
  }

  function showOffline(reason) {
    dom.offlineDetail.textContent =
      reason || 'Hub 没有响应。App 本身没问题，只是看不见你那台电脑。';
    dom.offlineUrl.textContent = state.hub || '—';
    show('offline');
  }

  /** Ask the hub whether it is there, and update the pill without blocking the UI. */
  async function refreshStatus() {
    const id = ++state.probeId;
    const hub = state.hub;
    if (!hub) return;
    const up = await probe(hub);
    if (id !== state.probeId || state.view !== 'connected') return;
    setStatus(up ? '在线' : '连不上', up ? 'ok' : 'warn');
  }

  // ------------------------------------------------------------------ actions
  /**
   * Pair this phone with a hub from the app itself, and keep the device token.
   * The app's own screen (app.html) then talks to the HTTP API directly with
   * `Authorization: Bearer <token>` - no cookie, no cross-site cookie rules.
   */
  async function pairWithHub(hub, code) {
    const res = await fetch(`${hub}/api/pair`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ code, client: 'app' }),
    });
    const data = await res.json().catch(() => null);
    if (res.status === 401) throw new Error('配对码不对，或者这个链接已经过期了。');
    if (res.status === 409) throw new Error('这台电脑还没有打开「允许手机连接」。');
    if (!res.ok || !data?.token) {
      throw new Error((data && data.error && data.error.message) || `配对失败（${res.status}）`);
    }
    return data;
  }

  /** Pair (when a code came with it) and go into that machine's full UI. */
  async function openChat(hub, code) {
    show('booting');
    dom.bootingText.textContent = code ? '正在配对…' : '正在打开夜班…';
    dom.bootingUrl.textContent = hub;
    state.hub = hub;
    const up = await probe(hub);
    if (state.view !== 'booting') return; // user cancelled
    if (!up) {
      showOffline(`${hub} 没有响应。`);
      return;
    }
    if (code) {
      const paired = await pairWithHub(hub, code);
      await store.set(KEYS.tokenFor(hub), paired.token);
      if (paired.device?.id) await store.set('desk.deviceId', paired.device.id);
    } else if (!(await store.get(KEYS.tokenFor(hub)))) {
      // No token yet: the hub's own UI has the pairing form.
      await store.set(KEYS.hub, hub);
      window.location.assign(hubUrlFor(hub, ''));
      return;
    }
    await enterMachine({ url: hub, name: state.machineName || hostLabel(hub) });
  }

  /** A pair link from the computer's QR code: https://host:port/?pair=TOKEN */
  async function connectFromScan(raw) {
    const text = String(raw || '').trim();
    if (!text) {
      setError('没扫到内容，再试一次。');
      return;
    }
    let url;
    try {
      url = new URL(/^[a-z][a-z0-9+.-]*:\/\//i.test(text) ? text : `http://${text}`);
    } catch {
      setError(`这个码不是夜班的连接码：${text.slice(0, 80)}`);
      return;
    }
    const hub = url.origin;
    const token = url.searchParams.get('pair') || '';
    await rememberHub(hub);
    await renderMachines();
    try {
      await openChat(hub, token);
    } catch (err) {
      setError(err.message || String(err));
      showConnect(hub);
    }
  }

  /**
   * The MLKit scanner ships as a Google module that the OS downloads on demand.
   * On phones without Google Play services (very common in China) that download
   * never succeeds, so check first and say so instead of throwing an English
   * stack at the user.
   */
  async function ensureBarcodeModule() {
    if (!scanner) return false;
    try {
      const check = scanner.isGoogleBarcodeScannerModuleAvailable;
      if (typeof check === 'function') {
        const state = await check.call(scanner);
        if (state && state.available) return true;
      } else {
        return true; // older plugin: no module split, just scan
      }
      if (typeof scanner.installGoogleBarcodeScannerModule === 'function') {
        await scanner.installGoogleBarcodeScannerModule.call(scanner);
        const again = typeof check === 'function' ? await check.call(scanner) : null;
        return Boolean(again && again.available);
      }
    } catch (err) {
      console.warn('[desk] barcode module unavailable', err);
    }
    return false;
  }

  async function scanToConnect() {
    setError('');
    if (!scanner) {
      setError('这个版本没有扫码模块（例如网页预览）。请手动填地址，或在手机浏览器里打开电脑上的二维码链接。');
      return;
    }
    if (dom.scanBtn) dom.scanBtn.disabled = true;
    try {
      const permission = await scanner.requestPermissions().catch(() => null);
      if (permission && permission.camera !== 'granted' && permission.camera !== 'limited') {
        setError('没有相机权限，扫不了码。到系统设置里给夜班打开「相机」再试一次。');
        return;
      }
      if (!(await ensureBarcodeModule())) {
        setError(
          '这台手机的扫码组件还没装好（需要 Google 条码扫描模块，国内机型通常下载不到）。\n' +
            '下面直接填地址也能连，或者在手机浏览器里打开电脑上那个二维码链接。',
        );
        dom.hubUrl?.focus();
        return;
      }
      const result = await scanner.scan({ formats: ['QR_CODE'] });
      const value = result?.barcodes?.[0]?.rawValue || '';
      await connectFromScan(value);
    } catch (err) {
      const message = String(err?.message || err || '');
      if (/barcode scanner module/i.test(message)) {
        setError(
          '这台手机的扫码组件还没装好（需要 Google 条码扫描模块，国内机型通常下载不到）。\n' +
            '下面直接填地址也能连，或者在手机浏览器里打开电脑上那个二维码链接。',
        );
        dom.hubUrl?.focus();
        return;
      }
      setError(
        /cancel/i.test(message)
          ? '扫码已取消。'
          : `扫码没成功：${message}\n如果一直这样，手动填电脑上显示的地址也能连。`,
      );
    } finally {
      if (dom.scanBtn) dom.scanBtn.disabled = false;
    }
  }

  async function connectFromForm() {
    setError('');
    let hub;
    try {
      hub = normalizeHub(dom.hubUrl.value);
    } catch (err) {
      setError(err.message);
      return;
    }
    const code = dom.hubCode.value.trim();
    dom.connectBtn.disabled = true;
    dom.connectBtn.textContent = '连接中…';
    try {
      const up = await probe(hub);
      if (!up) {
        state.hub = hub;
        showOffline(
          `${hub} 没有响应。\n确认那边夜班是用 ASSIST_ALLOW_REMOTE=1 HOST=0.0.0.0 起的，` +
            '手机和电脑在同一个网络，防火墙放行了这个端口。',
        );
        return;
      }
      await rememberHub(hub);
      dom.hubCode.value = '';
      await renderMachines();
      await openChat(hub, code);
    } catch (err) {
      setError(err.message || String(err));
    } finally {
      dom.connectBtn.disabled = false;
      dom.connectBtn.textContent = '连接并打开';
    }
  }

  // ------------------------------------------------------------------- wiring
  dom.connectForm.addEventListener('submit', (event) => {
    event.preventDefault();
    void connectFromForm();
  });

  dom.scanBtn.addEventListener('click', () => {
    void scanToConnect();
  });

  dom.pasteBtn.addEventListener('click', async () => {
    try {
      const text = await navigator.clipboard.readText();
      if (text && text.trim()) {
        dom.hubUrl.value = text.trim();
        setError('');
      }
    } catch {
      dom.hubUrl.focus();
    }
  });

  dom.previewBtn.addEventListener('click', () => {
    // The bundled copy of public/ (www/ui). No hub, so no data — it is there to
    // prove what the shell packaged, not to be useful.
    window.location.assign('ui/index.html');
  });

  dom.openBtn?.addEventListener('click', () => {
    if (state.hub) void openChat(state.hub, '');
  });

  dom.changeBtn.addEventListener('click', () => showConnect(state.hub));
  dom.forgetBtn.addEventListener('click', async () => {
    if (state.hub) await forgetHub(state.hub);
    else await store.remove(KEYS.hub);
    state.hub = '';
    dom.connectForm.reset();
    await renderMachines();
    showConnect('');
  });

  dom.bootingCancel.addEventListener('click', () => {
    if (state.hub) showConnected();
    else showConnect('');
  });

  dom.offlineRetry.addEventListener('click', () => {
    if (state.hub) void openChat(state.hub, '');
    else showConnect('');
  });
  dom.offlineChange.addEventListener('click', () => showConnect(state.hub));

  // -------------------------------------------------------------------- boot
  async function boot() {
    await loadInfo();
    dom.foot.textContent = `Nightshift mobile · ${shellLabel()}${isNative ? '' : ' · web preview'}`;
    if (dom.scanBtn) dom.scanBtn.hidden = false;

    const hub = await store.get(KEYS.hub);
    if (hub) {
      try {
        state.hub = normalizeHub(hub);
      } catch {
        state.hub = '';
      }
    }
    await renderMachines();
    if (state.hub) {
      showConnected();
      return;
    }
    showConnect('');
  }

  // The app came back to the foreground and the launchpad is showing: re-check.
  if (app && typeof app.addListener === 'function') {
    app.addListener('appStateChange', ({ isActive }) => {
      if (isActive && state.view === 'connected') void refreshStatus();
    });
  }

  boot().catch((err) => {
    console.error('[desk] boot failed', err);
    showConnect('');
    setError(`外壳启动失败：${err && err.message ? err.message : err}`);
  });

  // Exposed for `npm run check:shell` and for `chrome://inspect` on a device.
  window.__deskShell = {
    isNative,
    plugins: Object.keys(plugins),
    normalizeHub,
    state: () => ({ view: state.view, hub: state.hub, info: state.info }),
  };})();
