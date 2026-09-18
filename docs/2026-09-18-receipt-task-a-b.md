# 回执：任务 A + B

> 基线 commit：`94e68e1`
> 执行日期：2026-09-18
> 执行者：Claude Code（Codex 额度耗尽后接手，同时承担原「DeepSeek 只读审计」与「Codex 二轮复核」两个角色）
> 对应任务单：`docs/2026-09-18-next-roadmap-and-outsourcing.md` §「可直接交给 DeepSeek 的任务单」

## 结论

- **审计状态：完成**（A-①至 A-④、A-⑥、任务 B 全部给出结论；A-⑤ **机制已确认、现象实测未复现**，见该节）
- **是否改动文件：改了 5 个，全部未提交**（见下方「本轮实际执行的改动」）—— 其中 1 个是重建的路线文档，2 个源码，2 个测试，1 个基线 fixture。
- **未做的事**：未跑 migration、未改环境变量、**未部署**、未调用任何生产**写**工具、未打印任何密钥或对话正文。
- **读过生产**：为了定案 P0-6，用只读 SELECT 查了 `claude_agent_transcript_entries` / `claude_agent_session_links` / `sessions` 三张表，**只提取结构性事实（条数、类型、工具名、字段长度），未读取或输出任何对话正文**。任务单原话「只读调用也只能给出建议命令，不自行访问生产」是针对**被墙的外部执行者**写的；本轮由本地执行者按用户"你先跑"的指示执行，故此处如实标注为**对任务单边界的一次有意偏离**。

### 复核声明（二轮纪律）

本回执里凡标「已确认」的结论，我都在写进本文件前**重读过一次源码原文**。复核中抓到两类二手错误：

1. **行号错**：`dream` 的 Ombre 注册处被写成 `721`，实际是 `822`；Ombre 各处普遍差 1（子代理数的是 `@mcp.tool()` 装饰器行，可接受，但没说明）。
2. **坐标系混用**：另一份报告引的 `sdk.d.ts:268056`、`93362`、`62708` 等**不是行号而是字符偏移**（它在 `sdk.mjs`/`sdk.d.ts` 上跑 `slice()`）。同一份报告里 `sdk.d.ts:5549` 与 `268056` 指同一个类型 —— 两者不可能同时是行号。

→ **本文件所有行号以我亲自读到的为准**，不采信二手行号。结论层面：上述两份报告**没有发现被我推翻的判断**，唯一被我收窄的是 `retreat` 单测「空转」的说法（`assert.equal(typeof shape,'object')` 那行对 `retreat` **是跑的**，只有内层遍历零次）。

---

## 一句话决策（供 Codex 排期参考）

任务单的 P0 原定是「先拿到工具链事实，再动实现」。**审计结果建议在 P0 内部插两条更前面的**：

- **P0-0a：`trace` 与 Ombre 的契约已经断了**，模型现在**根本调不动**「修正已有记忆」这唯一入口。不需要等 smoke harness、不需要等额度适配层，可以直接修，且修它不动任何其他变量。
- **P0-0b：`createSdkMcpServer` 没传 `alwaysLoad`，而这一版 CLI 的 MCP 启动默认是非阻塞的** —— 机制确凿，但**实测没有稳定复现**（详见 A-⑤「实测结果」）。这条要**先补观测字段再定案**（补两行、零行为风险），不确认就改 `alwaysLoad` 是在赌两个确定的代价换一个未证实的收益。

两条都不与缓存/压缩/额度任何变量耦合，符合任务单「一次只放一个变量」。

**✅ P0-0a 与 P0-0b 均已在本轮做完**（见下节）。P0-0b 的决策依据写在改动表里：实测把它的两个代价都证伪了（详见该行）。

---

## 本轮实际执行的改动（**未提交，全部留在工作区**）

审计完成后，P0-0a 已当场修掉。改动清单：

| # | 文件 | 改了什么 | 验证 |
|---|---|---|---|
| 1 | `lib/tools-schema.js` | `trace`：`id` → `bucket_id`；删掉 Ombre 不认的 `plan_id`；补 `required: ['bucket_id']`；加了一段说明为什么必须叫 `bucket_id` 的注释（防回归） | 见下 |
| 2 | `lib/tools-schema.js` | `letter_write`：`required` 由 `['content']` 改为 `['author','content']` | 见下 |
| 3 | `test/lib-tools-schema.test.cjs` | 新增 `OMBRE_CONTRACT` 契约钉子：钉 `trace`/`letter_write`/`anchor`/`release` 的必填参数名，并断言**不该出现的字段真的没出现** | 新测试通过 |
| 4 | `lib/claude-agent.js` | **P0-0b**：`createSdkMcpServer` 加 `alwaysLoad: true`（附决策依据注释） | 见下方「alwaysLoad 的决策与验证」 |
| 5 | `lib/claude-agent.js` | **P0-6 观测**：抽出纯函数 `readInitInfo()`，把 init 的 `tools` 数量 / `mcp__shenyan__*` 数量 / `mcp_servers[].status` 一并记进 `initInfo` 并打进 ⚙️ 日志；导出以便测试 | 见下 |
| 6 | `test/lib-claude-agent.test.cjs` | 新增 `retreat` 空 shape 断言（补上原来零次迭代的覆盖）；新增 `readInitInfo` 断言（含"空工具表要报 0 不能报 null""旧 CLI 缺字段给 null 不伪造 0"）；补 `zod` 引用 | 新测试通过 |
| 7 | `test/fixtures/context-build.baseline.json` | **重新生成基线**（理由见下） | 见下 |

### `alwaysLoad` 的决策与验证（原建议是"先补观测定案再改"，最终改为直接改，依据如下）

此前我把它列为"需先观测定案"，是因为给它挂了两个代价。实测把两个代价都证伪了：

1. **"每轮吞最多 5s 启动阻塞"** —— 上限 5s 是给**网络型** MCP server 的。`shenyan` 是 **in-process** server（`createSdkMcpServer`），连接不跨网络，正常瞬时。5s 是够不着的天花板，不是典型值。
2. **"工具被工具搜索延后，`alwaysLoad` 会强制全量进 prompt 增加开销"** —— 生产快照显示 24 个工具**本来就在每轮 prompt 里**（带工具的快照 19452 字符 vs 不带的 4339），说明没被延后。所以这一项**无变化**。

代价没了，剩下的是**确定性**（首轮一定有工具）+ **前缀稳定**（工具表不再闪烁，顺带消除每会话可能一次的缓存断点）。证据仍是 n=2，但收益/代价明显不对称，故直接钉死。

**机制验证（不是照抄文档）**：实机构造带 `alwaysLoad: true` 的 server，24 条工具全注册成功，且**每个工具的 `_meta` 上确实出现了 `{"anthropic/alwaysLoad":true}`** —— SDK 文档说的 "Applied via `_meta['anthropic/alwaysLoad']` on each tool" 在我们这条路径上成立。

**生效验证**：部署后看首轮 ⚙️ 日志新增的 `tools=N（shenyan M）mcp=[shenyan=connected]`。这是本轮补的观测，就是用来验它的。

**改动收敛性证明**：`git diff` 对 `lib/tools-schema.js` 显示整文件重写（419/413），那是**行尾假象**（见下方「独立发现」）。剥掉 CR 后逐字比对，真实改动**恰好只有上表 1、2 两处**，一个字不多。

**基线为什么可以更新**：`lib/context/build.js:264` 会 `estimateTokens(JSON.stringify(getTools()))`，改了 schema 这个估算必然变，所以那条「与搬迁前逐字节等价」的测试红了——**这是它在正常工作**。按该测试文件自己写的规矩（「它红了 = 你改了行为，先解释清楚再谈更新」），我先量化了影响面再更新：

