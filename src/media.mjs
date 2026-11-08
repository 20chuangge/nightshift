/**
 * media.mjs - make pictures and videos (image_generate, video_generate).
 *
 * Settings live in data/media.json: {image:{service, baseUrl, model, apiKey},
 * video:{...}}; keys are write-only (publicMedia reports hasKey only). With no
 * key of its own, a SiliconFlow voice key is used, the same way image_view
 * borrows it, so one SiliconFlow key covers voice, vision and generation.
 *
 * Three kinds of service:
 *   siliconflow  images: POST /images/generations {model, prompt, image_size}
 *                videos: POST /video/submit -> requestId; POST /video/status
 *   ark          Volcano Engine Ark (Doubao Seedream / Seedance):
 *                images: POST /images/generations (OpenAI shape)
 *                videos: POST /contents/generations/tasks; GET .../tasks/:id
 *   openai       any OpenAI-compatible /images/generations (no video)
 * Results are downloaded into the workspace, so they stay after the provider's
 * temporary URL expires and the chat can show them.
 */

import fsp from 'node:fs/promises';
import path from 'node:path';
import { P, readJson, writeJsonAtomic } from './store.mjs';

const MEDIA_FILE = path.join(P.dataDir, 'media.json');

export const IMAGE_SERVICES = [
  { id: 'siliconflow', label: '硅基流动（Kolors / FLUX / Qwen-Image）', kind: 'siliconflow', baseUrl: 'https://api.siliconflow.cn/v1', model: 'Kwai-Kolors/Kolors', models: ['Kwai-Kolors/Kolors', 'Qwen/Qwen-Image', 'black-forest-labs/FLUX.1-schnell'], keyUrl: 'https://cloud.siliconflow.cn/account/ak' },
  { id: 'ark', label: '火山方舟 豆包 Seedream', kind: 'ark', baseUrl: 'https://ark.cn-beijing.volces.com/api/v3', model: 'doubao-seedream-4-0-250828', models: ['doubao-seedream-4-0-250828'], keyUrl: 'https://console.volcengine.com/ark/region:ark+cn-beijing/apiKey' },
  { id: 'openai', label: 'OpenAI 兼容（gpt-image-1 等）', kind: 'openai', baseUrl: 'https://api.openai.com/v1', model: 'gpt-image-1', models: ['gpt-image-1', 'dall-e-3'], keyUrl: 'https://platform.openai.com/api-keys' },
];
export const VIDEO_SERVICES = [
  { id: 'siliconflow', label: '硅基流动（通义万相 Wan2.2）', kind: 'siliconflow', baseUrl: 'https://api.siliconflow.cn/v1', model: 'Wan-AI/Wan2.2-T2V-A14B', imageModel: 'Wan-AI/Wan2.2-I2V-A14B', models: ['Wan-AI/Wan2.2-T2V-A14B', 'Wan-AI/Wan2.2-I2V-A14B'], keyUrl: 'https://cloud.siliconflow.cn/account/ak' },
  { id: 'ark', label: '火山方舟 豆包 Seedance', kind: 'ark', baseUrl: 'https://ark.cn-beijing.volces.com/api/v3', model: 'doubao-seedance-1-0-pro-250528', models: ['doubao-seedance-1-0-pro-250528', 'doubao-seedance-1-0-lite-t2v-250428'], keyUrl: 'https://console.volcengine.com/ark/region:ark+cn-beijing/apiKey' },
];

function mediaError(status, code, message) {
  const err = new Error(message);
  err.status = status;
  err.code = code;
  return err;
}

const trimUrl = (v) => String(v || '').trim().replace(/\/+$/, '');
const emptyOne = () => ({ service: '', baseUrl: '', model: '', apiKey: '' });

export async function loadMedia() {
  const raw = await readJson(MEDIA_FILE, null);
  const one = (r) => (r && typeof r === 'object'
    ? { service: String(r.service || ''), baseUrl: trimUrl(r.baseUrl), model: String(r.model || '').trim(), apiKey: String(r.apiKey || '').trim() }
    : emptyOne());
  return { image: one(raw?.image), video: one(raw?.video) };
}

