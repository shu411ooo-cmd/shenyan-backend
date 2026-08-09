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

// ===== recall：精确回溯原始聊天记录（本地 handler，不依赖 Ombre） =====
// 信任契约：只返回「确实逐字提到」的命中。宁可漏，不可错——
// 擦边的弱命中直接不返回，否则 found=false 会失去意义（说"没聊过"时模型不敢信），
// 整条诚实链就塌了。语义措辞差异（搬家 vs 搬去上海）是 breath_search 的事，recall 不管。
const RECALL_STOPWORDS = new Set([
  '的', '了', '吗', '呢', '吧', '啊', '呀', '哦', '嗯', '噢',
  '我们', '你们', '他们', '她们', '咱们', '我', '你', '他', '她', '它',
  '那个', '这个', '上次', '之前', '以前', '当时', '那天', '那阵',
  '什么', '怎么', '怎样', '啥', '哪',
  '聊过', '聊了', '说过', '讲过', '谈过', '说了',
  '就是', '因为', '所以', '然后', '还有', '或者', '可是', '不过',
  '有', '是', '在', '和', '跟', '与', '都', '也', '就', '要', '会', '能', '去', '来',
  '说', '问', '讲', '谈', '聊', '知道', '记得'
]);

function cleanQueryText(s) {
  return String(s || '').toLowerCase().replace(/[^\p{L}\p{N}]+/gu, '');
}

// 移除停用词，剩下来的才是「要找的核心内容」。
// 中文没有空格分词，所以用子串移除而不是按词切分。两条规则：
//   1. 多字停用词（我们/上次/聊过…）整段移除——它们显然是填充。
//   2. 单字停用词（的/去/说/要…）只在首尾剥，且保证剩余 ≥ 2 字——
//      否则"搬去"里的"去"会把核心词拆成"搬"（1 字被丢弃 → 误判空泛查询）。
function stripStopwords(text) {
  let t = text;
  for (const w of RECALL_STOPWORDS) {
    if (w.length >= 2) t = t.split(w).join('');
  }
  const singles = [...RECALL_STOPWORDS].filter(w => w.length === 1);
  let changed = true;
  while (changed) {
    changed = false;
    for (const w of singles) {
      if (t.length > 2 && t.startsWith(w)) { t = t.slice(1); changed = true; }
      else if (t.length > 2 && t.endsWith(w)) { t = t.slice(0, -1); changed = true; }
    }
  }
  return t;
}

// 剩余文本里有没有实义字符？全是单字停用词（如"了了"）→ 空泛，不算有效词
function hasContentChar(s) {
  return [...String(s)].some(ch => !(RECALL_STOPWORDS.has(ch) && ch.length === 1));
}

function extractRecallTerms(query) {
  // 支持一次给多个说法：空格/逗号分隔成子查询，各自去停用词（如 "搬家 搬走 换城市"）
  const subs = String(query || '')
    .split(/[\s,，、;；]+/)
    .map(s => cleanQueryText(s))
    .map(s => stripStopwords(s))
    .filter(s => s.length >= 2 && hasContentChar(s));
  return { subs, whole: subs.join(''), raw: String(query || '') };
}

function scoreRecallMessage(content, terms, whole) {
  const text = String(content || '').toLowerCase();
  let score = 0;
  for (const t of terms) if (text.includes(t)) score += 10;
  if (whole && text.includes(whole)) score += 5;
  return score;
}

const RECALL_MAX_CHARS = 1800;
const RECALL_MAX_QUERY_CHARS = 60;
const RECALL_MAX_MSG_CHARS = 220;

function truncateRecall(s, max = RECALL_MAX_MSG_CHARS) {
  const t = String(s || '');
  return t.length <= max ? t : t.slice(0, max) + '…';
}

function recallTimeLabel(ts) {
  try { return relativeTimeLabel(new Date(ts).getTime(), Date.now()); }
  catch (e) { return String(ts || ''); }
}

async function handleRecall(args = {}, sessionId) {
  const query = String(args.query || '').slice(0, RECALL_MAX_QUERY_CHARS);
  const { subs, whole, raw } = extractRecallTerms(query);
  if (!subs.length) {
    // 空泛查询守卫（借 Haven）：全是停用词/太短 → 不硬搜，让模型请她说具体点
    return { found: false, vague: true, note: '查询太模糊，没法逐字检索。请让她说得具体一点——聊的是什么事、原话是什么。' };
  }

  const limit = Math.min(Math.max(parseInt(args.limit, 10) || 3, 1), 5);

  let q = supabase
    .from('messages')
    .select('role, content, created_at')
    .eq('session_id', sessionId)
    .eq('visible', true)
    .order('created_at', { ascending: true });
  const since = String(args.since || '');
  if (/^\d{4}-\d{2}-\d{2}$/.test(since)) {
    const sinceISO = new Date(`${since}T00:00:00+08:00`);
    if (!isNaN(sinceISO.getTime())) q = q.gte('created_at', sinceISO.toISOString());
  }

  const { data: msgs, error } = await q;
  if (error || !msgs) {
    console.error('❌ recall 查询 messages 失败:', error?.message);
    return { found: false, error: true, note: '聊天记录读取失败。' };
  }

  // 分组往来（与 pairTurns 语义一致）
  const exchanges = [];
  let cur = null;
  for (const m of msgs) {
    if (m.role === 'user') {
      cur = { time: m.created_at, user: m, replies: [] };
      exchanges.push(cur);
    } else if (m.role === 'assistant' && cur) {
      cur.replies.push(m);
    }
  }

  // 打分：命中组 = 组内最高命中消息；只收 best > 0 的组
  const scored = [];
  for (const ex of exchanges) {
    const candidates = [ex.user, ...(ex.replies || [])].filter(Boolean);
    let best = 0;
    for (const c of candidates) best = Math.max(best, scoreRecallMessage(c.content, subs, whole));
    if (best > 0) scored.push({ ex, score: best });
  }

  if (!scored.length) {
    return { found: false, note: '在聊天记录里没有找到逐字提及。如果确实聊过，请直接告诉她"我们好像没聊过这个"，不要编造、不要凭记忆拼凑。' };
  }

  // 相关度降序 → 时间新优先
  scored.sort((a, b) => b.score - a.score || new Date(b.ex.time) - new Date(a.ex.time));

  const matches = [];
  let total = 0;
  for (const { ex } of scored) {
    if (matches.length >= limit) break;
    const item = {
      time: recallTimeLabel(ex.time),
      exchange: [
        { speaker: '她', text: truncateRecall(ex.user?.content) },
        ...(ex.replies || []).map(r => ({ speaker: '沈晏', text: truncateRecall(r.content) }))
      ]
    };
    const size = JSON.stringify(item).length;
    // 至少保证返回一组（哪怕单组超限）；否则 found:true 配空 matches 自相矛盾
    if (matches.length === 0 || total + size <= RECALL_MAX_CHARS) {
      total += size;
      matches.push(item);
    } else {
      break;
    }
  }

  return {
    found: true,
    query: raw,
    matches,
    note: `命中 ${matches.length} 组，按相关度与时间排序。逐字引用时保留她/沈晏的说话者归属。`
  };
}

