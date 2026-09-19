const { test } = require('node:test');
const assert = require('node:assert');

const {
  compactContextSnapshot,
  compactQuotaSnapshot,
  mergeRequestObservation,
  observationStatColumns,
} = require('../lib/request-observation');

test('额度快照只落窗口数字，不泄露 SDK 附带对象', () => {
  const out = compactQuotaSnapshot({
    available: true,
    stale: false,
    source: 'usage',
    subscriptionType: 'pro',
    windows: [{ id: 'five_hour', scope: 'plan', utilization: 42.5, resetsAt: '2026-09-19T10:00:00Z', status: 'allowed' }],
    updatedAt: '2026-09-19T09:00:00Z',
    secret: 'do-not-store',
  });
  assert.equal(out.windows[0].utilization, 42.5);
  assert.equal(out.secret, undefined);
  assert.equal(JSON.stringify(out).includes('do-not-store'), false);
});

test('上下文快照保留总量和类别，不落工具清单与文件路径', () => {
  const out = compactContextSnapshot({
    available: true, stale: false, usedTokens: 37090, maxTokens: 200000, percent: 18.55,
    model: 'claude-sonnet-4-6', autoCompactThreshold: 167000, isAutoCompactEnabled: true,
    categories: [{ kind: 'used', name: 'Messages', tokens: 30655 }],
    mcpTools: [{ name: 'mcp__shenyan__hold', tokens: 200 }],
    memoryFiles: [{ path: 'C:/secret/CLAUDE.md', tokens: 100 }],
  });
  assert.equal(out.usedTokens, 37090);
  assert.deepStrictEqual(out.categories, [{ kind: 'used', name: 'Messages', tokens: 30655 }]);
  assert.equal(out.mcpTools, undefined);
  assert.equal(JSON.stringify(out).includes('CLAUDE.md'), false);
});

test('账本列明确区分实际线路、SDK mode 与 fork', () => {
  const row = observationStatColumns({
    transport: 'claude-subscription', transportReason: null,
    agentSessionMode: 'resume', agentForked: false,
    contextSnapshot: { available: true, usedTokens: 1, maxTokens: 10, percent: 10 },
    quotaBefore: { available: false, reason: 'not_observed', windows: [] },
    quotaAfter: { available: true, source: 'usage', windows: [{ id: 'five_hour', utilization: 9 }] },
  });
  assert.equal(row.transport, 'claude-subscription');
  assert.equal(row.agent_session_mode, 'resume');
  assert.equal(row.agent_forked, false);
  assert.equal(row.claude_context_snapshot.percent, 10);
  assert.equal(row.claude_quota_after.windows[0].utilization, 9);
});

test('异步观测失败时仍保住同步线路字段', async () => {
  const out = await mergeRequestObservation(
    { transport: 'api', transportReason: 'images_unsupported' },
    Promise.reject(new Error('telemetry failed')),
  );
  assert.deepStrictEqual(out, { transport: 'api', transportReason: 'images_unsupported' });
});
