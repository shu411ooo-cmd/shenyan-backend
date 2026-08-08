# Context Assembly（上下文组装）

> **数据库是历史，上下文是投影。**
>
> **Database History ≠ Model Context。**

这一条是整个设计的根基。数据库里**每条消息永远保留**，Context Assembly 决定的只是"这一次请求，把哪些历史发给模型"。任何设计决策都是这句话的推论：摘要不删原文、冻结边界不重切、预算只是安全上限。

---

## 为什么需要它

1. **窗口有限**：日记会无限变长，模型上下文窗口是固定的。全量发送总有一天爆。
2. **成本线性涨**：全量发送时，每多一轮对话，所有历史重新计费一次。
3. **缓存失效（最隐蔽）**：OpenRouter 前缀缓存要求前缀字节级稳定。如果每次请求都把所有历史原样发出，前缀随轮数增长而变化——**缓存永远不命中**，成本只增不减。

Context Assembly 把历史切成三段，让"可压缩的中间段"被摘要替代，让"最早的段"字节稳定成为缓存锚点，让"最近的段"保持原文。三者各司其职。

---

## 一次请求，模型看到什么

```
System Prompt            ← 稳定，缓存锚点
────────────────────────────────
Frozen  第 1 ~ frozen_until_turn 轮   ← 字节级稳定，缓存命中的根基
Summary 第 X~Y 轮                    ← 被压缩的中间历史，后台生成
Live    最近 live_rounds 轮           ← 模型真正需要"原汁原味"的部分
【当前时间】                         ← 动态尾巴，在所有缓存断点之后
当前用户消息                          ← 永远最后
```

**缓存断点**（`cache_control: ephemeral`）理想情况下有 3 个，全部落在动态内容之前：

| 断点位置 | 作用 |
|---|---|
| System Prompt | 工具定义 + 稳定系统提示词的前缀锚 |
| Frozen 段最后一条 | 冻结历史的缓存边界 |
| Summary 段 | 摘要与 Live 的分界 |

三者之后是 `【当前时间】` 和当前消息——不带断点，随请求变化，不污染前缀。

---

## 关键机制：为什么长这样

### 1. Frozen 为什么"冻死"

`frozen_until_turn` 是**单调边界**：首次跨过阈值（`totalTurns > frozen_rounds + live_rounds`）时写入一次，之后**永不移动**。

- 一旦写入，Frozen 段的字节就固定下来 → 前缀可被缓存复用。
- 如果每次请求都重新切分，前缀字节一直在变，缓存形同虚设。
- 写入发生在热路径且失败只告警不阻断——最坏情况是这轮不缓存，不丢消息。

### 2. Summary 是"范围"，不是记忆系统

`summary_from_turn ~ summary_to_turn` 只标注"第 X~Y 轮被概括了"。原始消息一个不删。

- **覆盖检查**：只有 `summary_to_turn >= liveStart - 1` 时摘要才可信（`summaryFull`）。摘要覆盖落后于中间段，就**不用它**，改为发送中间段原文。
- **降级不静默**：摘要缺失时，中间段原文原样进上下文。宁可多花钱，绝不静默丢掉中间历史。

### 3. 时间戳为什么是 `user` 角色

OpenRouter 会把消息数组里的 `system` 角色消息**提升合并进顶层 `system` 参数**（Anthropic 模型）。如果时间戳放进 `system` 角色：

- 它会被合并进顶层 system → 前缀字节每次请求都变 → **缓存失效器复活**。

所以时间戳以 `user` 角色 + `【当前时间】` 标记，放在所有缓存断点之后、当前消息之前。模型通过标记明确感知当前日期时间，而缓存前缀不受影响。这条是踩坑得出的结论，**未来改回去之前先想想为什么**。

### 4. 摘要为什么后台生成

- 在 `/chat` 回复结束**之后**由 `scheduleSummary()` 触发，**不在热路径**——不阻塞当前回复。
- 防重入：内存锁 `summaryLocks`（`Set`），同一 session 同时只允许一个后台摘要任务。
- 触发条件（满足才生成）：
  1. 中间段存在（`summaryEnd >= frozenUntil + 1`）
  2. 当前摘要覆盖已落后（`summary_to_turn < summaryEnd`）
- 失败处理：生成失败不动覆盖范围，下次请求自动重试。
- **已知局限**：内存锁是单实例假设。多实例部署时可能同时生成两份——结果幂等，无副作用。

### 5. Token 预算

`max_context_tokens` 是安全上限（默认 8000）。估算无 tokenizer 依赖：CJK 字符（codePoint > 0x2E7F）≈ 1 token/字，ASCII ≈ 4 字符/token。

