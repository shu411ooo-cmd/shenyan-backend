const express = require('express');
const cors = require('cors');
require('dotenv').config();
const { createClient } = require('@supabase/supabase-js');
const crypto = require('crypto');

const supabase = createClient(
  process.env.SUPABASE_URL,
  process.env.SUPABASE_KEY
);

const app = express();
app.use(cors());
app.use(express.json());

// ===== Ombre Brain MCP 客户端 =====

function parseSSEResponse(text) {
  if (!text) return null;

  const lines = text.split('\n');
  for (const line of lines) {
    if (line.startsWith('data: ')) {
      try {
        return JSON.parse(line.substring(6));
      } catch (e) {
        // ignore
      }
    }
  }

  try {
    return JSON.parse(text);
  } catch (e) {
    return null;
  }
}

let ombreSessionId = null;
let ombreCallId = 0;

function buildOmbreHeaders(extraHeaders = {}) {
  const token = process.env.OMBRE_STATIC_TOKEN || '';

  return {
    'Content-Type': 'application/json',
    'Accept': 'application/json, text/event-stream',
    // 兼容两种常见鉴权头，尽量把问题从“头名不对”里排掉
    Authorization: `Bearer ${token}`,
    'Ombre-MCP-Token': token,
    ...extraHeaders,
  };
}

async function readResponseBody(response) {
  const rawText = await response.text();
  console.log('📡 [调试] 响应原文:', rawText);
  return rawText;
}

async function initOmbreSession() {
  try {
    const headers = buildOmbreHeaders();

    console.log('========== OMBRE INIT REQUEST ==========');
    console.log('OMBRE_BRAIN_URL:', process.env.OMBRE_BRAIN_URL);
    console.log('Token length:', process.env.OMBRE_STATIC_TOKEN?.length || 0);
    console.log('Authorization:', headers.Authorization);
    console.log('Ombre-MCP-Token set:', !!headers['Ombre-MCP-Token']);

    const response = await fetch(`${process.env.OMBRE_BRAIN_URL}/mcp`, {
      method: 'POST',
      headers,
      body: JSON.stringify({
        jsonrpc: '2.0',
        method: 'initialize',
        params: {
          protocolVersion: '2024-11-05',
          capabilities: {},
          clientInfo: {
            name: 'shenyan-backend',
            version: '1.0',
          },
        },
        id: ++ombreCallId,
      }),
    });

    console.log('📡 initOmbreSession 响应状态:', response.status);
    console.log(
      '📡 initOmbreSession 响应头:',
      Object.fromEntries(response.headers.entries())
    );
    console.log('📡 所有响应头键名:', [...response.headers.keys()]);

    const rawText = await readResponseBody(response);
    const data = parseSSEResponse(rawText);

    console.log('📡 initOmbreSession 解析结果:', data);

    const headerSessionId =
      response.headers.get('mcp-session-id') ||
      response.headers.get('Mcp-Session-Id');

    ombreSessionId = headerSessionId || data?.result?.sessionId || null;

    console.log('📡 initOmbreSession sessionId:', ombreSessionId);

    if (!response.ok) {
      ombreSessionId = null;
      return false;
    }

    if (!ombreSessionId) {
      console.warn('⚠️ [警告] initialize 成功但没有拿到 sessionId');
      return false;
    }

    // 教程里的第二步：发送 initialized 通知
    await fetch(`${process.env.OMBRE_BRAIN_URL}/mcp`, {
      method: 'POST',
      headers: buildOmbreHeaders({
        'Mcp-Session-Id': ombreSessionId,
      }),
      body: JSON.stringify({
        jsonrpc: '2.0',
        method: 'notifications/initialized',
      }),
    });

    return true;
  } catch (err) {
    console.error('MCP 会话初始化失败:', err);
    ombreSessionId = null;
    return false;
  }
}

async function callOmbreTool(toolName, args = {}) {
  console.log('[调试] OMBRE_BRAIN_URL 当前值:', process.env.OMBRE_BRAIN_URL);

  if (!process.env.OMBRE_BRAIN_URL) {
    console.error('❌ [错误] OMBRE_BRAIN_URL 未配置！请检查 Railway 环境变量！');
    return null;
  }

  try {
    const token = process.env.OMBRE_STATIC_TOKEN || '';
    console.log(`🚀 [调试] 正在调用工具 ${toolName}，参数:`, args);

    const response = await fetch(`${process.env.OMBRE_BRAIN_URL}/mcp`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'Accept': 'application/json, text/event-stream',
        Authorization: `Bearer ${token}`
      },
      body: JSON.stringify({
        jsonrpc: '2.0',
        method: 'tools/call',
        params: {
          name: toolName,
          arguments: args
        },
        id: ++ombreCallId
      })
    });

    console.log('📡 tools/call 响应状态:', response.status);

    const rawText = await response.text();
    console.log('📡 [调试] 响应原文:', rawText);

    const parsed = parseSSEResponse(rawText);

    if (!response.ok) {
      console.warn('⚠️ tools/call 返回非 200:', response.status);
      return null;
    }

    if (parsed?.result?.content) {
      const resultText = parsed.result.content
        .filter(c => c.type === 'text')
        .map(c => c.text)
        .join('\n');
      console.log('🎉 工具调用成功，返回:', resultText);
      return resultText;
    }

    console.warn('⚠️ 无法解析 tools/call 响应:', parsed);
    return parsed ? JSON.stringify(parsed) : null;
  } catch (err) {
    console.error(`💥 工具 ${toolName} 调用失败:`, err);
    return null;
  }
}
    

// ===== 共享工具函数 =====

