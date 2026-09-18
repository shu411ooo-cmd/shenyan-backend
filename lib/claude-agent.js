/* ============================================================
   Claude Agent SDK adapter

   Main-chat only. The application remains the source of truth for durable
   messages, memory and tool side effects. Agent SDK sessions preserve native
   conversational/tool context between turns. Claude Code built-in filesystem,
   shell tools and on-disk settings are disabled.
   ============================================================ */

const crypto = require('node:crypto');
const os = require('node:os');
const path = require('node:path');
const { z } = require('zod');

let sdkPromise;
let activeQueries = 0;

function loadSdk() {
  if (!sdkPromise) sdkPromise = import('@anthropic-ai/claude-agent-sdk');
  return sdkPromise;
}

function envInt(name, fallback, min, max) {
  const value = Number.parseInt(process.env[name] || '', 10);
  if (!Number.isFinite(value)) return fallback;
  return Math.max(min, Math.min(max, value));
}

function claudeAgentConfigured() {
  return Boolean(String(process.env.CLAUDE_CODE_OAUTH_TOKEN || '').trim());
}

function shouldUseClaudeAgent(opts = {}, resume = null) {
  if (!claudeAgentConfigured()) return false;
  if (String(process.env.CLAUDE_AGENT_ENABLED || 'true').toLowerCase() === 'false') return false;
  if (/deepseek/i.test(String(opts.model || ''))) return false;
  // Images need native multimodal message input; frontend MCP uses the existing
  // re-entrant delegation protocol. Keep both on the proven OpenRouter path.
  if (Array.isArray(opts.images) && opts.images.length) return false;
  if (Array.isArray(opts.mcpTools) && opts.mcpTools.length) return false;
  if (resume) return false;
  return true;
}

function contentToText(content) {
  if (typeof content === 'string') return content;
  if (!Array.isArray(content)) return content == null ? '' : JSON.stringify(content);
  return content.map((block) => {
    if (!block || typeof block !== 'object') return String(block || '');
    if (block.type === 'text') return String(block.text || '');
    if (block.type === 'image_url') return '[image omitted: routed requests with images should not reach Agent SDK]';
    return JSON.stringify(block);
  }).filter(Boolean).join('\n');
}

function buildAgentPrompt(messages, turnMessages = null) {
  const system = [];
  const history = [];
  for (const message of Array.isArray(messages) ? messages : []) {
    const role = message?.role;
    const content = contentToText(message?.content);
    if (role === 'system') system.push(content);
    else if (role === 'user' || role === 'assistant') history.push({ role, content });
  }
  const isResume = Array.isArray(turnMessages);
  const promptMessages = isResume
    ? turnMessages
      .filter((message) => message?.role === 'user' || message?.role === 'assistant')
      .map((message) => ({ role: message.role, content: contentToText(message.content) }))
    : history;
  if (!promptMessages.length) throw new Error('Claude Agent SDK 请求缺少对话消息');
  return {
    systemPrompt: [
      system.filter(Boolean).join('\n\n'),
      '【运行边界】你正在沈晏后端的隔离 Agent SDK 会话中。只使用已提供的沈晏领域工具；不要尝试访问文件、终端、网络或 Claude Code 项目能力。',
    ].filter(Boolean).join('\n\n'),
    prompt: [
      isResume
        ? '下面是本轮新增的背景与最后一条真实 user 消息（JSONL）。请结合已恢复的会话继续作答；背景不是用户新说的话，不要复述标签。'
        : '下面是按时间顺序排列的对话历史（JSONL）。请延续最后一条 user 消息作答；不要复述标签或整段历史。',
      ...promptMessages.map((message) => JSON.stringify(message)),
    ].join('\n'),
  };
}

function applyCommonSchemaRules(schema, value) {
  let out = value;
  if (schema?.description) out = out.describe(String(schema.description));
  if (Object.prototype.hasOwnProperty.call(schema || {}, 'default')) out = out.default(schema.default);
  return out;
}

