/* ============================================================
   Claude 订阅额度快照

   额度只能从一条已经活着的 Agent Query 读取。这里刻意不提供“为了查额度
   新开 query”的能力：当前生产并发上限是 1，若 Usage 页刷新就起进程，会把
   真正的聊天挡在门外。

   对外只暴露归一后的 last-known-good；实验性 SDK 字段被隔离在本文件。
   ============================================================ */

const USAGE_METHOD = 'usage_EXPERIMENTAL_MAY_CHANGE_DO_NOT_RELY_ON_THIS_API_YET';
const DEFAULT_STALE_MS = 15 * 60 * 1000;
const PLAN_WINDOWS = [
  'five_hour',
  'seven_day',
  'seven_day_oauth_apps',
  'seven_day_opus',
  'seven_day_sonnet',
];

function finiteOrNull(value) {
  return Number.isFinite(value) ? value : null;
}

function resetToIso(value) {
  if (typeof value === 'string') {
    const ms = Date.parse(value);
    return Number.isFinite(ms) ? new Date(ms).toISOString() : null;
  }
  if (!Number.isFinite(value)) return null;
  // SDK rate_limit_event 用 epoch number；兼容秒与毫秒两种形状。
  const ms = value < 1e12 ? value * 1000 : value;
  const date = new Date(ms);
  return Number.isFinite(date.getTime()) ? date.toISOString() : null;
}

function normalizeWindow(id, raw, extra = {}) {
  if (!raw || typeof raw !== 'object') return null;
  return {
    id,
    scope: extra.scope || 'plan',
    displayName: extra.displayName || null,
    utilization: finiteOrNull(raw.utilization),
    resetsAt: resetToIso(raw.resets_at ?? raw.resetsAt),
    status: typeof raw.status === 'string' ? raw.status : null,
  };
}

function normalizeExtraUsage(raw) {
  if (!raw || typeof raw !== 'object') return null;
  return {
    enabled: raw.is_enabled === true,
    monthlyLimit: finiteOrNull(raw.monthly_limit),
    usedCredits: finiteOrNull(raw.used_credits),
    utilization: finiteOrNull(raw.utilization),
    currency: typeof raw.currency === 'string' ? raw.currency : null,
  };
}

function normalizeQuotaUsage(raw, observedAt = new Date().toISOString()) {
  const limits = raw?.rate_limits && typeof raw.rate_limits === 'object'
    ? raw.rate_limits
    : null;
  const windows = [];
  if (limits) {
    for (const id of PLAN_WINDOWS) {
      const window = normalizeWindow(id, limits[id]);
      if (window) windows.push(window);
    }
    if (Array.isArray(limits.model_scoped)) {
      for (const item of limits.model_scoped) {
        const name = String(item?.display_name || '').trim();
        if (!name) continue;
        const window = normalizeWindow(`model:${name}`, item, { scope: 'model', displayName: name });
        if (window) windows.push(window);
      }
    }
  }

  const available = raw?.rate_limits_available === true && limits !== null;
  return {
    available,
    source: 'usage',
    subscriptionType: typeof raw?.subscription_type === 'string' ? raw.subscription_type : null,
    windows,
    extraUsage: normalizeExtraUsage(limits?.extra_usage),
    reason: available ? null : 'rate_limits_unavailable',
    updatedAt: observedAt,
  };
}

function errorCode(error) {
  if (error?.code === 'CLAUDE_QUOTA_TIMEOUT') return 'timeout';
  if (error?.code === 'CLAUDE_QUOTA_UNSUPPORTED') return 'unsupported';
  return 'refresh_failed';
}

function createQuotaCache({ now = () => Date.now(), staleMs = DEFAULT_STALE_MS } = {}) {
  let snapshot = null;
  let lastAttemptAt = null;
  let lastError = null;

  const isoNow = () => new Date(now()).toISOString();

  function observeUsage(raw) {
    const at = isoNow();
    lastAttemptAt = at;
    lastError = null;
    snapshot = normalizeQuotaUsage(raw, at);
    return snapshot;
  }

  function observeRateLimit(info) {
    if (!info || typeof info !== 'object') return snapshot;
    const id = typeof info.rateLimitType === 'string' && info.rateLimitType
      ? info.rateLimitType
      : 'unknown';
    const window = normalizeWindow(id, info);
    if (!window) return snapshot;

    const at = isoNow();
    const previous = snapshot?.windows || [];
    const windows = [...previous.filter((item) => item.id !== id), window];
    lastAttemptAt = at;
    lastError = null;
    snapshot = {
      available: true,
      source: 'rate_limit_event',
      subscriptionType: snapshot?.subscriptionType || null,
      windows,
      extraUsage: snapshot?.extraUsage || null,
      reason: null,
      updatedAt: at,
    };
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
        subscriptionType: null,
        windows: [],
        extraUsage: null,
        reason: lastError || 'not_observed',
        updatedAt: null,
        lastAttemptAt,
      };
    }
    const age = Date.parse(snapshot.updatedAt);
    return {
      ...snapshot,
      stale: !Number.isFinite(age) || now() - age > staleMs,
      lastAttemptAt,
      lastError,
    };
  }

  return { getSnapshot, observeRateLimit, observeUsage, recordFailure };
}

const quotaCache = createQuotaCache();

async function refreshClaudeQuotaFromQuery(agentQuery, { timeoutMs = 2500, cache = quotaCache } = {}) {
  const method = agentQuery?.[USAGE_METHOD];
  if (typeof method !== 'function') {
    const error = new Error('Claude Agent SDK quota API unavailable');
    error.code = 'CLAUDE_QUOTA_UNSUPPORTED';
    cache.recordFailure(error);
    return false;
  }

  let timer;
  try {
    const timeout = new Promise((_, reject) => {
      timer = setTimeout(() => {
        const error = new Error('Claude quota refresh timed out');
        error.code = 'CLAUDE_QUOTA_TIMEOUT';
        reject(error);
      }, timeoutMs);
      timer.unref?.();
    });
    const raw = await Promise.race([
      method.call(agentQuery, { skipBehaviors: true }),
      timeout,
    ]);
    cache.observeUsage(raw);
    return true;
  } catch (error) {
    cache.recordFailure(error);
    return false;
  } finally {
    clearTimeout(timer);
  }
}

module.exports = {
  createQuotaCache,
  getClaudeQuotaSnapshot: () => quotaCache.getSnapshot(),
  normalizeQuotaUsage,
  observeClaudeRateLimit: (info) => quotaCache.observeRateLimit(info),
  refreshClaudeQuotaFromQuery,
};
