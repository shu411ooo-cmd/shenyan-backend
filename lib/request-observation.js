/* ============================================================
   每轮请求的线路 / Agent SDK 观测摘要

   这里刻意只接收已经归一、去敏的 quota/context DTO，再压成适合落
   request_stats 的小快照。不要把 SDK 原对象、session id、消息正文或工具结果
   放进账本。
   ============================================================ */

function finiteOrNull(value) {
  return Number.isFinite(value) ? value : null;
}

function stringOrNull(value) {
  return typeof value === 'string' && value ? value : null;
}

function compactQuotaSnapshot(raw) {
  if (!raw || typeof raw !== 'object') return null;
  return {
    available: raw.available === true,
    stale: raw.stale === true,
    source: stringOrNull(raw.source),
    subscriptionType: stringOrNull(raw.subscriptionType),
    windows: Array.isArray(raw.windows)
      ? raw.windows.map((window) => ({
        id: stringOrNull(window?.id),
        scope: stringOrNull(window?.scope),
        utilization: finiteOrNull(window?.utilization),
        resetsAt: stringOrNull(window?.resetsAt),
        status: stringOrNull(window?.status),
      })).filter((window) => window.id)
      : [],
    reason: stringOrNull(raw.reason),
    updatedAt: stringOrNull(raw.updatedAt),
    lastError: stringOrNull(raw.lastError),
  };
}

function compactContextSnapshot(raw) {
  if (!raw || typeof raw !== 'object') return null;
  return {
    available: raw.available === true,
    stale: raw.stale === true,
    usedTokens: finiteOrNull(raw.usedTokens),
    maxTokens: finiteOrNull(raw.maxTokens),
    percent: finiteOrNull(raw.percent),
    model: stringOrNull(raw.model),
    autoCompactThreshold: finiteOrNull(raw.autoCompactThreshold),
    isAutoCompactEnabled: typeof raw.isAutoCompactEnabled === 'boolean'
      ? raw.isAutoCompactEnabled
      : null,
    categories: Array.isArray(raw.categories)
      ? raw.categories.map((category) => ({
        kind: stringOrNull(category?.kind),
        name: stringOrNull(category?.name),
        tokens: finiteOrNull(category?.tokens),
      }))
      : [],
    reason: stringOrNull(raw.reason),
    updatedAt: stringOrNull(raw.updatedAt),
    lastError: stringOrNull(raw.lastError),
  };
}

async function mergeRequestObservation(base, deferred) {
  let extra = null;
  try {
    extra = await Promise.resolve(deferred);
  } catch {
    // 观测失败不能让一次成功聊天丢账；线路等同步字段仍照常落库。
  }
  return { ...(base || {}), ...(extra || {}) };
}

function observationStatColumns(raw) {
  const observation = raw && typeof raw === 'object' ? raw : {};
  return {
    transport: stringOrNull(observation.transport),
    transport_reason: stringOrNull(observation.transportReason),
    agent_session_mode: stringOrNull(observation.agentSessionMode),
    agent_forked: typeof observation.agentForked === 'boolean' ? observation.agentForked : null,
    claude_context_snapshot: compactContextSnapshot(observation.contextSnapshot),
    claude_quota_before: compactQuotaSnapshot(observation.quotaBefore),
    claude_quota_after: compactQuotaSnapshot(observation.quotaAfter),
  };
}

module.exports = {
  compactContextSnapshot,
  compactQuotaSnapshot,
  mergeRequestObservation,
  observationStatColumns,
};