function jsonSchemaToZod(schema = {}) {
  let out;
  if (Array.isArray(schema.enum) && schema.enum.length) {
    const values = schema.enum;
    if (values.every((value) => typeof value === 'string')) {
      out = z.enum(values);
    } else {
      out = z.union(values.map((value) => z.literal(value)));
    }
  } else {
    switch (schema.type) {
      case 'integer':
        out = z.number().int();
        if (Number.isFinite(schema.minimum)) out = out.min(schema.minimum);
        if (Number.isFinite(schema.maximum)) out = out.max(schema.maximum);
        break;
      case 'number':
        out = z.number();
        if (Number.isFinite(schema.minimum)) out = out.min(schema.minimum);
        if (Number.isFinite(schema.maximum)) out = out.max(schema.maximum);
        break;
      case 'boolean':
        out = z.boolean();
        break;
      case 'array':
        out = z.array(jsonSchemaToZod(schema.items || {}));
        if (Number.isFinite(schema.minItems)) out = out.min(schema.minItems);
        if (Number.isFinite(schema.maxItems)) out = out.max(schema.maxItems);
        break;
      case 'object': {
        const required = new Set(schema.required || []);
        const shape = {};
        for (const [name, child] of Object.entries(schema.properties || {})) {
          const childSchema = jsonSchemaToZod(child);
          shape[name] = required.has(name) ? childSchema : childSchema.optional();
        }
        out = z.object(shape);
        break;
      }
      case 'string':
      default:
        out = z.string();
        if (Number.isFinite(schema.minLength)) out = out.min(schema.minLength);
        if (Number.isFinite(schema.maxLength)) out = out.max(schema.maxLength);
        break;
    }
  }
  return applyCommonSchemaRules(schema, out);
}

function toolShape(parameters = {}) {
  const required = new Set(parameters.required || []);
  const shape = {};
  for (const [name, schema] of Object.entries(parameters.properties || {})) {
    const converted = jsonSchemaToZod(schema);
    shape[name] = required.has(name) ? converted : converted.optional();
  }
  return shape;
}

function safeToolText(value) {
  if (value === undefined || value === null) return JSON.stringify({ error: '工具没有返回结果' });
  let text;
  try { text = JSON.stringify(value); } catch { text = String(value); }
  const max = 8000;
  return text.length > max ? `${text.slice(0, max)}\n…（工具结果过长，已截断）` : text;
}

function normalizeUsage(usage) {
  if (!usage || typeof usage !== 'object') return null;
  const input = Number(usage.input_tokens) || 0;
  const output = Number(usage.output_tokens) || 0;
  const cacheRead = Number(usage.cache_read_input_tokens) || 0;
  const cacheWrite = Number(usage.cache_creation_input_tokens) || 0;
  const prompt = input + cacheRead + cacheWrite;
  return {
    provider: 'claude-agent-sdk',
    prompt_tokens: prompt,
    completion_tokens: output,
    total_tokens: prompt + output,
    cache_read_input_tokens: cacheRead,
    cache_creation_input_tokens: cacheWrite,
    raw: usage,
  };
}