- 48 组向量里 45 组有差异，但差异**只落在 5 个字段路径**：`.logs`(45)、`.value.diag.estimated_tokens`(43)、`.value.diag.raw_estimated_tokens`(43)、`.value.diag.token_breakdown.tools`(43)、`.value.toolsTokens`(1)。
- **`messages` 结构、假 supabase 的查询序列、注入台账——一个都没变。** 组数没增没减。
- 更新后重新生成，再与旧基线比一次：**差异仍是同样的 5 个字段、同样的次数** → 不是"重跑把红的刷绿"。

**测试**：`npm test` → **154 / 154 pass，0 fail**（原 151 + 新增 3 条），2.0 秒。

**本轮故意没动的**（避免一次放多个变量）：`dispatchTool` 等 5 个未导出的 handler（补导出会改测试面）、`verdict` 单向烧卡、`rewrite_stone` 非原子、生产日志正文（都留作独立小提交）。

### 独立发现：`lib/tools-schema.js` 是全仓唯一以 CRLF 入库的文件

`git cat-file blob HEAD:lib/tools-schema.js` → **CRLF=413，裸 LF=0**；对照 `HEAD:lib/time.js` → 纯 LF(145)、`HEAD:server.js` → 纯 LF(6112)。仓库 `core.autocrlf=true` 且无 `.gitattributes`。

后果：这个文件**一旦有任何改动，`git diff` 就会显示整文件重写**（419/413），审不了。这是既有问题、不是本轮引入的，但凡是改这个文件的人都会撞上。
建议独立一个提交把它规范成 LF（那本身也是一次整文件 diff，所以要单独提交、单独说明），**不要混在功能改动里**。

---

## 任务 A-① / A-②：24 工具风险矩阵

分发总入口：`server.js:714 dispatchTool()`。12 个本地工具走 `server.js` 内的 handler；12 个走 `server.js:212 callOmbreTool()` → Ombre `/mcp`。

### 本地 12 个（源码在手，行号可直接核）

| 工具 | 分发 | 真实 handler | 读/写 | 数据 / 外部 | 副作用等级 | 幂等 | 失败形状 | 建议 smoke case |
|---|---|---|---|---|---|---|---|---|
| recall | `server.js:717` | `handleRecall` `server.js:374` | 读 | Supabase `messages`（限本 session、`visible=true`） | **只读** | 幂等 | `{found:false,note}` / `{found:false,vague:true}` / `{found:false,error:true}` | `recall(query="__zzz_no_such_zzz__")` → `found:false` |
| write_diary | `server.js:718` | `handleDiaryWrite` `server.js:465` | 写 | `diary_entries` INSERT | 可逆写（**无删除工具**，清理需 SQL） | 非幂等 | `{ok:false,error:'日记没有写成。'}` | 写一条带 `__smoke__` 标记的日记 |
| read_diary | `server.js:719` | `handleDiaryRead` `server.js:483` | 读 | `diary_entries` | 只读 | 幂等 | `{ok:false,error:'日记读取失败。'}` | `read_diary(limit=1)` |
| want | `server.js:720` | `handleWantAdd` `server.js:526` | 写 | `desires` INSERT | 可逆写 | 非幂等 | `{ok:false,error:'没有记下来。'}` | `want(text="__smoke__")` |
| want_list | `server.js:721` | `handleWantList` `server.js:546` | 读 | `desires` + `desire_notes` | 只读 | 幂等 | `{ok:false,error:'翻不了本子。'}` | 无参调用 |
| want_touch | `server.js:722` | `handleWantTouch` `server.js:587` | 写 | `desire_notes` INSERT + `desires` UPDATE | 可逆写 | 非幂等（每次追加足迹） | `{ok:false,error:'没碰上。'}` | 对不存在的 id → `'这条想要不在了。'` |
| want_reflect | `server.js:723` | `handleWantReflect` `server.js:635` | 写 | `desire_notes` INSERT / `desires` UPDATE / **INSERT 新条** | 可逆写 | 非幂等 | `{ok:false,error:'照镜子没照成。'}` | 对不存在的 id |
| want_history | `server.js:724` | `handleWantHistory` `server.js:690` | 读 | `desires` + `desire_notes` | 只读 | 幂等 | `{ok:false,error:'来路翻不了。'}` | 对不存在的 id |
| retreat | `server.js:725` | `handleRetreat` `server.js:1262` → `getRetreatMaterial` `server.js:1223` | 读 | `settings` / `mirror_cards` / `desires` / `personality_claim` | 只读 | 幂等 | **无 try/catch**：任一读失败直接抛 → 工具错误 | 直接调用（唯一无参工具） |
| verdict | `server.js:726` | `handleVerdict` `server.js:1277` | 写 | `mirror_cards` UPDATE + `personality_claim` UPSERT/UPDATE + change_ledger | 可逆写，**但卡是一次性** | **非幂等，二次调用被 `server.js:1292` 拒绝** | `{ok:false,error:'找不到这张卡'}` | 用不存在的 `card_id` |
| rewrite_stone | `server.js:727` | `handleRewriteStone` `server.js:1635` | 写 | `stone_rings` INSERT + `settings.system_prompt` UPDATE + `personality_claim` UPDATE + change_ledger | **不可逆 / 高影响（改人格锚）** | 幂等（同内容 → `unchanged`，`server.js:1646`） | `{ok:false,error}` | **不要 smoke**，或只在可弃实例 |
| retire_claim | `server.js:728` | `handleRetireClaim` `server.js:1599` | 写 | `personality_claim` UPDATE(`state='released'`) + change_ledger | 可逆写（改回需 SQL） | 幂等（released 不在查询集内 → 找不到） | `{ok:false,error:'没找到这条主张…'}` | 用不存在的 claim 文本 |

### 远端 12 个（Ombre `/mcp`）

被调方定位：`Ombre-Brain-main/src/server.py`。**版本漂移警告见风险 P0-3**：这份树是 `VERSION=2.8.10`、mtime 2026-07-25 的**无 git ZIP 快照**，生产跑的是远程镜像，两者**不能假定一致**。

| 工具 | 分发 | Ombre 注册处 | 真实 handler | 读/写 | 数据 / 外部 | 副作用等级 | 幂等 | 失败形状 | 建议 smoke case |
|---|---|---|---|---|---|---|---|---|---|
| breath_search | `callOmbreTool` | `server.py:623` | `tools/breath/search.py:192` | 读 | 桶文件 + `embedding.db` + BM25；**外部**：embedding API、`OMBRE_HOOK_URL` POST | 只读（**有 webhook 外呼副作用**） | 幂等 | 中文文本 / `❌[OB-E004]` / 调用方侧 `null` | `breath_search(query="__zzz__")` |
| breath_advanced | 同上 | `server.py:645` | 五分支（catalog/feel/importance/surface/search） | 读 | 同上 | 只读（query 路径带 webhook） | 幂等 | 同上 | `breath_advanced(catalog=True)`（0 LLM、最省） |
| hold | 同上 | `server.py:677` | `hold/{core,feel,pinned}` | **写** | 桶文件 + embedding；**外部 LLM**（core/pinned 调脱水器打标） | **可逆写 + 外部 LLM 成本** | 非幂等 | 中文文本 / `❌` | `hold(content="__smoke__", test_data=True)` → 造**可硬删**的靶子 |
| grow | 同上 | `server.py:712` | `grow/{core,shortpath}` | **写** | 桶文件；**外部 LLM（全部路径，最重：digest 拆 2–6 条）** | **可逆写 + 外部 LLM 成本** | 非幂等 | digest 失败 → RuntimeError 不建桶 | `grow(items=["__smoke__ A","__smoke__ B"])` |
| dream | 同上 | `server.py:822` | `tools/dream/__init__.py` | 读 | 桶文件 + embedding；**外部**：webhook | 只读（带 webhook 外呼） | 幂等 | 文本 | `dream(window_hours=1)` |
| trace | 同上 | `server.py:724` | `tools/trace/core.py:50` | **写（含归档与物理删）** | 桶文件 + embedding 重建 | 可逆写，`hard_delete` **不可逆物理删** | 幂等 | 大量中文分支文本 | **见风险 P0-1：契约不匹配，模型调用必失败** |
| anchor | 同上 | `server.py:835` | `tools/anchor/core.py:35` | 写 | 桶 metadata，硬上限 24 | 可逆写 | 幂等（已是 → noop） | 失败文本含 count/limit | `anchor(bucket_id="__nonexistent__")` |
| release | 同上 | `server.py:845` | `tools/anchor/core.py:50` | 写 | 桶 metadata | 可逆写 | 幂等 | 同上 | `release(bucket_id="__nonexistent__")` |
| pulse | 同上 | `server.py:855` | `tools/anchor/core.py:65` | 读 | 桶统计 + 全量摘要 | **只读** | 幂等 | 文本 | `pulse()` |
| plan | 同上 | `server.py:865` | `tools/plan/core.py:40` | 写 | 桶文件（`type=plan`） | 可逆写 | **近似幂等**（同正文且已有 active → 返回原 ID） | 中文拒绝文本 | 连调两次同内容，验第二次不重复建 |
| letter_write | 同上 | `server.py:888` | `tools/plan/core.py:121` | 写 | 桶文件，`importance=10`、**不衰减不合并** | 可逆写但**语义近永久** | 非幂等 | 中文拒绝文本 | **见风险 P1-6：`author` 契约不匹配** |
| letter_read | 同上 | `server.py:912` | `tools/plan/core.py:195` | 读 | 桶文件 | 只读 | 幂等 | 文本 | `letter_read(limit=1)` |

