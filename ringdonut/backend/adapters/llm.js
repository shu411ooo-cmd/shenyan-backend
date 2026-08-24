/**
 * LLM integration — 沈晏宿主实现（2026-08-24 接入）。
 *
 * 两个通道，与 ringdonut 原设计一致：
 *  - callOpenAI         → OpenAI 兼容格式（语音导演/摘要/语气判断用；主通道可配 OpenRouter）
 *  - callAnthropicNative → Anthropic 原生格式（主回复用）
 *
 * 主通道默认走 OpenRouter（与 shenyan-backend 现有调用一致，claude-sonnet-4-6）；
 * 未来 zenmux 落地时，只需改 toModel / baseUrl / headers 三处。
 */

function notConfigured(name) {
  throw new Error(`LLM adapter not configured: ${name}`);
}

function getApiConfig(model) {
  return {
    type: 'openai', // ringdonut 默认走 OpenAI 兼容通道；Anthropic 由调用方显式选
    provider: 'Host LLM',
    baseUrl: process.env.LLM_BASE_URL || 'https://openrouter.ai/api/v1',
    apiKey: process.env.OPENROUTER_API_KEY || process.env.LLM_API_KEY || '',
    model: model || process.env.DEFAULT_CALL_MODEL || 'anthropic/claude-sonnet-4-6',
    timeoutMs: Number(process.env.LLM_TIMEOUT_MS || 45000),
  };
}

// —— OpenAI 兼容非流式调用（ringdonut 内部全走这条）——
// signature: callOpenAI(config, messages, tools, maxTokens, temperature)
async function callOpenAI(config, messages, tools, maxTokens = 1000, temperature = 0.7) {
  // 语音导演/语气判断用 translationApiKey/translationBaseUrl（DeepSeek），
  // 其余用 apiKey/baseUrl（OpenRouter）——两套都认，避免上游 voice.js 传参不匹配。
  const apiKey = config?.apiKey || config?.translationApiKey;
  if (!apiKey) throw new Error('LLM API key 未配置（OPENROUTER_API_KEY / LLM_API_KEY / VOICE_TRANSLATION_API_KEY）');
  const baseUrl = String(config?.baseUrl || config?.translationBaseUrl || 'https://openrouter.ai/api/v1').replace(/\/+$/, '');
  const model = config?.model || config?.translationModel || 'anthropic/claude-sonnet-4-6';
  const body = {
    model,
    messages,
    max_tokens: maxTokens || 1000,
    temperature: temperature ?? 0.7,
  };
  if (Array.isArray(tools) && tools.length) {
    body.tools = tools;
    body.tool_choice = 'auto';
  }
  if (config.extraBody) Object.assign(body, config.extraBody);

  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), config.timeoutMs || 45000);
  try {
    const response = await fetch(`${baseUrl}/chat/completions`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'Authorization': `Bearer ${apiKey}`,
      },
      body: JSON.stringify(body),
      signal: controller.signal,
    });
    const data = await response.json();
    if (!response.ok) {
      throw new Error(`LLM 请求失败 (${response.status}): ${JSON.stringify(data).slice(0, 300)}`);
    }
    if (!data.choices || !data.choices[0]) {
      throw new Error(`LLM 响应异常: ${JSON.stringify(data).slice(0, 300)}`);
    }
    return data;
  } finally {
    clearTimeout(timer);
  }
}

// —— Anthropic 原生非流式调用（主回复用；OpenRouter 的 anthropic 通道）——
async function callAnthropicNative(config, messages, system, tools = [], maxTokens = 320, temperature = 0.72, stream = false, cacheOpts = {}) {
  if (!config?.apiKey) throw new Error('LLM API key 未配置');
  const body = {
    model: config.model,
    max_tokens: maxTokens || 320,
    messages,
    stream,
  };
  if (system) body.system = system;
  if (temperature !== undefined) body.temperature = temperature;
  if (Array.isArray(tools) && tools.length) {
    body.tools = tools;
    body.tool_choice = 'auto';
  }
  // 缓存断点：稳定 system 前缀用 1h TTL（OpenRouter 透传给 Anthropic）
  if (cacheOpts?.ttl) {
    body.cache_control = { type: 'ephemeral', ttl: cacheOpts.ttl };
  }

  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), config.timeoutMs || 45000);
  try {
    const response = await fetch('https://openrouter.ai/api/v1/chat/completions', {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'Authorization': `Bearer ${config.apiKey}`,
      },
      body: JSON.stringify(body),
      signal: controller.signal,
    });
    const data = await response.json();
    if (!response.ok) {
      throw new Error(`Anthropic 请求失败 (${response.status}): ${JSON.stringify(data).slice(0, 300)}`);
    }
    return data;
  } finally {
    clearTimeout(timer);
  }
}

// —— Anthropic 响应解析（从 choices[].message 提取文本）——
function parseAnthropicResponse(raw) {
  if (!raw) return { text: '', reasoning: null };
  const msg = raw.choices?.[0]?.message;
  if (!msg) return { text: '', reasoning: null };
  const content = msg.content;
  const text = Array.isArray(content)
    ? content.filter(b => b?.type === 'text').map(b => b.text).join('')
    : String(content || '');
  return {
    text,
    reasoning: msg.reasoning || msg.thinking || null,
  };
}

module.exports = {
  getApiConfig,
  callOpenAI,
  callAnthropicNative,
  parseAnthropicResponse,
};
