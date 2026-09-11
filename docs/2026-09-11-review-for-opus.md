# 复查报告 · server.js 分区第 3 步（第五片 `memory` 落地）

**日期**：2026-09-11
**给谁**：Opus（外部复查）
**谁做的**：程芥的助手（DeepSeek-v4-flash 档）
**状态**：**未提交、未部署**。全部改动只在工作区。
**一句话**：把一个 ~571 行的「记忆编辑者」整块从 `server.js` 搬进了 `lib/memory/index.js`，
用 108 组行为向量证明搬迁前后**逐字节等价**；顺带查实一个**安全闸形同虚设**的真窟窿（没修，交人判断）。

> 这份是**复查用**的，请重点看 §4（两处非逐字的决定）、§6（真发现）、§8（要你回答的问题）。
> 留档自用的版本在 `docs/2026-09-09-handoff.md` §11。

---

## §1 交付物清单

| 路径 | 行数 | 状态 | 说明 |
|---|---|---|---|
| `lib/memory/index.js` | 571 | 新增，未跟踪 | 记忆编辑者全部逻辑（逐字搬运） |
| `lib/ui-markers.js` | 28 | 新增，未跟踪 | `stripUiMarkers`，被三个域共用（见 §4①） |
| `server.js` | 5903（原 7067） | 已改 | 删 1226 行 / 加 62 行 |
| `scripts/audit/specs/memory-write.cjs` | 108 组向量 | 新增，未跟踪 | 基线生成器 |
| `test/fixtures/memory-write.baseline.json` | 71 KB | 新增，未跟踪 | 搬迁**前**的真实输出 |
| `test/lib-memory.test.cjs` | 14 条 | 新增，未跟踪 | 等价性 + 语义断言 |
| `scripts/audit/testkit.cjs` | +65 行 | 已改 | 假 supabase 补 `upsert`（真 onConflict 合并）与「按表抛」 |
| `package.json` | 1 行 | 已改 | 注册新测试 |

**验证结果**：

- 五条基线 × 两条路径（`--rev` / `--module`）**全部逐字节一致**：select 6 / retrieval 39 / session 43 / build 48 / **memory 108**。
- `npm test`：**121 / 121 通过**（原 107，新增 14 条）。含 74 条路由快照。
- `node --check` 三个文件干净；`require('./server.js')` 成功，47 个导出。
- 残留 grep 为空：22 个搬走的函数在 `server.js` 里都没有第二份定义；
  `memoryWriteLocks` / `memoryWriteProcessed` / `MEMORY_GATE_PROMPT` / `MEMORY_WRITE_PROMPT` 在 `server.js` 里零裸引用。
- **删行审计**：`git diff -U0` 里被删的 1226 行，**1223 行逐字出现在四个新模块里**；
  剩下 3 行是上一片就记录过的 `currentWeather` → `getWeather()/setWeather()` 口子替换。
  （→ 也就是说，这一轮**没有顺手多删任何东西**。）

---

## §2 我用的等价性证明方法（以及它的盲区 —— 请重点审这里）

**方法**：动刀**之前**，把待搬代码从 `git show HEAD:server.js` 里按行区间切出来、放进 vm 沙箱，
用 108 组输入跑一遍，把输出冻成 JSON。搬完再用同一份 spec 指向新模块，输出必须**逐字节相同**。
同一份 spec 驱动两个来源，杜绝「两边各写一套测试、然后都测了不一样的东西」。

**每组向量压五样**：返回值 / 落库后的表快照 / 假 supabase 的查询序列 / **外部 API 的调用参数** / 日志与告警。

### ⚠️ 这个方法的盲区（我认为这才是最该被审的地方）

