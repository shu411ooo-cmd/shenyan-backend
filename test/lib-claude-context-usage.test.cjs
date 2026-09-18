// ===== lib/claude-context-usage.js 单元测试（node:test）=====
//
// 这条链读的是 SDK 的 getContextUsage()——订阅线上**真实**的上下文窗口占用，
// 用来替掉应用层那套 24k 预算估算（后者只描述我们自己组装的那一份，不是他的记忆）。
//
// 这里钉三件对外承诺：
//   ① percent 由我们从两个 token 数自己算，**不采信** SDK 那个同名字段
//   ② 分类认 kind，不认 name
//   ③ 拿不到就是 null / available:false，绝不编造 0

const { test } = require('node:test');
const assert = require('node:assert');

const { createContextUsageCache, normalizeContextUsage, refreshContextUsageFromQuery } = require('../lib/claude-context-usage.js');

const OBSERVED_AT = '2026-09-19T00:00:00.000Z';

/** 一份贴近真实形状的响应（字段名照 sdk.d.ts 的 SDKControlGetContextUsageResponse） */
function sampleRaw(over = {}) {
  return {
    totalTokens: 48000,
    maxTokens: 160000,
    rawMaxTokens: 200000,
    percentage: 0.3,                 // ← 故意给一个"小数刻度"的值，看我们会不会照抄
    model: 'claude-sonnet-4-6',
    autoCompactThreshold: 128000,
    isAutoCompactEnabled: true,
    categories: [
      { name: 'Used', tokens: 48000, color: '#abc', kind: 'used' },
      { name: 'Free space', tokens: 80000, color: '#def', kind: 'free' },
      { name: 'Compact buffer', tokens: 32000, color: '#fed', kind: 'buffer' },
      { name: 'Deferred tools', tokens: 4200, color: '#ghi', kind: 'deferred', isDeferred: true },
    ],
    gridRows: [[{ color: '#abc', isFilled: true, categoryName: 'Used', tokens: 100, percentage: 1, squareFullness: 0.4 }]],
    memoryFiles: [{ path: 'C:/Users/hbyll/.claude/CLAUDE.md', type: 'project', tokens: 1200 }],
    mcpTools: [
      { name: 'mcp__shenyan__hold', serverName: 'shenyan', tokens: 260, isLoaded: true },
      { name: 'mcp__shenyan__recall', serverName: 'shenyan', tokens: 240, isLoaded: true },
    ],
    systemPromptSections: [{ name: '沈晏人格', tokens: 4591 }],
    agents: [],
    slashCommands: { totalCommands: 12, includedCommands: 3, tokens: 400 },
    skills: { totalSkills: 0, includedSkills: 0, tokens: 0 },
    ...over,
  };
}

/* ───────── ① percent 自己算 ───────── */

test('percent 由 token 数自己算，不采信 SDK 那个没有单位文档的 percentage', () => {
  // SDK 的 percentage 这里给的是 0.3（小数刻度）。若照抄，前端会显示 0.3%。
  // 48000 / 160000 = 30%。
  const out = normalizeContextUsage(sampleRaw(), OBSERVED_AT);
  assert.equal(out.percent, 30, 'percent 必须由 token 比值算出来');
  assert.equal(out.sdkPercentage, 0.3, 'SDK 那个值留着对账用，但不参与对外契约');
});

test('percent 只在两个 token 数都有效时才算；缺一个就是 null，不是 0', () => {
  assert.strictEqual(normalizeContextUsage(sampleRaw({ maxTokens: undefined }), OBSERVED_AT).percent, null);
  assert.strictEqual(normalizeContextUsage(sampleRaw({ totalTokens: NaN }), OBSERVED_AT).percent, null);
  assert.strictEqual(normalizeContextUsage(sampleRaw({ maxTokens: 0 }), OBSERVED_AT).percent, null, '分母 0 不能算出 Infinity');
});

test('percent 保留两位，不留浮点噪声', () => {
  const out = normalizeContextUsage(sampleRaw({ totalTokens: 1, maxTokens: 3 }), OBSERVED_AT);
  assert.equal(out.percent, 33.33);
});

/* ───────── ② 认 kind 不认 name ───────── */

test('categories 认 kind，不认英文名字（SDK 自己的纪律：never on the English name）', () => {
  const out = normalizeContextUsage(sampleRaw({
    categories: [
      { name: 'Free space', tokens: 10, kind: 'used' },      // 名字说 free，kind 说 used → 信 kind
      { name: 'Used', tokens: 20, kind: 'free' },            // 反过来也一样
      { name: '无 kind 的行', tokens: 30 },                   // 没有 kind 也保留，kind=null
    ],
  }), OBSERVED_AT);
  assert.deepStrictEqual(out.categories.map((c) => c.kind), ['used', 'free', null]);
  assert.equal(out.categories[0].name, 'Free space', '名字照留，只是不作为分类依据');
});

