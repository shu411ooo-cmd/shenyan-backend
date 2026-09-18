/* ============================================================
   Durable Claude Agent SDK sessions

   The Agent SDK owns its opaque transcript format. This adapter mirrors
   those JSONL entries to Supabase and maps one app session to one SDK
   session. Application messages/memory remain the source of truth.
   ============================================================ */

const SESSION_LINKS_TABLE = 'claude_agent_session_links';
const TRANSCRIPT_TABLE = 'claude_agent_transcript_entries';

function sessionsEnabled() {
  return String(process.env.CLAUDE_AGENT_SESSIONS_ENABLED || 'true').toLowerCase() !== 'false';
}

function normalizeKey(key) {
  return {
    project_key: String(key?.projectKey || ''),
    session_id: String(key?.sessionId || ''),
    subpath: key?.subpath == null ? '' : String(key.subpath),
  };
}

function entryRows(key, entries) {
  const base = normalizeKey(key);
  return (Array.isArray(entries) ? entries : []).map((entry) => ({
    ...base,
    entry_uuid: typeof entry?.uuid === 'string' && entry.uuid ? entry.uuid : null,
    entry,
  }));
}

function createSupabaseSessionStore(supabase) {
  if (!supabase) throw new Error('Claude SessionStore 缺少 Supabase client');

  return {
    async append(key, entries) {
      const rows = entryRows(key, entries);
      if (!rows.length) return;
      const { error } = await supabase
        .from(TRANSCRIPT_TABLE)
        .upsert(rows, {
          onConflict: 'project_key,session_id,subpath,entry_uuid',
          ignoreDuplicates: true,
        });
      if (error) throw new Error(`Claude transcript append 失败: ${error.message}`);
    },

    async load(key) {
      const normalized = normalizeKey(key);
      const { data, error } = await supabase
        .from(TRANSCRIPT_TABLE)
        .select('entry')
        .eq('project_key', normalized.project_key)
        .eq('session_id', normalized.session_id)
        .eq('subpath', normalized.subpath)
        .order('id', { ascending: true });
      if (error) throw new Error(`Claude transcript load 失败: ${error.message}`);
      if (!data?.length) return null;
      return data.map((row) => row.entry);
    },

    // App-side preflight: do not start a resume query when the durable copy is
    // already missing. Runtime resume failures are deliberately not retried,
    // because a tool may have produced side effects before an error surfaces.
    async hasSession(sessionId) {
      const { data, error } = await supabase
        .from(TRANSCRIPT_TABLE)
        .select('id')
        .eq('session_id', String(sessionId || ''))
        .eq('subpath', '')
        .limit(1);
      if (error) throw new Error(`Claude transcript preflight 失败: ${error.message}`);
      return Boolean(data?.length);
    },
  };
}

async function loadSessionLink(supabase, appSessionId) {
  if (!sessionsEnabled()) return null;
  const { data, error } = await supabase
    .from(SESSION_LINKS_TABLE)
    .select('sdk_session_id, model')
    .eq('app_session_id', String(appSessionId))
    .maybeSingle();
  if (error) throw new Error(`Claude session link load 失败: ${error.message}`);
  return data || null;
}

async function saveSessionLink(supabase, appSessionId, sdkSessionId, model) {
  if (!sessionsEnabled() || !sdkSessionId) return;
  const { error } = await supabase.from(SESSION_LINKS_TABLE).upsert({
    app_session_id: String(appSessionId),
    sdk_session_id: String(sdkSessionId),
    model: String(model || ''),
    updated_at: new Date().toISOString(),
  }, { onConflict: 'app_session_id' });
  if (error) throw new Error(`Claude session link save 失败: ${error.message}`);
}

async function clearSessionLink(supabase, appSessionId) {
  if (!sessionsEnabled()) return;
  const { error } = await supabase
    .from(SESSION_LINKS_TABLE)
    .delete()
    .eq('app_session_id', String(appSessionId));
  if (error) throw new Error(`Claude session link clear 失败: ${error.message}`);
}

// 保留期（毫秒）：CLAUDE_AGENT_SESSION_RETENTION_DAYS，默认 90 天；0/负数/非法 → null（不清理）。
// transcript 与 link 都是「可重建的续接缓存」：过期即删，下轮自动 fresh 重建（优雅降级路径）。
// 口径 = 会话最后活动时间（不是条目年龄）：只收「整条会话都安静了这么久」的，见 pruneExpiredSessions。
function sessionRetentionMs(env = process.env) {
  const raw = env.CLAUDE_AGENT_SESSION_RETENTION_DAYS;
  if (raw == null || String(raw).trim() === '') return 90 * 24 * 60 * 60 * 1000;
  const days = Number.parseInt(String(raw), 10);
  if (!Number.isFinite(days) || days <= 0) return null;
  return days * 24 * 60 * 60 * 1000;
}

// 一次 tick 最多扫多少条旧条目 / 确认多少个会话。清理跑在 15 分钟循环里，
// 必须是有界的：宁可分多次 tick 慢慢收，也不能让一次清理拖住事件循环。
const PRUNE_SCAN_LIMIT = 500;
const PRUNE_MAX_SESSIONS = 50;

