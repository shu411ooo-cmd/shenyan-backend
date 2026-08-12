# keepalive 实现方案（给 GPT 评审稿）

> 日期：2026-08-13（上海）。状态：实现方案，未开工。
> 配套：[keepalive-design.md](./keepalive-design.md)（v1 规格：边界/机制/prompt 全文/§11 清单）。
> 本文件只讲**改哪、怎么改、顺序、风险**；规格细节以 design.md 为准。
> 2026-08-13 已过 GPT 评审：3 个必须修 + 5 个建议**全部采纳**，改动已折叠进正文（§4.4/4.5/4.6/4.8），结论见 §7。

## 0. 一句话

你离开 ≥2 小时后，沈晏在活跃时段内自主"醒"一次，决定给你留一条信箱留言 / 写小日记 / 安静待着；你下次打开小窝看到留言，它记得自己醒过。

## 1. 既有边界（规格已拍板，评审勿推翻）

- ❌ 不做推送、不做感知层遥测（前端不是 PWA；Android 无 iOS 快捷指令对等物）
- ❌ keepalive 消息**不合并进 messages 正式历史**（否则破坏 pairTurns 冻结字节 → 缓存前缀作废；见 §4.5）
- ✅ 感知来源 = 时间 + 你亲口说的话（departure/残留）+ 摘要，全部来自已有系统
- ✅ 留言必须 grounded（source 逐字引述依据，空则降级 diary/none），沿用时间感铁律

## 2. 改动清单总览

| 位置 | 改动 | 风险 |
|---|---|---|
| migrations/2026-08-13-keepalive.sql（新） | keepalive_log 建表 + sessions.last_keepalive_at + request_stats 两列 | 低，IF NOT EXISTS |
| server.js `getKeepaliveConfig()`（新，仿 1015 getContextConfig） | 读 settings + 代码默认值 | 低 |
| server.js `_inActiveHours()`（新） | 上海时区活跃时段判断 | 中：时区（见 §4.2） |
| server.js `keepaliveCheck()`（新） | 门控 + 原子并发锁：时段/距用户消息/双 cap/不叠留言/抢锁 | 中：幂等+并发 |
| server.js `buildWakeMessages()`（新） | buildModelContext 输出 → 换尾为唤醒指令 | 中：缓存前缀（见 §4.5） |
| server.js `runKeepalive()`（新） | 调 DeepSeek 非流式 → JSON 解析 → grounded 门控 → 写库 → diary | 中：JSON 可靠性 |
| server.js `loadPendingKeepalive()`（新）+ `buildModelContext`（1182 改） | 动态区注入【自由活动记录】 | 中：injectTime 条件 |
| server.js `consumeKeepalive()`（新） | 响应完成后置 consumed | 低 |
| server.js 路由（2205 区） | GET /api/keepalive/messages + POST /api/keepalive/check | 低 |
| server.js 启动区（2638） | setInterval 挂 keepaliveCheck | 低（休眠下失效，靠 cron 兜底） |
| server.js `callOpenRouterNonStream`（2165 改） | 加 `opts.max_tokens`、`opts.responseFormat` 两个可选覆盖 | 低，向后兼容 |
| 前端 angel-garden-diary | 信箱面板 + 角标 + fetch | 低（形态见 §5） |

## 3. 迁移（新文件，跟 2026-08-13-rls.sql 同批次跑）

```sql
-- keepalive 主动唤醒 v1
ALTER TABLE sessions ADD COLUMN IF NOT EXISTS last_keepalive_at timestamptz;

CREATE TABLE IF NOT EXISTS keepalive_log (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  session_id text NOT NULL,
  run_at timestamptz NOT NULL,
  action text NOT NULL,          -- message | diary | none
  content text,                  -- message=留言正文 / diary=日记正文 / none=空
  source text,                   -- message 的依据（逐字引述）；空 = 没依据
  consumed boolean DEFAULT false,
  created_at timestamptz DEFAULT now()
);

-- 观测：request_stats 记 keepalive 诊断
ALTER TABLE request_stats ADD COLUMN IF NOT EXISTS keepalive_action text;
ALTER TABLE request_stats ADD COLUMN IF NOT EXISTS keepalive_meta jsonb;
```