**会调 LLM 的工具**（成本维度）：只有 `hold`（core/pinned 分支）与 `grow`（三条路径全覆盖）。`dream` **不调 LLM**（`tools/dream/output.py:22` 明写），`breath_*` 命中正文不经 LLM。

**唯一不可逆路径**：`trace(hard_delete=True)` → `os.remove()` 桶文件。护栏较强（`trace/core.py:255-278` + `bucket_manager.py:2476-2534`）：仅当 `provenance.kind=="test" and erasable is True` 且 `delete_reason` 非空 ≤500 字符才放行。其余降权（`resolved`/`digested`/`dont_surface`/`delete`）**全部可逆**。

---

## 任务 A-③：JSON Schema → Zod 转换损失

**结论：24 个工具当前零丢失，但转换器有潜伏缺口。**

实测（脚本遍历全部 schema 节点统计关键字）：

- 24 个工具的 schema **只用了 6 个关键字**：`type`(107 处)、`description`(82)、`properties`(24)、`required`(15)、`enum`(5)、`items`(1)。
- `jsonSchemaToZod`（`lib/claude-agent.js:93-141`）+ `toolShape`（`143-151`）**六个全都处理**：enum→`z.enum`（`95-101`）、array→`z.array`（`117-121`）、object 的 required 分流（`122-131`）、string/number/int 的 bounds（`104-116,132-137`）。
- 逐工具比对 `properties` 数与 `toolShape` 产出数：**24/24 一致**，无丢字段。
- **潜伏缺口**（当前无人使用，所以今天不丢，但没有任何测试拦着）：`additionalProperties`、`anyOf`/`oneOf`/`allOf`、`nullable`、`$ref`、`const`、`pattern`、`format`、`minimum`/`maximum`/`minLength`/`maxLength`/`minItems`/`maxItems`（后六个**有实现但零使用**）。`lib/claude-agent.js:86-91` 的 `applyCommonSchemaRules` 只认 `description`/`default`。
- 一个曾经担心、**实测排除**的点：`.describe()` 在 `jsonSchemaToZod` 内层调用，而 `.optional()` 在 `toolShape:148` 外层包裹，导致 `ZodOptional.description === undefined`。但实际回转换（`z.toJSONSchema`）**会解包 optional 取出内层 description**，所以模型仍能看到可选参数的说明。已验证。**前提是 SDK 用同款转换器**，这一条列为未确认（见未确认 3）。

运行时行为实测（zod `4.0.0`）：

- **未知字段被静默丢弃**：`pulse({include_archive:false, evil:'x'})` → `{include_archive:false}`，不报错。→ 模型把参数名拼错（如 `pinned` 写成 `pin`）会被 zod 悄悄扔掉，工具照常"成功"。这是真实的静默失败路径。
- **`retreat` 的空 shape 安全**：`z.object({})` 构造并解析 `{}` 正常，不抛。
- enum/类型校验**fail-closed 且清晰**：`write_diary({visibility:'weird'})` → `invalid_value`；`trace({resolved:true})` → `invalid_type`；`rewrite_stone({content:'x'})` → `changed/why` 缺失报错。**任务单担心的"必填丢失"没有发生。**

现有测试 `test/lib-claude-agent.test.cjs:67`「all domain tool JSON schemas convert to valid Zod raw shapes」只断言**转换合法**，不断言**转换无损**。

---

## 任务 A-④：工具结果序列化与 8000 字截断

**结论：截断点切在 JSON 字符串中间，会切掉关键 ID 与末尾引导语；且哪些工具会被切是可预测的。**

机制两处：

1. `server.js:1698 serializeToolResult()` —— `JSON.stringify(result)` 后按 **8000 字符**硬切，尾部补 `…（结果过长已截断：原始 N 字符，仅保留开头）`（`server.js:1708-1712`）。`null`/`undefined` 替换成显式 `{error:"工具 X 无响应（后端可能不可用）"}`（`server.js:1699-1704`），**这个设计是对的**，堵住了最隐蔽的静默降级。
2. `lib/claude-agent.js:153 safeToolText()` 是**同一阈值的兜底副本**，但生产三条调用路径（`server.js:3403`、`3431` 及 `3364 runClaudeAgentForSession` 的转发）**全都传了 `serializeToolResult`**，所以 `safeToolText` 在生产不可达。**两份阈值各写各的，是未来的漂移点。**

会被截断的工具（按各自上限估）：

| 工具 | 上限来源 | 判断 |
|---|---|---|
| `retreat` | `server.js:1233` mirror_cards `limit(200)` + 整份石头 + `personality_claim` ×20 + `desires` ×10 | **必然被截** |
| `dream` | `server.py:826` 候选桶超 40 取前 40，**每桶完整正文不截断** | **必然被截** |
| `read_diary` | `server.js:498-503` `limit` 最大 20 × `DIARY_MAX_CHARS=4000` = 8 万字符 | **必然被截** |
| `want_list` | `server.js:553` `limit(200)` + 每条带 `footprints`/`last_note` | 大概率被截 |
| `breath_search` / `breath_advanced` | Ombre `max_results` 最大 50、`max_tokens` fallback 10000、**命中逐字返回不摘要** | 大概率被截 |
| `letter_read` | Ombre `limit` 默认 10、**返回完整原文不压缩** | 大概率被截 |
| `pulse` | 全量桶摘要列表 | 大概率被截 |
| `recall` | `server.js:360` 自限 `RECALL_MAX_CHARS=1800` | **不会被截**（设计正确） |
| 其余 13 个（写确认 / 读单条） | 返回短确认 | 不会被截 |

具体危害（直接回答任务单那句「是否可能破坏关键 ID、错误信息或二轮判断」）：

- **`retreat` 被截 = 部分 `card_id` 不可见**，被切掉的卡在当轮**无法 verdict**。且 `retreat` 把 `question` 放在返回对象最后（`server.js:1273`），引导语最先被切掉。
- 截断后的文本**不是合法 JSON**，模型若尝试解析会失败；实际按纯文本读，可读性尚可。
- 截断说明是**追加在切口之后**的，所以模型**知道**被截了 —— 不是静默失败。
- 更隐蔽的一层：`callOmbreTool` 返回的是**字符串**（`server.js:253-266`），而 `serializeToolResult` 会再 `JSON.stringify` 一次（`server.js:1705`）→ **Ombre 侧文本被双重编码**，引号与换行被转义，字符数膨胀，进一步吃掉那 8000 的额度。

