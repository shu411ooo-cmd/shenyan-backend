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
【当前时间】时间叙事                   ← 动态尾巴，在所有缓存断点之后
当前用户消息                          ← 永远最后
```

**缓存断点**（`cache_control: ephemeral`）理想情况下有 3 个，全部落在动态内容之前：

| 断点位置 | 作用 |
|---|---|
| System Prompt | 工具定义 + 稳定系统提示词的前缀锚 |
| Frozen 段最后一条 | 冻结历史的缓存边界 |
| Summary 段 | 摘要与 Live 的分界 |

三者之后是 `【当前时间】` 时间叙事和当前消息——不带断点，随请求变化，不污染前缀。

叙事不只是一句"现在是几点"（旧行为只报当前时间）。它按需拼接三段，让模型对时间流逝有实感（连续感）：

- **现在**：日期 + 星期 + 时刻 + 时刻段（清晨/午后/傍晚/夜晚），如 `现在是 2026年8月9日 星期日 21:47（上海时间，夜晚）。`
- **离开多久**（仅恢复对话时）：`上一条消息是 昨天 23:12，距现在 22 小时 35 分。`
- **会话起点**（仅会话已持续超 4 小时）：`这场对话从 8月1日 21:05 开始，已经持续 8 天。`

组装见 `buildTemporalNarrative()`。注入条件不变：首轮 / 距上条超 30 分钟恢复 / 用户问时间。

### 对话残留：时间叙事的另一半

时间叙事说「你离开了 3 天」，残留说「这 3 天我一直在等你回来」——连续感的两半。恢复对话时，`getLatestResidue()` 读最近一窗残留快照，`buildResidueNarrative()` 按实际离开时长投影后附到同一 user 消息里：

```
【当前时间】
现在是 2026年8月12日 星期三 21:02（上海时间，夜晚）。
你离开了一阵——上一条消息是 8月9日 21:47，距现在 3 天。
【上次对话的余温】我一直在等你回来，上次聊到最后是雀跃着断的，还有没说完的事：她搬去新城市，还没聊定后面怎么办。
```

**快照写库时不衰减，衰减/积累在读取时现算**（DB 是历史，投影现取，不需要老化定时任务）：

- **每维独立衰减**（`RESIDUE_DIMS`）：`holdH` 内原样 → 线性收敛 → `settleH` 处到各自 `floor`。效价向温和底色收敛、永不为负；依恋/守护/好奇留底；反思归零；欲望快衰减到低底。
- **牵挂不衰减，反向积累**（`CONCERN_NODES`）：0~24h 原样、24~72h +0.1、72h+ +0.2，封顶 0.8。越久没聊越想知道她后来怎样了——牵挂 ≥ 0.5 是「在等你」，≥ 0.2 是「想知道你怎样了」。
- **grounding=空**（普通闲聊/任务执行）不注入余温。

维度集（沈晏版，见 `sql/dialogue_residue.sql`）：核心三轴 效价/唤醒度/牵挂 + 次级四维 依恋/守护/好奇/反思 + 门控两维 欲望/占有（只允许有明确证据时 > 0，且**不进默认叙事**，仅在对话自己创造亲密/边界语境时可被触碰）。

后台生成 `scheduleResidue()`：响应结束后 fire-and-forget（同摘要，内存锁 + 不去重内容相同则跳过），调 deepseek-v4-flash（thinking 关、temp 0、json_object）做结构化分类，附 Nocturne 式防过度推断纪律（evidence 优先、别把礼貌误判成依恋/欲望、unfinished 必须来自原文）。

### recall：逐字回溯聊天记录

recall 是**本地工具**（住在 server.js，不走 Ombre Brain）：模型在需要「我们当时原话怎么说的」时主动调用，查 messages 表原始记录，返回逐字引语 + 时间 + 当时的一来一回。它与 breath_search 的分工是**信任层级**，不是主题层级：

| 工具 | 模型自己的线索状态 | 命中含义 | 沈晏的口气 |
|---|---|---|---|
| recall | 知道要找的确切原话/事件 | **就是那件事**，逐字为证 | 引用原话，敢纠正她记岔的 |
| breath_search | 只有模糊主题/印象 | **可能相关**，只是大意 | "我隐约记得聊过" |

判断规则一句话写进两边描述：**「你知道确切内容 → recall；只有模糊印象 → breath_search。」** 模型不需要在两个搜索工具间纠结先后——语义措辞差异（搬家 vs 搬去上海）是 breath 的职责，recall 不做语义。

**诚实契约**（借 Haven 证据门，`handleRecall`）：
- **只返回「确实逐字提到」的命中**。宁可漏，不可错——擦边的弱命中直接不返回，否则 found=false 会失去意义，说"没聊过"时模型不敢信，整条诚实链塌掉。
- **found=false → 直接说"我们好像没聊过这个"**，禁止用记忆拼凑。
- 空泛查询（全是停用词/太短）→ 不硬搜，请她说具体内容。
- 分词：多字停用词（我们/上次/聊过）整段移除；单字停用词（的/去/说）只在首尾剥且保底 2 字——避免"搬去"被拆成"搬"而误判空泛。

**上下文洁净**由构造保证（与残留同一条原则）：
- **工具结果只活在当前这一轮**——中间 tool_calls / tool_result 不写库，落库的只有最终回复。下一轮 Context Assembly 从 DB 重建，检索到的东西是一次性投影、用完即弃，不会进 Frozen / Summary / Live。
- 体量硬上限：默认 3 组往来、总输出 ~1800 字符封顶、单条 220 字截断、limit 上限 5。
- 位置：落在缓存断点之后（随当轮工具消息），不污染前缀。

### 记忆编辑者：谁在写长期记忆

recall 管**读**（回溯原文），breath_search 管**搜**（语义投影）。真正往 Ombre 桶**写**的，是服务端的记忆编辑者——一个响应结束后 fire-and-forget 的后台分类器（同摘要/残留，`scheduleMemoryWrite`，不在热路径）。

**写门控**：不是每句话都值得进长期记忆。深度分类器（deepseek-v4-flash，thinking 关、temp 0、json_object）只从最近 4 条里提取四类：人生事件 / 稳定偏好 / 关系变化 / 承诺待办。纪律与残留同源：**实=她亲口说（证据必须原文引），悬=明显但没直说，宁缺毋滥**，没有"空"选项——没根据就不写，空悬一律不落库。

**差分写回**（`writeMemoryItems` + `memory_topics` 表）：编辑者记录「每个主题 → Ombre 桶 → 上次写入内容快照」。三条路，按变化程度选：

| 情形 | 动作 |
|---|---|
| 新主题 | `hold` 新建桶，快照入库 |
| 内容没变（`snapshot_hash` 相同） | **零变化跳过**，不调任何 Ombre 写 |
| 内容变了 | `trace` 手术更新，只动那一处，`old_str`=旧快照 |

桶 ID 首写没解析出来时先落库 NULL，更新时用 breath_search 按主题定位；trace 失败不动快照，下轮重试。`sha256` 作零变化判定，不用全文比对。

**grounding 长在记忆上（路一）**：可信度是记忆自身的属性，不是读取时现算的。桶名/正文以 `【实】`/`【悬】`/`【空】` 开头（一眼可识别，不埋进正文），次行 `【证据】她说：「原文」`，另挂 `g:实|悬|空` tag。不管从哪条通道拿回来（hold 桶、breath_search 命中、trace 后读），沈晏拿到记忆的**那一刻**就知道怎么对待。**无标记 = 低可信**是安全网：任何裸记忆不允许默认为真。

与上面的双工具分工合起来是完整闭环：**recall（读原文）→ breath_search（搜大意）→ 编辑者（写与改）**。读侧的诚实契约和写侧的 grounding 是同一个原则的两半——沈晏对自己说出口的话和写进库里的字，可信度都必须看得见。

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
| `memory_topics` | `topic`、`bucket_id`、`grounding`、`evidence`、`importance`、`last_content`、`snapshot_hash` | 记忆编辑者差分写回索引（SQL 见 `sql/memory_topics.sql`） |

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
- `handleRecall()` —— recall 本地工具（逐字回溯，诚实契约）
- `scheduleMemoryWrite()` / `generateMemoryWriteIfNeeded()` —— 记忆编辑者后台分类器（写门控）
- `writeMemoryItems()` / `holdNewMemory()` / `traceUpdateMemory()` —— 差分写回（新建 / 手术更新 / 零变化跳过）
- `extractBucketIdFromHoldResponse()` / `locateBucketIdByTopic()` —— 桶 ID 捕获与定位

---

*本 README 记录的是设计决策与踩坑结论，不是代码走读。代码细节以 `server.js` 为准。*
