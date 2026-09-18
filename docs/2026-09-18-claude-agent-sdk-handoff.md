# 2026-09-18 交接：Claude Agent SDK 会话层审计 —— 写给 Codex

> 写给下一位接手者（Codex）。你在这棵树上做到一半限额了。**这份文档第一件事是告诉你哪些行被动了，别覆盖。**
> 上下文：这套三层系统（Agent SDK 原生 Session + Supabase 长期记忆 + thinking summary）**今天才从 OpenRouter API 切进来**，你写的是第一天。
> 权威现状以本文 + 代码注释为准；本文只增量。
>
> **本文件写过两轮。** 第一轮是会话层审计（§〇–§二、§四–§六）。第二轮补了 **§2.5 的 system 消息观测**和 **§三末尾的「平台事实」** —— 后者是**全新知识**（SDK 自己到底记了什么，实测出来的），接手前值得先读那一节。
> 本文所有技术断言都附了来源：SDK 类型定义的行号、Supabase 里的实测行、或外部仓库。**带「未定」字样的就是没定论，别当结论用。**

---

## 〇、先看这里：这棵树被谁动了

你的未提交改动**没有丢，也没有被回退**。我（Claude）在同一批文件上继续做了审计 + 修复，并且在你的代码里**只重写了 `pruneExpiredSessions` 一个函数**。

| 文件 | 谁写的 | 说明 |
|---|---|---|
| `lib/claude-session-store.js` | 你的 + 我重写 `pruneExpiredSessions` | 见 §2.1、§三 |
| `server.js` | 你的 + 我改了 **2 处日志** | `finishClaudeAgentSession`（§2.2 / §2.5） |
| `test/lib-claude-session-store.test.cjs` | 你的 + 我扩了假 Supabase、加 2 测试、改了 1 个测试名 | 见 §2.3 |
| `lib/claude-agent.js` | **我新增两处**（你原本没动这个文件） | `detectSessionFork`（§2.2）+ system 消息观测（§2.5） |
| `test/lib-claude-agent.test.cjs` | **我新增 1 测试** | 见 §2.3 |
| `migrations/2026-09-18-claude-agent-session-retention.sql` | 你的 | **原样未动** |
| `public/index.html`、`public/assets/index-*` | 你的（前端构建产物） | 我按程芥的要求**一个字节没碰** |
| `_probe-agent-sessions.cjs` | **我新增**（被 `.gitignore:32` `_*.cjs` 忽略，不会进提交） | 只读探针：查线上会话 / 索引 / 断头风险，见 §六 |
| `_probe-agent-transcript.cjs` | **我新增**（同样被忽略） | 只读探针：看 SDK transcript 记了什么，见 §三「平台事实」。**只打结构不打值** |
| `_probe-agent-snapshot.cjs` | **我新增**（同样被忽略） | 要订阅 token 的探针，**未跑过**；主问题已被 §三 用查库解决，多半用不上了 |

> 探针脚本都沿用仓库既有的 `_*.cjs` 一次性约定（`.gitignore:32` 那条通配），**不会意外进提交**。要长期留着就 `git add -f`。

**结论：现在这棵树 = 你的 3/4 + 我修的 1/4，逻辑上是一份完整自洽的改动。** 你要继续做的话，请**基于当前工作区**，不要从 `836aa39` 重来——那会把修好的 P0 覆盖回去。

---

## 一、你写对了的部分（我一个字节没动，别改回去）

1. **`sessionRetentionMs` 的 env 门控语义**（`lib/claude-session-store.js:113`）
   `0 / 负数 / 非法 → null = 不清理`，默认 90 天。没有把「关闭」和「默认值」搅在一起，`0 = 关闭`这个口径很干净。

2. **「开轮前先消费掉 link、本轮落库成功才写回」**（`server.js:3323` `prepareClaudeAgentSession`）
   这是整套设计里最关键的一条纪律：**进程崩了 / mirror 失败 → 不留悬空可续接指针 → 下轮自动退回完整上下文**。fail-safe 方向正确，比「先写回再跑」强得多。

3. **`/health` 的可观测性三件套**（`server.js:4865`）
   `release` + `claudeAgent{configured,enabled,activeQueries,maxConcurrency}` + `claudeAgentSessions{enabled,retentionDays}`。
   `detectReleaseCommit` 走 env → `git rev-parse` 兜底，容器里没 git 也不会崩。正是审计 F 项要的东西。

