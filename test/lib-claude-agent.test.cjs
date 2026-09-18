const test = require('node:test');
const assert = require('node:assert/strict');

const {
  buildAgentPrompt,
  contentToText,
  normalizeUsage,
  shouldUseClaudeAgent,
  thinkingOptions,
  toolShape,
} = require('../lib/claude-agent');
const { getTools } = require('../lib/tools-schema');

test('buildAgentPrompt separates the system prompt and preserves ordered history', () => {
  const built = buildAgentPrompt([
    { role: 'system', content: [{ type: 'text', text: '人格锚' }] },
    { role: 'user', content: '你好' },
    { role: 'assistant', content: '在。' },
    { role: 'user', content: '继续说' },
  ]);
  assert.match(built.systemPrompt, /人格锚/);
  const lines = built.prompt.split('\n').slice(1).map((line) => JSON.parse(line));
  assert.deepEqual(lines, [
    { role: 'user', content: '你好' },
    { role: 'assistant', content: '在。' },
    { role: 'user', content: '继续说' },
  ]);
});

test('buildAgentPrompt sends only new turn material when resuming a native session', () => {
  const built = buildAgentPrompt([
    { role: 'system', content: '人格锚' },
    { role: 'user', content: '旧问题' },
    { role: 'assistant', content: '旧回答' },
    { role: 'user', content: '新问题' },
  ], [
    { role: 'user', content: '【当前时间】晚上十点' },
    { role: 'user', content: '新问题' },
  ]);
  assert.match(built.systemPrompt, /人格锚/);
  assert.doesNotMatch(built.prompt, /旧问题|旧回答/);
  const lines = built.prompt.split('\n').slice(1).map((line) => JSON.parse(line));
  assert.deepEqual(lines, [
    { role: 'user', content: '【当前时间】晚上十点' },
    { role: 'user', content: '新问题' },
  ]);
});
test('contentToText flattens text blocks without leaking image data', () => {
  const text = contentToText([
    { type: 'text', text: '看看' },
    { type: 'image_url', image_url: { url: 'data:image/png;base64,secret' } },
  ]);
  assert.match(text, /看看/);
  assert.doesNotMatch(text, /base64,secret/);
});

test('all domain tool JSON schemas convert to valid Zod raw shapes', () => {
  for (const definition of getTools()) {
    const fn = definition.function;
    const shape = toolShape(fn.parameters);
    assert.equal(typeof shape, 'object', fn.name);
    for (const schema of Object.values(shape)) {
      assert.equal(typeof schema.safeParse, 'function', fn.name);
    }
  }
});

test('normalizeUsage maps Anthropic cache buckets into request_stats shape', () => {
  assert.deepEqual(normalizeUsage({
    input_tokens: 10,
    output_tokens: 4,
    cache_read_input_tokens: 20,
    cache_creation_input_tokens: 5,
  }), {
    provider: 'claude-agent-sdk',
    prompt_tokens: 35,
    completion_tokens: 4,
    total_tokens: 39,
    cache_read_input_tokens: 20,
    cache_creation_input_tokens: 5,
    raw: {
      input_tokens: 10,
      output_tokens: 4,
      cache_read_input_tokens: 20,
      cache_creation_input_tokens: 5,
    },
  });
});

test('thinking display defaults to summarized and supports an omitted kill switch', () => {
  const before = process.env.CLAUDE_AGENT_THINKING_DISPLAY;
  try {
    delete process.env.CLAUDE_AGENT_THINKING_DISPLAY;
    assert.deepEqual(thinkingOptions('standard'), {
      thinking: { type: 'adaptive', display: 'summarized' },
      effort: 'medium',
    });
    assert.deepEqual(thinkingOptions('deep'), {
      thinking: { type: 'adaptive', display: 'summarized' },
      effort: 'high',
    });
    process.env.CLAUDE_AGENT_THINKING_DISPLAY = 'omitted';
    assert.deepEqual(thinkingOptions('standard'), {
      thinking: { type: 'adaptive', display: 'omitted' },
      effort: 'medium',
    });
    assert.deepEqual(thinkingOptions('off'), { thinking: { type: 'disabled' } });
  } finally {
    if (before === undefined) delete process.env.CLAUDE_AGENT_THINKING_DISPLAY;
    else process.env.CLAUDE_AGENT_THINKING_DISPLAY = before;
  }
});

test('provider selection is opt-in by token and falls back for unsupported request shapes', () => {
  const beforeToken = process.env.CLAUDE_CODE_OAUTH_TOKEN;
  const beforeEnabled = process.env.CLAUDE_AGENT_ENABLED;
  try {
    delete process.env.CLAUDE_CODE_OAUTH_TOKEN;
    assert.equal(shouldUseClaudeAgent({ model: 'claude-sonnet-4-6' }), false);

    process.env.CLAUDE_CODE_OAUTH_TOKEN = 'test-only';
    delete process.env.CLAUDE_AGENT_ENABLED;
    assert.equal(shouldUseClaudeAgent({ model: 'claude-sonnet-4-6' }), true);
    assert.equal(shouldUseClaudeAgent({ model: 'deepseek' }), false);
    assert.equal(shouldUseClaudeAgent({ model: 'claude-sonnet-4-6', images: ['data:'] }), false);
    assert.equal(shouldUseClaudeAgent({ model: 'claude-sonnet-4-6', mcpTools: [{}] }), false);

    process.env.CLAUDE_AGENT_ENABLED = 'false';
    assert.equal(shouldUseClaudeAgent({ model: 'claude-sonnet-4-6' }), false);
  } finally {
    if (beforeToken === undefined) delete process.env.CLAUDE_CODE_OAUTH_TOKEN;
    else process.env.CLAUDE_CODE_OAUTH_TOKEN = beforeToken;
    if (beforeEnabled === undefined) delete process.env.CLAUDE_AGENT_ENABLED;
    else process.env.CLAUDE_AGENT_ENABLED = beforeEnabled;
  }
});
