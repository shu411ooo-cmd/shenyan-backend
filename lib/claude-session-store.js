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

module.exports = {
  TRANSCRIPT_TABLE,
  SESSION_LINKS_TABLE,
  clearSessionLink,
  createSupabaseSessionStore,
  entryRows,
  loadSessionLink,
  normalizeKey,
  saveSessionLink,
  sessionsEnabled,
};
