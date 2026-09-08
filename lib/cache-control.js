/* ============================================================
   缓存断点与 token 估算 —— 纯函数，无 IO

   从 server.js 原样搬出（2026-09-08 分区第 1 步），注释一并带走。
   唯一外部依赖是 node 的 crypto（sha256 用）。

   这组函数是命中率那条线上的关键判据（08-31 从 60% 修到 99.9% 就是改的
   markCacheTail），值得单独成文件、单独读。
   ============================================================ */

const crypto = require('crypto');
// —— 无 tokenizer 依赖的估算：CJK 约 1 token/字，ASCII 约 4 字符/token（仅安全预算，不精确） ——
function estimateTokens(str) {
  if (!str) return 0;
  let cjk = 0, other = 0;
  for (const ch of String(str)) {
    if (ch.codePointAt(0) > 0x2E7F) cjk++;
    else other++;
  }
  return Math.ceil(cjk + other / 4);
}

function sha256(text) {
  return crypto.createHash('sha256').update(String(text)).digest('hex').slice(0, 16);
}

// —— cache_control 断点（OpenRouter 透传给 Anthropic，请求上限 4 个） ——
// 稳定段（frozen 末块 / summary）用 1h TTL：字节级稳定，值得留长一点，别让 5 分钟 TTL 把跨时段的复用打断。
// 动态尾巴不在这（顶层 cache_control 只挂在最后一条消息上，保持默认 5m）。
// 断点排序合法：1h 在前、5m 在后（Anthropic 只禁 1h-after-5m）。
function withCacheControl(msg) {
  if (msg.role === 'tool') return msg;
  if (Array.isArray(msg.content)) {
    return { ...msg, content: msg.content.map((b, i) =>
      i === msg.content.length - 1 ? { ...b, cache_control: { type: 'ephemeral', ttl: '1h' } } : b) };
  }
  return { ...msg, content: [{ type: 'text', text: msg.content, cache_control: { type: 'ephemeral', ttl: '1h' } }] };
}

// 数请求里已有多少个带 cache_control 的内容块（Anthropic 上限 4 个）。
// 顶层 body.cache_control 会让 OpenRouter 在最后一条消息上再物化一个块——
// 显式断点已满 4 个时还加顶层，就是 400「Found 5」（多段 session 必炸的根因）。
function countCacheControlBlocks(messages) {
  let n = 0;
  for (const m of messages || []) {
    const c = m.content;
    if (Array.isArray(c)) n += c.filter((b) => b && b.cache_control).length;
  }
  return n;
}

// 显式尾断点（2026-08-31 修 v2）：断点挂「倒数第二条」user 消息（当前输入之前的整段历史末尾），
// 对标实战报告（NyraSeithhh/cache BP4 rolling，线上 96%）铁律 #4——挂最后一条（本轮新输入）
// 每次都不一样，缓存等于没挂；挂倒数第二条，缓存边界正好停在「这轮之前的所有内容」末尾，
// 下一轮整段历史读回。只标 user 消息：assistant/tool 消息 content 可能为 null 或含 tool_calls，
// withCacheControl 会包坏。每请求消息数组由 buildModelContext 从 DB 重拼（DB 不带 cache_control），
// 不会跨轮累积断点数。首轮（不足两条 user）无历史可纳，缓存边界停在 system/frozen 末尾即可。
function markCacheTail(messages) {
  let found = 0;
  for (let i = messages.length - 1; i >= 0; i--) {
    const m = messages[i];
    if (m && m.role === 'user' && m.content) {
      found++;
      if (found === 2) {
        messages[i] = withCacheControl(m);
        return;
      }
    }
  }
}

// DeepSeek（OpenAI 兼容）不认 Anthropic 的 cache_control 块——发过去可能 400。发前剥离。
// 只剥 cache_control 字段，其余原样（保留 block 顺序对工具上下文无影响）。
function stripCacheControl(messages) {
  return (messages || []).map((m) => {
    if (!m || m.cache_control === undefined) return m;
    const { cache_control, ...rest } = m;
    return rest;
  });
}

module.exports = {
  estimateTokens,
  sha256,
  withCacheControl,
  countCacheControlBlocks,
  markCacheTail,
  stripCacheControl,
};
