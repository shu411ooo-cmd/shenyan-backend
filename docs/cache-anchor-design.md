# 缓存锚定 · 方向1 设计（供外部审）

> 2026-08-30 已部署（v2）。给外部审稿人看：缓存命中率优化「方向1」的完整机制与代码链路。**要审的问题：有没有为了修缓存，偷偷把模型实际看到的内容改坏。**

---

## 0. 目标与验证基准

- 问题：常态命中率只有 **55%**——连续对话的大部分轮次，约 45% 的输入（动态尾巴）在支付全价。
- 目标：连续对话期 55% → **90%+**（稳定段 22.4k + 尾巴 18.3k 都命中，≈40k cached），而且**是大多数轮次，不是偶尔**。
- 允许：塌缩那一轮 partial miss（= 回 55%，稳定段仍命中）——**用低频的一次断裂，换掉现在每轮都在断**。

---

## 1. 根因（为什么滚动滑窗 = 常态 55%）

Anthropic 前缀缓存：命中 = 从消息开头逐字节匹配的**最长公共前缀**。请求的 prompt 结构是：

```
[system 稳定段(1h断点)] [frozen(末块1h断点)] [summary(anchor/latest 1h断点)] [middle 原文] [live 原文] [动态注入] [她的当前消息]
```

稳定段（system+frozen+summary ≈ 22.4k）字节级稳定 → 几乎总命中。动态尾巴（middle+live ≈ 18.3k）是问题：

- **live 是「最近 live_rounds=15 轮的滚动滑窗」**：`liveStart = totalTurns - 15 + 1` 每轮前移 1。
- 每轮 = 头部掉一轮 + 尾部加一轮 → **前缀在 live 头部必然断** → 尾巴 45% 全价。
- middle 尾部每轮被 live 吸收，也在变。
- 所以常态 55% 是物理真相；90%+ 只出现在「连续追加轮」的乐观窗口。

实测实锤（request_stats）：同一 session 一小时内 100%↔55% 反复跳；hit 恒 22414（稳定段），write≈18300（尾巴每轮重写）。

---

## 2. 机制总图（一条 invariant）

> **live 在一次塌缩周期内只允许 append，不允许因总轮数增加而移动起点。只有 collapse 才允许 liveStart 改。**

```
当前周期              第 N 轮           第 N+1 轮          直到触发塌缩
frozen|middle|live    frozen|middle|live+N    frozen|middle|live+N+1    ...
        ↑
     固定起点（锚点）

live 攒到阈值：
frozen|middle|live(过长)
                │ collapse（本轮允许 partial miss）
                ▼
frozen'|middle'(接住旧 live)|live(重新开始，新锚点)
```

**为什么成立**：前缀命中只看「从头开始连续没变的字节」。锚定后 live 起点不动、只尾部追加 → 前缀从 system 一路连续到 live 尾部 → 尾巴命中。middle 在锚定期间也恒定（终点 = liveStart-1 固定）→ 整条尾巴字节连续。

---

## 3. 链路图（五环节）

### ① liveStart（起点锚定）

```js
// server.js buildModelContext
let liveStart = totalTurns - config.live_rounds + 1;   // 默认滚动起点（1-based）
const anchor = await loadLiveAnchor(sessionId);         // canonical = DB，进程内 Map 是 fast path
const anchorDead = anchor == null || anchor < 1 || anchor >= totalTurns
  || (segWatermark != null && anchor <= segWatermark); // 被摘要水位线吞掉=死
if (anchorDead) {
  liveStart = totalTurns - config.live_rounds + 1;     // 重置到滚动起点
  await saveLiveAnchor(sessionId, liveStart);          // 重新锚定
} else {
  liveStart = anchor;                                  // 锚定：live 从锚点纯追加
  ...
}
```

- 锚点 = live 段第一轮的 turn 号。非塌缩轮**一次都不改**。
- `anchorDead` 三条件：无锚 / 越界（历史被清）/ 被摘要水位线吞掉（`anchor <= segWatermark`，segWatermark 前的轮已摘要、不该逐字重复进 live）→ 自动重建，不伤害状态。

