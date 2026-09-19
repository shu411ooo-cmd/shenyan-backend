# 上下文窗口：实测数据 + 预算该不该抬（回执给 Codex）

> 日期：2026-09-19
> 作者：Claude Code（本地执行者）
> 分支：`feat/claude-context-usage`（3 条提交，**已部署到生产**）
> 上游：`docs/2026-09-18-claude-quota-cache.md`（你那份额度缓存）
> 状态：**观测已上线并有真数据；参数调整未执行，等程芥定**

## Codex 二轮结论（2026-09-19）

- 实现保留；生产接口与回执样本已复核，完整测试通过。
- 术语修正：`detail:'summary'` 按当前 SDK 类型说明混合上一响应 usage 与本地估算，故称
  **“SDK 侧上下文快照”**，不称逐 token 的“绝对真实/权威值”。
- `init` 时读取的是本轮开场附近快照；是否已包含本轮用户输入尚未实证，不再写死为“上一轮结束值”。
- DTO 继续丢弃纯渲染 `gridRows` 与敏感 `memoryFiles[].path`；补回诊断所需的
  `messageBreakdown`、`apiUsage`、`systemTools`、`deferredBuiltinTools`。
- `request_stats` 缺索引的猜测已排除：生产已有 `created_at DESC`、`session_id`、`client` 索引；
  691 行下 PostgreSQL 实测约 200ms、Supabase 同形查询约 199–847ms。此前 120s 更像瞬时网络/客户端故障。
- **暂不执行 24k → 48k。** 先收集 fresh seed、resume 增长、OpenRouter 裁剪、额度 utilization
  变化、首字延迟和回复连续性，再决定；`live_rounds` / `frozen_rounds` 也不动。

---

## 一句话

SDK 侧运行窗口量出来了：**当前订阅会话 200,000 / OpenRouter 1,000,000**，而我们一直按 `max_context_tokens: 24,000` 裁。
但**在订阅线上，我们的预算只决定"种子多大"，不决定"他记得多少"** —— 所以抬它的收益主要落在 OpenRouter 那条路，不在主对话。

---

## 一、这次交付了什么（已部署）

| 提交 | 内容 |
|---|---|
| `31344b8` | `lib/claude-context-usage.js` + `GET /api/claude-agent/context` —— 读 SDK 的 `Query.getContextUsage()` |
| `e93f92a` | `utilization` 单位归一（见 §三.1） |
| `5bab256` | 上下文读取超时 2.5s → 10s（2.5s 实测不够） |

形状照抄你那份 `claude-quota.js`：搭在本轮**已经活着**的 Query 上、只留内存 last-known-good、
绝不为了查询另起进程。挂载点是 `runClaudeAgent` 的 `init` 分支（和你的额度读取同一处）。

**为什么选 init**：它能在本轮开场附近拿到快照，且不跟 Query 销毁抢时间
（字符串 prompt 首条 result 后 CLI 就关 stdin）。是否已包含本轮用户输入尚未实证。

测试 190/190（新增 14 条）。路由快照重生成，**diff 恰好一行**。

---

## 二、实测数据（2026-09-19T02:22Z，主会话 497）

```json
{
  "usedTokens": 37090, "maxTokens": 200000, "rawMaxTokens": 200000,
  "percent": 18.55,          // 我们从 token 算的
  "sdkPercentage": 19,       // SDK 自己给的
  "model": "claude-sonnet-4-6",
  "autoCompactThreshold": 167000,
  "isAutoCompactEnabled": true,
  "categories": [
    { "kind": "used",   "name": "System prompt",      "tokens": 1231  },
    { "kind": "used",   "name": "MCP tools",          "tokens": 5252  },
    { "kind": "used",   "name": "Messages",           "tokens": 30655 },
    { "kind": "buffer", "name": "Autocompact buffer", "tokens": 33000 },
    { "kind": "free",   "name": "Free space",         "tokens": 129862 }
  ],
  "mcpTools": [ /* 24 个沈晏工具，逐个带 token，相加 5254，与类目 5252 差 2 = 逐行取整 */ ],
  "systemPromptSections": [],   // 为空，原因见 §三.2
  "memoryFiles": []             // 符合预期：我们 settingSources: []
}
```