4. **`hasSession` 预检**（`lib/claude-session-store.js:66`）
   「不拿一份已经不存在的 transcript 去开 resume 轮」——方向对。

5. **三条测试**：key 归一化、UUID 幂等、env 开关。断言写得实。

---

## 二、我动了什么（逐处，附理由）

### 2.1 【P0 修复】`pruneExpiredSessions` —— 从「按行年龄删」改成「按会话最后活动删」

- 文件：`lib/claude-session-store.js:121-218`，新增常量 `PRUNE_SCAN_LIMIT=500` / `PRUNE_MAX_SESSIONS=50`（`:123-124`）
- 你原来的写法是：

  ```js
  supabase.from(TRANSCRIPT_TABLE).delete().lt('created_at', since).select('id')
  ```

  **按条目年龄删行。**

**为什么这是必炸的，不是理论风险：**

前端的设计是「**所有 session 连成一条线、永不新建 id**」。所以**单个 app session 会活得比保留期长**，它的 transcript 天然是「头旧尾深」。

于是 90 天一到，那个还在天天用的会话，**头 90 天的条目被删了，尾巴还在**：

- `hasSession()` 只问「这个 session_id 还有没有行」→ 有 → **返回 true** → 预检放行
- 于是此后**每一轮**都拿一份**断头 transcript** 去 resume（SDK 的 `parentUuid` 链根缺失）
- 既不抛错、也不降级到 fresh —— **静默地、每轮都错**

这是最难查的一类故障：日志全绿，`mode=resume` 照打。

**修法**：保留期的单位是**会话**，不是行。四步有界扫描：

| 步 | 做什么 |
|---|---|
| ① | 扫出「至少有一条早于 cutoff 的条目」的会话做候选（`created_at` 升序，先收最该收的） |
| ② | **逐个确认整会话过期**——只要还剩一条不早于 cutoff 的条目就不动它（活跃长会话走这条） |
| ③ | 整会话删干净：transcript 全量 + 指向它的 link（一起删，不留悬空映射） |
| ④ | 单独收**悬空 link**（transcript 早已不在、映射还在——mirror 半途失败的遗产）。这类永远进不了 ①，因为没有 transcript 行就没有候选 |

四步都**有界**：清理跑在 15 分钟循环里，宁可分多次 tick 慢慢收，也不能拖住事件循环。

### 2.2 【P1 观测】`detectSessionFork`

- 文件：`lib/claude-agent.js:284`（定义）、`:385`（使用）、`:394`（返回 `resumed`/`forked`）
- `server.js:3366` 那行日志追加 `forked=true` 与 `think=<字数>`

**要解决的问题**：`mode=resume` 只说明我们**请求**了 resume，**不说明 SDK 真续上了**。续不上时 SDK 会悄悄开一条新血脉，光看 `mode` 永远发现不了。

所以：resume 成功时 SDK 必须回**同一个** `session_id`；不同 = 分叉。**只记日志，不干预行为**——本轮回答照样正确，`saveSessionLink` 照常写新 id，下一轮起用新血脉续。

这条同时是 §4 那个潜伏 bug 的**唯一探测器**。

### 2.3 测试

| 位置 | 内容 |
|---|---|
| `test/lib-claude-session-store.test.cjs:131` | 改了**测试名**（旧名说的是「只删早于 cutoff 的行」，语义已变成会话级，留着会误导下一个读的人）；断言未动 |
| 同上 `:155` | **新增**：活跃长会话（头旧尾新）绝不被截断 —— §2.1 的回归测试 |
| 同上 `:178` | **新增**：悬空 link 单独清除 |
| 假 Supabase | 扩展支持 `.lt/.gte/order/limit/列投影`（原来的替身撑不住新查询形状） |
| `test/lib-claude-agent.test.cjs:51` | **新增**：`detectSessionFork` 四例（续上/分叉/fresh轮/拿不到id），保证不误报 |

**`npm test` → 151/151 通过**（你原基线 148）。

### 2.4 一个工具坑（**同一场里连中三次**，你多半也会踩）

**症状**：在源码 / 文档里写 `\u0000` 这类控制字符转义，**编辑工具会把它当成真字节写进文件**。