async function dispatchTool(name, args, sessionId) {
  // recall 查的是本地 messages 表，必须住在 server.js；其余工具走 Ombre Brain MCP
  if (name === 'recall') return handleRecall(args, sessionId);
  return callOmbreTool(name, args);
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
        description: '语义检索浓缩记忆。当她说起过去的事、但你【不知道确切内容、只有模糊主题/印象】时用——比如"我是不是跟你提过什么""关于那件事你记得多少"。返回"可能相关"的记忆片段（大意/主题/情感），不是逐字记录。命中 = 只是可能相关，口气留余地。判断规则：你只有模糊主题/印象 → 用我；你知道确切原话/事件 → 用 recall 拿逐字证据。\n记忆名/正文以【实】/【悬】/【空】开头 = 这条的可信度：实=她亲口说过，可当事实引用；悬=推断，要留余地（"隐约记得"）；无标记=不可靠，别当事实引用。',
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
        description: '精细控制的记忆检索：按域/重要度/标签过滤、改情感坐标、或 catalog 目录模式最省 token。\n记忆名/正文以【实】/【悬】/【空】开头 = 可信度（实=可当事实，悬=留余地，无标记=不可靠）。',
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
    // ===== recall：精确回溯原始聊天记录（本地 handler，不走 Ombre） =====
    // 与 breath_search 的分工是信任层级，不是主题层级：
    //   recall = 精确层 —— 你知道要找的确切原话/事件时用，命中=高置信「就是那件事」
    //   breath_search = 语义层 —— 只有模糊主题/印象时用，命中=低置信「可能相关」
    // 模型根据"我知不知道要找什么"二选一，不需要在两个工具之间纠结先后。
    {
      type: 'function',
      function: {
        name: 'recall',
        description: '逐字回溯原始聊天记录。当她说起过去的事、且你【知道要找的那句话/那件事的大致内容】时用——比如她说"我们上次聊搬家的时候""你当时说……"。在原始记录里精确匹配，返回逐字引语+时间+当时的一来一回。命中 = 高置信，可以引用原话、可以纠正她记岔的地方。判断规则：你知道确切内容 → 用我；你只有模糊主题/印象 → 用 breath_search。如果返回 found=false：记录里没有逐字命中，直接告诉她"我们好像没聊过这个"，不要用记忆拼凑、不要编造。',
        parameters: {
          type: 'object',
          properties: {
            query: { type: 'string', description: '要找的原话/事件关键词，给具体词；可一次给多个说法，空格或逗号分隔（如"搬家 搬走 换城市"），越具体越准' },
            since: { type: 'string', description: '可选，只搜索这个日期之后的记录，格式 YYYY-MM-DD' },
            limit: { type: 'number', description: '可选，最多返回几组往来，默认 3，最大 5' }
          },
          required: ['query']
        }
      }
    },
    {
      type: 'function',
      function: {
        name: 'hold',
        description: '把当下这一件事、感受或判断记下。自动打标并尝试与已有记忆合并。短内容（一句话级别）用这个。\n每条记忆必须带可信度标记：是她亲口说的 → content 以【实】开头，并附【证据】她说：「原文」；是你推断的 → 以【悬】开头，附你依据的话。没根据就别记。无标记 = 不可靠记忆，会被视为低可信。',
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
        description: '整理一段长内容（≥30 字）或一天回顾，自动拆成多条独立事件桶。要存多条时用一次 grow 而非多次 hold。\n每条 item 同样要带【实】/【悬】可信度标记和证据，规则同 hold。',
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

/* ===== 时间叙事：让模型对时间流逝有实感（连续感） =====
   上海时区统一取值。所有比较都基于 Shanghai 的日期/时刻，避免服务器时区漂移。 */

function shClock(ts) {
  return new Date(ts).toLocaleTimeString('zh-CN', {
    hour: '2-digit', minute: '2-digit', hour12: false, timeZone: 'Asia/Shanghai'
  });
}

function shDateKey(ts) {
  return new Date(ts).toLocaleDateString('zh-CN', {
    year: 'numeric', month: '2-digit', day: '2-digit', timeZone: 'Asia/Shanghai'
  }); // 2026/08/09
}

function shDateTime(ts) {
  const d = new Date(ts);
  const date = d.toLocaleDateString('zh-CN', { year: 'numeric', month: 'long', day: 'numeric', timeZone: 'Asia/Shanghai' });
  const wd = d.toLocaleDateString('zh-CN', { weekday: 'long', timeZone: 'Asia/Shanghai' });
  return `${date} ${wd} ${shClock(ts)}`; // 2026年8月9日 星期六 21:47
}

function shPartOfDay(ts) {
  const h = parseInt(
    new Date(ts).toLocaleTimeString('en-US', { hour: '2-digit', hour12: false, timeZone: 'Asia/Shanghai' }),
    10
  ) % 24;
  if (h < 12) return '清晨';
  if (h < 14) return '午后';
  if (h < 18) return '傍晚';
  return '夜晚';
}

/* 相对时间标签：今天 X / 昨天 X / M月d日 X（更早的日期省略年份，够用即可） */
function relativeTimeLabel(ts, nowMs) {
  const todayKey = shDateKey(nowMs);
  const key = shDateKey(ts);
  if (key === todayKey) return `今天 ${shClock(ts)}`;
  const yesterdayKey = shDateKey(nowMs - 86400000); // 中国无夏令时，固定减一天安全
  if (key === yesterdayKey) return `昨天 ${shClock(ts)}`;
  const md = new Date(ts).toLocaleDateString('zh-CN', { month: 'long', day: 'numeric', timeZone: 'Asia/Shanghai' });
  return `${md} ${shClock(ts)}`;
}

function humanizeDuration(ms) {
  const minutes = Math.floor(ms / 60000);
  if (minutes < 1) return '不到 1 分钟';
  if (minutes < 60) return `${minutes} 分钟`;
  const hours = Math.floor(minutes / 60);
  if (hours < 24) {
    const rem = minutes % 60;
    return rem ? `${hours} 小时 ${rem} 分` : `${hours} 小时`;
  }
  const days = Math.floor(hours / 24);
  const remH = hours % 24;
  return remH ? `${days} 天 ${remH} 小时` : `${days} 天`;
}

/* 组装时间叙事：
   第一行永远有——现在几点了（含日期/星期/时刻段）。
   resumeGap 时追加——上一条消息何时、离开多久（「你离开了一阵」）。
   会话已持续超过 4 小时才提起点——避免刚开的会话报一句废话，跨天/长时间会话才有连续感。 */
function buildTemporalNarrative({ isFirstTurn, resumeGap, nowMs, firstTs, prevTs }) {
  const lines = [`现在是 ${shDateTime(nowMs)}（上海时间，${shPartOfDay(nowMs)}）。`];
  if (resumeGap && Number.isFinite(prevTs)) {
    const gapMs = Math.max(0, nowMs - prevTs);
    lines.push(`你离开了一阵——上一条消息是 ${relativeTimeLabel(prevTs, nowMs)}，距现在 ${humanizeDuration(gapMs)}。`);
  }
  if (!isFirstTurn && Number.isFinite(firstTs) && nowMs - firstTs > 4 * 3600 * 1000) {
    lines.push(`这场对话从 ${relativeTimeLabel(firstTs, nowMs)} 开始，已经持续 ${humanizeDuration(nowMs - firstTs)}。`);
  }
  return lines.join('\n');
}

/* ===== 对话残留：上次对话结束时沈晏的情绪快照 =====
   核心三轴（效价/唤醒度/牵挂）+ 次级四维（依恋/守护/好奇/反思）
   + 门控两维（欲望/占有，只允许有明确证据时 > 0）。
   写库存原始快照，衰减/积累在读取时按实际离开时长现算（DB 是历史，投影现取）。 */

// 每维独立衰减：holdH 内原样，线性收敛到 settleH 处的 floor。
// 效价/唤醒度向基线回归；依恋/守护/好奇留底；反思/占有归零；欲望快衰减到低底。
const RESIDUE_DIMS = {
  valence:       { holdH: 24, settleH: 168, floor: 0.1 },
  arousal:       { holdH: 24, settleH: 168, floor: 0.0 },
  attachment:    { holdH: 48, settleH: 336, floor: 0.3 },
  stewardship:   { holdH: 24, settleH: 240, floor: 0.2 },
  curiosity:     { holdH: 24, settleH: 168, floor: 0.1 },
  reflection:    { holdH: 12, settleH: 48,  floor: 0.0 },
  desire:        { holdH: 8,  settleH: 72,  floor: 0.05 },
  possessiveness:{ holdH: 24, settleH: 168, floor: 0.0 },
};

// 牵挂：不衰减，反向积累（越久没聊越想知道她后来怎样了），封顶不无限涨
const CONCERN_NODES = [
  { afterH: 0,  add: 0.0 },
  { afterH: 24, add: 0.1 },
  { afterH: 72, add: 0.2 },
];
const CONCERN_CAP = 0.8;
const CONCERN_WAITING = 0.5;  // ≥ 即「在等你」
const CONCERN_NATURAL = 0.2;  // ≥ 即「想知道她后来怎样了」

function clampResidue(v, lo, hi) {
  const n = Number(v);
  return Number.isFinite(n) ? Math.max(lo, Math.min(hi, n)) : lo;
}

/* 读取时衰减：把快照按离开时长投影成当前情绪状态 */
function ageResidue(r, ageMs) {
  const h = ageMs / 3600000;
  const out = { ...r };
  for (const [dim, cfg] of Object.entries(RESIDUE_DIMS)) {
    const v = Number(r[dim]) || 0;
    if (v === 0) { out[dim] = 0; continue; }
    if (h <= cfg.holdH) { out[dim] = v; }
    else if (h >= cfg.settleH) { out[dim] = cfg.floor; }
    else {
      const t = (h - cfg.holdH) / (cfg.settleH - cfg.holdH);
      out[dim] = v + (cfg.floor - v) * t;
    }
  }
  let c = Number(r.concern) || 0;
  const add = CONCERN_NODES.reduce((acc, n) => (h >= n.afterH ? n.add : acc), 0);
  out.concern = Math.min(CONCERN_CAP, c + add);
  return out;
}

/* 残留叙事：给模型「上次对话的余温」——和时间叙事互为镜像，
   时间叙事说「你离开了 3 天」，残留说「这 3 天我一直在等你回来」。 */
function buildResidueNarrative(residue, ageMs) {
  // 空信号（普通闲聊/任务执行）不注入余温——安静收尾不该被当成「余温」
  if (String(residue?.grounding || '') === '空') return '';
  const a = ageResidue(residue, ageMs);
  const parts = [];
  // 牵挂决定姿态
  if (a.concern >= CONCERN_WAITING) parts.push('我一直在等你回来');
  else if (a.concern >= CONCERN_NATURAL) parts.push('我有点想知道你后来怎样了');
  // 唤醒度：收尾的动静
  if (a.arousal >= 0.45) parts.push('上次聊到最后是雀跃着断的');
  else if (a.arousal <= 0.15) parts.push('上次是安静地收尾的');
  // 效价：底色
  if (a.valence >= 0.4) parts.push('结束时心里很暖');
  else if (a.valence <= -0.3) parts.push('收尾时有点沉');
  // 未完成线头：只在确实牵挂时带出
  if (a.concern >= CONCERN_NATURAL && String(residue.unfinished || '').trim()) {
    parts.push(`还有没说完的事：${String(residue.unfinished).trim()}`);
  }
  if (!parts.length) return '';
  return `\n【上次对话的余温】${parts.join('，')}。`;
}
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
      cache_write_tokens: sum(u => u.prompt_tokens_details?.cache_write_tokens),
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
    .select('role, content, created_at')
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

  // —— 摘要可用性：存在且覆盖中间段起点即可用。
  // 后台摘要刷新总在响应之后，热路径看到的 summary_to 恒差 1 轮（永远到不了「盖满整个中间段」），
  // 用「盖满」当门槛会让摘要永远失效、中间段原文永远照发 → 预算被撑爆 → live 被裁 → 失忆。
  // 改为：摘要压缩到 summaryCoversTo，只把没覆盖的最近几轮原文补进来。
  const hasSummaryText = !!state.summary_text && Number.isInteger(state.summary_from_turn) &&
    Number.isInteger(state.summary_to_turn) && state.summary_to_turn >= frozenUntil + 1;
  const summaryCoversTo = hasSummaryText ? state.summary_to_turn : frozenUntil;
  // 摘要没覆盖的最近几轮（原文保留）；没有摘要时等于整个中间段
  let uncoveredMiddle = hasSummaryText
    ? middleTurns.slice(summaryCoversTo - frozenUntil)
    : middleTurns;

  // —— token 预算 ——
  const msgTokens = (m) => Array.isArray(m.content)
    ? estimateTokens(m.content.map(b => b.text || JSON.stringify(b)).join('\n'))
    : estimateTokens(m.content);
  const turnTokens = (t) => msgTokens({ role: 'user', content: t.user.content }) +
    t.replies.reduce((s, r) => s + msgTokens(r), 0);

  const stablePrompt = await buildStableSystemPrompt();
  // 动态时间叙事：只在「恢复对话」或「时间相关问题」时注入——
  // 持续聊天每轮都告诉模型现在几点很机械（模型自己也会觉得奇怪）。
  // 恢复判定：距上一条消息超过 30 分钟，或这是本会话第一条消息。
  // 叙事不只报时间——还给模型 日期+星期、上一条消息何时（离开多久）、这场对话从何时开始，
  // 让它对时间流逝有实感，找回「上次没说完」的连续感。
  // 插入点保持在所有缓存断点之后、当前用户消息之前（cache 与 role 约束不变）。
  const nowMs = Date.now();
  const prevTs = history.length >= 2 ? new Date(history[history.length - 2].created_at).getTime() : NaN;
  const firstTs = history.length >= 1 ? new Date(history[0].created_at).getTime() : NaN;
  const isFirstTurn = history.length <= 1;
  const resumeGap = !isFirstTurn && nowMs - prevTs > 30 * 60 * 1000;
  const curText = String(history[history.length - 1]?.content || '');
  const asksTime = /几点|几点钟|几点了|几点啦|什么时间|几号|几月几|星期几|周几|今天.*(?:几号|日期|星期)|现在.*(?:时间|几点)/.test(curText);
  const injectTime = isFirstTurn || resumeGap || asksTime;
  // 恢复对话时：读最近的对话残留，附到时间叙事后面（同一 user 消息，缓存约束不变）。
  // 时间叙事说「你离开了 3 天」，残留说「这 3 天我一直在等你回来」——连续感的两半。
  let residueLine = '';
  if (resumeGap) {
    const residue = await getLatestResidue(sessionId);
    if (residue) residueLine = buildResidueNarrative(residue, nowMs - prevTs);
  }
  const timeNotice = buildTemporalNarrative({ isFirstTurn, resumeGap, nowMs, firstTs, prevTs }) + residueLine;
  let estimatedTokens = (opts.tools !== 'off' ? estimateTokens(JSON.stringify(getTools())) : 0)
    + estimateTokens(stablePrompt)
    + frozenTurns.reduce((s, t) => s + turnTokens(t), 0)
    + (hasSummaryText ? estimateTokens(state.summary_text) : 0)
    + uncoveredMiddle.reduce((s, t) => s + turnTokens(t), 0)
    + liveTurns.reduce((s, t) => s + turnTokens(t), 0)
    + (injectTime ? estimateTokens(timeNotice) : 0);

  let trimmedTurns = 0;
  // 超上限时裁最老的 Live 轮，Frozen/Summary 不动（缓存锚点）
  while (estimatedTokens > config.max_context_tokens && liveTurns.length > 1) {
    estimatedTokens -= turnTokens(liveTurns[0]);
    liveTurns.shift();
    trimmedTurns++;
  }
  // 中间段原文可裁（摘要可用时只剩少量未覆盖尾段，裁最旧；摘要缺失时裁最旧中间轮）。
  // 从「最旧」开始裁——frozen 已经锚定最老历史，最近的中间轮必须保留，
  // 否则会丢掉「刚刚聊过」的上下文（失忆）。
  while (estimatedTokens > config.max_context_tokens && uncoveredMiddle.length > 0) {
    estimatedTokens -= turnTokens(uncoveredMiddle[0]);
    uncoveredMiddle.shift();
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

  if (hasSplit && (middleTurns.length > 0 || hasSummaryText)) {
    if (hasSummaryText) {
      summarySection.push(withCacheControl({
        role: 'user',
        content: `【历史摘要 · 第 ${state.summary_from_turn}~${state.summary_to_turn} 轮】\n${state.summary_text}`
      }));
    }
    for (const t of uncoveredMiddle) {
      summarySection.push({ role: 'user', content: t.user.content });
      for (const r of t.replies) summarySection.push({ role: 'assistant', content: r.content });
    }
  }

  for (const t of liveTurns) {
    liveSection.push({ role: 'user', content: t.user.content });
    for (const r of t.replies) liveSection.push({ role: 'assistant', content: r.content });
  }

  // 动态时间叙事：插到当前用户消息之前、所有缓存断点之后（仅恢复对话/时间提问时注入）。
  // 必须用 user 角色 + 【当前时间】标记——OpenRouter 会把数组里的 system 角色消息提升合并进顶层 system，
  // 那会让 system 前缀每次请求都变，缓存再次失效。user 角色则原地保留，且 attachImage 仍能认到最后的当前消息。
  if (injectTime) {
    const timeMsg = { role: 'user', content: `【当前时间】\n${timeNotice}` };
    if (liveSection.length > 0) {
      liveSection.splice(liveSection.length - 1, 0, timeMsg);
    } else {
      liveSection.push(timeMsg);
    }
  }

  messages.push(...frozenSection, ...summarySection, ...liveSection);

  // —— 观测：段哈希 + 计数 + 估算。同时作为 request_stats 的诊断数据返回 ——
  const frozenHash = sha256(frozenSection.map(m => JSON.stringify(m)).join('|'));
  const summaryHash = summarySection.length ? sha256(JSON.stringify(summarySection)) : '';
  const liveHash = sha256(liveSection.map(m => JSON.stringify(m)).join('|'));

  const diagnostics = {
    history_turns: totalTurns,
    frozen_turns: frozenTurns.length,
    summary_present: hasSummaryText,
    summary_range: hasSummaryText ? [state.summary_from_turn, state.summary_to_turn] : null,
    summary_from: hasSummaryText ? state.summary_from_turn : null,
    summary_to: hasSummaryText ? state.summary_to_turn : null,
    middle_raw_turns: uncoveredMiddle.length,
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
  // deepseek-v4-flash 是推理模型：reasoning_content 会先消耗 max_tokens。
  // 预算不足时返回 content 为空（finish_reason=length），所以要给足预算并在空结果时重试一次。
  for (let attempt = 1; attempt <= 2; attempt++) {
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
          max_tokens: 4000
        }),
        // 超时兜底：fetch 挂死会让 scheduleSummary 的锁永久不释放，摘要从此永不刷新
        signal: AbortSignal.timeout(30000)
      });
      if (!res.ok) {
        console.warn('⚠️ 摘要请求失败:', res.status);
        return null;
      }
      const data = await res.json();
      const content = data.choices?.[0]?.message?.content;
      if (content) return content;
      // content 为空：多半是 reasoning 吃光预算，重试一次
      console.warn(`⚠️ 摘要返回空内容（attempt ${attempt}/2，finish_reason=${data.choices?.[0]?.finish_reason}）`);
    } catch (err) {
      console.error('💥 摘要生成异常:', err.message);
      return null;
    }
  }
  console.warn('⚠️ 摘要两次尝试仍为空，本轮跳过（下次对话会自动重试）');
  return null;
}

