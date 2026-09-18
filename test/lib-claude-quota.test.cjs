const { test } = require('node:test');
const assert = require('node:assert');

const {
  createQuotaCache,
  normalizeQuotaUsage,
  refreshClaudeQuotaFromQuery,
} = require('../lib/claude-quota');

test('usage 响应归一成稳定窗口，不把实验性 SDK 原对象直接递给前端', () => {
  const out = normalizeQuotaUsage({
    subscription_type: 'pro',
    rate_limits_available: true,
    rate_limits: {
      five_hour: { utilization: 42.5, resets_at: '2026-09-18T20:00:00Z' },
      seven_day: { utilization: 17, resets_at: '2026-09-22T00:00:00Z' },
      model_scoped: [{ display_name: 'Fable', utilization: 8, resets_at: null }],
      extra_usage: { is_enabled: true, monthly_limit: 20, used_credits: 3.5, utilization: 17.5, currency: 'USD' },
    },
    behaviors: { should_not: 'leak' },
    session: { total_cost_usd: 99 },
  }, '2026-09-18T19:00:00.000Z');

  assert.equal(out.available, true);
  assert.equal(out.subscriptionType, 'pro');
  assert.deepStrictEqual(out.windows.map((w) => w.id), ['five_hour', 'seven_day', 'model:Fable']);
  assert.equal(out.windows[0].utilization, 42.5);
  assert.equal(out.windows[0].resetsAt, '2026-09-18T20:00:00.000Z');
  assert.deepStrictEqual(out.extraUsage, {
    enabled: true, monthlyLimit: 20, usedCredits: 3.5, utilization: 17.5, currency: 'USD',
  });
  assert.equal('session' in out, false);
  assert.equal('behaviors' in out, false);
});

test('API key / scope 不足时是 available:false，不伪造 0% 额度', () => {
  const out = normalizeQuotaUsage({
    subscription_type: null,
    rate_limits_available: false,
    rate_limits: null,
  });
  assert.equal(out.available, false);
  assert.equal(out.reason, 'rate_limits_unavailable');
  assert.deepStrictEqual(out.windows, []);
});

test('last-known-good：刷新失败不抹掉旧快照，只留下失败状态', () => {
  let now = Date.parse('2026-09-18T19:00:00Z');
  const cache = createQuotaCache({ now: () => now, staleMs: 60_000 });
  cache.observeUsage({
    subscription_type: 'pro', rate_limits_available: true,
    rate_limits: { five_hour: { utilization: 12, resets_at: null } },
  });
  cache.recordFailure(Object.assign(new Error('secret upstream text'), { code: 'CLAUDE_QUOTA_TIMEOUT' }));
  const stillGood = cache.getSnapshot();
  assert.equal(stillGood.available, true);
  assert.equal(stillGood.windows[0].utilization, 12);
  assert.equal(stillGood.lastError, 'timeout');
  assert.equal(JSON.stringify(stillGood).includes('secret upstream text'), false);

  now += 61_000;
  assert.equal(cache.getSnapshot().stale, true);
});

test('rate_limit_event 按窗口合并，并兼容秒级 epoch reset', () => {
  const now = Date.parse('2026-09-18T19:00:00Z');
  const cache = createQuotaCache({ now: () => now });
  cache.observeUsage({
    subscription_type: 'max', rate_limits_available: true,
    rate_limits: { seven_day: { utilization: 10, resets_at: null } },
  });
  cache.observeRateLimit({
    rateLimitType: 'five_hour', status: 'allowed_warning', utilization: 91,
    resetsAt: Date.parse('2026-09-18T20:00:00Z') / 1000,
  });
  const out = cache.getSnapshot();
  assert.equal(out.source, 'rate_limit_event');
  assert.equal(out.subscriptionType, 'max');
  assert.equal(out.windows.find((w) => w.id === 'five_hour').status, 'allowed_warning');
  assert.equal(out.windows.find((w) => w.id === 'five_hour').resetsAt, '2026-09-18T20:00:00.000Z');
  assert.equal(out.windows.find((w) => w.id === 'seven_day').utilization, 10);
});

test('额度刷新复用现有 Query，并强制 skipBehaviors 避免扫七天 transcript', async () => {
  const cache = createQuotaCache();
  let received = null;
  const query = {
    async usage_EXPERIMENTAL_MAY_CHANGE_DO_NOT_RELY_ON_THIS_API_YET(opts) {
      received = opts;
      return {
        subscription_type: 'pro', rate_limits_available: true,
        rate_limits: { five_hour: { utilization: 5, resets_at: null } },
      };
    },
  };
  assert.equal(await refreshClaudeQuotaFromQuery(query, { cache, timeoutMs: 50 }), true);
  assert.deepStrictEqual(received, { skipBehaviors: true });
  assert.equal(cache.getSnapshot().windows[0].utilization, 5);
});

test('SDK 没有实验方法时优雅降级，不创建任何替代 Query', async () => {
  const cache = createQuotaCache();
  assert.equal(await refreshClaudeQuotaFromQuery({}, { cache, timeoutMs: 10 }), false);
  const out = cache.getSnapshot();
  assert.equal(out.available, false);
  assert.equal(out.reason, 'unsupported');
  assert.equal(out.updatedAt, null);
});
