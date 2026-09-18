# 外包改动二轮筛查回执

> 日期：2026-09-18  
> 输入：`2026-09-18-receipt-task-a-b.md` 及其产生的未提交改动  
> 状态：已清理、已测试，随本批提交部署

## 接受

- Ombre 工具契约：`trace.bucket_id`、移除 `plan_id`、`letter_write.author` 必填。已直接向生产 Ombre
  执行 `initialize` + `tools/list` 复核，生产端正是这套签名（14 个 MCP 工具）。
- Agent 工具首轮可靠性：in-process MCP server 使用 `alwaysLoad: true`；从 SDK `system/init` 只记录
  工具数量、沈晏工具数量与 MCP 状态，不记录工具内容。
- 工具日志脱敏：不再把记忆正文、工具参数值或 Ombre 原始响应写进生产日志。
- 写入护栏：短人格锚在写 `stone_rings` 前拒绝；反证卡非法裁决在写 `mirror_cards` 前拒绝；
  conflict revise 的返回 action 与实际落库值一致。
- 本轮真实线路：SSE 新增 `kind: "route"`，前端只展示后端解析后的实际线路。reason 使用稳定代码，
  中文说明留在前端映射。

## 撤下

- `kind: "context"` SSE 帧。
- 聊天页 `remembering N%`、上下文分解 Sheet。
- 为该 UI 添加的 `collapse_usage_ratio`、diagnostics 分母与测试夹具字段。

撤下原因：Claude Agent 原生 session resume 的真实上下文驻留在 SDK/CLI 中；现有应用层 24k 预算只衡量
Context Assembly，不等于订阅线路当前上下文窗口或 compact 压力。这个 UI 会给出精确但错误的答案。

## 验证

- 后端：`npm.cmd test`，168/168 通过。
- 前端：`npm.cmd run build`，108 modules transformed，构建通过；仅保留原有大 chunk 警告。
- 未做真消息端到端：会写生产数据并消耗额度，留到部署后做一轮受控验证。

## 下一步建议

1. 先提交并部署本批「工具可靠性 + 真实线路观测」。
2. 再接额度缓存：复用活跃 Agent Query 的实验性 usage / `rate_limit_event`，保存 last-known-good；
   查询接口只读缓存，不为每次刷新新开 Claude 进程。
3. 然后实现显式 `transport` 请求语义与前端 CC 模式开关。
4. 上下文 UI 等接到 `Query.getContextUsage()` 的真实口径后再做。
5. Serein 继续 shadow preview，不进入写路径。