超上限时按优先级裁：**先裁最老的 Live 轮**（Frozen/Summary 不动，保护缓存锚点），摘要缺失时再裁中间段尾部。

---

## 配置与状态：职责划分

| 表 | 字段 | 性质 |
|---|---|---|
| `settings`（session_id='global'） | `frozen_rounds`（默认 10）、`live_rounds`（默认 15）、`max_context_tokens`（默认 8000） | 全局配置 |
| `sessions` | `frozen_until_turn`、`summary_from_turn`、`summary_to_turn`、`summary_text` | 运行状态 |

**注意**：哈希（`frozen_prefix_hash` 等）只用于日志观察，**不进数据库**。不为此增加字段。

---

## 门控范围

| 请求 | 走哪条路 |
|---|---|
| `x-client: angel`（前端二） | Context Assembly |
| 缺 header / 其它值 | 前端一 legacy，行为完全不变 |

**红线：不要把缺 header 的请求默认当成 angel。** 缺失 header = legacy，永不默认升级。每条请求日志记录 `client` 类型，便于核对。

例外：`memory === false`（记忆关闭）时两套前端统一只发当前一条消息，绕过 Context Builder。

---

## 可观测性

每次 Context Assembly 请求输出一行 `[ContextAssembly]` JSON 日志：

| 字段 | 含义 | 健康信号 |
|---|---|---|
| `history_turns` | 数据库里的总轮数 | 只增不减 |
| `frozen_turns` | 冻结段轮数 | = `frozen_until_turn` |
| `summary_present` | 摘要是否可信可用 | 稳定为 true 说明后台摘要跑通了 |
| `summary_range` | 摘要覆盖范围 [from, to] | to 应紧跟 liveStart-1 |
| `middle_raw_turns` | 摘要缺失时原文中间段轮数 | 0 = 正常；>0 = 摘要还没生成 |
| `live_turns` | Live 段轮数 | ≤ live_rounds |
| `messages_sent` / `estimated_tokens` | 实际发送条数 / 估算 tokens | 被 `trimmed_turns` 限制 |
| `trimmed_turns` | 超预算被裁掉的轮数 | 长期 >0 说明阈值该调了 |
| `frozen_prefix_hash` | Frozen 段 sha256（16 位） | **跨请求不变 = 缓存前缀健康** |
| `summary_hash` / `live_hash` | 摘要段 / Live 段哈希 | summary_hash 在摘要更新时变化 |

**缓存命中的验证**：
1. 同一 session 连发两条请求（5 分钟 TTL 内）
2. 两条 `frozen_prefix_hash` 一致
3. OpenRouter 用量页 `cache_read_input_tokens` > 0

---

## 运维与调参

- **缓存下限**（OpenRouter）：sonnet-4-6 前缀 ≥ 1024 tokens、opus-4-6 ≥ 4096 tokens 才会缓存。短前缀静默不缓存，属预期。
- **断点上限**：每请求最多 4 个 `cache_control` 断点。理想情况用满 3 个，别再往上加。
- **想快速验证摘要器**：临时把 settings 的 `frozen_rounds` 调低（如 2）、`live_rounds` 调低（如 3），发几条消息后看日志 `✅ 后台摘要生成完成`。验证完改回。
- **环境变量**：摘要器用 `DEEPSEEK_API_KEY`（独立于 OpenRouter key），模型 `deepseek-v4-flash`。
- **时区**：时间戳固定 `Asia/Shanghai`，不随服务器时区漂移。

---

## 明确不做的事

- ❌ 不删除任何历史消息（数据库是源，上下文是投影）
- ❌ 不在 `/chat` 热路径生成摘要
- ❌ 不引入 Redis / 队列等额外基础设施（内存锁够用）
- ❌ 不把缺 `x-client` 头默认当 angel
- ❌ 不为观察性数据（哈希）新增数据库字段
- ❌ 不把时间戳放进 stable system prompt / system 角色

---

## 相关代码位置

全部在 `server.js`：

- `buildModelContext()` —— 核心组装
- `buildMessages()` —— 门控路由（memory off / angel / legacy）
- `scheduleSummary()` / `generateSummaryIfNeeded()` —— 后台摘要
- `summarizeViaDeepSeek()` —— DeepSeek 摘要调用
- `getContextConfig()` / `getSessionState()` —— 配置与状态读取
- `estimateTokens()` / `sha256()` / `withCacheControl()` —— 工具函数
- `/chat` 与 `/api/chat` 路由 —— `x-client` 头读取与 `scheduleSummary` 挂钩

---

*本 README 记录的是设计决策与踩坑结论，不是代码走读。代码细节以 `server.js` 为准。*
