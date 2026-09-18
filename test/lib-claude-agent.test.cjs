const test = require('node:test');
const assert = require('node:assert/strict');

const {
  buildAgentPrompt,
  contentToText,
  detectSessionFork,
  normalizeUsage,
  readInitInfo,
  resolveTransport,
  shouldUseClaudeAgent,
  thinkingOptions,
  toolShape,
} = require('../lib/claude-agent');
const { getTools } = require('../lib/tools-schema');
const { z } = require('zod');

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
// 「mode=resume」只说明我们请求了 resume，不说明 SDK 真续上了。续不上时它会悄悄开新血脉，
// 光看 mode 永远发现不了 —— 这条只影响日志（不改行为），但它是唯一能证伪 resume 的信号。
test('detectSessionFork only fires when a requested resume returned a different session', () => {
  assert.equal(detectSessionFork('s1', 's1'), false);          // 正常续上
  assert.equal(detectSessionFork('s1', 's2'), true);           // 悄悄换了血脉
  assert.equal(detectSessionFork(null, 's2'), false);          // fresh 轮，本来就没有可续的
  assert.equal(detectSessionFork('s1', undefined), false);     // 没拿到 id，不误报
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

// retreat 是唯一零参数工具：上面那条测试对它的内层循环零次迭代，等于没测。
// 空 ZodRawShape 是 SDK tool() 的边界形状，单独钉一条，别让它再滑过去。
test('retreat 是零参数工具，空 shape 仍能构造合法的 Zod object', () => {
  const retreat = getTools().find((t) => t.function.name === 'retreat');
  assert.ok(retreat, 'retreat 工具不存在');
  const shape = toolShape(retreat.function.parameters);
  assert.deepStrictEqual(Object.keys(shape), [], 'retreat 不应有任何参数');
  const parsed = z.object(shape).safeParse({});
  assert.equal(parsed.success, true, 'retreat 空 shape 应接受空参数');
  assert.deepStrictEqual(Object.keys(parsed.data), []);
});

/* resolveTransport：报给前端的「本轮真实线路」。
   核心不是枚举对不对，而是 ①deepseek 不能被报成 api（它是独立省额度通道，报错会误导账）；
   ②没走订阅线时**必须带结构化原因**（静默改道正是「请求什么 ≠ 走什么」的根源）；
   ③布尔版 shouldUseClaudeAgent 永远是它的投影 —— 两份条件各写各的就会漂移。 */
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

test('resolveTransport：正常主对话报 claude-subscription 且不带原因', () => {
  withEnv(TOKEN, () => {
    assert.deepStrictEqual(resolveTransport({ model: 'claude-sonnet-4-6' }), {
      transport: 'claude-subscription', reason: null,
    });
  });
});

test('resolveTransport：deepseek 是独立通道，不能被报成 api', () => {
  withEnv(TOKEN, () => {
    const r = resolveTransport({ model: 'deepseek' });
    assert.equal(r.transport, 'deepseek');
    assert.equal(r.reason, 'model_deepseek');
  });
});

test('resolveTransport：每一种静默改道都带结构化原因（图片 / 委托 MCP / 续调 / 无 token / 被关）', () => {
  withEnv(TOKEN, () => {
    assert.equal(resolveTransport({ images: ['x'] }).reason, 'images_unsupported');
    assert.equal(resolveTransport({ mcpTools: [{ name: 't' }] }).reason, 'frontend_mcp_unsupported');
    assert.equal(resolveTransport({}, { finalContent: 'x' }).reason, 'delegated_resume');
  });
  withEnv({ ...TOKEN, CLAUDE_CODE_OAUTH_TOKEN: undefined }, () => {
    assert.equal(resolveTransport({}).transport, 'api');
    assert.equal(resolveTransport({}).reason, 'subscription_unconfigured');
  });
  withEnv({ ...TOKEN, CLAUDE_AGENT_ENABLED: 'false' }, () => {
    assert.equal(resolveTransport({}).transport, 'api');
    assert.equal(resolveTransport({}).reason, 'subscription_disabled');
  });
});

test('resolveTransport：布尔版永远是它的投影（防两份条件漂移）', () => {
  const cases = [
    [{ model: 'claude-sonnet-4-6' }, null],
    [{ model: 'deepseek' }, null],
    [{ model: 'x', images: ['i'] }, null],
    [{ model: 'x', mcpTools: [{ name: 't' }] }, null],
    [{ model: 'claude-sonnet-4-6' }, { finalContent: 'y' }],
  ];
  for (const env of [TOKEN, { ...TOKEN, CLAUDE_CODE_OAUTH_TOKEN: undefined }, { ...TOKEN, CLAUDE_AGENT_ENABLED: 'false' }]) {
    withEnv(env, () => {
      for (const [opts, resume] of cases) {
        assert.equal(
          shouldUseClaudeAgent(opts, resume),
          resolveTransport(opts, resume).transport === 'claude-subscription',
          `不一致：${JSON.stringify(opts)} resume=${JSON.stringify(resume)}`,
        );
      }
    });
  }
});

/* 注：route 帧的字段集测试放在 test/lib-stream-frames.test.cjs。
   本文件只管「选哪条线」（resolveTransport），不管「怎么报给前端」。 */

/* system/init 是「这一轮实际拿到了什么」的唯一权威自述。2026-09-18 之前我们只从里面取
   4 个字段，把 tools 和 mcp_servers 丢了 —— 于是「首轮工具表为空」这件事既报不出来也证不了。
   这条测试钉住这两个字段不再被丢，顺带钉住「只取数量与状态、不取内容」。 */
test('readInitInfo 取到工具表与 MCP 连接状态（首轮空工具表要靠它定案）', () => {
  const info = readInitInfo({
    apiKeySource: 'none',
    claude_code_version: '2.1.274',
    model: 'claude-sonnet-4-6',
    slash_commands: ['compact', 'clear'],
    tools: ['mcp__shenyan__recall', 'mcp__shenyan__hold', 'Read'],
    mcp_servers: [{ name: 'shenyan', status: 'connected', source: 'sdk' }],
  });
  assert.equal(info.toolsCount, 3);
  assert.equal(info.shenyanToolsCount, 2, '只数 mcp__shenyan__ 前缀的');
  assert.deepStrictEqual(info.mcpServers, ['shenyan=connected']);
  assert.equal(info.apiKeySource, 'none');

  // 首轮真的没工具时，必须能如实报出来（而不是像以前那样静默变成 undefined）
  const empty = readInitInfo({ tools: [], mcp_servers: [{ name: 'shenyan', status: 'pending' }] });
  assert.equal(empty.toolsCount, 0, '空工具表要报 0，不能报 null');
  assert.equal(empty.shenyanToolsCount, 0);
  assert.deepStrictEqual(empty.mcpServers, ['shenyan=pending']);

  // 字段缺失（旧 CLI）时给 null，不伪造 0
  const legacy = readInitInfo({});
  assert.equal(legacy.toolsCount, null);
  assert.equal(legacy.mcpServers, null);
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
