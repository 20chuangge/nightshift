/**
 * server.mjs - node:http, no framework, no dependencies.
 *
 * REST for state, SSE for liveness. Every route returns JSON (except the static
 * files) and every failure returns { error: { code, message } } with a real
 * status code, so the UI never has to guess.
 *
 * Start:  node src/server.mjs        (PORT=0 picks a free port)
 * Ready:  prints one line of JSON {"event":"ready","port":N,...} on stdout, which
 *         is what scripts/smoke.mjs parses. Human logging goes to stderr.
 */

import http from 'node:http';
import net from 'node:net';
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import fsp from 'node:fs/promises';
import { pathToFileURL } from 'node:url';

import {
  P,
  ensureDirs,
  uid,
  nowIso,
  EventBus,
  readAudit,
  readJsonl,
  readJsonSync,
  writeJsonSyncAtomic,
  appendJsonl,
  sessionFile,
  audit,
} from './store.mjs';
import {
  loadAssistantConfig,
  listBots,
  getBot,
  createBot,
  updateBot,
  deleteBot,
  setPrimaryBot,
  lastMessagePreview,
  findAvatarFile,
  avatarMimeForExt,
  saveAvatarImage,
  removeAvatarImage,
  AVATAR_MAX_BYTES,
  AVATAR_MIME_TYPES,
  migrateSeedGrants,
  migrateBuiltinNames,
  writeAssistantConfig,
} from './bots.mjs';
import { computerSnapshot, captureScreen } from './computer.mjs';
import { createRegistry } from './tools.mjs';
import { ApprovalQueue, effectivePolicy, APPROVAL_LEVELS, phraseToPattern } from './approvals.mjs';
import { normalizeRule } from './rules.mjs';
import { RoutineStore } from './routines.mjs';
import { AgentRuntime, recoverInterruptedTurns } from './agent.mjs';
import * as memory from './memory.mjs';
import * as skills from './skills.mjs';
import * as groups from './groups.mjs';
import * as settingsModule from './settings.mjs';
import { publicProviderCatalogue } from './providers.mjs';
import { configure as configureDesktops, desktopInfo, desktopSupport, ensureDesktop, listDesktops, stopDesktop } from './desktops.mjs';
import { createProvisioner } from './remote.mjs';
import { bridgeWebSocket } from './wsbridge.mjs';
import * as voiceModule from './voice.mjs';
import * as visionModule from './vision.mjs';
import * as mediaModule from './media.mjs';
import { createVideoJobs } from './videojobs.mjs';
import { createFeishu } from './feishu.mjs';
import { listVault, putVault, deleteVault } from './vault.mjs';
import { createAttention } from './attention.mjs';
import * as modelsModule from './models.mjs';
import { applyUpdate, compareVersions, installedSetupVersion, shippedSetupVersion, UPDATE_MAX_BYTES } from './selfupdate.mjs';
import { packApp, cleanupPack } from './bundle.mjs';
import {
  evaluateAuth,
  isAuthExemptPath,
  isPublicShellPath,
  isLoopbackHost,
  clientIp,
  safeEqual,
  sessionCookieHeader,
  createRateLimiter,
  loadOrCreateSecurity,
  listLanAddresses,
  preferredLanAddress,
  lanUrlFor,
} from './auth.mjs';

// One version for the hub and the app: package.json (shipped with every hub).
const VERSION = (() => {
  try {
    return JSON.parse(fs.readFileSync(new URL('../package.json', import.meta.url), 'utf8')).version || '0.0.0';
  } catch {
    return '0.0.0';
  }
})();
const HOST = process.env.HOST || '127.0.0.1';
const DEFAULT_PORT = Number(process.env.PORT ?? 4390);
const MAX_BODY_BYTES = 1024 * 1024;

/** ASSIST_ALLOW_REMOTE=1 is the only way to expose this beyond loopback. */
function remoteAccessAllowed() {
  const value = String(process.env.ASSIST_ALLOW_REMOTE || '').toLowerCase();
  return value === '1' || value === 'true' || value === 'yes';
}

// ---------------------------------------------------------------------------
// bootstrap
// ---------------------------------------------------------------------------

/** Wire every module together. Exported so scripts/smoke.mjs could embed it too. */
export async function createAssistant({ port = DEFAULT_PORT, host = HOST } = {}) {
  await ensureDirs();

  // New releases add tools; existing installs only get them through this
  // additive migration (config seeds are copy-if-missing).
  const renamed = await migrateBuiltinNames();
  if (renamed) console.log(`[assistant] renamed ${renamed} built-in bot(s)`);
  const migrated = await migrateSeedGrants();
  if (migrated) console.log(`[assistant] migrated seed grants for ${migrated} bot(s)`);

  const config = await loadAssistantConfig();
  const workspaceDir = P.workspaceDir;
  config.workspaceDir = workspaceDir;

  // Settings + secret are read once at boot; PUT /api/settings rewrites both and
  // swaps the live model client without a restart.
  const settings = await settingsModule.loadSettings();
  const apiKey = await settingsModule.loadSecret();
  const voice = await voiceModule.loadVoice();
  const vision = await visionModule.loadVision();
  const media = await mediaModule.loadMedia();
  const security = await loadOrCreateSecurity();

  const bus = new EventBus();
  const attention = createAttention({ file: path.join(P.dataDir, 'attention.json'), bus });
  await attention.load();
  const approvals = new ApprovalQueue({
    timeoutMs: Number(config.policy.approvalTimeoutMs) || 10 * 60 * 1000,
    onAudit: (record) => audit(record),
    // Durability over cleverness: the pending list is written synchronously so a
    // kill -9 between "card shown" and "human clicks" cannot lose the card.
    onPersist: (records) => {
      try {
        writeJsonSyncAtomic(P.pendingFile, { updatedAt: nowIso(), approvals: records });
      } catch (err) {
        console.error('[approvals] could not write pending file:', err.message);
      }
    },
  });

  // Late-bound references: the routine runner needs the runtime, the
  // bot_message tool needs the runtime, and the registry is needed to build it.
  const refs = { runtime: null, routines: null, app: null };
  // A machine this one sets up gets this one's model, so it works at once.
  const provisioner = createProvisioner({
    modelToShare: () => {
      const s = state?.settings;
      if (!s?.provider || s.provider === 'mock') return null;
      return { provider: s.provider, baseUrl: s.baseUrl, model: s.model, apiKey: state.apiKey || '' };
    },
    voiceToShare: () => {
      const v = state?.voice;
      return v?.apiKey ? { baseUrl: v.baseUrl, model: v.model, apiKey: v.apiKey } : null;
    },
    visionToShare: () => {
      const v = state?.vision;
      return v?.apiKey ? { baseUrl: v.baseUrl, model: v.model, apiKey: v.apiKey } : null;
    },
  });

  // Per-bot desktops read the VNC password the installer stored, if any.
  configureDesktops({ dataDir: P.dataDir });

  const registry = createRegistry({
    workspaceDir,
    config,
    getRuntime: () => {
      if (!refs.runtime) throw new Error('agent runtime is not ready yet');
      return refs.runtime;
    },
    getRoutines: () => {
      if (!refs.routines) throw new Error('routines are not ready yet');
      return refs.routines;
    },
    // Resolved at call time: settings, voice and vision keys can change live.
    getVision: () => (refs.getVision ? refs.getVision() : null),
    getMedia: (kind) => (refs.getMedia ? refs.getMedia(kind) : null),
    getVideoJobs: () => refs.videoJobs || null,
  });

  const model = settingsModule.createModelFromSettings(settings, apiKey);
  // The memory/skills modules are already exactly the surface the tools and the
  // agent need, so they are passed through as namespaces.
  const memoryApi = memory;
  const skillsApi = skills;

  const routines = new RoutineStore({
    config,
    tickMs: 20000,
    runner: async (routine) => {
      const result = await refs.runtime.runTurn({
        botId: routine.botId,
        text: routine.instruction,
        source: 'routine',
        unattended: true,
      });
      return result;
    },
  });
  refs.routines = routines;

  // The agent's bot/group tools call exactly the same functions as the REST
  // routes, so a bot-created group and a UI-created group are the same thing.
  const botsApi = { listBots, getBot, createBot, updateBot, deleteBot };
  const runtime = new AgentRuntime({
    config,
    registry,
    model,
    bots: botsApi,
    groups,
    memory: memoryApi,
    skills: skillsApi,
    approvals,
    bus,
    getApp: () => refs.app,
  });
  refs.runtime = runtime;

  // --- crash recovery ------------------------------------------------------
  // Restore cards a human had not answered yet, and explain every turn the
  // previous process did not get to finish.
  const savedPending = readJsonSync(P.pendingFile, null);
  if (savedPending?.approvals?.length) {
    const restored = approvals.restore(savedPending.approvals);
    if (restored) console.error(`[assistant] restored ${restored} pending approval(s) from the previous run`);
  }
  const recoveredTurns = await recoverInterruptedTurns({ bus });
  if (recoveredTurns.length) {
    console.error(`[assistant] marked ${recoveredTurns.length} interrupted turn(s) as needs_attention`);
  }

  await routines.load();
  routines.start();

  // Each bot may talk to its own model (Settings → 模型 → 其他模型).
  runtime.modelFor = (bot) => modelsModule.modelForBot(bot);

  const state = {
    config,
    bus,
    approvals,
    attention,
    routines,
    registry,
    runtime,
    model,
    settings,
    apiKey, // never projected into a response; only `hasKey` leaves this module
    voice, // speech-to-text config; its key is write-only too
    vision, // image-understanding config; same rules
    media, // image / video generation config; same rules
    security,
    workspaceDir,
    startedAt: Date.now(),
    host,
    port,
    lanUrl: null,
    pairingUrl: null,
    requireAuth: true,
    pairLimiter: createRateLimiter({ limit: 5, windowMs: 60_000 }),
    recoveredTurns,
    provisioner,
    uiState: {
      theme: null,
      timezoneMode: null,
      timezone: '',
      machine: null,
      panelOpen: false,
      tab: 'activity',
      updatedAt: null,
    },
  };
  refs.getVision = () => visionModule.resolveVision(state.vision, { settings: state.settings, chatKey: state.apiKey, voice: state.voice });
  refs.getMedia = (kind) => mediaModule.resolveMedia(state.media, kind, { voice: state.voice });

  // Videos finish in the background; the bot that asked gets a turn to show it.
  const tellBot = async (job, text) => {
    if (!job.botId) return;
    // A video asked for in a group is shown in that group, by the bot that made it.
    let group = null;
    if (job.groupId) {
      const g = await groups.getGroup(job.groupId).catch(() => null);
      if (g && g.members.includes(job.botId)) {
        const byId = new Map((await listBots()).map((b) => [b.id, b]));
        group = { id: g.id, name: g.name, coordinatorId: g.coordinatorId, members: g.members.filter((id) => byId.has(id)).map((id) => ({ id, name: byId.get(id).name, role: byId.get(id).role })) };
      }
    }
    runtime.runTurn({ botId: job.botId, text, source: 'media', ...(group ? { group, groupRole: 'speaker', recordUser: false } : {}) })
      .catch((err) => console.error('[video] could not report:', err.message));
  };
  refs.videoJobs = createVideoJobs({
    file: path.join(P.dataDir, 'video-jobs.json'),
    getKey: () => refs.getMedia('video')?.apiKey || '',
    workspaceDir,
    onDone: (job) => tellBot(job, `[后台任务] 你之前提交的视频生成好了：${job.path}（内容：${job.prompt}）。告诉用户，并在回复里写出这个路径，视频会直接在聊天里播放。`),
    onFail: (job) => tellBot(job, `[后台任务] 你之前提交的视频没有生成成功：${job.error}（内容：${job.prompt}）。告诉用户原因，问要不要重试。`),
  });
  await refs.videoJobs.load();

  // Feishu: the assistant in the phone's chat app, over a connection this
  // machine opens (no public address needed). Off until set up in Settings.
  state.feishu = createFeishu({
    file: path.join(P.dataDir, 'feishu.json'),
    bus,
    runtime,
    approvals: {
      resolve: (id, decision) => {
        const record = approvals.decide(id, decision, '飞书', 'feishu');
        if (!record) throw new Error('找不到这个审批');
        if (record.error) throw new Error(record.error);
        bus.emit({ type: 'approval.decided', approvalId: record.id, botId: record.botId, turnId: record.turnId, status: record.status, note: record.note, late: Boolean(record.late) });
      },
    },
    getBots: () => state.botsCache || [],
    workspaceDir,
    machineName: () => state.uiState?.machine?.name || os.hostname(),
  });
  listBots().then((b) => { state.botsCache = b; }).catch(() => {});
  bus.subscribe((ev) => { if (ev.type === 'roster.changed') listBots().then((b) => { state.botsCache = b; }).catch(() => {}); });
  await state.feishu.load();

  // -------------------------------------------------------------------------
  // product-state callbacks used by the primary bot's settings/ui tools
  // -------------------------------------------------------------------------

  state.settingsView = () => ({
    app: { name: state.config.name, version: VERSION },
    model: settingsModule.publicModel(state.settings, state.apiKey),
    timezone: state.settings.timezone || '',
  });

  state.updateSettings = async (patch = {}) => {
    const source = patch && typeof patch === 'object' ? patch : {};
    const clean = {};
    for (const key of ['provider', 'baseUrl', 'model', 'timezone']) {
      if (source[key] !== undefined) clean[key] = source[key];
    }
    const next = await settingsModule.saveSettings(clean);
    if (typeof source.apiKey === 'string') {
      state.apiKey = await settingsModule.saveSecret(source.apiKey);
    }
    state.settings = next;
    state.model = settingsModule.createModelFromSettings(state.settings, state.apiKey);
    state.runtime.setModel(state.model);
    state.bus.emit({
      type: 'settings.changed',
      settings: settingsModule.publicModel(state.settings, state.apiKey),
    });
    return state.settingsView();
  };

  const UI_THEMES = new Set(['dark', 'light', 'system']);
  const UI_TZ_MODES = new Set(['local', 'target', 'manual']);
  const UI_TABS = new Set(['activity', 'computer', 'skills', 'routines', 'memory']);

  function cleanUiPatch(patch = {}) {
    const clean = {};
    if (UI_THEMES.has(patch.theme)) clean.theme = patch.theme;
    if (patch.lang === 'en' || patch.lang === 'zh') clean.lang = patch.lang;
    if (UI_TZ_MODES.has(patch.timezoneMode)) clean.timezoneMode = patch.timezoneMode;
    if (typeof patch.timezone === 'string') clean.timezone = patch.timezone.slice(0, 64);
    if (typeof patch.panelOpen === 'boolean') clean.panelOpen = patch.panelOpen;
    if (UI_TABS.has(patch.tab)) clean.tab = patch.tab;
    if (Array.isArray(patch.machines)) {
      clean.machines = patch.machines.slice(0, 30).map((m) => ({
        name: String(m?.name || '').slice(0, 80),
        url: String(m?.url || '').slice(0, 200),
        current: Boolean(m?.current),
      })).filter((m) => m.name && m.url);
    }
    // A command only (machine_switch): never stored in uiState.
    if (patch.switchMachine && typeof patch.switchMachine === 'object') {
      clean.switchMachine = {
        target: String(patch.switchMachine.target || '').slice(0, 200),
        message: String(patch.switchMachine.message || '').slice(0, 4000),
      };
    }
    // Which machine the window is showing; reported by the UI, read by ui_get.
    if (patch.machine && typeof patch.machine === 'object') {
      clean.machine = {
        name: String(patch.machine.name || '').slice(0, 80),
        url: String(patch.machine.url || '').slice(0, 200),
        local: Boolean(patch.machine.local),
      };
    }
    return clean;
  }

  state.uiView = () => ({ ...state.uiState });
  state.reportUi = (patch = {}) => {
    const { switchMachine, ...clean } = cleanUiPatch(patch);
    state.uiState = { ...state.uiState, ...clean, updatedAt: nowIso() };
    return state.uiView();
  };
  state.applyUi = (patch = {}, meta = {}) => {
    // machine/machines are reported by the UI, never commanded.
    const { machine, machines, ...clean } = cleanUiPatch(patch);
    const eventPatch = clean;
    if (!Object.keys(eventPatch).length) return state.uiView();
    const { switchMachine, ...stored } = clean;
    if (Object.keys(stored).length) {
      state.uiState = { ...state.uiState, ...stored, updatedAt: nowIso() };
    }
    // Global event: every open window applies it, regardless of the chat it is
    // showing. The UI treats this as a command, not a transcript message.
    state.bus.emit({ type: 'ui.command', patch: eventPatch, by: meta.by || null });
    return state.uiView();
  };
  refs.app = state;

  const server = http.createServer((req, res) => {
    handleRequest(req, res, state).catch((err) => {
      // Last-resort guard: no route may ever produce an unhandled rejection.
      console.error('[assistant] unhandled request error:', err);
      if (!res.headersSent) errorResponse(res, 500, 'INTERNAL', 'unexpected server error');
      else res.end();
    });
  });

  // Bot desktops: websockify listens on 127.0.0.1 only; a viewer reaches it
  // through this relay, which applies the same pairing check as the API.
  server.on('upgrade', (req, socket, head) => {
    const refuse = (status, text) => {
      try { socket.end(`HTTP/1.1 ${status} ${text}\r\nConnection: close\r\nContent-Length: 0\r\n\r\n`); } catch { /* gone */ }
    };
    socket.on('error', () => socket.destroy());
    let pathname = '';
    try { pathname = new URL(req.url || '/', 'http://hub').pathname; } catch { return refuse(400, 'Bad Request'); }
    const match = /^\/api\/bots\/([^/]+)\/desktop\/ws$/.exec(pathname);
    if (!match) return refuse(404, 'Not Found');
    if (!evaluateAuth(req, state.security).authorized) return refuse(401, 'Unauthorized');
    const info = desktopInfo(safeDecode(match[1]));
    if (!info.running) return refuse(404, 'Not Found');
    // Windows: no websockify; the hub speaks WebSocket to the VNC server itself.
    if (!info.webPort && info.vncPort) {
      if (!bridgeWebSocket(req, socket, head, { port: info.vncPort })) refuse(400, 'Bad Request');
      return;
    }
    if (!info.webPort) return refuse(404, 'Not Found');
    const upstream = net.connect(info.webPort, '127.0.0.1', () => {
      // Replay the client's handshake to websockify; it answers the upgrade.
      const lines = ['GET / HTTP/1.1'];
      for (let i = 0; i < req.rawHeaders.length; i += 2) lines.push(`${req.rawHeaders[i]}: ${req.rawHeaders[i + 1]}`);
      upstream.write(`${lines.join('\r\n')}\r\n\r\n`);
      if (head && head.length) upstream.write(head);
      upstream.pipe(socket);
      socket.pipe(upstream);
    });
    upstream.on('error', () => socket.destroy());
    socket.on('close', () => upstream.destroy());
  });

  return { server, state, port, host };
}