// 按最后活动时间清理过期 transcript 与 session link，返回各自删除行数。
//
// ⚠️ 保留期的单位是**会话**，不是行。不能直接按 created_at 删行：
//    前端把「所有 session 连成一条线、永不新建 id」，所以单个 app session 可以活过保留期——
//    它的 transcript 天然是「头旧尾新」。按行删会把这份 transcript 从中间截断，
//    而 hasSession 只看「还有没有行」仍返回 true，于是此后每一轮都拿一份**断头**
//    transcript 去 resume（SDK 的 parentUuid 链根缺失），既没报错也没降级，最难查。
//    所以：只有「整个会话都没有不早于 cutoff 的条目」时，才整会话删干净。
async function pruneExpiredSessions(supabase, { cutoff, maxSessions = PRUNE_MAX_SESSIONS } = {}) {
  if (!supabase) throw new Error('Claude SessionStore 缺少 Supabase client');
  if (!(cutoff instanceof Date) || Number.isNaN(cutoff.getTime())) {
    throw new Error('Claude SessionStore 清理需要合法的 cutoff 日期');
  }
  const since = cutoff.toISOString();

  // ① 候选：至少有一条早于 cutoff 的条目（按最旧在前，先收最该收的）。
  const { data: staleRows, error: scanError } = await supabase
    .from(TRANSCRIPT_TABLE)
    .select('project_key, session_id, created_at')
    .lt('created_at', since)
    .order('created_at', { ascending: true })
    .limit(PRUNE_SCAN_LIMIT);
  if (scanError) throw new Error(`Claude transcript 清理扫描失败: ${scanError.message}`);

  const candidates = [];
  const seen = new Set();
  for (const row of Array.isArray(staleRows) ? staleRows : []) {
    const key = JSON.stringify([row.project_key, row.session_id]);
    if (seen.has(key)) continue;
    seen.add(key);
    candidates.push({ projectKey: String(row.project_key), sessionId: String(row.session_id) });
    if (candidates.length >= maxSessions) break;
  }

  // ② 逐个确认「整个会话都过期」：只要还剩一条不早于 cutoff 的条目就不动它（活跃长会话走这条）。
  const expired = [];
  for (const key of candidates) {
    const { data, error } = await supabase
      .from(TRANSCRIPT_TABLE)
      .select('id')
      .eq('project_key', key.projectKey)
      .eq('session_id', key.sessionId)
      .gte('created_at', since)
      .limit(1);
    if (error) throw new Error(`Claude transcript 清理确认失败: ${error.message}`);
    if (!data?.length) expired.push(key);
  }

  // ③ 整会话删干净：transcript 全量 + 指向它的 link（一起删，不留悬空映射）。
  let transcripts = 0;
  let links = 0;
  for (const key of expired) {
    const removed = await supabase
      .from(TRANSCRIPT_TABLE)
      .delete()
      .eq('project_key', key.projectKey)
      .eq('session_id', key.sessionId)
      .select('id');
    if (removed.error) throw new Error(`Claude transcript 清理失败: ${removed.error.message}`);
    transcripts += Array.isArray(removed.data) ? removed.data.length : 0;

    const unlinked = await supabase
      .from(SESSION_LINKS_TABLE)
      .delete()
      .eq('sdk_session_id', key.sessionId)
      .select('id');
    if (unlinked.error) throw new Error(`Claude session link 清理失败: ${unlinked.error.message}`);
    links += Array.isArray(unlinked.data) ? unlinked.data.length : 0;
  }

  // ④ 悬空 link：映射还在、可它的 transcript 早已不在（mirror 半途失败、手工清过表）。
  //    这类 link 永远进不了 ①（没有 transcript 行就没有候选），只能单独按年龄收掉。
  const { data: staleLinks, error: linkScanError } = await supabase
    .from(SESSION_LINKS_TABLE)
    .select('id, sdk_session_id')
    .lt('updated_at', since)
    .limit(maxSessions);
  if (linkScanError) throw new Error(`Claude session link 清理扫描失败: ${linkScanError.message}`);
  for (const link of Array.isArray(staleLinks) ? staleLinks : []) {
    const alive = await supabase
      .from(TRANSCRIPT_TABLE)
      .select('id')
      .eq('session_id', String(link.sdk_session_id))
      .limit(1);
    if (alive.error) throw new Error(`Claude session link 清理确认失败: ${alive.error.message}`);
    if (alive.data?.length) continue; // transcript 还在 → 交给 ③ 按会话年龄裁决
    const removed = await supabase.from(SESSION_LINKS_TABLE).delete().eq('id', link.id).select('id');
    if (removed.error) throw new Error(`Claude session link 清理失败: ${removed.error.message}`);
    links += Array.isArray(removed.data) ? removed.data.length : 0;
  }

  return { transcripts, links };
}

module.exports = {
  TRANSCRIPT_TABLE,
  SESSION_LINKS_TABLE,
  clearSessionLink,
  createSupabaseSessionStore,
  entryRows,
  loadSessionLink,
  normalizeKey,
  pruneExpiredSessions,
  saveSessionLink,
  sessionRetentionMs,
  sessionsEnabled,
};