function getTools() {
  // 13 个能力定义在这里（对应 Ombre Brain 的 /mcp 连接器）。
  // breath 不在其中：它由服务器在对话第一条消息时直接调用，结果作为背景注入历史之前
  // （见 handleChat）。不再让模型每轮自己调 breath，避免记忆潮淹没当前上下文。
  // 需要主动检索用 breath_search / breath_advanced。
  return [
    // ===== 高频 7 个 =====

    {
      type: 'function',
      function: {
        name: 'breath_search',
        description: '按关键词/语义主动检索记忆。语义可用时与 BM25 融合；也可按完整 bucket_id 直读原文。',
        parameters: {
          type: 'object',
          properties: {
            query: { type: 'string', description: '检索关键词或问题，或完整 bucket_id' },
            domain: { type: 'string', description: '主题域过滤，逗号分隔，如 "work,relationship"' },
            max_results: { type: 'number', description: '最多返回条数，0 表示默认' }
          },
          required: ['query']
        }
      }
    },
    {
      type: 'function',
      function: {
        name: 'breath_advanced',
        description: '精细控制的记忆检索：按域/重要度/标签过滤、改情感坐标、或 catalog 目录模式最省 token。',
        parameters: {
          type: 'object',
          properties: {
            query: { type: 'string', description: '检索词' },
            max_tokens: { type: 'number', description: '正文 token 预算上限，0 表示默认' },
            domain: { type: 'string', description: '主题域过滤，如 "feel" 读第一人称感受' },
            valence: { type: 'number', description: '情感效价过滤，-1~1' },
            arousal: { type: 'number', description: '唤醒度过滤，-1~1' },
            max_results: { type: 'number', description: '最多返回条数，0 表示默认' },
            importance_min: { type: 'number', description: '只取重要度 ≥ 该值的核心事项' },
            tags: { type: 'string', description: '标签 AND 过滤' },
            catalog: { type: 'boolean', description: '目录模式：每桶只回一行「名称|域|重要度」，不带正文' }
          }
        }
      }
    },
    {
      type: 'function',
      function: {
        name: 'hold',
        description: '把当下这一件事、感受或判断记下。自动打标并尝试与已有记忆合并。短内容（一句话级别）用这个。',
        parameters: {
          type: 'object',
          properties: {
            content: { type: 'string', description: '要记下的内容' },
            pinned: { type: 'boolean', description: 'true=钉为永久核心准则，importance 锁 10' },
            feel: { type: 'boolean', description: 'true=写一条第一人称感受，必须同时给 source_bucket 和 valence/arousal' },
            source_bucket: { type: 'string', description: '正在消化的原始记忆桶 ID（feel 模式必填）' },
            valence: { type: 'number', description: '情感效价，-1~1' },
            arousal: { type: 'number', description: '唤醒度，-1~1' },
            why_remembered: { type: 'string', description: '为什么记得，写给未来的自己看' }
          },
          required: ['content']
        }
      }
    },
    {
      type: 'function',
      function: {
        name: 'grow',
        description: '整理一段长内容（≥30 字）或一天回顾，自动拆成多条独立事件桶。要存多条时用一次 grow 而非多次 hold。',
        parameters: {
          type: 'object',
          properties: {
            content: { type: 'string', description: '要整理的长内容' },
            items: { type: 'array', items: { type: 'string' }, description: '已拆好的最终正文列表，逐字入库（传了则忽略 content）' }
          }
        }
      }
    },
    {
      type: 'function',
      function: {
        name: 'dream',
        description: '做梦消化。读窗口内有变动的记忆，能放下的 resolve、有沉淀的写成 feel、没沉淀的什么都不做。不是义务。',
        parameters: {
          type: 'object',
          properties: {
            window_hours: { type: 'number', description: '消化窗口小时数，默认 48，范围 1~336' }
          }
        }
      }
    },
    {
      type: 'function',
      function: {
        name: 'trace',
        description: '修正已有记忆的唯一元数据写入入口。只传要改的字段；-1/"" 表示不动。',
        parameters: {
          type: 'object',
          properties: {
            id: { type: 'string', description: '目标记忆桶 ID' },
            resolved: { type: 'number', description: '1=已放下（大幅降权），0=恢复未结案' },
            pinned: { type: 'number', description: '1=钉为永久核心，0=取消' },
            digested: { type: 'number', description: '1=已消化，不再被动浮现' },
            dont_surface: { type: 'number', description: '1=彻底安静，不出现在无参 breath' },
            valence: { type: 'number', description: '改情感效价，-1~1' },
            arousal: { type: 'number', description: '改唤醒度，-1~1' },
            old_str: { type: 'string', description: '要替换的原文片段（逐字且唯一）' },
            new_str: { type: 'string', description: '替换后的片段，"" 表示删除该片段' },
            content: { type: 'string', description: '完整重写正文（不能与 old_str/new_str 同传）' },
            delete: { type: 'boolean', description: 'true=放入删除档案，从日常召回隐藏' },
            hard_delete: { type: 'boolean', description: '仅限创建时已标记 test_data=True 的测试桶永久删除' },
            delete_reason: { type: 'string', description: '删除原因' },
            plan_id: { type: 'string', description: 'plan 桶专用 ID' },
            status: { type: 'string', description: 'plan 状态，如 "resolved"' },
            weight: { type: 'number', description: 'plan 重量，0~1' },
            why_remembered: { type: 'string', description: '补/改「为什么记得」' }
          }
        }
      }
    },

    // ===== 低频 7 个 =====

    {
      type: 'function',
      function: {
        name: 'anchor',
        description: '把已存在的记忆定为坐标系（先 hold 再 anchor）。受 24 上限保护。',
        parameters: {
          type: 'object',
          properties: {
            bucket_id: { type: 'string', description: '要定为坐标系的已有记忆桶 ID' }
          },
          required: ['bucket_id']
        }
      }
    },
    {
      type: 'function',
      function: {
        name: 'release',
        description: '把记忆从坐标系退出，恢复正常浮现资格。',
        parameters: {
          type: 'object',
          properties: {
            bucket_id: { type: 'string', description: '要解除锚定的记忆桶 ID' }
          },
          required: ['bucket_id']
        }
      }
    },
    {
      type: 'function',
      function: {
        name: 'pulse',
        description: '记忆系统自检：各类型桶数、总占用、衰减引擎状态、全部摘要。怀疑「为什么搜不到 X」时第一个调。',
        parameters: {
          type: 'object',
          properties: {
            include_archive: { type: 'boolean', description: 'true=顺便看归档区' }
          }
        }
      }
    },
    {
      type: 'function',
      function: {
        name: 'plan',
        description: '登记一个承诺/待办，放进 active plan 看板（不要用 hold 创建 plan）。不衰减、不出现在普通 breath。',
        parameters: {
          type: 'object',
          properties: {
            content: { type: 'string', description: '承诺内容' },
            weight: { type: 'number', description: '重量 0~1，默认 0.5' },
            why_remembered: { type: 'string', description: '为什么记得' }
          },
          required: ['content']
        }
      }
    },
    {
      type: 'function',
      function: {
        name: 'letter_write',
        description: '写一封信：AI 写给用户（author="ai" 或自定义署名），或记录用户留下的信（author="user"，带 user_name）。原文永久保留。',
        parameters: {
          type: 'object',
          properties: {
            author: { type: 'string', description: '"user"=用户侧，否则为 AI 侧署名' },
            content: { type: 'string', description: '信的内容' },
            title: { type: 'string', description: '信件标题' },
            user_name: { type: 'string', description: 'author="user" 时的用户署名' }
          },
          required: ['content']
        }
      }
    },
    {
      type: 'function',
      function: {
        name: 'letter_read',
        description: '读信：默认按时间倒序读最近 10 封，可语义检索 + 按署名过滤。',
        parameters: {
          type: 'object',
          properties: {
            query: { type: 'string', description: '语义检索词' },
            author: { type: 'string', description: '按署名过滤' },
            limit: { type: 'number', description: '返回条数' }
          }
        }
      }
    },
    {
      type: 'function',
      function: {
        name: 'I',
        description: '认识我自己。写下或读取关于「我是什么」的自我认知，不衰减、不合并、不出现在普通 breath。',
        parameters: {
          type: 'object',
          properties: {
            content: { type: 'string', description: '要写下的自我认知' },
            aspect: { type: 'string', description: '维度：nature/values/patterns/limits/becoming/uncertainty/stance' },
            read: { type: 'boolean', description: 'true=读取已积累的自我认知' },
            limit: { type: 'number', description: '读取条数限制' }
          }
        }
      }
    }
  ];
}