settings 6 键（keepalive_enabled/interval_min/active_start/active_end/daily_cap/**daily_wake_cap**）**不写迁移**——代码侧默认值兜底，想改在 Supabase 直接插 settings 行（仿 getContextConfig 读法）。

## 4. 后端实现细节

### 4.1 配置读取 `getKeepaliveConfig()`（仿 getContextConfig L1015）

```js
const KEEPALIVE_DEFAULTS = {
  keepalive_enabled: true, interval_min: 120,
  active_start: 8, active_end: 24, daily_cap: 3, daily_wake_cap: 6, model: null
};
// SELECT keepalive_enabled, keepalive_interval_min, ... FROM settings WHERE session_id='global'
// 解析失败/无行 → 返回 KEEPALIVE_DEFAULTS（含 model 默认 null → 用 toOpenRouterModel(undefined)）
```

### 4.2 活跃时段 `_inActiveHours(now, cfg)` —— ⚠️ 时区

**风险点**：Railway 实例多半跑 UTC，`new Date().getHours()` 拿的是 UTC 小时，跟上海的 8–24 对不上。必须显式算上海小时：

```js
function shHr(ts) {
  // 已有 shClock/shDateLight 是上海时区格式化，这里要的是「上海时区的小时数」
  return Number(new Date(ts).toLocaleTimeString('en-US', { timeZone: 'Asia/Shanghai', hour12: false }).slice(0, 2));
}
function _inActiveHours(now, cfg) {
  const h = shHr(now);
  return cfg.active_start <= cfg.active_end
    ? cfg.active_start <= h && h < cfg.active_end
    : h >= cfg.active_start || h < cfg.active_end;   // 跨午夜：start>end，如 22 → 6
}
```

// 时区拍板（GPT 评审）：硬编码 Asia/Shanghai。单用户上海，不做时区配置/夏令时，避免过度工程。
// 不要用 active_end=25 这种写法——shHr 只会返回 0–23，跨午夜统一用 start>end 表达。

### 4.3 会话选择 `findKeepaliveSession()`

```js
// 规则（GPT 评审改名+钉死语义）：「最近更新过、且确实有过对话」的会话
// SELECT id FROM sessions ORDER BY updated_at DESC LIMIT 1
// 再 count messages(role='user', visible) > 0，否则返回 null
```

### 4.4 门控 `keepaliveCheck()`（幂等核心 + 原子并发锁）

```js
async function keepaliveCheck() {
  const cfg = await getKeepaliveConfig();
  if (!cfg.keepalive_enabled) return;
  if (!_inActiveHours(Date.now(), cfg)) return;          // 活跃时段外，安静
  const sessionId = await findKeepaliveSession();        // 无会话 → return
  const lastUserAt = 该会话最新一条 user 消息的 created_at;
  if (Date.now() - lastUserAt < cfg.interval_min * 60000) return;  // 你还在身边
  const todayWakes = await countTodayKeepalive(sessionId);         // 今日所有 action 的行数
  if (todayWakes >= cfg.daily_wake_cap) return;          // 今天醒够次数了（成本闸，GPT 评审新增）
  const todayMsg = await countKeepalive('message', 今日上海自然日) + 未消费的 message 数;
  if (todayMsg >= cfg.daily_cap) return;                 // 今天话够多了
  if (存在 consumed=false, action=message 的行) return;  // 上一条留言你还没回，不叠

  // —— 原子并发锁（GPT 评审必须项）：cron 与 setInterval 可能同时进来，只放行一个 ——
  // 用一次「条件更新」抢这轮唤醒权：sessions 行只在
  //   (last_keepalive_at 为空 或 距今 ≥ interval_min) 时才被更新。
  // 拿到行 = 抢到锁；拿不到 = 另一路已醒，直接退出。PostgREST 原生支持，无需新增依赖。
  const claimTs = new Date().toISOString();
  const { data: claimed, error } = await supabase
    .from('sessions')
    .update({ last_keepalive_at: claimTs })
    .eq('id', sessionId)
    .or(`last_keepalive_at.is.null,last_keepalive_at.lt.${new Date(Date.now() - cfg.interval_min * 60000).toISOString()}`)
    .select('id');
  if (error || !claimed?.length) return;                 // 没抢到 → 这轮唤醒权已被拿走

  try {
    await runKeepalive(sessionId);
  } catch (err) {
    // 失败 → 回滚锁（仅当 last_keepalive_at 仍是 claimTs 时改回 null），下轮 cron 可立即重试
    await supabase.from('sessions').update({ last_keepalive_at: null })
      .eq('id', sessionId).eq('last_keepalive_at', claimTs);
  }
}
```

**失败语义（GPT 评审修订）**：模型调用抛错 → 回滚锁，下轮可重试；JSON.parse 失败 → **不重试**，降级 none 记一次唤醒。一次唤醒最多一次 API 调用。

### 4.5 唤醒请求 `buildWakeMessages(sessionId)` —— 缓存前缀如何保住（关键）

机制（已在真实代码上核过）：
1. `const { messages, diagnostics } = await buildModelContext(sessionId)` —— 复用现成组装。system(1h)/frozen(1h)/summary(1h) 逐块 cache_control + 顶层 `body.cache_control={type:'ephemeral'}`（callOpenRouterNonStream L2178 已有）。
2. buildModelContext 的 messages **最后一条是用户上一条消息**（历史尾部）。把它**整体替换**成唤醒指令（design.md §4 全文，常量 `WAKE_PROMPT_TEXT`）：

```js
messages[messages.length - 1] = { role: 'user', content: WAKE_PROMPT_TEXT };
```

3. 只要两次请求之间稳定区（system/frozen/summary）没被摘要塌缩/新内容改写，**字节前缀就与上次聊天一致 → 具备缓存命中条件**（实际命中由 provider 决定，不承诺「必然命中」——GPT 评审修订）。

- buildModelContext 的输出会随「摘要更新 / 残留更新 / 时间注入 / live 窗口移动」变化——但这是**普通聊天之间也一样的动态性**，keepalive 只是复用同一套组装，并不额外破坏前缀。且 keepalive 只写 keepalive_log（不进 messages 历史），唤醒**不会**反过来污染下一次聊天的前缀。
- 验证不靠猜：buildModelContext 已返回 `frozen_prefix_hash` / `summary_hash` / `live_hash`，runKeepalive 把它们记进 keepalive_meta；之后拿普通聊天的 request_stats 哈希与唤醒对比，即可证明前缀一致（见 §4.6/4.11）。

### 4.6 执行 `runKeepalive(sessionId)`

```js
const { messages, diagnostics } = await buildWakeMessages(sessionId);
// callOpenRouterNonStream 加两个可选覆盖：
//   opts.max_tokens        （默认 2000 → 唤醒传 500）
//   opts.responseFormat    （'json_object' → body.response_format={type:'json_object'}）
let parsed = {};
try {
  const { msg, usage } = await callOpenRouterNonStream(messages, null, {
    model: cfg.model, thinking: 'off', max_tokens: 500, responseFormat: 'json_object'
  });
  parsed = JSON.parse(msg.content || '{}');   // 解析失败 → {} → 走 none
} catch { /* 解析失败不重试（GPT 评审：一次唤醒最多一次 API），本次记 none */ }
let action = ['message','diary','none'].includes(parsed.action) ? parsed.action : 'none';
const source = String(parsed.source||'').trim().slice(0,120);
let content = String(parsed.content||'').trim().slice(0,200);