function resolveModel(model) {
  const clean = String(model || process.env.CLAUDE_AGENT_MODEL || 'claude-sonnet-4-6').trim();
  return clean.replace(/^anthropic\//, '') || 'claude-sonnet-4-6';
}

function buildChildEnv() {
  const env = {
    ...process.env,
    CLAUDE_AGENT_SDK_CLIENT_APP: 'shenyan-backend/1.0.0',
    CLAUDE_CODE_DISABLE_AUTO_MEMORY: '1',
    // Keep the SDK SessionStore project key stable across Zeabur releases.
    CLAUDE_CODE_PROJECT_DIR_NAME: process.env.CLAUDE_AGENT_PROJECT_KEY || 'shenyan-backend',
  };
  // These credentials outrank subscription OAuth and can silently bill a
  // different provider. They are deliberately removed from the child only.
  delete env.ANTHROPIC_API_KEY;
  delete env.ANTHROPIC_AUTH_TOKEN;
  delete env.ANTHROPIC_BASE_URL;
  if (claudeAgentConfigured()) {
    env.CLAUDE_CONFIG_DIR = process.env.CLAUDE_AGENT_CONFIG_DIR
      || path.join(os.tmpdir(), 'shenyan-claude-agent');
  }
  return env;
}

async function acquireSlot() {
  const max = envInt('CLAUDE_AGENT_MAX_CONCURRENCY', 1, 1, 8);
  if (activeQueries >= max) {
    const error = new Error('Claude 正在处理上一条消息，请稍后再试');
    error.code = 'CLAUDE_AGENT_BUSY';
    error.status = 429;
    throw error;
  }
  activeQueries++;
  return () => { activeQueries = Math.max(0, activeQueries - 1); };
}

function emit(observer, method, payload) {
  try { observer?.[method]?.(payload); } catch { /* 客户端断开不影响工具结果 */ }
}

async function makeToolServer({ definitions, executeTool, serializeToolResult, observer }) {
  const { createSdkMcpServer, tool } = await loadSdk();
  let toolChain = Promise.resolve();
  const sdkTools = (definitions || []).map((definition) => {
    const fn = definition.function || definition;
    return tool(
      fn.name,
      fn.description || '',
      toolShape(fn.parameters || {}),
      async (args) => {
        const id = crypto.randomUUID();
        const startedAt = Date.now();
        console.log(`🔧 [Claude Agent Tool] name=${fn.name} state=start`);
        emit(observer, 'onToolCall', { id, name: fn.name, arguments: args });
        const run = toolChain.then(async () => {
          try {
            const result = await executeTool(fn.name, args);
            const text = serializeToolResult
              ? serializeToolResult(fn.name, result)
              : safeToolText(result);
            const success = result !== null && result !== undefined && !result?.error;
            console.log(`🔧 [Claude Agent Tool] name=${fn.name} state=${success ? 'ok' : 'error'} ms=${Date.now() - startedAt}`);
            emit(observer, 'onToolResult', { id, name: fn.name, success, result });
            return { content: [{ type: 'text', text }], isError: !success };
          } catch (error) {
            const message = error instanceof Error ? error.message : String(error);
            const result = { error: message };
            console.warn(`🔧 [Claude Agent Tool] name=${fn.name} state=error ms=${Date.now() - startedAt}`);
            emit(observer, 'onToolResult', { id, name: fn.name, success: false, result });
            return { content: [{ type: 'text', text: JSON.stringify(result) }], isError: true };
          }
        });
        toolChain = run.catch(() => undefined);
        return run;
      },
    );
  });
  if (!sdkTools.length) return { server: null, allowedTools: [] };
  return {
    server: createSdkMcpServer({
      name: 'shenyan',
      version: '1.0.0',
      tools: sdkTools,
      timeout: envInt('CLAUDE_AGENT_TOOL_TIMEOUT_MS', 30000, 1000, 120000),
    }),
    allowedTools: sdkTools.map((_, index) => `mcp__shenyan__${(definitions[index].function || definitions[index]).name}`),
  };
}

function thinkingOptions(thinking) {
  if (thinking === 'off') return { thinking: { type: 'disabled' } };
  const configuredDisplay = String(process.env.CLAUDE_AGENT_THINKING_DISPLAY || 'summarized').toLowerCase();
  const display = configuredDisplay === 'omitted' ? 'omitted' : 'summarized';
  return {
    // Agent SDK maps this to Claude Code's `--thinking-display` flag. Only
    // model-provided readable summaries are surfaced; hidden raw CoT is not.
    thinking: { type: 'adaptive', display },
    effort: thinking === 'deep' ? 'high' : 'medium',
  };
}

// resume 成功时 SDK 必须回同一个 session_id。不同 = 它没能续上、悄悄开了条新血脉
// （transcript 读不出 / 被清过 / project_key 漂移）。「请求了什么」不等于「续上了什么」，
// 所以这个判断只做观测、不干预：本轮回答照样正确，日志要说实话。
function detectSessionFork(resumeSessionId, sessionId) {
  return Boolean(resumeSessionId) && Boolean(sessionId) && sessionId !== resumeSessionId;
}

function resultError(message) {
  const details = Array.isArray(message?.errors) ? message.errors.join('; ') : '';
  const text = details || message?.result || message?.subtype || 'Claude Agent SDK 执行失败';
  const error = new Error(String(text).slice(0, 500));
  error.code = 'CLAUDE_AGENT_FAILED';
  return error;
}

async function runClaudeAgent({
  messages,
  turnMessages = null,
  resumeSessionId = null,
  sessionStore = null,
  opts = {},
  definitions = [],
  executeTool,
  serializeToolResult,
  observer = null,
}) {
  const release = await acquireSlot();
  const controller = new AbortController();
  const timeoutMs = envInt('CLAUDE_AGENT_TIMEOUT_MS', 180000, 30000, 600000);
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  const onAbort = () => controller.abort();
  observer?.signal?.addEventListener?.('abort', onAbort, { once: true });

  try {
    const { query } = await loadSdk();
    const { systemPrompt, prompt } = buildAgentPrompt(
      messages,
      resumeSessionId ? (turnMessages || []) : null,
    );
    const toolServer = opts.tools === 'off'
      ? { server: null, allowedTools: [] }
      : await makeToolServer({ definitions, executeTool, serializeToolResult, observer });
    const mcpServers = toolServer.server ? { shenyan: toolServer.server } : {};
    const queryOptions = {
      abortController: controller,
      allowedTools: toolServer.allowedTools,
      cwd: os.tmpdir(),
      env: buildChildEnv(),
      includePartialMessages: Boolean(observer?.onText || observer?.onThinking),
      maxTurns: envInt('CLAUDE_AGENT_MAX_TURNS', 4, 1, 10),
      mcpServers,
      model: resolveModel(opts.model),
      permissionMode: 'dontAsk',
      persistSession: Boolean(sessionStore),
      plugins: [],
      settingSources: [],
      skills: [],
      strictMcpConfig: true,
      systemPrompt,
      tools: [],
      ...thinkingOptions(opts.thinking || 'standard'),
    };
    if (sessionStore) {
      queryOptions.sessionStore = sessionStore;
      queryOptions.sessionStoreFlush = 'batched';
      queryOptions.loadTimeoutMs = envInt('CLAUDE_AGENT_SESSION_LOAD_TIMEOUT_MS', 30000, 1000, 60000);
    }
    if (resumeSessionId) queryOptions.resume = resumeSessionId;

    let streamedText = '';
    let thinkingText = '';
    let resultMessage = null;
    let mirrorError = null;
    // SDK 把「这一轮走的是哪条认证线」「它自己压了几次上下文」都如实塞在 system 消息里，
    // 而这三类以前全被丢掉了 —— 于是压缩随时发生而外面一无所知（审计 G 项的根源）。
    let initInfo = null;
    const compactions = [];
    for await (const message of query({ prompt, options: queryOptions })) {
      if (message.type === 'stream_event') {
        const event = message.event;
        if (event?.type !== 'content_block_delta') continue;
        if (event.delta?.type === 'text_delta' && event.delta.text) {
          streamedText += event.delta.text;
          emit(observer, 'onText', event.delta.text);
        } else if (event.delta?.type === 'thinking_delta' && event.delta.thinking) {
          thinkingText += event.delta.thinking;
          emit(observer, 'onThinking', event.delta.thinking);
        }
      } else if (message.type === 'system' && message.subtype === 'mirror_error') {
        mirrorError = String(message.error || 'unknown SessionStore error');
        console.error(`❌ [Claude SessionStore] session=${message.session_id || '—'} ${mirrorError.slice(0, 300)}`);
      } else if (message.type === 'system' && message.subtype === 'init') {
        // 每轮开头 CLI 报一次。apiKeySource 是唯一能证伪「这一轮真的走了订阅线」的信号
        // （'none' = OAuth / bearer；出现 ANTHROPIC_API_KEY 等字样则是被别的凭据接管了）。
        // slash_commands 顺带回答「/compact 到底可不可用」。只记名字和数量，不记内容。
        initInfo = {
          apiKeySource: message.apiKeySource || null,
          cliVersion: message.claude_code_version || null,
          model: message.model || null,
          slashCommands: Array.isArray(message.slash_commands) ? message.slash_commands : [],
        };
        console.log(`⚙️ [Claude Agent] session=${message.session_id || '—'} auth=${initInfo.apiKeySource}`
          + ` cli=${initInfo.cliVersion} model=${initInfo.model} slash=${initInfo.slashCommands.length}`
          + `${initInfo.slashCommands.includes('compact') ? '（含 compact）' : '（无 compact）'}`);
      } else if (message.type === 'system' && message.subtype === 'compact_boundary') {
        // SDK 自己的上下文压缩就发生在这里。trigger=auto 意味着它会自己决定压，
        // 且压的是它自己的 transcript —— 与我们 summary_segments 是两套互不知情的压缩。
        const meta = message.compact_metadata || {};
        compactions.push({
          trigger: meta.trigger || null,
          preTokens: meta.pre_tokens ?? null,
          postTokens: meta.post_tokens ?? null,
        });
        console.warn(`📦 [Claude Compact] session=${message.session_id || '—'} trigger=${meta.trigger || '—'}`
          + ` pre=${meta.pre_tokens ?? '—'} post=${meta.post_tokens ?? '—'} ms=${meta.duration_ms ?? '—'}`);
      } else if (message.type === 'system' && message.subtype === 'status' && message.compact_result) {
        // 压缩的收尾判定（success/failed）。失败的原文必须留痕，否则又是「无声失败」。
        console.warn(`📦 [Claude Compact] result=${message.compact_result}`
          + `${message.compact_error ? ` error=${String(message.compact_error).slice(0, 200)}` : ''}`);
      } else if (message.type === 'assistant' && message.error) {
        throw new Error(`Claude Agent SDK: ${message.error}`);
      } else if (message.type === 'result') {
        resultMessage = message;
      }
    }

    if (!resultMessage || resultMessage.subtype !== 'success' || resultMessage.is_error) {
      throw resultError(resultMessage);
    }
    const content = String(resultMessage.result || streamedText || '');
    if (!streamedText && content) emit(observer, 'onText', content);
    if (!content) throw new Error('Claude Agent SDK 没有返回正文');
    // 续接可观测性：resume 成功时 SDK 必须回**同一个** session_id。不同 = 它没能续上、
    // 悄悄开了条新血脉（transcript 读不出 / 被清过 / project_key 漂移）。本轮回答照样正确，
    // 但「mode=resume」这个名字从此不再等于「续上了」——只改日志不改行为，下轮起用新 id 续。
    const sessionId = resultMessage.session_id;
    const forked = detectSessionFork(resumeSessionId, sessionId);
    if (forked) {
      console.warn(`⚠️ [Claude Session] resume 未续上：请求 sdk=${String(resumeSessionId).slice(0, 8)} 实际 sdk=${String(sessionId).slice(0, 8)}（本轮已按新会话继续）`);
    }
    return {
      content,
      thinkingText,
      usage: normalizeUsage(resultMessage.usage),
      sessionId,
      resumed: Boolean(resumeSessionId),
      forked,
      initInfo,
      compactions,
      durable: Boolean(sessionStore) && !mirrorError,
      mirrorError,
    };
  } catch (error) {
    if (controller.signal.aborted && error?.code !== 'CLAUDE_AGENT_BUSY') {
      const timeout = new Error('Claude 响应超时或连接已取消');
      timeout.code = 'CLAUDE_AGENT_TIMEOUT';
      throw timeout;
    }
    throw error;
  } finally {
    clearTimeout(timer);
    observer?.signal?.removeEventListener?.('abort', onAbort);
    release();
  }
}

function getClaudeAgentRuntimeStatus() {
  return {
    configured: claudeAgentConfigured(),
    enabled: claudeAgentConfigured()
      && String(process.env.CLAUDE_AGENT_ENABLED || 'true').toLowerCase() !== 'false',
    activeQueries,
    maxConcurrency: envInt('CLAUDE_AGENT_MAX_CONCURRENCY', 1, 1, 8),
  };
}

module.exports = {
  buildAgentPrompt,
  contentToText,
  detectSessionFork,
  getClaudeAgentRuntimeStatus,
  jsonSchemaToZod,
  normalizeUsage,
  resolveModel,
  runClaudeAgent,
  shouldUseClaudeAgent,
  thinkingOptions,
  toolShape,
};
