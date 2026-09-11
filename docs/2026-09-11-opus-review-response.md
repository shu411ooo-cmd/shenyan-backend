# 复查回复 · server.js 分区第 3 步第五片（`memory`）

**日期**：2026-09-11
**回复对象**：`docs/2026-09-11-review-for-opus.md`
**谁审的**：Opus
**纪律**：只查不修。`lib/`、`server.js`、spec、基线一个字没动；没写库、没碰 `.env`、没部署。
实测用的是 scratchpad 里的一次性脚本（假 supabase + 桩，不联网），没进仓库。

---

## 结论先行

1. **搬迁本身是等价的。** 我独立复核了一遍：十条比对路径（五片 × `--rev`/`--module`）重跑全绿，`npm test` 121/121，
   删行审计也重做了（见 §0）。32 个注入名的接线我手工逐个核过（见 §2-a）。**这一刀没搬坏。**
2. **但现在的工作区不能原样提交**：报告写完之后，有另一批**不属于分区**的改动混进了 `server.js`（见 §0）。
3. **覆盖面有真缺口**：`writeMemoryItems` 有 9 条真分支没有任何向量压到；我实测了，其中 **7 条的现状行为有问题**
   （全是搬迁前就有的，不是搬坏的）。最重的一条违反了 08-30 程芥的裁决「证据可废止不可撕掉」（§3）。
4. **`attention is not defined` 是必崩点 —— 同意，而且证据比「静态推断」硬**：基线自己就把这次崩溃录下来了（§1）。
5. **fail-closed 那条**：我的技术判断是**应该修**，而且它不像报告里写的那样是个真正的两难（§4）。

---

## §0 新发现：工作区已经不是报告描述的那个了

- 报告写于 16:23，写的是「相对 HEAD `f7e49da`，server.js 5903 行，删 1226 / 加 62」。
- 现在 HEAD 是 **`2c259b8`**（17:12「记忆系统运维收尾」），`server.js` 在 **17:08** 又被改过：**5921 行，删 1229 / 加 83**。
- `2c259b8` 那条提交**没有带上 `server.js`**，但它的提交说明里列的两件事，实现就躺在 `server.js` 的工作区里：
  - `checkInjectionsLedgerHealth()`（台账健康检查，+16 行，外加启动时调用 +2 行）
  - `graduateThoughts` 从写 `kind` 改成写 `drive_category`（3 行）

**我重做的删行审计**：1229 行被删，1223 行逐字出现在四个新模块里；没命中的 6 行 =
3 行 `currentWeather`（报告已登记）+ **3 行 `graduateThoughts`（没登记，因为那不是分区的改动）**。
所以：**分区那部分依然干净**，但提交时如果 `git add server.js` 一把梭，就会把一次行为改动夹带进一个自称「零逻辑改动」的重构提交里。

⚠️ **部署顺序依赖**：`graduateThoughts` 现在往 `desires.drive_category` 写。
迁移 `migrations/2026-09-11-desire-drive-category.sql` 没跑之前就部署 → insert 报「列不存在」→ 走 `continue` →
**念头毕业静默失败**（只有一行 warn）。这是这个项目第 N 次踩「带不存在的列会静默失败」。

👉 **建议**：拆成两个提交（`git add -p`）—— ①「运维收尾」的三处 server.js 改动，跟它的迁移放一起；② 分区第五片。
部署前先跑迁移。这件事我没动手，等她定。

---

## §1 回答 Q5：`attention is not defined` —— 同意，是活跃路径上的必崩点

**证据不只是声明域**：`test/fixtures/context-build.baseline.json` 里 `build_attention_hit.threw` 就是
`"ReferenceError: attention is not defined"` —— 这是**搬迁前的代码**跑出来的。
`lib/context/build.js:389` 的 `const attention` 活在 `try` 块里，`:407` 在块外读它；
`(attention && …)` 读一个无法解析的标识符会直接抛，不会得到 `undefined`。

**路径**：`POST` 聊天 → `handleChat` → 先把她这条消息 **insert 进 messages** → `buildMessages`
→（`client === 'angel'`，就是正在用的 v2 前端）→ `buildModelContext` → 抛 →
外层 catch 给前端回 `error: "attention is not defined"`。
**用户看到的**：发出去的话存下了，他没回，冒一个报错。
**触发条件**：任何一轮提及闸/牵挂闸真的命中（`getAttentionMaterial` 返回了 text）。自 `f05766c`（08-30）起就在。

