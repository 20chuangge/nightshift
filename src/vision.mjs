/**
 * vision.mjs - let a text-only chat model (DeepSeek) see images.
 *
 * The bot calls the image_view tool with a workspace image (an attachment, a
 * screenshot it took) and a question; this module sends the picture to an
 * OpenAI-compatible vision model and returns what it sees as text.
 *
 * Which vision service, in order:
 *   1. its own settings  data/vision.json {baseUrl, model, apiKey}
 *   2. the voice service when that is SiliconFlow (same key, a VL model)
 *   3. the chat model's provider when it has a vision model (SiliconFlow,
 *      OpenAI, DashScope, Zhipu)
 * So someone who set up voice input with SiliconFlow gets vision for free.
 * The key is write-only: publicVision() reports hasKey only.
 */

import fsp from 'node:fs/promises';
import path from 'node:path';
import { P, readJson, writeJsonAtomic } from './store.mjs';

const VISION_FILE = path.join(P.dataDir, 'vision.json');

export const VISION_PROVIDERS = [
  { id: 'siliconflow', label: '硅基流动 Qwen3-VL（中文和小字识别好）', baseUrl: 'https://api.siliconflow.cn/v1', model: 'Qwen/Qwen3-VL-32B-Instruct', keyUrl: 'https://cloud.siliconflow.cn/account/ak' },
  { id: 'dashscope', label: '阿里云百炼 通义千问 VL', baseUrl: 'https://dashscope.aliyuncs.com/compatible-mode/v1', model: 'qwen-vl-max', keyUrl: 'https://bailian.console.aliyun.com/?apiKey=1' },
  { id: 'zhipu', label: '智谱 GLM-4V（有免费模型）', baseUrl: 'https://open.bigmodel.cn/api/paas/v4', model: 'glm-4v-flash', keyUrl: 'https://open.bigmodel.cn/usercenter/apikeys' },
  { id: 'openai', label: 'OpenAI GPT-4o mini', baseUrl: 'https://api.openai.com/v1', model: 'gpt-4o-mini', keyUrl: 'https://platform.openai.com/api-keys' },
  { id: 'custom', label: '自定义（OpenAI 兼容）', baseUrl: '', model: '', keyUrl: '' },
];
export const VISION_PRESET = VISION_PROVIDERS[0];

/** Chat providers whose key also opens a vision model. */
const FROM_CHAT_PROVIDER = {
  siliconflow: 'Qwen/Qwen3-VL-32B-Instruct',
  openai: 'gpt-4o-mini',
  qwen: 'qwen-vl-max',
  dashscope: 'qwen-vl-max',
  zhipu: 'glm-4v-flash',
};

export const IMAGE_MAX_BYTES = 12 * 1024 * 1024;
const MIME_BY_EXT = { '.png': 'image/png', '.jpg': 'image/jpeg', '.jpeg': 'image/jpeg', '.gif': 'image/gif', '.webp': 'image/webp', '.bmp': 'image/bmp' };

function visionError(status, code, message) {
  const err = new Error(message);
  err.status = status;
  err.code = code;
  return err;
}

const trimUrl = (v) => String(v || '').trim().replace(/\/+$/, '');

export async function loadVision() {
  const raw = await readJson(VISION_FILE, null);
  if (!raw || typeof raw !== 'object') return { baseUrl: '', model: '', apiKey: '' };
  return { baseUrl: trimUrl(raw.baseUrl), model: String(raw.model || '').trim(), apiKey: String(raw.apiKey || '').trim() };
}

