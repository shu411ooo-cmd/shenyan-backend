/* ============================================================
   Claude 订阅线的 **SDK 侧上下文窗口快照**

   为什么要有它：应用侧那套 Context Assembly（lib/context/build.js）算出来的
   raw_estimated_tokens / max_context_tokens 只描述**我们自己组装的那一份**。
   订阅线上真正的会话历史在 SDK/CLI 手里，而且会被 SDK 自己 compact ——
   拿应用层的数去说「他还记得住多少」，是拿错了视角。这个接口更接近
   SDK 实际会话，但 `detail:'summary'` 仍混合上一响应 usage 与本地估算，不能
   宣称是精确账单或逐 token 权威值。

   和额度一样，它**只能在一个已经活着的 Query 上调**。本模块刻意不提供
   「为了查上下文新开一个 query」的能力：生产并发上限是 1，起进程会把真正的
   聊天挡在门外。

   挂载点：runClaudeAgent 里 init 之后读一次，取得本轮开场附近的状态，且不跟
   Query 销毁抢时间。是否已包含本轮用户输入由 SDK 生命周期决定，不能擅自等同于
   「上一轮结束值」。

   ── 对外契约 ──
   ① `percent` 由**我们**从 totalTokens / maxTokens 算，不用 SDK 那个同名字段
      （它没有单位文档，而同一个坑今晚已经踩过一次——见下）
   ② 分类认 `categories[].kind`，不认 name（SDK 自己的注释：never on the English name）
   ③ 拿不到就是 available:false + reason，**不编造 0%**
   ============================================================ */

const CONTEXT_METHOD = 'getContextUsage';
const DEFAULT_STALE_MS = 15 * 60 * 1000;
const CATEGORY_KINDS = ['used', 'free', 'buffer', 'deferred'];

function nonNegativeOrNull(value) {
  return Number.isFinite(value) && value >= 0 ? value : null;
}

function positiveOrNull(value) {
  return Number.isFinite(value) && value > 0 ? value : null;
}

function percentOf(total, max) {
  if (total === null || max === null || max <= 0) return null;
  return Math.round((total / max) * 10000) / 100;
}

// 分类认 kind（SDK 的 kind 注释：'used' 占窗 / 'free' 剩余 / 'buffer' 压缩保留 / 'deferred' 窗外工具）
function normalizeCategories(raw) {
  if (!Array.isArray(raw)) return [];
  const out = [];
  for (const c of raw) {
    if (!c || typeof c !== 'object') continue;
    const kind = CATEGORY_KINDS.includes(c.kind) ? c.kind : null;
    const name = typeof c.name === 'string' ? c.name : null;
    if (!kind && !name) continue;
    out.push({ kind, name, tokens: nonNegativeOrNull(c.tokens) });
  }
  return out;
}

// 逐项 rows：只留名字与 token 数。
// 刻意**不带** memoryFiles[].path（文件路径不该出后端）、gridRows（那是 CLI 自己
// /context 网格图的渲染数据）、agents / slashCommands / skills（我们全关掉了，恒为空）。
function normalizeRows(raw, nameKeys = ['name']) {
  if (!Array.isArray(raw)) return [];
  const out = [];
  for (const r of raw) {
    if (!r || typeof r !== 'object') continue;
    let name = null;
    for (const k of nameKeys) {
      if (typeof r[k] === 'string' && r[k]) { name = r[k]; break; }
    }
    if (!name) continue;
    const row = { name, tokens: nonNegativeOrNull(r.tokens) };
    if (typeof r.type === 'string' && r.type) row.type = r.type;   // memoryFiles 用 type 替代 path
    if (typeof r.serverName === 'string' && r.serverName) row.serverName = r.serverName;
    if (typeof r.isLoaded === 'boolean') row.isLoaded = r.isLoaded;
    out.push(row);
  }
  return out;
}

// memoryFiles 的行用 `path` 而不是 `name` —— 曾经因为把两者混在一个 mapper 里，
// 结果整个数组被过滤成空（测试抓到的）。这里单独处理，并且**不要名字**：
// 有用的信号是「有几个、占多少 token」，不是它是哪个文件。
// （我们 settingSources: []，这个数组正常恒为空；这段是万一将来开了设置源的防御。）
function normalizeMemoryFiles(raw) {
  if (!Array.isArray(raw)) return [];
  const out = [];
  for (const f of raw) {
    if (!f || typeof f !== 'object') continue;
    out.push({
      type: typeof f.type === 'string' ? f.type : null,
      tokens: nonNegativeOrNull(f.tokens),
    });
  }
  return out;
}