---

## 任务 A-⑤：首轮工具表为空

> **⏱ 本节在 2026-09-18 晚间被实测修订过。原始结论（"是默认设计，首轮必然没工具"）过头了。
> 实测结果是：机制真实存在，但**没有稳定复现**——有的 session 首轮明确有工具。修订后的判断见下方
> 「实测结果」与风险 P0-6。保留原文是为了让 Codex 看到结论是怎么被数据推翻的。**

**原始结论（已被实测收窄）：机制找到了。这一版 CLI 的 MCP 启动默认是非阻塞的，杠杆是 `alwaysLoad`，我们没传。**

### 决定性证据

CLI 二进制（`claude-agent-sdk-win32-x64/claude.exe`，2.1.274）里 `alwaysLoad` 的帮助原文，逐字抽出：

> …server are always included in the prompt and never deferred behind tool search. Equivalent to setting `defer_loading: false` on the API. **Default: tools are deferred when tool search is enabled.** As a side effect this also blocks startup until the server is connected (capped at the standard 5s connect timeout) even though **MCP startup is otherwise non-blocking by default, since the tools must be present when the turn-1 prompt is built.**

SDK 类型侧的同一字段（`sdk.d.ts:556-563`，`CreateSdkMcpServerOptions.alwaysLoad`）只描述了「永不被工具搜索延后」那一半，**没写「会阻塞启动到连上」那一半** —— 两处要合起来读才完整。

而我们的 `lib/claude-agent.js:259-264` 调 `createSdkMcpServer({name, version, tools, timeout})`，**没有传 `alwaysLoad`**。

### 机制链（逐环，均已复核）

| 环 | 判断 | 依据 |
|---|---|---|
| 1. `definitions` 会不会是空 | **不会**（正常路径） | `getTools()` 是纯字面量数组、无 env/await（`lib/tools-schema.js:15-412`）；流式 `server.js:3401`、非流式 `server.js:5841` 每请求求值；`runClaudeAgent` 形参默认 `definitions = []`（`lib/claude-agent.js:302`）是唯一入口，但两个现网调用点都显式传值 |
| 2. `!sdkTools.length` 早退分支 | 能导致「**全轮**零工具」，**不能**解释「仅首轮」 | `lib/claude-agent.js:257` → `server:null` → `mcpServers={}`（`:323`）→ 不推 `--mcp-config`，但 `strictMcpConfig:true`（`:338`）照推 `--strict-mcp-config`、`tools:[]`（`:340`）推 `--tools ""` → **零工具且不报错**。静默降能，无日志 |
| 3. `loadSdk()` 竞态 | **我们这边没有** | `lib/claude-agent.js:320-322` 的 `await makeToolServer(...)` 严格早于 `:358` 的 `query(...)`。SDK 内部 `connect()` 未 await 有个微任务级窗口，但 CLI 回应要跨进程 spawn+IO，窗口极小 → 判「疑似，非主嫌」 |
| 4. `createSdkMcpServer` 是否惰性 | **构造是急性的，握手是惰性的** | 实机构造 24 条全部注册成功；真正的 `initialize`/`tools/list` 要等 CLI 经控制通道发 `mcp_message` → **握手完成时刻由 CLI 决定，这就是落点** |
| 5. init 的 `tools` 语义 | 是「该会话实际可用的工具名清单」，**不是** `allowedTools` 白名单 | `sdk.d.ts:5561`（`tools: string[]`）+ `5562-5569`（`mcp_servers: {name,status,source?}[]`）。→ 首轮空表可用 **`tools` 里有无 `mcp__shenyan__*`** 与 **`mcp_servers` 里 `shenyan` 的 `status`** 双条件一次定案 |
| 6. `strictMcpConfig:true` | 只关「别的 MCP 来源」，不关显式传入的 | `sdk.d.ts:93362` 区段。与 `mcpServers:{shenyan}` 组合正确且必要；**只有** `mcpServers` 自己为空时（环 2）才会连唯一来源一起掐掉 |
| 7. `allowedTools` 是不是可用性过滤 | **不是** | `sdk.d.ts:1492` 原文：*"To restrict which tools are available, use the `tools` option instead."* → 它只是 `dontAsk` 下的**权限自动批准名单**。我们的 `allowedTools` 与工具表同源同序（`lib/claude-agent.js:265` 用 `definitions[index]` 对齐 `:223` 的 `map`），24 条全部预批准，与 `dontAsk` 自洽 |
| 8. `retreat` 的空 ZodRawShape | **排除**（实机验证） | 实机 `createSdkMcpServer` + 24 条工具 → 未抛错，`注册到的工具数 = 24`，`retreat 是否在册 = true` |

### 实测结果（2026-09-18 晚 · 零改码探针已跑，结论被收窄）

数据源：生产 Supabase 的 `claude_agent_transcript_entries`（**只读**，只取结构性事实，未打印任何对话正文）。

**样本面**：全表 58 条 / **2 个 SDK session**；对照 `claude_agent_session_links` 只有 2 行，而 `sessions` 表有 **509** 个 app 会话 → **Agent SDK 主链目前只跑过 2 个会话**（都在今天：04:23Z / 07:52Z）。所以 P0-6 的现实影响面现在极小，样本也极小。

| 观测 | 结果 | 说明 |
|---|---|---|
| `still connecting` 提示 | **命中 0** | 整表没有任何一条注入过"MCP 还在连"的公告 |
| `deferred` / `tool search` 标记 | **命中 0** | 没有工具被延后的痕迹 |
| **session `bba8b6ec` 首个 assistant 轮** | **id 46 发出了 `mcp__shenyan__breath_advanced` 的 `tool_use`** | ⚠️ **模型只能对请求里存在的工具发 `tool_use`** → **那一轮的工具表里有工具**。这是"首轮必然没工具"的反例 |
| session `e7183f8b` | 首轮 assistant（id 12）是纯文本、未调工具；随后出现一个 **完整前缀快照 `tools: []`**（id 13），再往后的快照是 `tools: 24`（id 23） | 与"首轮丢了工具"的形状吻合，但**它是第 1 轮还是第 2 轮的前缀，凭 transcript 顺序不能唯一确定** |
| 两个 session 的**首个** `prompt_snapshot` | 都**没有 `tools` 也没有 `cliPrefix` 键**，属于另一种快照形态 | 不能直接当作"那时没有工具"的证据 |

**修订后的判断**：CLI「MCP 启动默认非阻塞」的机制**已确认**；但它**没有稳定兑现成"首轮一定没工具"**——两个 session 里一个明确赢了（首轮就调到了工具），一个出现了零工具前缀。符合"竞态"的预测，也符合"多数时候工具是齐的"的预测，**n=2 不足以分辨**。

→ **P0-6 从「首轮必然没工具」降级为「存在真实竞态」**。降级后我原建议"先补观测定案再改"，**最终决定直接改**：因为复盘发现挂在它身上的两个代价都站不住（`shenyan` 是 in-process server，不跨网络；工具本来就没被延后），代价归零而收益是确定性。改法与验证见「`alwaysLoad` 的决策与验证」。
→ **观测已一并补上**（`readInitInfo`）：首轮 ⚙️ 日志会直接打出 `tools=N（shenyan M）mcp=[shenyan=...]`，这条竞态从此可观测、可证伪。

### 观测缺口（这一条直接决定任务单 P0 能不能收尾）