// ---------------------------------------------------------------------------
// route table
// ---------------------------------------------------------------------------

const routes = [];

function route(method, pattern, handler, options = {}) {
  // `rawBody: true` opts a route out of JSON body parsing - avatar uploads are
  // raw image bytes, and turning a PNG into UTF-8 would be the end of it.
  routes.push({ method, pattern, handler, ...options });
}

/**
 * Handlers receive (req, res, { params, query, body, state }).
 * They may return a value (sent as 200 JSON), or write to res themselves and
 * return undefined.
 */
async function handleRequest(req, res, state) {
  const url = new URL(req.url || '/', `http://${req.headers.host || 'localhost'}`);
  const pathname = safeDecode(url.pathname);
  const method = (req.method || 'GET').toUpperCase();

  if (pathname === '/api' || pathname.startsWith('/api/')) {
    // Loopback is the local user. Everything else has to pair first - except the
    // two endpoints that exist precisely so an unauthenticated client can find
    // out it needs to pair and then do it.
    if (!isAuthExemptPath(method, pathname)) {
      const auth = evaluateAuth(req, state.security);
      if (!auth.authorized) {
        return errorResponse(
          res,
          401,
          'AUTH_REQUIRED',
          'this device is not paired: POST /api/pair with the code shown in Settings, or send Authorization: Bearer <token>',
        );
      }
      req.auth = auth;
    }
    return dispatchApi(req, res, state, pathname, url);
  }

  // Static: the app shell has to load before a client can pair, so those files
  // are public. Anything else in public/ is treated like app data.
  const auth = evaluateAuth(req, state.security);
  if (!auth.authorized && !isPublicShellPath(pathname)) {
    return errorResponse(res, 401, 'AUTH_REQUIRED', 'this device is not paired');
  }
  return serveStatic(req, res, pathname);
}

async function dispatchApi(req, res, state, pathname, url) {
  const method = (req.method || 'GET').toUpperCase();

  for (const entry of routes) {
    if (entry.method !== method) continue;
    const match = pathname.match(entry.pattern);
    if (!match) continue;

    const params = match.groups || {};
    let body = {};
    if ((method === 'POST' || method === 'PATCH' || method === 'PUT') && !entry.rawBody) {
      try {
        body = await readJsonBody(req);
      } catch (err) {
        return errorResponse(res, err.status || 400, err.code || 'BAD_BODY', err.message);
      }
    }

    try {
      const result = await entry.handler(req, res, { params, query: url.searchParams, body, state });
      if (result !== undefined && !res.headersSent) jsonResponse(res, 200, result);
      return undefined;
    } catch (err) {
      const status = err.status || 500;
      const code = err.code || (status === 500 ? 'INTERNAL' : 'REQUEST_FAILED');
      if (status >= 500) console.error(`[assistant] ${method} ${pathname} failed:`, err);
      return errorResponse(res, status, code, err.message || 'request failed');
    }
  }

  return errorResponse(res, 404, 'NOT_FOUND', `no route for ${method} ${pathname}`);
}

// --- health / config -------------------------------------------------------

route('GET', /^\/api\/health$/, async (_req, _res, { state }) => {
  const bots = await listBots();
  return {
    ok: true,
    version: VERSION,
    now: nowIso(),
    uptimeSec: Math.round((Date.now() - state.startedAt) / 1000),
    model: { provider: state.model.provider, model: state.model.model },
    workspace: state.workspaceDir,
    dataDir: P.dataDir,
    bots: bots.length,
    primaryBotId: bots.find((b) => b.primary)?.id || null,
    routines: state.routines.list().length,
    pendingApprovals: state.approvals.list({ status: 'pending' }).length,
    activeTurns: state.runtime.activeTurns().length,
    requireAuth: Boolean(state.requireAuth),
    lanUrl: state.lanUrl,
    recoveredTurns: state.recoveredTurns.length,
    // Self-update: what this machine was set up with, and what this build's
    // scripts would install (a client compares them before pushing an update).
    setupVersion: installedSetupVersion(),
    shippedSetupVersion: shippedSetupVersion(),
    selfUpdate: true,
  };
});

route('GET', /^\/api\/config$/, async (_req, _res, { state }) => {
  const bots = await listBots();
  return {
    name: state.config.name,
    persona: state.config.persona,
    timezone: state.settings.timezone || state.config.timezone || '',
    primaryBotId: state.config.primaryBotId || bots.find((b) => b.primary)?.id || null,
    policy: {
      autoApproveMedium: Boolean(state.config.policy?.autoApproveMedium),
      denyPatterns: state.config.policy?.denyPatterns || [],
      approvalTimeoutMs: state.config.policy?.approvalTimeoutMs || 600000,
    },
    model: { provider: state.model.provider, model: state.model.model },
    workspace: state.workspaceDir,
    version: VERSION,
  };
});

route('GET', /^\/api\/events$/, async (_req, _res, { query, state }) => {
  return state.bus.recent(Number(query.get('limit')) || 60);
});

// --- settings / auth / pairing ---------------------------------------------
//
// Contract (the UI and the smoke test both depend on it):
//   GET  /api/settings       {app:{name,version}, model:{provider,baseUrl,model,hasKey},
//                             server:{host,port,lanUrl,requireAuth}, pairing:{url,code}}
//   PUT  /api/settings       {provider,baseUrl,model,apiKey?} -> {ok:true, model:{...}}
//   POST /api/settings/test  -> {ok, latencyMs, mode, error?}
//   GET  /api/auth           -> {required, authorized, mode:'local'|'token'|'cookie'|'none'}
//   POST /api/pair           {code} -> {ok:true} + Set-Cookie: desk_session
//   GET  /api/pairing        -> {url, code}

function pairingInfo(state) {
  const port = state.port;
  const url =
    state.pairingUrl ||
    state.lanUrl ||
    `http://${isLoopbackHost(state.host) ? '127.0.0.1' : state.host}:${port}`;
  return { url, code: state.security.code };
}

route('GET', /^\/api\/settings$/, async (_req, _res, { state }) => ({
  app: { name: state.config.name, version: VERSION },
  timezone: state.settings.timezone || '',
  model: settingsModule.publicModel(state.settings, state.apiKey),
  server: {
    host: state.host,
    port: state.port,
    lanUrl: state.lanUrl,
    requireAuth: Boolean(state.requireAuth),
  },
  pairing: pairingInfo(state),
}));