- **第一次（代码）**：`lib/claude-session-store.js` 里我用它做去重 Map 的键分隔符 → 真 NUL 落盘 → **git 把整个 `.js` 判成二进制**（`git diff` 显示 `Bin 4148 -> 9803 bytes`，`numstat` 也是 `-`）。
  修法：改用 `JSON.stringify([projectKey, sessionId])` 组合键（`:153`）。
- **第二次（文档）**：**同一份交接文档里，我为了描述这个坑又打了一次** → 又一个真 NUL 落盘。在 Markdown 里它显示成**一片空白**，肉眼几乎看不出来，只有 git 判成二进制或 `od` 才露馅。
- **第三次（写这份文档的 Edit 调用）**：我把那六个字符写进 `old_string` 想匹配它，结果**工具入参的 JSON 又把它解析成了真 NUL**，匹配失败。
  → 同一件事在 **「文件内容」** 和 **「工具入参」** 两个层面都会咬人。

**自查一行**（这一行本身就含那个转义，所以只在这里出现一次）：

```bash
tr -dc '\000' < 文件 | wc -c     # 非 0 = 中招了
```

**修法**：只能用脚本 —— 用 `String.fromCharCode(0)` 定位真 NUL，替换成那六个字面字符。
**Edit 工具处理不了这种文件**：`old_string` 里你没法输入真 NUL；而想匹配那六个字面字符，又得在入参里把反斜杠再转义一层 —— 正是第三次踩的那一脚。

> **结论：别在任何源码或文档里写控制字符转义。** 需要分隔符就用 `JSON.stringify([a, b])`，或一个确定不会冲突的普通字符串。

### 2.5 【观测】接住三类 `system` 消息 —— SDK 主动报的事实，以前全被丢掉了

- 文件：`lib/claude-agent.js` 的消息循环（`for await (const message of query(...))`）
- `server.js:3366` 那行 🧵 摘要追加 `auth=` 与 `compact=`

原来循环只处理四种消息：`stream_event` / `system`+`mirror_error` / `assistant`（带 error）/ `result`，**其余一律丢弃**。被丢掉的里面有三种是 SDK 主动呈报的事实：

| 消息 | 现在打出来的日志 | 为什么重要 |
|---|---|---|
| `system/init` | `⚙️ [Claude Agent] auth=… cli=… model=… slash=N（含 compact / 无 compact）` | **`apiKeySource` 是唯一能证伪「这一轮真走了订阅线」的信号**（`'none'` = OAuth/订阅线；出现别的字样 = 被别的凭据接管）。`slash_commands` 顺带回答 `/compact` 可不可用 |
| `system/compact_boundary` | `📦 [Claude Compact] trigger=auto pre=… post=… ms=…` | SDK 自己的上下文压缩就发生在这里；`trigger` 区分 auto / manual |
| `system/status`（带 `compact_result`） | `📦 [Claude Compact] result=success\|failed error=…` | 压缩的收尾判定，失败原文必须留痕 |

**为什么这条是「唯一的口子」**：实测（见 §三「平台事实」）—— transcript 里**根本没有 `system` 类条目**。SDK 压缩过上下文这件事，**永远不会出现在镜像进 Supabase 的那批条目里**。不接这三类消息，两套压缩就是彻底互相不可见的（这正是审计 G 项的根源：不是设计冲突，是信号没接）。

返回对象新增 `initInfo` 与 `compactions` 两个字段（纯加法，不影响既有调用方）。**只加日志，零行为改动。**

> 来源：`sdk.d.ts:5556`（`apiKeySource`）/ `:2801`（`slash_commands` 所在的 init 消息）/ `:3508`（`SDKCompactBoundaryMessage.compact_metadata`）/ `:5534`（`SDKStatusMessage`）。

---

## 三、审计结论（已判完，你不用重跑）

### 三层职责

| 层 | 判定 |
|---|---|
| `messages` | **清晰**。唯一可见对话事实源，thinking 也挂在这张表。 |
| Agent transcript | **基本清晰，有一处浑浊**。定位是「可重建的续接缓存 + 工具轨迹」，读写只经 `SessionStore`，从不被当事实源读回。但动态注入块以 `user` 角色沉淀进去，使它兼任了「背景材料垃圾场」（见下 P1）。 |
| 长期记忆 | **清晰**。summary / attention / world book / residue / memory topics 全走 `messages` + 记忆表，Agent SDK 完全不碰。 |

