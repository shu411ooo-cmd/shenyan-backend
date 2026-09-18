const test = require('node:test');
const assert = require('node:assert/strict');

const {
  createSupabaseSessionStore,
  entryRows,
  normalizeKey,
  sessionsEnabled,
} = require('../lib/claude-session-store');

function fakeSupabase(initial = []) {
  const rows = initial.map((row, index) => ({ id: index + 1, ...row }));
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
        select() {
          const filters = [];
          const query = {
            eq(field, value) { filters.push([field, value]); return query; },
            async order() {
              return {
                data: rows.filter((row) => filters.every(([field, value]) => row[field] === value))
                  .sort((a, b) => a.id - b.id)
                  .map((row) => ({ entry: row.entry })),
                error: null,
              };
            },
            async limit(count) {
              return {
                data: rows.filter((row) => filters.every(([field, value]) => row[field] === value))
                  .slice(0, count).map((row) => ({ id: row.id })),
                error: null,
              };
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
