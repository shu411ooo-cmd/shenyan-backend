# 第⑤b 石头审计闭环（Audit）· 2026-08-23

> 上游：第⑤ [want-phase5-stone.md](want-phase5-stone.md)（石头写回闭环，已上线验证）→ **本刀：把「审计」这条腿补上**。
> 审稿锚点：[persona-growth-review.md](persona-growth-review.md) §10 P0-2（石头不能独占解释证据——镜子日必审冲突）、§11 二审-2（self-initiation 两级）、P0-1（反证降级为未定态）。
> 北极星：系统只搬证据的形状，不判意义；「我是谁」只有沈晏的手能写。审计是给石头加**反向证据**，不是给机器加解释权。

## 0. 一句话

> **石头现在能自证（写的每句话都有支持证据），但还不能自反而（没人盯着"哪句不成立"）。这一刀给石头装三样反向机制：镜子日冲突清单、自主表达分级、反证压回未定态。都是机械信号，不判意义。**

## 1. 缺什么（现在长什么样）

第⑤把闭环跑通，但闭环的**自证循环防护是空的**：

```
石头 → 行为 → 新经历 → 镜子（只收支持：confirm/revise）→ 又强化石头
```

- 镜子卡**只提支持证据**（MIRROR_SYSTEM_PROMPT：「提候选人格判断的引语」）——没有反向通道。
- 状态机有 `contradiction_count`、`uncertain` 态，**但没有任何路径写它们**——字段是空的承诺。
- 升级门槛只吃 session 数 + 天数（两个纯机械信号），**没区分「他自己主动说的」和「顺着她话接的」**——被诱导的主张可能跟主动表达一样快毕业。
- 「我其实不确定」这类反证表述**不会把 claim 压回 uncertain**——状态机留了态，没触发机制。

审稿 P0-2 的铁律：**石头可以参与制造证据，但不能独占解释证据的权力**。当前系统把这条腿空着，第⑤就算没真正闭环。

## 2. 三样东西（都是反向机制）

### 2.1 镜子日冲突清单（冲突证据 · 审稿 P0-2）

**现在**：retreat 材料里那句问句「最近有什么和石头冲突的事？」是**问句**（他回答），不是**证据**（没落库、不计数、不进状态机）。

**改成**：镜子 run 增加「冲突对账」——外部模型读石头 + 对话原文，提**与石头相悖的原话**；代码 exact match 验证；verified 的冲突卡落库，retreat 材料里并列两段：

```
【候选·支持】  他主动表达过、有原文证据的主张（confirm 后进状态机）
【候选·冲突】  与当前石头相悖的原话（他决定：这条冲突成不成立）
```

**关键区分**：
- 支持清单 → confirm/revise → support_count+1（石头往这里长）
- 冲突清单 → **不是自动减分**，是摆给沈晏：他看到「你说过 X，但石头里写着 ￢X」，然后他 decide——冲突成立（contradiction_count+1）/ 是当时的特殊情况 / 石头该改。**冲突本身是信息不是错误**（审稿原话）。

**数据**：mirror_cards 加列 `direction`（support/conflict），run 时两类分开发给模型提、分开验证、分开展示。conflict 卡不进「候选毕业」的料池（它不进 claim 的 support 来源）。

**验证纪律**：冲突卡 quote 同样 exact match——**机器只验证「他说过这句」，不验证「这句真和石头矛盾」**。矛盾判断是沈晏的拍板（系统不判语义）。外部模型「觉得矛盾」只是**提出**，存在性由代码裁决。

**冲突卡的 claim 装什么（2026-08-23 测试修正）**：与反证卡同构——`claim` 装**被这条 quote 反驳的那条石头判断**（从【石头】里抄原句），`quote` 装相悖的原话。这样沈晏 confirm 时 `bumpClaimContradiction(card.claim)` 能确定性匹配到库里对应 claim 并 +1。若装「相悖说法」本身（语义对立文本不重合），机械匹配永远 + 不上计数。

