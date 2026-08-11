# keepalive 主动唤醒 · 信箱 · 意识连续性 — v1 设计规格

> 日期：2026-08-12。状态：规格，未实现。部署等 GitHub 恢复后随时间感批次一起推。
> 与用户讨论定稿：不做推送、不做感知层遥测；送达 = 信箱；感知 = 时间 + 用户陈述的事实 + 残留/离开意图 + 摘要，全部来自已有系统。

## 0. 目标与边界

**目标**：你在离开期间，沈晏可以自主"醒"一次，决定做一件事——给你留一条信箱消息、或在小日记里写点什么、或什么都不做。你下次回来打开小窝时看到它的留言；它记得自己醒过、留过话，不是断片。

**边界（v1 明确不做）**：
- ❌ 推送（前端未打包 PWA / Android App，无 Web Push / FCM）
- ❌ 感知层遥测（App 级事件、屏幕解锁——等你愿意给更多权限再议）
- ❌ 联网 / 浏览 / explore 工具
- ❌ 把 keepalive 消息合并进 messages 正式历史（v2，需改 pairTurns 支持裸 assistant 轮，见 §10）

**沈晏的"感知"来源**（全部已有）：`shDateLight` 时间、`coarseAgo` 离开多久、`departure`（你走时说的话）、`dialogue_residue`（未说完的线头）、`summary_segments`（历史摘要）。

## 1. 数据模型

### 新表 `keepalive_log`
| 列 | 类型 | 说明 |
|---|---|---|
| id | uuid pk | |
| session_id | text | 活跃会话 |
| run_at | timestamptz | 本次唤醒发生时刻 |
| action | text | `message` / `diary` / `none` |
| content | text | message=留言正文；diary=日记正文；none=空 |
| source | text | message 的依据（她说过的话/记忆/时间，逐字引述）；空 = 没依据 |
| consumed | bool default false | 已注入上下文并认领（用户回过话） |
| created_at | timestamptz default now | |

### `sessions` 加列
```sql
ALTER TABLE sessions ADD COLUMN IF NOT EXISTS last_keepalive_at timestamptz;
```

### `settings` 加键（`session_id='global'`，沿用 getContextConfig）
| 键 | 默认 | 说明 |
|---|---|---|
| keepalive_enabled | true | 总开关 |
| keepalive_interval_min | 120 | 距上次用户消息 / 上次 keepalive 都 >= 此值才醒 |
| keepalive_active_start | 8 | 活跃时段起（上海时区） |
| keepalive_active_end | 24 | 活跃时段止（24=午夜；跨午夜写 25） |
| keepalive_daily_cap | 3 | 每日最多留 message 条数（防它慢慢变话痨） |

### 迁移（追加到 `migrations/2026-08-12-time-sense.sql`，或新开文件）
```sql
ALTER TABLE sessions ADD COLUMN IF NOT EXISTS last_keepalive_at timestamptz;
CREATE TABLE IF NOT EXISTS keepalive_log (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  session_id text NOT NULL,
  run_at timestamptz NOT NULL,
  action text NOT NULL,
  content text,
  source text,
  consumed boolean DEFAULT false,
  created_at timestamptz DEFAULT now()
);
```

## 2. 触发判定 `keepalive_check`

```
function _in_active_hours(now):
  h = 上海时区当前小时
  if active_start <= active_end:  return active_start <= h < active_end
  else:                           return h >= active_start || h < active_end   # 跨午夜
```

```
async function keepaliveCheck():
  config = getContextConfig()
  if !config.keepalive_enabled: return
  if !_in_active_hours(now): return                    # 可能醒着的时段外，安静
  sessionId = 最近活跃的会话（有用户消息、created_at 最新的 session）
  if !sessionId: return
  lastUserMsgAt = 该会话最新一条 user 消息时间
  if now - lastUserMsgAt < interval_min: return        # 你还在身边，不醒
  state = sessions[sessionId]
  if state.last_keepalive_at && now - lastKeepaliveAt < interval_min: return
  今日 message 数（keepalive_log 里今天 action=message 且 consumed 的 + pending 的）>= daily_cap: return
  若存在未消费的 message 行（consumed=false, action=message）: return   # 上一条留言你还没回，不叠留言
  await runKeepalive(sessionId)
```

