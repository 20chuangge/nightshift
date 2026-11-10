/* chat.js — the native chat screen of the Nightshift app (Android).
 *
 * Why this exists: the WebView loading the hub's own UI works but is a website
 * in a box. This screen talks to the same HTTP API with the device token the app
 * got when it paired, so it can stream, keep local state, and later show
 * notifications without a browser in between.
 *
 * Contract with the launcher (launcher.js):
 *   Preferences 'desk.hubUrl'  -> http://192.168.1.4:14390
 *   Preferences 'desk.token'   -> the device session token (Bearer)
 *   Preferences 'desk.botId'   -> last bot
 *
 * API used here (all Bearer):
 *   GET  /api/bots                       roster
 *   GET  /api/bots/:id/messages?limit=   transcript
 *   POST /api/bots/:id/message {text}    send, returns {turnId}
 *   GET  /api/stream?botId=              SSE: turn.start, message.delta, message,
 *                                        tool.*, approval.request, approval.resolved ...
 *   GET  /api/approvals?status=pending   cards to answer
 *   POST /api/approvals/:id {decision}   approve / deny
 *   GET  /api/health                     online + version
 */
(() => {
  'use strict';

  const $ = (id) => document.getElementById(id);
  const KEYS = { hub: 'desk.hubUrl', bot: 'desk.botId' };
  /** Tokens are per hub: switching machines must not reuse another one's. */
  const tokenKey = (hub) => `desk.token:${hub}`;
  const cap = window.Capacitor || null;
  const plugins = (cap && cap.Plugins) || {};
  const prefs = plugins.Preferences || null;
  const app = plugins.App || null;

  const store = {
    async get(key) {
      if (prefs) {
        try {
          const res = await prefs.get({ key });
          if (res && typeof res.value === 'string') return res.value;
        } catch {
          /* fall through */
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
        } catch {
          /* fall through */
        }
      }
      try {
        window.localStorage.setItem(key, value);
      } catch {
        /* ignore */
      }
    },
    async remove(key) {
      if (prefs) {
        try {
          await prefs.remove({ key });
        } catch {
          /* ignore */
        }
      }
      try {
        window.localStorage.removeItem(key);
      } catch {
        /* ignore */
      }
    },
  };

  const state = {
    hub: '',
    token: '',
    botId: '',
    bots: [],
    machineName: '',
    streaming: null, // { node, text }
    streamAbort: null,
    retry: 0,
    drafts: {},
  };

  // ------------------------------------------------------------------ helpers
  const esc = (s) => String(s ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c]);

  /** Minimal markdown: code fences, inline code, bold, tables, line breaks. */
  function render(text) {
    const src = String(text ?? '');
    const parts = src.split(/```/);
    let html = '';
    parts.forEach((part, index) => {
      if (index % 2 === 1) {
        const body = part.replace(/^[a-zA-Z0-9+#-]*\n/, '');
        html += `<pre><code>${esc(body.replace(/\n$/, ''))}</code></pre>`;
        return;
      }
      html += renderBlocks(part);
    });
    return html;
  }

  function renderBlocks(text) {
    const lines = text.split('\n');
    const out = [];
    let table = [];
    const flush = () => {
      if (!table.length) return;
      const cells = (line) => line.replace(/^\s*\|/, '').replace(/\|\s*$/, '').split('|').map((c) => c.trim());
      const head = cells(table[0]);
      const body = table.slice(1).filter((r) => !/^\s*\|?[\s:-]+\|/.test(r));
      out.push(
        `<div class="md-table"><table><thead><tr>${head.map((c) => `<th>${inline(c)}</th>`).join('')}</tr></thead><tbody>`
        + body.map((r) => `<tr>${cells(r).map((c) => `<td>${inline(c)}</td>`).join('')}</tr>`).join('')
        + '</tbody></table></div>',
      );
      table = [];
    };
    for (const line of lines) {
      if (/^\s*\|.*\|\s*$/.test(line)) {
        table.push(line);
        continue;
      }
      flush();
      if (!line.trim()) {
        out.push('<br>');
        continue;
      }
      if (/^#{1,4}\s+/.test(line)) {
        out.push(`<strong>${inline(line.replace(/^#{1,4}\s+/, ''))}</strong><br>`);
        continue;
      }
      if (/^\s*([-*+]|\d+[.)])\s+/.test(line)) {
        out.push(`• ${inline(line.replace(/^\s*([-*+]|\d+[.)])\s+/, ''))}<br>`);
        continue;
      }
      out.push(`${inline(line)}<br>`);
    }
    flush();
    return out.join('');
  }

  function inline(text) {
    return esc(text)
      .replace(/`([^`]+)`/g, '<code>$1</code>')
      .replace(/\*\*([^*]+)\*\*/g, '<strong>$1</strong>');
  }

  async function api(pathname, options = {}) {
    if (!state.hub) throw new Error('没有配置 Hub');
    const res = await fetch(`${state.hub}${pathname}`, {
      ...options,
      headers: {
        authorization: `Bearer ${state.token}`,
        ...(options.body !== undefined ? { 'content-type': 'application/json' } : {}),
        ...(options.headers || {}),
      },
    });
    if (res.status === 401) {
      await store.remove(tokenKey(state.hub));
      banner('这台设备需要重新配对。');
      throw Object.assign(new Error('需要重新配对'), { code: 'AUTH' });
    }
    const text = await res.text();
    let json = null;
    try {
      json = text ? JSON.parse(text) : null;
    } catch {
      /* not json */
    }
    if (!res.ok) throw new Error((json && json.error && json.error.message) || `${res.status}`);
    return json;
  }

  function banner(text) {
    const node = $('banner');
    if (!node) return;
    if (!text) {
      node.hidden = true;
      node.textContent = '';
      return;
    }
    node.hidden = false;
    node.textContent = text;
  }

  function scrollToEnd() {
    const main = $('messages');
    main.scrollTop = main.scrollHeight;
  }

  function bubble(role, text, extra = '') {
    const node = document.createElement('div');
    node.className = `msg ${role} ${extra}`;
    node.innerHTML = render(text);
    return node;
  }

  // ------------------------------------------------------------------ renders
  function renderBots() {
    const bar = $('bots');
    if (!state.bots.length) {
      bar.hidden = true;
      return;
    }
    bar.hidden = state.bots.length < 2;
    bar.textContent = '';
    for (const bot of state.bots) {
      const button = document.createElement('button');
      button.type = 'button';
      button.textContent = bot.name + (bot.primary ? ' · 主' : '');
      button.classList.toggle('active', bot.id === state.botId);
      button.addEventListener('click', () => selectBot(bot.id));
      bar.appendChild(button);
    }
  }

  function setWho() {
    const bot = state.bots.find((b) => b.id === state.botId);
    $('who-name').textContent = bot ? bot.name : 'Nightshift';
    const machine = $('who-machine');
    const label = state.machineName || state.hub.replace(/^https?:\/\//, '');
    machine.innerHTML = `<span class="dot" id="who-dot"></span>${esc(label)}`;
  }

  function setOnline(on) {
    const dot = $('who-dot');
    if (dot) dot.className = `dot ${on ? 'on' : 'off'}`;
  }

  function approvalCard(event) {
    const node = document.createElement('div');
    node.className = 'card';
    node.dataset.approval = event.approvalId || '';
    node.innerHTML = `
      <div class="title">要你同意：${esc(event.tool || '工具')}</div>
      <div class="body">${esc(event.reason || '这一步会动到你的东西。')}</div>
      <div class="body"><pre>${esc(JSON.stringify(event.args || {}, null, 2).slice(0, 600))}</pre></div>
      <div class="row">
        <button class="no" type="button">拒绝</button>
        <button class="ok" type="button">批准</button>
      </div>`;
    const decide = async (decision) => {
      const buttons = node.querySelectorAll('button');
      buttons.forEach((b) => (b.disabled = true));
      try {
        await api(`/api/approvals/${encodeURIComponent(event.approvalId)}`, {
          method: 'POST',
          body: JSON.stringify({ decision }),
        });
        node.classList.add('done');
        node.querySelector('.body').textContent = decision === 'approve' ? '已批准，继续。' : '已拒绝。';
      } catch (err) {
        node.querySelector('.body').textContent = `没能提交：${err.message}`;
        buttons.forEach((b) => (b.disabled = false));
      }
    };
    node.querySelector('.ok').addEventListener('click', () => decide('approve'));
    node.querySelector('.no').addEventListener('click', () => decide('deny'));
    return node;
  }

  // ------------------------------------------------------------------ actions
  async function loadBots() {
    const bots = await api('/api/bots');
    state.bots = Array.isArray(bots) ? bots : bots?.bots || [];
    const saved = await store.get(KEYS.bot);
    const exists = state.bots.some((b) => b.id === saved);
    state.botId = exists ? saved : state.bots.find((b) => b.primary)?.id || state.bots[0]?.id || '';
    renderBots();
    setWho();
  }

  async function selectBot(botId) {
    if (botId === state.botId) return;
    state.botId = botId;
    await store.set(KEYS.bot, botId);
    renderBots();
    setWho();
    await loadMessages();
    connectStream();
  }

  async function loadMessages() {
    const main = $('messages');
    main.textContent = '<div class="empty">正在读取…</div>';
    const items = await api(`/api/bots/${encodeURIComponent(state.botId)}/messages?limit=120`);
    main.textContent = '';
    if (!Array.isArray(items) || !items.length) {
      const empty = document.createElement('div');
      empty.className = 'empty';
      empty.innerHTML = '还没有对话。<br>说一句要做什么就行。';
      main.appendChild(empty);
      return;
    }
    const answers = new Set();
    items
      .filter((item) => item.role === 'approval' && item.approvalId)
      .forEach((item) => answers.add(`${item.approvalId}:${item.decision || ''}`));
    for (const item of items) {
      if (item.role === 'user') main.appendChild(bubble('user', item.text));
      else if (item.role === 'assistant') main.appendChild(bubble(item.system ? 'system' : 'assistant', item.text));
      else if (item.role === 'tool' && item.needsApproval) {
        const answered = [...answers].some((key) => key.startsWith(`${item.approvalId}:`) && !key.endsWith(':'));
        const card = approvalCard({ approvalId: item.approvalId, tool: item.name, reason: item.reason, args: item.args });
        if (item.decision || answered) {
          card.classList.add('done');
          card.querySelector('.body').textContent = `已${item.decision === 'denied' ? '拒绝' : '批准'}。`;
          card.querySelectorAll('button').forEach((b) => (b.disabled = true));
        }
        main.appendChild(card);
      }
    }
    scrollToEnd();
  }

  async function loadPending() {
    try {
      const data = await api(`/api/approvals?status=pending&botId=${encodeURIComponent(state.botId)}`);
      const pending = Array.isArray(data) ? data : data?.approvals || [];
      for (const record of pending) {
        if (document.querySelector(`[data-approval="${record.id}"]`)) continue;
        $('messages').appendChild(
          approvalCard({ approvalId: record.id, tool: record.toolName, reason: record.reason, args: record.args }),
        );
      }
      if (pending.length) scrollToEnd();
    } catch {
      /* list is a nicety */
    }
  }

  async function send() {
    const box = $('text');
    const text = box.value.trim();
    if (!text || !state.botId) return;
    box.value = '';
    box.style.height = 'auto';
    $('empty')?.remove();
    $('messages').appendChild(bubble('user', text));
    scrollToEnd();
    $('send').disabled = true;
    try {
      await api(`/api/bots/${encodeURIComponent(state.botId)}/message`, {
        method: 'POST',
        body: JSON.stringify({ text }),
      });
    } catch (err) {
      banner(`没发出去：${err.message}`);
    } finally {
      $('send').disabled = false;
    }
  }

  // ---------------------------------------------------------------- streaming
  function streamUrl() {
    return `${state.hub}/api/stream?botId=${encodeURIComponent(state.botId)}`;
  }

  async function connectStream() {
    if (state.streamAbort) state.streamAbort.abort();
    if (!state.hub || !state.token || !state.botId) return;
    state.streamAbort = new AbortController();
    try {
      const res = await fetch(streamUrl(), {
        headers: { authorization: `Bearer ${state.token}`, accept: 'text/event-stream' },
        signal: state.streamAbort.signal,
      });
      if (!res.ok || !res.body) throw new Error(`stream ${res.status}`);
      setOnline(true);
      banner('');
      state.retry = 0;
      const reader = res.body.getReader();
      const decoder = new TextDecoder();
      let buffer = '';
      for (;;) {
        const { value, done } = await reader.read();
        if (done) break;
        buffer += decoder.decode(value, { stream: true });
        let cut;
        while ((cut = buffer.indexOf('\n\n')) !== -1) {
          const frame = buffer.slice(0, cut);
          buffer = buffer.slice(cut + 2);
          for (const line of frame.split('\n')) {
            if (!line.startsWith('data: ')) continue;
            let event;
            try {
              event = JSON.parse(line.slice(6));
            } catch {
              continue;
            }
            onEvent(event);
          }
        }
      }
      throw new Error('流断开了');
    } catch (err) {
      if (state.streamAbort?.signal.aborted) return;
      setOnline(false);
      banner(`连接断了，正在重连…（${err.message}）`);
      state.retry = Math.min(state.retry + 1, 6);
      setTimeout(() => connectStream(), 1000 * state.retry);
    }
  }

  function onEvent(event) {
    if (!event || !event.type) return;
    const main = $('messages');
    if (event.type === 'turn.start') {
      $('empty')?.remove();
      const node = bubble('assistant', '', 'streaming');
      main.appendChild(node);
      state.streaming = { node, text: '' };
      scrollToEnd();
      return;
    }
    if (event.type === 'message.delta') {
      if (!state.streaming) {
        const node = bubble('assistant', '', 'streaming');
        main.appendChild(node);
        state.streaming = { node, text: '' };
      }
      state.streaming.text += event.text || '';
      state.streaming.node.innerHTML = render(state.streaming.text);
      scrollToEnd();
      return;
    }
    if (event.type === 'message' && event.final) {
      $('empty')?.remove();
      const role = event.system ? 'system' : 'assistant';
      if (state.streaming) {
        state.streaming.node.className = `msg ${role}`;
        state.streaming.node.innerHTML = render(event.text);
        state.streaming = null;
      } else {
        main.appendChild(bubble(role, event.text));
      }
      scrollToEnd();
      return;
    }
    if (event.type === 'approval.request') {
      main.appendChild(approvalCard(event));
      scrollToEnd();
      return;
    }
    if (event.type === 'approval.decided' || event.type === 'approval.resolved') {
      const card = document.querySelector(`[data-approval="${event.approvalId}"]`);
      if (card) {
        card.classList.add('done');
        const body = card.querySelector('.body');
        if (body) body.textContent = event.decision === 'deny' || event.status === 'denied' ? '已拒绝。' : '已批准。';
        card.querySelectorAll('button').forEach((b) => (b.disabled = true));
      }
      return;
    }
    if (event.type === 'turn.end') {
      if (state.streaming) {
        state.streaming.node.classList.remove('streaming');
        state.streaming = null;
      }
      if (event.status && event.status !== 'success') banner(event.summary || `这一轮结束了：${event.status}`);
      return;
    }
    // tool.*, roster.changed, ... are not rendered yet (the full UI has them).
  }

  // -------------------------------------------------------------------- boot
  async function boot() {
    state.hub = ((await store.get(KEYS.hub)) || '').replace(/\/+$/, '');
    state.token = (await store.get(tokenKey(state.hub))) || '';
    if (!state.hub || !state.token) {
      banner('还没有连上 Hub，回到上一屏填地址和配对码。');
      setTimeout(() => window.location.assign('index.html'), 1200);
      return;
    }
    try {
      const health = await api('/api/health');
      setOnline(Boolean(health?.ok));
      if (health?.version) $('who-machine').innerHTML = `<span class="dot on" id="who-dot"></span>${esc(health.version)}`;
    } catch (err) {
      setOnline(false);
      banner(`连不上 Hub（${err.message}）。`);
    }
    // Name the machine the way the hub does (hostname), not by its address.
    try {
      const data = await api('/api/machines');
      const mine = (data?.machines || []).find((m) => m.self);
      if (mine?.name) state.machineName = mine.name;
    } catch {
      /* the address is a fine fallback */
    }
    try {
      await loadBots();
      await loadMessages();
      await loadPending();
      connectStream();
    } catch (err) {
      banner(`加载失败：${err.message}`, true);
    }
  }

  $('back').addEventListener('click', () => window.location.assign('index.html'));
  // The full web UI lives on the hub and needs its own session cookie. Mint a
  // one-time pairing link (we are authenticated) and open that, so the phone
  // lands inside the complete UI instead of its pairing screen.
  $('full').addEventListener('click', async () => {
    try {
      const made = await api('/api/pairing/link', { method: 'POST' });
      const links = Array.isArray(made?.links) ? made.links : [];
      const wantsTailnet = /^100\./.test(location.hostname);
      const pick = links.find((l) => l.kind === (wantsTailnet ? 'tailnet' : 'lan')) || links[0];
      const target = pick?.url || made?.url;
      if (target) {
        window.location.assign(target);
        return;
      }
    } catch {
      /* fall through to the plain address */
    }
    window.location.assign(state.hub);
  });
  $('send').addEventListener('click', send);
  $('text').addEventListener('focus', () => setTimeout(scrollToEnd, 250));
  $('text').addEventListener('input', (event) => {
    const node = event.target;
    node.style.height = 'auto';
    node.style.height = `${Math.min(node.scrollHeight, 140)}px`;
    state.drafts[state.botId] = node.value;
  });
  $('text').addEventListener('keydown', (event) => {
    if (event.key === 'Enter' && !event.shiftKey) {
      event.preventDefault();
      send();
    }
  });
  document.addEventListener('visibilitychange', () => {
    if (document.visibilityState === 'visible') connectStream();
  });
  if (app && typeof app.addListener === 'function') {
    app.addListener('appStateChange', ({ isActive }) => {
      if (isActive) connectStream();
    });
  }

  boot();

  // For scripts/check-android-app.mjs.
  window.__deskChat = { state, send, loadMessages };
})();