1. **spec 和实现是同一个人写的 —— 这是最大的方法论弱点。**
   108 个绿点证明的是「我改的地方和我测的地方一致」。**我没想到的分支，等于两条路都错成一样，基线照绿。**
   👉 所以请**审 spec 的覆盖面**（`scripts/audit/specs/memory-write.cjs`），而不是审那 108 个绿点。
   具体：`writeMemoryItems` 的 17 组向量是否真的穷尽了它的分支？`generateMemoryWriteIfNeeded` 的 15 组够不够？
2. **假 supabase 是近似实现，不是真 PostgREST。** 它逐字实现了 `eq/neq/in/order/range/limit/insert/update/upsert`，
   但**没有**实现：RLS、`count` 的真实语义、错误码、超时、`upsert` 的 `ignoreDuplicates`、
   以及「PostgREST 把 `error` 放在 `{data:null,error}` 而不是抛」这个**恰好是真窟窿成因**的行为
   （这一条这次是靠**手工造**出来的，见 §6 —— 说明假货确实会漏掉真实失败形态）。
3. **冻钟**意味着任何依赖真实时间的路径没被真正压过（时钟被固定在 `2026-09-10T12:00:00Z`）。
4. **网络桩**覆盖了「HTTP 200 / 非 200 / 空内容 / 坏 JSON / 超时异常」，
   但没覆盖：429、部分流、真实 30s 超时行为、并发同窗两个请求真撞上。
5. **完全没有**验证：性能、并发安全、部署环境、内存占用。`memoryWriteLocks` 的锁语义只在单进程单线程假设下成立。
6. **迁移后没有跑过一次真实对话。** 这一片是「聊天后台链路」，从没在生产负载下跑过。

**我认为：这套方法能证明「我搬的是同一段代码」，不能证明「这段代码是对的」。** 这两件事请分开看。

---

## §3 哪些代码被搬了（边界图）

`server.js` 里被搬走的三段（相对 `HEAD = f7e49da` 的行号）：

| 段 | 行区间 | 去向 |
|---|---|---|
| 判官 → 主分类 → 写回整条链 | 3709–3914 | `lib/memory/index.js` |
| `stripUiMarkers` | 3916–3925 | **`lib/ui-markers.js`**（不跟 memory 走，见 §4①） |
| 主题表读写 / 差分写回 / 调度 | 3927–4236 | `lib/memory/index.js` |

**注入进工厂的六个外部依赖**（用 `acorn` 算的精确自由变量面，不是人工白名单）：
`supabase`、`warnConfigFallback`、`sha256`、`callOmbreTool`、`callDeepSeekJson`、`markMemoryDegraded`。
模块里**没有** `require('../server')` —— CommonJS 循环依赖会静默给 `undefined`，这是这个项目的红线。

**跟着代码进闭包的模块态**：`memoryWriteLocks`（内存锁）、`memoryWriteProcessed`（窗口哈希去重集）。
两个都**没有任何外部调用方**（连裸引用都为零），所以是纯闭包迁移，不需要开访问器。
对比上一片的 `currentWeather`：那个有外部写入方（`POST /api/location`），所以必须交 `getWeather/setWeather` 口子。
**规矩：绑定跟着状态走，不跟着调用走。**

---

## §4 三处非逐字的决定（请判）

### ① `stripUiMarkers` 搬去了 `lib/ui-markers.js`，**没有**跟着 memory 片走 —— 请判这个边界

它原先**物理上坐在 memory 块正中间**（`gateMemoryWriteViaDeepSeek` 与 `scheduleMemoryWrite` 之间）。
但它是**零依赖纯叶子**，且被**三个域**在用：
备份导出（`server.js:1028`）、残留窗口（`server.js:2515`）、记忆门控（`lib/memory/index.js`）。

三个选项：

| 方案 | 问题 |
|---|---|
| 留在 `server.js` 注入 | spec 里得再抄一份实现 → **两份副本漂移没有任何测试能发现**（最坏） |
| 跟着 memory 走，别的域去 require | 两个跟记忆无关的域要跨模块 require 记忆模块的内部件 |
| **（采用）搬去 `lib/ui-markers.js`，三方 require 同一份** | 引入一个**新的初始化顺序风险**（见下） |