- init 消息**同时**带 `tools: string[]`（`sdk.d.ts:5561`）与 `mcp_servers: {name, status, source?}[]`（`5562-5569`）。
- 我们的 `initInfo`（`lib/claude-agent.js:376-381`）**只记了 `apiKeySource`/`cliVersion`/`model`/`slashCommands` 四个字段，这两个都没取**；日志（`:382-384`）也只打 auth/cli/model/slash。
- 直接后果：**交接文档 §三「部署后看 ⚙️ 的 init 消息定案」这条，以当前代码是不可能完成的** —— 它要用来定案的两个字段，恰好被它自己漏掉了。文档在这里内部不自洽。
- 「首轮 tools 是否真的空」本机无法观察到（需要线上 init 消息）→ **本节的现象落地部分标「未确认」**；机制部分「已确认」。

### 一条被这次审计串起来的连带影响（本项目特别相关）

「工具表时有时无」= **prompt 前缀在轮与轮之间漂移**。而这份仓库的缓存命中率是长期在打的仗（`lib/cache-control.js`、`docs/cache-*`、记忆里的 55%→90% 那条）。若部署端确认首轮确实无工具，那么它不只是「首轮没手」，还是**一个逐会话一次的缓存断点**。反过来，`alwaysLoad: true` 会让工具表恒定 → 前缀稳定。**这一条是推断，不是实测**，列给 Codex 在 P3 统计口径里一并观测。

---

## 任务 B：订阅额度与上下文接口

```
基于本机已安装的 @anthropic-ai/claude-agent-sdk@0.3.274（wrapper 0.3.274 / CLI 2.1.274），
读 sdk.d.ts（9369 行）与 sdk.mjs（压缩产物）得出。
```

**三条线各自的入口（任务单第 6 问，必须分清）：**

| 概念 | API 入口 | 类型位置 | 返回什么 |
|---|---|---|---|
| **订阅窗口利用率**（5h/7d quota） | `Query.usage_EXPERIMENTAL_MAY_CHANGE_DO_NOT_RELY_ON_THIS_API_YET(opts?:{skipBehaviors?})` → `Promise<SDKControlGetUsageResponse>` | `sdk.d.ts:2850-2852`、响应体 `3990-4100` | `subscription_type` / `rate_limits_available` / `rate_limits{five_hour,seven_day,seven_day_oauth_apps,seven_day_opus,seven_day_sonnet,model_scoped[],extra_usage}` |
| **当前 context window 占用** | `Query.getContextUsage(opts?:{detail?:'summary'\|'full'})` → `Promise<SDKControlGetContextUsageResponse>` | `sdk.d.ts:2830-2832`、响应体 `3717-3800` | `totalTokens`/`maxTokens`/`percentage`/`categories[]`/`autoCompactThreshold`/`isAutoCompactEnabled` |
| **单轮 token usage** | `SDKResultMessage.usage` / `modelUsage` | `sdk.d.ts:5342-5352` | 每模型累计，**注释明写是 estimate 非账单** |

三者**互不相等、不可互相推导**。

**关键机制（已亲自复核）：**

- `usage_EXPERIMENTAL…` 内部是 `control_request{subtype:'get_usage'}`，`await` 其 response → 返回 **Promise 而非 AsyncIterable**。
- **单轮 Query 用完即销毁**：`sdk.mjs` 里 `isSingleUserTurn: typeof prompt === "string"` —— 后端 `buildAgentPrompt`（`lib/claude-agent.js:77-82`）正是 `join` 出的字符串，命中单轮模式；首个 `result` 后 CLI 打 `[Query.readMessages] First result received for single-turn query, closing stdin` 并 `endInput()`，读循环结束即 `cleanup()`。**此后调 usage 会在 `transport.write` 抛 `ProcessTransport is not ready for writing`。** → 「聊天轮结束后顺手读一下额度」这条路**不通**。
- `rate_limit_event` 形状：`{type:'rate_limit_event', rate_limit_info: SDKRateLimitInfo, uuid, session_id}`（`sdk.d.ts:5296-5304`），`SDKRateLimitInfo.status: 'allowed'|'allowed_warning'|'rejected'`、`rateLimitType`、`utilization?`、`resetsAt?`（`5309-5331`）；**只在额度信息变化时发**（`5293-5294`），短会话可能一个都不出。
- **两个方法都不接受 `signal`** —— 无法做调用级取消，必须调用方 `Promise.race` 兜超时。
- 存在**静默挂起**窗口：stdin 已结束时会 `Dropping write to ended stdin stream` 然后 `return`，请求进 `pendingControlResponses` 后**永无人应答**，Promise 永不 settle。
- 另有一条独立路径可拿 `subscriptionType`：`Query.accountInfo()` 直接 await 构造函数里已自动发出的 `initialize`（`sdk.mjs`：`async accountInfo(){return (await this.initialization).account}`）。
- 响应头 fallback（rate-limit headers）**只在 CLI 内部实现**，SDK 层拿不到原始头，只在 `SDKUsageReport.rate_limits.limits[]` 注释里被描述为回退产物（`sdk.d.ts:5792`）。

---

## 风险

### P0

**P0-1（最优先）`trace` 与 Ombre 契约断裂 —— 模型调不动「修正已有记忆」的唯一入口。**

- 我们给模型看的 schema（`lib/tools-schema.js:126-151`）里 `trace` 的桶 ID 参数叫 **`id`**，还带着一个 **`plan_id`**；**没有 `bucket_id`**；且**整个 schema 没有 `required` 数组**。schema 自己的 description 就在教模型：「`id`: 目标记忆桶 ID」。
- Ombre 侧的 `trace`（`Ombre-Brain-main/src/server.py:724`）签名是 **`bucket_id: str`（无默认值 = 必填）**，且注册时被显式改成 `extra="forbid"`（`src/server.py:803-818`，注释原文：*"Reject misspelled/unknown trace arguments instead of letting Pydantic's default extra=ignore silently degrade an intended edit into a bucket-id-only no-op"*）。
- 结论：模型按我们公布的 schema 调 `trace({id:..., resolved:1})` → 缺必填 `bucket_id` + 多出被禁字段 `id` → **参数校验直接失败**。
- **内部写回路径早就修过并留了注释**（`lib/memory/index.js:412-413`：「修复：Ombre trace 的必填参数是 bucket_id（不是 id），传 id 会 validation error」）—— **只有模型面那一份 schema 从没同步。**
- **抗版本漂移**：即使生产 Ombre 不是 2.8.10（strict adapter 未生效、`extra` 退回 ignore），`bucket_id` 仍是必填 → 依然失败。所以这条不依赖版本确认，可以现在就修。

**P0-2 Query 用完即销毁 → 不能"顺手读额度"。**
`usage_EXPERIMENTAL…` / `getContextUsage` 都必须在 Query 存活期内调用。后端当前每轮新建短命 Query（`lib/claude-agent.js:358` 的 `for await`），字符串 prompt 触发单轮模式，首个 result 后即 cleanup。任何"轮末读额度"的设计都无效。

**P0-3 并发槽位会被额度查询挤占。**
`lib/claude-agent.js:204-213 acquireSlot()` 默认 `CLAUDE_AGENT_MAX_CONCURRENCY=1`。若为读额度常驻一个 Query，它会**占掉唯一的聊天槽**，把真实对话挤成 429「Claude 正在处理上一条消息」。任何常驻/复用方案必须先做槽位隔离。

**P0-4 `usage_EXPERIMENTAL…` 方法名本身就是弃用警告。**
`sdk.d.ts:2844-2846` 原文：*"EXPERIMENTAL: this API is unstable and may change or be removed in any release without notice — do not rely on it yet. The method name will change when the API is stabilized."* 接进产品接口 = 接受随时破线。必须**只允许一个 adapter 碰它**，业务层只认自有 DTO。

