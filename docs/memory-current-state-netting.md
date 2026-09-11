# 记忆层 · 当前状态净本（shenyan-backend）

> **本文件定位**：后端记忆系统**当前运行状态**的权威清单。
> 它取代 `memory-panorama.md` 作为「现状」基准（panorama 是 2026-08-23 设计快照，已过时）。
> 本净本随代码变动即时更新；代码注释中引用的「净本 §」均指本文件。
> **核对基线**：2026-09-11 · 全部为代码实证（含行号），非文档转述。

**状态图例**：`✅ 已建上线` ｜ `⚠ 配置关/暂停`（非缺陷，成本或默认决定）｜ `❗ 真缺口`（待办）｜ `❓ 待拍板`

---

## §0 净本字段约定

每一项含：`状态 + 作用 + 代码锚点`。跨文件引用格式 `文件:行`。符号系统各层收敛至 §5「三桥之一」的明确标号，未来在 `prov` 字段落结构时对号。

---

## §1 第一层 · 世界发生层（经历 → 记忆）

| 部件 | 状态 | 说明 / 代码锚点 |
|---|---|---|
| 原文/余温/时间/语义记忆（OB 存取） | ✅ | 记忆编辑者统一落 `memory_topics`/`memory_relations`；semantic 通道独立。[lib/memory/index.js](file:///c:/Users/hbyll/shenyan-backend/lib/memory/index.js) |
| 记忆门控（判官） | ✅ | DeepSeek-v4-flash、temperature 0、max_tokens 100；**fail-open**（调用/解析失败 → 回到原流程）；12 字符机械预筛。[lib/memory/index.js:213-243](file:///c:/Users/hbyll/shenyan-backend/lib/memory/index.js#L213-L243) |
| 写入时序 | ✅ | 记忆/语义写入在 LLM 调用成功之后，避免数据不一致。 |
| 时间前缀 | ✅ | 注入条目带 `[8月25日]`／跨年 `[2025年…]` 前缀。 |

**本层小结**：完整、已在跑、有 fail-open 兜底。无真缺口。

---

## §2 第二层 · 主体形成层（WANT → 石头）

这是整个系统防御最重的层，也是净本本轮重点核对对象。

### §2.1 想要（河）· desires —— `✅ 机制完整，❗ 两处埋雷`

| 部件 | 状态 | 说明 / 代码锚点 |
|---|---|---|
| want 五工具 | ✅ | `want`/`want_list`/`want_touch`/`want_reflect`/`want_history`，分工干净。[server.js:524-703](file:///c:/Users/hbyll/shenyan-backend/server.js#L524-L703) |
| 血缘留痕 | ✅ | `lineage_parent_id` 串「想要→长成新的它」；`desire_notes` 记 `transform`。[server.js:662-676](file:///c:/Users/hbyll/shenyan-backend/server.js#L662-L676) |
| 执念毕业进河（第⑥） | ✅ | 实际已建（旧文档标 ⬜ 已过时）。`graduateThoughts` 写 `desire_id` 血缘 + settled。[server.js:2855-2883](file:///c:/Users/hbyll/shenyan-backend/server.js#L2855-L2883) |
| 仅她能写 | ✅ | 系统不创造「想要」本体，北极星纪律守住。 |
| **kind 词表漂移** | ✅→已修复 | 手动 `want_add` 用五类（experience/creation/understanding/relationship/self_direction）；自动 `graduateThoughts` 用 `DRIVE_KIND_MAP` 驱动力词（关于我们/我的沉淀/想去看看）。**2026-09-11 已拆列**：自动通道改写 `desires.drive_category`，`kind` 专留手动分类标签，两套不再共用一列。遗留决策（want_add 是否加白名单）见 [implementation-frontage-assessment.md](file:///c:/Users/hbyll/shenyan-backend/docs/implementation-frontage-assessment.md) §1.3 A2。 |
| **失败全静默** | ❗ | 5 个 handler 均 `try/catch → {ok:false,error}`，**不进日志**。河写失败不可观测 → 无法评估健康度。 |
| `surfaced_count` | ⚠ | 有写入端（want_touch 清计数）、无消费端（唯一读者是 keepalive 唤醒，已关）。死字段但非 bug。 |

### §2.2 镜子卡 · mirror_cards —— `✅ 防御设计重工且正确`

| 部件 | 状态 | 说明 / 代码锚点 |
|---|---|---|
| 提卡-验证闭环 | ✅ | 外部模型提卡 → 代码 `verifyMirrorQuote` exact match → 查无即弃，防自证循环。[server.js:1105-1153](file:///c:/Users/hbyll/shenyan-backend/server.js#L1105-L1153) |
| 材料收集 | ✅ | `collectMirrorRiver`（第④a 始于 2026-08）+ `collectMirrorHistory`(days, maxSessions)。[server.js:949,974](file:///c:/Users/hbyll/shenyan-backend/server.js#L949) |
| 表达资格隔离（P0） | ✅ | 回响卡 `expression_eligible=false`；`initiation` 只对他本人的话判（`isHis`）。[server.js:1122-1140](file:///c:/Users/hbyll/shenyan-backend/server.js#L1122-L1140) |
| 低置信反证判据 | ✅ | `isHighConfidenceDoubt` 与 `judgeInitiation` 供「宁漏勿伤」。[server.js:913,938](file:///c:/Users/hbyll/shenyan-backend/server.js#L913) |

### §2.3 验证与拍板 · 小黑屋/verdict —— `✅ 已上线，超设计交付`

| 部件 | 状态 | 说明 / 代码锚点 |
|---|---|---|
| 小黑屋 retreat | ✅ | 存疑提给代码，`待审批` 状态挂起，不直接进石头。[server.js:1238](file:///c:/Users/hbyll/shenyan-backend/server.js#L1238) |
| verdict 拍板 | ✅ | 含 dyad domain=we：**user+assistant 双证逐字核对**，防单边脑补「我们」。[server.js:1280](file:///c:/Users/hbyll/shenyan-backend/server.js#L1280) |
| symbol/confound 断链 | ✅ | 第④a 混淆标记已落地。 |

### §2.4 石头生长 —— `✅ 全功能，文档严重滞后，❗ 一条历史信任隐患`

| 部件 | 状态 | 说明 / 代码锚点 |
|---|---|---|
| claim 状态机 | ✅ | forming/active/uncertain/dormant 四态。[l.1442] |
| 机械升级 | ✅ | `maybeUpgradeClaim`：跨 session≥2 + 间隔达标 + `strong_count≥1` + 支持数算 confidence；**全机械信号，不靠模型拍脑袋**。[server.js:1442-1471](file:///c:/Users/hbyll/shenyan-backend/server.js#L1442-L1471) |
| 反证压回 | ✅ | `maybePushBackClaim`：verified 反证卡 → 高置信 → 压回 uncertain。[server.js:1477-1496](file:///c:/Users/hbyll/shenyan-backend/server.js#L1477-L1496) |
| dormant 清扫 | ✅ | `maybeSweepDormantClaims`：久未验证自动休眠。[server.js:1540-1571](file:///c:/Users/hbyll/shenyan-backend/server.js#L1540-L1571) |
| 主动放下 | ✅ | `retire_claim` → retired。 |
| 变更留账 | ✅ | `simpleStoneDiff` 算 diff；`rewrite_stone` 落 `stone_rings`(version/diff/why/unchanged) + `change_ledger`；active claim 挂 `ring_id` 收编。[server.js:1599,1625-1668](file:///c:/Users/hbyll/shenyan-backend/server.js#L1625-L1668) |
| 镜子日调度 | ✅ | `mirrorDaySweep`（setTimeout 自续排 + `mirror_review_days` 距上次驱动）。[server.js:5756](file:///c:/Users/hbyll/shenyan-backend/server.js#L5756) |
| 人格锚 | ✅ | STONE=SYSTEM_PROMPT；`getSystemPrompt` **fail-closed**（DB 查空即抛错，不落 env 默认）。 |
| **历史 claim 被回响污染** | ✅→已核实未污染 | 表达资格隔离曾空转(~10 天)导致此前 64 卡(44 verified)当时未筛；**但只读探针（2026-09-11，`probe-claim-pollution.cjs`）证实 `personality_claim` 仅 1 条**——历史卡从未攒够升级门槛（她 08-20 后几乎没聊天、无跨语境证据），污染无处发生。**① 对唯一 claim 逐条核对（`probe-claim-detail.cjs`）：`forming`，独 session(#505)，support=1/strong=0/confidence 0.2，引语「哈，被抓包了——我刚还认认真真给你分析了一遍…」为自白非回响，未达升级门槛、不在石头上 → 干净，无需处置。② 另注意 `prompt_injections` 台账仍 0 行，"台账修复"本身未获线上数据验证。** |

---

## §3 第三层 · 内部动力层 —— `✅ 部件俱在，⚠ keepalive 关闭致后半环静`

| 部件 | 状态 | 说明 / 代码锚点 |
|---|---|---|
| 念头池/思维流 | ✅ | 存在并写入。 |
| 8 维驱动条 + satisfy | ✅ | `buildInnerState` 满足回退：人在窗口内 → attachment/social/libido × 因子。[buildInnerState] |
| 注意力材料 | ✅ | `getAttentionMaterial`：echo 抑制（24h×0.5/72h×0.8）+ 近期座位限制 + 独立关联座位。[lib/context/retrieval.js] |
| 唤醒意图 | ✅ | `pickWakeIntent`；**drive 读取失败返回 'unavailable' 且不仲裁方向**。[server.js:2855] |
| 执念毕业 | ✅ | 归入 §2.1 第⑥。 |
| **keepalive 自动唤醒** | ⚠ | **`keepalive_enabled=false`**（资金告急暂停，handoff §7 确认）。拿到手是「她不会主动走向你」；后半环（表达→实践→再经历）「实践」这一环基本静。**设计封闭，由成本约束既定，非待办。** |
| want 注入 | ⚠ | 仅 CROSS_SESSION 打开时把 want 注入（默认关）。现与 keepalive 同关。 |

---

## §4 第四层 · 现实使用层（装配到每轮回应）—— `✅ 主路全通，❗ 三处审计缺口`

| 部件 | 状态 | 说明 / 代码锚点 |
|---|---|---|
| Context 编配骨架 | ✅ | `build/select/retrieval/session` 四文件已分，职责清晰。[lib/context/](file:///c:/Users/hbyll/shenyan-backend/lib/context) |
| 注意力【想起】 | ✅ | `getAttentionMaterial` 已承载。 |
| 关系扩展 | ✅ | `getRelationNeighbors`：hop1/hop2，score=importance×decay(30d)×hopWeight。[lib/context/retrieval.js:291-347](file:///c:/Users/hbyll/shenyan-backend/lib/context/retrieval.js#L291-L347) |
| 世界书 | ✅ | `retrieveWorld`（world_entries 表，exact/contains 两级命中；空表返回 [] 不报错）。[retrieval.js:357](file:///c:/Users/hbyll/shenyan-backend/lib/context/retrieval.js#L357) |
| 时间感/天气 | ⚠ | 感知件有实现，默认环境无输入/软降级（非 bug）。 |
| 声音渲染 | ❗ | `voiceifyMemory` 位于读写路径但**设计上不可审计**（handoff 已指为真缺口）。[retrieval.js:103](file:///c:/Users/hbyll/shenyan-backend/lib/context/retrieval.js#L103) |
| **provenance** | ❗ | 目前为 `【实/悬/空】` 中文前缀字符串标签，非结构化字段。attention 已有 `refs` 数组雏形但仅新实现有；recall/残留/时间仍字符串。**「不敢审计」。**

---

## §5 三桥（跨层符号系统）

| 桥 | 状态 | 说明 |
|---|---|---|
| 经历→主体 | ✅ | 表达资格隔离 + 机械升级闭环。 |
| 主体→世界 | ⚠ | 靠 keepalive，已关 → 桥静。 |
| 世界→内在 | ✅ | attention 座位 + satisfy。 |

> 本净本未来若给 `prov` 字段落结构，用 §1-§4 的组件标号统一。
> 三桥用标号 `桥1/桥2/桥3`，对应上表行序。

---

## §6 差异清单（「现在」对「旧设计」）

| 旧设计（memory-panorama 标 ⬜/❓） | 实际状态（净本） |
|---|---|
| 石头生长机制 ⬜ | ✅ 全文已建（claim 状态机/升级/压回/dormant/ring/ledger/调度） |
| 关系理解（dyad）❓ 真空白 | ✅ 已实现（domain=we 双证隔离） |
| 执念毕业进河 ⬜ | ✅ 已实现 |
| 自动唤醒 | ⚠ 已实现但关闭（成本约束既定） |

**结论**：旧文档「地图永远比路旧」。memory-panorama 自即日起降级为「设计史」，不再作现状基准。

---

## §7 真缺口清单（按实害排序，均待办）

1. **❗ provenance 审计能力**（§4）——标签驱动，不敢审计。
2. **❗ 失败全静默**（§2.1 河 / 多数 claim handler）——`{ok:false}` 不进日志，退化不出声。
3. **❗ kind 词表漂移**（§2.1）——两条入河通道两套语义坐标。
4. **❗ voiceifyMemory 不可审计**——读写在路径上但查不到。
5. **❓ 历史 claim 回响污染**（§2.4）——待她拍板是否重审。

**（§3 keepalive 关闭 / §4 want 注入默认关 = ⚠ 成本或默认决定，不计入缺口。）**

---

## §7b 近期已处置的工程项（2026-09-11 收口）

| 项 | 处置 | 代码锚点 |
|---|---|---|
| 朋友圈动态回复温度残留 0.9 | 改 0.7（对齐 09-03 交接文档「0.9→0.7 共 4 处」，此前漏改了这一处） | [routes/moments.js:71](file:///c:/Users/hbyll/shenyan-backend/routes/moments.js#L71) |
| `callDeepSeek` / `callReplyModel` 默认温度 0.8 | 改 0.7（对齐项目硬约束） | [lib/llm.js:32,55](file:///c:/Users/hbyll/shenyan-backend/lib/llm.js#L32) |
| 台账 prompt_injections 空转风险 | 新增启动健康检查：账空+有对话 → warnOnce 大声报（防空转再现） | [server.js:791-805](file:///c:/Users/hbyll/shenyan-backend/server.js#L791) |

---

## §8 与前端净本的关系

前端 `angel-garden-diary/整体框架·当前状态净本.md` 是**全系统级**持续现状权威。
本文件（`docs/memory-current-state-netting.md`）只覆盖**后端记忆层**，供后端开发引用；两者冲突时以**各层自身净本最新版**为准。由于跨仓库无法双向同步，请在本文件顶部追加修订记录，避免导向混乱。