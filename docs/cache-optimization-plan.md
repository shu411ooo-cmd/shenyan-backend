# 缓存优化方案：live 段 append-only 化

> 状态：**已过时（2026-08-11 22:20 更新）——命中率问题已由当前部署版自愈，本方案不需要实施**。
> 实测（08-11 14:13-14:18）：epoch 内 ~99% 命中、均值 ~95%。根因：`MIN_SEGMENT_TURNS=8` 批量摘要把摘要水位线在 epoch 内定住 → uncovered+live 的并集 append-only → `hit_{n+1}=hit_n+write_n`。之前 62% 的元凶是旧版每轮生成摘要、水位线每轮跳、缓存常破。**本方案核心改动（liveStart 固定段边界 + live 末尾断点）经分析是 no-op**——并集本来就 append-only，发的字节一模一样。GPT 版"全量摘要入上下文"只剩记忆增强价值（每请求 +2230 token），纯产品取舍，非命中率所需。历史提案保留备查。

> 原提案（保留备查）：目标命中率 62% → 85%+，写率 37% → ~10%。
> 核心原则：**只改缓存断点位置与 live 边界算法，不改模型收到的消息内容**——记忆效果不回归。

## 一、为什么现在只有 62%

- 缓存断点：system / frozen 末条 / summary 段（anchor + latest），全 1h TTL。
- 命中前缀 = system + frozen + summary，实测恒 ~9073 tokens。
- live = 最近 15 轮，是**滑动窗**（`liveStart = totalTurns - live_rounds + 1`），每轮整体右移一格。
- 缓存按**字节前缀**匹配：滑动窗每轮 shift → live 里 14/15 轮重复原文对不上上一轮的前缀 → 整段每轮重写。
- 数据实证：hit 恒 9073，write 随对话从 26% 涨到 37%（live 段填满后稳定）。

对比：主流聊天 app 命中 80%+ 靠 **append-only 全量历史**——每轮数组 = 上轮 + 新交换，前缀是严格超集 → 只写最新一条。我们做不了全量（日记无界），但 live 段可以做成**周期内 append-only**。

## 二、记忆效果为什么不变

1. breath 背景记忆（index 1，首条注入）：不在改动范围，断点①~②纪律不变。
2. recall / breath_search：工具结果在断点之后、不入库；模型近期语境还变多，反而更少依赖 recall。
3. 记忆编辑者 / 对话残留：后台直接读 DB，与上下文组装无关。
4. 模型近期原文语境：现在 uncoveredMiddle+live = "摘要水位线之后所有轮"（15~22）；改后 live = 同一范围，**15→22 轮渐涨**，只在摘要塌缩瞬间回 15（且被压掉的 8 轮成为 latestSeg 摘要仍在上下文）。只多不少。

## 三、改动点（server.js）

1. **`buildModelContext` 的 liveStart 改为固定段边界**：
   ```js
   // 旧：liveStart = totalTurns - config.live_rounds + 1;      // 滑动
   // 新：liveStart = (segWatermark ?? frozenUntil) + 1;        // 固定于最新摘要段边界
   ```
   效果：live = 摘要水位线之后所有轮，周期内 append-only。
2. **缓存断点移到 live 段末尾**（最后一条 live 消息，当前用户消息之前）加 `withCacheControl`（1h TTL）。与 system/frozen/summary 断点并存，总断点数仍 ≤ 4。
3. 可选：`MIN_SEGMENT_TURNS` 8 → 12~15（摘要更 chunk → 塌缩更少、近期语境更足、缓存破更少）。
4. 预算裁剪逻辑保持（超限裁最老 live 轮，现有代码已处理）。生成器 `generateSummaryIfNeeded` 的触发逻辑保持不动（其 watermark 判定与热路径在塌缩点自洽）。

## 四、预期

- epoch 内（15~22 轮）：相邻请求前缀 append-only 超集 → 命中 ~90%，写 ~5-10%。
- 摘要塌缩请求（每 ~8-15 轮一次）：整前缀重写（system+frozen 仍命中），一次约 $0.03，摊薄可忽略。
- 综合命中 ~83-90%（取决于 MIN_SEGMENT_TURNS）。

## 五、风险与验收

- **风险1（记忆）**：塌缩瞬间 22→15 轮 + 被压 8 轮只剩摘要。验收：改造后连续对话，盯模型能否拾起 8 轮前的话题细节；必要时对照改造前。
- **风险2（摘要节奏）**：若摘要跟不上，live 无限涨 → 预算裁剪频繁 → 缓存破得更多。验收：盯 `[ContextAssembly]` 日志 live_turns 是否稳定 15~22；长期 >22 说明 MIN_SEGMENT_TURNS 该调或摘要卡了。
- **验收**：改造前后各跑 `node diag-cache-temp.js`，对照命中率、FULL 分类、live_turns 分布。改造后需先有真实使用数据（TTL 版部署后至今 request_stats 仍 0 条，见 [[openrouter-cache-diagnosis]]）。

## 六、回退与备选

- 回退：改动集中在 `buildModelContext` + live 末尾断点两处，revert 即回。
- **备选（更简单、但影响记忆）**：只把 `live_rounds` 15 → 5~6，命中直接 ~88%，但模型近期原文只剩 5~6 轮（现 15 轮），连续对话可能接不住 7 轮前的话题——记忆效果受影响，需小流量验证后定。

## 七、与 TTL 版部署的关系

TTL（1h）版已上线但部署后 0 使用，TTL 类 FULL 尚未验证。本方案应在此验证完成后、基于实测数据再实施，避免两个变量同时变。