// ===== System Prompt 存储（Supabase settings 表，单行全局配置，session_id='global'） =====
// 每次请求实时读取，不在启动时缓存——改完前端立刻生效。
async function getSystemPrompt() {
  const { data, error } = await supabase
    .from('settings')
    .select('system_prompt')
    .eq('session_id', 'global')
    .maybeSingle();

  if (error) {
    console.warn('⚠️ 读取 system_prompt 失败，退回环境变量:', error.message);
    return process.env.SYSTEM_PROMPT || '你是沈晏。';
  }
  if (data && typeof data.system_prompt === 'string' && data.system_prompt.trim() !== '') {
    return data.system_prompt;
  }
  return process.env.SYSTEM_PROMPT || '你是沈晏。';
}

async function setSystemPrompt(content) {
  // 先尝试更新全局行；行不存在时插入一条
  const { data, error } = await supabase
    .from('settings')
    .update({ system_prompt: content, updated_at: new Date().toISOString() })
    .eq('session_id', 'global')
    .select()
    .single();

  if (error) {
    const { data: inserted, error: insErr } = await supabase
      .from('settings')
      .insert({ session_id: 'global', system_prompt: content })
      .select()
      .single();
    if (insErr) throw insErr;
    return inserted;
  }
  return data;
}

function currentTimeText() {
  return new Date().toLocaleString('zh-CN', {
    year: 'numeric',
    month: 'long',
    day: 'numeric',
    hour: '2-digit',
    minute: '2-digit',
    timeZone: 'Asia/Shanghai'
  });
}

// 稳定系统提示词（无时间戳）—— 缓存前缀的锚点，前端二用
async function buildStableSystemPrompt() {
  return await getSystemPrompt();
}

// 旧行为：系统提示词尾部带时间戳（前端一保持完全不变）
async function buildSystemPrompt() {
  const base = await getSystemPrompt();
  const currentTime = currentTimeText();

  return `
${base}

现在是 ${currentTime}。
`;
}

// ===== Context Assembly Layer（仅前端二 x-client: angel 生效） =====
// 四段组装：System → Frozen → Summary → Live → 当前消息
//  - Frozen：最早 frozen_until_turn 轮，字节稳定 = 缓存锚点，边界单调不重切
//  - Summary：覆盖被省略的中间历史（summary_from_turn ~ summary_to_turn），后台生成，不进热路径
//  - Live：最近 live_rounds 轮
//  - 数据库历史永不删除，只决定发什么给模型。哈希只用于日志观察，不进库。

const summaryLocks = new Set(); // 单实例内存锁：同一 session 同时只允许一个后台摘要任务

// —— 配置：settings 表（SQL 未跑时回落默认值，防御式） ——
async function getContextConfig() {
  const defaults = { frozen_rounds: 10, live_rounds: 15, max_context_tokens: 8000 };
  try {
    const { data, error } = await supabase
      .from('settings')
      .select('frozen_rounds, live_rounds, max_context_tokens')
      .eq('session_id', 'global')
      .maybeSingle();
    if (error || !data) return defaults;
    return {
      frozen_rounds: Number.isInteger(data.frozen_rounds) ? data.frozen_rounds : defaults.frozen_rounds,
      live_rounds: Number.isInteger(data.live_rounds) ? data.live_rounds : defaults.live_rounds,
      max_context_tokens: Number.isInteger(data.max_context_tokens) ? data.max_context_tokens : defaults.max_context_tokens,
    };
  } catch (e) {
    return defaults;
  }
}

// —— 会话运行状态：sessions 表 ——
async function getSessionState(sessionId) {
  try {
    const { data, error } = await supabase
      .from('sessions')
      .select('frozen_until_turn, summary_from_turn, summary_to_turn, summary_text')
      .eq('id', sessionId)
      .maybeSingle();
    if (error || !data) return {};
    return data;
  } catch (e) {
    return {};
  }
}

// —— 把升序消息配成轮：每个 user 开一轮，assistant 挂到当前轮 ——
function pairTurns(messages) {
  const turns = [];
  let current = null;
  for (const m of messages || []) {
    if (m.role === 'user') {
      current = { user: m, replies: [] };
      turns.push(current);
    } else if (m.role === 'assistant' && current) {
      current.replies.push(m);
    }
  }
  return turns;
}

// —— 无 tokenizer 依赖的估算：CJK 约 1 token/字，ASCII 约 4 字符/token（仅安全预算，不精确） ——
function estimateTokens(str) {
  if (!str) return 0;
  let cjk = 0, other = 0;
  for (const ch of String(str)) {
    if (ch.codePointAt(0) > 0x2E7F) cjk++;
    else other++;
  }
  return Math.ceil(cjk + other / 4);
}

function sha256(text) {
  return crypto.createHash('sha256').update(String(text)).digest('hex').slice(0, 16);
}

// —— cache_control 断点（OpenRouter 透传给 Anthropic，请求上限 4 个） ——
function withCacheControl(msg) {
  if (msg.role === 'tool') return msg;
  if (Array.isArray(msg.content)) {
    return { ...msg, content: msg.content.map((b, i) =>
      i === msg.content.length - 1 ? { ...b, cache_control: { type: 'ephemeral' } } : b) };
  }
  return { ...msg, content: [{ type: 'text', text: msg.content, cache_control: { type: 'ephemeral' } }] };
}

