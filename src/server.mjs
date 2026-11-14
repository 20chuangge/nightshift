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
import https from 'node:https';
import net from 'node:net';
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import crypto from 'node:crypto';
import { spawn as spawnChild } from 'node:child_process';
import fsp from 'node:fs/promises';
import zlib from 'node:zlib';
import { pathToFileURL, fileURLToPath } from 'node:url';

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
  migrateBaseGrants,
  migrateBuiltinNames,
  migrateAppName,
  migrateDefaultAvatars,
  writeAssistantConfig,
} from './bots.mjs';
import { computerSnapshot, captureScreen } from './computer.mjs';
import { createRegistry } from './tools.mjs';
import { ApprovalQueue, effectivePolicy, APPROVAL_LEVELS, phraseToPattern, invalidDenyPatterns } from './approvals.mjs';
import { readUsageRecords, recentRecords, summarizeUsage, readUsageSettings, saveUsageSettings, readUsageAlert, localDay } from './usage.mjs';
import { normalizeRule } from './rules.mjs';
import { RoutineStore } from './routines.mjs';
import { AgentRuntime, recoverInterruptedTurns } from './agent.mjs';
import * as memory from './memory.mjs';
import * as skills from './skills.mjs';
import * as groups from './groups.mjs';
import * as settingsModule from './settings.mjs';
import { publicProviderCatalogue } from './providers.mjs';
import * as providersModule from './providers.mjs';
import { configure as configureDesktops, desktopInfo, desktopSupport, ensureDesktop, listDesktops, stopDesktop, setDesktopHooks, setDesktopMode, getDesktopMode, desktopViewerOpened, ensureViewer, DESKTOP_IDLE_MS, fullDesktopInstalled, desktopEnv } from './desktops.mjs';
import { loadPlan } from './plans.mjs';
import { setClipboard, getClipboard, CLIPBOARD_MAX_CHARS, sudoInstall } from './clipboard.mjs';
import { createMcpManager } from './mcp.mjs';
import { createProvisioner } from './remote.mjs';
import { bridgeWebSocket } from './wsbridge.mjs';
import { enableFunnel, disableFunnel, funnelView, funnelPublicUrl, restoreFunnel } from './funnel.mjs';
import * as voiceModule from './voice.mjs';
import * as visionModule from './vision.mjs';
import * as mediaModule from './media.mjs';
import { createVideoJobs } from './videojobs.mjs';
import { createFeishu, loadFeishu } from './feishu.mjs';
import { createPeers } from './peers.mjs';
import { createPages, PAGE_HEADERS } from './pages.mjs';
import { collectBriefing, briefingInstruction } from './briefing.mjs';
import { resolveRemoteMember, isRemoteMember, askPeerBot } from './crossmachine.mjs';
import { listVault, putVault, deleteVault } from './vault.mjs';
import { createAttention } from './attention.mjs';
import * as modelsModule from './models.mjs';
import { applyUpdate, compareVersions, installedSetupVersion, shippedSetupVersion, UPDATE_MAX_BYTES } from './selfupdate.mjs';
import { packApp, cleanupPack } from './bundle.mjs';
import {
  evaluateAuth,
  isSameOriginRequest,
  isAuthExemptPath,
  isPublicShellPath,
  isLoopbackHost,
  isSecureRequest,
  isLoopbackAddress,
  clientIp,
  safeEqual,
  sessionCookieHeader,
  createRateLimiter,
  createPairLinkStore,
  loadOrCreateSecurity,
  listLanAddresses,
  preferredLanAddress,
  lanUrlFor,
  tailnetAddress,
  pairingCodeExpired,
  renewPairingCode,
} from './auth.mjs';
import { loadDeviceStore, describeAgent, deviceKind, mayPushUpdate } from './devices.mjs';
import { realPathOf } from './realpath.mjs';

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

/** ASSIST_REQUIRE_HTTPS=1 refuses plain HTTP from anything but loopback. */
const REQUIRE_HTTPS = /^(1|true|yes)$/i.test(String(process.env.ASSIST_REQUIRE_HTTPS || ''));

/**
 * Origins a native app is allowed to call this hub from. A Capacitor WebView
 * serves the app from https://localhost (Android) or capacitor://localhost
 * (iOS), which is a different origin from the hub, so the app needs CORS. Only
 * these fixed origins are allowed, and only with `Authorization: Bearer` - no
 * cookies, so `Access-Control-Allow-Credentials` is never sent.
 */
const APP_ORIGINS = new Set(
  String(process.env.ASSIST_APP_ORIGINS || 'https://localhost,http://localhost,capacitor://localhost')
    .split(',')
    .map((s) => s.trim().toLowerCase())
    .filter(Boolean),
);

/**
 * A certificate the owner put there. Two ways: the env pair (ASSIST_TLS_CERT /
 * ASSIST_TLS_KEY, full paths) or data/tls/cert.pem + data/tls/key.pem. Nothing
 * is generated: a self-signed cert that the browser has never met is worse than
 * saying "put Caddy in front", and docs/HTTPS.md explains both.
 */
function loadTls() {
  const fromEnvCert = process.env.ASSIST_TLS_CERT;
  const fromEnvKey = process.env.ASSIST_TLS_KEY;
  const dir = path.join(P.dataDir, 'tls');
  const certPath = fromEnvCert ? path.resolve(fromEnvCert) : path.join(dir, 'cert.pem');
  const keyPath = fromEnvKey ? path.resolve(fromEnvKey) : path.join(dir, 'key.pem');
  try {
    if (!fs.existsSync(certPath) || !fs.existsSync(keyPath)) return null;
    return { cert: fs.readFileSync(certPath), key: fs.readFileSync(keyPath) };
  } catch (err) {
    console.error(`[assistant] TLS files could not be read (${err.message}); staying on http`);
    return null;
  }
}

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
  if (await migrateAppName().catch(() => false)) console.log('[assistant] app name updated to Lamplit');
  const grayed = await migrateDefaultAvatars().catch(() => 0);
  if (grayed) console.log(`[assistant] ${grayed} bot(s) moved from an old default colour to gray`);
  await migrateBaseGrants().catch((err) => console.error('[bots] base grants:', err.message));
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
  // A danger rule that does not compile never matches: say so instead of
  // silently skipping it (SEC-07).
  const brokenRules = invalidDenyPatterns(effectivePolicy(config.policy || {}).denyPatterns);
  for (const bad of brokenRules) console.error(`[assistant] danger rule does not compile, it never matches: ${bad.pattern} (${bad.error})`);
  if (brokenRules.length) void audit({ kind: 'policy.invalid-deny', patterns: brokenRules.map((b) => b.pattern) }).catch(() => {});
  // Phones that paired with this hub, and the single-use links a QR code carries.
  const devices = await loadDeviceStore();
  const pairLinks = createPairLinkStore();

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
  // Light or full desktops for the bots (Linux), and stopping the idle ones:
  // a desktop counts as in use while its bot's browser works.
  setDesktopMode(readJsonSync(path.join(P.dataDir, 'desktop.json'), {})?.mode || process.env.DESK_DESKTOP_MODE || 'light');
  // Full desktop picked (in 添加机器, or before XFCE was there): install it now, in the background.
  if (getDesktopMode() === 'full') setTimeout(() => startFullDesktopInstall(state, { quiet: true }), 20000).unref?.();
  {
    const { browserManagers } = await import('./browser.mjs');
    const managerOf = (botId) => browserManagers().find((m) => m.key === botId);
    setDesktopHooks({
      busy: (botId) => {
        const m = managerOf(botId);
        return Boolean(m?.session && (m.inFlight > 0 || Date.now() - (m.lastActivity || 0) < DESKTOP_IDLE_MS));
      },
      beforeStop: async (botId) => {
        const m = managerOf(botId);
        if (m?.session) await m.close().catch(() => {});
      },
    });
  }

  // Reports and dashboards bots make as web pages (the page library).
  refs.pages = createPages({ workspaceDir });

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
    getPeers: () => refs.peers || null,
    getPages: () => refs.pages || null,
    getBriefing: () => refs.collectBriefing || null,
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
      const NO_CHANGE = /^[「"]?(没有变化|无变化|NO_CHANGE)[」"]?[。.!！]?$/i;
      const changeNote = (strict) => (routine.onlyChanges
        ? `（只在有变化时提醒我。${strict ? '你上一轮没有真的去查就说了没有变化。' : ''}先用工具把这件事重新查一遍，不要凭聊天记录判断；再和上次的结果比较。上次的结果：「${routine.lastReport ? routine.lastReport.slice(0, 1500) : '（第一次运行，没有上次）'}」。如果和上次相比没有值得告诉我的新变化，只回复「没有变化」四个字，别的都不要写。）`
        : '');
      // One run; collects what the bot says (to tell "nothing new" apart and to
      // send it on) and whether it used any tool (a "no change" it did not check is no answer).
      const once = async (strict) => {
        const turnId = uid('turn');
        const texts = [];
        let tools = 0;
        const off = bus.subscribe((ev) => {
          if (ev.turnId !== turnId) return;
          if (ev.type === 'message' && ev.final && ev.text && !ev.system) texts.push(String(ev.text));
          if (ev.type === 'tool.call' && ev.name !== 'task_finish') tools += 1;
        });
        try {
          const result = await refs.runtime.runTurn({
            botId: routine.botId,
            text: routine.instruction,
            hiddenNote: changeNote(strict),
            source: 'routine',
            unattended: true,
            turnId,
          });
          return { result, tools, report: texts.join('\n\n').trim() || String(result?.summary || '').trim() };
        } finally { off(); }
      };
      let { result, tools, report } = await once(false);
      if (routine.onlyChanges && NO_CHANGE.test(report) && tools === 0) ({ result, tools, report } = await once(true));
      const quiet = routine.onlyChanges && result?.status === 'success' && NO_CHANGE.test(report) && tools > 0;
      if (quiet) {
        attention.quiet(`bot:${routine.botId}`);
      } else if (routine.pushFeishu && report && refs.feishu) {
        await refs.feishu.push(`【${routine.name}】\n${report}`).catch((err) => console.error('[routines] feishu push failed:', err.message));
      }
      return { ...result, quiet, report };
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
    getPeers: () => refs.peers || null,
  });
  refs.runtime = runtime;
  // Tasks a bot was working through before the app stopped go on by themselves.
  runtime.resumeTasks().then((n) => { if (n) console.log(`[tasks] picking up ${n} open task(s) in a moment`); }).catch((err) => console.error('[tasks] resume:', err.message));
  // Which coding assistants on the human's subscription are ready here: bots
  // offer big programming work to them. Checked shortly after start, then hourly.
  if (process.env.DESK_CLI_WATCH !== '0') {
    const checkCli = () => refreshCliAgents(runtime).catch(() => {});
    setTimeout(checkCli, 20000).unref?.();
    setInterval(checkCli, 60 * 60 * 1000).unref?.();
  }

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
    devices,
    pairLinks,
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
  // A video a teammate made for a task handed down from the bot the human is
  // talking to: that bot hears about it too, so the human is not left waiting.
  const tellUpstream = async (job, what) => {
    if (!job.reportTo || job.reportTo === job.botId) return;
    const maker = await getBot(job.botId).catch(() => null);
    const up = await getBot(job.reportTo).catch(() => null);
    if (!up) return;
    await tellBot({ botId: up.id }, `[后台任务] 你交给团队的视频（由「${maker?.name || job.botId}」提交，内容：${job.prompt}）${what}`);
  };
  refs.videoJobs = createVideoJobs({
    file: path.join(P.dataDir, 'video-jobs.json'),
    getKey: () => refs.getMedia('video')?.apiKey || '',
    workspaceDir,
    onDone: async (job) => {
      await tellBot(job, `[后台任务] 你之前提交的视频生成好了：${job.path}（内容：${job.prompt}）。告诉用户，并在回复里写出这个路径，视频会直接在聊天里播放。`);
      await tellUpstream(job, `生成好了：${job.path}。告诉用户，并在回复里写出这个路径，视频会直接在聊天里播放。`);
    },
    onFail: async (job) => {
      await tellBot(job, `[后台任务] 你之前提交的视频没有生成成功：${job.error}（内容：${job.prompt}）。告诉用户原因，问要不要重试。`);
      await tellUpstream(job, `没有生成成功：${job.error}。告诉用户原因，问要不要重试。`);
    },
  });
  await refs.videoJobs.load();
  state.videoJobs = refs.videoJobs;

  // Connected apps (MCP): their tools join the registry while connected.
  state.mcp = createMcpManager({ registry, workspaceDir, version: VERSION, readFeishu: () => loadFeishu(path.join(P.dataDir, 'feishu.json')), publicUrl: () => funnelPublicUrl(), emit: () => bus.emit({ type: 'settings.changed', section: 'mcp' }) });
  registry.mcpGate = (bot, name) => state.mcp.allowed(bot, name);
  registry.mcpTrust = (name) => state.mcp.trustFor(name);
  await state.mcp.load().catch((err) => console.error('[assistant] mcp.json:', err.message));
  // In the background: an npx server may take a while to download.
  state.mcp.startAll().catch(() => {});

  // Feishu: the assistant in the phone's chat app, over a connection this
  // machine opens (no public address needed). Off until set up in Settings.
  const feishuBase = {
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
    // "@name" in Feishu also reaches bots on the human's other machines.
    resolveRemote: (ref) => resolveRemoteMember(refs.peers, ref),
    listRemote: () => (refs.peers ? refs.peers.rosters() : []),
    askRemote: ({ machine, botId, text }) => askPeerBot(refs.peers, refs.peers.find(machine), {
      botId,
      text: `${text}\n\n（这条消息是用户在手机飞书里发的，由另一台机器转给你；你的回答会发回飞书。做出的图片、视频写出路径，会一起发过去。）`,
      handoff: { depth: 1, chain: ['feishu', botId], budgetLeft: 6, from: { bot: '飞书里的用户' } },
      workspaceDir,
    }),
    workspaceDir,
    machineName: () => selfMachineName(),
    // Voice messages in and out, through this machine's voice service.
    transcribe: (bytes, mime) => voiceModule.transcribe(voiceModule.resolveVoice(state.voice, state.settings, state.apiKey), bytes, mime),
    speak: async (text, botId) => {
      const tts = voiceModule.ttsFor(voiceModule.resolveVoice(state.voice, state.settings, state.apiKey), { ttsVoice: await voiceForBot(state, botId) });
      const bytes = await voiceModule.speak(tts, voiceModule.speakableText(text, 500), { format: 'opus' });
      return { bytes, durationMs: voiceModule.oggDurationMs(bytes) };
    },
  };
  state.feishu = createFeishu({ ...feishuBase, file: path.join(P.dataDir, 'feishu.json') });
  listBots().then((b) => { state.botsCache = b; }).catch(() => {});
  bus.subscribe((ev) => { if (ev.type === 'roster.changed') listBots().then((b) => { state.botsCache = b; }).catch(() => {}); });
  await state.feishu.load();
  refs.feishu = state.feishu;

  // Feishu apps of their own, one per bot (Notion §97.6 I2). data/feishu-apps.json
  // lists them; each keeps its credentials, pairing and people in
  // data/feishu-app-<id>.json, because Feishu gives a person a different id in
  // every app - each app pairs on its own.
  state.feishuApps = new Map();
  state.feishuAppsFile = path.join(P.dataDir, 'feishu-apps.json');
  state.feishuAppFile = (id) => path.join(P.dataDir, `feishu-app-${id}.json`);
  state.resolveFeishuBot = async (ref) => {
    const want = String(ref || '').trim();
    if (!want) return null;
    if (want.includes('@')) {
      const far = await resolveRemoteMember(refs.peers, want).catch(() => null);
      return far ? { botId: far.info.botId, machine: far.info.machine, name: far.info.name } : null;
    }
    const bot = (await listBots()).find((b) => b.id === want);
    return bot ? { botId: bot.id, machine: '', name: bot.name } : null;
  };
  state.startFeishuApp = async (meta) => {
    const inst = createFeishu({ ...feishuBase, file: state.feishuAppFile(meta.id), pinned: { botId: meta.botId, machine: meta.machine || '', name: meta.name } });
    await inst.load();
    state.feishuApps.set(meta.id, { meta, inst });
    return inst;
  };
  state.saveFeishuApps = () => writeJsonSyncAtomic(state.feishuAppsFile, [...state.feishuApps.values()].map((a) => a.meta));
  for (const meta of readJsonSync(state.feishuAppsFile, []) || []) {
    if (meta?.id && meta.botId) await state.startFeishuApp(meta).catch((err) => console.error('[feishu] app', meta.id, err.message));
  }

  // The daily briefing's facts about this machine (other machines answer for themselves).
  refs.collectBriefing = (hours = 24) => collectBriefing({
    hours,
    machine: state.uiState?.machine?.name || os.hostname(),
    listBots,
    readSession: (botId) => readJsonl(sessionFile(botId)),
    approvals,
    attention,
    pages: refs.pages,
    videoJobs: refs.videoJobs,
    routines: state.routines,
  });
  state.collectBriefing = refs.collectBriefing;

  // The human's other machines, as the desktop client hands them over: bots
  // here can hand work to bots there and move files, machine to machine.
  refs.peers = createPeers({ file: path.join(P.dataDir, 'peers.json') });
  await refs.peers.load();
  state.peers = refs.peers;
  state.pages = refs.pages;

  // Badges of bots and groups deleted by an older version (which kept them).
  try {
    const [liveBots, liveGroups] = await Promise.all([listBots(), groups.listGroups()]);
    attention.prune([...liveBots.map((b) => `bot:${b.id}`), ...liveGroups.map((g) => `group:${g.id}`)]);
  } catch { /* never block startup on this */ }

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
      section: 'model',
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

  // TLS: a cert/key pair is optional and never generated behind the owner's
  // back. With it the hub speaks https itself (ASSIST_TLS_CERT / ASSIST_TLS_KEY,
  // or data/tls/cert.pem + key.pem); without it, run a reverse proxy or use a
  // tunnel - see docs/HTTPS.md.
  const tls = loadTls();
  const server = tls
    ? https.createServer(tls, hubRequestHandler(state, false))
    : http.createServer(hubRequestHandler(state, false));
  if (tls) console.error('[assistant] TLS is on (HSTS + Secure cookies)');
  attachHubUpgrade(server, state, false);

  return {
    server,
    state,
    port,
    host,
    // A separate socket for the tunnel: same routes, but it never counts as
    // "the local human" no matter that it is bound to 127.0.0.1.
    makePublicServer: () => {
      const publicServer = http.createServer(hubRequestHandler(state, true));
      attachHubUpgrade(publicServer, state, true);
      return publicServer;
    },
  };
}