/** Patch {baseUrl?, model?, apiKey?}; apiKey "" clears it. */
export async function saveVision(current, patch = {}) {
  const next = { ...current };
  if (patch.baseUrl !== undefined) {
    const url = trimUrl(patch.baseUrl);
    if (url && !/^https?:\/\//i.test(url)) throw visionError(400, 'INVALID_BASE_URL', 'baseUrl must start with http:// or https://');
    next.baseUrl = url;
  }
  if (patch.model !== undefined) next.model = String(patch.model || '').trim().slice(0, 200);
  if (patch.apiKey !== undefined) {
    if (typeof patch.apiKey !== 'string') throw visionError(400, 'INVALID_API_KEY', 'apiKey must be a string');
    next.apiKey = patch.apiKey.trim();
  }
  await writeJsonAtomic(VISION_FILE, { ...next, updatedAt: new Date().toISOString() });
  try { await fsp.chmod(VISION_FILE, 0o600); } catch { /* Windows */ }
  return next;
}

/**
 * The service image_view will use, or null.
 * @param {object} vision  own settings
 * @param {object} ctx     {settings, chatKey, voice} for the fallbacks
 */
export function resolveVision(vision, { settings, chatKey, voice } = {}) {
  if (vision?.apiKey) {
    return { source: 'own', baseUrl: vision.baseUrl || VISION_PRESET.baseUrl, model: vision.model || VISION_PRESET.model, apiKey: vision.apiKey };
  }
  const voiceBase = trimUrl(voice?.baseUrl || 'https://api.siliconflow.cn/v1');
  if (voice?.apiKey && /siliconflow\.cn/.test(voiceBase)) {
    return { source: 'voice', baseUrl: voiceBase, model: vision?.model || VISION_PRESET.model, apiKey: voice.apiKey };
  }
  const fromChat = FROM_CHAT_PROVIDER[settings?.provider];
  if (fromChat && chatKey) {
    return { source: 'model', baseUrl: trimUrl(settings.baseUrl), model: vision?.model || fromChat, apiKey: chatKey };
  }
  return null;
}

export function publicVision(vision, ctx) {
  const active = resolveVision(vision, ctx);
  return {
    available: Boolean(active),
    source: active?.source || null,
    baseUrl: active?.baseUrl || vision.baseUrl || '',
    model: active?.model || vision.model || '',
    hasKey: Boolean(vision.apiKey),
    preset: VISION_PRESET,
    providers: VISION_PROVIDERS,
  };
}

export function imageMime(file) {
  return MIME_BY_EXT[path.extname(String(file)).toLowerCase()] || null;
}

/** Ask the vision model about one image. -> {text, model, latencyMs} */
export async function describeImage(service, bytes, mime, question, { timeoutMs = 90000, fetchImpl = fetch } = {}) {
  if (!service) {
    throw visionError(409, 'VISION_NOT_CONFIGURED', '还没有配置看图模型：在「设置 → 模型 → 看图」里选一个服务并填密钥（硅基流动的密钥就能用）');
  }
  if (!bytes?.length) throw visionError(400, 'EMPTY_IMAGE', '图片是空的');
  if (bytes.length > IMAGE_MAX_BYTES) throw visionError(400, 'IMAGE_TOO_LARGE', '图片超过 12 MB，先缩小再看');
  const prompt = String(question || '').trim()
    || '详细描述这张图片：画面里有什么；把能看到的文字（包括小字）尽量原样写出来；如果是界面或网页截图，说明是什么页面、有哪些按钮和信息。用中文回答。';
  const started = Date.now();
  let res;
  try {
    res = await fetchImpl(`${service.baseUrl}/chat/completions`, {
      method: 'POST',
      headers: { authorization: `Bearer ${service.apiKey}`, 'content-type': 'application/json' },
      body: JSON.stringify({
        model: service.model,
        max_tokens: 1500,
        temperature: 0.2,
        messages: [{
          role: 'user',
          content: [
            { type: 'image_url', image_url: { url: `data:${mime};base64,${Buffer.from(bytes).toString('base64')}` } },
            { type: 'text', text: prompt },
          ],
        }],
      }),
      signal: AbortSignal.timeout(timeoutMs),
    });
  } catch (err) {
    throw visionError(502, 'VISION_UNREACHABLE', `连不上看图模型：${err.name === 'TimeoutError' ? '超时' : err.message}`);
  }
  const raw = await res.text();
  if (!res.ok) {
    let detail = raw.slice(0, 200);
    try { const j = JSON.parse(raw); detail = j.error?.message || j.message || detail; } catch { /* text */ }
    const hint = res.status === 401 || res.status === 403 ? '密钥无效或没有权限' : res.status === 404 ? '模型名不对，或这个服务不支持看图' : `HTTP ${res.status}`;
    throw visionError(502, 'VISION_FAILED', `看图失败（${hint}）：${detail}`);
  }
  let text = '';
  try { text = String(JSON.parse(raw).choices?.[0]?.message?.content || ''); } catch { text = ''; }
  if (!text.trim()) throw visionError(502, 'VISION_EMPTY', '看图模型没有返回内容');
  return { text: text.trim(), model: service.model, latencyMs: Date.now() - started };
}
