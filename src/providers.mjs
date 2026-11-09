/**
 * providers.mjs - the catalogue of model providers Desk can talk to.
 *
 * There are only two wire formats in the world that matter here:
 *
 *   openai     /chat/completions with tools - covers almost everything worth
 *              using: OpenAI, DeepSeek, Kimi, 智谱 GLM, 通义千问, MiniMax,
 *              混元, 讯飞星火, 硅基流动, OpenRouter, Groq, Together, Grok,
 *              Ollama / LM Studio / vLLM 本地, and even Gemini's
 *              OpenAI-compatibility endpoint.
 *   anthropic  /messages with tool_use blocks - Claude, which is the one big
 *              provider that is NOT OpenAI-compatible.
 *
 * Adding a provider is therefore a data change, not a code change: append an
 * entry here. `kind` decides which client model.mjs builds.
 *
 *   baseUrl  the value the settings form pre-fills (still editable - gateways,
 *            proxies and self-hosted deployments all change it)
 *   models   suggestions for the model field; free text always wins
 *   keyUrl   where a human actually gets a key (shown in the UI)
 */

export const PROVIDER_PRESETS = {
  mock: {
    label: '演示模式（无需密钥）',
    kind: 'mock',
    baseUrl: '',
    models: [],
    note: '本地脚本化规划器，完全离线，用来试功能。',
  },
  openai: {
    label: 'OpenAI',
    kind: 'openai',
    baseUrl: 'https://api.openai.com/v1',
    models: ['gpt-4o', 'gpt-4o-mini', 'gpt-4.1', 'o4-mini'],
    keyUrl: 'https://platform.openai.com/api-keys',
  },
  deepseek: {
    label: 'DeepSeek 深度求索',
    kind: 'openai',
    baseUrl: 'https://api.deepseek.com/v1',
    // What DeepSeek's /models lists (2026-11); the form reads the live list when it can.
    models: ['deepseek-flash', 'deepseek-v4-pro'],
    keyUrl: 'https://platform.deepseek.com/api_keys',
  },
  moonshot: {
    label: '月之暗面 Kimi',
    kind: 'openai',
    baseUrl: 'https://api.moonshot.cn/v1',
    models: ['kimi-k2-0905-preview', 'moonshot-v1-128k', 'moonshot-v1-32k', 'moonshot-v1-8k'],
    keyUrl: 'https://platform.moonshot.cn/console/api-keys',
  },
  zhipu: {
    label: '智谱 GLM',
    kind: 'openai',
    baseUrl: 'https://open.bigmodel.cn/api/paas/v4',
    models: ['glm-4-plus', 'glm-4-air', 'glm-4-flash'],
    keyUrl: 'https://bigmodel.cn/usercenter/apikeys',
  },
  qwen: {
    label: '阿里通义千问',
    kind: 'openai',
    baseUrl: 'https://dashscope.aliyuncs.com/compatible-mode/v1',
    models: ['qwen-max', 'qwen-plus', 'qwen-turbo', 'qwen3-235b-a22b'],
    keyUrl: 'https://bailian.console.aliyun.com/?apiKey=1',
  },
  minimax: {
    label: 'MiniMax',
    kind: 'openai',
    baseUrl: 'https://api.minimax.chat/v1',
    models: ['MiniMax-M1', 'abab6.5s-chat'],
    keyUrl: 'https://platform.minimaxi.com/user-center/basic-information/interface-key',
  },
  hunyuan: {
    label: '腾讯混元',
    kind: 'openai',
    baseUrl: 'https://api.hunyuan.cloud.tencent.com/v1',
    models: ['hunyuan-turbos-latest', 'hunyuan-large'],
    keyUrl: 'https://console.cloud.tencent.com/hunyuan/api-key',
  },
  spark: {
    label: '讯飞星火',
    kind: 'openai',
    baseUrl: 'https://spark-api-open.xf-yun.com/v1',
    models: ['4.0Ultra', 'generalv3.5', 'lite'],
    keyUrl: 'https://console.xfyun.cn/services/bmx1',
  },
  siliconflow: {
    label: '硅基流动 SiliconFlow',
    kind: 'openai',
    baseUrl: 'https://api.siliconflow.cn/v1',
    models: ['deepseek-ai/DeepSeek-V3', 'Qwen/Qwen2.5-72B-Instruct'],
    keyUrl: 'https://cloud.siliconflow.cn/account/ak',
  },
  openrouter: {
    label: 'OpenRouter（聚合）',
    kind: 'openai',
    baseUrl: 'https://openrouter.ai/api/v1',
    models: ['anthropic/claude-sonnet-4.5', 'google/gemini-2.5-pro', 'deepseek/deepseek-chat'],
    keyUrl: 'https://openrouter.ai/keys',
  },
  groq: {
    label: 'Groq（极快推理）',
    kind: 'openai',
    baseUrl: 'https://api.groq.com/openai/v1',
    models: ['llama-3.3-70b-versatile', 'qwen/qwen3-32b'],
    keyUrl: 'https://console.groq.com/keys',
  },
  together: {
    label: 'Together AI',
    kind: 'openai',
    baseUrl: 'https://api.together.xyz/v1',
    models: ['meta-llama/Llama-3.3-70B-Instruct-Turbo'],
    keyUrl: 'https://api.together.ai/settings/api-keys',
  },
  mistral: {
    label: 'Mistral',
    kind: 'openai',
    baseUrl: 'https://api.mistral.ai/v1',
    models: ['mistral-large-latest', 'mistral-small-latest'],
    keyUrl: 'https://console.mistral.ai/api-keys',
  },
  xai: {
    label: 'xAI Grok',
    kind: 'openai',
    baseUrl: 'https://api.x.ai/v1',
    models: ['grok-4', 'grok-3', 'grok-3-mini'],
    keyUrl: 'https://console.x.ai',
  },
  gemini: {
    label: 'Google Gemini（OpenAI 兼容口）',
    kind: 'openai',
    baseUrl: 'https://generativelanguage.googleapis.com/v1beta/openai',
    models: ['gemini-2.5-pro', 'gemini-2.5-flash'],
    keyUrl: 'https://aistudio.google.com/apikey',
  },
  anthropic: {
    label: 'Anthropic Claude',
    kind: 'anthropic',
    baseUrl: 'https://api.anthropic.com/v1',
    models: ['claude-sonnet-4-5', 'claude-opus-4-1', 'claude-haiku-4-5'],
    keyUrl: 'https://console.anthropic.com/settings/keys',
  },
  ollama: {
    label: 'Ollama（本机模型）',
    kind: 'openai',
    baseUrl: 'http://127.0.0.1:11434/v1',
    models: ['qwen3:8b', 'llama3.2:3b', 'deepseek-r1:7b'],
    note: '本机跑模型，不需要密钥；先 ollama serve。',
    needsKey: false,
  },
  lmstudio: {
    label: 'LM Studio（本机模型）',
    kind: 'openai',
    baseUrl: 'http://127.0.0.1:1234/v1',
    models: ['local-model'],
    note: 'LM Studio 开 Local Server 后可用，不需要密钥。',
    needsKey: false,
  },
  custom: {
    label: '自定义（OpenAI 兼容）',
    kind: 'openai',
    baseUrl: '',
    models: [],
    note: '任何兼容 /chat/completions 的服务，填地址和模型名即可。',
  },
};

