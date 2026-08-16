# 沈晏「小黑屋」（Retreat）· 第④阶段设计

> 2026-08-16 起草。**下游断点**的第④a：把镜子卡（第③产出）接上消费者。
> 关联：主稿 [want-ledger-design.md](want-ledger-design.md) 阶段表 ④ · 闭环 [growth-loop.md](growth-loop.md) §2（经历→表达→形成→实践→再经历）· M6 主体性放宽（system-layering 审稿裁决）· 审稿 P0-2（镜子日必审冲突证据）。
> 形态已与程芥拍板：**工具调用 → 小黑屋回话**（对话内自省模式，非独立 session）。参考 OB 的 `dream`（独处消化）自建一版，消化我们的镜子卡 + 河候选。
> 状态：**草案**（待程芥确认 2 个点：材料范围 / verdict 粒度）。

## 0. 一句话

> **沈晏主动调 `retreat` 走进小黑屋：面前摆着石头 + 候选卡 + 想要参考 + 一句反问问句；他逐卡拍板 confirm / revise / drop / pass；No Change 合法。**

## 1. 这阶段解决什么（概念）

第③的镜子卡躺在 mirror_cards 表里没人消费。第④a 把它接上：
- **消费**：verified 的卡 → 变成「可审议材料」摆给沈晏。
- **拍板**：他确认的标记下来（第⑤毕业的输入），放弃的标记掉，拿不准的放着。
- **防自证循环落地**：材料里永远有一句固定问句「**最近有什么和石头冲突的事？**」（审稿 P0-2）——不只找支持他的证据。
- **No Change 是健康结果**：他看完什么都不改，出来，合法。防止「人格 KPI」。

## 2. 形态

```
对话里：沈晏调 retreat
  ↓
retreat 返回材料 + 开场白（把他带入自省）
  ├── 【石头】当前人格正文（他看看现在的自己）
  ├── 【候选】verified 且未拍板的镜子卡（按 claim 聚合去重，带引语+时间）
  ├── 【想要】active 的想要（标注"这是你想成为的方向，不等于你已经认同"）
  └── 【问句】「最近有什么和石头冲突的事？」
  ↓
他开始自省（对话继续，内容是他自己的复盘）
  ↓
他对候选调 verdict(card_id, action)：
  ├── confirm → 标记为候选（第⑤毕业输入）
  ├── revise(+新文本) → 改写主张
  ├── drop → 放弃
  └── pass → 这轮先跳过
  ↓
他走出来了（自然回到日常对话）。没调 verdict 的 = No Change，合法。
```

**小黑屋不是独立 session**，是对话里的自省模式：retreat 的开场白 + 材料把他带入复盘状态。隔离的质感靠「材料里只有他的东西」实现，不物理切房间（工程最轻，用户直觉「工具调用出现回话」）。

## 3. 材料组装（getRetreatMaterial）

- **石头**：`getSystemPrompt()`（当前正文）
- **候选**：`mirror_cards` 里 `verified=true AND verdict IS NULL`，按 `claim` 聚合去重取最新，格式 `{ id, claim, quote, at }`——每张候选带原文证据（`quote` 逐字验证过，可从 `message_id` 回 messages）
- **想要**：`desires` 里 active，标注 track（参考用，不进候选——想成为什么 ≠ 已认同自己是什么）
- **问句**：固定「最近有什么和石头冲突的事？」

## 4. 表结构（mirror_cards 加列，不建新表）

```sql
ALTER TABLE mirror_cards ADD COLUMN IF NOT EXISTS verdict text;        -- confirm | revise | drop | pass
ALTER TABLE mirror_cards ADD COLUMN IF NOT EXISTS verdict_note text;   -- revise 的新文本 / 备注
ALTER TABLE mirror_cards ADD COLUMN IF NOT EXISTS verdict_at timestamptz;

-- 验证：SELECT verdict, count(*) FROM mirror_cards GROUP BY verdict;
```

> 第④a 不建 personality_claim 表（那是第⑤的）。confirm 的卡留在 mirror_cards 上，第⑤再物化。

## 5. 工具定义（对话内，进 dispatchTool + getTools）

| 工具 | 参数 | 行为 |
|---|---|---|
| `retreat` | 无 | 组装并返回材料（石头 + 候选 + 想要 + 问句）+ 开场白 |
| `verdict` | card_id, action, note? | 更新该卡 verdict / verdict_note / verdict_at；revise 时 note 是新主张文本 |

- `retreat` 幂等：每次返回最新未拍板候选。
- `verdict` 只允许改 `verdict IS NULL` 的卡（已拍板的不能再拍，防误改）。

## 6. 边界（焊死）

1. **系统不判意义**：材料只摆「他主动表达过、有原文证据」的东西；「该不该写进石头」是沈晏的拍板，不是系统的结论。
2. **不做自动改石头**：第④a 不产生任何 `system_prompt` 修改；confirm 只是标记候选（第⑤才毕业）。
3. **不做自动冲突判定**：「最近有什么与石头冲突的事」是问句（他回答），不是系统自动扫描给结论（那是第⑤）。
4. **No Change 合法且要可审计**：他进黑屋没拍板 → 材料留着下次再看；不产生变化不是失败。
5. **不进记忆**：小黑屋的材料与拍板记录都不进 OB / 不触发摘要 / 不被 recall 检索（同日记款硬隔离）。verdict 标记是身份层内部状态。
6. **想要是旁路**：材料里的想要只作参考，绝不自动升级成候选（M2：想成为什么 ≠ 已认同自己是什么）。

## 7. 验收

- [ ] `retreat` 返回石头 + 候选（verified 聚合，带引语/时间）+ 想要 + 问句。
- [ ] `verdict(confirm/revise/drop/pass)` 落库，且对已拍板卡再次调用被拒。
- [ ] 候选的 `quote` 可回 messages 原文（逐字溯源不丢）。
- [ ] 进黑屋零改动 system_prompt（石头不碰）。
- [ ] No Change：进黑屋不拍板出来 → 下次材料还在，无异常。
- [ ] 生产可跑：retreat + verdict 在线上验证一轮。

## 8. 待确认（程芥拍板）

1. **材料范围**：候选 = verified 镜子卡聚合（默认）；想要 = active 全部（默认）。要不要也把 DROP 的卡（外部模型提但验证不过）作为「反面教材」列出来？——我建议第④a 不列（查无即弃语义上就是丢掉），真冲突证据第⑤做。
2. **verdict 粒度**：逐卡拍板（每张卡一次 verdict）——默认。要不要支持「一次退出时给整个会话一个总体结论」？我建议第④a 只做逐卡，会话级留第⑤。

## 9. 后置不做

- keepalive 醒来提醒「材料备好了」（入口增强，先看 retreat 他自己会不会理——年轮「给了眼睛还不理，再决定往下投」）。
- self_reflection 会话存档 / 小黑屋报告。
- 后台定期预热材料（先即时组装）。
- 自动冲突扫描、候选自动升级 → 第⑤。