// Static catalogue of every model provider Desk can talk to. No secrets, so it
// is safe for any paired device; the UI uses it to fill the settings form.
route('GET', /^\/api\/providers$/, async () => ({ providers: publicProviderCatalogue() }));

// Per-bot desktops. `support` explains why it is off (non-Linux hub, missing
// Xvfb) so the UI can say something more useful than "failed".
route('GET', /^\/api\/desktops$/, async () => ({ support: desktopSupport(), desktops: listDesktops() }));

route('GET', /^\/api\/bots\/(?<botId>[^/]+)\/desktop$/, async (_req, _res, { params }) => {
  const botId = params.botId;
  try {
    const support = desktopSupport();
    if (!support.available) return { botId, support, desktop: { botId, running: false, url: null } };
    const desktop = await ensureDesktop(botId);
    return { botId, support, desktop };
  } catch (err) {
    return { botId, support: desktopSupport(), desktop: { botId, running: false, url: null }, error: err.message };
  }
});

route('POST', /^\/api\/bots\/(?<botId>[^/]+)\/desktop\/stop$/, async (_req, _res, { params }) => ({
  ok: stopDesktop(params.botId),
}));

route('PUT', /^\/api\/settings$/, async (_req, _res, { body, state }) => {
  // The documented body is flat: {provider, baseUrl, model, apiKey?}.
  // Some clients (including our own UI) also try a nested {model:{...}} shape;
  // accept both instead of silently doing nothing on the nested one.
  const source = body && typeof body.model === 'object' && body.model !== null ? body.model : body || {};

  const patch = {};
  if (source.provider !== undefined) patch.provider = source.provider;
  if (source.baseUrl !== undefined) patch.baseUrl = source.baseUrl;
  if (source.model !== undefined) patch.model = source.model;
  if (source.timezone !== undefined) patch.timezone = source.timezone;

  const apiKeyInput = source.apiKey !== undefined ? source.apiKey : body?.apiKey;
  if (apiKeyInput !== undefined && typeof apiKeyInput !== 'string') {
    throw httpError(400, 'INVALID_API_KEY', 'apiKey must be a string (an empty string clears it)');
  }
  if (!Object.keys(patch).length && apiKeyInput === undefined) {
    throw httpError(400, 'SETTINGS_EMPTY', 'body needs {provider, baseUrl, model, apiKey?}');
  }

  if (typeof apiKeyInput === 'string') patch.apiKey = apiKeyInput;
  // Write-only secret: it never comes back out of this endpoint.
  await state.updateSettings(patch);

  return { ok: true, model: settingsModule.publicModel(state.settings, state.apiKey) };
});

// --- voice input --------------------------------------------------------------
//
//   GET  /api/voice              -> {available, source:'own'|'model'|null, baseUrl, model, hasKey, preset}
//   PUT  /api/voice              {baseUrl?, model?, apiKey?} -> same shape
//   POST /api/voice/transcribe   raw audio (content-type audio/webm…), ?lang=zh -> {text, latencyMs}

// --- Feishu --------------------------------------------------------------------
//   GET  /api/feishu          -> {enabled, appId, hasSecret, botId, pairCode, users, connected, error}
//   PUT  /api/feishu          {enabled?, appId?, appSecret?, botId?, newPairCode?, clearSecret?}
//   POST /api/feishu/unpair   {openId}

route('GET', /^\/api\/feishu$/, async (_req, _res, { state }) => state.feishu.view());

route('PUT', /^\/api\/feishu$/, async (_req, _res, { body, state }) => {
  const view = await state.feishu.update(body || {});
  await audit({ kind: 'feishu.changed', enabled: view.enabled, appId: view.appId });
  return view;
});

route('POST', /^\/api\/feishu\/unpair$/, async (_req, _res, { body, state }) => {
  const view = await state.feishu.unpair(String(body?.openId || ''));
  await audit({ kind: 'feishu.unpaired' });
  return view;
});

// --- extra models (a bot can use its own) -------------------------------------
//   GET    /api/models           -> {default:{provider,model,...}, models:[{id,label,provider,baseUrl,model,hasKey}]}
//   POST   /api/models           {label?, provider, baseUrl?, model, apiKey}
//   PUT    /api/models/:id       same fields; empty apiKey keeps the old one
//   DELETE /api/models/:id       bots using it go back to the default
//   POST   /api/models/test      {id?} or {provider, baseUrl, model, apiKey}

route('GET', /^\/api\/models$/, async (_req, _res, { state }) => ({
  default: settingsModule.publicModel(state.settings, state.apiKey),
  models: await modelsModule.publicProfiles(),
}));

route('POST', /^\/api\/models$/, async (_req, _res, { body }) => {
  const model = await modelsModule.saveProfile({ ...body, id: undefined });
  await audit({ kind: 'model.saved', id: model.id, provider: model.provider, model: model.model });
  return { model };
});

route('POST', /^\/api\/models\/test$/, async (_req, _res, { body }) => {
  const started = Date.now();
  try {
    const client = await modelsModule.testClient(body || {});
    if (client.provider === 'mock') return { ok: false, error: { message: '没有密钥' } };
    const r = await client.complete([{ role: 'user', content: 'Reply with the single word: ok' }], { maxTokens: 8, temperature: 0, timeoutMs: 20000 });
    return { ok: true, latencyMs: Date.now() - started, reply: String(r?.content || '').slice(0, 80) };
  } catch (err) {
    return { ok: false, latencyMs: Date.now() - started, error: { message: err.message } };
  }
});

route('PUT', /^\/api\/models\/(?<id>[^/]+)$/, async (_req, _res, { params, body }) => {
  const model = await modelsModule.saveProfile({ ...body, id: params.id });
  await audit({ kind: 'model.saved', id: model.id, provider: model.provider, model: model.model });
  return { model };
});

route('DELETE', /^\/api\/models\/(?<id>[^/]+)$/, async (_req, _res, { params, state }) => {
  const result = await modelsModule.deleteProfile(params.id);
  await audit({ kind: 'model.deleted', id: params.id });
  state.bus.emit({ type: 'roster.changed' });
  return result;
});

// --- attention (sidebar status) ----------------------------------------------
//   GET  /api/attention        -> {items:{"bot:<id>"|"group:<id>": {working, needsYou, unread}}, needsYou, unread, working}
//   POST /api/attention/seen   {key}   the human is looking at that chat

route('GET', /^\/api\/attention$/, async (_req, _res, { state }) => state.attention.snapshot());

route('POST', /^\/api\/attention\/seen$/, async (_req, _res, { body, state }) => {
  if (!state.attention.seen(body?.key)) throw httpError(400, 'BAD_KEY', 'key must be bot:<id> or group:<id>');
  return { ok: true };
});

// --- vault -------------------------------------------------------------------
//   GET    /api/vault            -> {entries:[{id,name,site,fields:[labels]}]}   never values
//   POST   /api/vault            {name, site?, values:{label: value}}  create or update by name
//   PUT    /api/vault/:id        {name?, site?, values?}                empty value = keep
//   DELETE /api/vault/:id
// Values go in and never come out through any route.

route('GET', /^\/api\/vault$/, async () => ({ entries: await listVault() }));

route('POST', /^\/api\/vault$/, async (_req, _res, { body, state }) => {
  const entry = await putVault({ name: body?.name, site: body?.site, values: body?.values });
  await audit({ kind: 'vault.saved', name: entry.name, fields: entry.fields });
  state.bus.emit({ type: 'vault.changed' });
  return { entry };
});

route('PUT', /^\/api\/vault\/(?<id>[^/]+)$/, async (_req, _res, { params, body, state }) => {
  const entry = await putVault({ id: params.id, name: body?.name, site: body?.site, values: body?.values });
  await audit({ kind: 'vault.saved', name: entry.name, fields: entry.fields });
  state.bus.emit({ type: 'vault.changed' });
  return { entry };
});

route('DELETE', /^\/api\/vault\/(?<id>[^/]+)$/, async (_req, _res, { params, state }) => {
  const result = await deleteVault(params.id);
  await audit({ kind: 'vault.deleted', id: params.id });
  state.bus.emit({ type: 'vault.changed' });
  return result;
});

// --- vision (image_view) --------------------------------------------------
//   GET /api/vision -> {available, source:'own'|'voice'|'model'|null, baseUrl, model, hasKey, providers}
//   PUT /api/vision {baseUrl?, model?, apiKey?}

const visionCtx = (state) => ({ settings: state.settings, chatKey: state.apiKey, voice: state.voice });

route('GET', /^\/api\/vision$/, async (_req, _res, { state }) => visionModule.publicVision(state.vision, visionCtx(state)));

route('PUT', /^\/api\/vision$/, async (_req, _res, { body, state }) => {
  const patch = {};
  for (const k of ['baseUrl', 'model', 'apiKey']) if (body?.[k] !== undefined) patch[k] = body[k];
  if (!Object.keys(patch).length) throw httpError(400, 'SETTINGS_EMPTY', 'body needs {baseUrl?, model?, apiKey?}');
  state.vision = await visionModule.saveVision(state.vision, patch);
  return visionModule.publicVision(state.vision, visionCtx(state));
});

// --- image / video generation ------------------------------------------------
//   GET /api/media                -> {image:{available, source, service, baseUrl, model, hasKey, services}, video:{...}}
//   PUT /api/media/(image|video)  {service?, baseUrl?, model?, apiKey?}

route('GET', /^\/api\/media$/, async (_req, _res, { state }) => mediaModule.publicMedia(state.media, { voice: state.voice }));

route('PUT', /^\/api\/media\/(?<kind>image|video)$/, async (_req, _res, { params, body, state }) => {
  const patch = {};
  for (const k of ['service', 'baseUrl', 'model', 'apiKey']) if (body?.[k] !== undefined) patch[k] = body[k];
  if (!Object.keys(patch).length) throw httpError(400, 'SETTINGS_EMPTY', 'body needs {service?, baseUrl?, model?, apiKey?}');
  state.media = await mediaModule.saveMedia(state.media, params.kind, patch);
  return mediaModule.publicMedia(state.media, { voice: state.voice });
});

route('GET', /^\/api\/voice$/, async (_req, _res, { state }) => voiceModule.publicVoice(state.voice, state.settings, state.apiKey));

route('PUT', /^\/api\/voice$/, async (_req, _res, { body, state }) => {
  const patch = {};
  for (const k of ['baseUrl', 'model', 'apiKey']) if (body?.[k] !== undefined) patch[k] = body[k];
  if (!Object.keys(patch).length) throw httpError(400, 'SETTINGS_EMPTY', 'body needs {baseUrl?, model?, apiKey?}');
  state.voice = await voiceModule.saveVoice(state.voice, patch);
  return voiceModule.publicVoice(state.voice, state.settings, state.apiKey);
});

route(
  'POST',
  /^\/api\/voice\/transcribe$/,
  async (req, _res, { state, query }) => {
    const bytes = await readRawBody(req, voiceModule.VOICE_MAX_BYTES, {
      code: 'AUDIO_TOO_LARGE',
      message: '一段语音最多 10 MB（约 10 分钟）',
    });
    const service = voiceModule.resolveVoice(state.voice, state.settings, state.apiKey);
    const lang = String(query.get('lang') || '').trim();
    return voiceModule.transcribe(service, bytes, req.headers['content-type'], {
      language: /^[a-z]{2}$/.test(lang) ? lang : undefined,
    });
  },
  { rawBody: true },
);

route('POST', /^\/api\/settings\/test$/, async (_req, _res, { body, state }) => {
  // Accept optional unsaved overrides so the UI can test before it saves.
  const source = body && typeof body.model === 'object' && body.model !== null ? body.model : body || {};
  let settings = state.settings;
  let apiKey = state.apiKey;
  if (source.provider !== undefined || source.baseUrl !== undefined || source.model !== undefined) {
    settings = settingsModule.validateSettings({
      provider: source.provider ?? state.settings.provider,
      baseUrl: source.baseUrl ?? state.settings.baseUrl,
      model: source.model ?? state.settings.model,
    });
  }
  if (typeof source.apiKey === 'string') apiKey = source.apiKey.trim();

  const result = await settingsModule.testConnection({ settings, apiKey, timeoutMs: 20000 });
  return {
    ok: result.ok,
    latencyMs: result.latencyMs,
    mode: result.mode,
    ...(result.reply ? { reply: result.reply } : {}),
    ...(result.error ? { error: result.error } : {}),
  };
});