**线上到底撞没撞过**：我没有日志证据。只读的确认方法：zeabur 日志里搜 `attention is not defined`，
或者问她有没有在聊天里见过这句报错。**我没去查线上日志，要查请先说一声。**

**修法**（一行级）：在 `try` 外声明 `let attentionRefs = []`，`try` 里赋值，`:407` 读它。
**修的协议**：单独一个提交；基线里**只允许** `build_attention_hit` 和 `build_blocks_overflow_drop` 两组变化，
外加 `test/lib-context-build.test.cjs` 里那条「两组崩溃是同一句话」的断言要改。
用 diff 证明其余 46 组一个字没动。这是「基线可以更新」的唯一正当情形：**有意改行为 + 写清楚为什么**。

---

## §2 回答 Q3：哪条盲区最致命

报告自认是「spec 与实现同源」。那是对的，但太笼统了 —— 它具体长成了下面三个形状，前两个是结构性的，下一片会更疼。

### (a) 两条路共用同一套 DEPS 桩 → **接缝完全不在基线里**

`--rev` 和 `--module` 两边吃的是**同一份** `DEPS`。所以基线证明的是「模块体 = 原代码体」，
**证明不了 `server.js` 实际塞进工厂的是什么**。那条接缝唯一的证据是 `require('./server.js')` 成功。

我把三个工厂的 32 个注入名（memory 6 / session 2 / build 24）逐个核了：
全部是 `const` 或函数声明、都在工厂调用之前声明（或被提升）、全文件**零重赋值**。
**所以这一次接缝是干净的。**

但这就是 `lib/wake/` 那片会踩的地方：keepalive/reflection 有 `let` 模块态（定时器、上次唤醒时刻、开关缓存之类）。
原代码读的是**活绑定**，工厂注入拿到的是**调用那一刻的值** —— 正是 `currentWeather` 那一类，
而基线**看不见**（两边都是桩）。
👉 **动 wake 之前**：给 `free-vars.cjs` 加一道机械检查 —— 每个注入名的声明种类必须 ∈ {`function`, `const`}
且全文件没有重赋值，否则拒绝，逼你当场决定「开访问器 / 搬进闭包」。

### (b) 「压五样」的第四样在 fetch 这个口子上是空的

报告说每组向量压「外部 API 的调用参数」。对 Ombre 是真的；对 DeepSeek **不是**：
- 判官和主分类走 `fetch`，而 `dsReply` / `dsRaw` **忽略入参** —— 请求体（model、max_tokens、prompt）一个字没录。
  基线里 `deepseek-v4-flash` 出现 **0** 次。
- refine 走 `callDeepSeekJson`，桩只记了 `[tag, usr]`，**system prompt 没录**（旧正文 / 现行与作废关键事实的模板）。
  基线里「现行关键事实」出现 **0** 次。

**后果**：`gm_happyPath` 的注释声称压住了「只有 source≠music 的主题进 prompt、按 importance 排」，
可它的输出里**没有任何东西**能反映 prompt 长什么样 —— 那句声明是**假绿**。
`existingTopics` 的过滤 / 排序 / `slice(0,30)` 三步，事实上一步都没压。

对**这一次**搬迁风险接近 0（删行审计证明了逐字）。但它说明「压五样」在最容易出事的外部口上有一个洞。
👉 **补法**：`FETCH.impl` 外面包一层，把 `JSON.parse(init.body)` 记进输出；`callDeepSeekJson` 桩把 `sys` 也记上。
**扩覆盖要从 `--rev f7e49da` 重录基线、再用 `--module` 去比** —— 这不违反「基线不许为变绿而更新」，
因为新基线的**来源**仍是搬迁前的代码。

### (c) 「同源」的具体表现：没想到的分支 —— 见 §3

---

## §3 回答 Q6：缺的是哪类场景（全部实测过）

共同形状：**spec 里的 `ITEM()` 默认值太「乖」了** —— `update_topic: null`、一批一条、Ombre 永远成功、
feel 桶的 refine 要么完美成功要么根本不走。真实世界里不乖的那一半都没压。

