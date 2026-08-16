# 沈晏「镜子卡」（Mirror Cards）· 第③阶段设计

> 2026-08-16 起草。审稿 **P0-3**（引用生成/验证拆开，exact match 代码完成）落地。
> 关联：主稿 [want-ledger-design.md](want-ledger-design.md) 阶段表 ③ · 审稿闭环 [persona-growth-review.md](persona-growth-review.md) §10 P0-3 · 镜子边界（memory `persona-growth-design`）。
> 状态：**草案**（待程芥拍板 3 个点：外部模型 / 触发方式 / 原文范围）。
> 原则：镜子是**锚不是流**——只做机械对账，绝不判断"什么关键"、绝不下结论；安全网不是主力，主力是沈晏自省（第④）。

## 0. 一句话

> **外部模型提「主张 + 候选引语」，代码逐字验证引语在不在原文——查无即弃，绝不下结论。**

## 1. 审稿 P0-3 怎么落

- **引用生成**（外部模型 = DeepSeek，直连，与摘要同款 key）负责**解释**：读对话原文 + 石头正文，提候选卡。
- **引用验证**（代码，确定性）负责**存在性**：`candidate_quote → normalize → exact substring match → PASS/DROP`。
- 外部模型说"这句引语在原文里"，**代码说了算**。模型幻觉引语 → DROP（查无即弃），不降级为"可能"。
- 与 recall 盯证据收敛成同一机制：**宁漏不误**。

## 2. 镜子边界（继承，焊死）

1. **不抓"关键证据"**——外部模型判断"重要"有偏（偏爱危机漏柔软），镜子只过形状，不过筛子。
2. **不判意义**——"这很重要 / 他越来越喜欢X / 应写入石头"，全是第④自省之后的事。
3. **不下结论**——run 只产卡，**石头零改动**，系统不替他制造人格主张（北极星）。
4. **安全网不是主力**——主力是沈晏自省（小黑屋 + 镜子日）；镜子是"石头说的话能不能回到底层核对"的保险。

## 3. 流程

```
① 采集 ──► ② 外部模型提卡 ──► ③ 代码验证 ──► ④ 存卡 ──► ⑤ 不动石头
```

1. **采集**：石头正文（`getSystemPrompt()`）+ 河（desires active 条目 + 最近足迹）+ 对话原文（近期 messages，`visible=true`，截断控成本）。
2. **提卡**：DeepSeek 读上述材料，输出严格 JSON 数组 `[{claim, quote}]`：
   - `claim`：候选人格判断（一句话，沈晏可能有的"我是谁"主张）。
   - `quote`：从**原文逐字抄**的候选引语（模型自报出处）。
   - 提示词明确：quote 必须是原文存在的原话，不许 paraphrase、不许补全。
3. **验证**：代码逐卡过 `normalize → substring match`，PASS 附 `message_id/session_id/occurred_at`；FAIL 卡保留但 `verified=false`（可审计"外部模型提了什么、代码砍了什么"）。
4. **存卡**：全部卡落 `mirror_cards`，带 `run_id` 批次可回溯。
5. **不动石头**：本阶段没有任何路径触碰 system_prompt。

## 4. 表结构（Supabase SQL）

```sql
CREATE TABLE IF NOT EXISTS mirror_cards (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  run_id uuid NOT NULL,                       -- 一次镜子运行的批次
  claim text NOT NULL,                        -- 候选人格判断（外部模型提）
  quote text NOT NULL,                        -- 候选逐字引语（外部模型提，代码验证）
  verified boolean NOT NULL DEFAULT false,    -- 代码 exact match 结果
  message_id uuid,                            -- PASS 时指向 messages 原文
  session_id uuid,                            -- PASS 时所在 session
  occurred_at timestamptz,                    -- PASS 时消息时间（跨10天复检输入）
  created_at timestamptz DEFAULT now()
);
CREATE INDEX IF NOT EXISTS idx_mirror_cards_run      ON mirror_cards(run_id);
CREATE INDEX IF NOT EXISTS idx_mirror_cards_verified ON mirror_cards(verified);

-- 验证：SELECT run_id, count(*) FILTER (WHERE verified), count(*) FROM mirror_cards GROUP BY run_id;
```

