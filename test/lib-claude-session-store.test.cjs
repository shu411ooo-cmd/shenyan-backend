const test = require('node:test');
const assert = require('node:assert/strict');

const {
  createSupabaseSessionStore,
  entryRows,
  normalizeKey,
  pruneExpiredSessions,
  sessionRetentionMs,
  sessionsEnabled,
} = require('../lib/claude-session-store');

// 表名只用来分组，不改变行为：真实实现里两张表的列不重叠（session_id vs sdk_session_id），
// 所以单数组也能跑；分组是为了让断言能直接问「transcript 还剩什么」。
function fakeSupabase(initial = []) {
  const rows = initial.map((row, index) => ({ id: index + 1, ...row }));
  const matches = (row, filters) => filters.every(([op, field, value]) => {
    if (op === 'eq') return row[field] === value;
    if (op === 'lt') return row[field] != null && new Date(row[field]).getTime() < new Date(value).getTime();
    if (op === 'gte') return row[field] != null && new Date(row[field]).getTime() >= new Date(value).getTime();
    return false;
  });
  return {
    rows,
    from() {
      return {
        async upsert(input) {
          for (const row of input) {
            if (row.entry_uuid && rows.some((old) => old.project_key === row.project_key
              && old.session_id === row.session_id && old.subpath === row.subpath
              && old.entry_uuid === row.entry_uuid)) continue;
            rows.push({ id: rows.length + 1, ...row });
          }
          return { error: null };
        },
        select(columns = '*') {
          const filters = [];
          const fields = String(columns).split(',').map((name) => name.trim()).filter(Boolean);
          let limitCount = Infinity;
          const project = (row) => (fields.includes('*')
            ? { ...row }
            : fields.reduce((out, name) => {
              out[name] = row[name];
              return out;
            }, {}));
          const query = {
            eq(field, value) { filters.push(['eq', field, value]); return query; },
            lt(field, value) { filters.push(['lt', field, value]); return query; },
            gte(field, value) { filters.push(['gte', field, value]); return query; },
            order() { return query; },
            limit(count) { limitCount = count; return query; },
            then(resolve, reject) {
              return Promise.resolve({
                data: rows.filter((row) => matches(row, filters)).slice(0, limitCount).map(project),
                error: null,
              }).then(resolve, reject);
            },
          };
          return query;
        },
        delete() {
          const filters = [];
          const query = {
            eq(field, value) { filters.push(['eq', field, value]); return query; },
            lt(field, value) { filters.push(['lt', field, value]); return query; },
            async select() {
              const victims = rows.filter((row) => matches(row, filters));
              for (const victim of victims) rows.splice(rows.indexOf(victim), 1);
              return { data: victims.map((row) => ({ id: row.id })), error: null };
            },
          };
          return query;
        },
      };
    },
  };
}

test('SessionStore key normalization preserves main and subagent transcript identity', () => {
  assert.deepEqual(normalizeKey({ projectKey: 'garden', sessionId: 's1' }), {
    project_key: 'garden', session_id: 's1', subpath: '',
  });
  assert.deepEqual(normalizeKey({ projectKey: 'garden', sessionId: 's1', subpath: 'subagents/a' }), {
    project_key: 'garden', session_id: 's1', subpath: 'subagents/a',
  });
});

test('entryRows keeps opaque transcript payloads and UUID idempotency keys intact', () => {
  const entries = [{ type: 'user', uuid: 'u1', nested: { text: 'hi' } }, { type: 'tag' }];
  assert.deepEqual(entryRows({ projectKey: 'garden', sessionId: 's1' }, entries), [
    { project_key: 'garden', session_id: 's1', subpath: '', entry_uuid: 'u1', entry: entries[0] },
    { project_key: 'garden', session_id: 's1', subpath: '', entry_uuid: null, entry: entries[1] },
  ]);
});

test('Supabase SessionStore appends in order, deduplicates UUID entries, and loads null for misses', async () => {
  const sb = fakeSupabase();
  const store = createSupabaseSessionStore(sb);
  const key = { projectKey: 'garden', sessionId: 's1' };
  const first = { type: 'user', uuid: 'u1', message: 'hello' };
  const second = { type: 'assistant', uuid: 'u2', message: 'hi' };
  await store.append(key, [first, second]);
  await store.append(key, [first]);
  assert.deepEqual(await store.load(key), [first, second]);
  assert.equal(await store.hasSession('s1'), true);
  assert.equal(await store.load({ projectKey: 'garden', sessionId: 'missing' }), null);
});

test('native session toggle defaults on and supports an emergency off switch', () => {
  const before = process.env.CLAUDE_AGENT_SESSIONS_ENABLED;
  try {
    delete process.env.CLAUDE_AGENT_SESSIONS_ENABLED;
    assert.equal(sessionsEnabled(), true);
    process.env.CLAUDE_AGENT_SESSIONS_ENABLED = 'false';
    assert.equal(sessionsEnabled(), false);
  } finally {
    if (before === undefined) delete process.env.CLAUDE_AGENT_SESSIONS_ENABLED;
    else process.env.CLAUDE_AGENT_SESSIONS_ENABLED = before;
  }
});

