/* ============================================================
   DeepSeek 结构化输出（JSON mode）—— 单次调用，拿一个 JSON 对象回来

   2026-09-09 从 server.js 的音乐室区搬出（分区第 2 步）。它原本住在
   「音乐室 · 动作沉淀」那一节里，但实际有三个调用方：
     - sedimentMusicMoment（音乐室沉淀）
     - voiceifyMemory（记忆声音渲染）
     - refineFeelContent（feel 正文精修）
   所以它是通用工具，不属于音乐域 —— 抽出来两边都能用，
   否则搬走音乐路由会把另外两个调用方弄断。

   顺手改掉一处误导：原来失败日志写死「音乐室沉淀请求失败」，
   但另外两个调用方也会打这行，看日志的人会找错地方。改成带 tag 的通用文案。

   纪律：thinking 关掉 + temperature 0 + response_format json_object。
   （踩过的坑见 [[safety-valve-baseline-drift]]：deepseek 思考型会吃光 max_tokens
     导致 JSON 截断后静默 pass，所以这里明确禁思考。）
   ============================================================ */

const DEEPSEEK_JSON_URL = 'https://api.deepseek.com/v1/chat/completions';

/**
 * @param {string} systemContent 系统提示
 * @param {string} userContent   用户内容
 * @param {string} [tag]         日志标记，指明是谁在调（失败时能一眼看出来源）
 * @returns {Promise<object|null>} 解析出的对象；没配 key / 请求失败 / 解析不出来都返回 null
 */
async function callDeepSeekJson(systemContent, userContent, tag = 'deepseek-json') {
  if (!process.env.DEEPSEEK_API_KEY) return null;
  const res = await fetch(DEEPSEEK_JSON_URL, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', 'Authorization': `Bearer ${process.env.DEEPSEEK_API_KEY}` },
    body: JSON.stringify({
      model: 'deepseek-v4-flash',
      temperature: 0,
      thinking: { type: 'disabled' },
      max_tokens: 700,
      response_format: { type: 'json_object' },
      messages: [
        { role: 'system', content: systemContent },
        { role: 'user', content: userContent }
      ]
    }),
    signal: AbortSignal.timeout(30000)
  });
  if (!res.ok) { console.warn(`⚠️ [${tag}] DeepSeek JSON 请求失败:`, res.status); return null; }
  const data = await res.json();
  const raw = data.choices && data.choices[0] && data.choices[0].message;
  if (!raw || !raw.content) return null;
  try { return JSON.parse(raw.content); }
  catch {
    // 模型偶尔在 JSON 外面裹一层话，捞出最外层大括号再试一次
    const m = String(raw.content).match(/\{[\s\S]*\}/);
    return m ? JSON.parse(m[0]) : null;
  }
}

module.exports = { callDeepSeekJson };