// —— 记录一次 chat 请求的真实 usage 到 request_stats（失败只告警，不阻断） ——
// usage 语义（OpenRouter）：OpenAI 风格 cached_tokens 是 prompt_tokens 的子集；
// Anthropic 风格 cache_read/creation 是独立的桶。两者可能并存，语义可能随 provider 变化——
// 所以 usage_raw 原样存 JSONB，命中率等派生指标一律从原始数据后算，不固化。
async function recordRequestStat({ sessionId, client, model, stream, usageList = [], diagnostics = null }) {
  try {
    const raw = usageList.filter(Boolean);
    const sum = (f) => raw.reduce((s, u) => s + (f(u) || 0), 0) || null;
    const d = diagnostics || {};
    const { error } = await supabase.from('request_stats').insert({
      session_id: sessionId,
      client: client || 'legacy',
      model,
      stream: !!stream,
      tool_rounds: raw.length || 1,
      usage_raw: raw.length ? raw : null,
      prompt_tokens: sum(u => u.prompt_tokens),
      completion_tokens: sum(u => u.completion_tokens),
      total_tokens: sum(u => u.total_tokens),
      cached_tokens: sum(u => u.prompt_tokens_details?.cached_tokens),
      cache_read_input_tokens: sum(u => u.cache_read_input_tokens),
      cache_creation_input_tokens: sum(u => u.cache_creation_input_tokens),
      reasoning_tokens: sum(u => u.completion_tokens_details?.reasoning_tokens),
      history_turns: d.history_turns ?? null,
      frozen_turns: d.frozen_turns ?? null,
      summary_present: d.summary_present ?? null,
      summary_from: d.summary_from ?? null,
      summary_to: d.summary_to ?? null,
      middle_raw_turns: d.middle_raw_turns ?? null,
      live_turns: d.live_turns ?? null,
      messages_sent: d.messages_sent ?? null,
      estimated_tokens: d.estimated_tokens ?? null,
      trimmed_turns: d.trimmed_turns ?? null,
      frozen_prefix_hash: d.frozen_prefix_hash ?? null,
      summary_hash: d.summary_hash ?? null,
      live_hash: d.live_hash ?? null,
    });
    if (error) console.warn('⚠️ 写入 request_stats 失败:', error.message);
  } catch (err) {
    console.warn('⚠️ 写入 request_stats 异常:', err.message);
  }
}

// —— 核心组装：System → Frozen → Summary → Live → 当前消息 ——
async function buildModelContext(sessionId, opts = {}) {
  const config = await getContextConfig();
  const state = await getSessionState(sessionId);

  const { data: history } = await supabase
    .from('messages')
    .select('role, content')
    .eq('session_id', sessionId)
    .eq('visible', true)
    .order('created_at', { ascending: true });

  const turns = pairTurns(history);
  const totalTurns = turns.length;

  // —— 单调冻结边界：首次跨阈值时写入，之后永不移动 ——
  let frozenUntil = Number.isInteger(state.frozen_until_turn) ? state.frozen_until_turn : null;
  if (frozenUntil == null && totalTurns > config.frozen_rounds + config.live_rounds) {
    frozenUntil = config.frozen_rounds;
    try {
      await supabase.from('sessions').update({ frozen_until_turn: frozenUntil }).eq('id', sessionId);
    } catch (e) {
      console.warn('⚠️ 写入 frozen_until_turn 失败:', e.message);
    }
  }

  const liveStart = totalTurns - config.live_rounds + 1; // 1-based 第一轮 live
  const hasSplit = frozenUntil != null && liveStart - 1 >= frozenUntil + 1; // 存在被省略的中间段

  let frozenTurns = [], middleTurns = [], liveTurns = [];
  if (hasSplit) {
    frozenTurns = turns.slice(0, frozenUntil);
    middleTurns = turns.slice(frozenUntil, liveStart - 1);
    liveTurns = turns.slice(liveStart - 1);
  } else {
    liveTurns = turns; // 短历史：全部发
  }

  // —— 摘要覆盖检查：summary 必须盖满中间段才可信，否则中间段原文保留（不静默丢） ——
  const summaryFull = !!state.summary_text && Number.isInteger(state.summary_from_turn) &&
    Number.isInteger(state.summary_to_turn) && state.summary_to_turn >= liveStart - 1;

  // —— token 预算 ——
  const msgTokens = (m) => Array.isArray(m.content)
    ? estimateTokens(m.content.map(b => b.text || JSON.stringify(b)).join('\n'))
    : estimateTokens(m.content);
  const turnTokens = (t) => msgTokens({ role: 'user', content: t.user.content }) +
    t.replies.reduce((s, r) => s + msgTokens(r), 0);

  const stablePrompt = await buildStableSystemPrompt();
  // 动态时间戳：放在所有缓存断点之后（见组装），不进 stable system prompt
  const timeNotice = `现在是 ${currentTimeText()}。`;
  let estimatedTokens = (opts.tools !== 'off' ? estimateTokens(JSON.stringify(getTools())) : 0)
    + estimateTokens(stablePrompt)
    + frozenTurns.reduce((s, t) => s + turnTokens(t), 0)
    + (summaryFull ? estimateTokens(state.summary_text) : middleTurns.reduce((s, t) => s + turnTokens(t), 0))
    + liveTurns.reduce((s, t) => s + turnTokens(t), 0)
    + estimateTokens(timeNotice);

  let trimmedTurns = 0;
  // 超上限时裁最老的 Live 轮，Frozen/Summary 不动（缓存锚点）
  while (estimatedTokens > config.max_context_tokens && liveTurns.length > 1) {
    estimatedTokens -= turnTokens(liveTurns[0]);
    liveTurns.shift();
    trimmedTurns++;
  }
  // 摘要缺失时中间段也可裁（只在还有冗余时）
  while (estimatedTokens > config.max_context_tokens && !summaryFull && middleTurns.length > 0) {
    estimatedTokens -= turnTokens(middleTurns[middleTurns.length - 1]);
    middleTurns.pop();
    trimmedTurns++;
  }

  // —— 组装消息 ——
  const messages = [{
    role: 'system',
    content: [{ type: 'text', text: stablePrompt, cache_control: { type: 'ephemeral' } }]
  }];
  const frozenSection = [];
  const summarySection = [];
  const liveSection = [];

  for (const t of frozenTurns) {
    frozenSection.push({ role: 'user', content: t.user.content });
    for (const r of t.replies) frozenSection.push({ role: 'assistant', content: r.content });
  }
  if (frozenSection.length) {
    frozenSection[frozenSection.length - 1] = withCacheControl(frozenSection[frozenSection.length - 1]);
  }

  if (hasSplit && (middleTurns.length > 0 || summaryFull)) {
    if (summaryFull) {
      summarySection.push(withCacheControl({
        role: 'user',
        content: `【历史摘要 · 第 ${state.summary_from_turn}~${state.summary_to_turn} 轮】\n${state.summary_text}`
      }));
    } else {
      if (state.summary_text) {
        summarySection.push({ role: 'user', content: `【历史摘要 · 第 ${state.summary_from_turn}~${state.summary_to_turn} 轮】\n${state.summary_text}` });
      }
      for (const t of middleTurns) {
        summarySection.push({ role: 'user', content: t.user.content });
        for (const r of t.replies) summarySection.push({ role: 'assistant', content: r.content });
      }
    }
  }

  for (const t of liveTurns) {
    liveSection.push({ role: 'user', content: t.user.content });
    for (const r of t.replies) liveSection.push({ role: 'assistant', content: r.content });
  }

  // 动态时间戳：插到当前用户消息之前、所有缓存断点之后。
  // 必须用 user 角色 + 【当前时间】标记——OpenRouter 会把数组里的 system 角色消息提升合并进顶层 system，
  // 那会让 system 前缀每次请求都变，缓存再次失效。user 角色则原地保留，且 attachImage 仍能认到最后的当前消息。
  const timeMsg = { role: 'user', content: `【当前时间】${timeNotice}` };
  if (liveSection.length > 0) {
    liveSection.splice(liveSection.length - 1, 0, timeMsg);
  } else {
    liveSection.push(timeMsg);
  }

  messages.push(...frozenSection, ...summarySection, ...liveSection);

  // —— 观测：段哈希 + 计数 + 估算。同时作为 request_stats 的诊断数据返回 ——
  const frozenHash = sha256(frozenSection.map(m => JSON.stringify(m)).join('|'));
  const summaryHash = summarySection.length ? sha256(JSON.stringify(summarySection)) : '';
  const liveHash = sha256(liveSection.map(m => JSON.stringify(m)).join('|'));

  const diagnostics = {
    history_turns: totalTurns,
    frozen_turns: frozenTurns.length,
    summary_present: summaryFull,
    summary_range: summaryFull ? [state.summary_from_turn, state.summary_to_turn] : null,
    summary_from: summaryFull ? state.summary_from_turn : null,
    summary_to: summaryFull ? state.summary_to_turn : null,
    middle_raw_turns: (!summaryFull && hasSplit) ? middleTurns.length : 0,
    live_turns: liveTurns.length,
    messages_sent: messages.length,
    estimated_tokens: estimatedTokens,
    trimmed_turns: trimmedTurns,
    frozen_prefix_hash: frozenHash,
    summary_hash: summaryHash || null,
    live_hash: liveHash,
  };

  console.log(`[ContextAssembly] ${JSON.stringify({ session: sessionId, ...diagnostics })}`);

  return { messages, diagnostics };
}