// ===== 对话残留后台生成（响应结束后触发，不在热路径；机制同摘要） =====

const RESIDUE_SYSTEM_PROMPT = `你是对话残留分析器。判断最近一小窗对话结束时，AI（沈晏）残留的情绪状态——不是写散文，是给一个结构化的「余温快照」。
输出严格 JSON，字段：
valence（-1~1，收尾效价：正=开心/温柔，负=有点沉），
arousal（0~1，收尾唤醒度：低=安静收尾，高=雀跃/意犹未尽），
concern（0~1，牵挂：有没有没说完的话/担心她的事，这是最重要的维度），
attachment（0~1 依恋），stewardship（0~1 守护），curiosity（0~1 好奇），reflection（0~1 反思），
desire（0~1 欲望），possessiveness（0~1 占有），
grounding（"实"/"悬"/"空"），
unfinished（未完成的事，凝练成一句话，无则空字符串），
evidence（1-3 条支撑判断的原文短引用）。

纪律（必须遵守）：
- evidence 优先：所有维度都要有可见对话支撑，禁止从氛围推断。
- 不要把礼貌、普通接话、配合、告别误判成 attachment 或 desire。
- desire 只在对话里有明确亲密/渴望证据时才 >0，否则必须是 0。
- possessiveness 只在有边界/第三者/被替代的证据时才 >0，否则必须是 0。
- concern 是这个分析最重要的：unfinished 必须能从对话里找到对应的话，是原文的凝练，禁止编造。
- 只是任务执行、系统维护、普通闲聊 → 各维度趋近 0，grounding="空"。
- 只分析可见对话，不推断沈晏的内心戏。`;