route('GET', /^\/api\/auth$/, async (req, _res, { state }) => {
  const auth = evaluateAuth(req, state.security);
  return { required: auth.required, authorized: auth.authorized, mode: auth.mode };
});

route('POST', /^\/api\/pair$/, async (req, res, { body, state }) => {
  const limit = state.pairLimiter.check(clientIp(req));
  if (!limit.allowed) {
    res.setHeader('retry-after', String(Math.max(1, Math.ceil((limit.retryAfterMs || 0) / 1000))));
    throw httpError(429, 'PAIR_RATE_LIMITED', 'too many pairing attempts; wait a minute and try again');
  }

  const code = String(body?.code ?? '').trim();
  if (!code) throw httpError(400, 'PAIR_CODE_REQUIRED', 'body needs { code }');
  if (!safeEqual(code, state.security.code)) {
    throw httpError(401, 'PAIR_INVALID_CODE', 'that pairing code is not valid');
  }

  res.setHeader('set-cookie', sessionCookieHeader(state.security.token));
  return { ok: true };
});

route('GET', /^\/api\/pairing$/, async (_req, _res, { state }) => pairingInfo(state));

// --- UI state / remote machines -------------------------------------------
//
// The browser owns localStorage (theme, timezone mode). It pushes a small
// projection here so the primary bot can read what the human sees and change
// it over chat.

route('GET', /^\/api\/ui\/state$/, async (_req, _res, { state }) => state.uiView());

route('POST', /^\/api\/ui\/state$/, async (_req, _res, { body, state }) => ({
  ok: true,
  ui: state.reportUi(body?.patch || body || {}),
}));

route('GET', /^\/api\/remote\/provision$/, async (_req, _res, { state }) => ({
  jobs: state.provisioner.list(),
}));

route('POST', /^\/api\/remote\/provision$/, async (_req, _res, { body, state }) => ({
  ok: true,
  job: state.provisioner.start(body || {}),
}));

route('GET', /^\/api\/remote\/provision\/(?<id>[^/]+)$/, async (_req, _res, { params, state }) => {
  const job = state.provisioner.get(params.id);
  if (!job) throw httpError(404, 'PROVISION_NOT_FOUND', `no provisioning job "${params.id}"`);
  return job;
});

// --- self-update ------------------------------------------------------------
//
//   POST /api/system/update        raw .tar.gz (the same package setup installs)
//        -> {ok, from, to, restarting}; then this process exits and its
//           supervisor (systemd / the Windows launcher loop) starts the new code
//   POST /api/remote/push-update   {url, cookie}  loopback only: this computer
//        packs itself and updates that machine, then waits for the new version

route(
  'POST',
  /^\/api\/system\/update$/,
  async (req, _res, { state }) => {
    if (state.runtime.activeTurns().length) {
      throw httpError(409, 'UPDATE_BUSY', '这台机器上有任务正在进行，等它做完再更新');
    }
    const bytes = await readRawBody(req, UPDATE_MAX_BYTES, { code: 'UPDATE_TOO_LARGE', message: '更新包太大' });
    const result = await applyUpdate({ bytes, currentVersion: VERSION, log: (line) => console.error(line) });
    if (process.env.ASSIST_UPDATE_NO_EXIT !== '1') {
      setTimeout(() => process.exit(0), 800).unref?.();
    }
    return { ok: true, ...result, restarting: true };
  },
  { rawBody: true },
);

route('POST', /^\/api\/remote\/push-update$/, async (req, _res, { body }) => {
  if (!isLoopbackHost(clientIp(req))) throw httpError(403, 'LOCAL_ONLY', 'only the desktop app on this computer can push updates');
  const url = String(body?.url || '').replace(/\/+$/, '');
  if (!/^https?:\/\/[^/]+$/.test(url)) throw httpError(400, 'BAD_URL', 'url must be a machine address like http://host:4390');
  const headers = body?.cookie ? { cookie: String(body.cookie) } : {};
  const health = async () => {
    const res = await fetch(`${url}/api/health`, { headers, signal: AbortSignal.timeout(30000) });
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
    return res.json();
  };
  const before = await health().catch((err) => { throw httpError(502, 'MACHINE_UNREACHABLE', `连不上这台机器：${err.message}`); });
  if (compareVersions(before.version, VERSION) >= 0) return { ok: true, updated: false, version: before.version };
  if (!before.selfUpdate) {
    // Installed before self-update existed: one last manual add, automatic after that.
    return { ok: false, needsSetup: true, version: before.version, message: `这台机器还是 ${before.version}，不支持自动更新：重新添加一次，以后就会自动更新了` };
  }
  if (shippedSetupVersion() > Number(before.setupVersion || 1)) {
    return { ok: false, needsSetup: true, version: before.version, message: '这次更新需要改动系统组件，请重新添加一次这台机器' };
  }
  const packed = await packApp();
  try {
    const res = await fetch(`${url}/api/system/update`, {
      method: 'POST',
      headers: { ...headers, 'content-type': 'application/gzip', 'x-nightshift-version': VERSION },
      body: fs.readFileSync(packed.file),
      // The machine test-starts the new version (up to 2 min) before answering.
      signal: AbortSignal.timeout(300000),
    });
    const reply = await res.json().catch(() => ({}));
    if (!res.ok) {
      const code = reply?.error?.code;
      return { ok: false, busy: code === 'UPDATE_BUSY', needsSetup: code === 'UPDATE_NEEDS_SETUP', version: before.version, message: reply?.error?.message || `HTTP ${res.status}` };
    }
  } finally {
    cleanupPack(packed.file);
  }
  // It restarts on its own; wait until it answers with the new version.
  const deadline = Date.now() + 90000;
  while (Date.now() < deadline) {
    await new Promise((r) => setTimeout(r, 2000));
    const now = await health().catch(() => null);
    if (now && compareVersions(now.version, VERSION) >= 0) return { ok: true, updated: true, from: before.version, to: now.version };
  }
  return { ok: false, version: before.version, message: '新版本已经装上，但 90 秒内没有重新连上，稍后再看' };
});

// --- bots ------------------------------------------------------------------

route('GET', /^\/api\/bots$/, async () => {
  const bots = await listBots();
  // The sidebar wants the last thing each bot said. That costs one tail read per
  // bot; a broken or unreadable log degrades to preview:null instead of failing
  // the roster (lastMessagePreview never throws).
  return Promise.all(
    bots.map(async (bot) => ({ ...publicBot(bot), preview: await lastMessagePreview(bot.id) })),
  );
});

route('POST', /^\/api\/bots$/, async (_req, _res, { body, state }) => {
  const bot = await createBot(body || {});
  state.bus.emit({ type: 'roster.changed', scope: 'bots', action: 'create', botId: bot.id });
  return { bot: publicBot(bot) };
});

route('PATCH', /^\/api\/bots\/(?<id>[^/]+)$/, async (_req, _res, { params, body, state }) => {
  const before = await getBot(params.id);
  const bot = await updateBot(params.id, body || {});
  if (before && (Array.isArray(body?.tools) || body?.policy?.autoApproveMedium !== undefined)) {
    const had = new Set(before.tools || []);
    const has = new Set(bot.tools || []);
    const added = [...has].filter((t) => !had.has(t));
    const removed = [...had].filter((t) => !has.has(t));
    const trust = Boolean(before.policy?.autoApproveMedium) !== Boolean(bot.policy?.autoApproveMedium) ? Boolean(bot.policy?.autoApproveMedium) : undefined;
    if (added.length || removed.length || trust !== undefined) {
      await audit({ kind: 'bot.abilities', botId: bot.id, added, removed, ...(trust !== undefined ? { trusted: trust } : {}) });
    }
  }
  if (body?.primary === true) {
    await setPrimaryBot(bot.id, state.config);
  }
  const fresh = await getBot(bot.id);
  state.bus.emit({ type: 'roster.changed', scope: 'bots', action: 'update', botId: bot.id });
  return { bot: publicBot(fresh) };
});

route('DELETE', /^\/api\/bots\/(?<id>[^/]+)$/, async (_req, _res, { params, state }) => {
  const result = await deleteBot(params.id, state.config);
  state.bus.emit({ type: 'roster.changed', scope: 'bots', action: 'delete', botId: params.id });
  return result;
});

route('POST', /^\/api\/bots\/(?<id>[^/]+)\/primary$/, async (_req, _res, { params, state }) => {
  const bot = await setPrimaryBot(params.id, state.config);
  state.config.primaryBotId = params.id;
  return { bot: publicBot(bot) };
});

route('GET', /^\/api\/bots\/(?<id>[^/]+)\/messages$/, async (_req, _res, { params, query }) => {
  const bot = await getBot(params.id);
  if (!bot) throw httpError(404, 'BOT_NOT_FOUND', `no bot with id "${params.id}"`);
  const records = await readJsonl(sessionFile(bot.id));
  const limit = Math.min(Number(query.get('limit')) || 200, 1000);
  return records.slice(-limit).map((record, index) => toMessageItem(record, index));
});

route('POST', /^\/api\/bots\/(?<id>[^/]+)\/message$/, async (_req, res, { params, body, state }) => {
  const bot = await getBot(params.id);
  if (!bot) throw httpError(404, 'BOT_NOT_FOUND', `no bot with id "${params.id}"`);

  const text = withAttachments(String(body?.text ?? '').trim(), await checkAttachments(state, body?.attachments));
  if (!text) throw httpError(400, 'EMPTY_MESSAGE', 'text is required');
  if (text.length > 20000) throw httpError(400, 'MESSAGE_TOO_LONG', 'text is limited to 20000 characters');

  // Answer immediately with the turn id; the turn streams over SSE.
  const turnId = uid('turn');
  state.runtime
    .runTurn({ botId: bot.id, text, source: 'chat', turnId })
    .catch((err) => {
      state.bus.emit({ type: 'error', botId: bot.id, turnId, message: err.message });
    });

  return { turnId, botId: bot.id };
});

// --- attachments -----------------------------------------------------------
//
//   POST /api/uploads   raw bytes, header x-file-name (URI-encoded)
//                       -> {path:"uploads/2026-11-07/a.png", name, size, mime}
//   GET  /api/workspace/file?path=uploads/…   -> the bytes (thumbnails, downloads)
//
// Files land in the shared workspace, so every bot can open them with its
// normal file tools. A message carries them as a "[附件]" block the bot reads
// and the UI renders as thumbnails / file cards.

const UPLOAD_MAX_BYTES = 25 * 1024 * 1024;
const MIME_BY_EXT = {
  '.png': 'image/png', '.jpg': 'image/jpeg', '.jpeg': 'image/jpeg', '.gif': 'image/gif', '.webp': 'image/webp',
  '.svg': 'image/svg+xml', '.pdf': 'application/pdf', '.txt': 'text/plain; charset=utf-8', '.md': 'text/markdown; charset=utf-8',
  '.csv': 'text/csv; charset=utf-8', '.json': 'application/json', '.zip': 'application/zip',
  '.mp4': 'video/mp4', '.webm': 'video/webm', '.mov': 'video/quicktime',
};
const mimeOf = (name) => MIME_BY_EXT[path.extname(String(name)).toLowerCase()] || 'application/octet-stream';