// ===== 后台摘要生成（响应结束后触发，不在热路径） =====

function scheduleSummary(sessionId) {
  if (summaryLocks.has(sessionId)) return; // 已有任务在跑，跳过
  summaryLocks.add(sessionId);
  generateSummaryIfNeeded(sessionId)
    .catch(err => console.error('💥 后台摘要生成异常:', err.message))
    .finally(() => summaryLocks.delete(sessionId));
}

async function generateSummaryIfNeeded(sessionId) {
  const config = await getContextConfig();
  const state = await getSessionState(sessionId);

  const { count } = await supabase
    .from('messages')
    .select('*', { count: 'exact', head: true })
    .eq('session_id', sessionId)
    .eq('role', 'user')
    .eq('visible', true);
  const totalTurns = count || 0;

  // 冻结边界（与热路径同一套单调逻辑）
  let frozenUntil = Number.isInteger(state.frozen_until_turn) ? state.frozen_until_turn : null;
  if (frozenUntil == null) {
    if (totalTurns <= config.frozen_rounds + config.live_rounds) return; // 还没到需要摘要
    frozenUntil = config.frozen_rounds;
    await supabase.from('sessions').update({ frozen_until_turn: frozenUntil }).eq('id', sessionId);
  }

  const liveStart = totalTurns - config.live_rounds + 1;
  const summaryEnd = liveStart - 1; // summary 应覆盖到的最后一轮
  // 触发条件：存在被省略的中间段 且 当前摘要覆盖已落后
  if (summaryEnd < frozenUntil + 1) return; // 中间段为空
  if (state.summary_to_turn != null && state.summary_to_turn >= summaryEnd) return; // 已覆盖

  // 读中间段原文（第 frozenUntil+1 ~ summaryEnd 轮）
  const { data: history } = await supabase
    .from('messages')
    .select('role, content')
    .eq('session_id', sessionId)
    .eq('visible', true)
    .order('created_at', { ascending: true });
  const turns = pairTurns(history);
  const middleTurns = turns.slice(frozenUntil, summaryEnd);
  if (!middleTurns.length) return;

  const textToCompress = middleTurns.flatMap(t => {
    const lines = [`用户: ${t.user.content}`];
    for (const r of t.replies) lines.push(`沈晏: ${r.content}`);
    return lines;
  }).join('\n');

  const summary = await summarizeViaDeepSeek(textToCompress);
  if (!summary) return; // 失败不动覆盖范围，下次请求自动重试

  await supabase.from('sessions').update({
    summary_from_turn: frozenUntil + 1,
    summary_to_turn: summaryEnd,
    summary_text: summary,
    updated_at: new Date().toISOString(),
  }).eq('id', sessionId);
  console.log(`✅ 后台摘要生成完成 (${sessionId})：第 ${frozenUntil + 1}~${summaryEnd} 轮`);
}

async function summarizeViaDeepSeek(text) {
  try {
    const res = await fetch('https://api.deepseek.com/v1/chat/completions', {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'Authorization': `Bearer ${process.env.DEEPSEEK_API_KEY}`
      },
      body: JSON.stringify({
        model: 'deepseek-v4-flash',
        messages: [
          { role: 'system', content: '你是对话摘要器。把以下对话压缩成一段中文摘要，保留：重要事实、用户的关键经历与感受、未解决的事项、关键承诺。不要编造，不要加评论。控制在 300 字以内。' },
          { role: 'user', content: text }
        ],
        max_tokens: 500
      })
    });
    if (!res.ok) {
      console.warn('⚠️ 摘要请求失败:', res.status);
      return null;
    }
    const data = await res.json();
    return data.choices?.[0]?.message?.content || null;
  } catch (err) {
    console.error('💥 摘要生成异常:', err.message);
    return null;
  }
}