### ② collapse trigger（什么时候塌）——双阈值，谁先到谁触发

```js
// 在锚定分支内：
const tmpLiveTokens = turns.slice(liveStart - 1).reduce((s, t) => s + turnTokens(t), 0);
if (totalTurns - liveStart + 1 > config.live_rounds * 2      // 轮数：别让周期无限延长
    || tmpLiveTokens > config.live_max_tokens) {            // token：别撑爆预算（安全线不是目标值）
  liveStart = totalTurns - config.live_rounds + 1;
  await saveLiveAnchor(sessionId, liveStart);               // 锚点前移，旧 live 让给 middle
}
```

- 轮数阈值 = `live_rounds × 2`（15→30 轮）。**它不是稳定预算单位**——话痨对话 30 轮可能几十 k token。
- token 阈值 = `live_max_tokens`（settings 可配置，默认 20k，按实测 live≈18.3k 反推的实验值）。
- **为什么 token 阈值是必要的保险丝**：如果没有它，攒批撑爆预算后预算裁剪会先裁光 middle、再每轮裁 live → **重新制造 cache miss，退化回滚动**。token 阈值保证在预算主动裁剪 live **之前**主动塌缩。

### ③ boundary update（塌缩怎么动边界）

- 塌缩动作只有一件事：`liveStart = 当前滚动起点`（前移，多出的 15 轮从 live 掉出来）。
- **旧 live 不是被删**：middle = `turns.slice(frozenEnd, liveStart - 1)`，liveStart 前移 → middle 尾部正好接住旧 live。middle 归既有生命周期管（分段摘要塌缩吸收 + 预算裁剪从最旧丢）。
- 切片（不变，锚点只是喂给 liveStart）：

```js
let frozenTurns = [], middleTurns = [], liveTurns = [];
if (segWatermark != null) {
  const frozenStart = segWatermark;                          // 0-based
  const frozenEnd = Math.min(frozenStart + config.frozen_rounds, liveStart - 1);
  frozenTurns = turns.slice(frozenStart, frozenEnd);
  middleTurns  = turns.slice(frozenEnd, liveStart - 1);
  liveTurns    = turns.slice(liveStart - 1);
}
```

### ④ context assembly（塌缩轮怎么组装 + 预算裁剪）

组装顺序（逐字，除 summary 是摘要文本）：
`system(1h断点)` → `frozenSection(末条1h断点)` → `summarySection(anchorSeg+latestSeg 各1h断点，uncoveredMiddle 无断点)` → `liveSection` → `动态注入块(live 区开头，user 角色+【】前缀，同轮≤3)` → 她的当前消息。

预算裁剪（**裁剪顺序不变**，2026-08-29 失忆修复定稿）：

```js
// ① middle 最先裁（从最旧）——最近的中间轮必须保留，否则丢「刚刚聊过」
while (estimatedTokens > config.max_context_tokens && uncoveredMiddle.length > 0) {
  uncoveredMiddle.shift();
}
// ② live 后裁，保底 3 轮（当前+最近两轮完整对话）
while (estimatedTokens > config.max_context_tokens && liveTurns.length > 3) {
  liveTurns.shift();
}
// ③ frozen 兜底可裁最老轮（保底 2）
// ④ 更早锚段最后丢（降级到按需召回）
```

### ⑤ cache breakpoint（断点怎么落）

```js
// system 首条：1h
content: [{ type: 'text', text: stablePrompt, cache_control: { type: 'ephemeral', ttl: '1h' } }]
// frozenSection 末条：1h（frozenSection[frozenSection.length-1] = withCacheControl(...)）
// summarySection：anchorSeg + latestSeg 各 1h；uncoveredMiddle 无断点
// liveSection：无断点
// 顶层：countCacheControlBlocks(messages) < 4 时才挂 body.cache_control（满 4 跳过，防 400 Found 5）
```