function safeUploadName(raw) {
  const base = path.basename(String(raw || 'file')).replace(/[\\/:*?"<>|\u0000-\u001f]/g, '_').trim();
  return (base || 'file').slice(0, 120);
}

/** A workspace-relative path that must stay inside the workspace. */
function workspaceFile(state, rel) {
  const root = path.resolve(state.workspaceDir);
  const abs = path.resolve(root, String(rel || ''));
  if (abs !== root && !abs.startsWith(root + path.sep)) throw httpError(400, 'PATH_OUTSIDE_WORKSPACE', 'path must stay inside the workspace');
  return abs;
}

route(
  'POST',
  /^\/api\/uploads$/,
  async (req, _res, { state }) => {
    let name = 'file';
    try { name = decodeURIComponent(String(req.headers['x-file-name'] || 'file')); } catch { /* keep default */ }
    name = safeUploadName(name);
    const bytes = await readRawBody(req, UPLOAD_MAX_BYTES, {
      code: 'UPLOAD_TOO_LARGE',
      message: `an attachment must be ${UPLOAD_MAX_BYTES / (1024 * 1024)} MB or smaller`,
    });
    const day = new Date().toISOString().slice(0, 10);
    const dir = workspaceFile(state, path.join('uploads', day));
    await fsp.mkdir(dir, { recursive: true });
    const ext = path.extname(name);
    const stem = name.slice(0, name.length - ext.length);
    let candidate = name;
    for (let i = 1; fs.existsSync(path.join(dir, candidate)); i += 1) candidate = `${stem}-${i}${ext}`;
    await fsp.writeFile(path.join(dir, candidate), bytes);
    return { path: `uploads/${day}/${candidate}`, name: candidate, size: bytes.length, mime: mimeOf(candidate) };
  },
  { rawBody: true },
);

route('GET', /^\/api\/workspace\/file$/, async (_req, res, { state, query }) => {
  const abs = workspaceFile(state, query.get('path'));
  let data;
  try { data = await fsp.readFile(abs); } catch { return errorResponse(res, 404, 'FILE_NOT_FOUND', 'no such file in the workspace'); }
  const mime = mimeOf(abs);
  res.writeHead(200, {
    // Never let an uploaded HTML/SVG run as part of the app.
    'content-type': mime === 'image/svg+xml' ? 'text/plain; charset=utf-8' : mime,
    'content-length': data.length,
    'x-content-type-options': 'nosniff',
    'content-disposition': mime.startsWith('image/') && mime !== 'image/svg+xml' ? 'inline' : `attachment; filename*=UTF-8''${encodeURIComponent(path.basename(abs))}`,
    'cache-control': 'private, max-age=3600',
  });
  res.end(data);
  return undefined;
});

/** Attachments named in a message must be files we stored. */
async function checkAttachments(state, list) {
  if (!Array.isArray(list) || !list.length) return [];
  if (list.length > 10) throw httpError(400, 'TOO_MANY_ATTACHMENTS', 'at most 10 attachments per message');
  const out = [];
  for (const item of list) {
    const rel = String(item?.path || '');
    if (!/^uploads\//.test(rel)) throw httpError(400, 'BAD_ATTACHMENT', 'attachments must be uploaded first');
    const abs = workspaceFile(state, rel);
    let size = 0;
    try { size = (await fsp.stat(abs)).size; } catch { throw httpError(400, 'BAD_ATTACHMENT', `no uploaded file at ${rel}`); }
    out.push({ path: rel.replace(/\\/g, '/'), mime: mimeOf(rel), size });
  }
  return out;
}

/** The text the bot sees: what you wrote, then where each attachment is. */
function withAttachments(text, attachments) {
  if (!attachments.length) return text;
  const kb = (n) => (n >= 1024 * 1024 ? `${(n / 1024 / 1024).toFixed(1)} MB` : `${Math.max(1, Math.round(n / 1024))} KB`);
  const lines = attachments.map((a) => `- ${a.path}（${a.mime.startsWith('image/') ? '图片' : '文件'}，${kb(a.size)}）`);
  // The chat model reads text only: point it at image_view for the pictures.
  const hint = attachments.some((a) => a.mime.startsWith('image/')) ? '\n（图片的内容要用 image_view 工具看。）' : '';
  return `${text || '（见附件）'}\n\n[附件] 都在共享工作区里：\n${lines.join('\n')}${hint}`;
}

// --- bot avatars -----------------------------------------------------------
//
// The contract the UI codes against:
//   POST   /api/bots/:id/avatar        raw image bytes -> {ok:true, imageUrl}
//   DELETE /api/bots/:id/avatar        -> {ok:true}
//   GET    /api/bots/:id/avatar?v=N    -> the bytes (immutable when ?v= is given)
// One image per bot, stored at data/avatars/<botId>.<ext>; the bot JSON only
// records shape and colour, so hasImage/imageUrl can never drift from the disk.

route(
  'POST',
  /^\/api\/bots\/(?<id>[^/]+)\/avatar$/,
  async (req, _res, { params }) => {
    const bot = await getBot(params.id);
    if (!bot) throw httpError(404, 'BOT_NOT_FOUND', `no bot with id "${params.id}"`);

    const declared = avatarMimeFromHeader(req.headers['content-type']);
    if (!declared) {
      throw httpError(400, 'AVATAR_BAD_TYPE', `content-type must be one of: ${AVATAR_MIME_TYPES.join(', ')}`);
    }

    // 2 MB is the limit from the contract; anything bigger is a clear 400, not a
    // generic 413, so the UI can explain it.
    const bytes = await readRawBody(req, AVATAR_MAX_BYTES, {
      code: 'AVATAR_TOO_LARGE',
      message: `an avatar image must be ${AVATAR_MAX_BYTES / (1024 * 1024)} MB or smaller`,
    });

    // Trust but verify: the image has to actually start with PNG/JPEG/WebP magic
    // bytes matching the declared type. Otherwise "avatar.png" containing HTML
    // would be served back as image/png.
    const sniffed = sniffImageType(bytes);
    if (!sniffed) {
      throw httpError(400, 'AVATAR_BAD_TYPE', 'body is not a PNG, JPEG or WebP image');
    }
    if (sniffed !== declared) {
      throw httpError(400, 'AVATAR_BAD_TYPE', `content-type says ${declared} but the bytes look like ${sniffed}`);
    }

    const imageUrl = await saveAvatarImage(bot.id, bytes, sniffed);
    return { ok: true, imageUrl };
  },
  { rawBody: true },
);

route('DELETE', /^\/api\/bots\/(?<id>[^/]+)\/avatar$/, async (_req, _res, { params }) => {
  const bot = await getBot(params.id);
  if (!bot) throw httpError(404, 'BOT_NOT_FOUND', `no bot with id "${params.id}"`);
  // Idempotent on purpose: "make this bot have no image" is a state, not a
  // transition, and the UI may have raced itself.
  await removeAvatarImage(bot.id);
  return { ok: true };
});

route('GET', /^\/api\/bots\/(?<id>[^/]+)\/avatar$/, async (_req, res, { params, query }) => {
  const bot = await getBot(params.id);
  if (!bot) throw httpError(404, 'BOT_NOT_FOUND', `no bot with id "${params.id}"`);

  const found = await findAvatarFile(bot.id);
  if (!found) {
    return errorResponse(res, 404, 'AVATAR_NOT_FOUND', `bot "${bot.id}" has no avatar image`);
  }

  const data = await fsp.readFile(found.file);
  // Cacheability is the client's call: with ?v=<anything> the URL is effectively
  // content-addressed, so it can be cached for a year; without one it has to be
  // revalidated every time.
  const immutable = query.has('v');
  res.writeHead(200, {
    'content-type': avatarMimeForExt(found.ext),
    'content-length': data.length,
    'cache-control': immutable ? 'private, max-age=31536000, immutable' : 'no-cache',
  });
  res.end(data);
  return undefined;
});

route('GET', /^\/api\/bots\/(?<id>[^/]+)\/memory$/, async (_req, _res, { params }) => {
  const bot = await getBot(params.id);
  if (!bot) throw httpError(404, 'BOT_NOT_FOUND', `no bot with id "${params.id}"`);
  const snapshot = await memory.memorySnapshot(bot.id);
  return {
    botId: bot.id,
    memoryFile: relativeToRoot(memory.memoryFileFor(bot.id)),
    sharedFile: relativeToRoot(memory.memoryFileFor('shared')),
    memory: snapshot.memory,
    shared: snapshot.shared,
    entries: snapshot.entries.map((e) => ({ text: e.text, when: e.ts ? new Date(e.ts).toISOString() : null })),
  };
});

route('GET', /^\/api\/bots\/(?<id>[^/]+)$/, async (_req, _res, { params }) => {
  const bot = await getBot(params.id);
  if (!bot) throw httpError(404, 'BOT_NOT_FOUND', `no bot with id "${params.id}"`);
  return { bot: publicBot(bot) };
});

// --- groups ----------------------------------------------------------------
//
// Contract (the UI codes against these shapes; do not rename fields):
//   GET    /api/groups                [{...group, members:[{id,name,role,avatar}], preview}]
//   POST   /api/groups                {name, members:[ids], coordinatorId?} -> {group}
//   GET    /api/groups/:id            -> {group}
//   PATCH  /api/groups/:id            {name?, members?, coordinatorId?} -> {group}
//   DELETE /api/groups/:id            -> {ok:true, id, deleted:true}
//   GET    /api/groups/:id/messages   [{id, ts, kind:'user'|'assistant'|'tool'|'status', from, text?, name?, status?}]
//   POST   /api/groups/:id/message    {text} -> {turnId}   (the coordinator runs; results go over SSE)
//
// Members are stored as bot ids but every response projects them to objects, so
// the UI never has to join the roster itself.

async function botsById() {
  return new Map((await listBots()).map((bot) => [bot.id, bot]));
}

/** Resolve a bot reference (id or display name) to an id, or null. */
async function resolveBotRef(ref, bots = null) {
  const key = String(ref ?? '').trim().toLowerCase();
  if (!key) return null;
  const list = bots || (await listBots());
  const bot = list.find((b) => b.id.toLowerCase() === key || b.name.toLowerCase() === key);
  return bot ? bot.id : null;
}

/** Resolve POST/PATCH members. Unknown references are a 400, not silently dropped. */
async function resolveMemberIds(input, bots) {
  const list = bots || (await listBots());
  const ids = [];
  const unknown = [];
  for (const ref of groups.normalizeMemberIds(input)) {
    const id = await resolveBotRef(ref, list);
    if (!id) unknown.push(ref);
    else if (!ids.includes(id)) ids.push(id);
  }
  if (unknown.length) {
    throw httpError(400, 'GROUP_UNKNOWN_MEMBER', `no bot matches: ${unknown.join(', ')}`);
  }
  return ids;
}

async function publicGroup(group, bots) {
  const byId = bots instanceof Map ? bots : await botsById();
  return {
    id: group.id,
    name: group.name,
    members: group.members
      .map((id) => byId.get(id))
      .filter(Boolean)
      .map((bot) => ({ id: bot.id, name: bot.name, role: bot.role, avatar: bot.avatar })),
    coordinatorId: group.coordinatorId,
    createdAt: group.createdAt,
    updatedAt: group.updatedAt,
    preview: await groups.lastGroupPreview(group.id),
  };
}

route('GET', /^\/api\/groups$/, async () => {
  const [all, byId] = await Promise.all([groups.listGroups(), botsById()]);
  return Promise.all(all.map((group) => publicGroup(group, byId)));
});

route('POST', /^\/api\/groups$/, async (_req, _res, { body, state }) => {
  // Size check before name resolution: "too few members" is the useful answer
  // for a one-member request, even when that one reference is also unknown.
  groups.assertMemberCount(groups.normalizeMemberIds(body?.members));

  const bots = await listBots();
  const memberIds = await resolveMemberIds(body?.members, bots);

  let coordinatorId;
  if (body?.coordinatorId !== undefined && String(body.coordinatorId ?? '').trim() !== '') {
    coordinatorId = await resolveBotRef(body.coordinatorId, bots);
    if (!coordinatorId) {
      throw httpError(400, 'GROUP_UNKNOWN_MEMBER', `no bot matches "${body.coordinatorId}"`);
    }
  }

  const group = await groups.createGroup({ name: body?.name, members: memberIds, coordinatorId });
  state.bus.emit({ type: 'roster.changed', scope: 'groups', action: 'create', groupId: group.id });
  // Members introduce themselves (job, progress, next step) right away.
  state.runtime.kickoffGroup(group.id).catch((err) => console.error('[group] kickoff failed:', err.message));
  return { group: await publicGroup(group, bots) };
});

route('GET', /^\/api\/groups\/(?<id>[^/]+)\/messages$/, async (_req, _res, { params, query }) => {
  const group = await groups.getGroup(params.id);
  if (!group) throw httpError(404, 'GROUP_NOT_FOUND', `no group with id "${params.id}"`);
  const limit = Math.min(Number(query.get('limit')) || 200, 1000);
  const messages = await groups.readGroupMessages(group.id, { limit });
  return messages.map(groups.publicGroupMessage);
});

route('POST', /^\/api\/groups\/(?<id>[^/]+)\/message$/, async (_req, _res, { params, body, state }) => {
  const group = await groups.getGroup(params.id);
  if (!group) throw httpError(404, 'GROUP_NOT_FOUND', `no group with id "${params.id}"`);

  const text = withAttachments(String(body?.text ?? '').trim(), await checkAttachments(state, body?.attachments));
  if (!text) throw httpError(400, 'EMPTY_MESSAGE', 'text is required');
  if (text.length > 20000) throw httpError(400, 'MESSAGE_TOO_LONG', 'text is limited to 20000 characters');

  // A group can be left in a state it cannot run in (a member was deleted). Say
  // so plainly instead of failing inside the turn.
  const blocker = groups.groupRunBlocker(group);
  if (blocker) throw httpError(blocker.status, blocker.code, blocker.message);

  const bots = await listBots();
  const byId = new Map(bots.map((bot) => [bot.id, bot]));
  const coordinator = byId.get(group.coordinatorId);
  if (!coordinator) throw httpError(409, 'GROUP_NO_COORDINATOR', `"${group.name}" has no coordinator bot`);
  const members = group.members
    .filter((id) => byId.has(id))
    .map((id) => ({ id, name: byId.get(id).name, role: byId.get(id).role }));

  // Answer immediately with the turn id; the turn streams over SSE and its
  // transcript lands in data/groups/<id>.jsonl.
  const turnId = uid('turn');
  state.runtime
    .runGroupMessage({
      group: { id: group.id, name: group.name, coordinatorId: group.coordinatorId, members },
      text,
      turnId,
    })
    .catch((err) => {
      state.bus.emit({ type: 'error', groupId: group.id, turnId, message: err.message });
    });

  return { turnId };
});

route('PATCH', /^\/api\/groups\/(?<id>[^/]+)$/, async (_req, _res, { params, body, state }) => {
  const current = await groups.getGroup(params.id);
  if (!current) throw httpError(404, 'GROUP_NOT_FOUND', `no group with id "${params.id}"`);

  const bots = await listBots();
  const patch = {};
  if (body?.name !== undefined) patch.name = body.name;
  if (body?.members !== undefined) {
    groups.assertMemberCount(groups.normalizeMemberIds(body.members));
    patch.members = await resolveMemberIds(body.members, bots);
  }
  if (body?.coordinatorId !== undefined) {
    const coordinatorId = await resolveBotRef(body.coordinatorId, bots);
    if (!coordinatorId) {
      throw httpError(400, 'GROUP_UNKNOWN_MEMBER', `no bot matches "${body.coordinatorId}"`);
    }
    patch.coordinatorId = coordinatorId;
  }

  const updated = await groups.updateGroup(current.id, patch);
  state.bus.emit({ type: 'roster.changed', scope: 'groups', action: 'update', groupId: updated.id });
  return { group: await publicGroup(updated, bots) };
});

route('DELETE', /^\/api\/groups\/(?<id>[^/]+)$/, async (_req, _res, { params, state }) => {
  const removed = await groups.deleteGroup(params.id);
  state.bus.emit({ type: 'roster.changed', scope: 'groups', action: 'delete', groupId: params.id });
  return { ok: true, id: removed.id, deleted: true, name: removed.name };
});

route('GET', /^\/api\/groups\/(?<id>[^/]+)$/, async (_req, _res, { params }) => {
  const group = await groups.getGroup(params.id);
  if (!group) throw httpError(404, 'GROUP_NOT_FOUND', `no group with id "${params.id}"`);
  return { group: await publicGroup(group) };
});

// --- computer (watch and manage the hub box) --------------------------------

const SHOT_FILE = () => path.join(P.dataDir, 'screen.png');

route('GET', /^\/api\/computer$/, async (req, _res, { state, query }) => {
  const shot = fs.existsSync(SHOT_FILE()) ? SHOT_FILE() : null;
  const snap = await computerSnapshot({ screenshotPath: shot });

  // Bot-scoped desktops: when ?botId= is given and that bot has its own X
  // display, the viewer must show THAT desktop, not the machine's shared one.
  let botId = String(query?.get?.('botId') || '').trim();
  if (!botId && desktopSupport().available && state.config?.primaryBotId) {
    botId = state.config.primaryBotId;
  }
  let perBot = null;
  if (botId) {
    try {
      perBot = desktopInfo(botId);
      if (!perBot.running && desktopSupport().available) perBot = await ensureDesktop(botId);
    } catch (err) {
      perBot = { botId, running: false, error: err.message };
    }
    if (perBot?.url) {
      snap.desktop = { url: perBot.url, botId, perBot: true, display: perBot.display };
    }
    snap.perBotDesktop = { ...perBot, support: desktopSupport() };
  }
  // A fresh Linux machine installs its desktop and browser in the background
  // after the Hub is up (setup-linux.sh); say how far that is.
  const setup = readJsonSync(path.join(P.dataDir, 'desktop-setup.json'), null);
  // Elapsed time is worked out here, on this machine's own clock: a restored
  // VM snapshot can be days off, and the viewer's clock is not this one.
  if (setup?.state && setup.state !== 'done') {
    // Prefer the install script's own count of seconds (a restored VM often
    // sets its clock mid-install), plus the time since it last wrote.
    let elapsedSec = null;
    if (Number.isFinite(setup.elapsed)) {
      let since = 0;
      try { since = (Date.now() - fs.statSync(path.join(P.dataDir, 'desktop-setup.json')).mtimeMs) / 1000; } catch { /* none */ }
      elapsedSec = Math.round(setup.elapsed + (since > 0 && since < 3600 ? since : 0));
    } else {
      const started = Date.parse(setup.startedAt || '');
      const s = Number.isFinite(started) ? Math.round((Date.now() - started) / 1000) : NaN;
      elapsedSec = s >= 0 && s < 6 * 3600 ? s : null; // nonsense after a clock jump: say nothing
    }
    snap.desktopSetup = { state: setup.state, detail: setup.detail || '', startedAt: setup.startedAt || null, elapsedSec };
  }
  // noVNC asks for the VNC password every single time, which is unbearable when
  // the viewer opens in a panel. Hand it the password once via the URL.
  // Source: DESK_VNC_PASSWORD, or data/vnc.json written by the installer.
  let vncPass = process.env.DESK_VNC_PASSWORD || '';
  if (!vncPass) {
    try {
      vncPass = JSON.parse(fs.readFileSync(path.join(P.dataDir, 'vnc.json'), 'utf8')).password || '';
    } catch { /* not configured */ }
  }
  if (vncPass && snap.desktop?.url && !snap.desktop.perBot) {
    snap.desktop.url += `&password=${encodeURIComponent(vncPass)}`;
    snap.desktop.hasPassword = true;
  }
  let browser = null;
  try {
    const { getBrowserManager, browserSupport } = await import('./browser.mjs');
    const manager = getBrowserManager();
    const support = browserSupport();
    browser = {
      supported: support.supported,
      transport: support.transport || null,
      running: Boolean(manager?.isRunning?.()),
      pid: manager?.pid || null,
      url: manager?.currentUrl || null,
    };
  } catch (err) {
    browser = { supported: false, error: err.message };
  }
  return { ...snap, browser, server: { version: VERSION, port: state.port, host: state.host } };
});

route('GET', /^\/api\/computer\/screenshot$/, async (_req, res) => {
  const target = SHOT_FILE();
  const shot = await captureScreen(target);
  if (!shot.ok) {
    res.writeHead(501, { 'content-type': 'application/json; charset=utf-8' });
    res.end(JSON.stringify({ error: { code: 'SCREENSHOT_UNAVAILABLE', message: shot.reason } }));
    return;
  }
  const buf = await fsp.readFile(target);
  res.writeHead(200, { 'content-type': 'image/png', 'cache-control': 'no-store', 'content-length': buf.length });
  res.end(buf);
});

// --- policy ----------------------------------------------------------------

//   GET /api/policy -> {mode, level, autoApproveAll, builtinDeny:n, extraDeny:[{id,text}]}
//   PUT /api/policy {level?} | {addDeny: "git push"} | {removeDeny: id} | {autoApproveAll} (older clients)

function publicPolicy(policy) {
  const eff = effectivePolicy(policy);
  return {
    mode: eff.mode,
    level: eff.level,
    // kept for older clients and the machine checks
    autoApproveAll: eff.autonomous,
    autoApproveMedium: Boolean(policy?.autoApproveMedium),
    builtinDeny: eff.builtinDeny.length,
    extraDeny: eff.extraDeny.map((e) => ({ id: e.id, text: e.text })),
    rules: (policy?.rules || []).map((r) => ({ id: r.id, text: r.text, action: r.action })),
    // Desktop takeover on this machine: 'control' (see and use) or 'view' (see only).
    takeover: policy?.takeover === 'view' ? 'view' : 'control',
    denyPatterns: eff.denyPatterns.length,
    // What the bots may touch on this machine (src/boundary.mjs).
    workspace: P.workspaceDir,
    folders: (policy?.folders || []).map((f) => ({ id: f.id, path: f.path, write: Boolean(f.write) })),
    outside: policy?.outside === 'deny' ? 'deny' : 'ask',
    sudo: policy?.sudo === 'allow' ? 'allow' : 'ask',
    platform: process.platform,
  };
}

route('GET', /^\/api\/policy$/, async (_req, _res, { state }) => publicPolicy(state.config.policy));

route('PUT', /^\/api\/policy$/, async (_req, _res, { body, state }) => {
  const next = { ...(state.config.policy || {}) };
  if (body?.level !== undefined) {
    if (!APPROVAL_LEVELS.includes(body.level)) throw httpError(400, 'BAD_LEVEL', `level must be one of ${APPROVAL_LEVELS.join(', ')}`);
    next.level = body.level;
  }
  if (typeof body?.autoApproveAll === 'boolean') {
    next.level = body.autoApproveAll ? 'auto' : 'standard';
    if (effectivePolicy(next).mode === 'remote') next.remoteAutonomy = body.autoApproveAll;
    else next.autoApproveAll = body.autoApproveAll;
  }
  if (typeof body?.autoApproveMedium === 'boolean') next.autoApproveMedium = body.autoApproveMedium;
  if (body?.addDeny !== undefined) {
    const text = String(body.addDeny || '').trim().slice(0, 80);
    const pattern = phraseToPattern(text);
    if (!pattern) throw httpError(400, 'BAD_DENY', '填一个命令或词，比如 git push');
    next.extraDeny = [...(next.extraDeny || []).filter((e) => e.text !== text), { id: uid('deny'), text, pattern }];
  }
  if (body?.removeDeny !== undefined) {
    next.extraDeny = (next.extraDeny || []).filter((e) => e.id !== body.removeDeny);
  }
  if (body?.takeover !== undefined) {
    if (!['view', 'control'].includes(body.takeover)) throw httpError(400, 'BAD_TAKEOVER', "takeover must be 'view' or 'control'");
    next.takeover = body.takeover;
  }
  if (body?.addRule !== undefined) {
    const rule = normalizeRule(body.addRule);
    if (!rule) throw httpError(400, 'BAD_RULE', '写一句规则，比如「发邮件先问我」');
    if ((next.rules || []).length >= 30) throw httpError(400, 'TOO_MANY_RULES', '规则最多 30 条');
    next.rules = [...(next.rules || []).filter((r) => r.text !== rule.text), { id: uid('rule'), ...rule }];
  }
  if (body?.removeRule !== undefined) {
    next.rules = (next.rules || []).filter((r) => r.id !== body.removeRule);
  }
  if (body?.addFolder !== undefined) {
    const raw = String(body.addFolder?.path || '').trim();
    if (!raw || !path.isAbsolute(raw)) throw httpError(400, 'BAD_FOLDER', '填这台机器上的完整路径，比如 D:\\资料 或 /home/me/docs');
    const abs = path.resolve(raw);
    const st = await fsp.stat(abs).catch(() => null);
    if (!st?.isDirectory()) throw httpError(400, 'BAD_FOLDER', `这台机器上没有这个文件夹：${abs}`);
    if (abs === path.parse(abs).root) throw httpError(400, 'BAD_FOLDER', '不能开放整个磁盘的根目录');
    if ((next.folders || []).length >= 30) throw httpError(400, 'TOO_MANY_FOLDERS', '最多开放 30 个文件夹');
    next.folders = [...(next.folders || []).filter((f) => f.path !== abs), { id: uid('dir'), path: abs, write: Boolean(body.addFolder?.write) }];
  }
  if (body?.removeFolder !== undefined) {
    next.folders = (next.folders || []).filter((f) => f.id !== body.removeFolder);
  }
  if (body?.folderWrite !== undefined) {
    next.folders = (next.folders || []).map((f) => (f.id === body.folderWrite?.id ? { ...f, write: Boolean(body.folderWrite?.write) } : f));
  }
  if (body?.outside !== undefined) {
    if (!['ask', 'deny'].includes(body.outside)) throw httpError(400, 'BAD_OUTSIDE', "outside must be 'ask' or 'deny'");
    next.outside = body.outside;
  }
  if (body?.sudo !== undefined) {
    if (!['ask', 'allow'].includes(body.sudo)) throw httpError(400, 'BAD_SUDO', "sudo must be 'ask' or 'allow'");
    next.sudo = body.sudo;
  }
  state.config.policy = next;
  await writeAssistantConfig({ ...state.config, workspaceDir: undefined });
  const change = {};
  for (const k of ['level', 'takeover', 'addDeny', 'removeDeny', 'addRule', 'removeRule', 'autoApproveAll', 'addFolder', 'removeFolder', 'folderWrite', 'outside', 'sudo']) {
    if (body?.[k] !== undefined) change[k] = body[k];
  }
  await audit({ kind: 'policy.changed', change });
  const pub = publicPolicy(next);
  state.bus.emit({ type: 'policy.changed', autoApproveAll: pub.autoApproveAll, level: pub.level });
  return pub;
});

// --- approvals -------------------------------------------------------------

route('GET', /^\/api\/approvals$/, async (_req, _res, { query, state }) => {
  return state.approvals.list({
    status: query.get('status') || undefined,
    botId: query.get('botId') || undefined,
    limit: Number(query.get('limit')) || 100,
  });
});

route('POST', /^\/api\/approvals\/(?<id>[^/]+)$/, async (_req, _res, { params, body, state }) => {
  const decision = body?.decision;
  if (!decision) throw httpError(400, 'DECISION_REQUIRED', 'body needs { decision: "approve" | "deny" }');
  const record = state.approvals.decide(params.id, decision, body?.note || '');
  if (!record) throw httpError(404, 'APPROVAL_NOT_FOUND', `no approval with id "${params.id}"`);
  if (record.error) throw httpError(409, 'APPROVAL_CONFLICT', record.error);

  state.bus.emit({
    type: 'approval.decided',
    approvalId: record.id,
    botId: record.botId,
    turnId: record.turnId,
    status: record.status,
    note: record.note,
    late: Boolean(record.late),
    restored: Boolean(record.restored),
  });

  // A card restored after a restart has no live turn behind it. The human's
  // answer still has to mean something, so:
  //   - a live-chat card that was approved replays the one tool call the human
  //     actually approved (it provably had not run yet: pending cards never run);
  //   - an unattended (routine) card is recorded but never replayed - those runs
  //     were already reported as needs_attention, and "approve & re-run a whole
  //     routine" would be a different, bigger promise.
  // Either way the transcript says exactly what happened.
  if (record.restored) {
    const ts = nowIso();
    let note;
    let replay = null;

    if (record.status === 'approved') {
      replay = await replayRestoredApproval(state, record);
      if (replay.ran) {
        note =
          `Approved "${record.toolName}" from a card restored after a restart. ` +
          (replay.ok
            ? 'The approved tool ran now. The rest of that turn did not resume - ask again for anything else.'
            : `The approved tool ran now but failed: ${replay.error || 'unknown error'}. The rest of that turn did not resume.`);
        try {
          await appendJsonl(sessionFile(record.botId || 'unknown'), {
            ts,
            kind: 'tool',
            name: record.toolName,
            args: replay.args || {},
            ok: replay.ok,
            risk: record.risk || null,
            output: replay.result ?? null,
            turnId: record.turnId || null,
            restored: true,
          });
        } catch (err) {
          console.error('[approvals] could not append the replayed tool result:', err.message);
        }
        state.bus.emit({
          type: 'tool.result',
          botId: record.botId,
          turnId: record.turnId,
          callId: `restored_${record.id}`,
          name: record.toolName,
          ok: replay.ok,
          risk: record.risk,
          result: replay.result,
          restored: true,
        });
        await audit({
          kind: 'tool.run',
          botId: record.botId,
          turnId: record.turnId,
          tool: record.toolName,
          risk: record.risk,
          decision: 'restored_approval',
          ok: replay.ok,
          args: replay.args || {},
          result: safeJson(replay.result, 1200),
          restored: true,
        });
      } else if (replay.skipped === 'unattended') {
        note =
          `Approved "${record.toolName}" from a routine card restored after a restart, but the run that asked ` +
          'was unattended and already stopped. Nothing was re-run - run the routine again if you still want it.';
      } else {
        note = `Approved "${record.toolName}" from a card restored after a restart, but it could not be replayed (${replay.error}). Nothing ran.`;
      }
    } else {
      note = `Denied "${record.toolName}" from a card restored after a restart. Nothing ran.`;
    }

    if (record.botId) {
      try {
        await appendJsonl(sessionFile(record.botId), {
          ts,
          kind: 'approval',
          approvalId: record.id,
          toolName: record.toolName,
          risk: record.risk,
          reason: record.reason || '',
          decision: record.status,
          note: record.note || '',
          args: record.args || '{}',
          turnId: record.turnId || null,
          restored: true,
        });
        await appendJsonl(sessionFile(record.botId), {
          ts,
          kind: 'assistant',
          text: note,
          system: true,
          restored: true,
          turnId: record.turnId || null,
          source: 'system',
        });
      } catch (err) {
        console.error('[approvals] could not append the restored decision:', err.message);
      }
      state.bus.emit({
        type: 'message',
        botId: record.botId,
        turnId: record.turnId,
        text: note,
        final: true,
        system: true,
        restored: true,
      });
    }
  }
  return { approval: record };
});

/**
 * Replay the single tool call behind a restored, approved live-chat card.
 * Returns {ran, ok, result} or {ran:false, skipped|error}.
 */
async function replayRestoredApproval(state, record) {
  if (record.unattended) return { ran: false, skipped: 'unattended' };
  const tool = state.registry.get(record.toolName);
  if (!tool) return { ran: false, error: `the tool "${record.toolName}" no longer exists` };

  const bot = await getBot(record.botId);
  if (!bot) return { ran: false, error: 'the bot that asked no longer exists' };
  if (!state.registry.isGranted(bot, record.toolName)) {
    return { ran: false, error: `"${record.toolName}" is no longer granted to ${bot.name}` };
  }

  let args;
  try {
    args = JSON.parse(record.args || '{}');
  } catch {
    return { ran: false, error: 'the stored arguments were truncated by the crash' };
  }

  const ctx = {
    bot,
    config: state.config,
    workspaceDir: state.workspaceDir,
    turnId: record.turnId,
    unattended: false,
    depth: 0,
    signal: new AbortController().signal,
    memory,
    skills,
    bots: { listBots, getBot },
    emit: (event) => state.bus.emit({ ...event, botId: bot.id, turnId: record.turnId, restored: true }),
  };

  try {
    const result = await tool.run(args, ctx);
    const ok = result?.ok !== false && !result?.error;
    return {
      ran: true,
      ok,
      result,
      args,
      error: ok ? null : result?.error?.message || 'the tool reported a failure',
    };
  } catch (err) {
    return {
      ran: true,
      ok: false,
      args,
      result: { error: { code: err.code || 'TOOL_FAILED', message: err.message } },
      error: err.message,
    };
  }
}

/** JSON for the audit log, bounded like the agent's own audit records. */
function safeJson(value, max = 1200) {
  try {
    const json = JSON.stringify(value);
    return json.length > max ? `${json.slice(0, max)}...` : json;
  } catch {
    return '(unserialisable)';
  }
}

// --- routines --------------------------------------------------------------

route('GET', /^\/api\/routines$/, async (_req, _res, { state }) => {
  return state.routines.list().map(publicRoutine);
});

route('POST', /^\/api\/routines$/, async (_req, _res, { body, state }) => {
  const created = await state.routines.create(body || {});
  return { routine: publicRoutine(created) };
});

route('PATCH', /^\/api\/routines\/(?<id>[^/]+)$/, async (_req, _res, { params, body, state }) => {
  const updated = await state.routines.update(params.id, body || {});
  return { routine: publicRoutine(updated) };
});

route('DELETE', /^\/api\/routines\/(?<id>[^/]+)$/, async (_req, _res, { params, state }) => {
  return state.routines.remove(params.id);
});

route('POST', /^\/api\/routines\/(?<id>[^/]+)\/test$/, async (_req, _res, { params, state }) => {
  const result = await state.routines.runNow(params.id, { trigger: 'test' });
  return { routine: publicRoutine(result.routine), run: result.run };
});

// --- skills ----------------------------------------------------------------

route('GET', /^\/api\/skills$/, async (_req, _res, { query }) => {
  const botId = query.get('botId');
  const bot = botId ? await getBot(botId) : null;
  const list = bot ? await skills.listSkillsForBot(bot.skills) : await skills.listSkills();
  return list;
});

route('GET', /^\/api\/skills\/(?<name>[^/]+)$/, async (_req, _res, { params }) => {
  const skill = await skills.readSkill(params.name);
  if (!skill) throw httpError(404, 'SKILL_NOT_FOUND', `no skill named "${params.name}"`);
  return { skill: { ...skill, raw: skill.raw } };
});

// --- audit / turns ---------------------------------------------------------

//   GET /api/audit[?limit=&view=important|all|approvals|blocked|takeover|changes]
//   POST /api/audit/takeover {botId, mode}  (the UI reports a takeover)
const AUDIT_VIEWS = {
  important: (r) => (r.kind === 'tool.run' ? r.risk && r.risk !== 'LOW' : r.kind !== 'approval.requested'),
  approvals: (r) => r.kind === 'approval.resolved' || r.kind === 'tool.approval_denied',
  blocked: (r) => r.kind === 'tool.denied' || (r.kind === 'approval.resolved' && r.status !== 'approved'),
  takeover: (r) => r.kind === 'desktop.takeover',
  changes: (r) => r.kind === 'policy.changed' || r.kind === 'bot.abilities',
  all: () => true,
};

route('GET', /^\/api\/audit$/, async (_req, _res, { query }) => {
  const limit = Math.min(Number(query.get('limit')) || 100, 500);
  const view = AUDIT_VIEWS[query.get('view')];
  if (!view) return readAudit({ limit }); // older clients: the raw tail
  return (await readAudit({ limit: 5000 })).filter(view).slice(0, limit);
});

route('POST', /^\/api\/audit\/takeover$/, async (req, _res, { body }) => {
  await audit({
    kind: 'desktop.takeover',
    botId: String(body?.botId || '').slice(0, 80) || null,
    mode: body?.mode === 'view' ? 'view' : 'control',
    from: clientIp(req),
  });
  return { ok: true };
});

route('GET', /^\/api\/turns$/, async (_req, _res, { state }) => {
  return state.runtime.activeTurns();
});

route('POST', /^\/api\/turns\/(?<id>[^/]+)\/cancel$/, async (_req, _res, { params, state }) => {
  const cancelled = state.runtime.cancel(params.id);
  if (!cancelled) throw httpError(404, 'TURN_NOT_FOUND', `no active turn "${params.id}"`);
  return { cancelled: true, turnId: params.id };
});

// --- SSE -------------------------------------------------------------------

route('GET', /^\/api\/stream$/, async (req, res, { query, state }) => {
  const botId = query.get('botId') || '';
  // A group stream carries only events tagged with that groupId. Turn events of
  // the coordinator's group turn set it; private bot_message replies do not.
  const groupId = query.get('groupId') || '';
  res.writeHead(200, {
    'content-type': 'text/event-stream; charset=utf-8',
    'cache-control': 'no-cache, no-transform',
    connection: 'keep-alive',
    'x-accel-buffering': 'no',
  });
  res.write(`retry: 2000\n: connected ${nowIso()}\n\n`);

  let closed = false;
  // Roster edits are global: every window needs them regardless of which bot
  // or group it happens to be looking at.
  const GLOBAL_EVENTS = new Set(['roster.changed', 'ui.command', 'settings.changed', 'attention.changed', 'feishu.changed']);
  const send = (event) => {
    if (closed) return;
    if (!GLOBAL_EVENTS.has(event.type)) {
      if (botId && event.botId && event.botId !== botId) return;
      if (groupId && event.groupId !== groupId) return;
    }
    try {
      // One `data:` line per event; the UI reads event.type from the payload.
      res.write(`data: ${JSON.stringify(event)}\n\n`);
    } catch {
      closed = true;
    }
  };

  const unsubscribe = state.bus.subscribe(send);

  // Heartbeat keeps proxies and idle TCP connections from dropping the stream.
  const heartbeat = setInterval(() => {
    if (closed) return;
    try {
      res.write(`: ping ${Date.now()}\n\n`);
    } catch {
      closed = true;
    }
  }, 15000);
  if (typeof heartbeat.unref === 'function') heartbeat.unref();

  const cleanup = () => {
    if (closed) return;
    closed = true;
    clearInterval(heartbeat);
    unsubscribe();
  };
  req.on('close', cleanup);
  req.on('error', cleanup);
  res.on('close', cleanup);

  // Never return: this response is owned by the stream until the client leaves.
  return undefined;
});

// ---------------------------------------------------------------------------
// response helpers
// ---------------------------------------------------------------------------

function jsonResponse(res, status, payload) {
  const body = JSON.stringify(payload);
  res.writeHead(status, {
    'content-type': 'application/json; charset=utf-8',
    'content-length': Buffer.byteLength(body),
    'cache-control': 'no-store',
  });
  res.end(body);
}

function errorResponse(res, status, code, message) {
  if (res.headersSent) {
    res.end();
    return;
  }
  jsonResponse(res, status, { error: { code, message } });
}

function httpError(status, code, message) {
  const err = new Error(message);
  err.status = status;
  err.code = code;
  return err;
}

async function readJsonBody(req, maxBytes = MAX_BODY_BYTES) {
  const chunks = [];
  let size = 0;
  for await (const chunk of req) {
    size += chunk.length;
    if (size > maxBytes) {
      const err = new Error(`request body exceeds ${maxBytes} bytes`);
      err.status = 413;
      err.code = 'BODY_TOO_LARGE';
      throw err;
    }
    chunks.push(chunk);
  }
  if (!chunks.length) return {};
  const raw = Buffer.concat(chunks).toString('utf8').trim();
  if (!raw) return {};
  try {
    return JSON.parse(raw);
  } catch {
    const err = new Error('request body is not valid JSON');
    err.status = 400;
    err.code = 'BAD_JSON';
    throw err;
  }
}

/**
 * Read a request body as raw bytes, for uploads that are not JSON.
 *
 * An oversized body is drained (without being buffered) before the error is
 * returned: if we stopped reading the moment the limit was passed, a browser
 * uploading 3 MB would usually see a connection reset instead of a JSON
 * AVATAR_TOO_LARGE. Dropping the chunks keeps memory bounded; the socket only
 * carries bytes the client chose to send.
 */
async function readRawBody(req, maxBytes, { code = 'BODY_TOO_LARGE', message } = {}) {
  const chunks = [];
  let size = 0;
  for await (const chunk of req) {
    size += chunk.length;
    if (size <= maxBytes) chunks.push(chunk);
  }
  if (size > maxBytes) {
    const err = new Error(message || `request body exceeds ${maxBytes} bytes`);
    err.status = 400;
    err.code = code;
    throw err;
  }
  return Buffer.concat(chunks);
}

/** `image/jpg` is what some clients send; treat it as jpeg. */
function avatarMimeFromHeader(value) {
  const declared = String(value || '').split(';')[0].trim().toLowerCase();
  if (declared === 'image/jpg') return 'image/jpeg';
  return AVATAR_MIME_TYPES.includes(declared) ? declared : null;
}

/** The first few bytes are enough to tell these three formats apart. */
function sniffImageType(bytes) {
  if (!bytes || bytes.length < 12) return null;
  if (bytes[0] === 0x89 && bytes[1] === 0x50 && bytes[2] === 0x4e && bytes[3] === 0x47) return 'image/png';
  if (bytes[0] === 0xff && bytes[1] === 0xd8 && bytes[2] === 0xff) return 'image/jpeg';
  if (bytes.toString('ascii', 0, 4) === 'RIFF' && bytes.toString('ascii', 8, 12) === 'WEBP') return 'image/webp';
  return null;
}

// ---------------------------------------------------------------------------
// static files
// ---------------------------------------------------------------------------

const MIME = {
  '.html': 'text/html; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.mjs': 'text/javascript; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
  '.svg': 'image/svg+xml',
  '.png': 'image/png',
  '.ico': 'image/x-icon',
  '.woff2': 'font/woff2',
  '.txt': 'text/plain; charset=utf-8',
  '.md': 'text/markdown; charset=utf-8',
};

async function serveStatic(req, res, pathname) {
  if (req.method !== 'GET' && req.method !== 'HEAD') {
    return errorResponse(res, 405, 'METHOD_NOT_ALLOWED', 'static files are GET/HEAD only');
  }

  const relative = pathname === '/' ? 'index.html' : pathname.replace(/^\/+/, '');
  const target = path.resolve(P.publicDir, relative);

  // Path traversal guard: the resolved file must stay inside public/.
  const publicRoot = P.publicDir.endsWith(path.sep) ? P.publicDir : P.publicDir + path.sep;
  if (target !== P.publicDir && !target.startsWith(publicRoot)) {
    return errorResponse(res, 403, 'FORBIDDEN', 'path escapes the public directory');
  }

  let data;
  try {
    data = await fsp.readFile(target);
  } catch (err) {
    if (err.code === 'ENOENT' || err.code === 'EISDIR') {
      return errorResponse(res, 404, 'NOT_FOUND', `no file at ${pathname}`);
    }
    throw err;
  }

  const type = MIME[path.extname(target).toLowerCase()] || 'application/octet-stream';
  res.writeHead(200, {
    'content-type': type,
    'content-length': data.length,
    'cache-control': 'no-cache',
  });
  if (req.method === 'HEAD') return res.end();
  return res.end(data);
}

// ---------------------------------------------------------------------------
// projections (what the UI is allowed to see)
// ---------------------------------------------------------------------------

function publicBot(bot) {
  return {
    id: bot.id,
    name: bot.name,
    avatarColor: bot.avatarColor,
    avatar: bot.avatar,
    role: bot.role,
    persona: bot.persona,
    primary: bot.primary,
    tools: bot.tools,
    skills: bot.skills,
    policy: bot.policy,
    model: bot.model || '',
    createdAt: bot.createdAt,
  };
}

function publicRoutine(routine) {
  return {
    id: routine.id,
    botId: routine.botId,
    name: routine.name,
    instruction: routine.instruction,
    schedule: routine.schedule,
    kind: routine.kind,
    timezone: routine.timezone,
    enabled: routine.enabled,
    lastRun: routine.lastRun,
    nextRun: routine.nextRun,
    lastStatus: routine.lastStatus,
    runs: routine.runs.slice(-10),
  };
}

/** Session record -> one chat bubble / chip. */
function toMessageItem(record, index) {
  const base = { id: `${record.turnId || 'turn'}-${index}`, ts: record.ts, turnId: record.turnId || null };
  switch (record.kind) {
    case 'user':
      return { ...base, role: 'user', text: record.text, source: record.source || 'chat' };
    case 'assistant':
      return { ...base, role: 'assistant', text: record.text, system: Boolean(record.system), source: record.source || 'chat' };
    case 'tool':
      return {
        ...base,
        role: 'tool',
        name: record.name,
        args: record.args || {},
        ok: Boolean(record.ok),
        risk: record.risk || null,
        denied: Boolean(record.denied),
        needsApproval: Boolean(record.needsApproval),
        reason: record.reason || null,
        output: record.output ?? null,
      };
    case 'approval':
      return {
        ...base,
        role: 'approval',
        approvalId: record.approvalId || null,
        tool: record.toolName,
        risk: record.risk || null,
        reason: record.reason || '',
        decision: record.decision || null,
        note: record.note || '',
        args: record.args || '{}',
      };
    case 'turn':
      return { ...base, role: 'status', status: record.status, summary: record.summary, steps: record.steps };
    default:
      return { ...base, role: 'system', text: record.text || record.kind };
  }
}

function relativeToRoot(file) {
  return path.relative(P.root, file).split(path.sep).join('/');
}

function safeDecode(value) {
  try {
    return decodeURIComponent(value);
  } catch {
    return value;
  }
}

// ---------------------------------------------------------------------------
// main
// ---------------------------------------------------------------------------

export async function startServer({ port = DEFAULT_PORT, host = HOST } = {}) {
  // Binding beyond loopback is a deliberate, loud decision. Refusing by default
  // is the whole security posture: "no authentication" used to be safe because
  // the socket was local, and now that auth exists it is still opt-in.
  if (!isLoopbackHost(host) && !remoteAccessAllowed()) {
    const err = new Error(
      `refusing to bind ${host}: remote access is disabled. ` +
        'Set ASSIST_ALLOW_REMOTE=1 to expose this assistant to your network (pairing is still required).',
    );
    err.code = 'REMOTE_NOT_ALLOWED';
    throw err;
  }

  const { server, state } = await createAssistant({ port, host });

  await new Promise((resolve, reject) => {
    server.once('error', reject);
    server.listen(port, host, () => {
      server.removeListener('error', reject);
      resolve();
    });
  });

  const actualPort = server.address().port;
  const url = `http://${host}:${actualPort}`;
  const remote = !isLoopbackHost(host);
  // A wildcard bind has no address of its own; pick the LAN interface a phone
  // would plausibly be on. A specific bind knows its own address.
  const wildcard = ['0.0.0.0', '::', '[::]', ''].includes(String(host));
  const lanAddress = wildcard ? preferredLanAddress() : host;
  const lanUrl = remote ? lanUrlFor(lanAddress, actualPort) : null;

  // Routes need the real port to build pairing URLs; state is shared by closure.
  state.port = actualPort;
  state.host = host;
  state.lanUrl = lanUrl;
  state.pairingUrl = lanUrl || `http://${isLoopbackHost(host) ? '127.0.0.1' : host}:${actualPort}`;

  // Machine-readable readiness line (parsed by the smoke test); human logs go
  // to stderr so stdout stays clean.
  console.log(
    JSON.stringify({
      event: 'ready',
      port: actualPort,
      url,
      provider: state.model.provider,
      workspace: state.workspaceDir,
      lanUrl,
      requireAuth: Boolean(state.requireAuth),
    }),
  );
  console.error(`[assistant] listening on ${url} (model: ${state.model.provider}/${state.model.model})`);
  console.error(`[assistant] workspace: ${state.workspaceDir}`);
  console.error(`[assistant] data:      ${P.dataDir}`);

  // Always print where a phone should connect to, and say plainly whether that
  // is actually reachable. The requirement is "print the LAN URL on boot".
  const candidates = listLanAddresses();
  const shownAddress = remote ? lanAddress : preferredLanAddress();
  if (remote) {
    console.error(
      `[assistant] WARNING: remote access enabled (ASSIST_ALLOW_REMOTE=1). ` +
        'Anyone on this network who pairs with the code can use this assistant.',
    );
    if (lanUrl) {
      console.error(`[assistant] LAN URL: ${lanUrl}`);
    } else {
      console.error(`[assistant] LAN URL: (bound to ${host}, but no non-internal IPv4 address was found)`);
    }
  } else {
    const wouldBe = shownAddress ? lanUrlFor(shownAddress, actualPort) : '(no LAN address found)';
    console.error(`[assistant] LAN URL: ${wouldBe} (not listening there - set ASSIST_ALLOW_REMOTE=1 and HOST=0.0.0.0)`);
  }
  if (candidates.length > 1) {
    const others = candidates.filter((entry) => entry.address !== shownAddress);
    if (others.length) {
      console.error(
        `[assistant] other interfaces: ${others.map((entry) => lanUrlFor(entry.address, actualPort)).join(', ')}`,
      );
    }
  }
  console.error(`[assistant] pairing code: ${state.security.code} (also shown in Settings)`);

  let closing = false;
  const shutdown = (signal) => {
    if (closing) return;
    closing = true;
    console.error(`[assistant] ${signal} received - shutting down`);
    try {
      state.routines.stop();
      state.runtime.cancelAll('server shutting down');
      state.approvals.shutdown('server shutting down');
    } catch (err) {
      console.error('[assistant] shutdown cleanup failed:', err.message);
    }
    server.close(() => {
      console.error('[assistant] closed');
      process.exit(0);
    });
    // SSE connections are long-lived by design: close them so server.close()
    // can actually finish instead of waiting for a browser tab to go away.
    if (typeof server.closeAllConnections === 'function') server.closeAllConnections();
    // If a socket refuses to close, leave anyway.
    const force = setTimeout(() => process.exit(0), 3000);
    if (typeof force.unref === 'function') force.unref();
  };

  process.on('SIGINT', () => shutdown('SIGINT'));
  process.on('SIGTERM', () => shutdown('SIGTERM'));
  process.on('unhandledRejection', (reason) => {
    console.error('[assistant] unhandled rejection:', reason);
  });

  return { server, state, port: actualPort, url };
}

const isMain = process.argv[1] && pathToFileURL(path.resolve(process.argv[1])).href === import.meta.url;

if (isMain) {
  startServer().catch((err) => {
    if (err.code === 'EADDRINUSE') {
      console.error(`[assistant] port ${DEFAULT_PORT} is already in use. Set PORT to a free port (PORT=0 picks one).`);
    } else if (err.code === 'REMOTE_NOT_ALLOWED') {
      console.error(`[assistant] ${err.message}`);
    } else {
      console.error('[assistant] failed to start:', err);
    }
    process.exit(1);
  });
}