// —— 真 grounded（GPT 评审必须项）：source 必须能在这轮唤醒上下文里逐字找到，不信模型自述 ——
const contextText = messages
  .filter(m => m.role === 'user')
  .map(m => Array.isArray(m.content) ? m.content.map(b => b.text || '').join('\n') : m.content)
  .join('\n');
const grounded = source.length > 0 && contextText.includes(source);
if (action === 'message' && !grounded) { action = content ? 'diary' : 'none'; }   // 宁丢勿假

// 写 keepalive_log（run_at, session_id, action, content, source, consumed=false）→ 拿回 wake_id
// if (action==='diary') → 走 handleDiaryWrite 同款写入（diary_entries, event_time=now）
// recordRequestStat({ client:'keepalive', keepalive_action:action,
//   keepalive_meta:{ wake_id, source_hit: grounded, model, estimated_tokens,
//     frozen_prefix_hash, summary_hash, live_hash } })   // 哈希用于对比缓存前缀（§4.11）

// ⚠️ grounded 的代价：旧对话的逐字原话可能只存在于摘要（已压缩），includes() 会漏判 → 降级 diary。
//   这是「宁丢勿假」的安全方向，接受（GPT 评审认可）。
```

### 4.7 动态区注入 `loadPendingKeepalive(sessionId)` + buildModelContext 改动

```js
async function loadPendingKeepalive(sessionId) {
  // SELECT id, action, content, source, run_at FROM keepalive_log
  //   WHERE session_id=? AND consumed=false AND action IN ('message','diary') ORDER BY run_at
  // 拼成 lines：
  //   - `- 你给她留了条消息：「content」（依据：source）`
  //   - `- 你在小日记里写道：「content」`
  // return { notes: `\n【自由活动记录】\n` + lines.join('\n') 或 '',
  //          ids: [这次取出的那几条 id] }     // ids 交给 consumeKeepalive 只消费本次注入的（§4.8）
}
```

改 buildModelContext（L1240–1267 一带）：
1. `const { notes: keepaliveNotes, ids: keepaliveInjectedIds } = await loadPendingKeepalive(sessionId);`
2. `const injectTime = heartbeat || resumeGap || asksTime || !!keepaliveNotes;` ← **注入条件加上 pending 存在**
3. 注入后 `diagnostics.keepalive_injected_ids = keepaliveInjectedIds;`（随诊断返回，供 §4.8 认领）
4. 组装时（L1343）：

```js
if (injectTime) {
  let body = '';
  if (timeNotice) body += `【当前时间】\n${timeNotice}`;
  if (keepaliveNotes) body += keepaliveNotes;          // 自带【自由活动记录】标签
  const timeMsg = { role: 'user', content: body };
  // 插到 live 尾部、当前用户消息之前（原逻辑）
  ...
}
```

> 关键点：**有 pending 但无心跳/无恢复对话时也必须注入**——否则你正常发消息（距上次 <1h）就永远看不到沈晏的留言。这就是 `|| !!keepaliveNotes` 的意义。

### 4.8 认领 `consumeKeepalive(sessionId, injectedIds)`（handleChat 响应后钩子）

在 handleChat 的 `if (opts.client === 'angel')` 块（流式 L2539 / 非流式 L2612）里，**新增一行**，并传入本次**实际注入过的 ids**：

```js
if (opts.client === 'angel') {
  scheduleSummary(sessionId);
  scheduleResidue(sessionId);
  scheduleMemoryWrite(sessionId);
  consumeKeepalive(sessionId, diagnostics.keepalive_injected_ids);   // ← 只认领这次真注入的
}
```

- ids 由 buildModelContext 在注入时放进 `diagnostics.keepalive_injected_ids`（§4.7）。
- **只消费「这次上下文里真实出现过」的 pending**——不会把从没进过上下文的留言误标已读（GPT 评审修订）。
- 时序：用户消息 → buildModelContext 注入 pending（记 ids）→ 模型回复 → 后台钩子按 ids 置 consumed。**你开口即认领**；只看信箱不算。

### 4.9 路由

```js
// GET /api/keepalive/messages?session_id=xxx
// → { items: [{id, run_at, action, content, source, consumed}...按 run_at 倒序],
//      has_pending: bool }            // 存在 consumed=false 的 message