/** Patch one kind ('image' | 'video') with {service?, baseUrl?, model?, apiKey?}; apiKey "" clears it. */
export async function saveMedia(current, kind, patch = {}) {
  if (kind !== 'image' && kind !== 'video') throw mediaError(400, 'BAD_KIND', 'kind must be image or video');
  const list = kind === 'image' ? IMAGE_SERVICES : VIDEO_SERVICES;
  const next = { ...current, [kind]: { ...current[kind] } };
  const one = next[kind];
  if (patch.service !== undefined) {
    if (patch.service && !list.some((s) => s.id === patch.service)) throw mediaError(400, 'BAD_SERVICE', `unknown ${kind} service`);
    one.service = String(patch.service || '');
  }
  if (patch.baseUrl !== undefined) {
    const url = trimUrl(patch.baseUrl);
    if (url && !/^https?:\/\//i.test(url)) throw mediaError(400, 'INVALID_BASE_URL', 'baseUrl must start with http:// or https://');
    one.baseUrl = url;
  }
  if (patch.model !== undefined) one.model = String(patch.model || '').trim().slice(0, 200);
  if (patch.apiKey !== undefined) {
    if (typeof patch.apiKey !== 'string') throw mediaError(400, 'INVALID_API_KEY', 'apiKey must be a string');
    one.apiKey = patch.apiKey.trim();
  }
  await writeJsonAtomic(MEDIA_FILE, { ...next, updatedAt: new Date().toISOString() });
  try { await fsp.chmod(MEDIA_FILE, 0o600); } catch { /* Windows */ }
  return next;
}

/** The service a tool will use for 'image' | 'video', or null. */
export function resolveMedia(media, kind, { voice } = {}) {
  const list = kind === 'image' ? IMAGE_SERVICES : VIDEO_SERVICES;
  const own = media?.[kind] || emptyOne();
  const preset = list.find((s) => s.id === own.service) || list[0];
  if (own.apiKey) {
    return { source: 'own', kind: preset.kind, service: preset.id, baseUrl: own.baseUrl || preset.baseUrl, model: own.model || preset.model, imageModel: preset.imageModel, apiKey: own.apiKey };
  }
  // A SiliconFlow voice key works for SiliconFlow generation too.
  const voiceBase = trimUrl(voice?.baseUrl || 'https://api.siliconflow.cn/v1');
  if (voice?.apiKey && /siliconflow\.cn/.test(voiceBase) && preset.kind === 'siliconflow') {
    return { source: 'voice', kind: 'siliconflow', service: preset.id, baseUrl: voiceBase, model: own.model || preset.model, imageModel: preset.imageModel, apiKey: voice.apiKey };
  }
  return null;
}

export function publicMedia(media, ctx) {
  const view = (kind) => {
    const active = resolveMedia(media, kind, ctx);
    const own = media?.[kind] || emptyOne();
    return {
      available: Boolean(active),
      source: active?.source || null,
      service: own.service || (kind === 'image' ? IMAGE_SERVICES : VIDEO_SERVICES)[0].id,
      baseUrl: active?.baseUrl || own.baseUrl || '',
      model: active?.model || own.model || '',
      hasKey: Boolean(own.apiKey),
      services: kind === 'image' ? IMAGE_SERVICES : VIDEO_SERVICES,
    };
  };
  return { image: view('image'), video: view('video') };
}

// ---------------------------------------------------------------------------
// HTTP helpers
// ---------------------------------------------------------------------------

async function callJson(url, { method = 'POST', apiKey, body, timeoutMs = 120000, fetchImpl = fetch } = {}) {
  let res;
  try {
    res = await fetchImpl(url, {
      method,
      headers: { authorization: `Bearer ${apiKey}`, ...(body ? { 'content-type': 'application/json' } : {}) },
      body: body ? JSON.stringify(body) : undefined,
      signal: AbortSignal.timeout(timeoutMs),
    });
  } catch (err) {
    throw mediaError(502, 'MEDIA_UNREACHABLE', `连不上生成服务：${err.message}`);
  }
  const text = await res.text();
  let json = null;
  try { json = JSON.parse(text); } catch { /* not JSON */ }
  if (!res.ok) {
    const msg = json?.error?.message || json?.message || text.slice(0, 300);
    throw mediaError(res.status === 401 || res.status === 403 ? 401 : 502, res.status === 401 || res.status === 403 ? 'MEDIA_BAD_KEY' : 'MEDIA_FAILED', `生成服务返回 ${res.status}：${msg}`);
  }
  return json || {};
}

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

/** Download a result (URL or base64) into the workspace. -> workspace-relative path */
async function saveResult({ url, b64 }, { workspaceDir, folder, ext, fetchImpl = fetch }) {
  let bytes;
  if (b64) {
    bytes = Buffer.from(b64, 'base64');
  } else {
    let res;
    try { res = await fetchImpl(url, { signal: AbortSignal.timeout(300000) }); } catch (err) { throw mediaError(502, 'MEDIA_DOWNLOAD', `下载生成结果失败：${err.message}`); }
    if (!res.ok) throw mediaError(502, 'MEDIA_DOWNLOAD', `下载生成结果失败：HTTP ${res.status}`);
    bytes = Buffer.from(await res.arrayBuffer());
    const type = res.headers.get('content-type') || '';
    if (/png/.test(type)) ext = '.png';
    else if (/jpe?g/.test(type)) ext = '.jpg';
    else if (/webp/.test(type)) ext = '.webp';
  }
  const day = new Date().toISOString().slice(0, 10);
  const dirRel = path.posix.join('generated', day);
  await fsp.mkdir(path.join(workspaceDir, dirRel), { recursive: true });
  const name = `${folder}-${Date.now().toString(36)}${Math.random().toString(36).slice(2, 6)}${ext}`;
  const rel = path.posix.join(dirRel, name);
  await fsp.writeFile(path.join(workspaceDir, rel), bytes);
  return { path: rel, bytes: bytes.length };
}

// ---------------------------------------------------------------------------
// images
// ---------------------------------------------------------------------------

const SIZES = new Set(['1024x1024', '960x1280', '768x1024', '720x1440', '720x1280', '1280x720', '1024x768', '1280x960', '1440x720']);

/** -> {paths:[...], model, latencyMs} */
export async function generateImages(service, { prompt, size = '1024x1024', count = 1, negativePrompt = '' } = {}, { workspaceDir, fetchImpl = fetch } = {}) {
  if (!service) throw mediaError(409, 'IMAGE_NOT_CONFIGURED', '还没有配置生图：在「设置 → 模型 → 生图」里选一个服务并填密钥（硅基流动的密钥就能用）');
  const text = String(prompt || '').trim();
  if (!text) throw mediaError(400, 'EMPTY_PROMPT', '要画什么？prompt 是空的');
  const n = Math.max(1, Math.min(4, Number(count) || 1));
  const sz = SIZES.has(size) ? size : '1024x1024';
  const started = Date.now();
  const url = `${trimUrl(service.baseUrl)}/images/generations`;
  let items = [];
  if (service.kind === 'siliconflow') {
    const body = { model: service.model, prompt: text.slice(0, 2000), image_size: sz, batch_size: n };
    if (negativePrompt) body.negative_prompt = String(negativePrompt).slice(0, 1000);
    const out = await callJson(url, { apiKey: service.apiKey, body, fetchImpl });
    items = (out.images || out.data || []).map((i) => ({ url: i.url, b64: i.b64_json }));
  } else {
    // OpenAI shape (OpenAI, Ark Seedream). One call per image keeps old models happy.
    for (let i = 0; i < n; i += 1) {
      const body = { model: service.model, prompt: text.slice(0, 4000), size: sz, n: 1 };
      if (service.kind === 'ark') body.response_format = 'url';
      const out = await callJson(url, { apiKey: service.apiKey, body, fetchImpl });
      items.push(...(out.data || []).map((d) => ({ url: d.url, b64: d.b64_json })));
    }
  }
  items = items.filter((i) => i.url || i.b64);
  if (!items.length) throw mediaError(502, 'MEDIA_EMPTY', '生成服务没有返回图片');
  const paths = [];
  for (const item of items) paths.push((await saveResult(item, { workspaceDir, folder: 'image', ext: '.png', fetchImpl })).path);
  return { paths, model: service.model, latencyMs: Date.now() - started };
}

// ---------------------------------------------------------------------------
// videos (asynchronous on every provider: submit, then poll)
// ---------------------------------------------------------------------------

/**
 * -> {path, model, latencyMs}
 * imageDataUrl: optional first frame (image-to-video) as a data: URL.
 */
export async function generateVideo(service, { prompt, size = '1280x720', imageDataUrl = '' } = {}, { workspaceDir, fetchImpl = fetch, signal, pollMs = 5000, maxWaitMs = 15 * 60 * 1000, onProgress } = {}) {
  if (!service) throw mediaError(409, 'VIDEO_NOT_CONFIGURED', '还没有配置生视频：在「设置 → 模型 → 生视频」里选一个服务并填密钥（硅基流动的密钥就能用）');
  const text = String(prompt || '').trim();
  if (!text) throw mediaError(400, 'EMPTY_PROMPT', '要生成什么视频？prompt 是空的');
  const started = Date.now();
  const base = trimUrl(service.baseUrl);
  let check;
  if (service.kind === 'siliconflow') {
    const model = imageDataUrl && service.imageModel ? service.imageModel : service.model;
    const body = { model, prompt: text.slice(0, 2000), image_size: /^(1280x720|720x1280|960x960)$/.test(size) ? size : '1280x720' };
    if (imageDataUrl) body.image = imageDataUrl;
    const out = await callJson(`${base}/video/submit`, { apiKey: service.apiKey, body, fetchImpl });
    const id = out.requestId || out.request_id;
    if (!id) throw mediaError(502, 'MEDIA_FAILED', '生成服务没有返回任务编号');
    check = async () => {
      const s = await callJson(`${base}/video/status`, { apiKey: service.apiKey, body: { requestId: id }, fetchImpl });
      const st = String(s.status || '').toLowerCase();
      if (st === 'succeed' || st === 'succeeded') return { done: true, url: s.results?.videos?.[0]?.url };
      if (st === 'failed') throw mediaError(502, 'MEDIA_FAILED', `生成失败：${s.reason || '未知原因'}`);
      return { done: false, status: st };
    };
  } else if (service.kind === 'ark') {
    const content = [{ type: 'text', text: text.slice(0, 2000) }];
    if (imageDataUrl) content.push({ type: 'image_url', image_url: { url: imageDataUrl } });
    const out = await callJson(`${base}/contents/generations/tasks`, { apiKey: service.apiKey, body: { model: service.model, content }, fetchImpl });
    if (!out.id) throw mediaError(502, 'MEDIA_FAILED', '生成服务没有返回任务编号');
    check = async () => {
      const s = await callJson(`${base}/contents/generations/tasks/${encodeURIComponent(out.id)}`, { method: 'GET', apiKey: service.apiKey, fetchImpl });
      const st = String(s.status || '').toLowerCase();
      if (st === 'succeeded') return { done: true, url: s.content?.video_url };
      if (st === 'failed' || st === 'cancelled') throw mediaError(502, 'MEDIA_FAILED', `生成失败：${s.error?.message || st}`);
      return { done: false, status: st };
    };
  } else {
    throw mediaError(400, 'VIDEO_UNSUPPORTED', '这个服务不支持生成视频');
  }
  for (;;) {
    if (signal?.aborted) throw mediaError(499, 'CANCELLED', '已取消');
    if (Date.now() - started > maxWaitMs) throw mediaError(504, 'MEDIA_TIMEOUT', `视频 ${Math.round(maxWaitMs / 60000)} 分钟还没生成好`);
    await sleep(pollMs);
    const r = await check();
    if (r.done) {
      if (!r.url) throw mediaError(502, 'MEDIA_EMPTY', '生成服务没有返回视频地址');
      const saved = await saveResult({ url: r.url }, { workspaceDir, folder: 'video', ext: '.mp4', fetchImpl });
      return { path: saved.path, model: service.model, latencyMs: Date.now() - started };
    }
    if (onProgress) onProgress(r.status);
  }
}