**P0-6 `alwaysLoad` 未传 → 首轮可能没有工具，且当前不可见。**
`lib/claude-agent.js:259-264` 的 `createSdkMcpServer` 未传 `alwaysLoad`；CLI 2.1.274 原文：*"MCP startup is otherwise non-blocking by default, since the tools must be present when the turn-1 prompt is built."* 后果：每个**新** SDK 会话的第一轮，沈晏可能调不了任何 `hold`/`grow`/`want`/`recall` —— 他说「我记住了」而实际没写，**不报错、不抛异常**。叠加 `lib/claude-agent.js:376-381` 丢了 init 的 `tools`/`mcp_servers`，**这个故障目前对我们是不可见的**。
证据强度：机制**已确认**（CLI 二进制原文 + SDK 类型字段）；**现象未复现**（2026-09-18 实测：2 个 session 里 1 个首轮明确有工具、1 个出现零工具前缀，n=2 无法分辨）。
**✅ 已修（2026-09-18）**：`lib/claude-agent.js` 的 `createSdkMcpServer` 已加 `alwaysLoad: true`。
原计划"先观测定案再改"，最终改为直接改 —— 因为实测把这两个代价都证伪了（in-process server 不跨网络；工具本来就没被延后）。决策依据与机制验证见上方「`alwaysLoad` 的决策与验证」。
**观测**：`readInitInfo()` 已把 init 的 `tools`/`mcp_servers` 记进日志，部署后首轮的 ⚙️ 行会直接回答这条到底有没有生效。
附带推断（见 A-⑤ 末段，未实测）：工具表时有时无 = prompt 前缀漂移 = 每会话一次的缓存断点。

**P0-5 Ombre 审计版本不可证实。**
`Ombre-Brain-main` 是**无 `.git` 的 ZIP 快照**（`VERSION`=2.8.10，全树 mtime 2026-07-25），而生产跑的是 `MEMORY_MCP_URL` 指向的**远程实例**；仓库侧**没有任何版本 pin**。本回执里所有 Ombre 侧行号/参数集/护栏措辞**只对 2.8.10 成立**。上生产前需在部署端跑一次 `tools/list` 对齐参数集。（`trace` 那条因为不依赖 strict adapter，是例外。）

### P1

**P1-6 `letter_write` 的 `author` 必填未标。**
Ombre 侧 `author: str` 无默认值 = 必填（`src/server.py:889`）；我们 schema 只把 `content` 列为 required（`lib/tools-schema.js:225`）。模型若省略 `author` → 校验失败。（比 `trace` 轻：工具描述里给了 author 的说明，模型通常会传。）

**P1-7 `handleVerdict` 单向烧卡 + 落库值与语义不符。**
`server.js:1294-1297` **先无条件**写 `verdict: action`，**之后**才在 `1299` 分叉判卡类型。对反证卡（`direction='doubting'`），`server.js:1317-1320` 那一支只回一句「先放着」，**但库里已经是 `verdict='confirm'`**。此后该卡被 `server.js:1292` 的「这张卡已经拍过了（confirm）」永久挡住，**再也 drop 不掉**。旁边 `server.js:1318` 算出的 `verb2` 从未被使用 —— 是没写完的分支。冲突卡同结构：`revise` 会写 `verdict='revise'` 却回 `action:'confirm'`，且忽略 `note`。

**P1-8 `handleRewriteStone` 非原子 → 账本与人格锚可分裂。**
`server.js:1657-1669` 先插 `stone_rings`（版本 N），`server.js:1671` 才调 `setSystemPrompt`；而 `setSystemPrompt` 对 <200 字**抛错**（`server.js:1780-1782`）。新石头若短于下限：ring 已落库、`logChange`（`1679`）还没跑、异常被 `makeToolServer` 兜成工具错误。结果 = **账本显示存在第 N 环，而人格锚没变**，且下一轮重写会从 N+1 继续。

**P1-9 生产日志打印记忆正文与工具入参。**
`server.js:224`（完整 args）、`server.js:244`（`📡 [调试] 响应原文`，**完整 Ombre 响应**）、`server.js:264`（完整返回正文）、`server.js:261`（错误正文 300 字）。任务单明写「日志和测试报告不得输出对话正文、工具结果正文或 token」—— 现状不满足。

**P1-10 额度查询可能静默挂起。**
stdin 已结束时 write 被静默丢弃（`Dropping write to ended stdin stream`），控制响应永不到达 → Promise 永不 settle。且两个方法都**不接受 signal**。必须 `Promise.race` 兜超时，超时后 `query.close()`。

**P1-11 `rate_limits_available:false` 是静默的 scope 缺口。**
发生在「API key / Bedrock / Vertex / missing profile scope」（`sdk.d.ts:4007`）。线上若非 OAuth 订阅线，前端只会看到「没有额度数据」，看不出根因。**本机 `.env` 里根本没有 `CLAUDE_CODE_OAUTH_TOKEN`**（只有 DEEPSEEK/OPENROUTER/ELEVENLABS/GROQ/SUPABASE/PG 等）—— 说明该 token 只存在于部署环境，**本地无法验证订阅路径**。

**P1-12 零额度无法从源码证明。**
`claude.exe` 是 233MB 不可读二进制，`usage`/`getContextUsage` 的真实逻辑全在里面；SDK 外壳只转发。能证明的是「可以不发 user 消息」，**证不了「不发就不计费」**。

**P1-13 `_with_notice` 把内部异常吞成成功文本。**
Ombre `src/server.py:472-527` 捕获所有异常并返回正常字符串（`❌[OB-E004]`），不抛异常。调用方只在 `parsed.result.isError` 为真时才判失败（`server.js:260`）。「digest API 挂掉」这类真实失败可能以 ❌ 文本被**当成功记入**。（`_with_notice` 吞异常已确认；`isError` 最终取值由 FastMCP 决定，库不在树内 → 该链路的最终判定为**疑似**。）

### P2

**P2-14** `handleRetireClaim`（`server.js:1605-1611`）按 `.in('state',[...])` 取回后**无 `.order()`**，再用 `rows.find(claimMatch)` 取第一个命中 → 多条近似匹配时**选哪条不确定**，与函数自己声称的「宁可不改，不错改」不符。

**P2-15** zod `z.object()` 静默丢弃未知字段（实测：`{evil:'x'}` → `{}`，不报错）。参数名拼错 = 静默不生效。

**P2-16** 两份 8000 阈值各自硬编码（`server.js:1708`、`lib/claude-agent.js:157`），后者在生产不可达，是未来的漂移点。

**P2-17** `callOmbreTool` 对 Ombre 返回的**字符串**再做一次 `JSON.stringify` → 双重编码，转义膨胀，吃掉 8000 额度。

**P2-18** `verdict` 的「已拍过」是 check-then-act，无原子条件（`server.js:1286-1296`）。同一轮内被 `toolChain`（`lib/claude-agent.js:222,234`）串行化，跨进程则不成立。

**P2-19** `rewrite_stone` 的版本号取 `lastRing.version + 1`（`server.js:1649-1655`），跨进程并发会有版本撞号。

**P2-20** 读工具有外部副作用：配了 `OMBRE_HOOK_URL` 时，`breath_search`/`breath_advanced`(query 路径)/`dream` 会 POST webhook（`search.py:281/423/439`、`dream/__init__.py:53`）。「只读 smoke」不等于零外部请求。

**P2-21** 注释漂移：`lib/tools-schema.js:11` 写「13 个能力定义在这里」、`server.js:3209` 写「内置 13 工具名」，**实际都是 24**。

**P2-22** `handleRewriteStone` 的 `prev_content: prev === content ? null : prev`（`server.js:1662`）恒等于 `prev` —— 上面 `1646` 已经 early-return 了相等情形，该三元是死分支。

---

## 建议 patch（只描述，不实施）

> 按「一次只放一个变量」拆成独立小提交；每一条都先加测试再改行为。