### 审计 A–H 逐项

| 项 | 结论 |
|---|---|
| **A** 三层职责 | 边界是对的。唯一要动的是 transcript 的**保留口径**（已修）。 |
| **B** 动态注入进 transcript | **会积累**。七类块（time / residue / weather / calendar / attention / world / device）都以 `user` 角色进 transcript，而「背景不是用户新说的话」那句说明**只在当轮 prompt 头部、不随块走**。缓解靠块自带【】标签 + stable prompt 里逐条点名的【背景纪律】——**是软的**。SDK 自动 compaction 会把这些块当 user 原话一起压。**未修，属语义改动，需程芥定方向。** |
| **C** 生命周期 | fresh / resume / model-change / missing-transcript / rebuild / degraded 六态已覆盖。缺口三个：resume 悄悄分叉不可见（**已补**）、过期口径错（**已修**）、无显式 close API（靠 `clearSessionLink`）。 |
| **D** 并发 | 全局 `CLAUDE_AGENT_MAX_CONCURRENCY` 默认 **1**，同一时刻只有一条 agent 查询 → **工具副作用不会并发重复执行**。同会话连发两轮：第二轮 prepare 时 link 已被第一轮消费 → fresh，且 `acquireSlot` 会 429。残留风险 = **用户消息已落库但没回复**（429 前 `messages.insert` 已执行），前端需要能重试。 |
| **E** thinking | 只取 SDK 正式提供的 summarized（`thinking_delta`），**不碰隐藏 CoT** ✅。三层开关：前端 `opts.thinking='off'` / 服务端 `CLAUDE_AGENT_THINKING_DISPLAY=omitted` / `CLAUDE_AGENT_ENABLED`。落库 `messages.thinking` 与 `keepsakes.his_thinking`，**随 session 走、无独立保留期**，与 messages 同寿。 |
| **F** 可观测性 | `/health` 三件套 + 每轮 `🧵 [Claude Session]` 一行（mode + sdk 短哈希 + forked + think 字数）。工具 `🔧 name= state= ms=`。**但注意**：`🔔 [注意力]`、`🧩 [动态注入]` 等既有日志里**确实记录了正文片段**（注意力前 180 字、`last_msg` 前 40 字）——那是既有记忆系统的观测，不在本次范围。 |
| **G** compaction 重复压缩 | **不会互相污染数据**（SDK 的 compaction 只写进它自己的 transcript，不进 `messages` / `summary_segments`），但**会重复压缩同一段历史**：应用侧把旧轮压成 summary 段继续发，SDK 侧又把同一段压成它的摘要。代价是重复 token + 两套口径可能对同一件事给出**不同表述**。**根源不是设计冲突，是信号没接**——SDK 压缩时会发 `compact_boundary`，而你们的循环把它丢了（**已补，见 §2.5**）。**口径本身仍未修，需程芥定方向**，但要先等 §2.5 的日志跑出真实数据。 |
| **H** 每轮 Context Assembly 成本 | `buildMessages` 每轮**全量跑**，即使本轮是 resume、最终只发 `agentTurnMessages`。真正的浪费：`fetchSessionHistory` 分页拉全量 + frozen/summary/live 三段构造 + 三次全量 sha256，**全部丢弃**。**但不该草率跳过**——`request_stats` / 成本账本 / 后台塌缩触发器都读它。另有一个口径问题：resume 轮的 `estimated_tokens` 报的是「如果走 OpenRouter 会发多少」，不是本轮真实上下文，**会高估**。**未修。** |

---

### 平台事实 —— 实测（附来源）

**怎么测的（重要，可复用）：不用 token、不花额度、不部署。**

SDK 文档说系统 prompt 的快照是「recorded **in the session transcript**」（`sdk.d.ts:2200-2285` 的 snapshot 文档块），而 transcript 就镜像在 Supabase 的 `claude_agent_transcript_entries` 里 —— **那就直接只读查库**。
工具：`_probe-agent-transcript.cjs`（**只打结构、不打任何字段值**，人格 prompt 与对话原文一个字都不进日志）。