| # | 场景 | 实测结果 | 严重度 |
|---|---|---|---|
| A | feel 桶更新，**refine 失败**（DeepSeek 挂了 → null） | 旧 key_facts **整体被这一轮分类器给的 1~3 条替换**；已作废的行（superseded）**被删掉**；旧的 active 事实也丢了。**不点 degraded** | 🔴 |
| B | feel 桶更新，refine 说「没变」（原样回旧正文），但分类器的 `item.content` 不一样 | 照样 `trace` 成**未提炼**的分类器原文；key_facts 同 A 被整体替换 | 🔴 |
| C | 原来是 feel 的桶，这一轮分类器标成 `memory` | `kind` 翻成 memory，`key_facts` 被**清成 null** | 🔴 |
| D | 同一批两条 item **同一个 topic**（prompt 自己要求「一窗多事实拆多条」） | 第一条 hold，第二条命中刚 push 的行 → `trace(old=第一条, new=第二条)` → **第一条事实从 OB 和索引里都没了**。`topics.push(row)` 这一行专为这个场景存在，却没有一组向量走到它 | 🔴 |
| E | `update_topic` 指回旧桶（08-30 三刀的**核心机制**）/ 指向不存在的主题 | 行为正确（前者 trace 旧桶，后者按 topic 新建）。**但 0 组向量** | 🟡 覆盖 |
| F | `hold` 失败（`callOmbreTool` 回 null） | memory_topics 照样写一行，`bucket_id: null`、`last_content` 是那条记忆。**OB 里没有，索引说有**；不点 degraded。以后每次更新都走模糊的 `breath_search` 定位 | 🟡 |
| G | 新 topic 同时包含两个旧 topic（「上海搬家」vs「上海」「搬家」） | 命中哪个取决于数组顺序；线上是 `select('*')` **无 order** → Postgres 堆序，被 UPDATE 过的行会挪位置 → **同一句话不同轮可能改不同的桶** | 🟡 |
| H | 旧行没 `bucket_id`，靠 `breath_search` 定位到了 | 定位结果**不回写**，下次再搜一遍；搜索排序一变就可能定位到别的桶 | 🟡 |
| I | 正文没变但 grounding 从「悬」升到「实」 | 零变化跳过 → **升级不落库**，永远是「悬」 | 🟢 |

另外两处小的：`existingTopics` 的 `slice(0,30)`（需要 >30 个主题才走得到）没压；
`memoryWriteProcessed.add(windowId)` 在判官/分类**之前**，所以分类器临时失败时同一窗口在本进程内不会重试 ——
日志里的「下轮重试」其实是「靠下一个窗口的重叠部分碰运气」。

**A/B/C 为什么是最重的**：08-30 程芥裁决的「关键事实只增不减 / 证据可废止不可撕掉」，
这层保护**只写在 `refineFeelContent` 里面**。任何绕开 refine 的路径（refine 失败、refine 说没变、这一轮 kind 不是 feel）
都会让 `existing.key_facts = keyFacts` 把整组覆盖掉。refine 失败还是**静默**的。
修它是产品层的事（她的裁决在代码里没兑现），**我没动，建议她过目后单独做**。

👉 这 9 条都应该变成向量。按 §2-b 的办法从 `--rev f7e49da` 重录 —— 录下来的就是「现状」，
以后谁修了它们，红的就是那一组，一目了然。

---

## §4 回答 Q4：fail-closed —— 技术上应该修，而且这不是真两难

报告把它框成「丢掉真实记忆 vs 重复建桶」。我认为两边的代价都被估错了。

**fail-open 那边比报告写的更糟：**
1. 回 `error` 字段的最常见原因（列不存在、RLS、权限）是**持续性**的，不是抖一下。同一张表的 `upsert` 大概率也失败 →
   hold 成功（OB 建了桶）、upsert 失败（索引没记住）→ 下一个值得记的窗口又当新的 → 又 hold →
   **每个窗口一个重复桶，没有上限，一直到有人发现为止**。
2. 就算 upsert 成功，`onConflict: (source, topic)` 会把已有那一行的 `bucket_id` **改指新桶** →
   **旧桶成了孤儿**：还在 OB 里、还会被 breath 召回，但再也不会被差分更新 → 过期内容永久残留。