⚠️ **新引入的风险，请确认我判断对了**：它原来是**函数声明**（靠提升，模块顶层调用也安全），
现在是 **`require` 上来的 `const`**。我核对过两个调用点都在**函数体内、运行期才执行**，所以没问题；
但**将来有人在 `server.js` 顶层直接调它就会踩 TDZ**。我把这条写进了 `server.js:2007` 附近的接线注释和
`lib/ui-markers.js` 的文件头。**如果你认为「提升语义的变化」风险高于「两份副本漂移」，请说。**

### ② 工厂交回 22 个名字，其中 **21 个只有测试在用** —— 请判这是否越界

`lib/memory/index.js` 的返回对象里，`server.js` 真正消费的**只有 `scheduleMemoryWrite`**（两处接线：`server.js:3264` / `5721`）。
另外 21 个（`parseEventTime` / `normalizeMemoryWrite` / `holdNewMemory` / `traceUpdateMemory` / `normalizeKeyFacts` / `refineFeelContent` …）
**纯粹是为了让 108 组向量能直接压每个函数**才交出去的，属于「测试专用导出」。

**我的理由**：这一片的行为有一半藏在「每一步的归一化」里 —— `importance` 钳位、`key_facts` 并集与 superseded 纠回、
`grounding` 过滤、`topic` 截断到 12 字。只从 `scheduleMemoryWrite` 入口测，这些分支**全被两个网络调用埋在下面，进不去**。

**我知道这脏**（接口最小化原则上不合格）。我在返回对象里留了明确的分隔注释标明哪些是接口、哪些只为测试。
**要收窄的话正确做法是同时把 spec 改成只走入口**，而不是随手删导出 —— 删了那 90 组向量就没法跑了。
👉 **请你判：接受现状（有注释）／要求我改成「测试专用子导出」（如 `__internals`）／要求重写 spec 走入口。**

### ③ `server.js` 里的接线注释写了 ~40 行 —— 请判是否过度

每一片落地时我都在 `server.js` 里留了：搬去哪、压了哪几样、哪几个符号是注入的、
以及**这一片特有的坑**（例如「`hold` 的 `tags` 必须是 string」）。理由是这个文件的读者比模块的读者多。
但这也是**注释和实现可能漂移**的地方（行号已经漂过一次了 —— 我在 §11 里刚修正了 `warnConfigFallback` 的调用点行号）。

---

## §5 基线顺手压住的「反直觉但正确」的行为（**不是 bug，别随手修**）

这些是搬迁**前**就有的现状，基线把它们的输出原样冻住了。谁"顺手修好"了它们，测试会红：

1. **`importance: 0` 被顶成 `0.5`。** 代码是 `Math.min(Math.max(parseFloat(x) || 0.5, 0), 1)` ——
   `parseFloat(0)` 是 falsy，被 `||` 换成默认值。**负数**才真的被夹到 `0`。
   后果：模型明确说「这条不重要（0）」和「模型没给 importance」落库是**同一个值**。
2. **`key_facts` 过滤映射把非字符串变成字符串**：数字 `42` → `"42"`，`null` → `"null"`（两者都**保留**，不是丢掉）。
3. **`getMemoryGateConfig` 的三个退化分支不对称**：`error` / `noRow` 会调 `warnConfigFallback`，
   `catch`（真抛）**不调**。三组向量分别压住（`gc_error` / `gc_noRow` / `gc_throw`）。
4. **判官说 `false` 时连主题表都不读**（`gm_gateSaysNo` 的 IO 序列里没有 `from:memory_topics`）——
   这是判官存在的**全部价值**：省掉「全表 topic 读 + 30 条列表的大 prompt」。

---

## §6 ⚠️ 本轮真发现：`getAllMemoryTopics` 的 fail-closed 闸**对最常见的失败形态不响**

