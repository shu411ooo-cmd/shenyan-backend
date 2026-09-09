// ===== lib/cache-control.js 单元测试（node:test）=====
// 命中率那条线的关键判据（08-31 从 60% 修到 99.9% 就是改的 markCacheTail），必须有常驻测试保护。

const { test } = require('node:test');
const assert = require('node:assert');
const c = require('../lib/cache-control.js');

const BP = { type: 'ephemeral', ttl: '1h' };

test('estimateTokens：空 / ASCII / 中文 / 混合的估算', () => {
  assert.strictEqual(c.estimateTokens(null), 0);
  assert.strictEqual(c.estimateTokens(undefined), 0);
  assert.strictEqual(c.estimateTokens(''), 0);
  assert.strictEqual(c.estimateTokens('hello'), 2); // 5 字符 /4 → ceil 2
  assert.strictEqual(c.estimateTokens('你好世界'), 4); // CJK 1 字 1 token
  assert.strictEqual(c.estimateTokens('abc你好'), 3); // 2 CJK + 3 ascii/4 → ceil(2.75)=3
});

test('sha256：确定性且截成 16 位 hex', () => {
  assert.strictEqual(c.sha256('hello'), '2cf24dba5fb0a30e');
  assert.strictEqual(c.sha256('hello'), c.sha256('hello'));
  assert.match(c.sha256('任何输入'), /^[0-9a-f]{16}$/);
});

test('withCacheControl：tool 消息原样返回，不加断点', () => {
  const msg = { role: 'tool', content: '结果', tool_call_id: 'x' };
  assert.strictEqual(c.withCacheControl(msg), msg); // 连新对象都不建
});

test('withCacheControl：字符串 content 会被包成单块数组并加断点', () => {
  const out = c.withCacheControl({ role: 'user', content: '你好' });
  assert.deepStrictEqual(out.content, [{ type: 'text', text: '你好', cache_control: BP }]);
});

test('withCacheControl：数组 content 只在最后一块加断点', () => {
  const out = c.withCacheControl({
    role: 'assistant',
    content: [{ type: 'text', text: 'a' }, { type: 'text', text: 'b' }],
  });
  assert.deepStrictEqual(out.content[0], { type: 'text', text: 'a' }); // 前面的块不动
  assert.deepStrictEqual(out.content[1], { type: 'text', text: 'b', cache_control: BP });
});

test('countCacheControlBlocks：null / 空 / 多条消息累加', () => {
  assert.strictEqual(c.countCacheControlBlocks(null), 0);
  assert.strictEqual(c.countCacheControlBlocks([]), 0);
  // 一条消息里：第 1、3 块带断点 → 2
  const one = [{ content: [
    { type: 'text', text: 'a', cache_control: BP },
    { type: 'text', text: 'b' },
    { type: 'text', text: 'c', cache_control: BP },
  ] }];
  assert.strictEqual(c.countCacheControlBlocks(one), 2);
  // 多条消息累加：1 + 2
  const many = [
    { content: [{ cache_control: BP }] },
    { content: [{ cache_control: BP }, { type: 'text', text: 'x', cache_control: {} }] },
  ];
  assert.strictEqual(c.countCacheControlBlocks(many), 3);
  // content 不是数组的不数（空数组也算 0）
  assert.strictEqual(c.countCacheControlBlocks([{ content: '字符串' }]), 0);
});

test('markCacheTail：断点挂倒数第二条 user（不是最后一条）', () => {
  const msgs = [
    { role: 'user', content: 'u1' },
    { role: 'assistant', content: 'a1' },
    { role: 'user', content: 'u2' },
    { role: 'assistant', content: 'a2' },
    { role: 'user', content: 'u3' }, // 本轮新输入，绝不挂
  ];
  c.markCacheTail(msgs);
  assert.deepStrictEqual(msgs[2].content[0].cache_control, BP); // u2 被挂
  assert.strictEqual(msgs[4].content, 'u3'); // 最后一条 user 保持原样
  assert.strictEqual(msgs[0].content, 'u1'); // 更早的不动
});

test('markCacheTail：只有一条 user 时不挂', () => {
  const msgs = [{ role: 'user', content: 'u1' }, { role: 'assistant', content: 'a1' }];
  c.markCacheTail(msgs);
  assert.strictEqual(msgs[0].content, 'u1');
});

test('markCacheTail：空数组不炸', () => {
  const empty = [];
  assert.doesNotThrow(() => c.markCacheTail(empty));
});

test('markCacheTail：content 为 null 的 assistant 要被跳过，null-content 的 user 也不算数', () => {
  // assistant content null 夹在中间：仍然该挂 u1（倒数第二条 user）
  const msgs = [
    { role: 'user', content: 'u1' },
    { role: 'assistant', content: null },
    { role: 'assistant', content: null },
    { role: 'user', content: 'u2' },
  ];
  c.markCacheTail(msgs);
  assert.deepStrictEqual(msgs[0].content[0].cache_control, BP);
  assert.strictEqual(msgs[1].content, null);
  assert.strictEqual(msgs[3].content, 'u2');

  // 只有两条 user 但其中一条 content 是 null → 不足两条有效 user，不挂
  const msgs2 = [{ role: 'user', content: 'u1' }, { role: 'user', content: null }];
  c.markCacheTail(msgs2);
  assert.strictEqual(msgs2[0].content, 'u1');
});

test('stripCacheControl：有/无 cache_control 字段两种', () => {
  const inMsgs = [
    { role: 'user', content: 'x', cache_control: BP },
    { role: 'user', content: 'y' },
    null,
  ];
  const out = c.stripCacheControl(inMsgs);
  assert.deepStrictEqual(out, [
    { role: 'user', content: 'x' },
    { role: 'user', content: 'y' },
    null,
  ]);
  assert.strictEqual(c.stripCacheControl(null).length, 0);
  assert.strictEqual(c.stripCacheControl([]).length, 0);
});
