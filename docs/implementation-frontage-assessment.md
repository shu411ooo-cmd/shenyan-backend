# 实施面评估 · 两处记忆缺口（kind 词表漂移 + 历史 claim 污染）

> **任务 3（只查不修）**：把两处缺口「能不能修、怎么修、改成什么、风险在哪」摊开，代码一行不动，交她拍板。
> 核对基线：2026-09-11 · 净本 §7 #3（kind 漂移）与 #5（历史 claim 污染）。
> **纪律**：本文件只评估。任何落库、重构、迁移都要另开任务。

---

## 一、缺口 A：kind 词表漂移（desires.kind 两套语义）

### 1.1 现状（净本 §2.1）

同一个 `desires.kind` 字段，被两条入河通道写了两套完全不搭的值：

| 通道 | 写什么 | 值的来源 | 是否有校验 |
|---|---|---|---|
| 手动 `want_add` | 任意字符串标签 | 模型自由填 `String(args.kind||'')` | ❌ 零校验（[server.js:531](file:///c:/Users/hbyll/shenyan-backend/server.js#L531)） |
| 自动 `graduateThoughts` | 驱动维中文词 | `DRIVE_KIND_MAP`（[server.js:2854](file:///c:/Users/hbyll/shenyan-backend/server.js#L2854)） | ✅ 固定表 |

**同一列里实际会出现的全部取值**（两套并存的完整清单）：

```
手动通道（模型可能填的，无约束）：
  experience / creation / understanding / relationship / self_direction
  —— 这是 memory-panorama 设计文档里的五类，但代码零校验，模型也可能填别的任意词

自动通道（DRIVE_KIND_MAP 写死的）：
  关于我们   （attachment）
  我的沉淀   （reflection / duty / stress / fatigue）
  想去看看   （curiosity / social）
  null        （libido 的毕业念头——libido 不写类别）
```

以及 rewrite（`handleWantReflect`）这条分支：新条 `insert` 时**根本没传 kind**，新条 kind 直接是 null（[server.js:672](file:///c:/Users/hbyll/shenyan-backend/server.js#L672)）——它本身就是第三条"值域"。

### 1.2 关键事实：目前**没有消费者**

我全局搜过 `eq('kind'`、按 kind 的 `group/sort/filter`，`desires.kind` 在后端 JS 里**没有任何过滤/统计/注入消费点**，只有写入和 select 展示。所以：

- **它现在是"潜伏"错位，不是"破裂"。**不炸，但任何未来"按 kind 排序/过滤"的需求都会踩。
- **`desire_notes.kind` 是完全不同的表/语义**（footprint/transform/reflection，足迹分类），不在本缺口内，别混进去改。

### 1.3 处置选项

| 选项 | 做法 | 优点 | 代价/风险 | 我的倾向 |
|---|---|---|---|---|
| **A1 拆列**（已执行） | 新增 `desires.drive_category` 只给自动通道用，`kind` 保留给手动分类 | 两套彻底不碰；不动存量；最小改动 | 手动通道仍是自由文本（未来仍可能想要约束） | ✅ **已做**，净本 §2.1 的 #3 已从「待办」降为「已修复」 |
| **A2 手动通道也校验** | `want_add` 把 kind 收进固定集合（五类），非法回退 null | `desires.kind` 从此只有一手语义 | 模型少点自由；如果她其实喜欢手填，反而框死 | 可选，等她定 |
| **A3 存量梳理** | 一次性把历史 `desires.kind` 里脏值人工归类 | 老数据可用 | 脏值可能是她的意图，不能机器断言 | 不推荐，除非她要 |

**缺口 A 结论**：A1 已落地，物理上两套不再共用一列。**遗留决策**只有一个：A2 要不要对 `want_add` 的 `kind` 加白名单校验（影响"手动分类的自由度"）。

---

## 二、缺口 B：历史 claim 被回响污染（石头是否长了对的东西）

### 2.1 事实链（handoff §5 #1 + §3 bug #3）

1. **表达资格隔离（回响剔除）空转十天然才修复**（`prompt_injections.session_id` 建成 uuid 而 `sessions.id` 是整数）。
2. 空转期间，`collectInjectionNormals` 读到的台账一直是空的 → `isEchoOfInjection` 形同虚设 → **回响卡没被剔除**（[server.js:1121-1125](file:///c:/Users/hbyll/shenyan-backend/server.js#L1121-L1125)）。
3. 那段时间产生 **64 张镜子卡、44 张 verified**，当时都没真正做回声排除。
4. 若其中回响卡通过 `maybeUpgradeClaim` 毕业进了 `personality_claim`，**现在的库里分不出哪些是回响冒充的主动表达**。

### 2.2 关键分界：能不能追溯，取决于"卡的时间 vs 台账修复时间"

`runMirrorOnce` 在 `isEchoOfInjection` 这步是**实时**算的（每次 run 现读台账当天往前 `days` 天）。所以：

- **修复之后**产的卡：台账正常 → 已验证 ✓
- **修复之前**产的卡：当时台账空 → 未被筛选 → **可疑**

=> 判断"污染范围有多大"，核心只读探针就是：**把 mirror_cards 按 run 时间切两段，看修复前那段有多少"可能毕业的 verified 卡"。**

### 2.3 只读探针计划（全程 `select`，不写库）

沿用已入库的 `scripts/audit/probe-mechanisms.cjs` 方法论（读 `.env`、`createClient`、四查法）。新探针 `probe-claim-pollution.cjs`（新建）：

```
P0 台账整流期边界
   取 prompt_injections 最早一行 created_at → 记为 repair_ts。
   （若台账仍 0 行，则边界无法从台账定，退回用「代码修复的部署时刻」估计——见 P0-备）

P1 mirror_cards 分段
   select id, claim, quote, verified, direction, initiation, expression_eligible, occurred_at, created_at
   from mirror_cards
   平铺 count + 按 verified / expression_eligible / direction / 时间早于 repair_ts 交叉分组。
   → 输出：修复前 verified 卡有几张、其中 support 方向几张、initiation 分布。

P2 可疑卡是否已升进 personality_claim
   select * from personality_claim
   对 P1 里修复前 verified support 卡的 claim 文本做 claimMatch（去程度修饰词）去对 personality_claim.claim：
   → 命中 = 已染进主体的可疑 claim 清单（含 claim 文本、两边 created_at）

P3 补证据（如果 P1 里有卡可查）
   select message_id, session_id from mirror_cards where …，
   再逆查 messages 往对应 session 查「该引语的前后文」重建它到底是主动表达还是回响
   （这一步是最重的，只对 P2 命中 isEcho 候选做，样本很小才做）

P0-备 台账如果仍空
   用 git 找 `prompt_injections` 修 session_id 类型那次迁移/部署的时间（handoff §3 bug#3，
   迁移是 2026-08-23 `prompt-injections-session-type` 那条命令）→ 以它当 repair_ts 下界。
```

**探针判读出口**（不是结论，是交给她的证据）：
- P1/P2 全为空 or 命中 0 → 污染实际没发生，**无需重审**，直接结案。
- 命中>0 → 把可疑 claim 清单列出来，由她决定是 drop / 重投 retreat / 保留。

### 2.4 处置选项（探针结果出来后再选择）

| 结果 | 建议动作 |
|---|---|
| 命中 0 | 结案，净本 §2.4 的 ❓ 改 ✅ |
| 命中少量（≤几条） | 列清单给她，逐条拍板（drop / 保留），不整体推倒 |
| 命中较多 | 才考虑整批重投 retreat；**注意**：重投也会烧一次 DeepSeek + 需要她人工 confirm，不是免费的 |

**缺口 B 结论**：先跑只读探针拿硬证据，**不要现在拍"要不要重审"**——探针可能直接证明没污染，省掉一堆投入。

---

## 三、执行决策点（要她拍板）

1. **A2**：`want_add` 的 `kind` 要不要加白名单校验（收进固定五类）？——影响"手动分类自由度"。
2. **B**：要不要我写并跑 `probe-claim-pollution.cjs`（纯只读）拿污染范围硬证据？跑完再谈重审。

> 两者都不需要她现在给"要不要修"的表态，只需授权"查/不查""框/不框"。

---

*关联：净本 [docs/memory-current-state-netting.md](file:///c:/Users/hbyll/shenyan-backend/docs/memory-current-state-netting.md) §2.1 / §2.4 / §7；handoff [docs/2026-09-09-handoff.md](file:///c:/Users/hbyll/shenyan-backend/docs/2026-09-09-handoff.md) §3 / §5。#2（kind 漂移）的上游修复 A1 已在 2026-09-11 落地。*