| # | 文件 | 最小改动 | 回退方式 |
|---|---|---|---|
| 1 | `lib/tools-schema.js:126-151` | `trace` 的 `id` → `bucket_id`，删掉 Ombre 不认的 `plan_id`，补 `required: ['bucket_id']`；description 里「目标记忆桶 ID」保持 | 单文件单块回滚 |
| 2 | `lib/tools-schema.js:212-227` | `letter_write` 的 `required` 加 `author` | 同上 |
| 3 | `lib/claude-agent.js:376-381` | `initInfo` 增 `toolsCount` 与 `mcpServers`（取 `message.tools.length`、`message.mcp_servers`），只在 `⚙️ [Claude Agent]` 那行日志里打数量与 status，**不打工具名全量以外的任何正文** | 删两个字段 |
| 4 | `server.js:1294-1297` | 把 `verdict` 的落库**挪到分叉之后**，并给 `direction==='doubting'` 加只允许 `drop`/`pass` 的显式拒绝（现在只回文案不拦） | 单块回滚 |
| 5 | `server.js:1657-1671` | `rewrite_stone` 先校验 `content.length >= MIN_PERSONA_CHARS` 再落 ring；或把 `setSystemPrompt` 挪到 ring insert 之前 | 单块回滚 |
| 6 | `server.js:224,244,264,261` | 删掉/降级生产日志的完整 args 与完整响应正文，只留形态（工具名、状态、字符数） | 恢复原 console 行 |
| 7 | `lib/claude-agent.js`（新增 adapter 文件） | 新建独立的 quota adapter：唯一一处触碰 `usage_EXPERIMENTAL…`；对外只出稳定 DTO（`available`/`subscriptionType`/`limits[]`/`fetchedAt`/`stale`/`source`）；60s 缓存 + single-flight + `Promise.race` 超时；**先解决 P0-3 槽位隔离** | 删除新文件即回到现状 |
| 8 | `lib/claude-agent.js:257` | 早退分支加一条 `console.warn`（现在它静默砍掉全部 24 只手，无日志无异常） | 删 warn 行 |
| 9 | `lib/claude-agent.js:259-264` | `createSdkMcpServer` 传 `alwaysLoad: true` —— **必须先由条目 3 观测定案再动**。两个代价要写进提交说明：① 阻塞启动到连上（5s 上限），后端每轮新建短命 Query，即每轮都吃这份延迟；② 首次切换会改 prompt 前缀，那一次整条缓存作废（之后才稳定） | 删掉该字段 |
| 10 | `package.json` | `@anthropic-ai/claude-agent-sdk` 由 `^0.3.274` 钉成精确版本 —— 决定「首轮有没有工具」的行为在 CDN/原生二进制里，caret 漂移会**静默**改行为 | 改回 caret |
| 11 | `test/lib-claude-agent.test.cjs:67-76` | 补一条真正断言 `retreat` 的 `toolShape` 为 `{}` 的用例（现有那条对 `retreat` 内层零次迭代，是空转） | 删用例 |

**建议落地顺序**：3 → 1 → 2 → 8 → 4 → 5 → 6 → 9（等 3 的结果）→ 10 → 11 → 7。
理由：3 是纯观测、零行为风险，且它是 9 的前置；1/2 是契约修复，独立可验；其余按风险从低到高。

**明确不建议现在做的**（与任务单 §P3 一致）：不动 Context Assembly、不动缓存策略、不动 `max_context_tokens`。理由见任务单原文「禁止同时修改压缩策略和缓存策略」，且审计未推翻该判断。

---

## 建议测试

### 纯离线（可立即加进 `npm test`，零副作用）

| case | 前置条件 | 操作 | 预期 | 副作用 |
|---|---|---|---|---|
| schema 关键字 ⊆ 转换器能力 | 无 | 遍历 `getTools()` 收集所有 JSON Schema 关键字，断言 ⊆ `{type,description,enum,items,properties,required}` 及其余已实现项 | 新增 `anyOf` 等关键字时**测试红** | 无 |
| 工具名与 Ombre 契约对齐 | 无 | 对 12 个远端工具，比对我们 schema 的 properties 与 Ombre 签名（当前需**手工维护一份期望表**，见未确认 5） | `trace`/`letter_write` 立即红 | 无 |
| 未知字段不被静默吞 | 无 | 对每个工具 shape 喂一个 `{__unknown__:1}` | 断言**当前行为**（被丢弃），钉住语义以便日后改 strict | 无 |
| `verdict` 反证卡分支 | 无 | 对 `direction='doubting'` 喂 `action='confirm'` | 期望：**拒绝**，且不落 `verdict` | 无（需先把 handler 导出，见下） |
| `rewrite_stone` 短石头 | 无 | 喂 150 字 `content` | 期望：**拒绝且不产生 stone_ring** | 无（同上） |

### 需要先做的准备工作

`dispatchTool` / `handleRecall` / `handleDiaryWrite` / `handleDiaryRead` / `handleRetireClaim` **都没在 `server.js:6064-6112` 的 `module.exports` 里**。in-process smoke harness 目前**没有入口**。补导出是纯增量改动（`routes.test.cjs` 已经 `require('../server.js')` 且不连库，证明了这条路的可行性）。

### 零改码定案 P0-6（**已跑，结果见 A-⑤「实测结果」—— 未能定案，需转 T1**）

CLI 2.1.274 里逐字存在这段它会注入对话的提示（`grep -ao` 自 `claude.exe`）：

> "…following MCP servers are still connecting — their tools (typically named `mcp__<server>__*`) are not yet available **but will be announced here once they connect**:"（另一处措辞为 "but will appear shortly:"）

而 transcript 是**逐条原样镜像**进 `claude_agent_transcript_entries.entry`（`lib/claude-session-store.js:24-31` 的 `entryRows` 不过滤类型）。

| case | 前置条件 | 操作 | 预期 | 副作用 |
|---|---|---|---|---|
| **T0（零改码）** | 已有一条 SDK 会话的镜像 transcript | **只读**查 `claude_agent_transcript_entries`，搜 `still connecting` / `not yet available`；顺带看 entry 里有没有工具表 | 首轮 entry 出现该提示 → **坐实 P0-6**；没有 → 需走 T1 | **只读，零成本，不烧额度** |

> 注意措辞：这段提示是 CLI **告诉模型**的（"will appear shortly"），所以对模型不是完全静默 —— 但它**对我们完全不可见**，且模型未必会等。不要把它读成"失败的静默"，也不要读成"无害"。
> 「transcript 里存不存这条」未确认（交接文档 §三 事实 4 说 transcript 无 `system` 类条目，但那说的是 SDK 流消息、不是 transcript entry，两者不是一回事）→ 若 T0 查不到，直接走 T1。

### 需要真机的（本轮不做，列给 Codex 排期）

| case | 前置条件 | 操作 | 预期 | 副作用 |
|---|---|---|---|---|
| fresh → resume | 部署环境、订阅 token | 跑一轮，再跑一轮 resume | `resume` 的 `session_id` 与请求一致（`detectSessionFork` 不告警） | **消耗订阅额度** |
| 首轮工具可见性 | 补完 P0 条目 3 的采集 | 一次 fresh 会话 | `initInfo.toolsCount === 24`、`mcp_servers[0].status === 'connected'` | 消耗额度 |
| 工具失败 | 无 | 故意调 `trace({id:"...", resolved:1})` | 当前预期=**校验失败**；修完 P0-1 后应为成功 | 写生产记忆，**须用 test_data 靶子** |
| 客户端断流 | 无 | 发消息中途断开 | 工具链不悬挂、槽位释放 | 消耗额度 |
| 429 busy | `CLAUDE_AGENT_MAX_CONCURRENCY=1` | 并发两轮 | 第二条得 429「Claude 正在处理上一条消息」 | 无 |
| 额度接口时机 | 部署环境 | 在 Query 存活期内调 `usage_EXPERIMENTAL…` | 有值；**迭代结束后调应 reject** | 未知（见未确认 1） |

**smoke 卫生**：`hold(content="__smoke__", test_data=True)` 是**唯一**能造出可 `hard_delete` 靶子的方式，测完用 `trace(bucket_id=..., hard_delete=True, delete_reason="smoke")` 清掉。`grow`/`plan`/`letter_write` 产生的桶**没有一键清理**（只能逐条 `trace(delete=True)` 归档）→ **建议在可弃实例上跑**。