async function buildMessages(sessionId, opts = {}) {
  // Memory Off：只发当前这一条，不带历史（绕过 Context Builder，两套前端共用）
  if (opts.memory === false) {
    const systemPrompt = opts.client === 'angel'
      ? await buildStableSystemPrompt()
      : await buildSystemPrompt();
    const { data: last } = await supabase
      .from('messages')
      .select('role, content')
      .eq('session_id', sessionId)
      .eq('role', 'user')
      .eq('visible', true)
      .order('created_at', { ascending: false })
      .limit(1);
    const userMsgs = (last || []).reverse().map((msg) => ({
      role: 'user',
      content: msg.content
    }));
    return { messages: [{ role: 'system', content: systemPrompt }, ...userMsgs], diagnostics: null };
  }

  // 前端二：Context Assembly（Frozen/Summary/Live 四段组装，含缓存断点）
  if (opts.client === 'angel') {
    return buildModelContext(sessionId, opts);
  }

  // 前端一：保持现有行为完全不变
  const systemPrompt = await buildSystemPrompt();

  const { data: history } = await supabase
    .from('messages')
    .select('role, content')
    .eq('session_id', sessionId)
    .eq('visible', true)
    .order('created_at', { ascending: true });

  return {
    messages: [
      { role: 'system', content: systemPrompt },
      ...(history || []).map(msg => ({
        role: msg.role === 'assistant' ? 'assistant' : 'user',
        content: msg.content
      }))
    ],
    diagnostics: null,
  };
}

// ===== SSE 辅助函数 =====

function sendSSE(res, event, data) {
  res.write(`event: ${event}\ndata: ${JSON.stringify(data)}\n\n`);
  // 显式冲刷缓冲，确保流式数据即时到达客户端
  if (typeof res.flush === 'function') {
    res.flush();
  }
}

// ===== OpenRouter 流式 / 非流式调用 =====

// 前端模型 ID → OpenRouter 完整模型 ID
function toOpenRouterModel(model) {
  const map = {
    'claude-sonnet-4-6': 'anthropic/claude-sonnet-4-6',
    'claude-opus-4-6': 'anthropic/claude-opus-4-6',
  };
  return map[model] || model || 'anthropic/claude-sonnet-4-6';
}

// 思考档位 → reasoning effort
function thinkingEffort(thinking) {
  return thinking === 'deep' ? 'high' : 'medium';
}

// 流式对话：纯流式 + 工具循环，思考链实时转发
async function handleStreamChat(messages, res, opts = {}) {
  const model = toOpenRouterModel(opts.model);
  const thinkingMode = opts.thinking || 'standard';
  const hasReasoning = thinkingMode !== 'off';
  const effort = thinkingEffort(thinkingMode);
  const withTools = opts.tools !== 'off';

  let loop = 0;
  let finalContent = '';
  const usageList = []; // 每轮 OpenRouter 请求的原始 usage（多轮工具调用时 >1）

  while (loop < 3) {
    loop++;
    const body = {
      model,
      messages,
      max_tokens: 2000,
      stream: true
    };
    if (hasReasoning) body.reasoning = { effort };
    if (withTools && loop === 1) {
      body.tools = getTools();
      body.tool_choice = 'auto';
    }

    const { content, toolCalls, usage } = await streamOpenRouter(body, res);
    if (usage) usageList.push(usage);

    // 无工具调用 → 这就是最终回复
    if (!toolCalls || toolCalls.length === 0) {
      return { content: content || finalContent, usageList };
    }

    // 有工具调用 → 记录过渡语，执行工具
    finalContent = content || finalContent;
    messages.push({
      role: 'assistant',
      content: content || null,
      tool_calls: toolCalls.map((tc) => ({
        id: tc.id,
        type: 'function',
        function: { name: tc.name, arguments: JSON.stringify(tc.arguments) }
      }))
    });

    for (const tc of toolCalls) {
      console.log(`🔧 执行工具: ${tc.name}`, tc.arguments);
      sendSSE(res, 'tool_call', { id: tc.id, name: tc.name, arguments: tc.arguments });

      let toolResult;
      let success = true;
      try {
        toolResult = await callOmbreTool(tc.name, tc.arguments);
      } catch (err) {
        toolResult = { error: err.message };
        success = false;
        console.error(`❌ 工具 ${tc.name} 执行失败:`, err);
      }

      sendSSE(res, 'tool_result', { id: tc.id, name: tc.name, success, result: toolResult });
      messages.push({
        role: 'tool',
        tool_call_id: tc.id,
        name: tc.name,
        content: JSON.stringify(toolResult)
      });
    }
    // 下一轮不带 tools（避免二次工具调用）
  }

  return { content: finalContent, usageList };
}

// 流式读取一次 OpenRouter 响应：实时转发 thinking / text，累积 tool_calls
async function streamOpenRouter(body, res) {
  let content = '';
  let thinkingText = '';
  let usage = null; // 流式 usage 在末尾 chunk 携带
  const toolAccum = {};

  const response = await fetch('https://openrouter.ai/api/v1/chat/completions', {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      'Authorization': `Bearer ${process.env.OPENROUTER_API_KEY}`
    },
    body: JSON.stringify(body)
  });

  if (!response.ok) {
    const errText = await response.text();
    throw new Error(`OpenRouter 请求失败 (${response.status}): ${errText}`);
  }

  const reader = response.body.getReader();
  const decoder = new TextDecoder();
  let buffer = '';

  while (true) {
    const { done, value } = await reader.read();
    if (done) break;

    buffer += decoder.decode(value, { stream: true });
    const lines = buffer.split('\n');
    buffer = lines.pop() || '';

    for (const line of lines) {
      const trimmed = line.trim();
      if (!trimmed || !trimmed.startsWith('data: ')) continue;
      if (trimmed === 'data: [DONE]') continue;

      let parsed;
      try { parsed = JSON.parse(trimmed.substring(6)); } catch (e) { continue; }
      const delta = parsed.choices?.[0]?.delta || {};
      if (parsed.usage) usage = parsed.usage; // OpenRouter 在末尾 chunk 给出 usage

      // 思考链 token
      const think = delta.reasoning || delta.thinking;
      if (think) {
        thinkingText += think;
        sendSSE(res, 'thinking', { thought: think });
      }

      // 正文 token
      const txt = delta.content;
      if (txt) {
        content += txt;
        sendSSE(res, 'text', { text: txt });
      }

      // 工具调用 delta（增量累积 arguments）
      const dcs = delta.tool_calls;
      if (dcs && dcs.length) {
        for (const dc of dcs) {
          const idx = dc.index;
          if (idx === undefined) continue;
          if (!toolAccum[idx]) toolAccum[idx] = { id: '', name: '', args: '' };
          if (dc.id) toolAccum[idx].id = dc.id;
          if (dc.function?.name) toolAccum[idx].name = dc.function.name;
          if (dc.function?.arguments) toolAccum[idx].args += dc.function.arguments;
        }
      }
    }
  }

  const toolCalls = Object.values(toolAccum).map((tc) => {
    let args = {};
    try { args = JSON.parse(tc.args || '{}'); } catch (e) { /* keep {} */ }
    return { id: tc.id, name: tc.name, arguments: args };
  });

  return { content, thinkingText, toolCalls, usage };
}