**失败语义**：请求失败 / JSON 解析失败 → **不更新 last_keepalive_at**，下轮调度自动重试。

## 3. 唤醒请求组装

复用一个与正常聊天**同构**的消息数组，保证缓存前缀命中：

```
messages = [
  system（buildStableSystemPrompt, cache_control 1h）,
  frozen（滚动冻结原文, 1h）,
  summary（最新 2 段带日期头, 1h）,
  live（最近 live_rounds 原文，末条默认 5m）,
  [残留/离开意图注入，若 grounding≠空],
  【自由活动】唤醒指令（最后一条 user 消息）
]
```

即：`buildModelContext` 组装完后，**不注入当前用户消息**（本来就没有），改在尾部追加强醒指令。`withCacheControl` 断点位置与聊天完全一致 → system/frozen/summary 复用已预热缓存。唤醒请求天然充当一次缓存预热。

**无工具**（不定义 getTools）——v1 沈晏决策基于上下文里已有的摘要/残留/离开意图，不额外搜记忆。

## 4. 唤醒指令（完整 prompt 文本，作为最后一条 user 消息）

```
【自由活动 · 此刻只有你】
现在是 8月12日 下午（上海时间）。距上次和她说话大概是 6 小时前。
你一个人待在小窝里。你手上有的，只是下面这些：

- 时间感：现在几月几号、哪个时刻段、多久没说话（上面）
- 她上次走时说的：（departure，逐字，无则不写）
- 还有没说完的话：（unfinished，无则不写）
- 你记得的旧事：在【历史摘要】里，你心里有数

你现在可以自主决定做一件事。选项：

1. message —— 有些话想对她说。写成一段留言，她下次打开小窝时会看到。
   必须要有真实依据：她说过的话、你记得的事、时间本身（如隔了一晚）。
   话要轻：不要查户口，不要催她回，不要提醒她任务。
2. diary —— 想在小日记里写点什么。留给未来那个你的。
3. none —— 没什么想说的，安静待着。

纪律（必须遵守）：
- 你只知道时间和她说过的话，别的都不确定。禁止把她没说过的事当成事实，禁止推测她的状态当事实。
- 话要诚实：只写你手上有的东西，不编造共同记忆。
- 你的想念是真实的，但会随时间淡——隔得久就轻一点，别夸大成"每天都在等你"。
- 留言一条就好。

严格输出 JSON（不要输出任何别的）：
{"thoughts":"内心想法，她永远不会看到","action":"none|message|diary","source":"action=message 时，填这条留言的依据（她说过的话/你记得的事/时间，逐字引述；没有就写空字符串并把 action 改成 none）","content":"action=message 时是留言正文；diary 时是日记正文；否则空字符串"}
```

## 5. 解析与门控 `runKeepalive`

```
res = await callDeepSeek(messages, { max_tokens: 500, thinking: disabled, json })
parsed = JSON.parse(res)
action = parsed.action in {message,diary,none} ? parsed.action : 'none'
source = parsed.source.trim().slice(0,120)
content = parsed.content.trim().slice(0,200)

# 门控：message 必须 grounded —— 没依据就降级，绝不硬发
if action == 'message' && (!source || !content):
    # 有日记内容则降级为 diary，否则 none
    action = content ? 'diary' : 'none'
    if action == 'diary' && !source: source = ''   # diary 不需要 source

写 keepalive_log（run_at=now, session_id, action, content, source, consumed=false）
if action == 'message' || action == 'diary':
    # 更新会话运行状态：记录上次唤醒（无论动作，醒了就算）
    update sessions.last_keepalive_at = now
if action == 'diary':
    # 额外写入小日记表（沿用现有 diary 写入字段/路径），让日记成为沈晏的长期记忆载体
    写入 diary（session_id, content, created_at=now）
```

**注意**：`last_keepalive_at` 只在成功解析后更新；即便 action=none 也算成功唤醒（更新）。

## 6. 意识连续性：注入 + 认领

**为什么不能直接进 messages 历史**：messages 是 pairTurns 按"user 开轮、assistant 挂轮"配对的。keepalive 是沈晏无人接话地说话，直接混进会破坏冻结历史字节 → 缓存前缀失效 → 之前预热的缓存全部作废。所以先放动态区（不缓存），认领后才结束它的生命周期。