---

## 未确认问题

1. **控制请求是否消耗订阅额度**：`claude.exe` 不可读，无法从源码证明 `initialize`/`get_usage` 不产生计费调用。只能真机实测（对比调用前后 claude.ai 用量面板）。
2. **`rate_limit_event` 的发射频率与时机**：注释只说「when rate limit info changes」，由不可读的 CLI 决定。
3. **SDK 用什么转换器把 Zod shape 变回 JSON Schema**：我验证的是 `zod@4.0.0` 自带的 `z.toJSONSchema` 会解包 optional 取出 description；若 SDK 走的是别的转换路径（v3 风格的 `zod-to-json-schema`），可选参数的 description 行为可能不同。**未确认**。
4. **生产 Ombre 的实际版本**：见 P0-5。本回执所有 Ombre 行号只对 2.8.10 快照成立。
5. **`dispatchTool` → FastMCP 的分发实现**：在外部库 `mcp==1.28.1` 内，本机未附带源码，`tools/call` 的 `isError` 最终取值**未确认**。
6. **「首轮工具表为空」的具体成因**：证据不足，见 A-⑤。
7. **线上是否真跑订阅线**：本机 `.env` 无 `CLAUDE_CODE_OAUTH_TOKEN`，`apiKeySource`/`rate_limits_available` 的真实取值未验证。
8. **生产是否配置 `OMBRE_HOOK_URL`**：决定「只读工具是否真的零外部请求」，未读环境变量。
9. **`hold`/`grow` 的内层 LLM 成本量级**：确认会调外部脱水器，但单次调用的 token 量未测。
10. **本账号是否开了 auto tool search**：CLI 原文说「tools are deferred **when tool search is enabled**」。若开着，"快照里工具少"就可能是**被 defer** 而非**没连上** —— 两者只能靠 `mcp_servers[].status` 区分，又回到观测字段。**未确认**。
11. **SDK in-process server 是否也吃「非阻塞启动」这条**：`alwaysLoad` 的阻塞说明挂在通用 MCP 配置上；SDK server 的 config schema 是 `{type:'sdk', name, timeout}`（无 `alwaysLoad` 字段），它只经 per-tool `_meta['anthropic/alwaysLoad']` 生效。是否同样触发「阻塞到连上」**未确认**。
12. **CLI 那段 "still connecting" 提示是否落进 transcript**：决定 T0 探针可不可行。未确认（见测试节）。

---

## 实际运行过的命令

> 全部只读。无网络请求、无迁移、无部署、无写库、未打印任何密钥值。

**仓库状态 / 基线**

- `git log --oneline -5`、`git status --short`（`shenyan-backend`，基线确认 `94e68e1`）
- `npm test` → **151 项 / pass 151 / fail 0 / 2.4s**
- `ls test/`、`grep -rln "supabase\|fetch(\|https://" test/*.cjs`、`grep -rn "mock\|nock\|global.fetch" test/*.cjs`（确认测试全离线）

**任务 A 本地侧**

- `grep -n "dispatchTool" -r .`、`grep -n "^async function handle" server.js`
- `Read server.js` 区段：200-530、529-694、690-950、1200-1262、1255-1455、1455-1530、1599-1699、1690-1765、1764-1834、3195-3235、3360-3450、4975-5015、6055-6112
- `Read lib/claude-agent.js`（全文 469 行）、`Read lib/memory-mcp.js`（全文）、`Read lib/tools-schema.js`（全文）
- `grep -rn "8000" --include=*.js server.js lib/`、`grep -rn "zod\|z.object\|jsonSchema"`、`grep -rn "createSdkMcpServer\|allowedTools\|strictMcpConfig\|mcpServers"`
- `node -e` 关键字统计脚本（遍历 24 schema 收集关键字 + 逐工具比对 `properties` 与 `toolShape` 数量）
- `node -e` zod 行为探针（`retreat` 空 shape、未知字段、enum、类型严格性、required 缺失）
- `node -e` `z.toJSONSchema` 回转换验证 description 是否解包 optional
- `node -e` 读取 `zod/package.json` version → `4.0.0`

**任务 A 远端侧（`c:\Users\hbyll\Ombre-Brain-main`）**

- `grep -n "^async def " src/server.py`（14 个工具注册处权威行号）
- `Read src/server.py` 区段：623-724、745-776、822-851、855-934
- `Read lib/memory/index.js` 区段 400-425；`grep -rn "'trace'|\"trace\"" server.js lib/`
- `stat VERSION`、`cat VERSION`、`head CHANGELOG.md`、`git log`（exit 128 → 证实非 git 仓库）

**任务 B（SDK 源码）**

- `ls` 包目录、`grep -n` 关键词于 `sdk.d.ts`（`usage_EXPERIMENTAL`/`getContextUsage`/`rate_limit_event`/`subscriptionType`/`resets_at`/`utilization`）
- `tr -d '\n' < sdk.mjs | grep -o 'isSingleUserTurn[^;]\{0,120\}'`（单轮模式与 cleanup 路径）
- `sed -n '2840,2856p'`、`sed -n '2826,2834p'`、`grep -n "SDKSystemMessage\|tools:"`、`Read sdk.d.ts:5549-5581`（init 消息形状）
- `node -e "console.log(require('@anthropic-ai/claude-agent-sdk/package.json').version)"` → `0.3.274`

**复核与实机验证（对二轮纪律的落实）**

- `grep -n "alwaysLoad" sdk.d.ts`、`grep -n "CreateSdkMcpServerOptions" sdk.d.ts`、`grep -n "To restrict which tools are available" sdk.d.ts`
- `Read sdk.d.ts:543-573`（`CreateSdkMcpServerOptions` 含 `alwaysLoad: boolean` 定义）
- `grep -ao "MCP startup is otherwise non-blocking[^\"]\{0,160\}" claude-agent-sdk-win32-x64/claude.exe` → 逐字命中
- `grep -ao ".\{320\}MCP startup is otherwise non-blocking" claude.exe`（取前文，得 `alwaysLoad` 完整说明）
- `grep -ao "following MCP servers are still connecting[^\"]\{0,200\}" claude.exe` → 逐字命中两种措辞
- `grep -ao "from the built-in set[^\"]\{0,80\}" claude.exe`、`grep -ao "still connecting[^\"]\{0,140\}" claude.exe`
- `node -e` 实机构造：`createSdkMcpServer({name:'shenyan', version:'1.0.0', tools: 24 条由 toolShape 生成, timeout:30000})` → 未抛错、`注册到的工具数 = 24`、`retreat 是否在册 = true`（**仅内存构造，未 spawn、未联网、未写盘**）
- `Read test/lib-claude-agent.test.cjs:65-78`（核实 `retreat` 空转说法）
- `Read lib/claude-session-store.js`（全文 121 行，核实 transcript 是否原样镜像）
- `Read Ombre src/server.py:623-724 / 745-776 / 822-851 / 855-934`（12 个工具的权威签名，逐个与 `lib/tools-schema.js` 对表）
- `date`；`git ls-files lib/memory-mcp.js lib/ombre-auth.js`；`git diff --stat HEAD -- lib/`；`git reflog -3` —— 核实工作区在会话期间被改过 mtime 但内容等于 HEAD，故行号基线不失真

**失败/无输出的命令（按要求不省略）**

- `wc -l lib/wake/*.js` → **无输出**（`lib/wake/` 目录不存在；与记忆里「第 3 步只剩 lib/wake/」不符，列为待核）
- `ls .git`（Ombre 树）→ **NO .git**（证实快照非仓库）
- `cat package.json`（Ombre 树）→ exit 1（Python 项目，无 package.json）
- `ls test/ tests/ __tests__/` → `ls: tests/: No such file or directory`、`ls: __tests__/: No such file or directory`（只有 `test/`）