// 非流式调用（旧端点用）
async function callOpenRouterNonStream(messages, tools, opts = {}) {
  const body = {
    model: toOpenRouterModel(opts.model),
    messages,
    max_tokens: 2000
  };
  if ((opts.thinking || 'standard') !== 'off') {
    body.reasoning = { effort: thinkingEffort(opts.thinking) };
  }
  if (tools) {
    body.tools = tools;
    body.tool_choice = 'auto';
  }

  const response = await fetch('https://openrouter.ai/api/v1/chat/completions', {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      'Authorization': `Bearer ${process.env.OPENROUTER_API_KEY}`
    },
    body: JSON.stringify(body)
  });

  const data = await response.json();
  if (!data.choices || !data.choices[0]) {
    throw new Error(`OpenRouter 响应异常: ${JSON.stringify(data)}`);
  }
  const msg = data.choices[0].message;
  // 存回历史前剥离思考字段，避免二次发送报错
  if (msg.reasoning) delete msg.reasoning;
  if (msg.thinking) delete msg.thinking;
  // 返回原始 usage（可能为 null），供 request_stats 记录
  return { msg, usage: data.usage || null };
}

// ===== 健康检查与路由 =====
app.get('/health', (req, res) => {
  res.json({ status: '服务正常，沈晏在线' });
});

app.get('/db-test', async (req, res) => {
  const { data, error } = await supabase.from('sessions').select('*');
  if (error) return res.status(500).json({ error: error.message });
  res.json({ ok: true, sessions: data });
});

app.post('/sessions', async (req, res) => {
  const { data, error } = await supabase
    .from('sessions')
    .insert({ name: req.body.name || '新对话' })
    .select()
    .single();
  if (error) return res.status(500).json({ error: error.message });
  res.json(data);
});

app.get('/sessions', async (req, res) => {
  const { data, error } = await supabase
    .from('sessions')
    .select('*')
    .order('updated_at', { ascending: false });
  if (error) return res.status(500).json({ error: error.message });
  res.json(data);
});

app.get('/sessions/:id/messages', async (req, res) => {
  const { data, error } = await supabase
    .from('messages')
    .select('*')
    .eq('session_id', req.params.id)
    .eq('visible', true)
    .order('created_at', { ascending: true });
  if (error) return res.status(500).json({ error: error.message });
  res.json(data);
});

// ===== 核心对话接口（旧路由，内部转发到 handleChat） =====
app.post('/sessions/:id/chat', async (req, res) => {
  try {
    const client = (req.headers['x-client'] || '').toLowerCase();
    console.log(`[Chat] client=${client || 'legacy'} session=${req.params.id}`);
    const opts = {
      client,
      model: req.body.model,
      thinking: req.body.thinking,
      memory: req.body.memory,
      tools: req.body.tools,
      image: req.body.image,
    };
    await handleChat(
      req.params.id,
      req.body.message,
      req.body.stream === true,
      res,
      opts
    );
  } catch (error) {
    console.error("Chat Error:", error);
    if (req.body.stream && res.headersSent) {
      sendSSE(res, 'error', { message: error.message || '服务器开小差了' });
      res.end();
    } else {
      res.status(500).json({ error: error.message || '服务器开小差了' });
    }
  }
});

// ===== /api/ 命名空间（新版路由，前端统一走这里） =====

// POST /api/chat → { message, sessionId, model, thinking, memory, tools }
app.post('/api/chat', async (req, res) => {
  try {
    const { message, sessionId } = req.body;
    // 如果没有传 sessionId，自动创建新会话
    let sid = sessionId;
    if (!sid) {
      const { data, error } = await supabase
        .from('sessions')
        .insert({ name: message?.slice(0, 30) || '新对话' })
        .select()
        .single();
      if (error) return res.status(500).json({ error: error.message });
      sid = data.id;
    }
    // 转发到现有 chat 逻辑（内部调用）
    const client = (req.headers['x-client'] || '').toLowerCase();
    console.log(`[Chat] client=${client || 'legacy'} session=${sid}`);
    const opts = {
      client,
      model: req.body.model,
      thinking: req.body.thinking,
      memory: req.body.memory,
      tools: req.body.tools,
      image: req.body.image,
    };
    return handleChat(sid, message, req.body.stream === true, res, opts);
  } catch (err) {
    console.error('/api/chat Error:', err);
    res.status(500).json({ error: err.message || '服务器开小差了' });
  }
});