#### 事实 1：`systemPromptSnapshot` 在你们账号上**确实生效**

库里躺着三条 `prompt_snapshot` attachment：

| id | 轮次 | attachment type | `systemPrompt` 长度 |
|---|---|---|---|
| 10 | 第 1 轮（fresh） | `prompt_snapshot` | **3958** |
| 13 | 第 1 轮 | `prompt_snapshot` | **3958** |
| 23 | 第 2 轮（resume） | `prompt_snapshot` | **3958** |

**三轮一字不差 → 录制在发生，而且是被原样重发的。**

推论：`buildStableSystemPrompt()` 你们每轮都调，**只有每个 SDK 会话第一轮那次算数**。人格锚的改动要等到下一次 compaction。

> 来源：行为语义 `sdk.d.ts:2200-2285`（`Options.systemPrompt` 的 `snapshot` 文档块，原话「a different `append` or `prompt` passed on a later launch of the same session is **ignored until compaction or a new session**」）；`systemPromptSnapshot` 字段类型 `sdk.d.ts:4235`。实测：`claude_agent_transcript_entries` id=10 / 13 / 23。

**⚠️ 但别急着把它当 bug 去修。** 第三方独立确认了它为什么是默认行为：

> `tsuru0805/api-to-claude-code-p`：「同一 sid 连续 resume、system 不变、模型不变 → cache_read ~99%」
> 「**换 system / 换模型 / 换 MCP 工具表 = 整条缓存作废**，下一轮全量重写 —— 把这类变更**攒到低峰期一起做，不要聊着聊着热切**」

所以 `{ type:'custom', prompt, snapshot:false }` **不是解法**（每改一次炸一次缓存，而且带 thinking 时会丢弃模型已有的推理链）。真正要设计的是「**人格改动在哪个时刻落地**」，而 compaction 正好是个天然的落地时机。**这条留给程芥定方向。**

#### 事实 2：系统内置 prompt **只剩一句话**

```
cliPrefix = "You are a Claude agent, built on Anthropic's Claude Agent SDK."
```

就这 64 个字符。**你们的 `systemPrompt` 字符串几乎完全替换掉了 Claude Code 的内置 prompt。**

对照：`tsuru0805/api-to-claude-code-p` 警告过 `--append-system-prompt` 的染色问题 —— 「你的 prompt 前面垫着一整段『你是一个 CLI 工具』，对聊天型应用是明显的染色」。**这个在你们这儿没有发生。** 你们设的 `settingSources: []` / `skills: []` / `plugins: []` / `tools: []` 是有效的，前面只垫了这一句 SDK 通用开场白。

> 来源：`prompt_snapshot` attachment 的 `cliPrefix` 字段（实测）。语义来源 `sdk.d.ts:2285` —— `systemPrompt` 传 bare string 等同 `{ type:'custom' }`，是**替换**不是追加；要追加得写 `{ type:'preset', preset:'claude_code', append }`。

#### 事实 3（**未定**）：第 1 轮的 `tools` 是**空的**

| id | 轮次 | `tools` |
|---|---|---|
| 10 | 第 1 轮 | 键都不存在 |
| 13 | 第 1 轮 | **空数组 `[]`** |
| 23 | 第 2 轮 | **完整 24 个**（15824 字符，第一个 `mcp__shenyan__anchor`） |

这正好撞上 `api-to-claude-code-p` 的**坑 1**：「`--mcp-config` 连接是**后台异步**的，工具偶发不可见，**无报错**」。

**但我不下结论** —— snapshot 是在哪个时刻抓的没有确认（id=10 那张连 `cliPrefix` 都没有，明显是更早的一次抓取）。

**如果为真，后果不小**：每个新 SDK 会话的**第一轮，他调不了任何工具**。那次线上验证之所以过，是因为 `want_list` 落在了第 2 轮。

**怎么定案**：部署后看 §2.5 那行 `⚙️` —— `init` 消息里带 `mcp_servers` 的状态，对一下就清楚了。

#### 事实 4：transcript 里**没有 `system` 类条目**

30 条的 type 分布：`queue-operation` ×4 · `user` ×3 · `attachment` ×10 · `atis-latch` ×2 · `ai-title` ×2 · `assistant` ×5 · `last-prompt` ×3 · `mode` ×1。
`attachment` 的子类型：`environment` / `model` / `total_tokens_reminder` / `session_context` / `date` / `prompt_snapshot`。

