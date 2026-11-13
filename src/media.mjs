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
 *   openai       any OpenAI-compatible /images/generations (no video); Zhipu
 *                CogView and Google Imagen speak it too
 *   dashscope    Alibaba Bailian (Wanxiang, Qwen-Image), asynchronous:
 *                POST /services/aigc/text2image/image-synthesis or
 *                /services/aigc/video-generation/video-synthesis with
 *                X-DashScope-Async: enable -> output.task_id; GET /tasks/:id
 *   zhipu        Zhipu CogVideoX videos: POST /videos/generations -> id;
 *                GET /async-result/:id
 *   minimax      MiniMax: images POST /image_generation (data.image_urls);
 *                videos POST /video_generation -> task_id;
 *                GET /query/video_generation?task_id= -> file_id;
 *                GET /files/retrieve?file_id= -> file.download_url
 * Results are downloaded into the workspace, so they stay after the provider's
 * temporary URL expires and the chat can show them.
 */

import fsp from 'node:fs/promises';
import path from 'node:path';
import { P, readJson, writeJsonAtomic } from './store.mjs';

const MEDIA_FILE = path.join(P.dataDir, 'media.json');

export const IMAGE_SERVICES = [
  { id: 'siliconflow', label: '硅基流动（Kolors / Qwen-Image / FLUX）', kind: 'siliconflow', baseUrl: 'https://api.siliconflow.cn/v1', model: 'Kwai-Kolors/Kolors', models: ['Kwai-Kolors/Kolors', 'Qwen/Qwen-Image', 'black-forest-labs/FLUX.1-dev', 'black-forest-labs/FLUX.1-schnell'], keyUrl: 'https://cloud.siliconflow.cn/account/ak' },
  { id: 'ark', label: '火山方舟 豆包 Seedream', kind: 'ark', baseUrl: 'https://ark.cn-beijing.volces.com/api/v3', model: 'doubao-seedream-4-0-250828', models: ['doubao-seedream-4-5-251128', 'doubao-seedream-4-0-250828', 'doubao-seedream-3-0-t2i-250415'], keyUrl: 'https://console.volcengine.com/ark/region:ark+cn-beijing/apiKey' },
  { id: 'dashscope', label: '阿里云百炼（通义万相 / Qwen-Image）', kind: 'dashscope', baseUrl: 'https://dashscope.aliyuncs.com/api/v1', model: 'wan2.5-t2i-preview', models: ['wan2.5-t2i-preview', 'wan2.2-t2i-plus', 'wan2.2-t2i-flash', 'qwen-image-plus', 'qwen-image'], keyUrl: 'https://bailian.console.aliyun.com/?apiKey=1' },
  { id: 'zhipu', label: '智谱 CogView（cogview-3-flash 免费）', kind: 'openai', baseUrl: 'https://open.bigmodel.cn/api/paas/v4', model: 'cogview-4-250304', models: ['cogview-4-250304', 'cogview-3-flash'], keyUrl: 'https://open.bigmodel.cn/usercenter/apikeys' },
  { id: 'minimax', label: 'MiniMax 海螺 image-01', kind: 'minimax', baseUrl: 'https://api.minimaxi.com/v1', model: 'image-01', models: ['image-01'], keyUrl: 'https://platform.minimaxi.com/user-center/basic-information/interface-key' },
  { id: 'openai', label: 'OpenAI（gpt-image-1 等）', kind: 'openai', baseUrl: 'https://api.openai.com/v1', model: 'gpt-image-1', models: ['gpt-image-1', 'gpt-image-1-mini', 'dall-e-3'], keyUrl: 'https://platform.openai.com/api-keys' },
  { id: 'google', label: 'Google Imagen（Gemini API）', kind: 'openai', noSize: true, baseUrl: 'https://generativelanguage.googleapis.com/v1beta/openai', model: 'imagen-4.0-generate-001', models: ['imagen-4.0-generate-001', 'imagen-4.0-fast-generate-001', 'imagen-4.0-ultra-generate-001'], keyUrl: 'https://aistudio.google.com/apikey' },
  { id: 'custom', label: '自定义（OpenAI 兼容）', kind: 'openai', baseUrl: '', model: '', models: [], keyUrl: '' },
];
export const VIDEO_SERVICES = [
  { id: 'siliconflow', label: '硅基流动（通义万相 Wan2.2）', kind: 'siliconflow', baseUrl: 'https://api.siliconflow.cn/v1', model: 'Wan-AI/Wan2.2-T2V-A14B', imageModel: 'Wan-AI/Wan2.2-I2V-A14B', models: ['Wan-AI/Wan2.2-T2V-A14B', 'Wan-AI/Wan2.2-I2V-A14B'], keyUrl: 'https://cloud.siliconflow.cn/account/ak' },
  { id: 'ark', label: '火山方舟 豆包 Seedance', kind: 'ark', baseUrl: 'https://ark.cn-beijing.volces.com/api/v3', model: 'doubao-seedance-1-0-pro-250528', models: ['doubao-seedance-1-5-pro-251215', 'doubao-seedance-1-0-pro-250528', 'doubao-seedance-1-0-pro-fast-251015', 'doubao-seedance-1-0-lite-t2v-250428', 'doubao-seedance-1-0-lite-i2v-250428'], keyUrl: 'https://console.volcengine.com/ark/region:ark+cn-beijing/apiKey' },
  { id: 'dashscope', label: '阿里云百炼（通义万相 Wan）', kind: 'dashscope', baseUrl: 'https://dashscope.aliyuncs.com/api/v1', model: 'wan2.5-t2v-preview', imageModel: 'wan2.5-i2v-preview', models: ['wan2.5-t2v-preview', 'wan2.2-t2v-plus', 'wan2.5-i2v-preview', 'wan2.2-i2v-flash', 'wan2.2-i2v-plus'], keyUrl: 'https://bailian.console.aliyun.com/?apiKey=1' },
  { id: 'minimax', label: 'MiniMax 海螺 Hailuo', kind: 'minimax', baseUrl: 'https://api.minimaxi.com/v1', model: 'MiniMax-Hailuo-02', models: ['MiniMax-Hailuo-2.3', 'MiniMax-Hailuo-02', 'T2V-01-Director', 'I2V-01'], keyUrl: 'https://platform.minimaxi.com/user-center/basic-information/interface-key' },
  { id: 'zhipu', label: '智谱 CogVideoX（cogvideox-flash 免费）', kind: 'zhipu', baseUrl: 'https://open.bigmodel.cn/api/paas/v4', model: 'cogvideox-3', models: ['cogvideox-3', 'cogvideox-flash'], keyUrl: 'https://open.bigmodel.cn/usercenter/apikeys' },
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
    const baseUrl = own.baseUrl || preset.baseUrl;
    const model = own.model || preset.model;
    // "Custom" has no address or model of its own: nothing to call until both are filled in.
    if (!baseUrl || !model) return null;
    // A first-frame model is used for a picture only when the human kept the
    // service's default text model (a model they picked is used as it is).
    const imageModel = own.model && own.model !== preset.model ? (/i2v|I2V/.test(own.model) ? own.model : undefined) : preset.imageModel;
    return { source: 'own', kind: preset.kind, service: preset.id, baseUrl, model, imageModel, noSize: preset.noSize, apiKey: own.apiKey };
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

async function callJson(url, { method = 'POST', apiKey, body, headers = {}, timeoutMs = 120000, fetchImpl = fetch } = {}) {
  let res;
  try {
    res = await fetchImpl(url, {
      method,
      headers: { authorization: `Bearer ${apiKey}`, ...(body ? { 'content-type': 'application/json' } : {}), ...headers },
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
  // MiniMax answers 200 with its own status: 0 is fine, 1004 / 2049 a bad key.
  const br = json?.base_resp;
  if (br && Number(br.status_code) !== 0) {
    const badKey = [1004, 2049].includes(Number(br.status_code));
    throw mediaError(badKey ? 401 : 502, badKey ? 'MEDIA_BAD_KEY' : 'MEDIA_FAILED', `生成服务返回 ${br.status_code}：${br.status_msg || '失败'}`);
  }
  // Bailian puts a refusal in code / message with a 200 now and then.
  if (json?.code && json?.output === undefined && json?.request_id && /^(InvalidApiKey|InvalidParameter|DataInspectionFailed|Throttling|AccessDenied)/.test(String(json.code))) {
    const badKey = /InvalidApiKey|AccessDenied/.test(String(json.code));
    throw mediaError(badKey ? 401 : 502, badKey ? 'MEDIA_BAD_KEY' : 'MEDIA_FAILED', `生成服务返回 ${json.code}：${json.message || ''}`);
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

const dims = (sz) => sz.split('x').map(Number);
/** "1280x720" -> "16:9" (the nearest ratio MiniMax takes). */
export function aspectOf(sz) {
  const [w, h] = dims(sz);
  const ratios = ['1:1', '16:9', '4:3', '3:2', '2:3', '3:4', '9:16', '21:9'];
  const r = w / h;
  return ratios.reduce((best, x) => {
    const [a, b] = x.split(':').map(Number);
    return Math.abs(a / b - r) < Math.abs(best.v - r) ? { x, v: a / b } : best;
  }, { x: '1:1', v: 1 }).x;
}

/**
 * The size a model behind an OpenAI-shaped endpoint accepts:
 *   gpt-image-*  1024x1024, 1536x1024, 1024x1536
 *   dall-e-3     1024x1024, 1792x1024, 1024x1792
 *   Seedream 4.5 at least 2560x1440 worth of pixels: scaled up, same shape
 *   others       as asked
 */
export function openAiSize(model, sz) {
  const [w, h] = dims(sz);
  const shape = w > h ? 'wide' : w < h ? 'tall' : 'square';
  if (/^gpt-image/i.test(model)) return { wide: '1536x1024', tall: '1024x1536', square: '1024x1024' }[shape];
  if (/^dall-e-3/i.test(model)) return { wide: '1792x1024', tall: '1024x1792', square: '1024x1024' }[shape];
  if (/seedream-4-5/i.test(model)) {
    const f = Math.sqrt((2560 * 1440) / (w * h));
    if (f > 1) return `${Math.ceil((w * f) / 16) * 16}x${Math.ceil((h * f) / 16) * 16}`;
  }
  return sz;
}

/** Bailian sizes ("W*H"); Qwen-Image takes only its five. */
function dashscopeSize(model, sz) {
  const [w, h] = dims(sz);
  if (/^qwen-image/i.test(model)) {
    const r = w / h;
    return r > 1.6 ? '1664*928' : r > 1.1 ? '1472*1140' : r < 0.625 ? '928*1664' : r < 0.9 ? '1140*1472' : '1328*1328';
  }
  return `${w}*${h}`;
}

const DASH_ASYNC = { 'X-DashScope-Async': 'enable' };

/** Wait for a Bailian task. -> its output; throws when it failed or took too long */
async function dashscopeWait(base, taskId, apiKey, { fetchImpl, pollMs = 3000, maxWaitMs = 5 * 60 * 1000 }) {
  const started = Date.now();
  for (;;) {
    await sleep(pollMs);
    const s = await callJson(`${base}/tasks/${encodeURIComponent(taskId)}`, { method: 'GET', apiKey, fetchImpl });
    const st = String(s.output?.task_status || '').toUpperCase();
    if (st === 'SUCCEEDED') return s.output;
    if (st === 'FAILED' || st === 'CANCELED' || st === 'UNKNOWN') throw mediaError(502, 'MEDIA_FAILED', `生成失败：${s.output?.message || s.output?.code || st}`);
    if (Date.now() - started > maxWaitMs) throw mediaError(504, 'MEDIA_TIMEOUT', '图片 5 分钟还没生成好');
  }
}

async function dashscopeImages(service, { text, sz, n, negativePrompt, fetchImpl, pollMs }) {
  const base = trimUrl(service.baseUrl);
  const body = { model: service.model, input: { prompt: text.slice(0, 2000) }, parameters: { size: dashscopeSize(service.model, sz), n } };
  if (negativePrompt) body.input.negative_prompt = String(negativePrompt).slice(0, 500);
  const out = await callJson(`${base}/services/aigc/text2image/image-synthesis`, { apiKey: service.apiKey, body, headers: DASH_ASYNC, fetchImpl });
  const id = out.output?.task_id;
  if (!id) throw mediaError(502, 'MEDIA_FAILED', '生成服务没有返回任务编号');
  const done = await dashscopeWait(base, id, service.apiKey, { fetchImpl, pollMs: service.pollMs ?? pollMs });
  return (done.results || []).map((r) => ({ url: r.url }));
}

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
  } else if (service.kind === 'dashscope') {
    items = await dashscopeImages(service, { text, sz, n, negativePrompt, fetchImpl });
  } else if (service.kind === 'minimax') {
    const body = { model: service.model, prompt: text.slice(0, 1500), aspect_ratio: aspectOf(sz), response_format: 'url', n };
    const out = await callJson(`${trimUrl(service.baseUrl)}/image_generation`, { apiKey: service.apiKey, body, fetchImpl });
    items = (out.data?.image_urls || []).map((u) => ({ url: u }));
  } else {
    // OpenAI shape (OpenAI, Ark Seedream, Zhipu CogView, Google Imagen). One
    // call per image keeps old models happy.
    for (let i = 0; i < n; i += 1) {
      const body = { model: service.model, prompt: text.slice(0, 4000), n: 1 };
      if (!service.noSize) body.size = openAiSize(service.model, sz);
      if (service.kind === 'ark') body.response_format = 'url';
      if (service.noSize) body.response_format = 'b64_json';
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
 * Start a video. -> {kind, baseUrl, model, taskId}; keep it to check later.
 * imageDataUrl: optional first frame (image-to-video) as a data: URL.
 */
export async function submitVideo(service, { prompt, size = '1280x720', imageDataUrl = '' } = {}, { fetchImpl = fetch } = {}) {
  if (!service) throw mediaError(409, 'VIDEO_NOT_CONFIGURED', '还没有配置生视频：在「设置 → 模型 → 生视频」里选一个服务并填密钥（硅基流动的密钥就能用）');
  const text = String(prompt || '').trim();
  if (!text) throw mediaError(400, 'EMPTY_PROMPT', '要生成什么视频？prompt 是空的');
  const base = trimUrl(service.baseUrl);
  if (service.kind === 'siliconflow') {
    const model = imageDataUrl && service.imageModel ? service.imageModel : service.model;
    const body = { model, prompt: text.slice(0, 2000), image_size: /^(1280x720|720x1280|960x960)$/.test(size) ? size : '1280x720' };
    if (imageDataUrl) body.image = imageDataUrl;
    const out = await callJson(`${base}/video/submit`, { apiKey: service.apiKey, body, fetchImpl });
    const id = out.requestId || out.request_id;
    if (!id) throw mediaError(502, 'MEDIA_FAILED', '生成服务没有返回任务编号');
    return { kind: 'siliconflow', baseUrl: base, model, taskId: String(id) };
  }
  if (service.kind === 'ark') {
    const content = [{ type: 'text', text: text.slice(0, 2000) }];
    if (imageDataUrl) content.push({ type: 'image_url', image_url: { url: imageDataUrl } });
    const out = await callJson(`${base}/contents/generations/tasks`, { apiKey: service.apiKey, body: { model: service.model, content }, fetchImpl });
    if (!out.id) throw mediaError(502, 'MEDIA_FAILED', '生成服务没有返回任务编号');
    return { kind: 'ark', baseUrl: base, model: service.model, taskId: String(out.id) };
  }
  const model = imageDataUrl && service.imageModel ? service.imageModel : service.model;
  if (service.kind === 'dashscope') {
    const [w, h] = dims(/^\d+x\d+$/.test(size) ? size : '1280x720');
    const body = imageDataUrl
      ? { model, input: { prompt: text.slice(0, 1500), img_url: imageDataUrl }, parameters: { resolution: '720P' } }
      : { model, input: { prompt: text.slice(0, 1500) }, parameters: { size: `${w}*${h}` } };
    const out = await callJson(`${base}/services/aigc/video-generation/video-synthesis`, { apiKey: service.apiKey, body, headers: DASH_ASYNC, fetchImpl });
    const id = out.output?.task_id;
    if (!id) throw mediaError(502, 'MEDIA_FAILED', '生成服务没有返回任务编号');
    return { kind: 'dashscope', baseUrl: base, model, taskId: String(id) };
  }
  if (service.kind === 'minimax') {
    const body = { model, prompt: text.slice(0, 2000) };
    if (imageDataUrl) body.first_frame_image = imageDataUrl;
    const out = await callJson(`${base}/video_generation`, { apiKey: service.apiKey, body, fetchImpl });
    if (!out.task_id) throw mediaError(502, 'MEDIA_FAILED', '生成服务没有返回任务编号');
    return { kind: 'minimax', baseUrl: base, model, taskId: String(out.task_id) };
  }
  if (service.kind === 'zhipu') {
    const body = { model, prompt: text.slice(0, 1500) };
    if (imageDataUrl) body.image_url = imageDataUrl;
    const out = await callJson(`${base}/videos/generations`, { apiKey: service.apiKey, body, fetchImpl });
    if (!out.id) throw mediaError(502, 'MEDIA_FAILED', '生成服务没有返回任务编号');
    return { kind: 'zhipu', baseUrl: base, model, taskId: String(out.id) };
  }
  throw mediaError(400, 'VIDEO_UNSUPPORTED', '这个服务不支持生成视频');
}

/** Ask once how a submitted video is doing. -> {done, url?, status} ; throws when it failed */
export async function checkVideo(task, apiKey, { fetchImpl = fetch } = {}) {
  if (task.kind === 'siliconflow') {
    const s = await callJson(`${task.baseUrl}/video/status`, { apiKey, body: { requestId: task.taskId }, fetchImpl });
    const st = String(s.status || '').toLowerCase();
    if (st === 'succeed' || st === 'succeeded') return { done: true, url: s.results?.videos?.[0]?.url, status: st };
    if (st === 'failed') throw mediaError(502, 'MEDIA_FAILED', `生成失败：${s.reason || '未知原因'}`);
    return { done: false, status: st };
  }
  if (task.kind === 'dashscope') {
    const s = await callJson(`${task.baseUrl}/tasks/${encodeURIComponent(task.taskId)}`, { method: 'GET', apiKey, fetchImpl });
    const st = String(s.output?.task_status || '').toLowerCase();
    if (st === 'succeeded') return { done: true, url: s.output?.video_url, status: st };
    if (st === 'failed' || st === 'canceled' || st === 'unknown') throw mediaError(502, 'MEDIA_FAILED', `生成失败：${s.output?.message || s.output?.code || st}`);
    return { done: false, status: st };
  }
  if (task.kind === 'minimax') {
    const s = await callJson(`${task.baseUrl}/query/video_generation?task_id=${encodeURIComponent(task.taskId)}`, { method: 'GET', apiKey, fetchImpl });
    const st = String(s.status || '').toLowerCase();
    if (st === 'fail') throw mediaError(502, 'MEDIA_FAILED', '生成失败');
    if (st !== 'success') return { done: false, status: st };
    // Done: the video is a file to look up for its download address.
    const f = await callJson(`${task.baseUrl}/files/retrieve?file_id=${encodeURIComponent(s.file_id)}`, { method: 'GET', apiKey, fetchImpl });
    return { done: true, url: f.file?.download_url, status: st };
  }
  if (task.kind === 'zhipu') {
    const s = await callJson(`${task.baseUrl}/async-result/${encodeURIComponent(task.taskId)}`, { method: 'GET', apiKey, fetchImpl });
    const st = String(s.task_status || '').toLowerCase();
    if (st === 'success') return { done: true, url: s.video_result?.[0]?.url, status: st };
    if (st === 'fail') throw mediaError(502, 'MEDIA_FAILED', '生成失败');
    return { done: false, status: st };
  }
  const s = await callJson(`${task.baseUrl}/contents/generations/tasks/${encodeURIComponent(task.taskId)}`, { method: 'GET', apiKey, fetchImpl });
  const st = String(s.status || '').toLowerCase();
  if (st === 'succeeded') return { done: true, url: s.content?.video_url, status: st };
  if (st === 'failed' || st === 'cancelled') throw mediaError(502, 'MEDIA_FAILED', `生成失败：${s.error?.message || st}`);
  return { done: false, status: st };
}

/** Download a finished video into the workspace. -> workspace-relative path */
export async function saveVideo(url, { workspaceDir, fetchImpl = fetch } = {}) {
  if (!url) throw mediaError(502, 'MEDIA_EMPTY', '生成服务没有返回视频地址');
  return (await saveResult({ url }, { workspaceDir, folder: 'video', ext: '.mp4', fetchImpl })).path;
}

/** Submit and wait (tests, and anything that can afford to block). -> {path, model, latencyMs} */
export async function generateVideo(service, opts = {}, { workspaceDir, fetchImpl = fetch, signal, pollMs = 5000, maxWaitMs = 15 * 60 * 1000, onProgress } = {}) {
  const started = Date.now();
  const task = await submitVideo(service, opts, { fetchImpl });
  const check = () => checkVideo(task, service.apiKey, { fetchImpl });
  for (;;) {
    if (signal?.aborted) throw mediaError(499, 'CANCELLED', '已取消');
    if (Date.now() - started > maxWaitMs) throw mediaError(504, 'MEDIA_TIMEOUT', `视频 ${Math.round(maxWaitMs / 60000)} 分钟还没生成好`);
    await sleep(pollMs);
    const r = await check();
    if (r.done) {
      if (onProgress) onProgress('done', Date.now() - started);
      const saved = await saveVideo(r.url, { workspaceDir, fetchImpl });
      return { path: saved, model: task.model, latencyMs: Date.now() - started };
    }
    if (onProgress) onProgress(r.status, Date.now() - started);
  }
}