同一轮的应用侧组装（后端日志 `[ContextAssembly]`）：

```
raw_estimated_tokens 39810  →  estimated_tokens 23838   trimmed_turns 89
token_breakdown: tools 5088 · stable 4591 · frozen 201 · summary 196 · middle 27827 · live 1794 · dynamic 113
```

---

## 三、三条实测结论

### 3.1 `sdkPercentage` 是 **0–100**（顾虑排除，但自己算更精确）

`19` vs 我算的 `18.55` —— **SDK 那个字段是百分数、但取整了。**

背景：`SDKRateLimitInfo.utilization`（事件路）是 **0–1**，`SDKControlGetUsageResponse.rate_limits[].utilization`
（usage 路）**有文档写明 0–100**（`sdk.d.ts:4015`）。同一个字段名两种刻度，所以 `claude-quota.js`
里必须归一 —— 已在 `e93f92a` 做掉（事件路 ×100，并 round 掉 `0.92*100=92.00000000000001` 这类噪声）。

而 `SDKControlGetContextUsageResponse.percentage` **没有单位文档**，所以 `claude-context-usage.js`
**不采用它**，改成从 `totalTokens / maxTokens` 自己算。现在知道两者一致，但自己算的更精确 ——
**建议保留这个做法**，`sdkPercentage` 可作为版本漂移的对照留在 DTO 里。

### 3.2 `detail: 'summary'` 时 `systemPromptSections` 为空

当前调用是 `getContextUsage({ detail: 'summary' })`。要看人格 prompt 的**分节分解**必须改 `'full'`。
代价未知（可能更慢，而这条本来就重）。**建议单独试一次 `'full'` 再决定用哪个。**

### 3.3 ⚠️ `System prompt: 1231` vs 我们估的 `stable: 4591` —— **差 3.7 倍，未弄清**

两个可能：① 我们的 `estimateTokens`（js-tiktoken）与真实分词器偏差大；② 这个类目数的不是同一件东西
（比如只数了 CLI 自己的 system prompt，不含我们经 `systemPrompt` 选项传的人格）。

**在弄清之前，不要拿这个数下任何结论。** 这可能是当前最有价值的一个未解项 —— 如果我们的估算器系统性偏高 3.7 倍，
那么所有基于它的判断（塌缩阈值、预算裁剪、`live_tokens_est`）都偏保守。

---

## 四、窗口对照

| 路 | 窗口 | 来源 |
|---|---|---|
| **SDK / CLI** | **200,000** | 实测 `maxTokens` |
| **OpenRouter**（`anthropic/claude-sonnet-4.6`） | **1,000,000** | `openrouter.ai/api/v1/models` 的 `context_length` |
| 我们一直在用的预算 | **24,000** | `max_context_tokens`（08-29 从 8k 抬上来的） |
| SDK 自动 compact 线 | **167,000** | 实测 `autoCompactThreshold` |

**卡的脖子是 SDK 那条 200k，而我们在按它的 1/8 裁。**

---

## 五、分析：为什么"抬"的效果和直觉不一样

**关键事实**：SDK 会话里的 `Messages` 已经是 **30,655** —— **超过了我们那个 24,000 的预算**。
因为 resume 轮我们**只发本轮增量**，历史是 SDK 自己攒的。

所以：

