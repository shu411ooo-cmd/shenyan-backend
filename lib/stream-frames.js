/* ============================================================
   流内帧 —— 后端发给前端的**跨仓库契约面**

   为什么单独一个文件：这些帧的字段名是前端会认的。angel-garden-diary 的
   ChatScreen 只解析 SSE 的 `data:` 行、**完全忽略 `event:` 行**，分发靠 payload
   里的判别字段（kind）。任何一边单方面改了字段名，两边都不报错，只会静默显示
   错的东西 —— 与 trace/bucket_id 那次契约漂移是同一形状
   （见 docs/2026-09-18-receipt-task-a-b.md）。

   所以把它们收在一处：**改这里，就得回头看前端。**

   约定：
   - 每帧必须带 `kind`（前端唯一的判别字段）
   - `kind` 一旦对外就别改；加能力只加枚举值或新字段，不改既有字段的含义
   - 字段集被 test/lib-stream-frames.test.cjs 钉死，改名/加字段都会红
   ============================================================ */

const { resolveTransport } = require('./claude-agent');

/* route 帧：这一轮**实际**走了哪条线。
   注意报的是实际、不是前端请求了什么 —— 带图片 / 带委托 MCP / 续调轮 / token 缺失
   都会静默改道，不一致时前端要显示真实那条。 */
function routeFrame(opts = {}, resume = null) {
  const { transport, reason } = resolveTransport(opts, resume);
  return { kind: 'route', transport, reason };
}

module.exports = { routeFrame };