// POST /api/keepalive/check   —— 外部 cron 触发入口，与 setInterval 共用 keepaliveCheck()
// 鉴权：若 process.env.KEEPALIVE_CRON_SECRET 存在，要求 x-cron-secret 头一致
//   （用 crypto.timingSafeEqual 做恒定时间比较，GPT 评审），否则 401
```

### 4.10 调度 —— ⚠️ Railway 休眠现实

- `app.listen` 后 `setInterval(keepaliveCheck, 15*60*1000)`（启动也跑一次）。
- **但 Railway 空闲会休眠，setInterval 不 fire**。所以真正的机制是：
  - **外部 cron（cron-job.org 等）每 ~30 分钟 POST /api/keepalive/check** —— 这一发同时把实例唤醒了 + 触发检查，等于「保活 + 触发」二合一。
  - 幂等由 keepaliveCheck 门控兜住（interval/last_keepalive_at/日 cap），重复命中无害。
- 建议 v1 直接两个都挂，靠幂等去重。

已评审通过（GPT）：cron 兼 scheduler 成立。接受「离开 ≥2h 后、在下一次调度点才可能醒」的粒度——15–30 分钟级，反而不该追求秒级精确。

### 4.11 观测

request_stats 每 keepalive 写一行：`client='keepalive'` + `keepalive_action` + `keepalive_meta`（source_hit、model、estimated_tokens）。前端 Stats 面板或 SQL 直接看：每天醒几次、各 action 占比、source 命中率。

## 5. 前端（建议形态，等用户定）

- 新增 `src/components/Mailbox.jsx` + 一个角标（有 pending 时 Home 上出现小信箱标记，不弹窗不打断）。
- `GET /api/keepalive/messages?session_id=` 拉列表，渲染为沈晏侧气泡 + run_at 时间。
- 用户发第一条消息后 pending 自动清（后端响应钩子置 consumed），角标消失。
- 具体 UI 样式交用户/前端设计，后端接口形状已定。

## 6. 实施顺序

1. 迁移文件（建表）→ 2. getKeepaliveConfig + _inActiveHours → 3. buildWakeMessages + runKeepalive（含 callOpenRouterNonStream 两个覆盖 + 真 grounded）→ 4. keepaliveCheck + findKeepaliveSession（含原子并发锁）→ 5. buildModelContext 注入 + consumeKeepalive → 6. 两个路由 + 调度 → 7. 前端信箱 → 8. 观测/调优。

每步独立可测：runKeepalive 可先写临时脚本直接调（仿 backfill-segments-temp.js 模式）验证 JSON 解析与 grounded 门控。

## 7. 评审结论（2026-08-13 GPT 已过，逐条落定）

| # | 原问题 | 结论 | 落地位置 |
|---|---|---|---|
| 1 | 缓存论断 | ✅ 措辞降为「具备命中条件」不承诺必然命中；用前缀哈希对比验证 | §4.5 / 4.6 / 4.11 |
| 2 | 调度 | ✅ 外部 cron 兼 scheduler 成立；接受「≥2h 后下个调度点才醒」的粒度 | §4.10 |
| 3 | 时区 | ✅ 硬编码 Asia/Shanghai，不做时区配置/夏令时 | §4.2 |
| 4 | 成本 | ✅ 新增 daily_wake_cap（每天最多醒 6 次），与 daily_cap（每天最多 3 条留言）分离 | §4.1 / 4.4 |
| 5 | JSON | ✅ 当前配置够 v1；解析失败降级 none、不重试、一次唤醒一次 API | §4.6 |
| 6 | 认领 | ✅ 只看不算、开口才认领；且只消费本次实际注入的 ids | §4.8 |
| 7 | 鉴权 | ✅ secret 头 + timing-safe 比较；并发由 §4.4 原子锁兜底 | §4.9 / 4.4 |

**开工前必须修的 3 项（已全部落入正文）**：
1. 并发锁 —— §4.4 原子条件更新抢锁（无新依赖），防 cron+setInterval 双触发两次模型调用
2. 真 grounded —— §4.6 source 必须能在唤醒上下文里逐字找到，不信模型自述；找不到降级 diary/none
3. 缓存措辞降级 + 哈希留证 —— §4.5 不承诺必然命中；§4.11 记录前缀哈希供对比

## 8. 明确不做的（v1 边界，评审勿推翻）

- 不合并进 messages 历史（pairTurns 冻结字节、缓存，见 §4.5）
- 不做推送 / PWA / 感知层
- 不加 explore / 联网工具
- 不在保留期写 settings 迁移行（代码默认值兜底）