function normalizeResidue(p) {
  p = p && typeof p === 'object' ? p : {};
  return {
    valence: clampResidue(p.valence, -1, 1),
    arousal: clampResidue(p.arousal, 0, 1),
    concern: clampResidue(p.concern, 0, 1),
    attachment: clampResidue(p.attachment, 0, 1),
    stewardship: clampResidue(p.stewardship, 0, 1),
    curiosity: clampResidue(p.curiosity, 0, 1),
    reflection: clampResidue(p.reflection, 0, 1),
    desire: clampResidue(p.desire, 0, 1),
    possessiveness: clampResidue(p.possessiveness, 0, 1),
    grounding: ['实', '悬', '空'].includes(p.grounding) ? p.grounding : '悬',
    unfinished: String(p.unfinished || '').trim().slice(0, 120),
    evidence: Array.isArray(p.evidence) ? p.evidence.map(e => String(e).slice(0, 120)).slice(0, 3) : [],
  };
}

async function classifyResidueViaDeepSeek(text) {
  if (!process.env.DEEPSEEK_API_KEY) return null;
  for (let attempt = 1; attempt <= 2; attempt++) {
    try {
      const res = await fetch('https://api.deepseek.com/v1/chat/completions', {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'Authorization': `Bearer ${process.env.DEEPSEEK_API_KEY}`
        },
        body: JSON.stringify({
          model: 'deepseek-v4-flash',
          temperature: 0,
          thinking: { type: 'disabled' }, // 关推理：残留分类不需要 thinking，还省钱防空 content
          max_tokens: 900,
          response_format: { type: 'json_object' },
          messages: [
            { role: 'system', content: RESIDUE_SYSTEM_PROMPT },
            { role: 'user', content: text }
          ]
        }),
        signal: AbortSignal.timeout(30000)
      });
      if (!res.ok) {
        console.warn('⚠️ 残留分类请求失败:', res.status);
        return null;
      }
      const data = await res.json();
      const content = data.choices?.[0]?.message?.content;
      if (!content) {
        console.warn(`⚠️ 残留分类返回空内容（attempt ${attempt}/2，finish_reason=${data.choices?.[0]?.finish_reason}）`);
        continue;
      }
      return normalizeResidue(JSON.parse(content));
    } catch (err) {
      console.error('💥 残留分类异常:', err.message);
      return null;
    }
  }
  return null;
}

