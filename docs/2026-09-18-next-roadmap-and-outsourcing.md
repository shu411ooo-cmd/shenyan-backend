# Claude Agent 下一阶段路线与外包任务单

> 日期：2026-09-18  
> 基线：`94e68e1`（Claude Agent SDK 主链、Ombre MCP 鉴权、provider-neutral memory transport 已上线）  
> 用途：这是下一阶段的唯一总清单。外部模型先按任务单做只读调查并回执；Codex 做二轮证据审查、实现、测试和部署。

> 晚间更新：工具加固、真实线路帧、订阅额度 adapter/API、线路胶囊以及消息恢复修复均已完成；下方较早的“当前基线”保留作决策记录，执行时以本节的滚动清单为准。

## 滚动执行清单（长期计划）

原则：每一阶段都必须能单独验收、单独回退；观测与行为修改分开提交。外部模型负责证据调查和测试设计，Codex 负责二轮复核、实现、生产验证。

### S0 稳定性收口（已完成）

- [x] Agent 工具参数与结果护栏、真实 transport 回传、完整测试。
- [x] 订阅额度稳定 DTO、last-known-good 缓存与 `/api/claude-agent/quota`。
- [x] 前端显示后端确认的真实线路。
- [x] 线路胶囊跨页面持久化；新一轮确认时不再闪退。
- [x] 后端消息作为恢复真相源；退出后短暂补拉仍在生成的回复。
- [x] 句子呈现间隔由 300ms 降到 100ms，减少“明明收到却慢慢出现”的假卡顿。

### S1 Claude 订阅控制面（下一步）

- [ ] 后端正式接收 `transport: auto | claude-subscription | api`，强制模式失败时返回结构化错误，禁止静默改道。
- [ ] Session Garden 增加“线路”选择，并完成旧 localStorage 的无损迁移。
- [ ] Usage 页面增加订阅额度窗口：5 小时、7 天及动态新增窗口；支持 loading / stale / unavailable / warning / rejected。
- [ ] 额度卡只展示已用百分比、重置时间和更新时间，不伪造剩余 token。
- [ ] 做一次 fresh、resume、图片、前端 MCP、强制 API 的端到端线路矩阵。

完成门：用户选择、请求字段、后端实际线路、header 回显四者一致；额度接口失败不影响聊天。

### S2 Context Flight Recorder（只观测，不改上下文）

- [ ] 每轮记录 requested/resolved transport、fresh/resume/rebuild、总耗时与各阶段耗时。
- [ ] 分项记录 system、近期消息、摘要、长期记忆、工具 schema 的估算 token；不记录正文。
- [ ] 记录 SDK context usage、compact 前后量、cache read/write 与 rate-limit 窗口。
- [ ] 给 request_stats 增加版本化统计口径，旧 OpenRouter 与 Agent SDK 指标明确分栏。
- [ ] 做一个仅本人可见的诊断视图或下载回执，方便把匿名数据交给外部模型分析。

完成门：至少收集 fresh、resume、工具调用、compact 各 10 轮，再允许修改压缩或缓存策略。

### S3 上下文热路径优化

- [ ] 用 S2 数据证明 resume 中哪些 DB 查询、哈希、token 估算没有消费者。
- [ ] 先消除可证明无用的 IO，再讨论上下文内容；每项都放在 feature flag 后。
- [ ] 保留记忆注入、塌缩触发器和 request_stats 所需语义，不用“看起来重复”作为删除依据。
- [ ] 对照优化前后的首 token 延迟、总耗时、输入 token 和缓存命中率。

完成门：性能或额度收益可量化，回复质量回归集无下降，关闭 flag 可立即回退。

### S4 压缩边界

- [ ] 明确 SDK compact 管短期 transcript，应用 summary/collapse 管跨会话长期语义，或用数据提出更好的单一职责边界。
- [ ] 压缩策略与缓存策略绝不在同一轮修改。
- [ ] 覆盖 compact 失败、进程重启、session 丢失、超长工具结果和手动重建。

### S5 记忆系统 shadow preview

- [ ] Ombre 保持生产主库；Serein 使用隔离服务、隔离数据卷、只读导入，禁止双写。
- [ ] 固定查询集对比召回质量、延迟、可解释性、写入副作用和恢复成本。
- [ ] 先产出迁移/回滚演练报告，再决定是否替换；不以功能数量作为迁移理由。

### 固定节奏