**位置**：`lib/memory/index.js:314`（搬迁前在 `server.js:3949` 附近，**代码一字未改**）

```js
async function getAllMemoryTopics() {
  try {
    const { data } = await supabase.from('memory_topics').select('*');
    return data || [];                       // ← 只解构 data
  } catch (e) {
    console.error('💥 读取 memory_topics 失败（本轮差分写回将跳过）:', e.message);
    return null;                             // ← 注释声称「fail-closed：读失败返回 null」
  }
}
```

调用方 `generateMemoryWriteIfNeeded`（`lib/memory/index.js:299-300`）：

```js
const topics = await getAllMemoryTopics();
if (topics === null) return;                 // ← 这是那道闸
```

**问题**：**supabase-js 的失败通常不是 throw，是 `{ data: null, error: {...} }`。**
它不抛 → 走不到 `catch` → 走 `return data || []` → 回的是 **`[]`**，**不是 `null`**。
闸门判的是 `=== null`，所以**不响**。

**后果链**：看不到任何旧主题 → 现有主题列表为空 → 模型看不见任何旧桶可指 →
**每个主题都被当成全新的 → 全部 `hold`** → **Ombre 重复建桶**。
这正是该函数注释自己写的那句「拿 `[]` 会把所有主题当不存在 → 全部重新 hold → Ombre 重复建桶（永久污染）」——
**注释描述的灾难，恰恰是它现在的实际行为**（只是触发条件从"读不到"缩窄成了"读失败但不抛"）。

**触发条件有多常见**：列名/表名写错、RLS 拒绝、权限不足、上游 4xx/5xx —— supabase-js 对这些都是
**回 `error` 字段、不抛**。走到 `catch` 需要的是真的**抛**（网络栈异常、JSON 解析失败等）。
⚠️ 我只有静态推理 + 假 supabase 的对照实验，**没有生产日志证据**证明线上真的发生过这条路 ——
如果你想确认，得去看线上 `memory_topics` 里有没有**同一主题的多行**（重复建桶的痕迹）；**那是只读查询，但请先问程芥**。

**我没有修**（纪律：等价搬迁不掺修复；发现交人判断）。**但基线把这个落差原样压住了，而且是成对压的**:

| 向量 | 失败方式 | 结果 | 谁在压 |
|---|---|---|---|
| `wm_topicsThrow` | **真抛** | 不 hold、`degraded: ["memory_topics_read_failed"]`、两条明确日志 ← 闸响了 | 返回值那 90 组 |
| `wm_topicsErrorFieldProceeds` | 回 `error` 字段 | **照样 hold 了一个新桶并 upsert**、`degraded: []`（**静默**）← 闸哑了 | 同上（**故意不一样**） |
| `gm_topicsThrowCloses` | 真抛 | 整轮跳过 | `generateMemoryWriteIfNeeded` 那 15 组 |
| `gm_topicsErrorFieldProceeds` | 回 `error` 字段 | 整轮继续、写回发生 | 同上 |

`test/lib-memory.test.cjs` 里还有一条白话断言（"fail-closed 的缺口…"）把这件事单独钉住。

**修法（一行，供拍板，我没动）**：

```js
const { data, error } = await supabase.from('memory_topics').select('*');
if (error) return null;      // 或加上日志，与 catch 分支对齐
return data || [];
```

⚠️ 修之前要先想清一件事：**闸真的响了会怎样？** 现在这条链是 fail-**open** 地在最坏情况下"重复建桶"，
改成 fail-closed 之后，一次读取失败 = **本轮记忆完全不写**（丢掉真实记忆 vs 重复建桶，哪个代价大是产品判断，不是技术判断）。
👉 **这条我明确不替她决定。**

---

## §7 历史遗留：我之前报过、仍然**没修**的发现（汇总，供你一并评估）

这些在 `docs/2026-09-09-handoff.md` §8–§10 里都有记录，这里汇总一遍：