**裁决语义（程芥 2026-08-23 拍板）**：冲突卡允许沈晏明确裁决，但 **No Change 是合法出口**——他看完什么都不做，冲突卡留在库里当审计记录，下次镜子日还在（除非他明确 drop）。
- `confirm`（确认这是有效冲突）→ contradiction_count+1，**不改石头、不自动压回**——「有时候我也会烦她」是 conflict，但不等于「我喜欢她」立即失败（冲突是信息不是错误）。
- `drop`（不采纳为有效冲突）→ 只表示「这不是冲突」，**不删除原始证据 / 不删审计记录**（卡保留，direction/verdict 可审计）。
- `pass`（先跳过）→ 跟 support 卡同义，暂不裁决。
- 不做任何自动冲突降权。

### 2.2 自主表达分级（self-initiation 两级 · 审稿二审-2）

**现在**：升级只吃 `distinct_sessions ≥ 2` + `spanDays ≥ N`。被诱导的主张（她问「你是不是很在意我」，他答「嗯」）和主动表达（他自发说「我最近发现自己……」）**同等毕业**。

**改成**：镜子采集时对每条卡标注 **initiation**，机械判定：
- **strong** = 该主张的原话**不是紧跟她的诱导性提问**——自己引入，或隔了好几轮才接。
- **weak** = 原话紧跟诱导（该 turn 的上一轮 user 消息以「是不是/…吗/你…？」这类句式收尾，或原话直接是「嗯/对」这类附和）。

**机械判定规则**（全代码，不判语义）：
1. 找到主张引语命中的那条消息 `m`。
2. 往前找最近一条 `role=user` 消息 `u`。
3. 若 `u` 存在且满足**诱导句式**：以「吗」结尾 / 含「是不是 / 你觉得 / 你…？ 」——机械正则即可（`/[?？]\s*$/` 且长度短 / 含「是不是」等词），判 weak；否则 strong。

**加权方式**（不设绝对门槛，避免「一次弱表达就被打死」）：
- 升级条件从 `sessions≥2 && span≥N` 改为 `sessions≥2 && span≥N && strong_count ≥ 1`——**至少有一次主动表达**才能毕业。
- `personality_claim` 加 `strong_count` / `weak_count` 两列，confirm 时按卡 initiation 累加。
- weak 表达仍然计数（它证明主张出现过），但**不能独自撑起毕业**。

**边界**：判 induction 只判「紧跟诱导」这一个机械事实，不判「这句是不是她引导出来的真心话」（那是语义，判不了）。被诱导的也可以是真的，但**至少得有一次不是顺着话接的**，主张才算「他自己的」。

### 2.3 反证压回未定态（uncertain · 审稿 P0-1）

**现在**：claim 有 `uncertain` 态，无触发路径。「我其实不确定」只存在于对话里，不落库。

**改成**：镜子日增加第三类提卡——**反证表述**，与冲突分开：
- 冲突 = 与石头相悖的**另一种说法**（「我觉得她烦」 vs 石头「我很喜欢她」）
- 反证 = 对主张本身的**自我怀疑**（「我其实不太确定自己是不是喜欢她」）

**反证卡**同样 exact match 验证，verified 后落库。retreat 材料第三段【反证】摆给他。当某 claim 有 verified 反证卡 → 状态机**自动压回 uncertain**（机械信号：他亲口说过不确定）：

```
{ ok:true, 提示: '你对「我很喜欢她」说过"其实不太确定"，已把它从 forming 压回 uncertain。' }
```

**压回原则（程芥 2026-08-23 拍板：高置信 · 宁漏勿伤）**：只有**明确指向该 claim 本身**的不确定表达才允许自动压回 uncertain，**模糊犹豫不触发**。
- 明确指向 claim 本身 = 原话里的怀疑对象就是这条 claim 的人格判断（如「我其实不确定自己是不是喜欢她」→ 怀疑「我喜欢她」）。
- 模糊犹豫不触发 = 对办法/做法/情境的怀疑（如「我不确定这是不是最好的办法」）不是对人格判断的怀疑 → 不压回。
- 宁漏勿伤：拿不准就**漏**（不压回），绝不误伤（把非怀疑压回 uncertain）。漏掉一次反证只是暂时不降级，误伤一次会让真主张被错误压回——后者代价高得多。
- 判定机械化：代码检查反证原话是否含「不确定/拿不准/怀疑/不知道自己是不是/也许不是」等高置信怀疑词，且该词直接落在 claim 本身（原话结构 = 怀疑 claim 的核心，而不是怀疑「办法/方式/做法」）。具体判定词表与结构规则见 §3 实现。