/* ───────── ③ 不泄露路径 / 不编造 ───────── */

test('memoryFiles 只留 type 与 tokens，**不带 path**', () => {
  const out = normalizeContextUsage(sampleRaw(), OBSERVED_AT);
  assert.equal(out.memoryFiles.length, 1);
  assert.equal(out.memoryFiles[0].type, 'project');
  assert.equal(out.memoryFiles[0].tokens, 1200);
  assert.equal(out.memoryFiles[0].path, undefined, '文件路径不该出后端');
  assert.ok(!JSON.stringify(out).includes('CLAUDE.md'), '整个 DTO 里不该出现那个路径');
});

test('mcpTools / systemPromptSections 逐项带 token（前端要看的分解）', () => {
  const out = normalizeContextUsage(sampleRaw(), OBSERVED_AT);
  assert.deepStrictEqual(out.mcpTools.map((t) => t.name), ['mcp__shenyan__hold', 'mcp__shenyan__recall']);
  assert.equal(out.mcpTools[0].tokens, 260);
  assert.deepStrictEqual(out.systemPromptSections, [{ name: '沈晏人格', tokens: 4591 }]);
});

test('gridRows 不进 DTO（那是 CLI 自己 /context 网格图的渲染数据）', () => {
  const out = normalizeContextUsage(sampleRaw(), OBSERVED_AT);
  assert.equal(out.gridRows, undefined);
});

/* ───────── 缓存：stale / 失败保留 / not_observed ───────── */

test('冷启动没观测过：available:false + not_observed，且 percent 是 null 不是 0', () => {
  const cache = createContextUsageCache({ now: () => Date.parse(OBSERVED_AT) });
  const s = cache.getSnapshot();
  assert.equal(s.available, false);
  assert.equal(s.stale, true);
  assert.equal(s.reason, 'not_observed');
  assert.strictEqual(s.percent, null);
  assert.strictEqual(s.usedTokens, null);
});

test('15 分钟没成功观测 → stale:true，但仍返回上一份快照', () => {
  let now = Date.parse(OBSERVED_AT);
  const cache = createContextUsageCache({ now: () => now });
  cache.observe(sampleRaw());
  assert.equal(cache.getSnapshot().stale, false);
  now += 16 * 60 * 1000;
  const s = cache.getSnapshot();
  assert.equal(s.stale, true);
  assert.equal(s.available, true, 'stale 不等于不可用');
  assert.equal(s.percent, 30, '旧值要保住，不能被清成 0');
});

test('已有成功快照后再失败：保留旧值，只标 lastError', () => {
  const cache = createContextUsageCache({ now: () => Date.parse(OBSERVED_AT) });
  cache.observe(sampleRaw());
  const err = new Error('boom'); err.code = 'CLAUDE_CONTEXT_TIMEOUT';
  cache.recordFailure(err);
  const s = cache.getSnapshot();
  assert.equal(s.available, true);
  assert.equal(s.percent, 30);
  assert.equal(s.lastError, 'timeout');
});

/* ───────── refresh：复用活着的 Query，不另起 ───────── */

test('refresh 复用传入的 Query，用 detail:"summary"（不跑逐类统计，更省）', async () => {
  const cache = createContextUsageCache();
  let received = null;
  const fakeQuery = {
    async getContextUsage(opts) { received = opts; return sampleRaw(); },
  };
  assert.equal(await refreshContextUsageFromQuery(fakeQuery, { cache }), true);
  assert.deepStrictEqual(received, { detail: 'summary' });
  assert.equal(cache.getSnapshot().percent, 30);
});

test('Query 上没有这个方法（旧 SDK）→ 记 unsupported，不当成失败重试', async () => {
  const cache = createContextUsageCache();
  assert.equal(await refreshContextUsageFromQuery({}, { cache }), false);
  assert.equal(cache.getSnapshot().reason, 'unsupported');
});

test('方法挂着不返回 → 超时兜底，不把整轮聊天拖死', async () => {
  const cache = createContextUsageCache();
  const hang = { getContextUsage: () => new Promise(() => {}) };
  assert.equal(await refreshContextUsageFromQuery(hang, { cache, timeoutMs: 30 }), false);
  assert.equal(cache.getSnapshot().reason, 'timeout');
});

test('方法抛错 → 记 refresh_failed，保留旧快照', async () => {
  const cache = createContextUsageCache();
  cache.observe(sampleRaw());
  const boom = { getContextUsage: async () => { throw new Error('nope'); } };
  assert.equal(await refreshContextUsageFromQuery(boom, { cache }), false);
  const s = cache.getSnapshot();
  assert.equal(s.lastError, 'refresh_failed');
  assert.equal(s.percent, 30);
});