/** One request handler for both sockets; the public one carries a flag. */
function hubRequestHandler(state, viaPublic) {
  return (req, res) => {
    if (viaPublic) req.viaPublic = true;
    handleRequest(req, res, state).catch((err) => {
      // Last-resort guard: no route may ever produce an unhandled rejection.
      console.error('[assistant] unhandled request error:', err);
      if (!res.headersSent) errorResponse(res, 500, 'INTERNAL', 'unexpected server error');
      else res.end();
    });
  };
}

/** Bot desktop websocket relay, shared by the normal and the public socket. */
function attachHubUpgrade(server, state, viaPublic) {
  server.on('upgrade', (req, socket, head) => {
    if (viaPublic) req.viaPublic = true;
    const refuse = (status, text) => {
      try { socket.end(`HTTP/1.1 ${status} ${text}\r\nConnection: close\r\nContent-Length: 0\r\n\r\n`); } catch { /* gone */ }
    };
    socket.on('error', () => socket.destroy());
    let pathname = '';
    try { pathname = new URL(req.url || '/', 'http://hub').pathname; } catch { return refuse(400, 'Bad Request'); }
    const match = /^\/api\/bots\/([^/]+)\/desktop\/ws$/.exec(pathname);
    if (!match) return refuse(404, 'Not Found');
    if (!evaluateAuth(req, state.security, state.devices).authorized) return refuse(401, 'Unauthorized');
    // WebSockets ignore the browser's cross-site rules, so a viewer must prove
    // it is the hub's own page (its Origin) or carry a token (SEC-03).
    const hasOrigin = Boolean(String(req.headers.origin || '').trim());
    const hasBearer = /^bearer\s+\S/i.test(String(req.headers.authorization || ''));
    if (!hasBearer && !(hasOrigin && isSameOriginRequest(req))) return refuse(401, 'Unauthorized');
    const info = desktopInfo(safeDecode(match[1]));
    if (!info.running) return refuse(404, 'Not Found');
    // Windows: no websockify; the hub speaks WebSocket to the VNC server itself.
    if (!info.webPort && info.vncPort) {
      if (!bridgeWebSocket(req, socket, head, { port: info.vncPort })) refuse(400, 'Bad Request');
      return;
    }
    if (!info.webPort) return refuse(404, 'Not Found');
    // Someone watching keeps the desktop from being stopped as idle.
    const viewerDone = desktopViewerOpened(safeDecode(match[1]));
    socket.on('close', viewerDone);
    // The VNC part runs only while someone watches: start it now if needed.
    void ensureViewer(safeDecode(match[1])).catch(() => false).then((ok) => {
    if (!ok || socket.destroyed) { refuse(503, 'Service Unavailable'); return; }
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
  });
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

  if (req.viaPublic) {
    // The tunnel terminates TLS; tell the browser never to go back to http.
    res.setHeader('strict-transport-security', 'max-age=31536000; includeSubDomains');
  }
  // Every answer (SEC-13): no guessing a file's type, no addresses leaking to other sites.
  res.setHeader('x-content-type-options', 'nosniff');
  res.setHeader('referrer-policy', 'no-referrer');

  // The native app lives on its own origin (https://localhost in a Capacitor
  // WebView). It authenticates with a Bearer token, never a cookie, so the
  // cross-origin rules are simple: echo an allowed origin, allow the header.
  const origin = String(req.headers.origin || '').toLowerCase();
  const appOrigin = origin && APP_ORIGINS.has(origin) ? origin : '';
  if (appOrigin) {
    res.setHeader('access-control-allow-origin', appOrigin);
    res.setHeader('vary', 'origin');
    res.setHeader('access-control-allow-headers', 'authorization, content-type, x-file-name');
    res.setHeader('access-control-allow-methods', 'GET, POST, PUT, PATCH, DELETE, OPTIONS');
    res.setHeader('access-control-max-age', '600');
    if (method === 'OPTIONS') {
      res.writeHead(204);
      return res.end();
    }
  }

  // ASSIST_REQUIRE_HTTPS=1: from anywhere but this computer, plain HTTP is
  // refused. The shell still has to be reachable so the message can be read.
  if (REQUIRE_HTTPS && !isSecureRequest(req) && !isLoopbackAddress(clientIp(req)) && !isPublicShellPath(pathname)) {
    return errorResponse(
      res,
      426,
      'HTTPS_REQUIRED',
      'this server only accepts https; open it through your https address (or turn ASSIST_REQUIRE_HTTPS off)',
    );
  }

  if (pathname === '/api' || pathname.startsWith('/api/')) {
    // Loopback is the local user. Everything else has to pair first - except the
    // two endpoints that exist precisely so an unauthenticated client can find
    // out it needs to pair and then do it.
    if (!isAuthExemptPath(method, pathname)) {
      const auth = evaluateAuth(req, state.security, state.devices);
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
  const auth = evaluateAuth(req, state.security, state.devices);
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
      // A page can send text/plain to any address without asking first; JSON
      // makes the browser ask (a CORS preflight), and we never say yes to
      // another site. Every client of ours already sends application/json.
      const type = String(req.headers['content-type'] || '').split(';')[0].trim().toLowerCase();
      const hasBody = Number(req.headers['content-length'] || 0) > 0 || Boolean(req.headers['transfer-encoding']);
      if (hasBody && type !== 'application/json') {
        req.resume();
        return errorResponse(res, 415, 'JSON_REQUIRED', 'send the body as application/json');
      }
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

// CPU use sampled every 15 s (os.loadavg is 0 on Windows); "busy" after a minute near 100%.
const loadSamples = [];
let lastCpu = null;
function sampleCpu() {
  const t = os.cpus().reduce((a, c) => { for (const [k, v] of Object.entries(c.times)) a[k] = (a[k] || 0) + v; return a; }, {});
  const total = Object.values(t).reduce((a, b) => a + b, 0);
  if (lastCpu) {
    const dt = total - lastCpu.total;
    const busy = dt - (t.idle - lastCpu.idle);
    if (dt > 0) loadSamples.push(Math.round((busy / dt) * 100));
    while (loadSamples.length > 4) loadSamples.shift();
  }
  lastCpu = { total, idle: t.idle };
}
sampleCpu();
setInterval(sampleCpu, 15000).unref();
function machineLoad() {
  const cpu = loadSamples.length ? loadSamples[loadSamples.length - 1] : null;
  const memFreeMB = Math.round(os.freemem() / 1048576);
  const memTotalMB = Math.round(os.totalmem() / 1048576);
  const cpuBusy = loadSamples.length >= 4 && loadSamples.every((x) => x >= 90);
  const memBusy = memFreeMB < Math.max(300, memTotalMB * 0.05);
  return { cpu, cores: os.cpus().length, memFreeMB, memTotalMB, busy: cpuBusy || memBusy, why: cpuBusy ? 'cpu' : memBusy ? 'memory' : null };
}

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
    // Reachable from the owner's other devices anywhere (Tailscale), when on a tailnet.
    tailnetUrl: tailnetUrl(state),
    // What this machine is called in the owner's lists.
    name: selfMachineName(),
    recoveredTurns: state.recoveredTurns.length,
    // How busy the machine is (a one-core VM with Windows Update running made everything crawl).
    load: machineLoad(),
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

/** http://100.x.y.z:port when this hub listens beyond loopback and the machine is on Tailscale. */
function tailnetUrl(state) {
  if (!state.lanUrl) return null; // loopback only: not reachable from other devices anyway
  const ip = tailnetAddress();
  return ip ? `http://${ip}:${state.port}` : null;
}

function pairingInfo(state) {
  const port = state.port;
  const url =
    state.pairingUrl ||
    state.lanUrl ||
    `http://${isLoopbackHost(state.host) ? '127.0.0.1' : state.host}:${port}`;
  // Addresses a phone could use. Empty when the hub only listens on loopback:
  // the UI then says "turn on 允许手机连接" instead of showing a dead link.
  const urls = [];
  const publicUrl = funnelPublicUrl();
  if (publicUrl) urls.push({ kind: 'public', url: publicUrl });
  if (state.lanUrl) {
    const lanAddress = preferredLanAddress();
    const tailnetIp = tailnetAddress();
    if (lanAddress) urls.push({ kind: 'lan', url: lanUrlFor(lanAddress, port) });
    if (tailnetIp) urls.push({ kind: 'tailnet', url: lanUrlFor(tailnetIp, port) });
  }
  // A code older than a day is replaced before anyone sees it (SEC-15).
  if (pairingCodeExpired(state.security)) void renewPairingCode(state.security);
  return { url, code: state.security.code, urls, remote: Boolean(state.lanUrl || publicUrl) };
}

route('GET', /^\/api\/settings$/, async (_req, _res, { state }) => ({
  app: { name: state.config.name, version: VERSION },
  timezone: state.settings.timezone || '',
  model: settingsModule.publicModel(state.settings, state.apiKey),
  server: {
    host: state.host,
    port: state.port,
    lanUrl: state.lanUrl,
    tailnetUrl: tailnetUrl(state),
    requireAuth: Boolean(state.requireAuth),
  },
  pairing: pairingInfo(state),
}));

// Static catalogue of every model provider Desk can talk to. No secrets, so it
// is safe for any paired device; the UI uses it to fill the settings form.
route('GET', /^\/api\/providers$/, async () => ({ providers: publicProviderCatalogue() }));

// Per-bot desktops. `support` explains why it is off (non-Linux hub, missing
// Xvfb) so the UI can say something more useful than "failed".
route('GET', /^\/api\/desktops$/, async () => ({ support: desktopSupport(), desktops: listDesktops(), mode: getDesktopMode(), idleMinutes: Math.round(DESKTOP_IDLE_MS / 60000), fullInstalled: fullDesktopInstalled(), install: { ...fullInstall } }));

// XFCE for the full desktop, installed by the Hub itself (sudo -n, as other hub
// tasks): one click in Settings, or right after setup when 添加机器 chose it.
//   POST /api/desktops/install-full -> {fullInstalled, install:{state, detail}}
const fullInstall = { state: 'idle', detail: '', startedAt: 0 };
/** Can this machine have the XFCE desktop at all? (X11 screens; Rocky/RHEL 10 has none.) */
function fullDesktopPossible() {
  const s = desktopSupport();
  return process.platform === 'linux' && Boolean(s?.available) && !s?.shared && s?.backend !== 'wayland';
}
function startFullDesktopInstall(state, { quiet = false } = {}) {
  if (!fullDesktopPossible() || fullDesktopInstalled() || fullInstall.state === 'running') return;
  Object.assign(fullInstall, { state: 'running', detail: '正在下载安装 XFCE（几百 MB，通常 3–10 分钟）', startedAt: Date.now() });
  state.bus.emit({ type: 'settings.changed', section: 'machines' });
  sudoInstall('xfce4 xfce4-terminal dbus-x11', { timeoutMs: 30 * 60000, dnf: 'groupinstall -y -q Xfce' }).then((ok) => {
    const done = fullDesktopInstalled();
    Object.assign(fullInstall, done
      ? { state: 'done', detail: '' }
      : { state: 'failed', detail: ok ? '装完了但没找到 xfce4-session' : '没装上：要么这台机器的 sudo 需要密码，要么下载失败。可以再点一次，或者让机器人帮你装。' });
    if (!quiet || !done) audit({ kind: 'desktop.install-full', ok: done }).catch(() => {});
    state.bus.emit({ type: 'settings.changed', section: 'machines' });
  });
}
route('POST', /^\/api\/desktops\/install-full$/, async (_req, _res, { state }) => {
  if (!fullDesktopPossible()) throw httpError(400, 'NO_FULL_DESKTOP', '这台机器没有可装的完整桌面（只有 X11 屏幕的 Linux 才有 XFCE）');
  await audit({ kind: 'desktop.install-full', started: true });
  startFullDesktopInstall(state);
  return { fullInstalled: fullDesktopInstalled(), install: { ...fullInstall } };
});

// Light (openbox only) or full (XFCE) desktops for the bots; new desktops use it.
route('PUT', /^\/api\/desktops\/mode$/, async (_req, _res, { body, state }) => {
  const mode = setDesktopMode(body?.mode);
  writeJsonSyncAtomic(path.join(P.dataDir, 'desktop.json'), { mode });
  await audit({ kind: 'desktop.mode', mode });
  state.bus.emit({ type: 'settings.changed', section: 'machines' });
  return { mode, fullInstalled: fullDesktopInstalled() };
});

// Which screen a Windows machine with several monitors shows (one at a time,
// the primary one by default; or all side by side). Kept in data/screen.json
// and applied again whenever TightVNC comes (back) up.
//   GET /api/desktop/screens -> {supported, screens:[{n,label,primary}], choice}
//   PUT /api/desktop/screen {screen:'primary'|'all'|n} -> {ok, choice}
const SCREEN_FILE = path.join(P.dataDir, 'screen.json');
const screenChoice = () => {
  const c = readJsonSync(SCREEN_FILE, null)?.screen;
  return c === 'all' || (Number.isInteger(c) && c >= 1 && c <= 16) ? c : 'primary';
};
route('GET', /^\/api\/desktop\/screens$/, async () => {
  if (process.platform !== 'win32' || !desktopSupport().available) return { supported: false, screens: [], choice: screenChoice() };
  const { listScreens } = await import('./localvnc.mjs');
  return { supported: true, screens: await listScreens(), choice: screenChoice() };
});
route('PUT', /^\/api\/desktop\/screen$/, async (_req, _res, { body }) => {
  const raw = body?.screen;
  const choice = raw === 'all' || raw === 'primary' ? raw : Number(raw);
  if (choice !== 'all' && choice !== 'primary' && !(Number.isInteger(choice) && choice >= 1 && choice <= 16)) throw httpError(400, 'BAD_SCREEN', 'screen must be "primary", "all" or a screen number');
  if (process.platform !== 'win32') throw httpError(409, 'SCREENS_UNSUPPORTED', '只有 Windows 电脑能选屏幕（Linux 上每个机器人的桌面本来就只有一块屏）');
  const { shareScreen } = await import('./localvnc.mjs');
  const r = await shareScreen(choice);
  if (!r.ok) throw httpError(502, 'SCREEN_FAILED', r.error);
  writeJsonSyncAtomic(SCREEN_FILE, { screen: choice, updatedAt: nowIso() });
  return { ok: true, choice };
});
if (process.platform === 'win32' && process.env.DESK_SCREEN_WATCH !== '0') {
  let vncWasUp = false;
  const watchScreen = async () => {
    const up = desktopSupport().available;
    if (up && !vncWasUp) {
      const { shareScreen } = await import('./localvnc.mjs');
      await shareScreen(screenChoice()).catch(() => {});
    }
    vncWasUp = up;
  };
  setTimeout(() => watchScreen().catch(() => {}), 5000).unref?.();
  setInterval(() => watchScreen().catch(() => {}), 15000).unref?.();
}

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

// The screen's own clipboard, for text the VNC channel cannot carry (it is
// Latin-1, so Chinese turns into "?"). The person viewing asks for it; the
// answer says why not when this screen has no usable clipboard tool.
function screenClipEnv(botId) {
  return process.platform === 'win32' ? {} : desktopEnv(botId);
}
route('POST', /^\/api\/bots\/(?<botId>[^/]+)\/desktop\/clipboard$/, async (_req, _res, { params, body }) => {
  const text = body?.text;
  if (typeof text !== 'string') throw httpError(400, 'BAD_TEXT', 'body needs {text}');
  if (text.length > CLIPBOARD_MAX_CHARS) throw httpError(413, 'TEXT_TOO_LONG', `at most ${CLIPBOARD_MAX_CHARS} characters`);
  return setClipboard(screenClipEnv(params.botId), text);
});
route('GET', /^\/api\/bots\/(?<botId>[^/]+)\/desktop\/clipboard$/, async (_req, _res, { params }) => getClipboard(screenClipEnv(params.botId)));
// When the screen's clipboard cannot take it (a Wayland screen without a
// keyboard seat, a Windows hub in a service session): type it into the bot's
// browser, where the person's cursor is.
route('POST', /^\/api\/bots\/(?<botId>[^/]+)\/desktop\/type$/, async (_req, _res, { params, body }) => {
  const text = body?.text;
  if (typeof text !== 'string' || !text) throw httpError(400, 'BAD_TEXT', 'body needs {text}');
  if (text.length > 5000) throw httpError(413, 'TEXT_TOO_LONG', 'at most 5000 characters');
  const { getBrowserManager } = await import('./browser.mjs');
  return getBrowserManager(params.botId).insertAtFocus(text);
});

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
//   POST /api/voice/speak        {text, format?:'mp3'|'opus', botId?, voice?} -> the reply read aloud (audio bytes)
//                                botId: in that bot's voice; voice: this voice (试听 before saving)

// --- pages (the page library) --------------------------------------------------
//   GET    /api/pages              -> {pages:[{name, title, path, size, updatedAt, botName}]}
//   GET    /api/pages/:name        -> the page, sandboxed (?download=1 to save it)
//   DELETE /api/pages/:name

route('GET', /^\/api\/pages$/, async (_req, _res, { state }) => ({ pages: await state.pages.list() }));

route('GET', /^\/api\/pages\/(?<name>[a-z0-9-]{1,60})$/, async (_req, res, { params, state, query }) => {
  const html = await state.pages.read(params.name);
  if (html == null) return errorResponse(res, 404, 'PAGE_NOT_FOUND', 'no such page');
  const body = Buffer.from(html, 'utf8');
  res.writeHead(200, {
    ...PAGE_HEADERS,
    'content-length': body.length,
    ...(query.get('download') ? { 'content-disposition': `attachment; filename="${params.name}.html"` } : {}),
  });
  res.end(body);
  return undefined;
});

route('DELETE', /^\/api\/pages\/(?<name>[a-z0-9-]{1,60})$/, async (_req, _res, { params, state }) => {
  if (!(await state.pages.remove(params.name))) throw httpError(404, 'PAGE_NOT_FOUND', 'no such page');
  return { ok: true, name: params.name, deleted: true };
});

// --- peers (the human's other machines) -----------------------------------------
//   GET /api/peers   -> {peers:[{name, url, tailnetUrl}]}   never the tokens
//   PUT /api/peers   {peers:[{name, url, tailnetUrl, token}]}   from the desktop client

route('GET', /^\/api\/peers$/, async (_req, _res, { state }) => ({ peers: state.peers.list() }));

//   GET /api/peers/bots -> {machines:[{machine, bots:[{id,name,role}]}]}   who works on the other machines
route('GET', /^\/api\/peers\/bots$/, async (_req, _res, { state }) => ({ machines: await state.peers.rosters().catch(() => []) }));

route('PUT', /^\/api\/peers$/, async (_req, _res, { body, state }) => {
  // The computer that shares the list also says what this machine is called
  // (the name given in "添加机器"), so every list shows that name.
  if (typeof body?.self?.name === 'string' && body.self.name.trim()) setSelfMachineName(body.self.name);
  const peers = await state.peers.set(body?.peers);
  state.bus.emit({ type: 'settings.changed', section: 'machines' });
  return { peers };
});

// --- files on the human's other machines -----------------------------------------
//   GET /api/peers/locate?path=pages/x.html     -> {machine}  (404 when no machine has it)
//   GET /api/peers/:machine/file?path=...       -> that file, fetched over the peer link
// A reply (a briefing) can name a page or picture that lives on another machine;
// the chat finds and shows it from there. Pages stay sandboxed.

const peerPath = (raw) => {
  const p = String(raw || '').replace(/^\.\//, '').replace(/^workspace\//, '');
  if (!p || p.startsWith('/') || /(^|\/)\.\.(\/|$)/.test(p) || /^[a-z]:/i.test(p) || p.length > 300) throw httpError(400, 'BAD_PATH', 'a workspace-relative path');
  return p;
};
const peerPagePath = (p) => /^pages\/([a-z0-9-]{1,60})\.html$/.exec(p)?.[1] || null;
const remoteFetch = (state, peer, p) => {
  const page = peerPagePath(p);
  return state.peers.call(peer, 'GET', page ? `/api/pages/${page}` : `/api/workspace/file?path=${encodeURIComponent(p)}`, { timeoutMs: 60000 });
};
const locateCache = new Map(); // path -> {machine, at}

route('GET', /^\/api\/peers\/locate$/, async (_req, _res, { state, query }) => {
  const p = peerPath(query.get('path'));
  const hit = locateCache.get(p);
  if (hit && Date.now() - hit.at < 5 * 60 * 1000) {
    if (!hit.machine) throw httpError(404, 'NOT_ON_ANY_MACHINE', 'no machine has this file');
    return { machine: hit.machine, ...(hit.title ? { title: hit.title } : {}) };
  }
  for (const peer of state.peers.list()) {
    try {
      const res = await remoteFetch(state, state.peers.find(peer.name), p);
      res.body?.cancel?.().catch?.(() => {});
      if (res.ok) {
        // A page: its title there, for the card and the viewer.
        let title = '';
        const page = peerPagePath(p);
        if (page) {
          try { title = ((await state.peers.json(state.peers.find(peer.name), 'GET', '/api/pages', { timeoutMs: 8000 })).pages || []).find((x) => x.name === page)?.title || ''; } catch { /* name only */ }
        }
        locateCache.set(p, { machine: peer.name, title, at: Date.now() });
        return { machine: peer.name, ...(title ? { title } : {}) };
      }
    } catch { /* away: try the next */ }
  }
  locateCache.set(p, { machine: null, at: Date.now() });
  throw httpError(404, 'NOT_ON_ANY_MACHINE', 'no machine has this file');
});

route('GET', /^\/api\/peers\/(?<machine>[^/]+)\/file$/, async (_req, res, { params, state, query }) => {
  const p = peerPath(query.get('path'));
  const peer = state.peers.find(decodeURIComponent(params.machine));
  if (!peer) throw httpError(404, 'PEER_NOT_FOUND', 'no such machine');
  let r;
  try { r = await remoteFetch(state, peer, p); } catch (err) { throw httpError(502, err.code || 'PEER_UNREACHABLE', err.message); }
  if (!r.ok) return errorResponse(res, 404, 'FILE_NOT_FOUND', `「${peer.name}」上没有这个文件`);
  const bytes = Buffer.from(await r.arrayBuffer());
  const headers = peerPagePath(p)
    ? { ...PAGE_HEADERS }
    : {
      // Images and videos inline, everything else a download; never anything
      // that could run here (HTML, SVG, XML, script), whatever that machine says.
      'content-type': /html|svg|xml|javascript/i.test(r.headers.get('content-type') || '') ? 'text/plain; charset=utf-8' : (r.headers.get('content-type') || 'application/octet-stream'),
      'x-content-type-options': 'nosniff',
      'content-disposition': /^(image\/(png|jpe?g|gif|webp)|video\/)/i.test(r.headers.get('content-type') || '') ? 'inline' : 'attachment',
      'cache-control': 'private, max-age=600',
    };
  res.writeHead(200, { ...headers, 'content-length': bytes.length });
  res.end(bytes);
  return undefined;
});

// --- Feishu --------------------------------------------------------------------
//   GET  /api/feishu          -> {enabled, appId, hasSecret, botId, pairCode, users, connected, error}
//   PUT  /api/feishu          {enabled?, appId?, appSecret?, botId?, newPairCode?, clearSecret?}
//   POST /api/feishu/unpair   {openId}

route('GET', /^\/api\/feishu$/, async (_req, _res, { state }) => state.feishu.view());

route('PUT', /^\/api\/feishu$/, async (_req, _res, { body, state }) => {
  const view = await state.feishu.update(body || {});
  await audit({ kind: 'feishu.changed', enabled: view.enabled, appId: view.appId });
  state.bus.emit({ type: 'settings.changed', section: 'feishu' });
  return view;
});

route('POST', /^\/api\/feishu\/unpair$/, async (_req, _res, { body, state }) => {
  const view = await state.feishu.unpair(String(body?.openId || ''));
  await audit({ kind: 'feishu.unpaired' });
  state.bus.emit({ type: 'settings.changed', section: 'feishu' });
  return view;
});

// --- Feishu apps of their own (one bot each) ------------------------------------
//   GET    /api/feishu/apps                -> {apps:[{id, botId, machine, name, ...the app's view}]}
//   POST   /api/feishu/apps                {bot:"botId" | "botId@machine", appId, appSecret}
//   PUT    /api/feishu/apps/:id            {enabled?, appId?, appSecret?, newPairCode?}
//   POST   /api/feishu/apps/:id/unpair     {openId}
//   DELETE /api/feishu/apps/:id

const feishuAppView = ({ meta, inst }) => ({ id: meta.id, botId: meta.botId, machine: meta.machine || '', name: meta.name, ...inst.view() });
const feishuAppOr404 = (state, id) => {
  const app = state.feishuApps?.get(id);
  if (!app) throw httpError(404, 'FEISHU_APP_NOT_FOUND', '没有这个飞书应用');
  return app;
};
const feishuAppsChanged = (state) => state.bus.emit({ type: 'settings.changed', section: 'feishu' });

route('GET', /^\/api\/feishu\/apps$/, async (_req, _res, { state }) => ({ apps: [...(state.feishuApps?.values() || [])].map(feishuAppView) }));

route('POST', /^\/api\/feishu\/apps$/, async (_req, _res, { body, state }) => {
  const target = await state.resolveFeishuBot(body?.bot);
  if (!target) throw httpError(400, 'FEISHU_APP_BAD_BOT', '找不到这个机器人');
  const appId = String(body?.appId || '').trim();
  const appSecret = String(body?.appSecret || '').trim();
  if (!appId || !appSecret) throw httpError(400, 'FEISHU_APP_NEEDS_KEYS', '要填 App ID 和 App Secret');
  if (appId === state.feishu.view().appId || [...state.feishuApps.values()].some((a) => a.inst.view().appId === appId)) {
    throw httpError(409, 'FEISHU_APP_IN_USE', '这个飞书应用已经在用了：一个飞书应用只能对应一个入口');
  }
  const meta = { id: uid('fa'), ...target };
  const inst = await state.startFeishuApp(meta);
  state.saveFeishuApps();
  await inst.update({ appId, appSecret, enabled: true });
  await audit({ kind: 'feishu.app.added', bot: target.botId, machine: target.machine || '', appId });
  feishuAppsChanged(state);
  return feishuAppView(state.feishuApps.get(meta.id));
});

route('PUT', /^\/api\/feishu\/apps\/(?<id>[\w-]+)$/, async (_req, _res, { body, state, params }) => {
  const app = feishuAppOr404(state, params.id);
  const patch = {};
  for (const k of ['enabled', 'appId', 'appSecret', 'newPairCode']) if (body?.[k] !== undefined) patch[k] = body[k];
  await app.inst.update(patch);
  await audit({ kind: 'feishu.app.changed', id: app.meta.id, enabled: app.inst.view().enabled });
  feishuAppsChanged(state);
  return feishuAppView(app);
});

route('POST', /^\/api\/feishu\/apps\/(?<id>[\w-]+)\/unpair$/, async (_req, _res, { body, state, params }) => {
  const app = feishuAppOr404(state, params.id);
  await app.inst.unpair(String(body?.openId || ''));
  await audit({ kind: 'feishu.unpaired', app: app.meta.id });
  feishuAppsChanged(state);
  return feishuAppView(app);
});

route('DELETE', /^\/api\/feishu\/apps\/(?<id>[\w-]+)$/, async (_req, _res, { state, params }) => {
  const app = feishuAppOr404(state, params.id);
  app.inst.dispose();
  state.feishuApps.delete(app.meta.id);
  state.saveFeishuApps();
  await fsp.rm(state.feishuAppFile(app.meta.id), { force: true });
  await audit({ kind: 'feishu.app.removed', id: app.meta.id, bot: app.meta.botId });
  feishuAppsChanged(state);
  return { ok: true, id: app.meta.id };
});

// --- what a provider offers ----------------------------------------------------
//   POST /api/providers/models   {provider, baseUrl?, apiKey?} -> {models:[...], live:true} | {models: preset, live:false, error}
// Read from the provider itself, so the list is never out of date. Without a
// typed key, the saved key is used when it belongs to that provider.

const providerModelCache = new Map(); // provider|baseUrl|keyTail -> {at, models}
route('POST', /^\/api\/providers\/models$/, async (_req, _res, { body, state }) => {
  const provider = String(body?.provider || '');
  const preset = providersModule.providerPreset(provider);
  if (!preset) throw httpError(400, 'BAD_PROVIDER', 'unknown provider');
  const baseUrl = String(body?.baseUrl || preset.baseUrl || '');
  const savedFits = state.settings?.provider === provider;
  const apiKey = String(body?.apiKey || '') || (savedFits ? state.apiKey : '') || '';
  const fallback = { models: preset.models || [], live: false };
  if (!apiKey && providersModule.providerNeedsKey(provider)) return { ...fallback, error: '填上密钥后能读到它现在提供的全部模型' };
  const key = `${provider}|${baseUrl}|${apiKey.slice(-6)}`;
  const hit = providerModelCache.get(key);
  if (hit && Date.now() - hit.at < 10 * 60 * 1000) return { models: hit.models, live: true };
  try {
    const { models } = await providersModule.fetchProviderModels({ provider, baseUrl, apiKey });
    if (!models.length) return { ...fallback, error: '服务商没有列出模型' };
    providerModelCache.set(key, { at: Date.now(), models });
    return { models, live: true };
  } catch (err) {
    return { ...fallback, error: err.message };
  }
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

route('POST', /^\/api\/models$/, async (_req, _res, { body, state }) => {
  const model = await modelsModule.saveProfile({ ...body, id: undefined });
  await audit({ kind: 'model.saved', id: model.id, provider: model.provider, model: model.model });
  state.bus.emit({ type: 'settings.changed', section: 'model' });
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

route('PUT', /^\/api\/models\/(?<id>[^/]+)$/, async (_req, _res, { params, body, state }) => {
  const model = await modelsModule.saveProfile({ ...body, id: params.id });
  await audit({ kind: 'model.saved', id: model.id, provider: model.provider, model: model.model });
  state.bus.emit({ type: 'settings.changed', section: 'model' });
  return { model };
});

route('DELETE', /^\/api\/models\/(?<id>[^/]+)$/, async (_req, _res, { params, state }) => {
  const result = await modelsModule.deleteProfile(params.id);
  await audit({ kind: 'model.deleted', id: params.id });
  state.bus.emit({ type: 'roster.changed' });
  state.bus.emit({ type: 'settings.changed', section: 'model' });
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

// Coding CLIs on the human's subscription (cli_agent_run): installed? logged in?
// Only each tool's own status command is asked; their login files are never read.
//   GET /api/cliagents -> {agents:[{id, label, plan, installed, loggedIn, install, login, model, models}]}
//   PUT /api/cliagents {agent, model} -> the human's default model for that tool ('' = the tool's own)
let cliAgentsCache = { at: 0, agents: null };
/** The ready ones, for the bots' instructions: [{id, label, model}]. */
function shareCliReady(runtime) {
  if (runtime) runtime.cliReady = (cliAgentsCache.agents || []).filter((a) => a.installed && a.loggedIn).map((a) => ({ id: a.id, label: a.label, model: a.model || '' }));
}
async function refreshCliAgents(runtime) {
  const { detectCliAgents } = await import('./cliagents.mjs');
  cliAgentsCache = { at: Date.now(), agents: await detectCliAgents() };
  shareCliReady(runtime);
  return cliAgentsCache.agents;
}
route('GET', /^\/api\/cliagents$/, async (_req, _res, { query, state }) => {
  if (!cliAgentsCache.agents || query.get('refresh') || Date.now() - cliAgentsCache.at > 60000) await refreshCliAgents(state.runtime);
  return { agents: cliAgentsCache.agents };
});
route('PUT', /^\/api\/cliagents$/, async (_req, _res, { body, state }) => {
  const { saveCliModel } = await import('./cliagents.mjs');
  const config = await saveCliModel(String(body?.agent || ''), body?.model);
  if (cliAgentsCache.agents) cliAgentsCache.agents = cliAgentsCache.agents.map((a) => ({ ...a, model: config.models[a.id] || '' }));
  shareCliReady(state.runtime);
  return { ok: true, models: config.models };
});

// Connected apps (MCP). Secret values go in as {secrets:{名字: 值}} and land in
// the vault; nothing here ever answers with one.
//   GET    /api/mcp            -> {servers, presets}
//   POST   /api/mcp            {name, transport, command, args, env, url, headers, secrets, trust, bots}
//   PATCH  /api/mcp/:id        same fields, any subset
//   DELETE /api/mcp/:id
//   POST   /api/mcp/:id/test   connect again now, answer with the state and tools
route('GET', /^\/api\/mcp$/, async (_req, _res, { state }) => ({ servers: state.mcp.list(), presets: state.mcp.presets() }));
route('POST', /^\/api\/mcp$/, async (_req, _res, { state, body }) => {
  const server = await state.mcp.add(body || {});
  state.bus.emit({ type: 'settings.changed', section: 'mcp' });
  return { server };
});
route('PATCH', /^\/api\/mcp\/(?<id>[A-Za-z0-9_-]+)$/, async (_req, _res, { state, body, params }) => {
  const server = await state.mcp.update(params.id, body || {});
  state.bus.emit({ type: 'settings.changed', section: 'mcp' });
  return { server };
});
//   DELETE /api/mcp/:id?everywhere=1   a catalog app: disconnect it on the other machines too
route('DELETE', /^\/api\/mcp\/(?<id>[A-Za-z0-9_-]+)$/, async (_req, _res, { state, params, query }) => {
  const catalogId = state.mcp.list().find((s) => s.id === params.id)?.catalogId || '';
  const out = await state.mcp.remove(params.id);
  state.bus.emit({ type: 'settings.changed', section: 'mcp' });
  if (catalogId && query.get('everywhere') === '1') {
    out.peers = await Promise.all(state.peers.list().map(async (p) => {
      const peer = state.peers.find(p.name);
      try {
        const cat = await state.peers.json(peer, 'GET', '/api/mcp/catalog', { timeoutMs: 8000 });
        const there = (cat.apps || []).find((a) => a.id === catalogId)?.server;
        if (!there) return { machine: p.name, ok: true, already: true };
        await state.peers.json(peer, 'DELETE', `/api/mcp/${encodeURIComponent(there.id)}`, { timeoutMs: 20000 });
        return { machine: p.name, ok: true };
      } catch (err) {
        return { machine: p.name, ok: false, message: err.message };
      }
    }));
  }
  return out;
});
route('POST', /^\/api\/mcp\/(?<id>[A-Za-z0-9_-]+)\/test$/, async (_req, _res, { state, params }) => ({ server: await state.mcp.test(params.id) }));

// The app catalog: 「连接」 per app.
//   GET  /api/mcp/catalog               -> {apps:[{id, name, category, auth, help, server}]}
//   POST /api/mcp/catalog/:id/connect   {origin?, relay?, token?, appId?, appSecret?, everywhere?}
//                                       -> {server, authorizeUrl?, peers?:[{machine, ok, authorizeUrl?, already?, message?}]}
//   POST /api/mcp/catalog/:id/sync      {relay?} -> {peers:[...]}   connect it on the other machines too
//   GET  /api/mcp/oauth/callback        the app's sign-in page comes back here (no session needed)
//   POST /api/mcp/oauth/finish          {state, code, error?} a callback another machine received for this one
// `relay` is the loopback hub of the computer whose browser signs in: apps only
// send the browser back to https or loopback, so a machine on a LAN address
// gets its answer through that hub.
const mcpRelay = (body) => {
  for (const u of [body?.relay, body?.origin]) if (/^http:\/\/(127\.0\.0\.1|localhost|\[::1\]):\d{1,5}$/i.test(String(u || ''))) return String(u);
  return '';
};

/** Connect a catalog app that is connected here on every other machine too. */
async function syncMcpToPeers(state, catalogId, { relay = '' } = {}) {
  const payload = await state.mcp.syncPayload(catalogId);
  if (!payload) return [];
  return Promise.all(state.peers.list().map(async (p) => {
    const peer = state.peers.find(p.name);
    try {
      const cat = await state.peers.json(peer, 'GET', '/api/mcp/catalog', { timeoutMs: 8000 });
      const there = (cat.apps || []).find((a) => a.id === catalogId);
      if (!there) return { machine: p.name, ok: false, message: '那台机器的 Lamplit 版本较旧，更新后再同步' };
      // 邮箱 always gets the whole list: a mailbox added here must reach a machine that is already connected.
      if (catalogId !== 'email' && there.server && ['ready', 'connecting'].includes(there.server.state)) return { machine: p.name, ok: true, already: true };
      const body = { origin: p.url, relay, token: payload.token, appId: payload.appId, appSecret: payload.appSecret, ...(payload.fields ? { fields: payload.fields } : {}) };
      const out = await state.peers.json(peer, 'POST', `/api/mcp/catalog/${encodeURIComponent(catalogId)}/connect`, { body, timeoutMs: 60000 });
      return { machine: p.name, ok: true, authorizeUrl: out.authorizeUrl || '' };
    } catch (err) {
      return { machine: p.name, ok: false, message: err.message };
    }
  }));
}

route('GET', /^\/api\/mcp\/catalog$/, async (_req, _res, { state }) => ({ apps: state.mcp.catalog() }));
//   POST /api/mcp/mailbox/remove {email, everywhere?}   take one mailbox out of 邮箱 (here, and on the other machines)
route('POST', /^\/api\/mcp\/mailbox\/remove$/, async (_req, _res, { state, body }) => {
  const out = await state.mcp.removeMailbox(body?.email);
  state.bus.emit({ type: 'settings.changed', section: 'mcp' });
  if (body?.everywhere) {
    out.peers = await Promise.all(state.peers.list().map(async (p) => {
      try {
        await state.peers.json(state.peers.find(p.name), 'POST', '/api/mcp/mailbox/remove', { body: { email: body.email }, timeoutMs: 20000 });
        return { machine: p.name, ok: true };
      } catch (err) { return { machine: p.name, ok: false, message: err.message }; }
    }));
  }
  return out;
});
route('POST', /^\/api\/mcp\/catalog\/(?<id>[A-Za-z0-9_-]+)\/connect$/, async (_req, _res, { state, body, params }) => {
  const out = await state.mcp.connectCatalog(params.id, { ...(body || {}), relay: mcpRelay(body) });
  state.bus.emit({ type: 'settings.changed', section: 'mcp' });
  if (body?.everywhere) out.peers = await syncMcpToPeers(state, params.id, { relay: mcpRelay(body) });
  return out;
});
route('POST', /^\/api\/mcp\/catalog\/(?<id>[A-Za-z0-9_-]+)\/sync$/, async (_req, _res, { state, body, params }) => {
  if (!(await state.mcp.syncPayload(params.id))) throw httpError(400, 'MCP_NOT_CONNECTED', '这台机器上还没有连这个应用');
  return { peers: await syncMcpToPeers(state, params.id, { relay: mcpRelay(body) }) };
});
route('POST', /^\/api\/mcp\/oauth\/finish$/, async (_req, _res, { state, body }) => {
  const q = { state: String(body?.state || ''), code: String(body?.code || ''), error: String(body?.error || ''), error_description: String(body?.error_description || '') };
  if (!state.mcp.hasPending(q.state)) return { known: false };
  const out = await state.mcp.oauthCallback(q);
  state.bus.emit({ type: 'settings.changed', section: 'mcp' });
  return { known: true, ...out };
});
route('GET', /^\/api\/mcp\/oauth\/callback$/, async (req, res, { state, query }) => {
  const q = Object.fromEntries(query.entries());
  let out = null;
  // A sign-in another machine started (through this computer's browser): pass it on.
  // Only a browser on this computer can hand one over (the relay address is loopback).
  const fromHere = /^(127\.|::1$|::ffff:127\.)/.test(String(req.socket?.remoteAddress || ''));
  if (fromHere && !state.mcp.hasPending(q.state) && q.state) {
    const answers = await Promise.all(state.peers.list().map(async (p) => {
      try {
        const a = await state.peers.json(state.peers.find(p.name), 'POST', '/api/mcp/oauth/finish', { body: q, timeoutMs: 60000 });
        return a.known ? { ...a, machine: p.name } : null;
      } catch { return null; }
    }));
    out = answers.find(Boolean) || null;
  }
  if (!out) out = await state.mcp.oauthCallback(q);
  state.bus.emit({ type: 'settings.changed', section: 'mcp' });
  const esc = (t) => String(t || '').replace(/[&<>"]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c]));
  const title = out.ok ? `已连接「${esc(out.name)}」${out.machine ? `（${esc(out.machine)}）` : ''}` : '没有连上';
  const text = out.ok ? '可以关掉这个页面，回到 Lamplit。机器人现在就能用它的工具了（默认每次先问你）。' : esc(out.message);
  res.writeHead(out.ok ? 200 : 400, { 'content-type': 'text/html; charset=utf-8', 'cache-control': 'no-store' });
  res.end(`<!doctype html><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>${title}</title><body style="font-family:system-ui,sans-serif;max-width:520px;margin:15vh auto;padding:0 20px;line-height:1.6;color:#222"><h2>${title}</h2><p>${text}</p></body>`);
});

route('GET', /^\/api\/vision$/, async (_req, _res, { state }) => visionModule.publicVision(state.vision, visionCtx(state)));

route('PUT', /^\/api\/vision$/, async (_req, _res, { body, state }) => {
  const patch = {};
  for (const k of ['baseUrl', 'model', 'apiKey']) if (body?.[k] !== undefined) patch[k] = body[k];
  if (!Object.keys(patch).length) throw httpError(400, 'SETTINGS_EMPTY', 'body needs {baseUrl?, model?, apiKey?}');
  state.vision = await visionModule.saveVision(state.vision, patch);
  state.bus.emit({ type: 'settings.changed', section: 'vision' });
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
  state.bus.emit({ type: 'settings.changed', section: 'media' });
  return mediaModule.publicMedia(state.media, { voice: state.voice });
});

route('GET', /^\/api\/voice$/, async (_req, _res, { state }) => voiceModule.publicVoice(state.voice, state.settings, state.apiKey));

route('PUT', /^\/api\/voice$/, async (_req, _res, { body, state }) => {
  const patch = {};
  for (const k of ['baseUrl', 'model', 'apiKey', 'ttsVoice']) if (body?.[k] !== undefined) patch[k] = body[k];
  if (!Object.keys(patch).length) throw httpError(400, 'SETTINGS_EMPTY', 'body needs {baseUrl?, model?, apiKey?, ttsVoice?}');
  state.voice = await voiceModule.saveVoice(state.voice, patch);
  state.bus.emit({ type: 'settings.changed', section: 'voice' });
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

// Replies read aloud. The same reply is often played twice (replay, another
// window): a small cache saves paying for it again.
const speechCache = new Map(); // hash -> bytes

/** The voice a bot speaks with: its own choice, else the machine's (Settings → 模型 → 朗读回复). */
async function voiceForBot(state, botId) {
  if (botId) {
    const bot = await getBot(String(botId)).catch(() => null);
    if (bot?.voice) return bot.voice;
  }
  return state.voice?.ttsVoice || '';
}

// Translate a piece of selected text with the machine's model: Chinese to
// English, anything else to Simplified Chinese (or to `to`). No tools, no chat.
export function translatePrompt(text, to = '') {
  const target = to || (/[㐀-鿿]/.test(text) && (text.match(/[㐀-鿿]/g) || []).length >= text.replace(/\s/g, '').length * 0.3 ? 'English' : '简体中文');
  return {
    target,
    messages: [
      { role: 'system', content: `You are a translator. Translate the user's text into ${target}. Reply with the translation only: no notes, no quotes, keep line breaks, code and names as they are.` },
      { role: 'user', content: text },
    ],
  };
}

route('POST', /^\/api\/translate$/, async (_req, _res, { body, state }) => {
  const text = String(body?.text || '').trim();
  if (!text) throw httpError(400, 'TEXT_REQUIRED', 'body needs { text }');
  if (text.length > 6000) throw httpError(413, 'TEXT_TOO_LONG', 'select less text (6000 characters at most)');
  const { target, messages } = translatePrompt(text, String(body?.to || ''));
  const r = await state.model.complete(messages, { temperature: 0, maxTokens: 2000, timeoutMs: 60000 });
  return { target, text: String(r?.content || '').trim() };
});

route('POST', /^\/api\/voice\/speak$/, async (_req, res, { body, state }) => {
  const format = body?.format === 'opus' ? 'opus' : 'mp3';
  const text = voiceModule.speakableText(body?.text, Math.min(Number(body?.max) || 600, 1500));
  const service = voiceModule.resolveVoice(state.voice, state.settings, state.apiKey);
  const tts = voiceModule.ttsFor(service, { ttsVoice: body?.voice ? String(body.voice) : await voiceForBot(state, body?.botId) });
  const key = crypto.createHash('sha256').update(`${tts?.model}|${tts?.voice}|${format}|${text}`).digest('hex');
  let bytes = speechCache.get(key);
  if (!bytes) {
    bytes = await voiceModule.speak(tts, text, { format });
    speechCache.set(key, bytes);
    while (speechCache.size > 40) speechCache.delete(speechCache.keys().next().value);
  }
  res.writeHead(200, { 'content-type': format === 'opus' ? 'audio/ogg' : 'audio/mpeg', 'content-length': bytes.length, 'cache-control': 'no-store' });
  res.end(bytes);
  return undefined;
});

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
  const auth = evaluateAuth(req, state.security, state.devices);
  return { required: auth.required, authorized: auth.authorized, mode: auth.mode };
});

route('POST', /^\/api\/pair$/, async (req, res, { body, state }) => {
  if (req.viaPublic) {
    const paused = publicPairPaused();
    if (paused.paused) {
      res.setHeader('retry-after', String(Math.max(1, Math.ceil(paused.retryAfterMs / 1000))));
      throw httpError(429, 'PAIR_PAUSED_PUBLIC', 'too many failed public pairing attempts; try again later');
    }
  }
  // The public port has its own global budget (below); the per-IP limiter would
  // otherwise see one address for the whole internet and throttle real pairings.
  if (!req.viaPublic) {
    const limit = state.pairLimiter.check(clientIp(req));
    if (!limit.allowed) {
      res.setHeader('retry-after', String(Math.max(1, Math.ceil((limit.retryAfterMs || 0) / 1000))));
      throw httpError(429, 'PAIR_RATE_LIMITED', 'too many pairing attempts; wait a minute and try again');
    }
  }

  // Two ways in, both counted against the same rate limit: the 8-digit code a
  // human types, and the one-time token a QR code carries.
  const code = String(body?.code ?? body?.token ?? '').trim();
  if (!code) throw httpError(400, 'PAIR_CODE_REQUIRED', 'body needs { code }');
  // A typed code is a shared secret that can be guessed; the public port only
  // takes the one-time token a QR code carries.
  if (req.viaPublic && /^\d{8}$/.test(code)) {
    await notePublicPairFailure(state);
    throw httpError(403, 'PAIR_CODE_NOT_ALLOWED_PUBLIC', 'the 8-digit code cannot be used on the public address; scan the QR code instead');
  }
  if (!/^\d{8}$/.test(code)) {
    const link = state.pairLinks.consume(code);
    if (!link) {
      if (req.viaPublic) await notePublicPairFailure(state);
      throw httpError(401, 'PAIR_INVALID_LINK', 'that code was already used or has expired; scan the code again');
    }
  } else if (!safeEqual(code, state.security.code)) {
    throw httpError(401, 'PAIR_INVALID_CODE', 'that pairing code is not valid');
  } else if (pairingCodeExpired(state.security)) {
    void renewPairingCode(state.security);
    throw httpError(401, 'PAIR_CODE_EXPIRED', '这个配对码已经过期（一天换一次），到 设置 → 手机和外网 看新的');
  } else {
    // A typed code is spent once: whoever reads it off the screen later cannot reuse it (SEC-15).
    void renewPairingCode(state.security);
  }

  // Every paired client gets its own session, so Settings can list the phones
  // and remove one without logging the others out.
  // A client may name its device (the computer's entry for the other machines).
  const deviceName = String(body?.deviceName || '').trim().slice(0, 40);
  const userAgent = req?.headers?.['user-agent'];
  const { device, sessionToken } = state.devices.add({ name: deviceName || describeAgent(userAgent), ip: clientIp(req), kind: deviceKind(userAgent) });
  res.setHeader('set-cookie', sessionCookieHeader(sessionToken, { secure: isSecureRequest(req) || Boolean(req.viaPublic) }));
  // A native app has no cookie jar it trusts across origins: when it says so, it
  // gets the per-device token in the body and sends it as `Authorization`.
  if (String(body?.client || '') === 'app') return { ok: true, device, token: sessionToken };
  return { ok: true, device };
});

// --- public pairing guard -----------------------------------------------------
// The public port only accepts one-time tokens; 20 failures within an hour
// pause public pairing for 15 minutes (audited once), so a scanner cannot
// grind tokens from the whole internet.

const publicPairLog = { fails: [], pausedUntil: 0 };

function publicPairPaused() {
  const now = Date.now();
  if (publicPairLog.pausedUntil > now) return { paused: true, retryAfterMs: publicPairLog.pausedUntil - now };
  return { paused: false };
}

async function notePublicPairFailure(state) {
  const now = Date.now();
  publicPairLog.fails = publicPairLog.fails.filter((t) => now - t < 60 * 60 * 1000);
  publicPairLog.fails.push(now);
  if (publicPairLog.fails.length >= 20 && publicPairLog.pausedUntil < now) {
    publicPairLog.pausedUntil = now + 15 * 60 * 1000;
    await audit({
      kind: 'public.pair.paused',
      failures: publicPairLog.fails.length,
      until: new Date(publicPairLog.pausedUntil).toISOString(),
    }).catch(() => {});
    state.bus.emit({ type: 'attention.changed' });
  }
}

route('GET', /^\/api\/pairing$/, async (_req, _res, { state }) => pairingInfo(state));

// A QR code in Settings: a URL that pairs the phone by itself, once, in ten
// minutes. Only the machine owner (or an already-paired device) can ask.
/** `<lan>/?pair=T&alt=<tailnet>&alt=<public>`; null when there is no address. */
function combinedPairUrl(links, token) {
  const order = { lan: 0, tailnet: 1, public: 2 };
  const sorted = [...(links || [])].filter((l) => l && l.url).sort((a, b) => (order[a.kind] ?? 3) - (order[b.kind] ?? 3));
  if (!sorted.length) return null;
  const [first, ...rest] = sorted;
  const url = new URL(`${String(first.url).replace(/\/+$/, '')}/`);
  url.searchParams.set('pair', token);
  for (const link of rest) url.searchParams.append('alt', new URL(link.url).origin);
  return url.toString();
}

route('POST', /^\/api\/pairing\/link$/, async (_req, _res, { state }) => {
  const publicUrl = funnelPublicUrl();
  if (!state.lanUrl && !publicUrl) {
    throw httpError(
      409,
      'REMOTE_DISABLED',
      'this hub only listens on 127.0.0.1 - turn on "允许手机连接" in Settings → 手机和外网 first',
    );
  }
  const port = state.port;
  const lanAddress = preferredLanAddress();
  const tailnetIp = tailnetAddress();
  const links = [];
  // Public first: a phone without Tailscale can only use this one.
  if (publicUrl) links.push({ kind: 'public', url: publicUrl });
  if (state.lanUrl) {
    if (lanAddress) links.push({ kind: 'lan', url: lanUrlFor(lanAddress, port) });
    if (tailnetIp) links.push({ kind: 'tailnet', url: lanUrlFor(tailnetIp, port) });
  }

  // One token, every address: the phone scans whichever it can reach.
  const { token, expiresAt } = state.pairLinks.create();
  const withToken = links.map((link) => ({ ...link, url: `${link.url}/?pair=${token}` }));
  const preferred = withToken[0] || null;
  return {
    links: withToken,
    url: preferred?.url || null,
    // One code for every address: LAN first (what a phone at home opens), the
    // others as alt=. The Nightshift app tries them all and keeps the one that
    // answers - LAN when it is on the same network, Tailscale when it is not.
    qr: combinedPairUrl(links, token),
    expiresAt: new Date(expiresAt).toISOString(),
    expiresInSec: Math.round((expiresAt - Date.now()) / 1000),
  };
});

route('GET', /^\/api\/devices$/, async (_req, _res, { state }) => ({ devices: state.devices.list() }));

// Public HTTPS door. Off by default; enabling runs the real Tailscale CLI and
// persists the choice so a restart brings it back.
route('GET', /^\/api\/funnel$/, async (_req, _res, { state }) => funnelView(state.publicPort));

route('POST', /^\/api\/funnel$/, async (_req, _res, { body, state }) => {
  if (typeof body?.enabled !== 'boolean') throw httpError(400, 'BAD_FUNNEL', 'body needs {enabled}');
  if (body.enabled) await enableFunnel(state.publicPort);
  else await disableFunnel();
  state.bus.emit({ type: 'settings.changed', section: 'network' });
  return funnelView(state.publicPort);
});

route('GET', /^\/api\/machines\/(?<name>[^/]+)\/funnel$/, async (_req, _res, { params, state }) => {
  const peer = state.peers.find(params.name);
  if (!peer) throw httpError(404, 'MACHINE_NOT_FOUND', `no machine called "${params.name}"`);
  const view = await state.peers.json(peer, 'GET', '/api/funnel', { timeoutMs: 15000 });
  return { ok: true, machine: peer.name, funnel: view };
});

route('POST', /^\/api\/machines\/(?<name>[^/]+)\/funnel$/, async (_req, _res, { params, body, state }) => {
  if (typeof body?.enabled !== 'boolean') throw httpError(400, 'BAD_FUNNEL', 'body needs {enabled}');
  const peer = state.peers.find(params.name);
  if (!peer) throw httpError(404, 'MACHINE_NOT_FOUND', `no machine called "${params.name}"`);
  const view = await state.peers.json(peer, 'POST', '/api/funnel', { body: { enabled: body.enabled }, timeoutMs: 60000 });
  state.bus.emit({ type: 'settings.changed', section: 'machines' });
  return { ok: true, machine: peer.name, funnel: view };
});

route('DELETE', /^\/api\/devices\/(?<id>[^/]+)$/, async (_req, _res, { params, state }) => {
  const removed = state.devices.remove(params.id);
  if (!removed) throw httpError(404, 'DEVICE_NOT_FOUND', 'no such device');
  state.bus.emit({ type: 'settings.changed', section: 'network' });
  return { ok: true };
});

// Probe results are reused briefly: the machine list is opened often, and every
// probe costs a round trip to a machine that may be asleep (a phone waits for
// the whole answer).
const machineProbeCache = new Map(); // name -> { at, online }
const MACHINE_PROBE_TTL_MS = 15000;
const MACHINE_PROBE_TIMEOUT_MS = 900;
// A phone that is paired with this hub may want to look at another machine.
// It must NOT receive that machine's credential: instead the hub asks the other
// machine for a one-time pairing link (it already holds a bearer token there)
// and hands that back. The phone follows it, pairs there, and the link dies.
//
//   GET  /api/machines                  [{name, url, online, self}]
//   POST /api/machines/:name/handoff    {url} - a one-time link into that machine

/**
 * This machine's name in the owner's lists: the one given when it was added
 * (pushed by the computer that added it), else the hostname - with a VM
 * hostname like "ubuntu-VMware-Virtual-Platform" cut down to "ubuntu". Never
 * the product name: every hub is "Nightshift".
 */
let selfNameCache;
function selfMachineName() {
  if (selfNameCache === undefined) {
    selfNameCache = '';
    try { selfNameCache = String(JSON.parse(fs.readFileSync(path.join(P.dataDir, 'machine.json'), 'utf8')).name || '').trim(); } catch { /* not named */ }
  }
  if (selfNameCache) return selfNameCache;
  const hostname = os.hostname();
  return /^(.*?)-(vmware|virtualbox|virtual|platform)/i.exec(hostname)?.[1] || hostname;
}
function setSelfMachineName(name) {
  const clean = String(name).trim().slice(0, 40);
  if (!clean || clean === selfNameCache) return;
  selfNameCache = clean;
  try { writeJsonSyncAtomic(path.join(P.dataDir, 'machine.json'), { name: clean }); } catch { /* still applies until a restart */ }
}

route('GET', /^\/api\/machines$/, async (_req, _res, { state }) => {
  const peers = state.peers.list();
  // Its Tailscale address too: a phone that refreshes this row from here must not lose it.
  const selfTailnet = tailnetUrl(state);
  const self = { name: selfMachineName(), url: state.pairingUrl || null, ...(selfTailnet && selfTailnet !== state.pairingUrl ? { tailnetUrl: selfTailnet } : {}), online: true, self: true };
  const rest = await Promise.all(
    peers.map(async (peer) => {
      // list() deliberately hides tokens; the probe needs the real record, or it
      // would authenticate with nothing and report every machine as offline.
      const full = state.peers.find(peer.name) || peer;
      const cached = machineProbeCache.get(peer.name);
      let online;
      if (cached && Date.now() - cached.at < MACHINE_PROBE_TTL_MS) {
        online = cached.online;
      } else {
        // Both addresses at once: a LAN address that hangs must not hide a
        // Tailscale address that answers.
        const probe = (base) =>
          base
            ? state.peers
                .call(full, 'GET', '/api/health', { timeoutMs: MACHINE_PROBE_TIMEOUT_MS, base })
                .then((res) => res.ok)
                .catch(() => false)
            : Promise.resolve(false);
        online = (await Promise.all([probe(peer.url), probe(peer.tailnetUrl || '')])).some(Boolean);
        machineProbeCache.set(peer.name, { at: Date.now(), online });
      }
      return { name: peer.name, url: peer.url, tailnetUrl: peer.tailnetUrl || '', online, self: false };
    }),
  );
  return { machines: [self, ...rest] };
});

route('POST', /^\/api\/machines\/(?<name>[^/]+)\/handoff$/, async (_req, _res, { params, state }) => {
  const peer = state.peers.find(params.name);
  if (!peer) throw httpError(404, 'MACHINE_NOT_FOUND', `no machine called "${params.name}"`);
  let made;
  try {
    made = await state.peers.json(peer, 'POST', '/api/pairing/link', { timeoutMs: 8000 });
  } catch (err) {
    if (err.code === 'REMOTE_DISABLED') {
      throw httpError(409, 'MACHINE_REMOTE_DISABLED', `「${peer.name}」没有打开允许手机连接，先在它上面打开再试`);
    }
    throw err;
  }
  if (!made?.url) throw httpError(409, 'MACHINE_NO_ADDRESS', `「${peer.name}」没有可用的手机地址`);
  // Every address the machine has (public, LAN, Tailscale): the phone opens the
  // first one it can reach. A VM's LAN address is often the computer's internal
  // network, while its Tailscale one works from the phone.
  const links = Array.isArray(made.links) ? made.links.filter((l) => l && typeof l.url === 'string') : [];
  return { ok: true, machine: peer.name, url: made.url, links, qr: made.qr || null, expiresAt: made.expiresAt };
});

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

const sha256Hex = (bytes) => crypto.createHash('sha256').update(bytes).digest('hex');
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
    // New code runs with every right this machine has (SEC-06): the master token,
    // another computer's Lamplit, or the desktop app here (no Origin: not a page).
    // Never a phone, a browser, or a web page.
    const auth = req.auth || {};
    const device = auth.deviceId ? state.devices.list().find((d) => d.id === auth.deviceId) : null;
    const allowed = auth.mode === 'local' ? !req.headers.origin : auth.deviceId ? mayPushUpdate(device) : auth.mode === 'token' || auth.mode === 'cookie';
    if (!allowed) throw httpError(403, 'UPDATE_NOT_ALLOWED', 'only another computer running Lamplit (or the master token) can update this machine');
    const expected = String(req.headers['x-nightshift-sha256'] || '').trim().toLowerCase();
    if (!/^[0-9a-f]{64}$/.test(expected)) throw httpError(400, 'UPDATE_HASH_REQUIRED', 'send the package SHA-256 in x-nightshift-sha256');
    if (state.runtime.activeTurns().length) {
      throw httpError(409, 'UPDATE_BUSY', '这台机器上有任务正在进行，等它做完再更新');
    }
    const bytes = await readRawBody(req, UPDATE_MAX_BYTES, { code: 'UPDATE_TOO_LARGE', message: '更新包太大' });
    if (!safeEqual(sha256Hex(bytes), expected)) throw httpError(400, 'UPDATE_HASH_MISMATCH', '更新包和它的校验值对不上（传输中损坏或被改过）');
    const result = await applyUpdate({ bytes, currentVersion: VERSION, log: (line) => console.error(line) });
    if (process.env.ASSIST_UPDATE_NO_EXIT !== '1') {
      setTimeout(() => process.exit(0), 800).unref?.();
    }
    return { ok: true, ...result, restarting: true };
  },
  { rawBody: true },
);

route('POST', /^\/api\/remote\/push-update$/, async (req, _res, { body }) => {
  if (req.viaPublic || !isLoopbackHost(clientIp(req))) throw httpError(403, 'LOCAL_ONLY', 'only the desktop app on this computer can push updates');
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
    const packageBytes = fs.readFileSync(packed.file);
    const res = await fetch(`${url}/api/system/update`, {
      method: 'POST',
      headers: { ...headers, 'content-type': 'application/gzip', 'x-nightshift-version': VERSION, 'x-nightshift-sha256': sha256Hex(packageBytes) },
      body: packageBytes,
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
  const items = records.slice(-limit).map((record, index) => toMessageItem(record, index));
  // compact=1: the chat with its steps hidden. Long tool output and arguments
  // only start there; the page asks for everything when steps are shown. On a
  // phone over a slow link the full list (392 KB for a long chat) took 4 s.
  // Steps the chat does not show (every tool row but the two cards the human
  // acts on) are left out altogether: they were most of the bytes.
  return query.get('compact') === '1'
    ? items.filter((m) => m.role !== 'tool' || ACTION_CARD_TOOLS.has(m.name)).map(compactToolItem)
    : items;
});

/** Tool rows the chat shows even with its steps hidden: the human acts on them. */
const ACTION_CARD_TOOLS = new Set(['request_takeover', 'request_login']);

/** A tool row with its long parts cut to a preview (the steps the chat does not show). */
export function compactToolItem(item) {
  if (item.role !== 'tool') return item;
  const long = (v) => typeof v === 'string' && v.length > 600;
  const args = item.args && typeof item.args === 'object' && !Array.isArray(item.args)
    ? Object.fromEntries(Object.entries(item.args).map(([k, v]) => [k, long(v) ? `${v.slice(0, 600)}…（共 ${v.length} 字）` : v]))
    : item.args;
  const text = typeof item.output === 'string' ? item.output : JSON.stringify(item.output ?? null);
  const output = text && text.length > 1500 ? { preview: text.slice(0, 1500), length: text.length, cut: true } : item.output;
  return { ...item, args, output };
}

route('POST', /^\/api\/bots\/(?<id>[^/]+)\/message$/, async (_req, res, { params, body, state }) => {
  const bot = await getBot(params.id);
  if (!bot) throw httpError(404, 'BOT_NOT_FOUND', `no bot with id "${params.id}"`);

  const text = withAttachments(String(body?.text ?? '').trim(), await checkAttachments(state, body?.attachments));
  if (!text) throw httpError(400, 'EMPTY_MESSAGE', 'text is required');
  if (text.length > 20000) throw httpError(400, 'MESSAGE_TOO_LONG', 'text is limited to 20000 characters');

  // Answer immediately with the turn id; the turn streams over SSE.
  const turnId = uid('turn');
  // Work handed over by a bot on another machine: keep the chain's limits.
  const h = body?.handoff && typeof body.handoff === 'object' ? body.handoff : null;
  const handoff = h ? {
    depth: Math.min(3, Math.max(1, Number(h.depth) || 1)),
    chain: (Array.isArray(h.chain) ? h.chain : []).slice(0, 10).map((c) => String(c).slice(0, 120)),
    handoffBudget: { left: Math.min(12, Math.max(0, Number(h.budgetLeft) || 0)) },
  } : null;
  const fromNote = h ? `（另一台机器上的「${String(h.from?.bot || '队友').slice(0, 40)}」派给你的活；你的最终回答会传回给它。需要的文件可能在那台机器上，让它用 file_send 发过来，或在回答里写明你产出的文件路径。）\n\n` : '';
  // The bot is busy with something the human asked: answer now (no second
  // turn racing the first), and hand the message to the running turn.
  if (!h && state.runtime.busyTurn?.(bot.id)) {
    state.runtime.aside({ botId: bot.id, text, turnId, source: 'chat' })
      .catch((err) => state.bus.emit({ type: 'error', botId: bot.id, turnId, message: err.message }));
    return { turnId, botId: bot.id, aside: true };
  }
  state.runtime
    .runTurn({ botId: bot.id, text: fromNote + text, source: h ? 'peer' : 'chat', turnId, ...(handoff || {}) })
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
  // ...and a link inside it must not lead out (SEC-18).
  const realRoot = realPathOf(root);
  const real = realPathOf(abs);
  const cmp = (s) => (process.platform === 'win32' ? s.toLowerCase() : s);
  if (cmp(real) !== cmp(realRoot) && !cmp(real).startsWith(cmp(realRoot + path.sep))) throw httpError(400, 'PATH_OUTSIDE_WORKSPACE', 'path must stay inside the workspace');
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
async function resolveMemberIds(input, bots, peers = null, known = {}) {
  const list = bots || (await listBots());
  const ids = [];
  const unknown = [];
  // ids.remotes: what is known of the members on other machines ("botId@machine").
  ids.remotes = {};
  for (const ref of groups.normalizeMemberIds(input)) {
    const id = isRemoteMember(ref) ? null : await resolveBotRef(ref, list);
    // Already a member from another machine: stays, also while that machine is off.
    const far = id ? null : (known[ref] ? { id: ref, info: known[ref] } : await resolveRemoteMember(peers, ref));
    if (id) { if (!ids.includes(id)) ids.push(id); }
    else if (far) { if (!ids.includes(far.id)) ids.push(far.id); ids.remotes[far.id] = far.info; }
    else unknown.push(ref);
  }
  if (unknown.length) {
    throw httpError(400, 'GROUP_UNKNOWN_MEMBER', `no bot matches: ${unknown.join(', ')}`);
  }
  return ids;
}

/** A group's members as the chat and the runtime need them: local bots, and the ones on other machines. */
function groupMemberList(group, byId) {
  const taken = new Set(group.members.map((id) => byId.get(id)?.name).filter(Boolean));
  return group.members.map((id) => {
    const bot = byId.get(id);
    if (bot) return { id, name: bot.name, role: bot.role, avatar: bot.avatar, tools: bot.tools || [] };
    const far = group.remotes?.[id];
    if (!far) return null;
    // Two members of the same name: the far one says where it is.
    const name = taken.has(far.name) ? `${far.name}@${far.machine}` : far.name;
    taken.add(name);
    return { id, name, role: far.role, machine: far.machine, remote: { machine: far.machine, botId: far.botId } };
  }).filter(Boolean);
}

async function publicGroup(group, bots) {
  const byId = bots instanceof Map ? bots : await botsById();
  return {
    id: group.id,
    name: group.name,
    members: groupMemberList(group, byId).map(({ remote, ...m }) => m),
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
  const memberIds = await resolveMemberIds(body?.members, bots, state.peers);

  let coordinatorId;
  if (body?.coordinatorId !== undefined && String(body.coordinatorId ?? '').trim() !== '') {
    coordinatorId = await resolveBotRef(body.coordinatorId, bots);
    if (!coordinatorId) {
      throw httpError(400, 'GROUP_UNKNOWN_MEMBER', `no bot matches "${body.coordinatorId}"`);
    }
  }

  const group = await groups.createGroup({ name: body?.name, members: memberIds, coordinatorId, remotes: memberIds.remotes });
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

//   GET /api/groups/:id/plans/:planId -> {plan}   a task board (the group card shows it)
route('GET', /^\/api\/groups\/(?<id>[^/]+)\/plans\/(?<planId>[\w-]+)$/, async (_req, _res, { params, state }) => {
  const live = await state.runtime.groupPlan?.(params.id);
  const plan = live?.id === params.planId ? live : await loadPlan(params.planId);
  if (!plan || plan.groupId !== params.id) throw httpError(404, 'PLAN_NOT_FOUND', 'no such task board');
  return { plan };
});

//   GET /api/bots/:id/plans/:planId -> {plan}   a bot's task (the checklist card in its chat)
route('GET', /^\/api\/bots\/(?<id>[^/]+)\/plans\/(?<planId>[\w-]+)$/, async (_req, _res, { params, state }) => {
  const live = state.runtime.tasks?.get(params.id);
  const plan = live?.id === params.planId ? live : await loadPlan(params.planId);
  if (!plan || plan.kind !== 'task' || plan.botId !== params.id) throw httpError(404, 'PLAN_NOT_FOUND', 'no such task');
  return { plan };
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
  const members = groupMemberList(group, byId).map(({ avatar, ...m }) => m);

  // Answer immediately with the turn id; the turn streams over SSE and its
  // transcript lands in data/groups/<id>.jsonl.
  const turnId = uid('turn');
  // A task on the group's board asked the human something: this is the answer.
  if (await state.runtime.answerBoard?.({ id: group.id, name: group.name, coordinatorId: group.coordinatorId, members }, text)) return { turnId, board: true };
  // Someone in the group is still working on the last message: they answer
  // now, and the message reaches their running turn (as in a 1:1 chat).
  const busy = state.runtime.busyGroupTurn?.(group.id);
  if (busy) {
    state.runtime.aside({ botId: busy.botId, text, turnId, source: 'group', busy, group: { id: group.id, name: group.name, coordinatorId: group.coordinatorId, members } })
      .catch((err) => state.bus.emit({ type: 'error', groupId: group.id, turnId, message: err.message }));
    return { turnId, aside: true };
  }
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
    patch.members = await resolveMemberIds(body.members, bots, state.peers, current.remotes || {});
    patch.remotes = patch.members.remotes;
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
      snap.desktop = { url: perBot.url, botId, perBot: true, display: perBot.display, mode: perBot.mode || 'full' };
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

// --- workspace location ----------------------------------------------------
// The bots' shared folder can live anywhere the human likes (another drive,
// a synced folder). Read once at start (store.mjs), so a change restarts the
// hub the way an update does; files already there are not moved.
//   GET /api/workspace -> {path, defaultPath, custom}
//   PUT /api/workspace {path} ('' = back to the default) -> {ok, path, restarting}

route('GET', /^\/api\/workspace$/, async (_req, _res, { state }) => {
  const { DEFAULT_WORKSPACE_DIR } = await import('./store.mjs');
  return { path: state.workspaceDir, defaultPath: DEFAULT_WORKSPACE_DIR, custom: path.resolve(state.workspaceDir) !== path.resolve(DEFAULT_WORKSPACE_DIR) };
});
route('PUT', /^\/api\/workspace$/, async (_req, _res, { body, state }) => {
  const { DEFAULT_WORKSPACE_DIR, WORKSPACE_FILE } = await import('./store.mjs');
  const raw = String(body?.path ?? '').trim();
  const target = raw ? checkWorkspacePath(raw, { dataDir: P.dataDir }) : { ok: true, path: DEFAULT_WORKSPACE_DIR };
  if (!target.ok) throw httpError(400, 'BAD_WORKSPACE', target.error);
  if (state.runtime.activeTurns().length) throw httpError(409, 'WORKSPACE_BUSY', '有机器人正在干活，等它做完再换工作区');
  // It must exist (or be made) and take a file.
  try {
    fs.mkdirSync(target.path, { recursive: true });
    const probe = path.join(target.path, `.lamplit-write-test-${process.pid}`);
    fs.writeFileSync(probe, 'ok');
    fs.unlinkSync(probe);
  } catch (err) {
    throw httpError(400, 'WORKSPACE_NOT_WRITABLE', `这个文件夹建不了或写不进去：${err.message}`);
  }
  if (raw) writeJsonSyncAtomic(WORKSPACE_FILE, { path: target.path, updatedAt: nowIso() });
  else { try { fs.unlinkSync(WORKSPACE_FILE); } catch { /* already default */ } }
  const same = path.resolve(target.path) === path.resolve(state.workspaceDir);
  if (!same && process.env.ASSIST_UPDATE_NO_EXIT !== '1') setTimeout(() => process.exit(0), 800).unref?.();
  return { ok: true, path: target.path, restarting: !same };
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
    // Making pictures and videos (costs money): 'level' follows the approval level, 'ask' always asks, 'auto' never does.
    generate: ['ask', 'auto'].includes(policy?.generate) ? policy.generate : 'level',
    denyPatterns: eff.denyPatterns.length,
    // What the bots may touch on this machine (src/boundary.mjs).
    workspace: P.workspaceDir,
    folders: (policy?.folders || []).map((f) => ({ id: f.id, path: f.path, write: Boolean(f.write) })),
    outside: policy?.outside === 'deny' ? 'deny' : 'ask',
    sudo: policy?.sudo === 'allow' ? 'allow' : 'ask',
    // The primary bot past the machine boundary (sudo, places outside the
    // workspace); the dangerous-command list still asks.
    trustPrimary: Boolean(policy?.trustPrimary),
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
  if (body?.generate !== undefined) {
    if (!['level', 'ask', 'auto'].includes(body.generate)) throw httpError(400, 'BAD_GENERATE', "generate must be 'level', 'ask' or 'auto'");
    next.generate = body.generate;
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
  if (body?.trustPrimary !== undefined) next.trustPrimary = Boolean(body.trustPrimary);
  state.config.policy = next;
  await writeAssistantConfig({ ...state.config, workspaceDir: undefined });
  const change = {};
  for (const k of ['level', 'takeover', 'generate', 'addDeny', 'removeDeny', 'addRule', 'removeRule', 'autoApproveAll', 'addFolder', 'removeFolder', 'folderWrite', 'outside', 'sudo', 'trustPrimary']) {
    if (body?.[k] !== undefined) change[k] = body[k];
  }
  await audit({ kind: 'policy.changed', change });
  const pub = publicPolicy(next);
  state.bus.emit({ type: 'policy.changed', autoApproveAll: pub.autoApproveAll, level: pub.level });
  state.bus.emit({ type: 'settings.changed', section: 'policy' });
  return pub;
});

// --- usage / cost -----------------------------------------------------------
//
//   GET /api/usage?days=30  -> today + window totals, by bot / day / model
//   PUT /api/usage {currency?, prices?, dailyAlert?} -> saved settings
//
// Prices are per million tokens and optional: an unpriced model counts tokens
// but no money. The daily threshold is audited once per day (src/usage.mjs).

route('GET', /^\/api\/usage$/, async (_req, _res, { query }) => {
  const days = Math.min(Math.max(Number(query.get('days')) || 30, 1), 365);
  const settings = readUsageSettings();
  const records = recentRecords(await readUsageRecords(), days);
  const summary = summarizeUsage(records, settings);
  const today = summarizeUsage(records.filter((r) => r.day === localDay()), settings).totals;
  return { currency: settings.currency, days, today, alert: settings.dailyAlert ? readUsageAlert() : null, settings, ...summary };
});

route('PUT', /^\/api\/usage$/, async (_req, _res, { body, state }) => {
  const settings = await saveUsageSettings(body || {});
  await audit({ kind: 'usage.settings', currency: settings.currency, models: Object.keys(settings.prices), dailyAlert: settings.dailyAlert });
  state.bus.emit({ type: 'settings.changed', section: 'usage' });
  return { settings };
});

// --- approvals -------------------------------------------------------------

route('GET', /^\/api\/approvals$/, async (_req, _res, { query, state }) => {
  return state.approvals.list({
    status: query.get('status') || undefined,
    botId: query.get('botId') || undefined,
    limit: Number(query.get('limit')) || 100,
  });
});

route('POST', /^\/api\/approvals\/(?<id>[^/]+)$/, async (req, _res, { params, body, state }) => {
  const decision = body?.decision;
  if (!decision) throw httpError(400, 'DECISION_REQUIRED', 'body needs { decision: "approve" | "deny" }');
  // A device token means the answer came from the phone (a notification action
  // or the app's own card); a loopback browser is the person at this computer.
  const by = req.auth?.deviceId ? 'device' : 'human';
  const record = state.approvals.decide(params.id, decision, body?.note || '', by);
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
  state.bus.emit({ type: 'settings.changed', section: 'routines' });
  return { routine: publicRoutine(created) };
});

route('PATCH', /^\/api\/routines\/(?<id>[^/]+)$/, async (_req, _res, { params, body, state }) => {
  const updated = await state.routines.update(params.id, body || {});
  state.bus.emit({ type: 'settings.changed', section: 'routines' });
  return { routine: publicRoutine(updated) };
});

route('DELETE', /^\/api\/routines\/(?<id>[^/]+)$/, async (_req, _res, { params, state }) => {
  const result = state.routines.remove(params.id);
  state.bus.emit({ type: 'settings.changed', section: 'routines' });
  return result;
});

route('POST', /^\/api\/routines\/(?<id>[^/]+)\/test$/, async (_req, _res, { params, state }) => {
  const result = await state.routines.runNow(params.id, { trigger: 'test' });
  return { routine: publicRoutine(result.routine), run: result.run };
});

// --- background videos ----------------------------------------------------------
//   GET /api/media/jobs?botId=&groupId=   -> {jobs:[{id, state, prompt, createdAt, doneAt, path, error}], typicalSec}
// For the "视频生成中 · 已等 3 分 · 通常约 6 分钟" card in the chat that asked.

route('GET', /^\/api\/media\/jobs$/, async (_req, _res, { query, state }) => {
  const all = state.videoJobs ? state.videoJobs.list() : [];
  const botId = query.get('botId') || '';
  const groupId = query.get('groupId') || '';
  const mine = all.filter((j) => (groupId ? j.groupId === groupId : (j.botId === botId || j.reportTo === botId) && !j.groupId));
  // How long videos took here lately (the last ten that finished).
  const took = all.filter((j) => j.state === 'done' && j.doneAt && j.createdAt).slice(-10).map((j) => (j.doneAt - j.createdAt) / 1000);
  const typicalSec = took.length ? Math.round(took.sort((a, b) => a - b)[Math.floor(took.length / 2)]) : null;
  const recent = mine.filter((j) => j.state === 'running' || Date.now() - (j.doneAt || j.createdAt) < 10 * 60 * 1000).slice(-5);
  return {
    jobs: recent.map((j) => ({ id: j.id, state: j.state, prompt: j.prompt, createdAt: j.createdAt, doneAt: j.doneAt || null, path: j.path || '', error: j.error || '' })),
    typicalSec,
  };
});

// --- Tailscale on a machine already added -----------------------------------------
//   GET  /api/tailscale            -> {address, canInstall, status:{state:'idle'|'running'|'done'|'failed', detail}}
//   POST /api/tailscale/install    {authKey}   install and join, in the background
// Only on a machine given to the bots (the hub has the rights there); on the
// human's own computer they install the Tailscale app themselves.

const TS_LOG = process.platform === 'win32' ? path.join(process.env.ProgramData || 'C:\\ProgramData', 'Nightshift', 'tailscale.log') : '/var/log/desk-tailscale.log';
let tsLaunchFailedAt = 0; // the hub gave up on an installer that never started (the log may be root-owned)
const TS_LAUNCH_FAILED = '安装程序没能启动（密钥已删掉）；再点一次试试，还不行就到那台机器上手动装 Tailscale';
function tailscaleStatus() {
  if (tsLaunchFailedAt && Date.now() - tsLaunchFailedAt < 30 * 60 * 1000) return { state: 'failed', detail: TS_LAUNCH_FAILED };
  let text = '';
  let at = 0;
  try { text = fs.readFileSync(TS_LOG, 'utf8'); at = fs.statSync(TS_LOG).mtimeMs; } catch { return { state: 'idle', detail: '' }; }
  const m = [...text.matchAll(/DESK_TS=(done|failed)\s*(\S*)\s*(.*)/g)].pop();
  if (!m) return Date.now() - at < 15 * 60 * 1000 ? { state: 'running', detail: '正在安装 Tailscale…' } : { state: 'idle', detail: '' };
  if (m[1] === 'done') return { state: 'done', detail: m[2] ? `已加入你的网络：${m[2]}` : '已加入你的网络' };
  const why = m[2] === 'launch' ? TS_LAUNCH_FAILED
    : m[2] === 'key' ? '密钥不对：要 tskey-auth- 开头、没过期、没用过的 Auth key'
    : m[2] === 'download' ? '下载不了 Tailscale（这台机器连不上 tailscale.com？）'
      : (`${m[2]} ${m[3]}`.trim() || '安装失败');
  return { state: 'failed', detail: why };
}

route('GET', /^\/api\/tailscale$/, async (_req, _res, { state }) => ({
  address: tailnetUrl(state),
  canInstall: process.env.DESK_MACHINE_MODE === 'remote' && ['linux', 'win32'].includes(process.platform),
  status: tailscaleStatus(),
}));

route('POST', /^\/api\/tailscale\/install$/, async (_req, _res, { body, state }) => {
  if (process.env.DESK_MACHINE_MODE !== 'remote') throw httpError(400, 'TS_LOCAL', '这是你自己的电脑：请直接安装 Tailscale 客户端并登录');
  const key = String(body?.authKey || '').trim();
  if (/^tskey-api-/.test(key)) throw httpError(400, 'TS_API_KEY', '这是 API 访问令牌（tskey-api-），不能用来加设备：在 Tailscale 后台 Settings → Keys 里点「Generate auth key」');
  if (!/^tskey-auth-[A-Za-z0-9-]{10,200}$/.test(key)) throw httpError(400, 'TS_BAD_KEY', 'Tailscale 密钥应该是 tskey-auth- 开头的 Auth key');
  if (tailscaleStatus().state === 'running') throw httpError(409, 'TS_RUNNING', '已经在安装了，稍等');
  const { tailscaleDeviceName } = await import('./remote.mjs');
  const name = tailscaleDeviceName(state.uiState?.machine?.name || os.hostname());
  const keyFile = path.join(os.tmpdir(), `desk-tailscale-${crypto.randomBytes(6).toString('hex')}.key`);
  fs.writeFileSync(keyFile, `${key}\n`, { mode: 0o600 });
  tsLaunchFailedAt = 0;
  const hubDir = fileURLToPath(new URL('../hub/', import.meta.url)); // next to the code, not the data
  try { fs.writeFileSync(TS_LOG, 'start\n'); } catch { /* root-owned on Linux: the script writes it */ }
  if (process.platform === 'win32') {
    // Not detached: from the hub's background task (session 0), a detached
    // PowerShell exits at once with code 0 and runs nothing (seen on win11).
    const child = spawnChild('powershell.exe', ['-NoProfile', '-ExecutionPolicy', 'Bypass', '-File', path.join(hubDir, 'tailscale-windows.ps1'), '-KeyFile', keyFile, ...(name ? ['-Name', name] : [])], { stdio: 'ignore', windowsHide: true });
    child.on('error', () => {});
    child.unref();
  } else {
    // The hub's account may use sudo without a password on a machine given to the bots.
    const cmd = `/bin/bash '${path.join(hubDir, 'tailscale-linux.sh')}' '${keyFile}' '${name}' > ${TS_LOG} 2>&1`;
    const child = spawnChild('sudo', ['-n', 'systemd-run', '--unit=desk-tailscale-setup', '--collect', '--quiet', '/bin/bash', '-c', cmd], { detached: true, stdio: 'ignore' });
    child.on('error', () => {});
    child.unref();
  }
  // Safety net for an installer that never started (no sudo, a launch that did
  // nothing): after 90 s, remove the key and say so, never "installing…"
  // forever. "Started" is the installer's own word for it: on Linux it takes
  // the key file over at once; on Windows the key waits in its file until the
  // last step (download and install come first), so look for its own log line.
  setTimeout(() => {
    if (!fs.existsSync(keyFile)) return;
    if (process.platform === 'win32') {
      let log = '';
      try { log = fs.readFileSync(TS_LOG, 'utf8'); } catch { /* none yet */ }
      if (/^start \d{4}-/m.test(log)) return; // it is running; it removes the key itself
    }
    try { fs.unlinkSync(keyFile); } catch { /* gone */ }
    try { fs.appendFileSync(TS_LOG, 'DESK_TS=failed launch\n'); } catch { /* root-owned log */ }
    tsLaunchFailedAt = Date.now();
  }, 90000).unref();
  await audit({ kind: 'tailscale.install', name });
  return { ok: true, status: { state: 'running', detail: '正在安装 Tailscale…' } };
});

// --- daily briefing -----------------------------------------------------------
//   GET /api/briefing           -> {enabled, time, feishu, botId, routineId, lastRun, lastStatus, nextRun}
//   PUT /api/briefing           {enabled, time:"08:30", feishu, botId}   one routine with preset "briefing"
//   GET /api/briefing/data?hours=24   this machine's facts (peers ask for these)

function briefingView(state) {
  const r = state.routines.list().find((x) => x.preset === 'briefing');
  if (!r) return { enabled: false, time: '08:30', feishu: false, botId: null, routineId: null };
  const [m, h] = String(r.schedule).split(' ');
  return {
    enabled: r.enabled,
    time: `${String(h).padStart(2, '0')}:${String(m).padStart(2, '0')}`,
    feishu: Boolean(r.pushFeishu),
    botId: r.botId,
    routineId: r.id,
    lastRun: r.lastRun,
    lastStatus: r.lastStatus,
    nextRun: r.nextRun,
  };
}

route('GET', /^\/api\/briefing$/, async (_req, _res, { state }) => briefingView(state));

route('PUT', /^\/api\/briefing$/, async (_req, _res, { body, state }) => {
  const time = String(body?.time || '08:30');
  const m = /^([01]?\d|2[0-3]):([0-5]\d)$/.exec(time);
  if (!m) throw httpError(400, 'BRIEFING_BAD_TIME', 'time is HH:MM, e.g. 08:30');
  const bots = await listBots();
  const botId = bots.some((b) => b.id === body?.botId) ? body.botId : (bots.find((b) => b.primary)?.id || 'chief');
  const fields = {
    name: '每日简报',
    instruction: briefingInstruction(),
    schedule: `${Number(m[2])} ${Number(m[1])} * * *`,
    botId,
    enabled: Boolean(body?.enabled),
    pushFeishu: Boolean(body?.feishu),
  };
  const existing = state.routines.list().find((x) => x.preset === 'briefing');
  if (existing) await state.routines.update(existing.id, fields);
  else await state.routines.create({ ...fields, preset: 'briefing' });
  return briefingView(state);
});

route('GET', /^\/api\/briefing\/data$/, async (_req, _res, { query, state }) => state.collectBriefing(Number(query.get('hours')) || 24));

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

/**
 * A phone on Tailscale away from home goes through a DERP relay, where every
 * byte and every round trip shows. gzip and an ETag turn the 500 KB shell into
 * ~90 KB, and a reload into a 304 with no body at all.
 */
function acceptsGzip(req) {
  return /\bgzip\b/i.test(String(req?.headers?.['accept-encoding'] || ''));
}

function jsonResponse(res, status, payload) {
  const body = Buffer.from(JSON.stringify(payload), 'utf8');
  const gzip = body.length > 1024 && acceptsGzip(res.req);
  const out = gzip ? zlib.gzipSync(body) : body;
  const headers = withSecurityHeaders(res.req, {
    'content-type': 'application/json; charset=utf-8',
    'content-length': out.length,
    'cache-control': 'no-store',
    vary: 'accept-encoding',
  });
  if (gzip) headers['content-encoding'] = 'gzip';
  res.writeHead(status, headers);
  res.end(out);
}

/** HSTS only over TLS: sending it on plain HTTP would break later http visits. */
function withSecurityHeaders(req, headers) {
  if (isSecureRequest(req)) headers['strict-transport-security'] = 'max-age=15552000; includeSubDomains';
  return headers;
}

function errorResponse(res, status, code, message) {
  if (res.headersSent) {
    res.end();
    return;
  }
  jsonResponse(res, status, { error: { code, message } });
}

/**
 * A folder the human may make the workspace: a full path, not a drive root
 * or the whole system, not Windows' or the OS's own folders, not Nightshift's
 * data folder. -> {ok, path} | {ok:false, error}
 */
export function checkWorkspacePath(raw, { dataDir, platform = process.platform } = {}) {
  const text = String(raw || '').trim().replace(/^"(.*)"$/, '$1');
  const win = platform === 'win32';
  const abs = win ? /^[a-zA-Z]:[\\/]/.test(text) : text.startsWith('/');
  if (!abs) return { ok: false, error: win ? '要填完整路径，比如 D:\\Lamplit 工作区' : '要填完整路径，比如 /home/me/workspace' };
  const p = win ? path.win32.resolve(text) : path.posix.resolve(text);
  const norm = (s) => (win ? s.replace(/\//g, '\\').replace(/\\+$/, '').toLowerCase() : s.replace(/\/+$/, ''));
  const n = norm(p);
  if (win ? /^[a-z]:$/.test(n) : n === '') return { ok: false, error: '不能把整个磁盘当工作区，选磁盘里的一个文件夹' };
  const system = win
    ? ['c:\\windows', 'c:\\program files', 'c:\\program files (x86)', 'c:\\programdata']
    : ['/bin', '/boot', '/dev', '/etc', '/lib', '/lib64', '/proc', '/root', '/sbin', '/sys', '/usr', '/var'];
  if (system.some((s) => n === s || n.startsWith(`${s}${win ? '\\' : '/'}`))) return { ok: false, error: '不能放在系统文件夹里' };
  if (dataDir) {
    const d = norm(win ? path.win32.resolve(dataDir) : path.posix.resolve(dataDir));
    if (n === d || n.startsWith(`${d}${win ? '\\' : '/'}`) || d.startsWith(`${n}${win ? '\\' : '/'}`)) return { ok: false, error: '不能和 Lamplit 自己的数据文件夹放在一起' };
  }
  return { ok: true, path: p };
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

  const ext = path.extname(target).toLowerCase();
  const type = MIME[ext] || 'application/octet-stream';
  const stamp = await fsp.stat(target).then((s) => `${s.size.toString(16)}-${Math.floor(s.mtimeMs).toString(16)}`).catch(() => '');
  const etag = stamp ? `W/"${stamp}"` : '';

  // Revalidation is the cheap path over a relayed phone link: no body at all.
  if (etag && String(req.headers['if-none-match'] || '') === etag) {
    res.writeHead(304, { etag, 'cache-control': 'no-cache' });
    return res.end();
  }

  const compressible = COMPRESSIBLE_TYPES.has(ext) && data.length > 1024 && acceptsGzip(req);
  let payload = data;
  if (compressible) {
    const cached = gzipCache.get(target);
    if (cached && cached.stamp === stamp) {
      payload = cached.buffer;
    } else {
      payload = zlib.gzipSync(data);
      gzipCache.set(target, { stamp, buffer: payload });
      if (gzipCache.size > 40) gzipCache.delete(gzipCache.keys().next().value);
    }
  }

  const headers = withSecurityHeaders(req, {
    'content-type': type,
    'content-length': payload.length,
    'cache-control': 'no-cache',
    vary: 'accept-encoding',
  });
  if (SHELL_PAGES.has(relative)) Object.assign(headers, SHELL_PAGE_HEADERS);
  if (etag) headers.etag = etag;
  if (compressible) headers['content-encoding'] = 'gzip';
  res.writeHead(200, headers);
  if (req.method === 'HEAD') return res.end();
  return res.end(payload);
}

/**
 * The app page itself (SEC-13): no other site may frame it (click-jacking),
 * and the page may only run its own scripts. Inline scripts stay allowed
 * until the page is split into files. Pictures, sounds, other machines'
 * desktops and the reachability probe may come from any http(s) address.
 * Bot-made pages and the desktop viewer keep their own rules: other machines
 * show them in a frame.
 */
const SHELL_PAGES = new Set(['index.html', 'offline.html']);
const SHELL_PAGE_HEADERS = {
  'x-frame-options': 'SAMEORIGIN',
  'cross-origin-opener-policy': 'same-origin',
  'content-security-policy': [
    "default-src 'self'",
    "script-src 'self' 'unsafe-inline'",
    "style-src 'self' 'unsafe-inline'",
    "img-src 'self' data: blob: http: https:",
    "media-src 'self' data: blob: http: https:",
    "font-src 'self' data:",
    "connect-src 'self' data: blob: http: https: ws: wss:",
    "frame-src 'self' blob: http: https:",
    "worker-src 'self' blob:",
    "manifest-src 'self'",
    "object-src 'none'",
    "base-uri 'self'",
    "form-action 'self'",
    "frame-ancestors 'self'",
  ].join('; '),
};

/** One cached gzip buffer per static file, keyed by size+mtime. */
const gzipCache = new Map();
const COMPRESSIBLE_TYPES = new Set(['.html', '.css', '.js', '.mjs', '.json', '.svg', '.txt', '.md']);

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
    voice: bot.voice || '',
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
    onlyChanges: Boolean(routine.onlyChanges),
    pushFeishu: Boolean(routine.pushFeishu),
    preset: routine.preset || null,
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
    case 'plan':
      return { ...base, role: 'plan', planId: record.planId, text: record.text || '' };
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

  const { server, state, makePublicServer } = await createAssistant({ port, host });

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

  // Tunnel-only socket. It stays on 127.0.0.1 and every request on it is
  // flagged non-local, so the tunnel can never inherit "the human's computer".
  const publicStart = Math.min(Math.max(Number(process.env.ASSIST_PUBLIC_PORT) || 4391, 1), 65531);
  let publicPort = null;
  for (let attempt = 0; attempt <= 10 && publicPort == null; attempt += 1) {
    const candidate = publicStart + attempt;
    try {
      const publicServer = makePublicServer();
      await new Promise((resolve, reject) => {
        publicServer.once('error', reject);
        publicServer.listen(candidate, '127.0.0.1', () => {
          publicServer.removeListener('error', reject);
          resolve();
        });
      });
      publicPort = candidate;
      state.publicServer = publicServer;
    } catch (err) {
      if (err.code !== 'EADDRINUSE') {
        console.error('[assistant] public port failed:', err.message);
        break;
      }
    }
  }
  state.publicPort = publicPort;
  if (publicPort) {
    writeJsonSyncAtomic(path.join(P.dataDir, 'public-port.json'), { port: publicPort, updatedAt: nowIso() });
    console.error(`[assistant] public port: http://127.0.0.1:${publicPort} (tunnel only; never local-trusted)`);
  }
  // A funnel the human left on comes back after a restart; failure is logged,
  // never fatal (the tunnel is optional).
  if (publicPort) {
    restoreFunnel(publicPort)
      .then((view) => {
        if (view?.enabled && view.address) console.error(`[assistant] funnel: ${view.address}`);
      })
      .catch((err) => console.error('[assistant] funnel restore failed:', err.message));
  }

  // Machine-readable readiness line (parsed by the smoke test); human logs go
  // to stderr so stdout stays clean.
  console.log(
    JSON.stringify({
      event: 'ready',
      port: actualPort,
      publicPort,
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
      state.mcp?.stopAll();
    } catch (err) {
      console.error('[assistant] shutdown cleanup failed:', err.message);
    }
    server.close(() => {
      console.error('[assistant] closed');
      process.exit(0);
    });
    try { state.publicServer?.close(); } catch { /* already gone */ }
    // SSE connections are long-lived by design: close them so server.close()
    // can actually finish instead of waiting for a browser tab to go away.
    if (typeof server.closeAllConnections === 'function') server.closeAllConnections();
    if (typeof state.publicServer?.closeAllConnections === 'function') state.publicServer.closeAllConnections();
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