| # | 发现 | 位置（现在） | 严重度（我的判断） |
|---|---|---|---|
| 1 | **`attention is not defined` 生产崩溃** —— `const attention` 声明在 `try` 块内，`attentionInjected` 为真时在块外被引用，必抛 ReferenceError | `lib/context/build.js:389` 声明 / `:407` 引用 | 🔴 高（f05766c 引入，活跃路径） |
| 2 | `request_stats` 有整段盲区（已部分修，**未部署**） | `server.js` 统计段 | 🔴 高（钱账不准） |
| 3 | **`getAllMemoryTopics` fail-closed 失效**（本轮新增） | `lib/memory/index.js:314` | 🔴 高（污染记忆） |
| 4 | `live_max_tokens: -1` 缺下界校验 | 配置读取 | 🟡 中 |
| 5 | `ctx_noRow` 静默降级 / `'settings 无 global 行'` 分支是死代码 | `lib/context/session.js` | 🟡 中（静默） |
| 6 | `isExactWord(msg, '')` 潜在死循环（`''.indexOf('', from)` 把 from 夹在串长上），当前不可达 | `lib/context/select.js` | 🟡 中（潜伏） |
| 7 | 「牵挂闸」可达性远窄于设计意图（用去标点后的 n-gram，严格弱于提及闸的原始串 `includes`） | `lib/context/retrieval.js` | 🟡 中（机制空转） |
| 8 | `server.js` 里 **8 个死 import**（`lib/llm`：`randomDelay`、`parseJsonLoose`、`callVisionModel`；`lib/time`：`shClock`、`shPartOfDay`、`formatSegRange`、`segHeader`、`humanizeDuration`） | `server.js` 顶部 | 🟢 低（洁癖） |
| 9 | `lib/context/retrieval.js` 多交回两个非接口导出 | 同上 | 🟢 低 |

**1 号我建议优先**：它不是"能不能更好"的问题，是**走到那条路径就崩**。

---

## §8 我在这一轮自己犯的错（诚实记录）

**写测试时三条语义断言写错，全部是**我**的错，不是代码的错：

1. `importance` 那条：我传的 content 是「事实一」（**3 个字**），被 `content.length >= 4` 全过滤掉，拿到 `[]`。
   → 断言测的根本不是钳位，是过滤。
2. `refineFeelContent` 那条：我把桩的返回值设在 `run()` **外面**，而 `run()` 开头的清理会重置它，拿到 `null`。
3. 窗口去重那条：我把判官桩写成了主分类的返回形状（`{"should_write":false}` 里含 `false`，
   被 `normalizeGateResult` 匹配走）→ 判官直接说「不值得」→ **主题表一次都没读**，断言 `0 !== 1`。

**三条都是我先怀疑代码、结果代码是对的。** 我把这条当纪律写进 §11 了：**现写的语义断言没有基线背书，「红了先怀疑断言」。**

**另一件**：行数算术差点让我以为"搬多了"。模块总共 1414 行，`server.js` 只少了 1226 行 —— 差额看起来可疑。
我没有靠行数对账，而是写了「删行审计」（把 `git diff -U0` 里每一行被删的行拿去新模块里逐字找）。
👉 **建议把删行审计固化成常驻工具**（这次用完删了），它比行数算术强得多。

---

## §9 请你回答的问题（按重要性排序）

1. **§4① 的边界判断对不对？** `stripUiMarkers` 从"函数声明（提升）"变成"`require` 的 `const`（TDZ）"这个代价，
   抵得上"消灭两份副本漂移"的收益吗？
2. **§4② 的 21 个测试专用导出** —— 接受（有注释）／改 `__internals` 子对象／还是要求我把 spec 改成只走入口重写？
3. **§2 的盲区里，哪一条你认为最致命？** 我自认是「spec 与实现同源」（第 1 条）。
   如果你要抽查覆盖面，建议从 `writeMemoryItems`（17 组向量）和 `generateMemoryWriteIfNeeded`（15 组）入手。