- 断点只加在稳定段，**live 不新增断点**（锚定后它自己稳，无需断点）。
- 塌缩轮 = 尾巴 partial miss（稳定段 11.3k 仍命中），命中率回 55% = 现在常态。**没有为了 100% 魔改断点**。

---

## 4. 锚点持久化（canonical 明确）

| 层 | 角色 |
|---|---|
| `sessions.live_anchor_turn`（DB 列） | **canonical**。跨重启/多实例一致 |
| 进程内 `Map<sessionId, turn>` | 仅 fast path（本进程命中就不查库） |

```js
async function loadLiveAnchor(sessionId) {
  if (liveAnchors.has(sessionId)) return liveAnchors.get(sessionId);
  try {
    const { data, error } = await supabase
      .from('sessions').select('live_anchor_turn').eq('id', sessionId).maybeSingle();
    if (!error && data && Number.isInteger(data.live_anchor_turn)) {
      liveAnchors.set(sessionId, data.live_anchor_turn);
      return data.live_anchor_turn;
    }
  } catch (e) { /* DB 列未建 → 锚定退化为进程内 */ }
  return null;
}
async function saveLiveAnchor(sessionId, turn) {
  liveAnchors.set(sessionId, turn);
  try {
    await supabase.from('sessions').update({ live_anchor_turn: turn }).eq('id', sessionId);
  } catch (e) { console.warn('⚠️ saveLiveAnchor DB 失败（锚定仅在进程内）:', e.message); }
}
```

**设计要点**：锚点读写是独立函数，**不复用 `getSessionState`**。否则 select 缺列会让 state 整体失败 → resumeGap/residue 静默失效。现在缺列仅锚定降级（进程内/滚动），state 不受影响。

---

## 5. 语义无伤论证（要审的核心问题）

**只改 segment boundary，不改任何进嘴内容。** 自查三样逐字没动：

1. **注入块**：resumeGap/residue/keepalive/心跳全插在 live 段开头（背景位），锚定只挪 live 起点，注入位相对 live 不变。
2. **进嘴原文总量**：塌缩前后都是同样那些轮逐字进嘴，只是 middle/live 的切分变了。塌缩轮模型看到的「中间段」比平时长 15 轮——middle 无断点、在 latestSeg 之后，那些轮仍逐字可见，与滚动方案下可见等价。
3. **预算兜底**：裁剪顺序、保底轮数（live 3 / frozen 2）都没碰。锚定把「每轮裁 middle 头」变成「塌缩时裁一次」，触发更少。

**唯一行为差异**：塌缩轮 middle 变长 15 轮，受预算裁剪约束、最终归宿是分段摘要——不丢上下文。

---

## 6. 降级 / 边界

| 情况 | 行为 |
|---|---|
| DB 列未建（迁移没跑） | 锚定退化为进程内 Map，单实例照常；重启人为 miss 一次 |
| 锚点被摘要水位线吞掉 | `anchorDead` → 自动重建到滚动起点 |
| 历史被清 / turn 越界 | `anchorDead` → 自动重建 |
| 攒批触发预算裁剪 | middle 先裁→live 保底 3，塌缩周期被迫提前（低频，可接受） |
| Zeabur 重启 / 部署 | 从 DB 恢复锚点，不人为制造 miss |

---

## 7. 待外部审的点

1. 双阈值里 `live_max_tokens=20k` 是实验值，靠什么指标调？（建议：collapse frequency / 平均 live tokens / 命中率 / prompt 总量 / middle 裁剪频率）
2. 「旧 live 让给 middle」会不会让 middle 在塌缩后偏大、间接改变模型对「刚刚聊过」的感知距离？（预算裁剪保底 3 轮已兜）
3. 有没有发现任何「为修缓存而改语义内容」的地方——**这是本方案的红线**。
4. 方向 2/3/4（middle 进断点 / live_rounds 15→8 / Keeper 保温）暂不碰，先验证方向 1。