1. 外部模型按任务单只读审计并按证据格式回执。
2. Codex 二轮复核后，把一阶段拆成若干独立小提交。
3. 本地测试、构建、生产部署、公网验证四步全过才勾选。
4. 每完成一阶段更新本清单的勾选、commit 和已知风险；聊天记录不作为唯一交接介质。

---

## 一句话决策

**下一步先做 Claude Agent 工具链与额度观测，不先改缓存/上下文压缩，也不迁移记忆库。**

原因：当前同时存在三套会影响上下文的机制——应用侧 Context Assembly、Agent SDK 原生 session、SDK 自动 compact。真实运行数据还不足时调整缓存或压缩，会把变量搅在一起。先把路由、工具、额度、resume、compact 变成可见事实，再决定哪些旧计算能删、哪些压缩该保留。

---

## 当前基线（不要重复造）

- 主对话已能走 Claude Agent SDK 订阅额度。
- SDK session 已镜像进 Supabase；自动清理当前关闭，避免截断 transcript。
- thinking 只展示 SDK 提供的摘要，不抓隐藏思维链。
- 24 个沈晏领域工具已通过 in-process MCP 暴露给 Agent SDK。
- Ombre 生产 MCP 已通过 `initialize`、`tools/list` 和真实 `breath_search` 验证。
- 记忆连接已有中性配置层；Serein 只允许未来做隔离 shadow preview，当前语义适配器仍 fail-closed。
- 完整测试基线：151 项。

当前尚未闭环：

1. 24 个领域工具没有一份按副作用分级的端到端验收矩阵。
2. 首轮工具表曾出现空数组，异步 MCP 就绪竞态尚未被正式证伪。
3. 前端没有明确的“订阅 / API / 自动”线路控制；现在由后端隐式选择。
4. SDK 已有订阅额度数据，但后端没有稳定适配层，前端也没有额度窗口。
5. resume 轮仍完整执行 Context Assembly，随后只把本轮增量交给 SDK；其中一部分 IO/哈希/估算可能浪费，但不能在数据出来前直接删除。
6. SDK compact 与应用侧 summary/collapse 的真实触发关系只有日志，没有统计闭环。

---

## 实施顺序

### P0：工具与 Agent 运行事实验收（现在做）

目标：证明“会对话”之外，工具、续接、思考摘要、失败降级都可控。

交付：

- 24 工具风险矩阵：只读 / 可逆写 / 不可逆或外部副作用。
- 自动化 smoke harness；默认只运行只读工具。
- 可逆写工具必须使用唯一测试标记，并有清理或人工确认步骤。
- 捕获首轮 `system/init` 的工具数量、MCP 状态、真实工具调用结果。
- 覆盖 fresh → resume、工具成功、工具失败、超时、客户端断流、429 busy。
- 日志和测试报告不得输出对话正文、工具结果正文或 token。

完成门：首轮工具可见性有明确结论；所有只读工具有预期结果；写工具不允许靠“看起来成功”验收，必须查回写入结果。

### P1：明确线路控制 + 额度适配层

先做后端，再做前端，避免 UI 开关只是装饰。

建议请求字段：`transport`。

| 值 | 行为 |
|---|---|
| `auto` | 保持当前自动选择；兼容旧客户端 |
| `claude-subscription` | 必须走 Agent SDK；token 缺失或请求形状不支持时明确报错，不静默改走 API |
| `api` | 明确绕过 Agent SDK，走现有 OpenRouter 路径 |

约束：

- `deepseek` 测试模式仍是独立省额度通道。
- 图片、前端委托 MCP 等当前不受 Agent SDK 支持的形状，要么 UI 预先说明，要么后端返回结构化原因；不能偷偷切线后还显示“订阅模式”。
- 每轮响应或 SSE 元数据应回传 `resolvedTransport`，让前端展示真实线路而非用户愿望。

额度能力已经存在于当前本地 SDK `0.3.274`：

- `Query.usage_EXPERIMENTAL_MAY_CHANGE_DO_NOT_RELY_ON_THIS_API_YET()`：订阅类型、5 小时/7 天/按模型窗口的 utilization 与 resets_at。
- `rate_limit_event`：额度状态变化事件，含窗口类型、utilization、重置时间和 allowed/warning/rejected。
- `Query.getContextUsage()`：当前上下文窗口占用，不等同于订阅额度。

实现纪律：