function normalizeMessageBreakdown(raw) {
  if (!raw || typeof raw !== 'object') return null;
  const scalarKeys = [
    'toolCallTokens', 'toolResultTokens', 'attachmentTokens', 'assistantMessageTokens',
    'userMessageTokens', 'redirectedContextTokens', 'unattributedTokens',
  ];
  const out = {};
  for (const key of scalarKeys) out[key] = nonNegativeOrNull(raw[key]);
  out.toolCallsByType = Array.isArray(raw.toolCallsByType)
    ? raw.toolCallsByType
      .filter((row) => row && typeof row.name === 'string' && row.name)
      .map((row) => ({
        name: row.name,
        callTokens: nonNegativeOrNull(row.callTokens),
        resultTokens: nonNegativeOrNull(row.resultTokens),
      }))
    : [];
  out.attachmentsByType = Array.isArray(raw.attachmentsByType)
    ? raw.attachmentsByType
      .filter((row) => row && typeof row.name === 'string' && row.name)
      .map((row) => ({ name: row.name, tokens: nonNegativeOrNull(row.tokens) }))
    : [];
  return out;
}

function normalizeApiUsage(raw) {
  if (!raw || typeof raw !== 'object') return null;
  return {
    inputTokens: nonNegativeOrNull(raw.input_tokens),
    outputTokens: nonNegativeOrNull(raw.output_tokens),
    cacheCreationInputTokens: nonNegativeOrNull(raw.cache_creation_input_tokens),
    cacheReadInputTokens: nonNegativeOrNull(raw.cache_read_input_tokens),
  };
}

function normalizeContextUsage(raw, observedAt = new Date().toISOString()) {
  const total = nonNegativeOrNull(raw?.totalTokens);
  const max = positiveOrNull(raw?.maxTokens);
  const available = total !== null && max !== null;
  return {
    available,
    source: 'context_usage',
    usedTokens: total,
    maxTokens: max,
    rawMaxTokens: positiveOrNull(raw?.rawMaxTokens),
    // ⚠️ 由我们算，不用 raw.percentage ——
    // 那个字段**没有单位文档**，而今晚在 utilization 上刚被同一个坑绊过一次
    //（usage API 是 0–100、rate_limit_event 是 0–1，同一个字段名差 100 倍）。
    // 两个 token 数没有歧义，比值就没有歧义。
    percent: percentOf(total, max),
    // 保留 SDK 自己那个值，仅用于**首次实采时对账**：看它到底是 0–1 还是 0–100。
    // 对完账、心里有数了，这个字段就可以撤。
    sdkPercentage: nonNegativeOrNull(raw?.percentage),
    model: typeof raw?.model === 'string' ? raw.model : null,
    autoCompactThreshold: nonNegativeOrNull(raw?.autoCompactThreshold),
    // 缺字段代表 SDK 版本漂移/不支持，不等于「明确关闭」。
    isAutoCompactEnabled: typeof raw?.isAutoCompactEnabled === 'boolean'
      ? raw.isAutoCompactEnabled
      : null,
    categories: normalizeCategories(raw?.categories),
    mcpTools: normalizeRows(raw?.mcpTools),                                // 我们那 24 个沈晏工具
    systemPromptSections: normalizeRows(raw?.systemPromptSections),        // 人格 prompt 的分节
    memoryFiles: normalizeMemoryFiles(raw?.memoryFiles),                   // 只带 type+tokens，不带 path
    // 这些不是 CLI 渲染数据，而是下一阶段区分消息、工具、附件与缓存成本的关键观测。
    systemTools: normalizeRows(raw?.systemTools),
    deferredBuiltinTools: normalizeRows(raw?.deferredBuiltinTools),
    messageBreakdown: normalizeMessageBreakdown(raw?.messageBreakdown),
    apiUsage: normalizeApiUsage(raw?.apiUsage),
    reason: available ? null : 'invalid_snapshot',
    updatedAt: observedAt,
  };
}