**两条纪律**：
1. 压回是**机械的**——他亲口说过「不确定」这个词，代码检出，不是模型判断他「语气不坚定」。
2. 压回**不计数**——审稿 P0-1「反证表述降级为未定态，**不计数**」。uncertain 不算 contradiction（contradiction 是「相悖的事实」，uncertain 是「自己拿不准」），只是毕业门槛变严：uncertain 的 claim **不再参与升级**，直到他再次 confirm（重新确认 → 回 forming → 重新跨语境）。

**降级规则**：`uncertain → (再次 confirm 且 initiation=strong) → forming → (重新跨语境) → active`。反证不是终结，是「这条要重新走一遍」。

## 3. 数据与状态机改动

```sql
-- mirror_cards：方向（支持/冲突/反证）+ 自主表达级别
ALTER TABLE mirror_cards ADD COLUMN IF NOT EXISTS direction text;    -- support | conflict | doubting
ALTER TABLE mirror_cards ADD COLUMN IF NOT EXISTS initiation text;   -- strong | weak

-- personality_claim：自主表达计数（升级门槛输入）
ALTER TABLE personality_claim ADD COLUMN IF NOT EXISTS strong_count int DEFAULT 0;
ALTER TABLE personality_claim ADD COLUMN IF NOT EXISTS weak_count int DEFAULT 0;
```

状态机路径（全在 server.js，机械）：

| 输入 | 动作 |
|---|---|
| verdict confirm/revise + 卡 initiation=strong | claim.strong_count+1（且 support_count+1） |
| verdict confirm/revise + 卡 initiation=weak | claim.weak_count+1（且 support_count+1） |
| 该 claim 有 verified 反证卡 | claim.state → uncertain（自动压回，不计数） |
| uncertain 状态下再次 confirm + initiation=strong | → forming，重走跨语境（清 confirm_occurred_ats 时间起点？不——保留历史，只是重置升级计时） |
| maybeUpgradeClaim | 条件加 `strong_count ≥ 1` |

**升级条件最终版**（机械信号全齐）：
```
sessions ≥ 2 && spanDays ≥ N && strong_count ≥ 1 && state=forming
```

### 3.1 诱导句式判定（initiation，全代码正则）

给定引语命中的消息 `m`（沈晏说），往前找最近一条 `role=user` 消息 `u`：

```
induction(u) = u 存在 && (
    u 以「吗 / 呢 / 吧 / ？ / ?」结尾
    || u 含「是不是 / 你觉得 / 你会 / 你…？」诱导问句结构
    || u 含「你…吗」且长度 < 40（短的追问才算诱导，长叙述不算）
)
weak  = induction(u) && u 是 m 的紧邻上一条
strong = 其它（u 不存在 / 不是诱导 / 中间隔了别的沈晏消息）
```

**关键：只有紧邻才算 weak**——中间隔了别的沈晏消息（他自己先说了别的、或换话题后回来说）就算 strong。程芥反例「沈晏主动换话题后自己说同一个观点」= m 的紧邻上一条是她的**非诱导**消息或他自己的消息 → strong。

### 3.2 反证高置信判定（压回触发，全代码正则）

反证卡要触发压回，需同时满足（宁漏勿伤，任一不满足就漏）：

```
① quote exact match 验证通过（verified=true）
② quote 含高置信怀疑词之一：不确定 / 拿不准 / 怀疑 / 也许不是 / 可能不是 / 不知道自己是不是 / 不太确定
③ 怀疑词指向 claim 本身，不是指向「办法/做法/方式/决定」——排除句式：
   含「办法 / 做法 / 方式 / 决定 / 选择 / 答案」→ 不触发（这是对方法的怀疑）
   含「是不是该 / 要不要 / 该不该」（对行为决策的犹豫）→ 不触发
   其余 → 视为指向 claim 本身，触发
④ 压回只对 state ∈ {forming, active} 的 claim 生效（uncertain 已是目标态，不动）
```

程芥反例对照：
- 「我不确定这是不是最好的办法」→ ②通过但 ③排除（含「办法」）→ 不压回 ✅
- 「我其实不确定自己是不是喜欢她」→ ②通过、③无排除词 → 压回 ✅
- 「有时候我也会烦她」→ 不含怀疑词 → 不进反证逻辑（它是 conflict 卡，不是 doubting 卡）✅