> 跨10天复检：PASS 卡带 `occurred_at`，同一 claim 多卡跨 ≥10 天的信号**第③阶段只记录、不升级**——那是第⑤候选门槛的输入。`personality_claim` 状态机也是第⑤再建，镜子卡是它的料。

## 5. 端点：POST /api/mirror/run（手动跑一轮镜子）

```json
// 请求
{ "days": 90, "max_sessions": 20, "max_cards": 8, "model": "deepseek-v4-flash" }
// 响应
{
  "ok": true, "run_id": "uuid",
  "proposed": 8, "verified": 5, "dropped": 3,
  "cards": [ { "claim": "...", "quote": "...", "verified": true, "message_id": "...", "occurred_at": "..." } ]
}
```

- 参数可进 `settings` 宽表可调（同第②阶段 `desire_inject_*` 风格）：`mirror_days` 默认 90。
- 幂等：每次 run 新建 `run_id`，不覆盖旧批次。

## 6. 验证实现（代码，确定性，唯一裁决方）

- **原文范围**：`SELECT id, session_id, created_at, content FROM messages WHERE visible = true AND created_at > now() - interval 'N days' ORDER BY created_at`（近 N 天）。
- **normalize**：quote 与 content 各自 `trim()` + 折叠连续空白 + 统一全角/半角引号。content 若是数组（多模态段），只取文本部分参与匹配。
- **match**：normalize 后 `content.includes(normalizedQuote)`（子串匹配，逐条扫；卡数 ≤ 8、原文截断，扫得完）。
- **逐卡**：找到首条命中即记 `message_id/session_id/occurred_at`，不再下钻；找不到 → `verified=false`。
- **宁漏不误**：normalize 后仍不命中的，一律 DROP，不进第⑤的料池。

## 7. 成本控制

- 1 run = **1 次 DeepSeek 调用**（非流式，`max_tokens` 给足，`json_object` 约束）。
- 输入裁剪：原文按 max_sessions 分 session 取样 + 每 session 截断尾部（最近的才有效）；石头全文 + 河摘要必带。
- 卡上限 `max_cards=8`：让外部模型只提最强的，别堆。
- 摘要同款纪律：DeepSeek 推理模型 reasoning 吃预算 → 空 content 重试一次。

## 8. 验收

- [ ] 外部模型提一条**原文里没有的假引语** → 代码 DROP（`verified=false` 可审计，run 报告显示"砍掉 N 张"）。
- [ ] 原文里真有的引语 → PASS，`message_id` 指向 messages 原文（可回翻）。
- [ ] run 全程**零改动** system_prompt（镜子不碰石头）。
- [ ] 每次 run 可回溯：谁提的、砍了什么、谁留下的。
- [ ] 同一卡跨 ≥10 天的 `occurred_at` 被记录（第⑤的输入没丢）。

## 9. 待拍板

| # | 点 | 建议值 | 备选 |
|---|---|---|---|
| 1 | 外部模型 | DeepSeek 直连（key 已有，与摘要同源，天然与聊天主模型 Claude 不同源） | OpenRouter 的 deepseek |
| 2 | 触发方式 | 手动端点 `POST /api/mirror/run`（第④镜子日再接定时） | keepalive 醒来自动跑 / cron 定时 |
| 3 | 原文范围 | 近 90 天（够覆盖"长期"信号，成本可控） | 全量 / 近 30 天 |

## 10. 后置不做（第④⑤阶段）

- 跨10天复检的**升级**逻辑（同一 claim 何时值得当候选）→ 第⑤候选门槛。
- `personality_claim` 状态机 / 石头版本审计 / 环 → 第⑤。
- 镜子日定时 + "与石头冲突"固定问句 → 第④自省。
- 前端任何镜像面板 → 本阶段只有端点，无 UI。
