// ===== sse-parser 单元测试（node:test）=====
// 覆盖分帧边界与 reasoning 优先级等纯逻辑，不依赖网络。

const { test } = require('node:test');
const assert = require('node:assert');
const { createFramer, createChatStreamMerger } = require('../sse-parser');

test('分帧：跨 chunk 被切开的帧也能完整输出', () => {
  const framer = createFramer();
  // 第一帧完整 + 第二帧只喂半截 → 本轮只出一条
  const first = framer.push('data: {"a":1}\ndata: {"b"');
  assert.deepStrictEqual(first, ['{"a":1}']);
  // 补上剩半截 → 完整输出
  const second = framer.push(':2}\n');
  assert.deepStrictEqual(second, ['{"b":2}']);
});

test('分帧：垃圾行、非 data 行、空行、[DONE] 哨兵', () => {
  const framer = createFramer();
  const out = framer.push(':garbage:\ndata: {"x":1}\n\nevent: ping\ndata: [DONE]\n');
  assert.deepStrictEqual(out, ['{"x":1}', '[DONE]']);
});

test('合并：reasoning_summary 只在未收到推理正文时生效（防重复）', () => {
  const m = createChatStreamMerger({ reasoningKeys: ['reasoning', 'reasoning_summary', 'thinking'] });
  m.processDataLine('{"choices":[{"delta":{"reasoning_summary":"摘要"}}]}');
  m.processDataLine('{"choices":[{"delta":{"reasoning":"正文"}}]}');
  // 已收正文后，summary 被跳过，但 thinking 字段仍可用
  m.processDataLine('{"choices":[{"delta":{"reasoning_summary":"不该出现","thinking":"尾巴"}}]}');
  assert.deepStrictEqual(m.result().thinkingText, '摘要正文尾巴');
});

test('合并：坏帧静默跳过，usage 取最后一个', () => {
  const m = createChatStreamMerger({ reasoningKeys: ['reasoning_content'] });
  m.processDataLine('{bad json');
  m.processDataLine('{"choices":[{"delta":{"content":"a"}}],"usage":{"n":1}}');
  m.processDataLine('{"choices":[{"delta":{}}],"usage":{"n":2}}');
  const r = m.result();
  assert.strictEqual(r.content, 'a');
  assert.deepStrictEqual(r.usage, { n: 2 });
});

test('emit：text 事件带 sentence_end 句末标记（含跨 delta 的引号场景）', () => {
  const m = createChatStreamMerger({ reasoningKeys: ['reasoning'] });
  const emitted = [];
  m.processDataLine('{"choices":[{"delta":{"content":"「今天天气不错"}}]}', (t, p) => emitted.push([t, p]));
  m.processDataLine('{"choices":[{"delta":{"content":"。」"}}]}', (t, p) => emitted.push([t, p]));
  assert.deepStrictEqual(emitted, [
    ['text', { text: '「今天天气不错', sentence_end: false }],
    ['text', { text: '。」', sentence_end: true }],
  ]);
});

test('合并：usage 取最后一个，空对象也算 usage（{} 是 truthy，与原实现一致）', () => {
  const m = createChatStreamMerger({ reasoningKeys: ['reasoning'] });
  m.processDataLine('{"choices":[{"delta":{"content":"x"}}],"usage":{}}');
  m.processDataLine('{"choices":[{"delta":{"content":"y"}}],"usage":{"n":2}}');
  const r = m.result();
  assert.strictEqual(r.content, 'xy');
  assert.deepStrictEqual(r.usage, { n: 2 });
});