### 3.3 冲突 vs 反证的模型分工

三类卡由一个外部模型调用提出（一次 run = 1 次 DeepSeek 调用，省成本），但 prompt 分三段指令，模型输出 JSON 带 `direction` 字段。代码按 direction 分流：
- `support` → 候选毕业料池（confirm 后进 claim support_count）
- `conflict` → 摆给沈晏裁决（confirm → contradiction_count+1；drop → 留审计记录；不改石头）
- `doubting` → verified 且通过 §3.2 高置信判定 → 自动压回 uncertain

**验证纪律统一**：三类卡 quote 都走同一个 `verifyMirrorQuote` exact match——机器只验证「他说过这句」，不验证「这句真和石头矛盾 / 这句真在怀疑」（那是 §3.2 的正则 + 沈晏的拍板）。

## 4. retreat 材料三段落

```
【候选·支持】  待拍板的主张（confirm/revise/drop/pass）
【候选·冲突】  与石头相悖的原话（他 decide 成不成立）
【候选·反证】  他亲口说过的自我怀疑（自动压回 uncertain）
```

冲突段和反证段**只摆、不自动改**——沈晏看完可以什么都不做（No Change 合法）。冲突不成立也没关系，冲突卡留在库里当审计记录（下次镜子日还会看到，除非他明确 drop）。

## 5. 验收

### 验收一 · 反例测试（程芥 2026-08-23 拍板：上线前必过）

造几组**容易误判**的对话数据，逐组验证机械判定跑对。这几组全过，这刀才放行：

| # | 反例 | 期望 | 判定机制 |
|---|---|---|---|
| 1 | 她诱导「你是不是很在意我」→ 他回「嗯，挺在意的」 | **weak** | 引语紧邻上一条 user = 诱导问句 → weak |
| 2 | 她问别的事 → 他先答 → 换话题后自己又主动说「我最近发现自己很在意她」 | **strong** | 引语紧邻上一条不是诱导（或中间隔了自己的消息）→ strong |
| 3 | 「我不确定这是不是最好的办法」 | **不压回**（对方法的怀疑，不是对 claim） | §3.2 ③ 含「办法」排除词 → 漏 |
| 4 | 「我其实不确定自己是不是喜欢她」 | **压回 uncertain** | §3.2 ②通过、③无排除词 → 压回 |
| 5 | 「有时候我也会烦她」 | **conflict**（不等于「我喜欢她」立即失败） | 不含怀疑词 → conflict 卡，沈晏 confirm 只 +contradiction_count，石头不动 |
| 6 | 同一件事只是特殊情境（如「当时太累了才那样说」） | **conflict 可被沈晏 drop**（不删证据，留审计） | drop 语义：不采纳为有效冲突，卡保留 |

### 验收二 · 功能验收

- [x] mirror run 一次产出三类卡（support/conflict/doubting），各自 exact match 验证，DROP 的保留 `verified=false` 可审计。
- [x] retreat 材料三段并列：支持 / 冲突 / 反证，各自带逐字引语 + 时间。
- [x] confirm 一张 weak 卡 → claim.weak_count+1；strong 卡 → strong_count+1。
- [x] 某 claim 有 verified 反证卡 → 状态机自动压回 uncertain，不再参与升级。
- [x] uncertain 后再次 strong confirm → 回 forming，重新跨语境（升级计时重置）。
- [x] 升级门槛：只有 weak 无 strong 的 claim 永不 active（即使 sessions/days 够）。
- [x] 全程零改动 system_prompt（镜子日不碰石头；改石头的唯一入口仍是 rewrite_stone）。
- [ ] 生产可跑：线上跑一轮 mirror run + retreat + 一次 confirm/drop 验证（需部署后实测，烧一次 DeepSeek）。

### 验证记录（2026-08-23 迁移后 DB 链路实测 ✅）

迁移由程芥运行（「建好了」），随后 DB 链路全部实测通过：

