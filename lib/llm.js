/* ============================================================
   LLM 调用（DeepSeek 直连 / OpenRouter / 视觉）—— 纯 env + fetch，无 IO 无状态

   2026-09-09 从 server.js 的朋友圈区搬出（分区第 2 步）。逻辑一字未改。

   为什么单独抽：这几个函数原本住在「朋友圈」那一节里，但根本不属于那个域 ——
   callDeepSeek 被区外用了 8 处、callOpenRouter 4 处。朋友圈域是个枢纽不是叶子，
   直接整块搬走会变成「往 server.js 反向注入 8 个符号」，那不叫解耦。
   所以先把这层通用能力剥出来，朋友圈域才能真正变小。

   callReplyModel 的降级链保持原样：先 OpenRouter，失败回落 DeepSeek。
   parseJsonLoose 是它们的搭档 —— 不传 response_format（anthropic 走 OpenAI
   兼容通道时该参数不一定被支持），靠提示词要求严格 JSON + 这里兜底。
   ============================================================ */

function randomDelay(min, max) { return min + Math.random() * (max - min); }

// 容错 JSON 解析（LLM + max_tokens 截断常见病）：直接 parse → 剥围栏/截到 {} → 去尾随逗号
function parseJsonLoose(raw) {
  if (typeof raw !== 'string') return {};
  try { return JSON.parse(raw) || {}; } catch { /* 走下面容错 */ }
  let s = raw.replace(/^```(?:json)?\s*/i, '').replace(/\s*```$/i, '').trim();
  const start = s.indexOf('{');
  const end = s.lastIndexOf('}');
  if (start === -1 || end <= start) return {};
  s = s.slice(start, end + 1).replace(/,\s*([}\]])/g, '$1');
  try { return JSON.parse(s) || {}; } catch { return {}; }
}

// 回复音色：DeepSeek 直连（程芥 2026-08-26 定案——OpenRouter 在本机(中国 IP)被 region 封锁，
// 部署机也不保证通；DeepSeek 全球可通、便宜、key 现成）。文本回复走 json_object。
async function callDeepSeek(messages, { max_tokens = 300, temperature = 0.8 } = {}) {
  const res = await fetch('https://api.deepseek.com/v1/chat/completions', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', 'Authorization': `Bearer ${process.env.DEEPSEEK_API_KEY}` },
    body: JSON.stringify({
      model: process.env.DEEPSEEK_TEXT_MODEL || 'deepseek-v4-flash',
      temperature,
      thinking: { type: 'disabled' },
      max_tokens,
      response_format: { type: 'json_object' },
      messages,
    }),
  });
  if (!res.ok) throw new Error(`DeepSeek ${res.status}: ${(await res.text()).slice(0, 200)}`);
  const data = await res.json();
  const content = data.choices?.[0]?.message?.content;
  if (typeof content !== 'string' || !content) throw new Error('DeepSeek 无内容输出');
  return content;
}

// 回复引擎的模型调用：OpenRouter（Claude，和主对话同一声线）优先；失败自动降级 DeepSeek。
// 程芥 2026-08-26 确认：DeepSeek 是给我本机测试用的兜底（本机中国 IP 调 OpenRouter 必 403），不是线上替换。
// 生产（海外 IP + OPENROUTER_API_KEY）→ anthropic/claude-sonnet-4-6，和沈晏主对话同一个模型、同一个他。
async function callReplyModel(messages, { max_tokens = 300, temperature = 0.8 } = {}) {
  try {
    const content = await callOpenRouter(messages, { max_tokens, temperature });
    return { content, provider: 'openrouter' };
  } catch (e) {
    console.warn(`⚠️ [朋友圈] OpenRouter 回复不可用，降级 DeepSeek: ${String(e.message).slice(0, 120)}`);
    const content = await callDeepSeek(messages, { max_tokens, temperature });
    return { content, provider: 'deepseek' };
  }
}

// OpenRouter 非流式调用（回复短句用，不带 tools/reasoning，保持轻量）。
// 不传 response_format：anthropic 模型走 OpenAI 兼容通道时该参数不一定被支持；提示词已要求严格 JSON，parseJsonLoose 兜底。
async function callOpenRouter(messages, { max_tokens, temperature }) {
  const res = await fetch('https://openrouter.ai/api/v1/chat/completions', {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      'Authorization': `Bearer ${process.env.OPENROUTER_API_KEY}`,
    },
    body: JSON.stringify({
      model: 'anthropic/claude-sonnet-4-6',
      messages,
      max_tokens,
      temperature,
      provider: OPENROUTER_PROVIDER, // 钉死上游（缓存/一致性），见 handleStreamChat 注释
    }),
  });
  if (!res.ok) throw new Error(`OpenRouter ${res.status}: ${(await res.text()).slice(0, 200)}`);
  const data = await res.json();
  const content = data.choices?.[0]?.message?.content;
  if (typeof content !== 'string' || !content) throw new Error('OpenRouter 无内容输出');
  return content;
}

// 图片描述同样 OpenRouter 优先 → DeepSeek 视觉兜底（图只看一次，失败返回 null，回复引擎仍可用）
async function callVisionModel(parts) {
  try {
    const res = await fetch('https://openrouter.ai/api/v1/chat/completions', {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'Authorization': `Bearer ${process.env.OPENROUTER_API_KEY}`,
      },
      body: JSON.stringify({
        model: 'anthropic/claude-sonnet-4-6',
        messages: [{ role: 'user', content: parts }],
        max_tokens: 250,
        temperature: 0.7,
        provider: OPENROUTER_PROVIDER, // 钉死上游，见 handleStreamChat 注释
      }),
    });
    if (!res.ok) throw new Error(`OpenRouter 视觉 ${res.status}`);
    const data = await res.json();
    const content = data.choices?.[0]?.message?.content;
    if (typeof content !== 'string' || !content) throw new Error('OpenRouter 视觉无内容输出');
    return content;
  } catch (e) {
    console.warn(`⚠️ [朋友圈] OpenRouter 视觉不可用，降级 DeepSeek: ${String(e.message).slice(0, 120)}`);
    const res = await fetch('https://api.deepseek.com/v1/chat/completions', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'Authorization': `Bearer ${process.env.DEEPSEEK_API_KEY}` },
      body: JSON.stringify({
        model: process.env.DEEPSEEK_VISION_MODEL || 'deepseek-v4-flash-vision-exp',
        temperature: 0.7,
        thinking: { type: 'disabled' },
        max_tokens: 250,
        messages: [{ role: 'user', content: parts }],
      }),
    });
    if (!res.ok) throw new Error(`DeepSeek 视觉 ${res.status}`);
    const data = await res.json();
    const content = data.choices?.[0]?.message?.content;
    if (typeof content !== 'string' || !content) throw new Error('DeepSeek 视觉无内容输出');
    return content;
  }
}

module.exports = {
  randomDelay, parseJsonLoose,
  callDeepSeek, callReplyModel, callOpenRouter, callVisionModel,
};