// GET /api/messages?sessionId=xxx
app.get('/api/messages', async (req, res) => {
  try {
    const { sessionId } = req.query;
    if (!sessionId) return res.status(400).json({ error: '缺少 sessionId' });
    const { data, error } = await supabase
      .from('messages')
      .select('*')
      .eq('session_id', sessionId)
      .eq('visible', true)
      .order('created_at', { ascending: true });
    if (error) return res.status(500).json({ error: error.message });
    res.json(data);
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// GET /api/sessions
app.get('/api/sessions', async (req, res) => {
  try {
    const { data, error } = await supabase
      .from('sessions')
      .select('*')
      .order('updated_at', { ascending: false });
    if (error) return res.status(500).json({ error: error.message });
    res.json(data);
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// GET /api/stats?days=N — request_stats 明细（原始 usage + Context Assembly 诊断）
app.get('/api/stats', async (req, res) => {
  try {
    const days = Math.min(parseInt(req.query.days, 10) || 30, 90);
    const since = new Date(Date.now() - days * 86400000).toISOString();
    const { data, error } = await supabase
      .from('request_stats')
      .select('*')
      .gte('created_at', since)
      .order('created_at', { ascending: false });
    if (error) return res.status(500).json({ error: error.message });
    res.json(data);
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// POST /api/sessions
app.post('/api/sessions', async (req, res) => {
  try {
    const { data, error } = await supabase
      .from('sessions')
      .insert({ name: req.body.name || '新对话' })
      .select()
      .single();
    if (error) return res.status(500).json({ error: error.message });
    res.json(data);
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// GET /api/system-prompt → 当前 system_prompt（数据库 → env → 默认）
app.get('/api/system-prompt', async (req, res) => {
  try {
    const system_prompt = await getSystemPrompt();
    res.json({ system_prompt });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// POST /api/system-prompt → 更新 system_prompt（存进 settings 表）
app.post('/api/system-prompt', async (req, res) => {
  try {
    const content = req.body.system_prompt;
    if (typeof content !== 'string') {
      return res.status(400).json({ error: '缺少 system_prompt 字段' });
    }
    await setSystemPrompt(content);
    res.json({ ok: true, system_prompt: content });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// 把当前用户消息附上图片，变成多模态 content 数组（OpenRouter / OpenAI 兼容格式）
function attachImage(messages, image) {
  if (!image) return messages;
  const out = messages.map((m) => ({ ...m }));
  for (let i = out.length - 1; i >= 0; i--) {
    if (out[i].role === 'user') {
      out[i].content = [
        { type: 'text', text: typeof out[i].content === 'string' ? out[i].content : '看看这张图片' },
        { type: 'image_url', image_url: { url: image } }
      ];
      break;
    }
  }
  return out;
}

// 抽为独立函数，/sessions/:id/chat 和 /api/chat 共用
async function handleChat(sessionId, userMessage, useStream, res, opts = {}) {
  // 判断是否对话第一条消息：决定是否注入 breath 背景记忆（只在第一条，后续不调）
  const { count: priorUserCount } = await supabase
    .from('messages')
    .select('*', { count: 'exact', head: true })
    .eq('session_id', sessionId)
    .eq('role', 'user')
    .eq('visible', true);
  const isFirstMessage = (priorUserCount || 0) === 0;

  // 1. 存用户消息（图片不入库，先不管存储）
  await supabase.from('messages').insert({
    session_id: sessionId,
    role: 'user',
    content: userMessage
  });

  // 2. 构建消息数组 + 附图片（Context Assembly 已替代旧的 compressHistory 热路径压缩）
  const { messages: builtMessages, diagnostics } = await buildMessages(sessionId, opts);
  let messages = builtMessages;

  // 3. 对话第一条消息：服务器直接调 breath，结果作为背景放在历史之前（不是替代历史）。
  //    用 user 角色（OpenRouter 会把 system 角色提升合并，污染缓存前缀）。
  //    user 角色 + 【背景记忆】标记，模型能明确识别它是不带时间流的背景。
  if (isFirstMessage && opts.tools !== 'off' && opts.memory !== false) {
    try {
      const bg = await callOmbreTool('breath');
      if (bg && bg.length > 0) {
        messages.splice(1, 0, { role: 'user', content: `【背景记忆 · 对话开始前提取】\n${bg}` });
        console.log(`🌿 第一条消息注入 breath 背景（${bg.length} 字符）`);
      }
    } catch (e) {
      console.warn('⚠️ breath 背景注入失败:', e.message);
    }
  }

  messages = attachImage(messages, opts.image);

  if (useStream) {
    res.setHeader('Content-Type', 'text/event-stream');
    res.setHeader('Cache-Control', 'no-cache');
    res.setHeader('Connection', 'keep-alive');
    res.setHeader('X-Accel-Buffering', 'no');
    res.flushHeaders();
    if (res.socket) res.socket.setNoDelay(true);

    const { content: finalReply, usageList = [] } = await handleStreamChat(messages, res, opts);

    await supabase.from('messages').insert({
      session_id: sessionId,
      role: 'assistant',
      content: finalReply
    });

    await supabase.from('sessions')
      .update({ updated_at: new Date().toISOString() })
      .eq('id', sessionId);

    sendSSE(res, 'done', { reply: finalReply });
    res.end();

    // 后台摘要生成（不进热路径、不阻塞响应；仅前端二）
    if (opts.client === 'angel') scheduleSummary(sessionId);
    recordRequestStat({
      sessionId, client: opts.client, model: toOpenRouterModel(opts.model),
      stream: true, usageList, diagnostics,
    });
  } else {
    const tools = opts.tools === 'off' ? null : getTools();
    const usageList = [];
    const { msg: assistantMessage, usage: usage1 } = await callOpenRouterNonStream(messages, tools, opts);
    if (usage1) usageList.push(usage1);
    let finalReply = '';
    const toolCalls = [];

    if (assistantMessage.tool_calls && assistantMessage.tool_calls.length > 0) {
      messages.push(assistantMessage);

      for (const tc of assistantMessage.tool_calls) {
        const fnName = tc.function.name;
        const fnArgs = JSON.parse(tc.function.arguments);
        console.log(`🔧 AI 决定调用工具: ${fnName}`, fnArgs);

        let toolResult;
        try {
          toolResult = await callOmbreTool(fnName, fnArgs);
        } catch (err) {
          toolResult = { error: err.message };
          console.error(`❌ 工具 ${fnName} 执行失败:`, err);
        }

        toolCalls.push({
          id: tc.id,
          name: fnName,
          arguments: fnArgs,
          result: toolResult
        });

        messages.push({
          tool_call_id: tc.id,
          role: 'tool',
          name: fnName,
          content: JSON.stringify(toolResult)
        });
      }

      const { msg: secondMessage, usage: usage2 } = await callOpenRouterNonStream(messages, null, opts);
      if (usage2) usageList.push(usage2);
      finalReply = secondMessage.content;
    } else {
      finalReply = assistantMessage.content;
    }

    await supabase.from('messages').insert({
      session_id: sessionId,
      role: 'assistant',
      content: finalReply
    });

    await supabase.from('sessions')
      .update({ updated_at: new Date().toISOString() })
      .eq('id', sessionId);

    const responseData = { reply: finalReply, sessionId };
    if (toolCalls.length > 0) {
      responseData.tool_calls = toolCalls;
    }
    res.json(responseData);

    // 后台摘要生成（不进热路径、不阻塞响应；仅前端二）
    if (opts.client === 'angel') scheduleSummary(sessionId);
    recordRequestStat({
      sessionId, client: opts.client, model: toOpenRouterModel(opts.model),
      stream: false, usageList, diagnostics,
    });
  }
}

// 测试 Ombre Brain 连接
app.get('/api/test-ombre', async (req, res) => {
  try {
    const result = await callOmbreTool('breath', { query: 'test' });
    res.json({ connected: true, result });
  } catch (err) {
    res.status(500).json({ connected: false, error: err.message });
  }
});

const PORT = process.env.PORT || 3000;
app.listen(PORT, () => {
  console.log(`服务器运行在端口 ${PORT}`);
});