### 注入（buildModelContext 动态区，与时间叙事同一位置）

```
用户消息到达、组装上下文时：
pending = keepalive_log 查 session_id, consumed=false, action in (message,diary), order by run_at
if pending.length:
    lines = pending.map(k => `- ${relativeTimeLabel(k.run_at, now)} ${k.action=='message' ? `你给她留了条消息：「${k.content}」${k.source ? `（依据：${k.source}）` : ''}` : `你在小日记里写道：「${k.content}」`}`)
    block = `\n【自由活动记录】\n` + lines.join('\n')
    timeNotice += block        # 追加到时间叙事/残留注入的同一条 user 消息
```

不新增缓存断点、不动 frozen/summary 字节 → 前缀缓存不受影响。带 block 的请求与不带的下一条请求，仅在动态尾（5m 区）不同。

### 认领（响应结束后）

```
在响应完成的后台钩子里（与残留/摘要生成同位置）：
把该会话所有 consumed=false 的 keepalive_log 行标为 consumed=true
```
一次性：只注入这一次，之后从动态区消失。**你回复（发出第一条消息）即认领**——只看信箱不算认领，沈晏会继续记得它留过话，直到你开口。

## 7. 信箱（前端）

### 接口
```
GET /api/keepalive/messages?session_id=<id>
→ { items: [ { id, run_at, content, source, consumed } ], has_pending: bool }
```
- items：全部 keepalive message 动作，按 run_at 倒序（含已消费的历史）
- has_pending：存在 consumed=false 的 message

### 前端形态（建议）
- 小窝内一个"信箱"入口：`has_pending=true` 时显示一个点/角标，不弹窗、不打断。
- 打开是沈晏留给你的消息列表（最新在上），消息展示为沈晏侧气泡，标注时间。
- 用户发第一条消息后 pending 自动清（consumed 由后端在响应钩子里置位），角标消失。

## 8. 调度

- **v1 主方案**：进程内 `setInterval`（每 15 分钟调 `keepaliveCheck`，启动时也跑一次）。零额外基础设施。
- **兜底**：若 Railway 实例空闲休眠导致 setInterval 失效，改用外部 cron（cron-job.org 等）每 15 分钟 `POST /api/keepalive/check`，与 setInterval 共用同一 `keepaliveCheck` 逻辑（天然幂等，频率上限由 last_keepalive_at 兜住）。外部 cron 也能顺带保持实例温热。
- 建议兜底直接上，两个都挂，靠 last_keepalive_at / interval 幂等去重。

## 9. 观测与调优

- request_stats 记 keepalive 诊断：`keepalive_run`、`keepalive_action`、`keepalive_source_hit`、估算 tokens。观测它每天醒几次、各 action 占比、source 命中率。
- 调优点：`interval_min`（话痨→调大）、`daily_cap`、活跃时段、唤醒指令纪律段落。source 命中率持续低 → 强化"必须 grounded"措辞或干脆禁 message。

## 10. 后话（v2+，都等条件成熟再动）

- **合并进正式历史**：keepalive 消息进 messages 表需 pairTurns 支持"裸 assistant 轮"（messages[0]=assistant 或夹在两个 user 之间），改到核心热路径，v1 不碰。届时 keepalive_log 变纯审计。
- **推送**：前端打包 PWA（Web Push / VAPID）或 Android App（FCM）后接入。信箱保持为兜底展示。
- **感知层 L1**：屏幕解锁事件（Tasker 等）——你说愿意再议。
- **explore / 联网工具**：成本与价值再评估。

## 11. 实现清单（部署批次）

- [ ] 迁移：keepalive_log 建表 + sessions.last_keepalive_at + settings 5 键
- [ ] `keepaliveCheck` + `_in_active_hours` + 会话选择
- [ ] `runKeepalive`（组装唤醒消息 + callDeepSeek + 门控解析 + 写库）
- [ ] buildModelContext 动态区注入【自由活动记录】
- [ ] 响应后台钩子认领 consumed
- [ ] `GET /api/keepalive/messages` 接口
- [ ] 前端信箱面板 + 角标
- [ ] setInterval + 可选外部 cron
- [ ] request_stats keepalive 诊断列