→ **`compact_boundary` 这类消息永远进不了这张表。** SDK 压缩了上下文，你们不可能从库里发现。**§2.5 那条日志是唯一的口子。**

#### 事实 5（副产品，未探）：SDK 每轮塞一条 `total_tokens_reminder`（94 字节）

SDK 自己在提示 token 水位。可能是个**现成的、便宜的水位信号** —— 没细看，留个记号。

---

### 外部参考（程芥给的，附我的判定）

| 来源 | 是什么 | 判定 |
|---|---|---|
| **「潮汐 / rolling compact」**（程芥提供的方案文档） | 基于 **Claude Code CLI**（`--input-format stream-json` + stdin 喂 `/compact` + `SessionStart` hook）的常驻会话记忆整理术 | **架构不是你们这一套**（你们是 SDK `query()`）。但它列的三条判据对你们成立：① 水位要量真实的；② 压缩必须和账本**同时**动；③ 压缩对用户必须不可见（你们天然满足，`messages` 永不删）。**它踩过的「推理模型做摘要会吞答案进思维链」这个坑，你们已经踩过——同一个坑，说明它是结构性的** |
| **`tsuru0805/api-to-claude-code-p`**（MIT，10 star） | 《把自建聊天后端从 Anthropic API 迁到 Claude Code 订阅线》教程 + 4 个教学件 + 38 测试 | **最有价值的一个。** 直接回答了「要不要为了 `/compact` 上常驻进程」：**不要** —— 作者主张「从①每轮短命进程起步，延迟不可忍再升级②」，理由是「②引入的是一整类新问题，不是一个新参数」，且真要上②应**优先用 Agent SDK 而非手搓 stdin**。另外三条可直接查：**同 sid 必须串行化**、**env 白名单而非黑名单**、**失败轮作废 sid**（这条你们已经做对了） |
| **`dankefox/swap-tutorial`**（**AGPL-3.0**，61 star，**零代码，只有 README**） | 「精炼续窗」：CLI 层读 `~/.claude/projects/<hash>/*.jsonl`、正则打分筛事件、重写 `uuid`/`parentUuid` 链、生成可 `--resume` 的新会话 | **名字是假朋友** —— 「Swap」在此指记忆库快照回滚，「换窗」才是会话续接，跟鉴权互换无关。**AGPL-3.0：概念可借，代码不能抄。** 但它的四层架构（桥接层 / 启动层 / 耐久层 / 证据层）与你们现有的 live 段 / breath+stable / 记忆表+summary / Archive **几乎 1:1 对上**；有一条你们没有的闸：**毒上下文 fail closed**（检测到策略污染就拒绝续窗） |

---

## 四、⚠️ 一个我查出来但没修的潜伏 bug（在你的文件里）

`createSupabaseSessionStore` 的两个方法**口径不一致**：

| 方法 | 过滤条件 |
|---|---|
| `hasSession(sessionId)`（`:66`） | `session_id` + `subpath` —— **不看 `project_key`** |
| `load(key)`（`:49`） | `project_key` + `session_id` + `subpath` —— **看** |

**后果**：一旦 `CLAUDE_AGENT_PROJECT_KEY`（→ `CLAUDE_CODE_PROJECT_DIR_NAME`）漂移，`hasSession` 放行、`load` 返回 `null` → 拿一份空 transcript 去 resume → **一次静默分叉**。

**没修的原因**：`SessionStore` 的键契约是 SDK 定的（`projectKey` 是契约的一部分），我不敢单方面让 `load` 忽略它；而在 `hasSession` 这边补 `project_key` 需要把 project key 从 `buildChildEnv` 透传到调用点，改动面比收益大。

**现在至少能被发现了**：§2.2 的 `forked=true` 就是它的探测器。**线上盯日志，一旦出现 `forked=true`，第一个怀疑对象就是这里。**

---

## 五、程芥给的边界（别越线，这是他明确交代的）