- 原始 experimental 结构只能进入一个 adapter；业务路由和前端只认我们自己的稳定 DTO。
- 建议 DTO：`available`、`subscriptionType`、`limits[]`、`fetchedAt`、`stale`、`source`。
- `limits[]` 保留 `kind/group/percent/resetsAt/scope/severity/isActive`，不要把服务端未来新增的窗口硬编码丢掉。
- 额度读取做 60 秒左右缓存 + single-flight；刷新前端不能反复启动 Claude 查询进程。
- 只展示“已用百分比 + 重置时间”。没有可靠总 token 配额时，不伪造“还剩 N token”。
- 额度不可用是正常状态：API key、scope 不足、上游失败都应返回 `available:false`，不能变成聊天故障。

### P2：前端 CC 模式与额度窗口

建议产品命名使用“Claude 订阅”，内部字段仍可叫 `claude-subscription`；不要让普通界面暴露 SDK/CLI 术语。

放置：

- Session Garden / Merged Drawer：新增“线路”，选项为自动、Claude 订阅、API。
- Usage 页面：新增“订阅额度”卡片，展示 5 小时、7 天和服务端返回的其他窗口。
- 聊天气泡或状态区只显示本轮真实线路，例如“Claude 订阅”；不要每条消息展示大段技术信息。

状态必须齐全：loading、available、warning、rejected、unavailable、stale。重置时间按上海时区显示，并显示“更新于”。

完成门：选择的线路与后端回传的真实线路一致；刷新失败时保留 last-known-good 并标 stale；前端构建通过。

### P3：收集运行数据，再动 Context Assembly / 缓存 / 压缩

至少收集一批 fresh、resume、带工具、无工具、发生 compact 的真实轮次。先补统计，不先改行为：

- requested/resolved transport
- fresh/resume/rebuild/forked
- SDK input/output/cache read/cache write
- SDK compact trigger、pre/post tokens、success/failure
- 应用侧 raw_estimated_tokens、trimmed_turns、live_collapsed
- 工具名、耗时、成功状态（不记参数和正文）

然后只回答三个问题：

1. resume 轮里，完整 Context Assembly 哪些工作仍被记忆注入、塌缩触发器和 request_stats 使用？
2. SDK 自动 compact 是否已经覆盖了应用侧某部分 summary/collapse，还是二者保留不同职责？
3. 旧 OpenRouter cache 指标在 Agent SDK 路线上哪些仍有意义，哪些只是历史口径？

决策顺序：

1. 先修统计口径。
2. 再消除 resume 热路径中可证明无用的 IO/哈希。
3. 再决定应用侧压缩和 SDK compact 的边界。
4. 最后才调 `max_context_tokens`、live/frozen 参数或缓存策略。

禁止同时修改压缩策略和缓存策略；一次只放一个变量，保留回退开关。

### P4：记忆系统 shadow preview（后做）

- Ombre 保持生产主库。
- Serein 单独服务、单独数据卷、只读导入备份，禁止双写。
- 自动 Event pipeline 默认关闭；先验证已知迁移后事件阻塞问题。
- 用同一组查询对比召回质量、延迟、可解释性和回滚成本。
- 达到书面验收门后才讨论迁移，不因“功能看起来多”直接切换。

---

## 可直接交给 DeepSeek 的任务单

把本节原样交给执行者。执行者只调查与写回执，不部署、不改生产、不读取或输出密钥。

### 任务 A（最高优先）：Claude Agent 工具链只读审计

仓库：`shenyan-backend`，基线 commit `94e68e1`。

请完成：

1. 从 `lib/tools-schema.js` 的 24 个工具逐个追到 `dispatchTool` 和真实 handler。
2. 输出表格：工具名、handler、读/写、数据表或外部服务、副作用等级、幂等性、失败形状、建议 smoke case。
3. 核对 JSON Schema → Zod 转换是否丢失 `additionalProperties`、union、nullable、enum 等约束。
4. 核对工具结果序列化和 8000 字截断是否可能破坏关键 ID、错误信息或二轮判断。
5. 专门审计“首轮工具列表为空”的可能路径：SDK query 生命周期、in-process MCP 初始化、allowedTools、strictMcpConfig、init 消息时序。
6. 设计测试，不调用生产写工具；只读调用也只能给出建议命令，不自行访问生产。

不要做：改代码、更新依赖、运行 migration、改环境变量、部署、打印真实记忆正文。