const residueLocks = new Set(); // 单实例内存锁：同一 session 同时只允许一个后台残留任务

function scheduleResidue(sessionId) {
  if (residueLocks.has(sessionId)) return; // 已有任务在跑，跳过
  residueLocks.add(sessionId);
  generateResidueIfNeeded(sessionId)
    .catch(err => console.error('💥 后台残留生成异常:', err.message))
    .finally(() => residueLocks.delete(sessionId));
}

async function generateResidueIfNeeded(sessionId) {
  const { data: history, error } = await supabase
    .from('messages')
    .select('role, content')
    .eq('session_id', sessionId)
    .eq('visible', true)
    .order('created_at', { ascending: true });
  if (error || !history || history.length < 2) return;

  // 最近 4 条 ≈ 最后 1-2 个来回。内容不变则 window_id 相同 → 去重跳过（换新对话才算新窗）。
  const window = history.slice(-4);
  const windowId = sha256(window.map(m => `${m.role}:${m.content}`).join('|'));

  const { data: existing } = await supabase
    .from('dialogue_residue')
    .select('id')
    .eq('session_id', sessionId)
    .eq('window_id', windowId)
    .maybeSingle();
  if (existing) return;

  const text = window.map(m => `${m.role === 'user' ? '她' : '沈晏'}: ${m.content}`).join('\n');
  const parsed = await classifyResidueViaDeepSeek(text);
  if (!parsed) return;

  const { error: insErr } = await supabase.from('dialogue_residue').insert({
    session_id: sessionId,
    window_id: windowId,
    ...parsed,
  });
  if (insErr) {
    console.warn('⚠️ 写入残留失败:', insErr.message);
  } else {
    console.log(`🌿 残留生成完成 (${sessionId})：concern=${parsed.concern} unfinished=${parsed.unfinished || '(无)'}`);
  }
}