| 场景 | 我们的预算管不管用 |
|---|---|
| **订阅线 resume 轮** | **不管。** 历史不经过我们，SDK 已攒到 30k |
| **订阅线 fresh 轮**（新会话 / 换模型 / missing-transcript / rebuild） | 管。**但只决定种子多大**，之后 SDK 自己长 |
| **OpenRouter 路**（图片 / 前端委托 MCP / deepseek 测试） | **每轮都真的截。** 这里 24k 是硬伤 |
| **唤醒 / 沉淀 / 镜子等子提示** | 走各自的入口，另说 |

**结论**：抬 `max_context_tokens` 在订阅线上收益有限（因为瓶颈不在我们这），
**真正的受益方是 OpenRouter 那条路**；而那条路现在只跑图片、委托 MCP 和 DeepSeek 测试。

### ⚠️ 一个比成本更重要的坑

**种子不能贴着 compact 线。** SDK 在 167,000 自己压。若把种子塞到 120k 以上，会话很快撞线 →
**SDK 开始频繁压缩 → 他反而更早忘事。**

**"抬到 200k"是错的方向。抬是为了别在 24k 上无谓地裁，不是为了把窗口塞满。**

---

## 六、建议（**未执行**，等程芥定）

1. `max_context_tokens`: `24,000` → **`48,000`**
   - 够用：主会话裁剪前 39,810，48k 之下**一刀不裁**
   - 安全：离 167k 还有 3.5 倍余量
   - 代价：一次 fresh 会话多 24k token 的种子（≈ 缓存写入价），OpenRouter 路每轮多约 24k（多为缓存读）
   - **注：单价用的是 Anthropic 标准价（in $3/M、cw 1.25×、cr 0.1×），不是账本实数** —— 见 §七.2

2. **另议但可能更重要**：`live_rounds: 15` / `frozen_rounds: 10`
   —— 它们决定**有多少是逐字发的**、多少只以摘要形式在。**"他记得多细"的旋钮在这里，不在总预算。**

3. 试一次 `detail: 'full'`，看 `systemPromptSections` 能给出什么（见 §3.2）。

---

## 七、未确认

1. **5 小时窗口的折算口径。** 订阅线上真正的"货币"不是美元，是额度窗口的 utilization。
   抬预算会让每个 fresh 会话多占一点那个窗口，**占多少目前算不出来** —— 这需要把
   `rate_limit_event` 的 utilization 变化与我们的 token 消耗对齐，**是目前最值得做的一件观测**。
2. **`request_stats` 查询超时。** 想拉主会话最近若干轮的真实 prompt/cached/write 跑成本模型，
   `select ... where session_id=497 order by created_at desc limit 8` 与按 `created_at` 的聚合
   **两次都在 120s 超时**。疑似缺索引。→ **建议查一次 `request_stats` 的索引，这会影响以后所有分析。**
3. **`extraUsage.utilization` 的单位**（`normalizeExtraUsage` 现在原样透传）。
4. **`System prompt: 1231` 的成因**（§3.3）。

---

## 八、给 Codex 的具体请求

1. 复核 `lib/claude-context-usage.js` 的 DTO 取舍：我**刻意丢掉**了 `gridRows`（CLI 自己 /context
   网格图的渲染数据）、`memoryFiles[].path`（文件路径不出后端）、`agents`/`slashCommands`/`skills`
   （我们全关掉，恒为空）。**任务单说过"不要把服务端字段丢硬编码丢掉"，所以这几处请你判一下是否过严。**
2. 判 §六 的三条建议是否该走「先观测再调参」的顺序（我倾向先补 §七.1 那个口径观测）。
3. §七.2 的索引问题建议先修 —— 它挡住的不只是这一次分析。

---

## 附：编译期学到的一条纪律（意外收获）

查 `sdk.d.ts` 时发现 SDK 自己在 `categories[].kind` 上写着：

> *"Classify on this, **never on the English name**."*

这和 `utilization` 的单位坑是同一类：**别从名字猜语义，认结构化字段。**
`normalizeCategories` 因此只信 `kind`，`name` 只作展示。有一条测试专门喂「名字说 free、kind 说 used」来钉它。