function errorCode(error) {
  if (error?.code === 'CLAUDE_CONTEXT_TIMEOUT') return 'timeout';
  if (error?.code === 'CLAUDE_CONTEXT_UNSUPPORTED') return 'unsupported';
  return 'refresh_failed';
}

function createContextUsageCache({ now = () => Date.now(), staleMs = DEFAULT_STALE_MS } = {}) {
  let snapshot = null;
  let lastAttemptAt = null;
  let lastError = null;

  const isoNow = () => new Date(now()).toISOString();

  function observe(raw) {
    const at = isoNow();
    lastAttemptAt = at;
    lastError = null;
    snapshot = normalizeContextUsage(raw, at);
    return snapshot;
  }

  function recordFailure(error) {
    lastAttemptAt = isoNow();
    lastError = errorCode(error);
  }

  function getSnapshot() {
    if (!snapshot) {
      return {
        available: false,
        stale: true,
        source: null,
        usedTokens: null, maxTokens: null, rawMaxTokens: null, percent: null,
        sdkPercentage: null, model: null,
        autoCompactThreshold: null, isAutoCompactEnabled: null,
        categories: [], mcpTools: [], systemPromptSections: [], memoryFiles: [],
        systemTools: [], deferredBuiltinTools: [], messageBreakdown: null, apiUsage: null,
        reason: lastError || 'not_observed',
        updatedAt: null,
        lastAttemptAt,
      };
    }
    const age = Date.parse(snapshot.updatedAt);
    return {
      ...snapshot,
      // 已有成功快照后再失败：保留旧值，只标 stale —— 不把一份好数据清成 0
      stale: !Number.isFinite(age) || now() - age > staleMs,
      lastAttemptAt,
      lastError,
    };
  }

  return { getSnapshot, observe, recordFailure };
}

const contextUsageCache = createContextUsageCache();

/* 超时给得比额度那条宽（10s vs 2.5s）：2026-09-19 生产实测在 2.5s 上超时，
   而 reason 是 'timeout' 不是 'unsupported' —— 说明方法在、只是慢（它要遍历整个窗口，
   比额度那条重得多）。这条是 fire-and-forget、不阻塞聊天，所以等久一点没有代价。 */
const DEFAULT_TIMEOUT_MS = 10000;

async function refreshContextUsageFromQuery(agentQuery, { timeoutMs = DEFAULT_TIMEOUT_MS, cache = contextUsageCache } = {}) {
  const method = agentQuery?.[CONTEXT_METHOD];
  if (typeof method !== 'function') {
    const error = new Error('Claude Agent SDK context-usage API unavailable');
    error.code = 'CLAUDE_CONTEXT_UNSUPPORTED';
    cache.recordFailure(error);
    return false;
  }

  let timer;
  const startedAt = Date.now();
  try {
    // 同样不接受 signal（SDK 这两个 control 方法都没透传），只能调用方兜超时。
    const timeout = new Promise((_, reject) => {
      timer = setTimeout(() => {
        const error = new Error('Claude context-usage refresh timed out');
        error.code = 'CLAUDE_CONTEXT_TIMEOUT';
        reject(error);
      }, timeoutMs);
      timer.unref?.();
    });
    const raw = await Promise.race([
      method.call(agentQuery, { detail: 'summary' }),   // summary：不发逐类 token-count 调用，够用且更省
      timeout,
    ]);
    const snap = cache.observe(raw);
    // SDK 侧快照：summary 仍含本地估算；这里只把两个百分比并列做漂移对账。
    console.log(`🧠 [上下文占用] used=${snap.usedTokens}/${snap.maxTokens} 算得=${snap.percent}% SDK说的=${snap.sdkPercentage}`
      + ` autoCompact=${snap.isAutoCompactEnabled} 门槛=${snap.autoCompactThreshold ?? '—'} 工具类=${snap.mcpTools.length}项`
      + ` 耗时=${Date.now() - startedAt}ms`);
    return true;
  } catch (error) {
    cache.recordFailure(error);
    console.warn(`⚠️ [上下文占用] 读取失败（保留旧快照，不影响聊天）: ${error.message} 耗时=${Date.now() - startedAt}ms`);
    return false;
  } finally {
    clearTimeout(timer);
  }
}

module.exports = {
  createContextUsageCache,
  getClaudeContextSnapshot: () => contextUsageCache.getSnapshot(),
  normalizeContextUsage,
  refreshContextUsageFromQuery,
};