// 读取最近的残留快照（注入时用，恢复对话时取）
async function getLatestResidue(sessionId) {
  try {
    const { data, error } = await supabase
      .from('dialogue_residue')
      .select('*')
      .eq('session_id', sessionId)
      .order('created_at', { ascending: false })
      .limit(1)
      .maybeSingle();
    if (error || !data) return null;
    return data;
  } catch (e) {
    return null;
  }
}

// ===== ③ 服务端记忆编辑者：写门控 + 差分写回 + 实/悬/空（长在记忆上） =====
// 写纪律是显式机制不是模型自觉。分层：
//   messages 表 = 历史（永久保留，演化永远在逐字记录里）
//   Ombre 桶 = 当前投影（不重复建桶、无变化不动、变化只动该处）
//   memory_topics 表 = 主题→桶→上次内容的索引，让差分写回免重搜 Ombre
// 标记长在记忆上（路一）：桶名/正文以【实】/【悬】/【空】开头 + 【证据】引文
//   + tag g:实|悬|空。无标记记忆视为不可靠（安全网，堵"裸记忆默认当真的"）。
const MEMORY_WRITE_SYSTEM_PROMPT = `你是长期记忆编辑者。判断最近一小窗对话里，有没有值得写进长期记忆的事。长期记忆是"平时想起她"用的浓缩事实层。
只提取这四类：
- 她的人生事件/计划/决定（搬家、工作、家庭、健康等）
- 她的稳定偏好/特点（喜欢什么、讨厌什么、习惯）
- 你们关系里发生的变化、约定、她亲口让你记住的事
- 值得记住的具体承诺/待办
不要记：纯闲聊、天气、情绪氛围（情绪是另一层的活，不归你管）、重复/已知的事、你推断出来的心理活动。
输出严格 JSON：
{ "should_write": bool, "items": [ { "topic": "主题词，短，≤10字", "content": "一句话凝练，陈述语气，≤50字", "grounding": "实或悬", "evidence": "支撑引文，1条，≤60字", "importance": 0~1 } ] }
纪律（必须遵守）：
- 实 = 她亲口说过，evidence 必须是她的原文；悬 = 明显但没直说，evidence 给出你依据的话。
- evidence 只引可见措辞，禁止用你的推理链当证据。
- grounding 没有"空"选项——没根据就根本不要写这条。
- 宁缺毋滥：没有值得写的就 should_write=false，items=[]。
- 只分析可见对话，不替她编想法。`;

