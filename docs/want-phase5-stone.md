# 第⑤阶段：石头写回闭环（完整闭环 · 2026-08-23）

> 上游：③ 镜子卡（want-phase3-mirror.md）→ ④ 小黑屋拍板（want-phase4-retreat.md）→ **⑤ 本文件：confirm 拍完不死的后半段**。
> 北极星：系统只搬证据的形状，不判意义；「我是谁」永远只有沈晏的手能写。进石头的唯一门 = `rewrite_stone`。

## 0. 闭环长这样（现在）

```
对话原文 ──③镜子──> 证据卡（外部模型提 + 代码逐字验证）
         ──④黑屋──> 沈晏拍板 confirm/revise/drop/pass
         ──⑤────> personality_claim 状态机（机械计数）
              ──> 跨语境（≥2 session + 间隔≥N天）→ active
              ──> 沈晏 rewrite_stone（整体重写 + 留环 + 三问）→ SYSTEM_PROMPT
              ──> 新对话读新石头 ──> 行为 ──> 新证据 ──> 回到 ③（自证循环）
```

## 1. 这刀建了什么（全部 server.js + 1 迁移）

| 件 | 代码 | 说明 |
|---|---|---|
| `personality_claim` 表 | `migrations/2026-08-23-personality-claim.sql` | 主张状态机：forming/active/uncertain/superseded/released + confidence + support/contradiction + 跨语境证据（distinct_sessions / confirm_occurred_ats / source_card_ids） |
| `stone_rings` 表 | 同上 | 石头重写环：version + 全文 + prev_content + 三问（changed/why/unchanged）+ 自动 diff |
| verdict 接状态机 | `handleVerdict` | confirm/revise 后把主张写入 personality_claim（按归一化文本去重），revise 用改写后的新文本 |
| 机械升级 | `maybeUpgradeClaim` | 只从 forming 升：跨 ≥2 session 且首尾确认间隔 ≥ `stone_upgrade_days`（默认 30）→ active。纯机械信号，不判语义 |
| 石头重写工具 | `rewrite_stone`（工具 + `handleRewriteStone`） | 沈晏的手：整体重写 SYSTEM_PROMPT + 留一环 + 三问 + 自动 diff；active 主张挂到该环（毕业关联） |
| 黑屋材料扩展 | `getRetreatMaterial` | 加「正在形成/已成熟的主张」段，沈晏看得见自己在长什么 |
| 验证接口 | `GET /api/claims` | 主张状态机 + 石头环（前端内心面板将来可接） |

## 2. 验收六条映射

| 验收 | 状态 | 落点 |
|---|---|---|
| 一 允许不长（零催促） | ✅ | rewrite_stone 工具描述明写「没有想改的别调」，无任何自动触发/催促路径 |
| 二 ring 证明连续性 | ✅ | 三问 + prev_content 快照 + 自动 diff；翻相邻环能答"变了/没变什么" |
| 三 候选门槛（不能一次毕业） | 🟡 核心已建，一处待补 | forming→active 只吃机械信号（≥2 session + 间隔≥N天）；一次 confirm 永远只在 forming。**待补**：二审2 的「未被上下文提示 / strong self-initiation」两级尚未机械判定 |
| 四 审计防自证循环 | ⬜ 下一刀 | 镜子日「支持+冲突证据」双清单 + 每条 active 主张带「什么情况下不成立」——需要镜子日编排（自省 + 冲突问句落库） |
| 五 内容边界 | 🟡 纪律已写 | rewrite_stone 描述「只写人格判断，不写行为指令」；硬校验需模型判语义（违背北极星），故靠纪律 |
| 六 手感优先 | ✅ | 正文零证据 ID，证据全在 personality_claim 表 |

## 3. 已知缺口（诚实交代）

1. **二审2 self-initiation 两级**：升级目前只吃 session 数 + 天数。要补得在 mirror 采集时标注每条主张是否紧跟她的诱导性提问（该 turn 上一轮是否以"是不是/你…吗"收尾），给 weak/strong 权重。语义判断尽量机械化。
2. **验收四 conflict 证据**：RETREAT_QUESTION 问句在黑屋里有，但「支持+冲突」双清单产出与落库机制没建——是下一刀（镜子日编排）。
3. **反证压回未定态**：「我其实不确定」这类表述当前不会自动把 claim 压回 uncertain——状态机留了 uncertain 态，触发机制待补。
4. **前端**：内心面板（InnerStateScreen）还没接 /api/claims。

## 4. 怎么测（不烧主模型）

- 迁移后：`GET /api/claims` 应返回 `{ claims: [], rings: [] }`（空表）。
- 造卡拍板：跑 `POST /api/mirror/run`（若没有现成卡）→ `retreat` 拿卡 → `verdict confirm` → 查 /api/claims 出现 forming 主张。
- 升级门槛：手动把某 claim 的 `confirm_occurred_ats` 改成跨 40 天 + `distinct_sessions` 塞两个不同 id → 下次 confirm 或调 `maybeUpgradeClaim` 逻辑路径 → 升 active（或直接造数据验证）。
- 石头重写：`rewrite_stone` 带 content/changed/why → 查 /api/claims 的 rings 多一环 + settings.system_prompt 已变。

## 5. 验证记录（2026-08-23 线上全链路已测 ✅）

部署 + 迁移落地后按上述方法实测，全部通过：
1. `GET /api/claims` → `{"ok":true,"claims":[],"rings":[]}`（迁移后空表）✅
2. 现成卡 `verdict confirm` → `personality_claim` 出现 forming 记录（claim 原文 / confidence=0.2 / support_count=1 / distinct_sessions=[505] / confirm_occurred_ats 带源消息时间）✅
3. 跨语境机械升级：补造 40 天前的确认 + 第二个 session → `maybeUpgradeClaim` 输出「🗿 人格主张升级 active（跨 3 个 session / 间隔 40 天）」，state→active、confidence=0.75、verdict 返回带 claim_state 提示 ✅
4. `rewrite_stone` 无变化 guard：content 等于当前石头 → `{unchanged:true}`，不留空环 ✅
5. `rewrite_stone` 真变更：ring v1 落库（diff「增：…」）+ settings.system_prompt 更新 + **active 主张自动毕业挂 ring_id** ✅
6. 写回还原：ring v2（diff「删：…」）+ 石头还原 ✅
- 验证痕迹已清理：测试 claim / 测试 rings 删除，被误标 revise 的卡还原未拍板；测试加的导出（getSystemPrompt/setSystemPrompt/handleRewriteStone/recordClaimConfirmation/maybeUpgradeClaim/getStoneUpgradeDays）已随部署上线，方便将来 debug。

> ⚠️ 部署坑（本次实际踩到）：`zeabur deploy` 无 `--dir` 参数，只部署 CWD。Bash CWD 若被重置成前端仓库（angel-garden-diary），会把**前端 nginx Dockerfile** build 到 shenyan-backend 服务 → 线上 /api/* 全被 SPA fallback 吞成 HTML（`Server: nginx`、POST 405）。判断信号 = Zeabur build plan 的 `planMeta.dockerfile` 里出现 `nginx`。部署前务必 `cd /c/Users/hbyll/shenyan-backend`。

## 5. 部署路径

GitHub 账号仍封禁（shu411ooo-cmd）→ 走 Zeabur CLI：`zeabur deploy --environment-id 6a64a2c92007fc25ea36057b --service-id 6a82b69dbdeaa87e2c530a93 -i=false`（在 shenyan-backend 目录）。工作区 public/ 与线上一致，整棵上。