### 任务 B：订阅额度与上下文接口可行性审计

请基于当前安装的 `@anthropic-ai/claude-agent-sdk@0.3.274` 源码/类型，而不是凭记忆回答。

请确认：

1. `usage_EXPERIMENTAL_MAY_CHANGE_DO_NOT_RELY_ON_THIS_API_YET` 在当前 `query()` 生命周期的可调用时机。
2. 是否能在不发送真实聊天、不消耗明显额度的情况下启动控制通道并读取 usage。
3. query 结束后能否继续读取；若不能，最小安全复用方案是什么。
4. `rate_limit_event`、structured usage、响应头 fallback 三者的数据优先级。
5. 给出稳定 DTO、缓存策略、超时、last-known-good、scope 不足和版本漂移处理。
6. 明确区分“订阅窗口利用率”“当前 context window”“单轮 token usage”。

不要实现；输出可验证证据和最小 spike 方案。

### 任务 C：resume 路径的 Context Assembly 成本审计

请沿这条链路走读：请求路由 → `handleChat` → `buildMessages/buildModelContext` → `_agentTurnMessages` → `prepareClaudeAgentSession` → `runClaudeAgent`。

输出：

1. fresh 与 resume 分别真正发给 SDK 的消息。
2. resume 轮中每一项 DB 查询、摘要/记忆副作用、哈希、token 估算的消费者。
3. 哪些工作可跳过，哪些必须保留，哪些可移到响应后。
4. 当前 `request_stats.estimated_tokens` 在 Agent SDK resume 轮代表什么，是否误导。
5. 一个“只加观测、不改行为”的第一版 patch 计划。

不要顺手优化；这轮只审计。

### 任务 D：前端线路与额度信息架构审计

仓库：`angel-garden-diary`。

请走读：`chat-config.js`、`ChatScreen.jsx`、`SessionGarden.jsx`、`MergedDrawer.jsx`、`UsageScreen.jsx`。

输出：

1. `transport` 的唯一状态源和 localStorage 迁移方案。
2. 请求字段接入点与真实线路回显点。
3. 额度卡在 Usage 页的组件拆分和所有状态。
4. 图片 / 前端 MCP 导致订阅线路不可用时的 UI 文案与交互。
5. 最小改动文件清单；不做视觉重设计，不重复造模型设置源。

不要改代码；只交实现蓝图。

---

## 强制回执格式

外部执行者必须按以下格式交回。没有证据行号的判断视为“猜测”，Codex 二轮不接收。

```md
# 回执：任务 X

## 结论
- 状态：完成 / 部分完成 / 阻塞
- 基线 commit：
- 是否改动文件：否（本轮应为否）

## 证据
| 结论 | 文件:行号或命令输出 | 置信度 |
|---|---|---|

## 风险
### P0
### P1
### P2

## 建议 patch（只描述，不实施）
- 文件：
- 最小改动：
- 回退方式：

## 建议测试
| case | 前置条件 | 操作 | 预期 | 是否有副作用 |
|---|---|---|---|---|

## 未确认问题
- 明确写“未确认”，不要补全猜测。

## 实际运行过的命令
- 逐条列出；不得省略失败命令。
```

---

## Codex 二轮筛查清单

收到回执后，Codex 必须：

1. 逐条复核 P0/P1 证据，不接受只有结论没有代码位置的报告。
2. 检查执行者是否误读旧文档、生成文件或过期 SDK 文档。
3. 用当前代码和本地 SDK 类型重验额度字段。
4. 把建议拆成独立小提交；每一提交只解决一个问题。
5. 先加测试和观测，再改变生产行为。
6. 完整测试通过后才能推送；生产部署后检查 health、服务状态和无密钥日志。
7. 不暂存用户已有的前端构建产物、VS Code 配置和无关文档草稿。

---

## 本轮真正的下一步

先把 **任务 A + B** 交给 DeepSeek，可并行完成；任务 C 紧随其后。任务 D 等后端 `transport` 与额度 DTO 定稿后再做，避免前端按一个不存在的契约开工。

DeepSeek 回执回来后，Codex 先做二轮筛查，然后实施顺序固定为：

1. 只加 Agent 工具/额度观测与测试。
2. 后端 `transport` 契约和 quota adapter/API。
3. 前端 CC 模式与额度窗口。
4. 收集真实数据。
5. 再决定缓存与上下文压缩。