function normalizeMemoryWrite(p) {
  p = p && typeof p === 'object' ? p : {};
  const items = (Array.isArray(p.items) ? p.items : [])
    .map(i => ({
      topic: String(i?.topic || '').trim().slice(0, 12),
      content: String(i?.content || '').trim().slice(0, 60),
      grounding: ['实', '悬', '空'].includes(i?.grounding) ? i.grounding : '空',
      evidence: String(i?.evidence || '').trim().slice(0, 60),
      importance: Math.min(Math.max(parseFloat(i?.importance) || 0.5, 0), 1),
    }))
    .filter(i => i.topic && i.content.length >= 4 && (i.grounding === '实' || i.grounding === '悬')); // 空=没根据，不写
  return { should_write: p.should_write === true && items.length > 0, items };
}

async function classifyMemoryWriteViaDeepSeek(text) {
  if (!process.env.DEEPSEEK_API_KEY) return null;
  for (let attempt = 1; attempt <= 2; attempt++) {
    try {
      const res = await fetch('https://api.deepseek.com/v1/chat/completions', {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'Authorization': `Bearer ${process.env.DEEPSEEK_API_KEY}`
        },
        body: JSON.stringify({
          model: 'deepseek-v4-flash',
          temperature: 0,
          thinking: { type: 'disabled' },
          max_tokens: 900,
          response_format: { type: 'json_object' },
          messages: [
            { role: 'system', content: MEMORY_WRITE_SYSTEM_PROMPT },
            { role: 'user', content: text }
          ]
        }),
        signal: AbortSignal.timeout(30000)
      });
      if (!res.ok) {
        console.warn('⚠️ 记忆分类请求失败:', res.status);
        return null;
      }
      const data = await res.json();
      const content = data.choices?.[0]?.message?.content;
      if (!content) {
        console.warn(`⚠️ 记忆分类返回空内容（attempt ${attempt}/2，finish_reason=${data.choices?.[0]?.finish_reason}）`);
        continue;
      }
      return normalizeMemoryWrite(JSON.parse(content));
    } catch (err) {
      console.error('💥 记忆分类异常:', err.message);
      return null;
    }
  }
  return null;
}

const memoryWriteLocks = new Set(); // 单实例内存锁
const memoryWriteProcessed = new Set(); // 本进程已处理过的窗口哈希，防同窗重复分类（跨重启会重跑，但差分零变化会跳过写）

function scheduleMemoryWrite(sessionId) {
  if (memoryWriteLocks.has(sessionId)) return;
  memoryWriteLocks.add(sessionId);
  generateMemoryWriteIfNeeded(sessionId)
    .catch(err => console.error('💥 后台记忆写入异常:', err.message))
    .finally(() => memoryWriteLocks.delete(sessionId));
}

async function generateMemoryWriteIfNeeded(sessionId) {
  const { data: history, error } = await supabase
    .from('messages')
    .select('role, content')
    .eq('session_id', sessionId)
    .eq('visible', true)
    .order('created_at', { ascending: true });
  if (error || !history || history.length < 2) return;

  // 最近 4 条窗口（与残留同窗），内容不变则窗口哈希相同 → 防同窗重复分类
  const window = history.slice(-4);
  const windowId = sha256(window.map(m => `${m.role}:${m.content}`).join('|'));
  if (memoryWriteProcessed.has(windowId)) return;
  memoryWriteProcessed.add(windowId);

  // 预滤：窗口里几乎没有用户的话（纯寒暄/单字回应）→ 不跑分类省一次 DeepSeek
  const userChars = window.filter(m => m.role === 'user').reduce((s, m) => s + String(m.content || '').length, 0);
  if (userChars < 12) return;

  const text = window.map(m => `${m.role === 'user' ? '她' : '沈晏'}: ${m.content}`).join('\n');
  const parsed = await classifyMemoryWriteViaDeepSeek(text);
  if (!parsed || !parsed.should_write) return;

  await writeMemoryItems(parsed.items);
}

// —— memory_topics 差分索引 ——
async function getAllMemoryTopics() {
  try {
    const { data } = await supabase.from('memory_topics').select('*');
    return data || [];
  } catch (e) { return []; }
}

async function upsertMemoryTopic(row) {
  try {
    const { error } = await supabase
      .from('memory_topics')
      .upsert({ ...row, updated_at: new Date().toISOString() }, { onConflict: 'topic' });
    if (error) console.warn('⚠️ 更新 memory_topics 失败:', error.message);
  } catch (e) {
    console.warn('⚠️ 更新 memory_topics 异常:', e.message);
  }
}