1. **不改** `SYSTEM_PROMPT`、**不改**鉴权逻辑、**不改**现有记忆抽取规则。
2. **不重写**现有记忆系统。
3. **不抓隐藏原始 CoT** —— 只处理 SDK 正式提供的 summarized thinking。
4. **不抄 AGPL 项目**的代码，只能借鉴概念。
5. **只写幂等 migration 文件，不执行**；**不自动推送、部署、跑迁移**。
6. **不要暂存**：`node_modules/.package-lock.json`、`public/index.html`、`.vscode/`、`public/assets` 下未跟踪文件。
7. 改完必须跑**完整** `npm test`。

### 特别提醒：别把 OpenRouter 路径当死代码删掉

`shouldUseClaudeAgent`（`lib/claude-agent.js:33`）在这些情况下**返回 false**，仍走 OpenRouter：

- 没有 `CLAUDE_CODE_OAUTH_TOKEN`
- `CLAUDE_AGENT_ENABLED=false`
- `deepseek` 模型（测试模式）
- **有图片**（需要原生多模态输入）
- **有 `mcpTools`**（前端 MCP 委托走既有 re-entrant 协议）
- **`resume` 非空**（MCP 续调轮）

**切 SDK 是部分替换，不是全量替换。** 两条路必须同时活着，且 `Context Assembly` 是**两条路共用的**——看起来「resume 轮白跑了」的那部分，正是 OpenRouter 路径和成本账本在吃的东西。

---

## 六、运维状态（2026-09-18 已查清）

### 6.1 ⚠️ `npm run migrate -- --status` 不是只读的 —— 别在接管前用它

`scripts/migrate.js` 里 `wantStatus` 的判断（`:90`）排在**「首次接管」分支（`:75`）后面**：

```js
if (rows.length === 0 && !wantReset) {   // ← 先命中这个
  // 把全部迁移文件基线化为「已应用」，然后 return
}
const pending = files.filter(...)
if (wantStatus) { ... }                  // ← 永远轮不到
```

也就是说，**`schema_migrations` 为空时，`--status` 会把 40+ 个迁移标记成「已应用」并退出，一个状态都不打印**——纯写操作。

**本仓库的接管仪式已经跑过了**（47 条：46 `baseline-manual` + 1 `cli`），所以现在用它没事。但**别把这个当通用结论**：任何「接管前」的仓库跑它都会静默改状态。要查状态就用只读 SELECT（见 `_probe-agent-sessions.cjs`）。

### 6.2 retention 迁移：**未应用**

```
✓ 已应用  2026-09-18-claude-agent-sessions.sql            (03:25:53, by cli)
· 未应用  2026-09-18-claude-agent-session-retention.sql
```

`pg_indexes` 里**没有** `idx_claude_agent_transcript_created_at` / `idx_claude_agent_session_links_updated_at`。

**要跑**（程芥拍板，别自己跑）：新的四步扫描里，第 ① 步是
`.lt('created_at', since).order('created_at').limit(500)` —— 没有那个索引就是**全表扫 + 排序**。现在表里才 30 行不疼，但它正是为了「表长大后仍然廉价」才写的。

### 6.3 断头风险：**排除**

线上 transcript **全部 30 条条目都是 2026-09-18 04:23–04:24 产生的**（Agent SDK 今天才接进来），远在 90 天保留期内。

→ **旧版按行删的 `DELETE` 从来没有机会跑过**（那段代码根本没部署，deploy 还停在 `836aa39`）。**没有需要修的数据。**

| 项 | 实测 |
|---|---|
| 条目 / 会话 | 30 条 / **1 个会话**（`e7183f8b-aa9…`） |
| 映射 | `app=527 → sdk=e7183f8b-aa9…`，指向的 transcript 有 30 条 ✅ 无悬空、无孤儿 |
| 时间跨度 | 2026-09-18T04:23:34 → 04:24:00（0.04 天） |

**但注意样本量**：只有 1 个会话、30 条条目。§2.1 那套会话级清理在**生产里从未真正跑过**，只有单测覆盖（`test/lib-claude-session-store.test.cjs:155/:178`）。首次部署后请盯 `🧹` 那行。

---

## 七、部署后盯这几行