/** Providers the settings API accepts (mock + everything above). */
export const PROVIDER_NAMES = Object.keys(PROVIDER_PRESETS);

export function isKnownProvider(name) {
  return PROVIDER_NAMES.includes(String(name || '').toLowerCase());
}

/** Preset for a provider, falling back to the custom entry. */
export function providerPreset(name) {
  return PROVIDER_PRESETS[String(name || '').toLowerCase()] || PROVIDER_PRESETS.custom;
}

/** Which wire format a provider speaks. */
export function providerKind(name) {
  return providerPreset(name).kind;
}

/** Whether the provider needs an API key at all. */
export function providerNeedsKey(name) {
  const preset = providerPreset(name);
  return preset.needsKey !== false;
}

/**
 * What the UI shows. Deliberately no secrets and no environment state - this is
 * a static catalogue, so it is safe to serve to any paired device.
 */
export function publicProviderCatalogue() {
  return PROVIDER_NAMES.map((name) => {
    const p = PROVIDER_PRESETS[name];
    return {
      name,
      label: p.label,
      kind: p.kind,
      baseUrl: p.baseUrl,
      models: p.models || [],
      keyUrl: p.keyUrl || '',
      note: p.note || '',
      needsKey: p.needsKey !== false,
    };
  });
}

/**
 * The models a provider offers right now, from its own /models endpoint (with
 * the key). Chat models only, newest names as the provider gives them.
 * -> {models: [...ids]}; throws with a readable message when it cannot tell.
 */
export async function fetchProviderModels({ provider, baseUrl, apiKey, fetchImpl = fetch, timeoutMs = 12000 } = {}) {
  const preset = providerPreset(provider);
  const base = String(baseUrl || preset?.baseUrl || '').replace(/\/+$/, '');
  if (!base || !/^https?:\/\//.test(base)) throw new Error('没有接口地址');
  const kind = providerKind(provider);
  const headers = kind === 'anthropic'
    ? { 'x-api-key': apiKey || '', 'anthropic-version': '2023-06-01' }
    : (apiKey ? { authorization: `Bearer ${apiKey}` } : {});
  const res = await fetchImpl(`${base}/models`, { headers, signal: AbortSignal.timeout(timeoutMs) });
  if (res.status === 401 || res.status === 403) throw new Error('密钥不对或没有权限');
  if (!res.ok) throw new Error(`服务商返回 ${res.status}`);
  const data = await res.json().catch(() => ({}));
  const raw = Array.isArray(data?.data) ? data.data : Array.isArray(data?.models) ? data.models : [];
  // Not chat models: embeddings, speech, images, moderation, rerankers.
  const NOT_CHAT = /embed|whisper|tts|speech|audio|transcri|dall-e|image|moderation|rerank|bge-|sensevoice|cosyvoice|flux|stable-diffusion|kolors|wan-|video/i;
  const ids = raw.map((m) => String(m?.id || m?.name || '').replace(/^models\//, '')).filter((id) => id && !NOT_CHAT.test(id));
  return { models: [...new Set(ids)].slice(0, 300) };
}