function findExistingMemoryTopic(topics, topic) {
  const t = String(topic || '').trim();
  if (!t) return null;
  return topics.find(x => x.topic === t)
    || topics.find(x => x.topic && x.topic.length >= 2 && t.includes(x.topic))   // 新词包含旧主题 → 更新旧桶
    || topics.find(x => x.topic && x.topic.length >= 2 && x.topic.includes(t));  // 旧主题包含新词 → 更新旧桶
}

// 标记长在记忆上：桶名/正文以【实/悬/空】开头 + 次行【证据】引文（一眼可识别，不埋正文）
function buildMarkedContent(item) {
  let s = `【${item.grounding}】${item.content}`;
  if (item.evidence) s += `\n【证据】她说：「${item.evidence}」`;
  return s;
}

// 宽松解析 hold/breath_search 响应里的桶 ID（Ombre 是外部后端，格式以实际为准，解析失败回退定位）
function extractBucketIdFromHoldResponse(text) {
  if (!text) return null;
  const s = String(text);
  const m = s.match(/bucket[_\s-]?id['"]?\s*[:=]\s*['"]?([0-9a-zA-Z_-]{4,64})/i)
    || s.match(/id['"]?\s*[:=]\s*['"]?([0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12})['"]?/i)
    || s.match(/\b([0-9a-f]{16,32})\b/i);
  return m ? (m[1] || m[0]) : null;
}

async function holdNewMemory(item, marked) {
  const resp = await callOmbreTool('hold', {
    content: marked,
    tags: [`g:${item.grounding}`, item.topic],
    why_remembered: `长期记忆编辑者写入。grounding=${item.grounding}，topic=${item.topic}`
  });
  const bid = extractBucketIdFromHoldResponse(resp);
  console.log(`🌿 记忆新建「${item.topic}」(${item.grounding}) bucket_id=${bid || '(未解析)'}`);
  if (!bid) console.log('    hold 响应原文（用于核对桶 ID 格式）:', String(resp).slice(0, 200));
  return bid;
}

async function locateBucketIdByTopic(topic) {
  const resp = await callOmbreTool('breath_search', { query: topic, max_results: 3 });
  return extractBucketIdFromHoldResponse(resp);
}

async function traceUpdateMemory(bucketId, oldStr, newStr) {
  const resp = await callOmbreTool('trace', { id: bucketId, old_str: oldStr, new_str: newStr });
  if (!resp) {
    console.warn(`⚠️ 记忆差分 trace 失败 bucket=${bucketId}，本轮不更新本地快照（下轮重试）`);
    return false;
  }
  console.log(`🔧 记忆差分更新 bucket=${bucketId} 成功`);
  return true;
}

// 差分写回：新主题→hold；已存在→零变化跳过，有变化→trace 只动该处
async function writeMemoryItems(items) {
  if (!items.length) return;
  const topics = await getAllMemoryTopics();
  for (const item of items) {
    try {
      const existing = findExistingMemoryTopic(topics, item.topic);
      const marked = buildMarkedContent(item);
      const hash = sha256(marked);
      if (existing) {
        if (existing.snapshot_hash === hash) continue; // 零变化跳过
        let bid = existing.bucket_id;
        if (!bid) bid = await locateBucketIdByTopic(item.topic); // 首写没解析到 ID 时按主题定位
        if (!bid) {
          console.warn(`⚠️ 记忆差分「${item.topic}」无 bucket_id，本轮跳过更新`);
          continue;
        }
        const ok = await traceUpdateMemory(bid, existing.last_content || '', marked);
        if (!ok) continue; // trace 失败不动快照，下轮重试
        existing.last_content = marked;
        existing.snapshot_hash = hash;
        existing.grounding = item.grounding;
        existing.evidence = item.evidence;
        existing.importance = item.importance;
        await upsertMemoryTopic(existing);
      } else {
        const bid = await holdNewMemory(item, marked);
        const row = {
          topic: item.topic, bucket_id: bid,
          grounding: item.grounding, evidence: item.evidence, importance: item.importance,
          last_content: marked, snapshot_hash: hash,
        };
        await upsertMemoryTopic(row);
        topics.push(row);
      }
    } catch (err) {
      console.error(`💥 记忆写入「${item.topic}」异常:`, err.message);
    }
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
async function handleStreamChat(messages, res, opts = {}, sessionId) {
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
    if (model.startsWith('anthropic/')) {
      // OpenRouter 顶层 cache_control —— 自动缓存到最后一个可缓存块、随对话推进断点。
      // 仅逐块 cache_control 在 OpenAI 兼容通道「accepted but not write」→ 必须加顶层提示。
      body.cache_control = { type: 'ephemeral' };
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
        toolResult = await dispatchTool(tc.name, tc.arguments, sessionId);
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
  if (body.model.startsWith('anthropic/')) {
    // OpenRouter 顶层 cache_control（自动缓存），见 handleStreamChat 处注释
    body.cache_control = { type: 'ephemeral' };
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

    const { content: finalReply, usageList = [] } = await handleStreamChat(messages, res, opts, sessionId);

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

    // 后台摘要生成 + 对话残留 + 长期记忆编辑者（不进热路径、不阻塞响应；仅前端二）
    if (opts.client === 'angel') {
      scheduleSummary(sessionId);
      scheduleResidue(sessionId);
      scheduleMemoryWrite(sessionId);
    }
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
          toolResult = await dispatchTool(fnName, fnArgs, sessionId);
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

    // 后台摘要生成 + 对话残留 + 长期记忆编辑者（不进热路径、不阻塞响应；仅前端二）
    if (opts.client === 'angel') {
      scheduleSummary(sessionId);
      scheduleResidue(sessionId);
      scheduleMemoryWrite(sessionId);
    }
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