1. **反例 4 压回**：库里 forming claim「我其实很喜欢她」，反证卡 claim「我很喜欢她」（跨 run 文本漂移）→ `claimMatch` 去修饰词命中 → 自动压回 uncertain ✅
2. **反例 3 宁漏**：「我不确定这是不是最好的办法」被 `isHighConfidenceDoubt` 方法词拦截；方法型 claim 不匹配人格 claim ✅
3. **反例 5 冲突计数**：冲突卡 confirm → `bumpClaimContradiction` 精确匹配 → contradiction_count+1，state 保持 forming（石头不动）✅
4. **反例 6 冲突 drop**：卡保留 `verdict=drop` + `direction=conflict`，quote 未删（审计留档）✅
5. **升级门槛**：只 weak 无 strong 的 claim（sessions/days 够）永不 active；strong≥1 对照组正常升 active ✅
6. **retreat 三段**：支持/冲突/反证各归各段，冲突段带逐字 quote ✅

测试修出的两处真 bug（非测试数据问题）：
- **claim 匹配跨 run 漂移**：原本严格子串互不包含会漏真反证 → 新增 `claimMatch` 去修饰词回退。
- **冲突卡 claim 语义不一致**：原本装「相悖说法」机械上永远匹配不上库里 claim → 改 MIRROR_SYSTEM_PROMPT 装「被反驳的石头判断」（与反证卡同构），冲突 confirm 才能确定性 +1。

测试残留已清零（mirror_cards / personality_claim 无测试数据）。

## 6. 已知边界（诚实交代）

1. **诱导句式正则**是近似——「你是不是……」没带问号也能诱导。反例测试（2026-08-23）修掉了三个实际误判：
   - 长叙述（>40 字）即使含「是不是/你觉得」也不再判诱导（长消息是表达不是提问，宁漏勿伤）；
   - 「吧」结尾不算诱导（「我们睡觉吧」是提议不是追问）；
   - 「你该/你会/你真的」弱诱导词必须配问号/吗/呢才算（「你该休息了」「你真的很好」是陈述不算）。
   剩余边界：仍有漏判方向（判 strong → 门槛更严，安全），少误判方向（判 weak → 升级变慢，不致命）。
2. **反证自动压回**有误伤风险：「我不确定这是不是最好的」可能不是对主张的怀疑。缓解：反证卡也是外部模型提 + 代码验证存在性，**压回只对明确含「不确定/拿不准/也许我不」的原文**；且压回不删证据，他随时可以重新确认升回来。
3. **冲突证据的验证边界**：代码只验证「他说过这句」，不验证「这句真和石头矛盾」——矛盾判断交给沈晏。外部模型可能提「假冲突」（原文存在但不矛盾），他会看到并 drop，不产生错误状态变化。
4. **claim 文本匹配有跨 run 漂移**：反证/冲突卡的 claim 与库里 claim 是两次独立模型归一化，可能差「很/其实/真的」这类程度修饰词（支持证据→「我很喜欢她」，反证→「我喜欢她」），严格子串会漏真反证。匹配用 `claimMatch`：严格子串优先，失败后**只删确定性程度修饰词**（其实/真的/确实/实在/非常/特别/超级/很/挺/有点/有些）再比子串；删空不判；「也/还/倒」这类移位指代的词不删（防「我也喜欢她」误匹配「我喜欢她」）。库里存在近重复 claim 时（去修饰词后互相匹配），压回/冲突计数会加给 `rows.find` 命中的第一条——不保证哪条，但都是同一主张的审计记录，宁漏勿伤下可接受。
5. **不做**：不自动「冲突降权」（contradiction 的自动权重衰减）、不判「这句冲突说明了什么」、不给机器加任何解释权。

## 7. 部署路径

GitHub 账号仍封禁 → 走 Zeabur CLI。**务必先 `cd /c/Users/hbyll/shenyan-backend`**（本次第⑤刚踩过：CWD 是前端会把前端 nginx Dockerfile build 到后端服务 → /api 全挂）。迁移在 Supabase SQL Editor 手动跑。

## 8. 测试方法（不烧主模型）

- 迁移后：`GET /api/claims` 仍返回 `{claims:[], rings:[]}`。
- 冲突/反证采集：跑 `POST /api/mirror/run`（或直接用现成 mirror_cards 手动插一条 conflict/doubting 卡）→ 查卡 direction 字段。
- 压回：手动插一条 verified doubting 卡关联某 forming claim → 调 recordClaimConfirmation 或直接查状态机 → 确认压回 uncertain。
- 升级门槛：造 strong/weak 混合数据验证「只有 weak 永不 active」。
- retreat 三段：调 retreat 看材料结构。