4. **§6 的 fail-closed 窟窿**：改成真 fail-closed（读失败=本轮不写）还是维持现状（fail-open=可能重复建桶）？
   这是**产品代价权衡**，我倾向不替她决定，但想要你的技术判断。
5. **§7 的 9 条遗留发现里，1 号（`attention is not defined`）** ——
   你是否同意"这是活跃路径上的必崩点"？我只有静态证据（声明域），**没有生产报错日志**佐证
   （因为 `build_blocks_overflow_drop` 那条向量当初就是撞在它上面炸的，说明它真的会被走到）。
6. **我看漏了什么？** 这一片的 108 组向量里，你认为**缺失**的是哪类场景？

---

## §10 复现命令（都不写库、不部署、不碰 `.env`）

```bash
# 五条基线 × 两条路径（select / retrieval 要用各自的 baseRev，见 §11 的警告）
node scripts/audit/baseline-dump.cjs --spec scripts/audit/specs/context-select.cjs    --rev 1f96a08 --compare test/fixtures/context-select.baseline.json
node scripts/audit/baseline-dump.cjs --spec scripts/audit/specs/context-select.cjs    --module lib/context/select.js    --compare test/fixtures/context-select.baseline.json
node scripts/audit/baseline-dump.cjs --spec scripts/audit/specs/context-retrieval.cjs --rev 2b9c8c5 --compare test/fixtures/context-retrieval.baseline.json
node scripts/audit/baseline-dump.cjs --spec scripts/audit/specs/context-retrieval.cjs --module lib/context/retrieval.js --compare test/fixtures/context-retrieval.baseline.json
node scripts/audit/baseline-dump.cjs --spec scripts/audit/specs/context-session.cjs   --rev f7e49da --compare test/fixtures/context-session.baseline.json
node scripts/audit/baseline-dump.cjs --spec scripts/audit/specs/context-session.cjs   --module lib/context/session.js   --compare test/fixtures/context-session.baseline.json
node scripts/audit/baseline-dump.cjs --spec scripts/audit/specs/context-build.cjs     --rev f7e49da --compare test/fixtures/context-build.baseline.json
node scripts/audit/baseline-dump.cjs --spec scripts/audit/specs/context-build.cjs     --module lib/context/build.js     --compare test/fixtures/context-build.baseline.json
node scripts/audit/baseline-dump.cjs --spec scripts/audit/specs/memory-write.cjs      --rev f7e49da --compare test/fixtures/memory-write.baseline.json
node scripts/audit/baseline-dump.cjs --spec scripts/audit/specs/memory-write.cjs      --module lib/memory/index.js      --compare test/fixtures/memory-write.baseline.json

# 全量测试
npm test

# 单跑这一片
node --test test/lib-memory.test.cjs
```

**⚠️ 复查时请守的纪律**（这个项目的常驻规矩）：

- **基线不许为了让它变绿而更新。** 它红了就是行为变了，先解释清楚再谈更新。
- **只查不修。** 你发现的问题请写回文档／报告，**不要直接改 `lib/` 或 `server.js` 的代码** ——
  一改就得重跑这五条基线，而基线是不许跟着改的；改完你就有责任证明"等价"，那已经是下一轮工作了。
- **探针一律只读。** 需要写库的诊断先问人。
- **别碰 `.env` 和线上环境变量。** 读它们会把密钥落到磁盘或打进日志（09-08 真发生过一次，
  导致 DeepSeek key 必须轮换）。测试里对 `DEEPSEEK_API_KEY` 是**设一个假值再还原**，从不打印。
- 本次改动**没有部署、没有 push、没有 commit**。要部署请先跟程芥确认（☠️ 裸跑 `zeabur` = 部署当前目录；
  🚨 这个项目**「只推后端」不存在**，`COPY . .` 会让前端一起部署）。
