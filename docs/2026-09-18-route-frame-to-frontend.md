# 本轮真实线路 → 前端（第一条「信息进入前端映射」）

> 日期：2026-09-18
> 对应任务单：`docs/2026-09-18-next-roadmap-and-outsourcing.md` §P1 / §P2 的**前半**
> 状态：**二轮筛查通过，随本批提交部署**
> 上游审计：`docs/2026-09-18-receipt-task-a-b.md`

## 这次做的是什么

路线图 P1 原文有两半：**①后端接受 `transport` 请求字段（auto / claude-subscription / api）；
②每轮回传 `resolvedTransport`，让前端展示真实线路而非用户愿望。**

**本次只做了第②半。** 没做请求字段、没做线路选择 UI —— 那需要先定义"用户选了订阅线但不支持时怎么办"的完整语义，
是另一个决策，不该顺手塞进来。本次的目标是先把**事实**送到前端，把管道打通。

## 一条帧，两行契约

后端在流开头发一帧：

```
event: route
data: {"kind":"route","transport":"claude-subscription","reason":null}
```

| 字段 | 取值 | 说明 |
|---|---|---|
| `kind` | 恒为 `"route"` | **判别字段**。前端只解析 `data:` 行、按 payload 字段分发（`event:` 行根本不认），没有它这一帧会静默穿过所有分支 |
| `transport` | `claude-subscription` / `deepseek` / `api` | 本轮**实际**走哪条线 |
| `reason` | 稳定 reason code 或 `null` | 没走订阅线时的**结构化原因**；走了则为 `null`。中文文案由前端映射，后端不把文案当协议 |

`transport` 与 `reason` 由 `lib/claude-agent.js` 的 `resolveTransport(opts, resume)` 产出 —— 它是**唯一真相源**，
原本只有 `shouldUseClaudeAgent` 这个布尔，现在布尔版是它的投影（有一条测试专门钉这个投影关系，防两份条件漂移）。

## 为什么 `reason` 是这次的重点

这套系统里「请求了什么」和「实际走了什么」可以不一致，而且**改道是静默的**：

| 触发条件 | 实际走 |
|---|---|
| `model` 含 deepseek | `deepseek`（省额度测试通道） |
| 本轮带图片 | `api` —— 订阅线不支持多模态输入 |
| 本轮带前端委托 MCP 工具 | `api` —— 订阅线走的是既有的再入委托协议 |
| 续调轮 | `api` —— 只送本轮增量 |
| `CLAUDE_CODE_OAUTH_TOKEN` 缺失 / `CLAUDE_AGENT_ENABLED=false` | `api` |

当前 reason code：`model_deepseek`、`subscription_unconfigured`、`subscription_disabled`、
`images_unsupported`、`frontend_mcp_unsupported`、`delegated_resume`。

只回一个 `transport` 的话，前端看得见「不是订阅线」，看不见**为什么**。所以 `reason` 一起回。

刻意**没有**把 `deepseek` 归进 `api`：它是独立的省额度通道，报成 `api` 会误导用量判断。

## 改动清单

### 后端（`shenyan-backend`）

| 文件 | 改动 |
|---|---|
| `lib/claude-agent.js` | 新增 `resolveTransport(opts, resume)`（唯一真相源，返回 `{transport, reason}`）；`shouldUseClaudeAgent` 改为它的投影 |
| `lib/stream-frames.js` | 新增 `routeFrame(opts, resume)`，集中维护跨仓库 SSE 契约 |
| `server.js` | 导入 `routeFrame`；`handleStreamChat` 开头发 `route` 帧 + 打一行 `🧭 [线路]` 日志 |

`handleStreamChat` 的两个调用点都是**先 `flushHeaders()` 再进函数**，所以这一帧一定在正文之前到达。

**为什么抽 `routeFrame` 而不是在 server.js 里内联拼对象**：为了让**跨仓库契约可以被测**。字段名改了两边都不会报错，
只会静默显示错的东西 —— 与 `trace`/`bucket_id` 那次漂移是同一形状。

### 前端（`angel-garden-diary`）

`src/chat/ChatScreen.jsx`：

1. 模块级 `ROUTE_LABEL` / `ROUTE_REASON_LABEL`：稳定协议值 → 给人看的词。展示层不出现 SDK/CLI/OpenRouter 术语；
   表里没有的取值原样显示，免得后端加新线前端就白屏。
2. `const [route, setRoute] = useState(null)`。
3. 发送时 `setRoute(null)` —— 上一轮的结论不许残留到这一轮。
4. SSE 循环里加 `parsed.kind === "route"` 分支，**显式 `continue`**。
5. 头部状态区（写手状态那一行的右侧）加一个小胶囊：`--accent-soft` 底 + `--accent-deep` 字，
   用的是随主题走的既有色阶，没发明新颜色。**改道时圆点变淡**（`opacity .45`），一眼看得出「这轮不是默认那条线」；
   原因挂在 `title` 上，不占版面。未收到帧就**不渲染**（不占位、不猜）。

## 测试

`shenyan-backend`：二轮筛查后 **168 / 168 pass**。本次相关的：

- `resolveTransport` 4 条：deepseek 不被报成 api / 每种改道都带结构化原因 / **布尔版永远是 DTO 的投影**。
- `routeFrame` 2 条：**字段集被钉死**（`Object.keys` 排序断言）/ reason 能过 JSON 往返（前端 `title` 要用）。

前端：`npm run build` 通过（108 模块）。

## 二轮筛查撤下的东西

外包稿一度同时实现了 `kind: "context"` 和聊天页 `remembering N%`。二轮筛查已完整撤下，原因不是样式，
而是**口径不成立**：应用层 `raw_estimated_tokens / max_context_tokens` 只描述旧的 Context Assembly 预算；
Claude Agent 原生 session resume 时，真正的会话上下文由 SDK/CLI 持有并可能自动 compact。这两个数不是同一把尺子，
不能把前者包装成「他还记得住多少」。后续若要恢复，只能接 SDK 的真实 `Query.getContextUsage()` 等权威数据。

## 未做 / 未验证

- **未做请求字段**（`transport` 入参）与线路选择 UI。前端目前只能**看**，不能**选**。
- **非流式路径没接**：`/api/chat` 的非流式分支不发 route 帧，前端拿不到就不渲染 —— 是优雅降级，但要知道。
- **没有跑过真机端到端**：本地起后端打一发真消息会写生产库、烧额度，没做。
  验证留到部署后：发一条消息，看头部是否出现「Claude 订阅」，同时看后端日志那行 `🧭 [线路]`。
- **图片 / 委托 MCP 两条改道没实测**：代码上是明确的分支，但没有真发过一次带图消息去确认胶囊变成淡点。
- 前端没有测试框架（`package.json` 只有 dev/build/preview），所以前端那半**只有构建通过**这一层保证。

## 下一步（如果要接 P1 的前半）

做请求字段时，`resolveTransport` 要改成接受一个显式的用户意愿：

- `auto` → 现状（后端隐式选）
- `claude-subscription` → 必须走 Agent SDK；**token 缺失或请求形状不支持时明确报错，不静默改走 API**
- `api` → 明确绕过 Agent SDK

届时 `routeFrame` 要加一个维度：**用户要的** vs **实际走的**，两者不一致时前端得说清楚是哪一种。
现在这版只有后者，所以别急着在前端加"选择"UI —— 那会做出一个说了不算的开关。