test('sessionRetentionMs defaults to 90 days and returns null when disabled', () => {
  assert.equal(sessionRetentionMs({}), 90 * 24 * 60 * 60 * 1000);
  assert.equal(sessionRetentionMs({ CLAUDE_AGENT_SESSION_RETENTION_DAYS: '0' }), null);
  assert.equal(sessionRetentionMs({ CLAUDE_AGENT_SESSION_RETENTION_DAYS: '-5' }), null);
  assert.equal(sessionRetentionMs({ CLAUDE_AGENT_SESSION_RETENTION_DAYS: 'abc' }), null);
  assert.equal(sessionRetentionMs({ CLAUDE_AGENT_SESSION_RETENTION_DAYS: '30' }), 30 * 24 * 60 * 60 * 1000);
  assert.equal(sessionRetentionMs({ CLAUDE_AGENT_SESSION_RETENTION_DAYS: '1000' }), 1000 * 24 * 60 * 60 * 1000);
});

// 语义 = 会话级（见下一条回归测试）。这里守的是最朴素的一档：整条都安静的会话被收掉，
// 还有近期活动的会话一个字节都不动，计数如实回报。
test('pruneExpiredSessions removes a fully quiet session and keeps one with recent activity', async () => {
  const old = '2026-06-01T00:00:00Z';
  const fresh = '2026-09-15T00:00:00Z';
  const sb = fakeSupabase([
    { project_key: 'garden', session_id: 'dead', subpath: '', created_at: old, entry: { type: 'user', uuid: 'a1' } },
    { project_key: 'garden', session_id: 'dead', subpath: '', created_at: old, entry: { type: 'assistant', uuid: 'a2' } },
    { project_key: 'garden', session_id: 'alive', subpath: '', created_at: fresh, entry: { type: 'user', uuid: 'b1' } },
  ]);
  sb.rows.push({ id: 100, app_session_id: 'old-app', sdk_session_id: 'dead', model: 'x', updated_at: old });
  sb.rows.push({ id: 101, app_session_id: 'active-app', sdk_session_id: 'alive', model: 'x', updated_at: fresh });

  const pruned = await pruneExpiredSessions(sb, { cutoff: new Date('2026-09-01T00:00:00Z') });

  assert.deepEqual(pruned, { transcripts: 2, links: 1 });
  assert.equal(sb.rows.length, 2);
  assert.equal(sb.rows.some((row) => row.session_id === 'dead'), false);
  assert.equal(sb.rows.some((row) => row.app_session_id === 'old-app'), false);
  assert.equal(sb.rows.some((row) => row.session_id === 'alive'), true);
  assert.equal(sb.rows.some((row) => row.app_session_id === 'active-app'), true);
});

// 回归：前端把所有 session 连成一条线，单个 app session 可以活过保留期 —— 它的 transcript
// 天然「头旧尾新」。按行删会把它从中间截断，而 hasSession 仍为 true，此后每轮都拿一份
// 断头 transcript 去 resume。保留期的单位必须是会话，不是行。
test('pruneExpiredSessions never truncates a still-active long session (old head, fresh tail)', async () => {
  const old = '2026-06-01T00:00:00Z';
  const fresh = '2026-09-15T00:00:00Z';
  const sb = fakeSupabase([
    { project_key: 'garden', session_id: 'long', subpath: '', created_at: old, entry: { uuid: 'h1' } },
    { project_key: 'garden', session_id: 'long', subpath: '', created_at: old, entry: { uuid: 'h2' } },
    { project_key: 'garden', session_id: 'long', subpath: '', created_at: fresh, entry: { uuid: 't1' } },
    { project_key: 'garden', session_id: 'quiet', subpath: '', created_at: old, entry: { uuid: 'q1' } },
  ]);
  sb.rows.push({ id: 200, app_session_id: 'main', sdk_session_id: 'long', model: 'x', updated_at: fresh });
  sb.rows.push({ id: 201, app_session_id: 'gone', sdk_session_id: 'quiet', model: 'x', updated_at: old });

  const pruned = await pruneExpiredSessions(sb, { cutoff: new Date('2026-09-01T00:00:00Z') });

  assert.deepEqual(pruned, { transcripts: 1, links: 1 });
  assert.equal(sb.rows.filter((row) => row.session_id === 'long').length, 3);
  assert.equal(sb.rows.some((row) => row.session_id === 'quiet'), false);
  assert.equal(sb.rows.some((row) => row.app_session_id === 'main'), true);
  assert.equal(sb.rows.some((row) => row.app_session_id === 'gone'), false);
});

// 悬空映射：transcript 早已不在，link 却还在（mirror 半途失败 / 手工清过表）。
// 它进不了「会话级」那条路径（没有 transcript 行就没有候选），必须单独收掉。
test('pruneExpiredSessions clears a stale link whose transcript is already gone', async () => {
  const sb = fakeSupabase();
  sb.rows.push({ id: 300, app_session_id: 'orphan', sdk_session_id: 'vanished', model: 'x', updated_at: '2026-06-01T00:00:00Z' });

  const pruned = await pruneExpiredSessions(sb, { cutoff: new Date('2026-09-01T00:00:00Z') });

  assert.deepEqual(pruned, { transcripts: 0, links: 1 });
  assert.equal(sb.rows.length, 0);
});

test('pruneExpiredSessions rejects missing/invalid cutoff and missing client', async () => {
  const sb = fakeSupabase();
  await assert.rejects(() => pruneExpiredSessions(sb, {}), /cutoff/);
  await assert.rejects(() => pruneExpiredSessions(sb, { cutoff: 'not-a-date' }), /cutoff/);
  await assert.rejects(() => pruneExpiredSessions(null, { cutoff: new Date() }), /Supabase/);
});