```
🧵 [Claude Session] app=<id> mode=resume sdk=<8位> durable=true forked=true auth=none compact=auto think=<n>
                                          ^^^^^^^^^^^^                          ^^^^^^^^^^
                                          出现即重大发现（见 §4）                压缩发生了（见 §2.5）

⚙️ [Claude Agent] session=<id> auth=none cli=<版本> model=<模型> slash=<n>（含 compact / 无 compact）
                            ^^^^^^^^^                                                    ^^^^^^^^^^^^^^^^
                            唯一能证伪「真走了订阅线」的信号（'none'=OAuth）              回答 /compact 可不可用

📦 [Claude Compact] trigger=auto pre=<n> post=<n> ms=<n>
📦 [Claude Compact] result=success|failed error=…

🧹 [Claude Session] 过期清理 transcripts=<n> links=<n> 保留期=90天
                                          ^^^^ 首次上线会删 >90 天的旧会话，属预期
GET /health  →  release / claudeAgent / claudeAgentSessions
```

**重点看两个判据**：
1. **`⚙️` 那行的 `auth=`** —— 只要不是 `none`，就说明有别的凭据接管了请求（会错烧到别的计费线）。
2. **`📦` 有没有出现，以及 `trigger=auto`** —— 这是 SDK 自动压缩**第一次**在你们这儿发生的时刻。出现了才有资格谈 §八 的 G 项要不要动。

---

## 八、没做的事（故意留白，等方向）

| 项 | 为什么没做 |
|---|---|
| B · 动态块沉淀进 transcript | **语义改动**：要么改块的承载角色，要么给块加显式「仅本轮有效」尾注——都会改模型看到的东西，得程芥定 |
| G · 双重压缩口径 | **架构改动**：SDK compaction 与应用侧 summary 要不要共享水位线，是个设计决策。**§2.5 接上信号之后再谈**——先看清它什么时候压、压掉多少（`pre_tokens`/`post_tokens` 现成） |
| H · resume 轮指标虚高 | **口径改动**：`request_stats` 是成本账本的输入，程芥对这块极敏感，不能顺手改。建议方向是给 `diagnostics` 加个 `context_mode` 字段**标注**本轮实际发送模式，**不要改数值口径** |
| 单会话 transcript 体积上限 | 现在只有保留期兜底，连聊半年的会话会无限增长。P2 |

### 第二轮新查出来的留白（都是「已定位、未动手」）

| 项 | 事实 | 该谁定 |
|---|---|---|
| **人格改动的落地时机** | §三 事实 1：系统 prompt 被冻结到下一次 compaction。`snapshot:false` 不是解法（炸缓存）。**要设计的是「人格改动在哪个时刻生效」** | 程芥（产品决策：人格能不能在聊天中途变） |
| **首轮可能没有工具** | §三 事实 3：`tools` 在首轮快照里是空的。**未定**，部署后用 `⚙️` 的 init 消息定案。若为真 → 每个新会话第一轮他调不了工具 | 先定案再说 |
| **同 sid 的串行化是「全局」兜住的，不是「按会话」** | 现在靠 `CLAUDE_AGENT_MAX_CONCURRENCY` 默认 **1** 全局串行。`--resume` **没有并发保护**：两个查询同时 resume 同一会话，消息会**交错写进同一份 transcript**（来源：api-to-claude-code-p）。**一旦有人把这个值调大想着「反正不同会话互不影响」，同一会话的并发就漏了——而且是静默损坏** | 加 per-session 锁，或把「不许调大」写死在注释/校验里 |
| **子进程 env 用白名单重建，别用黑名单删除** | `buildChildEnv` 是 `{...process.env}` + 删三个。将来任何**新的**凭据类变量（`CLAUDE_CODE_USE_BEDROCK`、`ANTHROPIC_CUSTOM_HEADERS`…）会自动漏进去，而黑名单得有人记得去加 | 低风险加固，可顺手做 |
| **成本账本读 `usage`，会漏掉压缩自己的开销** | `SDKResultMessage` 上是两个字段：`usage` = 「**MAIN AGENT LOOP ONLY**、每轮」（`sdk.d.ts:5348`），`modelUsage` = 「整个 query 管道所有调用（**含 compaction**）、streaming-input 会话里累计」，SDK 原话是 **`modelUsage` 才是 "The correct field for token/cost accounting"**（`sdk.d.ts:5352`）。现在 `normalizeUsage(resultMessage.usage)` 读的是前者 → **compaction 自己烧的钱不进账本** | 程芥（动的是成本账本，极敏感）。**先在压缩真正发生之后再做** |