3. 所以报告里建议的线上核查（「看 memory_topics 有没有同一主题的多行」）**找不到任何东西** ——
   唯一约束 `uq_memory_topics_source_topic` 让多行不可能存在。痕迹只会在 OB（同 tags 多个桶）
   或日志里（对一个早就有的主题打出「🌿 记忆新建「X」」）。

**fail-closed 那边比报告写的轻：**
- 窗口是 4 条滑动的，每轮只挪 1~2 条 → 这一窗没写的信息，下一窗大多还在。
- `markMemoryDegraded` 连续 ≥3 次会大声报警 → 故障是**看得见**的，而 fail-open 是静默的。

**而且决定早就做过了**：那个函数的注释白纸黑字写着「fail-closed：读失败返回 null」。
修它是**兑现她已经做的决定**，不是替她做新决定。当然还是请她点头。

**修的形状**（我没动）：`error` 分支也打那句 `💥` 日志并 `return null`；
另外 `generateMemoryWriteIfNeeded` 里 `topics === null` 那条出口**目前不点 `markMemoryDegraded`**（只有 `writeMemoryItems` 那条点了），
不补的话修完之后 error 字段那条路在入口层会变成**另一种静默**。
协议同 §1：单独提交，只允许那两对成对向量 + 白话断言变化。

---

## §5 回答 Q1：`stripUiMarkers` 换成 `require` 的 const —— 值

核心是一个不对称：**TDZ 失败是响的，副本漂移是哑的。**
有人在 `server.js` 顶层提前调它 → 启动当场 `ReferenceError` → `routes.test` 一 require 就红。
两份副本漂了 → 什么都不红，直到某天记忆里混进了 `[[ask]]` 骨架。**拿一个响的风险换掉一个哑的风险，永远划算。**

👉 可以再进一步：把 `const { stripUiMarkers } = require('./lib/ui-markers')` 挪到 `server.js` 顶部，和其它 lib 的 require 放一起（第 16 行附近）。
TDZ 窗口几乎缩到零，那段警告注释也能删掉大半。纯移动、不改行为。

---

## §6 回答 Q2：21 个测试专用导出 —— 接受，**千万别改成只走入口**

§3 的结论是覆盖缺口在 `writeMemoryItems` 这一层 —— 需要的是**更多**直接压内部函数的向量，不是更少。
只走 `scheduleMemoryWrite` 入口，恰好会把最需要加压的那些分支埋到两个网络调用后面。

真正要紧的边界已经被守住了：`server.js` 只解构 `scheduleMemoryWrite`。
想让边界可以机械检查：收进 `__internals` 子对象只要改 spec `adapt` 里一行、基线不动；
或者加一条断言「server.js 从 `createMemory(...)` 只解构 `scheduleMemoryWrite`」。两个都是可选项，不急。

---

## §7 回答 ③：`server.js` 里约 40 行的接线注释 —— 过度，而且已经在漂了

实测：`stripUiMarkers` 在 server.js 里的真实调用点是 **1044 / 2531**，
注释里写的是 1028 / 2510 / 2515（三个文件三个数，没一个对）。「108 组向量」「43 组」这类计数也会过期。

👉 每片在 server.js 里留 **≤5 行**：搬去哪 / 注入面 / 最危险的那一条坑。**不写行号**（写函数名）、**不写计数**。
详细理由放模块文件头和交接文档 —— 那里离代码近，改代码的人会顺手看见。

---

## §8 建议的顺序

1. **拆工作区**：「运维收尾」的三处 server.js + 迁移一个提交；分区第五片一个提交。部署前先跑迁移。（§0）
2. **修 attention 崩溃**：单独提交，只动两组向量。（§1）
3. **fail-closed**：她点头后单独提交。（§4）
4. **feel 桶 key_facts 被绕过覆盖（A/B/C）**：她的裁决没兑现，先给她看再动。（§3）
5. **把 §3 的 9 条和 §2-b 的 fetch 入参补成向量**，从 `--rev f7e49da` 重录。
6. **动 wake 之前**：先上 §2-a 的注入面检查，再补「醒没醒 / 醒几次 / 调哪个模型」的基线。
7. 顺手：删行审计固化成 `scripts/audit/` 常驻工具（报告 §8 的建议，同意）；`stripUiMarkers` 的 require 挪到顶部（§5）。
