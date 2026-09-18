// ===== lib/stream-frames.js 单元测试（node:test）=====
//
// 这些帧的字段名是**前端会认的**：angel-garden-diary 的 ChatScreen 只解析 SSE 的
// data: 行（完全忽略 event: 行），靠 payload 里的 kind 分发。任何一边单方面改名，
// 两边都不报错、只会静默显示错的东西 —— 与 trace/bucket_id 那次契约漂移同一形状。
//
// 所以这里钉的是**字段集本身**：改名或加字段都会红，逼人回来同步前端。
// 不看样式、不看文案，只看"前端能拿到什么"。

const { test } = require('node:test');
const assert = require('node:assert');

const { routeFrame } = require('../lib/stream-frames.js');

const withEnv = (patch, fn) => {
  const saved = {};
  for (const [k, v] of Object.entries(patch)) {
    saved[k] = process.env[k];
    if (v === undefined) delete process.env[k]; else process.env[k] = v;
  }
  try { return fn(); } finally {
    for (const [k, v] of Object.entries(saved)) {
      if (v === undefined) delete process.env[k]; else process.env[k] = v;
    }
  }
};
const TOKEN = { CLAUDE_CODE_OAUTH_TOKEN: 'test-token', CLAUDE_AGENT_ENABLED: undefined };

/* ───────── route 帧 ───────── */

test('route 帧：字段集被钉死，且 kind 是前端唯一的判别字段', () => {
  withEnv(TOKEN, () => {
    const f = routeFrame({ model: 'claude-sonnet-4-6' });
    assert.deepStrictEqual(Object.keys(f).sort(), ['kind', 'reason', 'transport']);
    assert.equal(f.kind, 'route');
    assert.equal(f.transport, 'claude-subscription');
    assert.strictEqual(f.reason, null, '走订阅线时 reason 是 null（不是 undefined——那样会被 JSON 丢掉）');
    assert.deepStrictEqual(
      JSON.parse(JSON.stringify(f)),
      { kind: 'route', transport: 'claude-subscription', reason: null },
    );
  });
});

test('route 帧：改道时 reason 是字符串，能过 JSON 往返（前端 title 要用）', () => {
  withEnv(TOKEN, () => {
    const f = routeFrame({ images: ['x'] });
    assert.equal(f.transport, 'api');
    assert.equal(typeof f.reason, 'string');
    assert.ok(f.reason.length > 0);
    assert.equal(JSON.parse(JSON.stringify(f)).reason, f.reason);
  });
});
