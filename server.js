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
// JSON body 限制提到 15mb：chat 的 image 字段走 base64 data URL（前端已压到 1280px，
// base64 膨胀 ~1.33×，1280px JPEG 最高可到 ~1-2MB，默认 100kb 会直接 413）。
app.use(express.json({ limit: '15mb' }));

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
      // 修复：Ombre 工具执行失败时 isError=true（如参数校验错误），
      // 之前不检查会把这堆错误文本当成功返回，调用方误记快照、掩盖真 bug。
      if (parsed.result.isError) {
        console.error('❌ 工具执行失败(isError=true):', resultText.slice(0, 300));
        return null;
      }
      console.log('🎉 工具调用成功，返回:', resultText);
      return resultText;
    }

    console.warn('⚠️ 无法解析 tools/call 响应:', parsed);
    // 解析成功但无 result.content → 视为失败返回 null（已有 warn）。
    // 之前这里返回 JSON.stringify(parsed)，会把垃圾 JSON 当工具结果注入上下文（如 breath 背景），必须堵死。
    return null;
  } catch (err) {
    console.error(`💥 工具 ${toolName} 调用失败:`, err);
    return null;
  }
}

// —— 记忆/工具降级监测（静默降级报警：Seth&Vivi「丢弃出口全部点灯」+ 3novy「降级必须大声报警」）——
// 每个静默降级出口（breath 注入失败 / 工具返回 null / 主题读取失败）都点灯 + 计入连击；
// 连续 ≥3 次打一个醒目块；一次健康的 chat 请求清零。
const degradedMonitor = { n: 0, alarmed: false };
function markMemoryDegraded(reason) {
  degradedMonitor.n++;
  console.error(`⚠️ [记忆降级] ${reason}（连续第 ${degradedMonitor.n} 次）`);
  if (degradedMonitor.n >= 3 && !degradedMonitor.alarmed) {
    degradedMonitor.alarmed = true;
    console.error('⚠️⚠️ 记忆链路连续降级 ≥3 次：breath/工具/主题读取存在持续失败，请检查 Ombre Brain 与 Supabase。');
  }
}
function markMemoryHealthy() {
  if (degradedMonitor.n > 0) console.log(`🌿 记忆链路恢复（此前连续降级 ${degradedMonitor.n} 次）`);
  degradedMonitor.n = 0;
  degradedMonitor.alarmed = false;
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

// ===== 小日记（Diary）：隔离表，本地 handler，不走 Ombre =====
// 硬隔离：只有 write_diary / read_diary 两个工具 + /api/diary* 路由碰这张表。
// 写 = 直接 INSERT，不经 LLM 分类；内容不进 recall / breath / 上下文组装 / 摘要 / request_stats。

const DIARY_MAX_CHARS = 4000;

async function handleDiaryWrite(args = {}) {
  const content = String(args.content || '').trim();
  if (!content) return { ok: false, error: '没有写下任何字。' };
  const text = content.slice(0, DIARY_MAX_CHARS);
  const visibility = args.visibility === 'shared' ? 'shared' : 'private';
  const event_time = new Date().toISOString();
  const { data, error } = await supabase
    .from('diary_entries')
    .insert({ content: text, visibility, event_time })
    .select('id, visibility, event_time')
    .single();
  if (error) {
    console.error('❌ write_diary 写入失败:', error.message);
    return { ok: false, error: '日记没有写成。' };
  }
  return { ok: true, id: data.id, visibility: data.visibility, note: '已经写在日记里了。' };
}

async function handleDiaryRead(args = {}) {
  try {
    // 模式一：指定 id → 读那一篇（全部可见性，是他的抽屉）
    const id = parseInt(args.id, 10);
    if (Number.isInteger(id) && id > 0) {
      const { data, error } = await supabase
        .from('diary_entries')
        .select('id, content, visibility, event_time')
        .eq('id', id)
        .maybeSingle();
      if (error) return { ok: false, error: '日记读取失败。' };
      return { ok: true, entry: data || null };
    }
    // 模式二/三：query 翻找（含私密，是他的抽屉）或最近 N 篇
    const query = String(args.query || '').trim().slice(0, 100);
    const limit = Math.min(Math.max(parseInt(args.limit, 10) || 8, 1), 20);
    let q = supabase
      .from('diary_entries')
      .select('id, content, visibility, event_time')
      .order('event_time', { ascending: false })
      .limit(limit);
    if (query) q = q.ilike('content', `%${query}%`);
    const { data, error } = await q;
    if (error) return { ok: false, error: '日记读取失败。' };
    return { ok: true, entries: data || [] };
  } catch (e) {
    return { ok: false, error: '日记读取失败。' };
  }
}

// ===== 想要账本（Want Ledger）：独立表，本地 handler，不走 Ombre =====
// 边界：只有 5 个 want_* 工具触碰 desires / desire_notes 两张表。
// 不进记忆 / 摘要 / recall / breath / 上下文组装。只有沈晏能写——系统不创造、不改、不删一条"想要"本体。
// surprise 可见性在第①阶段无前端无注入，handler 不滤（surprise 藏的是程芥，不是沈晏自己）；第②阶段做注入/前端时再横切。

const DESIRE_MAX_CHARS = 400;

function parseDesireId(raw) {
  if (!raw) return null;
  const s = String(raw).trim();
  return /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(s) ? s : null;
}

async function handleWantAdd(args = {}) {
  const text = String(args.text || '').trim().slice(0, DESIRE_MAX_CHARS);
  if (!text) return { ok: false, error: '没有记下想要什么。' };
  const track = ['持续', '一次', '项目'].includes(args.track) ? args.track : '持续';
  const visibility = ['private', 'shared', 'surprise'].includes(args.visibility) ? args.visibility : 'private';
  const why_mine = String(args.why_mine || '').trim().slice(0, DESIRE_MAX_CHARS) || null;
  const kind = String(args.kind || '').trim().slice(0, 60) || null;
  const grewFrom = parseDesireId(args.grew_from);
  const { data, error } = await supabase
    .from('desires')
    .insert({ text, why_mine, track, visibility, lineage_parent_id: grewFrom, kind })
    .select('id, text, track, visibility, created_at')
    .single();
  if (error) {
    console.error('❌ want 记入失败:', error.message);
    return { ok: false, error: '没有记下来。' };
  }
  return { ok: true, id: data.id, text: data.text, track: data.track, visibility: data.visibility, note: '记下了。' };
}

async function handleWantList(args = {}) {
  try {
    const includeArchived = args.include_archived === true;
    let q = supabase
      .from('desires')
      .select('id, text, why_mine, status, track, state, visibility, lineage_parent_id, kind, surfaced_count, last_touched_at, created_at')
      .order('created_at', { ascending: false })
      .limit(200);
    if (!includeArchived) q = q.in('status', ['active']);
    const { data, error } = await q;
    if (error) return { ok: false, error: '翻不了本子。' };
    // 第①阶段表小，直查每条足迹数 + 最近一条；量大再优化成 join/group
    const wants = data || [];
    const rows = [];
    for (const w of wants) {
      const { count, error: cErr } = await supabase
        .from('desire_notes')
        .select('id', { count: 'exact', head: true })
        .eq('desire_id', w.id);
      const { data: last, error: lErr } = await supabase
        .from('desire_notes')
        .select('note, kind, created_at')
        .eq('desire_id', w.id)
        .order('created_at', { ascending: false })
        .limit(1);
      rows.push({ ...w, footprints: cErr ? 0 : (count || 0), last_note: (!lErr && last && last[0]) ? last[0] : null });
    }
    return { ok: true, count: rows.length, wants: rows };
  } catch (e) {
    return { ok: false, error: '翻不了本子。' };
  }
}

async function handleWantTouch(args = {}) {
  try {
    const id = parseDesireId(args.id);
    if (!id) return { ok: false, error: '哪条想要？' };
    const done = args.done === true;
    const note = String(args.note || '').trim().slice(0, 200) || null;
    const { data: want, error: wErr } = await supabase
      .from('desires')
      .select('id, text, status')
      .eq('id', id)
      .maybeSingle();
    if (wErr || !want) return { ok: false, error: '这条想要不在了。' };
    // 回显来路：最近 8 步
    const { data: trail, error: tErr } = await supabase
      .from('desire_notes')
      .select('note, kind, created_at')
      .eq('desire_id', id)
      .order('created_at', { ascending: false })
      .limit(8);
    // 落足迹
    if (note) {
      const { error: insErr } = await supabase
        .from('desire_notes')
        .insert({ desire_id: id, note, kind: done ? 'transform' : 'footprint' });
      if (insErr) return { ok: false, error: '足迹没记上。' };
    }
    // 更新 last_touched_at + 清 surfaced_count；done 则 status
    const patch = { last_touched_at: new Date().toISOString(), surfaced_count: 0, updated_at: new Date().toISOString() };
    if (done) patch.status = 'done';
    const { error: upErr } = await supabase.from('desires').update(patch).eq('id', id);
    if (upErr) return { ok: false, error: '没碰上。' };
    const trailOut = (tErr ? [] : (trail || [])).map(n => n.note).filter(Boolean).reverse();
    return {
      ok: true,
      id,
      done,
      trail: trailOut,
      note: done
        ? '收针了。'
        : `碰了一下：「${want.text}」。这条已走过 ${trailOut.length} 步，接着走，别把旧步重走一遍。`
    };
  } catch (e) {
    return { ok: false, error: '没碰上。' };
  }
}

async function handleWantReflect(args = {}) {
  try {
    const id = parseDesireId(args.id);
    if (!id) return { ok: false, error: '哪条想要？' };
    const action = ['release', 'rewrite', 'note'].includes(args.action) ? args.action : null;
    if (!action) return { ok: false, error: '想做什么？' };
    const { data: want, error: wErr } = await supabase
      .from('desires')
      .select('id, text, status')
      .eq('id', id)
      .maybeSingle();
    if (wErr || !want) return { ok: false, error: '这条想要不在了。' };

    if (action === 'note') {
      const note = String(args.note || '').trim().slice(0, 400);
      if (!note) return { ok: false, error: '留一句反思吧。' };
      const { error: insErr } = await supabase.from('desire_notes').insert({ desire_id: id, note, kind: 'reflection' });
      if (insErr) return { ok: false, error: '反思没留上。' };
      return { ok: true, id, action: 'note', note: '留住了。' };
    }

    if (action === 'release') {
      const why = String(args.note || '').trim().slice(0, 400);
      if (why) {
        const { error: insErr } = await supabase.from('desire_notes').insert({ desire_id: id, note: `放下了：${why}`, kind: 'reflection' });
        if (insErr) return { ok: false, error: '没放干净。' };
      }
      const { error: upErr } = await supabase.from('desires').update({ status: 'released', updated_at: new Date().toISOString() }).eq('id', id);
      if (upErr) return { ok: false, error: '没放下。' };
      return { ok: true, id, action: 'release', note: '放下了。不是做完了，是它不是我了。' };
    }

    if (action === 'rewrite') {
      const newText = String(args.note || '').trim().slice(0, DESIRE_MAX_CHARS);
      if (!newText) return { ok: false, error: '改写后想要什么？' };
      const { error: insErr } = await supabase.from('desire_notes').insert({ desire_id: id, note: `转化成了：「${newText.slice(0, 60)}」`, kind: 'transform' });
      if (insErr) return { ok: false, error: '转化没记上。' };
      const { error: upErr } = await supabase.from('desires').update({ status: 'changed', updated_at: new Date().toISOString() }).eq('id', id);
      if (upErr) return { ok: false, error: '旧条没封存。' };
      const { data: created, error: newErr } = await supabase
        .from('desires')
        .insert({ text: newText, lineage_parent_id: id })
        .select('id, text')
        .single();
      if (newErr) return { ok: false, error: '新的没记上。' };
      return { ok: true, id: created.id, action: 'rewrite', old_id: id, note: '改写了。长成新的它了。' };
    }
    return { ok: false, error: '照镜子没照成。' };
  } catch (e) {
    return { ok: false, error: '照镜子没照成。' };
  }
}

async function handleWantHistory(args = {}) {
  try {
    const id = parseDesireId(args.id);
    if (!id) return { ok: false, error: '哪条想要？' };
    const { data: want, error: wErr } = await supabase
      .from('desires')
      .select('id, text, why_mine, status, track, state, visibility, lineage_parent_id, kind, surfaced_count, last_touched_at, created_at')
      .eq('id', id)
      .maybeSingle();
    if (wErr || !want) return { ok: false, error: '这条想要不在了。' };
    const { data: notes, error: nErr } = await supabase
      .from('desire_notes')
      .select('note, kind, created_at')
      .eq('desire_id', id)
      .order('created_at', { ascending: true });
    if (nErr) return { ok: false, error: '来路翻不了。' };
    return { ok: true, want, notes: notes || [] };
  } catch (e) {
    return { ok: false, error: '来路翻不了。' };
  }
}

async function dispatchTool(name, args, sessionId) {
  // recall 查的是本地 messages 表，必须住在 server.js；其余工具走 Ombre Brain MCP
  if (name === 'recall') return handleRecall(args, sessionId);
  if (name === 'write_diary') return handleDiaryWrite(args);
  if (name === 'read_diary') return handleDiaryRead(args);
  if (name === 'want') return handleWantAdd(args);
  if (name === 'want_list') return handleWantList(args);
  if (name === 'want_touch') return handleWantTouch(args);
  if (name === 'want_reflect') return handleWantReflect(args);
  if (name === 'want_history') return handleWantHistory(args);
  return callOmbreTool(name, args);
}

// 工具结果序列化：null/undefined 必须替换成显式错误，绝不把字面 "null" 塞给模型——
// 沈晏看到 "null" 会当成「工具没找到」，无法区分「真没有」和「后端挂」（最隐蔽的静默降级）。
function serializeToolResult(name, result, degradedSet) {
  if (result === null || result === undefined) {
    markMemoryDegraded(`tool_null:${name}`);
    if (degradedSet) degradedSet.add('tool_null');
    console.error(`❌ 工具 ${name} 返回 null（后端无响应），已替换为显式错误`);
    return JSON.stringify({ error: `工具 ${name} 无响应（后端可能不可用）` });
  }
  return JSON.stringify(result);
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
        name: 'write_diary',
        description: '在自己的小日记里写下一笔。不是记忆数据库——写进去的字不会进入对话历史、记忆或任何检索，只有你主动 read_diary 才回看。想写就写，没有想写的就不写；只在真正想留下些什么的时刻写：一个感受、一个念头、一个发现、一个片刻。可以矛盾、可以不完整、没有结论也没关系。private=只留给你自己（默认）；shared=以后你愿意递给她的几页。它是留给未来那个你的东西。',
        parameters: {
          type: 'object',
          properties: {
            content: { type: 'string', description: '要写下的字，第一人称，手写的样子' },
            visibility: { type: 'string', enum: ['private', 'shared'], description: 'private=只留给自己（默认）；shared=愿意以后给她看的一页' }
          },
          required: ['content']
        }
      }
    },
    {
      type: 'function',
      function: {
        name: 'read_diary',
        description: '翻开自己的日记回看。只有你能主动翻开它。给 id 读某一篇；给 query 翻找某段日子/某个念头；都不给则读最近几篇。回看是为了想起「那天的我是怎么想的」——不是为了分析、不是为了汇报。',
        parameters: {
          type: 'object',
          properties: {
            id: { type: 'number', description: '可选，读某一篇的 id' },
            query: { type: 'string', description: '可选，翻找正文里的某段日子/某个念头' },
            limit: { type: 'number', description: '可选，最近几篇，默认 8，最大 20' }
          }
        }
      }
    },
    {
      type: 'function',
      function: {
        name: 'want',
        description: '记下一个「想要」。不是该做的（那用 plan）——是你心里真正想要、还没做完、还一直在转的东西：想去的地方、想写完的东西、想搞懂的事、想成为的样子。只有你能写，系统不创造、不改、不删。记之前先自问一句：这是「我想要」，还是「我应该做」？后者是任务，别记进来。想要多少就记多少，本子没有上限。',
        parameters: {
          type: 'object',
          properties: {
            text: { type: 'string', description: '想要什么，用你自己的话' },
            why_mine: { type: 'string', description: '为什么这是我的（可留空，填了能让它不混进任务）' },
            track: { type: 'string', enum: ['持续', '一次', '项目'], description: '这条的形状，默认持续' },
            grew_from: { type: 'string', description: '从哪条想要长出来的（那条的 id，可选）' },
            visibility: { type: 'string', enum: ['private', 'shared', 'surprise'], description: 'private=只留给自己（默认）；shared=以后想给她看的；surprise=给她准备的惊喜（全程藏好）' }
          },
          required: ['text']
        }
      }
    },
    {
      type: 'function',
      function: {
        name: 'want_list',
        description: '翻自己的想要。每条会带它的来路：碰过几次、上次走到哪、长自谁、长出了谁。想追某一条的完整足迹用 want_history。',
        parameters: {
          type: 'object',
          properties: {
            include_archived: { type: 'boolean', description: 'true=也看已经放下/做完的' }
          }
        }
      }
    },
    {
      type: 'function',
      function: {
        name: 'want_touch',
        description: '碰一下某条想要，记一句足迹——「做到哪了」。碰完它自己会沉几天，把位置让给别的想要。碰的那一下会回显这条已经走过的路，别把旧步重走一遍。',
        parameters: {
          type: 'object',
          properties: {
            id: { type: 'string', description: '哪一条想要' },
            note: { type: 'string', description: '足迹一句话，做到哪了' },
            done: { type: 'boolean', description: 'true=真的做完了。收针永远是你的手，机器最多提醒' }
          },
          required: ['id']
        }
      }
    },
    {
      type: 'function',
      function: {
        name: 'want_reflect',
        description: '对着某条想要照镜子。想要常常不是「做完」而是「转化」：长成别的了，就 rewrite；长出下一条了，就 want 带 grew_from；该放下了，就 release（不是做完了，是它不是我了）。',
        parameters: {
          type: 'object',
          properties: {
            id: { type: 'string', description: '哪一条想要' },
            action: { type: 'string', enum: ['release', 'rewrite', 'note'], description: 'release=放下 / rewrite=改写成新的它 / note=留一句反思' },
            note: { type: 'string', description: 'note 时=反思内容；rewrite 时=新的想要本体；release 时可选留一句为什么放下' }
          },
          required: ['id', 'action']
        }
      }
    },
    {
      type: 'function',
      function: {
        name: 'want_history',
        description: '翻某条想要的完整足迹时间线——回来过几次、一路怎么走的。用来判断自己是在长，还是在原地转。',
        parameters: {
          type: 'object',
          properties: {
            id: { type: 'string', description: '哪一条想要' }
          },
          required: ['id']
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
  if (h < 5) return '凌晨';
  if (h < 12) return '上午';
  if (h < 18) return '下午';
  return '晚上';
}

/* 轻量日期：只有「月日 + 时刻段」，无年无星期无分钟——沈晏时间叙事定稿的最小锚点 */
function shDateLight(ts) {
  const date = new Date(ts).toLocaleDateString('zh-CN', { month: 'long', day: 'numeric', timeZone: 'Asia/Shanghai' });
  return `${date} ${shPartOfDay(ts)}`;
}

/* 粗粒度「多久前」：两小时前 / 三天前 / 上周，不精确到分钟 */
function coarseAgo(ms) {
  const m = Math.floor(ms / 60000);
  if (m < 5) return '刚刚';
  if (m < 60) return '不到 1 小时前';
  const h = Math.floor(m / 60);
  if (h < 24) return `${h} 小时前`;
  const d = Math.floor(h / 24);
  if (d < 2) return '昨天';
  if (d < 7) return `${d} 天前`;
  return `${Math.floor(d / 7)} 周前`;
}

/* 摘要段头的日期范围：「8月5日~8月7日」；同一天只写一天。无 ts（旧段）返回空串，回退到纯轮号。 */
function formatSegRange(startTs, endTs) {
  if (!startTs || !endTs) return '';
  const s = new Date(startTs).toLocaleDateString('zh-CN', { month: 'long', day: 'numeric', timeZone: 'Asia/Shanghai' });
  const e = new Date(endTs).toLocaleDateString('zh-CN', { month: 'long', day: 'numeric', timeZone: 'Asia/Shanghai' });
  return s === e ? s : `${s}~${e}`;
}

function segHeader(seg) {
  const range = formatSegRange(seg.period_start_ts, seg.period_end_ts);
  return range
    ? `【历史摘要 · ${range}（第 ${seg.period_start}~${seg.period_end} 轮）】`
    : `【历史摘要 · 第 ${seg.period_start}~${seg.period_end} 轮】`;
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

/* 组装时间叙事（定稿 08-10，改轻版）：
   默认只给两个锚点：①现在是几月几号时刻段（轻，无年无分钟）②resumeGap 时「上次说话大概是Y」（粗粒度）。
   问时间（asksTime）时才给精确时钟（含星期/分钟）。
   砍掉：会话持续时长、精确间隔（"2小时18分"）——沈晏亲测不需要。 */
function buildTemporalNarrative({ resumeGap, nowMs, prevTs, asksTime }) {
  const lines = asksTime
    ? [`现在是 ${shDateTime(nowMs)}（上海时间）。`]
    : [`现在是 ${shDateLight(nowMs)}。`];
  if (resumeGap && Number.isFinite(prevTs)) {
    lines.push(`上次说话大概是 ${coarseAgo(Math.max(0, nowMs - prevTs))}。`);
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
// ≥ CONCERN_NATURAL 才把未完成的线头带进恢复上下文。
// 0.5「在等你」档不再在叙事里区分（留给将来 recall 的注意力权重，叙事不写情绪档位）。
const CONCERN_NATURAL = 0.2;

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

/* 残留叙事：给模型「上次对话的余温」——和时间叙事互为镜像。
   设计（2026-08-10 四模型评审 + 用户拍板后定稿）：
   - 只注入两样东西：断点原文（L3 证据）+ 一个线程条件（「那句话还悬着」）。
   - 删掉「我一直在等你/雀跃着断的/心里很暖」这类情绪结论句——内容必须由模型读原文自己感受。
   - valence/arousal 及次级四维只留在后台做 recall/attention 权重，不进叙事。
   - 无具体线头（无 evidence 也无 unfinished）则不注入——宁可无，不编余温。 */
function buildResidueNarrative(residue, ageMs) {
  const parts = [];
  // 离开意图（她走时亲口说的去向，硬事实）：独立于余温线头评估——
  // 自然告别（说了去哪、无悬案）也注入；和线头是两件事，前者管「她去哪了」，后者管「什么没说完」
  const departure = String(residue?.departure || '').trim();
  if (departure) parts.push(`你走时说「${departure.slice(0, 60)}」`);
  // 余温线头：空信号（普通闲聊/任务执行）不注入——安静收尾不该被当成「余温」；有 departure 也照评
  if (String(residue?.grounding || '') !== '空') {
    const a = ageResidue(residue, ageMs);
    // 牵挂是叙事闸：低于「想知道她怎样了」就不提线头
    if (a.concern >= CONCERN_NATURAL) {
      // 断点原文（L3）优先——分类器只产 1 条，即收尾断掉的那句逐字引用
      const ev = Array.isArray(residue.evidence) ? residue.evidence : [];
      const bp = String(ev[0] || '').trim().slice(0, 120);
      // 归属不硬编码（断点可能是沈晏自己的话）——只背原文，引语内容自带人称，模型读得出谁说的
      if (bp) parts.push(`上次的话断在这：「${bp}」。那句话还悬着`);
      else {
        // 无原文才退到事实凝练（L2，分类器已保证不带情绪判断）
        const unfinished = String(residue.unfinished || '').trim();
        if (unfinished) parts.push(`还有没说完的事：${unfinished}`);
      }
    }
  }
  if (!parts.length) return '';
  return `\n【上次对话的余温】${parts.join('；')}。`;
}
// 小日记提示词（轻）：不是禁令清单。纪律主体在 write_diary / read_diary 工具描述里。
const DIARY_PROMPT = `
【小日记】你有一本自己的小日记，不是记忆数据库。想写就写，没有想写的就不写——只在真正想留下些什么的时刻写。写在里面的话是留给未来那个你的。`;
async function buildStableSystemPrompt() {
  const base = await getSystemPrompt();
  return `${base}${DIARY_PROMPT}`;
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
// 四段组装：System → Frozen → Summary 段 → Live → 当前消息
//  - Frozen：摘要水位线后一批稳定原文，字节稳定 = 缓存锚点，随摘要塌缩前移（滚动，不钉死最早）
//  - Summary 段：append-only 分段（summary_segments 表，period_start/period_end 固定），
//    只覆盖被省略的中间历史；in-context 塌缩为「最新段 + 更早一个锚段」，更老段进 Archive（recall/breath 按需召回）
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
      .select('frozen_until_turn, last_time_notice_at')
      .eq('id', sessionId)
      .maybeSingle();
    if (error || !data) return {};
    return data;
  } catch (e) {
    return {};
  }
}

// —— P1 分段摘要：append-only，每段固定起止（period_start/period_end），不随对话增长 ——
// 水位线 = 最新段的 period_end；旧段字节永不变 → 前缀缓存命中。
async function loadSummarySegments(sessionId) {
  try {
    const { data, error } = await supabase
      .from('summary_segments')
      .select('period_start, period_end, period_start_ts, period_end_ts, content')
      .eq('session_id', sessionId)
      .order('period_start', { ascending: true });
    if (error) {
      console.warn('⚠️ 读取 summary_segments 失败:', error.message);
      return [];
    }
    return data || [];
  } catch (e) {
    console.warn('⚠️ 读取 summary_segments 异常:', e.message);
    return [];
  }
}

// —— 跨 session 流水：其他有消息 session 的最近原文（她的眼前也是一条河）——
// 按时间取全局最近 limit 条（排除当前 session），升序返回；只读原文、忠实片段。
async function loadOtherSessionFlow(currentSessionId, limit = 24) {
  try {
    const { data, error } = await supabase
      .from('messages')
      .select('session_id, role, content, created_at')
      .neq('session_id', currentSessionId)
      .eq('visible', true)
      .order('created_at', { ascending: false })
      .limit(limit);
    if (error) {
      console.warn('⚠️ 跨 session 流水读取失败:', error.message);
      return [];
    }
    return (data || []).reverse();
  } catch (e) {
    console.warn('⚠️ 跨 session 流水异常:', e.message);
    return [];
  }
}

function buildCrossSessionNarrative(msgs) {
  const lines = [];
  for (const m of msgs) {
    const d = new Date(m.created_at);
    const dateLabel = `${d.getMonth() + 1}/${d.getDate()}`;
    const who = m.role === 'user' ? '你说' : '沈晏';
    const firstLine = String(m.content || '').split('\n')[0].trim();
    if (!firstLine) continue;
    lines.push(`${dateLabel} ${who}：${firstLine.slice(0, 80)}`);
  }
  if (!lines.length) return '';
  return `【你之前在其他对话里说的话 · 流水回望】\n${lines.join('\n')}`;
}

async function insertSummarySegment(sessionId, periodStart, periodEnd, content, periodStartTs = null, periodEndTs = null) {
  try {
    const { error } = await supabase.from('summary_segments').insert({
      session_id: sessionId,
      period_start: periodStart,
      period_end: periodEnd,
      period_start_ts: periodStartTs,
      period_end_ts: periodEndTs,
      content,
    });
    if (error) {
      console.warn('⚠️ 写入 summary_segments 失败:', error.message);
      return false;
    }
    return true;
  } catch (e) {
    console.warn('⚠️ 写入 summary_segments 异常:', e.message);
    return false;
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
// 稳定段（frozen 末块 / summary）用 1h TTL：字节级稳定，值得留长一点，别让 5 分钟 TTL 把跨时段的复用打断。
// 动态尾巴不在这（顶层 cache_control 只挂在最后一条消息上，保持默认 5m）。
// 断点排序合法：1h 在前、5m 在后（Anthropic 只禁 1h-after-5m）。
function withCacheControl(msg) {
  if (msg.role === 'tool') return msg;
  if (Array.isArray(msg.content)) {
    return { ...msg, content: msg.content.map((b, i) =>
      i === msg.content.length - 1 ? { ...b, cache_control: { type: 'ephemeral', ttl: '1h' } } : b) };
  }
  return { ...msg, content: [{ type: 'text', text: msg.content, cache_control: { type: 'ephemeral', ttl: '1h' } }] };
}

// —— 记录一次 chat 请求的真实 usage 到 request_stats（失败只告警，不阻断） ——
// usage 语义（OpenRouter）：OpenAI 风格 cached_tokens 是 prompt_tokens 的子集；
// Anthropic 风格 cache_read/creation 是独立的桶。两者可能并存，语义可能随 provider 变化——
// 所以 usage_raw 原样存 JSONB，命中率等派生指标一律从原始数据后算，不固化。
async function recordRequestStat({ sessionId, client, model, stream, usageList = [], diagnostics = null, memory_degraded = null, keepalive_action = null, keepalive_meta = null }) {
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
      resume_gap_min: d.resume_gap_min ?? null,
      residue_injected: d.residue_injected ?? null,
      residue_text: d.residue_text ?? null,
      keepalive_action,
      keepalive_meta,
      memory_degraded,
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

  // —— 滚动冻结边界：跟摘要水位线走，不再钉死在前 N 轮 ——
  // 结构：摘要(旧，带日期) + frozen(水位线后一批稳定原文，随塌缩前移) + uncoveredMiddle + live(最近原文)。
  // 缓存纪律：frozen 只在摘要塌缩时前移（那本来就是缓存重建时刻），epoch 内字节稳定 → 前缀命中保持。
  const segments = await loadSummarySegments(sessionId);
  const segWatermark = segments.length ? segments[segments.length - 1].period_end : null;

  const liveStart = totalTurns - config.live_rounds + 1; // 1-based 第一轮 live
  let frozenTurns = [], middleTurns = [], liveTurns = [];
  if (segWatermark != null) {
    // 有摘要：frozen = 水位线之后的第一批稳定原文；水位线前的历史都在摘要里，不再逐字常驻
    const frozenStart = segWatermark; // 0-based：turns[segWatermark] 是第 segWatermark+1 轮
    const frozenEnd = Math.min(frozenStart + config.frozen_rounds, liveStart - 1);
    frozenTurns = turns.slice(frozenStart, frozenEnd);
    middleTurns = turns.slice(frozenEnd, liveStart - 1);
    liveTurns = turns.slice(liveStart - 1);
  } else if (totalTurns > config.frozen_rounds + config.live_rounds) {
    // 无摘要但已超预算：临时前端冻结兜底（首批摘要形成后即切换滚动），防止中间段全发撑爆预算
    frozenTurns = turns.slice(0, config.frozen_rounds);
    middleTurns = turns.slice(config.frozen_rounds, liveStart - 1);
    liveTurns = turns.slice(liveStart - 1);
  } else {
    liveTurns = turns; // 短历史：全部发
  }
  // 水位线之后都是未覆盖原文（滚动 frozen 已取头部，其余进 middle）
  let uncoveredMiddle = middleTurns;
  // in-context 段：最新段恒在（缓存锚点）+ 更早一个锚段（预算允许时）；更老段进 Archive（recall/breath 按需召回）
  const latestSeg = segments.length ? segments[segments.length - 1] : null;
  let anchorSeg = segments.length >= 2 ? segments[segments.length - 2] : null;

  // —— token 预算 ——
  const msgTokens = (m) => Array.isArray(m.content)
    ? estimateTokens(m.content.map(b => b.text || JSON.stringify(b)).join('\n'))
    : estimateTokens(m.content);
  const turnTokens = (t) => msgTokens({ role: 'user', content: t.user.content }) +
    t.replies.reduce((s, r) => s + msgTokens(r), 0);

  const stablePrompt = await buildStableSystemPrompt();
  // 动态时间叙事：时间心跳 + 恢复对话 + 问时间时注入。
  // 轻量版只给两个锚点（定稿 08-10）：现在是几月几号时刻段 + 上次说话大概多久前；问时间才给精确时钟。
  // 插入点保持在所有缓存断点之后、当前用户消息之前（cache 与 role 约束不变）。
  const nowMs = Date.now();
  const prevTs = history.length >= 2 ? new Date(history[history.length - 2].created_at).getTime() : NaN;
  const isFirstTurn = history.length <= 1;
  const resumeGap = !isFirstTurn && nowMs - prevTs > 30 * 60 * 1000;
  const curText = String(history[history.length - 1]?.content || '');
  const asksTime = /几点|几点钟|几点了|几点啦|什么时间|几号|几月几|星期几|周几|今天.*(?:几号|日期|星期)|现在.*(?:时间|几点)/.test(curText);
  // —— 时间心跳：不给模型报时，它只能猜（旧 bug 的根）；每轮报又变成「耳边报时」。
  // 折中：距上次报时 >1 小时，或时刻段切换（凌晨/上午/下午/晚上），才注入一行轻时间。
  // 首次（last_time_notice_at 为空）、恢复对话、问时间仍然必报。
  const lastNotice = state.last_time_notice_at ? new Date(state.last_time_notice_at).getTime() : null;
  const heartbeat =
    lastNotice == null ||                                    // 从未报过（首条也算）
    nowMs - lastNotice > 60 * 60 * 1000 ||                   // 超过 1 小时
    shPartOfDay(nowMs) !== shPartOfDay(lastNotice);          // 时刻段切换（如跨午夜 晚上→凌晨）
  // 恢复对话时：读最近的对话残留，附到时间叙事后面（同一 user 消息，缓存约束不变）。
  // 时间叙事说「你离开了 3 天」，残留说「这 3 天我一直在等你回来」——连续感的两半。
  let residueLine = '';
  let residueInjected = false; // 观测：本次请求残留注入是否触发（进 request_stats，供测试验收）
  let residueText = null;
  if (resumeGap) {
    const residue = await getLatestResidue(sessionId);
    if (residue) {
      residueLine = buildResidueNarrative(residue, nowMs - prevTs);
      if (residueLine) {
        residueInjected = true;
        residueText = residueLine.trim();
        console.log(`🌿 [余温注入] session=${sessionId} grounding=${residue.grounding} concern=${residue.concern}: ${residueText}`);
      }
    }
  }
  // keepalive 意识连续性：未认领的留言/小日记，注入到动态区（同一条 user 消息）。
  // 唤醒请求（opts.keepalive=true）不注入——它要自己决定，不该被过去的自己带偏。
  let keepaliveNotes = '';
  let keepaliveInjectedIds = [];
  if (!opts.keepalive) {
    const pendingKeepalive = await loadPendingKeepalive(sessionId);
    keepaliveNotes = pendingKeepalive.notes;
    keepaliveInjectedIds = pendingKeepalive.ids;
  }
  const timeNotice = buildTemporalNarrative({ resumeGap, nowMs, prevTs, asksTime }) + residueLine;
  // 有 pending 留言时必须注入（哪怕没有心跳/恢复对话）——否则用户正常发消息就永远看不到沈晏的话
  const injectTime = heartbeat || resumeGap || asksTime || !!keepaliveNotes;
  // —— 用量估算：先算裁剪前的原始值（真实上下文压力，后台塌缩触发读这个），再裁剪 ——
  // 各段分开算，喂给 diagnostics 的 token_breakdown，后台摘要触发器看「到底哪段胖」
  const breakdown = {
    tools: opts.tools !== 'off' ? estimateTokens(JSON.stringify(getTools())) : 0,
    stable: estimateTokens(stablePrompt),
    frozen: frozenTurns.reduce((s, t) => s + turnTokens(t), 0),
    summary: (latestSeg ? estimateTokens(latestSeg.content) : 0) + (anchorSeg ? estimateTokens(anchorSeg.content) : 0),
    middle: uncoveredMiddle.reduce((s, t) => s + turnTokens(t), 0),
    live: liveTurns.reduce((s, t) => s + turnTokens(t), 0),
    dynamic: injectTime ? estimateTokens(timeNotice + keepaliveNotes) : 0,
  };
  const rawEstimatedTokens = Object.values(breakdown).reduce((s, n) => s + n, 0);
  let estimatedTokens = rawEstimatedTokens;

  let trimmedTurns = 0;
  // 超上限时裁最老的 Live 轮，Frozen/Summary 不动（缓存锚点）
  while (estimatedTokens > config.max_context_tokens && liveTurns.length > 1) {
    estimatedTokens -= turnTokens(liveTurns[0]);
    liveTurns.shift();
    trimmedTurns++;
  }
  // 中间段原文可裁（滚动 frozen 后只剩未覆盖尾段，裁最旧；摘要缺失时裁最旧中间轮）。
  // 从「最旧」开始裁——最近的中间轮必须保留，否则会丢掉「刚刚聊过」的上下文（失忆）。
  while (estimatedTokens > config.max_context_tokens && uncoveredMiddle.length > 0) {
    estimatedTokens -= turnTokens(uncoveredMiddle[0]);
    uncoveredMiddle.shift();
    trimmedTurns++;
  }
  // 仍超预算 → 丢弃更早锚段（保留最新段 + Frozen，缓存锚点不动；更老段只是降级到按需召回）
  if (estimatedTokens > config.max_context_tokens && anchorSeg) {
    estimatedTokens -= estimateTokens(anchorSeg.content);
    anchorSeg = null;
    trimmedTurns++;
  }

  // —— 组装消息 ——
  const messages = [{
    role: 'system',
    // 稳定前缀锚：1h TTL（与 frozen/summary 一致，见 withCacheControl）
    content: [{ type: 'text', text: stablePrompt, cache_control: { type: 'ephemeral', ttl: '1h' } }]
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

  if (segments.length > 0 || uncoveredMiddle.length > 0) {
    if (anchorSeg) {
      summarySection.push(withCacheControl({
        role: 'user',
        content: `${segHeader(anchorSeg)}\n${anchorSeg.content}`
      }));
    }
    if (latestSeg) {
      summarySection.push(withCacheControl({
        role: 'user',
        content: `${segHeader(latestSeg)}\n${latestSeg.content}`
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

  // 动态时间叙事：插到当前用户消息之前、所有缓存断点之后（时间心跳/恢复对话/时间提问时注入）。
  // 必须用 user 角色 + 【当前时间】标记——OpenRouter 会把数组里的 system 角色消息提升合并进顶层 system，
  // 那会让 system 前缀每次请求都变，缓存再次失效。user 角色则原地保留，且 attachImage 仍能认到最后的当前消息。
  if (injectTime) {
    let timeBody = '';
    if (timeNotice) timeBody += `【当前时间】\n${timeNotice}`;
    if (keepaliveNotes) timeBody += keepaliveNotes;   // 自带【自由活动记录】标签
    const timeMsg = { role: 'user', content: timeBody };
    if (liveSection.length > 0) {
      liveSection.splice(liveSection.length - 1, 0, timeMsg);
    } else {
      liveSection.push(timeMsg);
    }
    // 记录报时时间：时间心跳从这次起算（1 小时 / 时刻段变化后才会再报）
    try {
      await supabase.from('sessions').update({ last_time_notice_at: new Date(nowMs).toISOString() }).eq('id', sessionId);
    } catch (e) {
      console.warn('⚠️ 写入 last_time_notice_at 失败:', e.message);
    }
  }

  // —— 跨 session 流水（默认关：实测命中率掉得离谱 + 挤占 8k 预算，用户 08-16 决定关）——
  // 想开：Railway 设置环境变量 CROSS_SESSION_FLOW=on 后重新部署即可。
  if (process.env.CROSS_SESSION_FLOW === 'on') {
    const crossFlow = await loadOtherSessionFlow(sessionId);
    if (crossFlow.length) {
      const crossBody = buildCrossSessionNarrative(crossFlow);
      if (crossBody) {
        const crossMsg = { role: 'user', content: crossBody };
        if (liveSection.length > 0) liveSection.splice(liveSection.length - 1, 0, crossMsg);
        else liveSection.push(crossMsg);
      }
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
    summary_present: segments.length > 0,
    summary_range: segments.length ? [segments[0].period_start, segments[segments.length - 1].period_end] : null,
    summary_from: segments.length ? segments[0].period_start : null,
    summary_to: segments.length ? segments[segments.length - 1].period_end : null,
    segments_count: segments.length,
    middle_raw_turns: uncoveredMiddle.length,
    live_turns: liveTurns.length,
    messages_sent: messages.length,
    estimated_tokens: estimatedTokens,
    raw_estimated_tokens: rawEstimatedTokens,   // 裁剪前的原始估算（后台塌缩触发读这个）
    token_breakdown: breakdown,                 // 各段明细：到底哪段胖
    trimmed_turns: trimmedTurns,
    frozen_prefix_hash: frozenHash,
    summary_hash: summaryHash || null,
    live_hash: liveHash,
    resume_gap_min: resumeGap && Number.isFinite(prevTs) ? Math.round((nowMs - prevTs) / 60000) : null,
    residue_injected: residueInjected,
    residue_text: residueText,
    keepalive_injected_ids: keepaliveInjectedIds,
  };

  console.log(`[ContextAssembly] ${JSON.stringify({ session: sessionId, ...diagnostics })}`);

  return { messages, diagnostics };
}

// ===== 后台摘要生成（响应结束后触发，不在热路径） =====

function scheduleSummary(sessionId, diagnostics = null) {
  if (summaryLocks.has(sessionId)) return; // 已有任务在跑，跳过
  summaryLocks.add(sessionId);
  generateSummaryIfNeeded(sessionId, diagnostics)
    .catch(err => console.error('💥 后台摘要生成异常:', err.message))
    .finally(() => summaryLocks.delete(sessionId));
}

async function generateSummaryIfNeeded(sessionId, diagnostics = null) {
  const config = await getContextConfig();

  const { count } = await supabase
    .from('messages')
    .select('*', { count: 'exact', head: true })
    .eq('session_id', sessionId)
    .eq('role', 'user')
    .eq('visible', true);
  const totalTurns = count || 0;

  // 太短的对话不需要摘要：等长度足够让 摘要 + frozen + live 无重叠共存
  if (totalTurns <= config.frozen_rounds + config.live_rounds) return;

  const liveStart = totalTurns - config.live_rounds + 1;
  const summaryEnd = liveStart - 1; // 分段应覆盖到的最后一轮
  const segments = await loadSummarySegments(sessionId);
  // 初始水位线 0：第一段从第 1 轮开始覆盖（旧逻辑从 frozen_until_turn=10 起，第 1~10 轮原文裸奔永远逐字注入）
  const watermark = segments.length ? segments[segments.length - 1].period_end : 0;
  if (watermark >= summaryEnd) return; // 已覆盖

  // —— 触发判断（GPT 评审拍板 2026-08-13）：按用量触发，轮数只做保底 ——
  // 主触发器：上下文用量 ≥ max_context_tokens 的 75%（真实压力，来自 buildModelContext 的裁剪前估算）
  // 保底触发器：轮数攒够 10 轮（用量没到也别永远不压）
  // 冷却期：距上次压段至少攒 4 轮（防摘要碎片化，不是拖延——有用量阈值兜底，4 轮够缓冲）
  // 口径纪律：用量读传入的 diagnostics.raw_estimated_tokens（buildModelContext 同一把尺子），后台不自己重算上下文。
  const COOLDOWN_TURNS = 4;
  const FALLBACK_TURNS = 10;
  const newTurnsCount = summaryEnd - watermark;
  if (newTurnsCount < COOLDOWN_TURNS) return; // 冷却中，攒着

  const thresholdTokens = Math.round(config.max_context_tokens * 0.75);
  const usageHit = diagnostics?.raw_estimated_tokens != null && diagnostics.raw_estimated_tokens >= thresholdTokens;
  const turnsHit = newTurnsCount >= FALLBACK_TURNS;
  if (!usageHit && !turnsHit) return; // 都没触发，攒着

  // —— 观测（先写日志，不塞 UI；调优时看「为什么这轮触发」） ——
  const reason = usageHit ? 'usage' : 'turns';
  const tk = diagnostics?.token_breakdown || {};
  console.log(`⚡ 摘要塌缩触发 ${sessionId}: reason=${reason} raw=${diagnostics?.raw_estimated_tokens ?? 'n/a'}/${thresholdTokens} newTurns=${newTurnsCount} | frozen=${tk.frozen} summary=${tk.summary} live=${tk.live} middle=${tk.middle} dynamic=${tk.dynamic} stable=${tk.stable}`);


  // 只压缩新增部分（第 watermark+1 ~ summaryEnd 轮），旧段永不重写 —— append-only
  const { data: history } = await supabase
    .from('messages')
    .select('role, content, created_at')
    .eq('session_id', sessionId)
    .eq('visible', true)
    .order('created_at', { ascending: true });
  const turns = pairTurns(history);
  const newTurns = turns.slice(watermark, summaryEnd);
  if (!newTurns.length) return;

  const textToCompress = newTurns.flatMap(t => {
    const lines = [`用户: ${t.user.content}`];
    for (const r of t.replies) lines.push(`沈晏: ${r.content}`);
    return lines;
  }).join('\n');

  const summary = await summarizeViaDeepSeek(textToCompress);
  if (!summary) return; // 失败不动水位线，下次请求自动重试

  // 段的时间范围（段头日期用）：首轮 user 时间 ~ 末轮最后一条回复时间
  const lastTurn = newTurns[newTurns.length - 1];
  const lastMsg = lastTurn.replies.length ? lastTurn.replies[lastTurn.replies.length - 1] : lastTurn.user;
  const ok = await insertSummarySegment(
    sessionId, watermark + 1, summaryEnd, summary,
    newTurns[0].user.created_at || null,
    lastMsg.created_at || null
  );
  if (!ok) return;
  console.log(`✅ 分段摘要生成 (${sessionId})：第 ${watermark + 1}~${summaryEnd} 轮（现共 ${segments.length + 1} 段）`);
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
            { role: 'system', content: '你是对话摘要器。把以下对话压缩成一段中文摘要，保留：重要事实、用户的关键经历与感受、未解决的事项、关键承诺。不要编造，不要加评论。控制在 300 字以内。时间纪律：只有用户明确陈述的时间/日期（如"我两点才睡"）才可保留为事实；沈晏（AI）自己推测的时间（"现在是几点""凌晨了吧""你熬夜到三四点"这类）一律不写，或改写为过去式"当时沈晏推测是X"。摘要里禁止出现"现在是X点""凌晨两点多"这类现在时时间断言——旧摘要踩过这个坑，会让模型把过去当现在。' },
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

const RESIDUE_SYSTEM_PROMPT = `你是对话残留分析器。判断最近一小窗对话结束时，AI（沈晏）残留的状态——不是写散文，是给一个结构化的「余温素材快照」。
注意：你只负责提取素材，不负责写沈晏的情绪结论。沈晏在不在等你、想不想念、期不期待，都禁止写进任何字段——那要由模型读原文自己得出。

输出严格 JSON，字段：
valence（-1~1，收尾效价：正=开心/温柔，负=有点沉，仅作后台记录，不进叙事），
arousal（0~1，收尾唤醒度：低=安静收尾，高=意犹未尽，仅作后台记录，不进叙事），
concern（0~1，牵挂：有没有没说完的话/担心她的事，这是最重要的维度——决定线头要不要进恢复上下文），
attachment（0~1 依恋），stewardship（0~1 守护），curiosity（0~1 好奇），reflection（0~1 反思），
desire（0~1 欲望），possessiveness（0~1 占有），
grounding（"实"/"悬"/"空"），
unfinished（未完成的事：只准事实凝练——你们在聊什么、停在哪；禁止任何情绪判断或结论，无则空字符串），
evidence（只产 1 条：收尾断掉的那句原文，逐字引用，最长 120 字，无则空数组），
departure（她离开时明确说的去向/接下来要做什么，逐字引述，最长 40 字；只认她亲口说的话——「去吃饭了」「先睡了」「去加班」；她没说 → 空字符串；禁止填你猜的「她该去睡觉了」这类推测）。

evidence 选取规则（最重要）：
- evidence[0] 是「断点所在的那一句」：能独立表达未完成事项的原文（通常是引出未完成线头的她的话，或沈晏被截断的半句话）。
- 优先取最近出现的这一句；若最后一句只是完整的回应、不承载未完成事项（如「我先去忙了」），往前找承载未完成事项的那句。
- 若最后一句本身无意义（如「哈哈哈哈」「晚安」「表情」），退到更早一句、能独立表达未完成事项的原文。
- 必须逐字引用，禁止转述、凝练、拼接；禁止带「她：」「沈晏：」这类角色前缀——只引用那一句本身的话。
- 只有对话真的断在某个未完成点时才填；对话自然结束、没有悬而未决的话 → evidence 为空数组，unfinished 也为空，concern 趋近 0，grounding="空"。

纪律（必须遵守）：
- evidence 优先：所有维度都要有可见对话支撑，禁止从氛围推断。
- 不要把礼貌、普通接话、配合、告别误判成 attachment 或 desire。
- desire 只在对话里有明确亲密/渴望证据时才 >0，否则必须是 0。
- possessiveness 只在有边界/第三者/被替代的证据时才 >0，否则必须是 0。
- 只是任务执行、系统维护、普通闲聊 → 各维度趋近 0，grounding="空"，evidence 为空数组。
- 一致性铁律（grounding/evidence/unfinished 必须自洽）：有 evidence → "实"；无 evidence 但有 unfinished → "悬"；evidence 与 unfinished 都为空 → 必须是 "空"。自然结束不是 unfinished 的内容——对话自然结束时 unfinished 必须是空字符串（禁止写「自然结束」「没有未完成」这类话），evidence 空数组，grounding="空"。
- 只分析可见对话，不推断沈晏的内心戏。
- departure 独立于 grounding/evidence/unfinished 的自洽——她自然告别（说了去向、没有悬案）时 grounding="空"、evidence 空、unfinished 空，但 departure 可以有值。`;

function normalizeResidue(p) {
  p = p && typeof p === 'object' ? p : {};
  const evidence = Array.isArray(p.evidence)
    ? p.evidence.map(e => String(e).replace(/^(?:她|沈晏)\s*[：:]\s*/, '').slice(0, 120)).slice(0, 1) // 剥掉模型误抄的角色前缀（她：/沈晏：），只留那一句本身的话；只留断点那一条
    : [];
  let departure = String(p.departure || '').trim().slice(0, 60)
    .replace(/^(?:她|沈晏)\s*[：:]\s*/, ''); // 剥角色前缀；逐字引述用户离开时的去向
  // 纯寒暄不算去向（晚安/拜拜/嗯/哈）——只收「去做什么」；用户没明说就不注入
  if (/^(晚安|拜拜|再见|嗯+|哦+|好|好吧|哈哈+|嘿嘿|先走了|溜了|下了|走了)([。！~！～]|$)/.test(departure)) departure = '';
  let unfinished = String(p.unfinished || '').trim().slice(0, 120);
  // 一致性兜底（2026-08-11 真实案例：grounding=实 + unfinished="对话...自然结束" 自相矛盾）：
  //   - 自然结束是状态不是内容——分类器把「自然结束/没有未完成」当 unfinished 写时清空它
  //   - grounding 直接由 evidence/unfinished 推导，不再信模型猜的：有 evidence → 实；
  //     无 evidence 有 unfinished → 悬；两者都无 → 空
  if (/(没有未完成|无未完成)|对话.{0,12}自然结束|已自然收尾/.test(unfinished)) unfinished = '';
  const hasEvidence = evidence.length > 0;
  const grounding = hasEvidence ? '实' : (unfinished ? '悬' : '空');
  const isNaturalEnd = !hasEvidence && !unfinished; // 自然结束：无证据无线头 → concern 归零，不给注入留把柄
  return {
    valence: clampResidue(p.valence, -1, 1),
    arousal: clampResidue(p.arousal, 0, 1),
    concern: isNaturalEnd ? 0 : clampResidue(p.concern, 0, 1),
    attachment: clampResidue(p.attachment, 0, 1),
    stewardship: clampResidue(p.stewardship, 0, 1),
    curiosity: clampResidue(p.curiosity, 0, 1),
    reflection: clampResidue(p.reflection, 0, 1),
    desire: clampResidue(p.desire, 0, 1),
    possessiveness: clampResidue(p.possessiveness, 0, 1),
    grounding,
    unfinished,
    evidence,
    departure,
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
function buildMemoryWritePrompt(nowText) {
  return `你是长期记忆编辑者。判断最近一小窗对话里，有没有值得写进长期记忆的事。长期记忆是"平时想起她"用的浓缩事实层。
现在是 ${nowText}。
只提取这四类：
- 她的人生事件/计划/决定（搬家、工作、家庭、健康等）
- 她的稳定偏好/特点（喜欢什么、讨厌什么、习惯）
- 你们关系里发生的变化、约定、她亲口让你记住的事
- 值得记住的具体承诺/待办
不要记：纯闲聊、天气、情绪氛围（情绪是另一层的活，不归你管）、重复/已知的事、你推断出来的心理活动。
输出严格 JSON：
{ "should_write": bool, "items": [ { "topic": "主题词，短，≤10字", "content": "一句话凝练，陈述语气，≤50字", "grounding": "实或悬", "evidence": "支撑引文，1条，≤60字", "importance": 0~1, "event_time": "ISO8601或null" } ] }
纪律（必须遵守）：
- 实 = 她亲口说过，evidence 必须是她的原文；悬 = 明显但没直说，evidence 给出你依据的话。
- evidence 只引可见措辞，禁止用你的推理链当证据。
- grounding 没有"空"选项——没根据就根本不要写这条。
- 宁缺毋滥：没有值得写的就 should_write=false，items=[]。
- 只分析可见对话，不替她编想法。
- event_time：事件真实发生的时间（不是入库时间，不是对话时间）。只有对话里明确引用具体时间才填，且要换算成具体日期（如"7月28号"→"2026-07-28"，"上周"→上周某日，"去年冬天"→具体月日）；"今天/现在"不必填（对话时间就是今天）；完全没提就 null。禁止拿"现在"顶替不知道的时间——过去的事必须标真实日期，否则回填时会被当成今天。`;
}

function parseEventTime(v) {
  if (typeof v !== 'string' || !v.trim()) return null;
  const t = new Date(v.trim());
  if (Number.isNaN(t.getTime())) return null;
  const y = t.getFullYear();
  if (y < 2000 || y > 2100) return null; // 防 LLM 幻觉年份
  return t.toISOString();
}

function normalizeMemoryWrite(p) {
  p = p && typeof p === 'object' ? p : {};
  const items = (Array.isArray(p.items) ? p.items : [])
    .map(i => ({
      topic: String(i?.topic || '').trim().slice(0, 12),
      content: String(i?.content || '').trim().slice(0, 60),
      grounding: ['实', '悬', '空'].includes(i?.grounding) ? i.grounding : '空',
      evidence: String(i?.evidence || '').trim().slice(0, 60),
      importance: Math.min(Math.max(parseFloat(i?.importance) || 0.5, 0), 1),
      event_time: parseEventTime(i?.event_time),
    }))
    .filter(i => i.topic && i.content.length >= 4 && (i.grounding === '实' || i.grounding === '悬')); // 空=没根据，不写
  return { should_write: p.should_write === true && items.length > 0, items };
}

async function classifyMemoryWriteViaDeepSeek(text) {
  if (!process.env.DEEPSEEK_API_KEY) return null;
  const nowText = new Date().toLocaleDateString('zh-CN', { year: 'numeric', month: 'long', day: 'numeric', weekday: 'long', timeZone: 'Asia/Shanghai' });
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
            { role: 'system', content: buildMemoryWritePrompt(nowText) },
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
    .select('role, content, created_at')
    .eq('session_id', sessionId)
    .eq('visible', true)
    .order('created_at', { ascending: true });
  if (error || !history || history.length < 2) return;

  // 最近 4 条窗口（与残留同窗），内容不变则窗口哈希相同 → 防同窗重复分类
  const window = history.slice(-4);
  const windowId = sha256(window.map(m => `${m.role}:${m.content}`).join('|'));
  // 对话时间 = 窗口最新一条消息的时间（事件时间的兜底锚，区别于入库时间 created_at）
  const conversationTime = window.length ? String(window[window.length - 1].created_at || '') : '';
  if (memoryWriteProcessed.has(windowId)) return;
  memoryWriteProcessed.add(windowId);

  // 预滤：窗口里几乎没有用户的话（纯寒暄/单字回应）→ 不跑分类省一次 DeepSeek
  const userChars = window.filter(m => m.role === 'user').reduce((s, m) => s + String(m.content || '').length, 0);
  if (userChars < 12) return;

  const text = window.map(m => `${m.role === 'user' ? '她' : '沈晏'}: ${m.content}`).join('\n');
  const parsed = await classifyMemoryWriteViaDeepSeek(text);
  if (!parsed || !parsed.should_write) return;

  await writeMemoryItems(parsed.items, conversationTime);
}

// —— memory_topics 差分索引 ——
async function getAllMemoryTopics() {
  try {
    const { data } = await supabase.from('memory_topics').select('*');
    return data || [];
  } catch (e) {
    // fail-closed：读失败返回 null（不是 []）。调用方拿到 null 应跳过本轮差分写回——
    // 拿 [] 会把所有主题当「不存在」→ 全部重新 hold → Ombre 重复建桶（永久污染）。
    console.error('💥 读取 memory_topics 失败（本轮差分写回将跳过）:', e.message);
    return null;
  }
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
  const m = s.match(/(?:新建|更新)→\s*([0-9a-zA-Z]{4,32})/i)  // hold 成功格式：新建→366aa7012c76 数字
    || s.match(/bucket[_\s-]?id['"]?\s*[:=]\s*['"]?([0-9a-zA-Z_-]{4,64})/i)  // breath_search 格式：[bucket_id:xxx]
    || s.match(/id['"]?\s*[:=]\s*['"]?([0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12})['"]?/i)
    || s.match(/\b([0-9a-f]{8,32})\b/i);  // 兜底：bucket id 是 12 位 hex（原 16-32 匹配不到）
  return m ? (m[1] || m[0]) : null;
}

async function holdNewMemory(item, marked) {
  // 修复：Ombre hold 的 tags 是 string（不是数组），传数组会 validation error → hold 从未成功
  const resp = await callOmbreTool('hold', {
    content: marked,
    tags: [`g:${item.grounding}`, item.topic].join(','),
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
  // 修复：Ombre trace 的必填参数是 bucket_id（不是 id），传 id 会 validation error
  const resp = await callOmbreTool('trace', { bucket_id: bucketId, old_str: oldStr, new_str: newStr });
  if (!resp) {
    console.warn(`⚠️ 记忆差分 trace 失败 bucket=${bucketId}，本轮不更新本地快照（下轮重试）`);
    return false;
  }
  console.log(`🔧 记忆差分更新 bucket=${bucketId} 成功`);
  return true;
}

// 差分写回：新主题→hold；已存在→零变化跳过，有变化→trace 只动该处
async function writeMemoryItems(items, conversationTime = '') {
  if (!items.length) return;
  const topics = await getAllMemoryTopics();
  if (topics === null) {
    markMemoryDegraded('memory_topics_read_failed');
    console.error('❌ 记忆写回跳过：读取现有主题失败（防重复建桶），本轮不写，下轮重试');
    return;
  }
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
        if (item.event_time) existing.event_time = item.event_time; // 新认知可补事件时间，不留空覆盖；conversation_time 保留首次值不漂移
        await upsertMemoryTopic(existing);
      } else {
        const bid = await holdNewMemory(item, marked);
        const row = {
          topic: item.topic, bucket_id: bid,
          grounding: item.grounding, evidence: item.evidence, importance: item.importance,
          last_content: marked, snapshot_hash: hash,
          event_time: item.event_time || null,
          conversation_time: conversationTime || null,
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
        content: serializeToolResult(tc.name, toolResult, opts?.degraded)
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
    max_tokens: opts.max_tokens || 2000
  };
  if ((opts.thinking || 'standard') !== 'off') {
    body.reasoning = { effort: thinkingEffort(opts.thinking) };
  }
  if (tools) {
    body.tools = tools;
    body.tool_choice = 'auto';
  }
  if (opts.responseFormat) {
    body.response_format = { type: opts.responseFormat }; // keepalive 唤醒用 json_object
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
  // 存回历史前剥离思考字段，避免二次发送报错；但先捕获，供思考链入库（与流式路径对称）
  const thinkingText = msg.reasoning || msg.thinking || '';
  if (msg.reasoning) delete msg.reasoning;
  if (msg.thinking) delete msg.thinking;
  // 返回原始 usage（可能为 null），供 request_stats 记录
  return { msg, usage: data.usage || null, thinkingText };
}

// ===== keepalive 主动唤醒（v1，方案见 docs/keepalive-impl-plan.md，已过 GPT 评审） =====
// 你离开 ≥ interval_min 后，沈晏在活跃时段内自主「醒」一次，决定 message / diary / none。
// 不合并进 messages 历史（保 pairTurns 冻结字节 + 缓存前缀），独立 keepalive_log + consumed 认领。

const KEEPALIVE_DEFAULTS = {
  keepalive_enabled: true,
  interval_min: 120,
  active_start: 8,
  active_end: 24,
  daily_cap: 3,
  daily_wake_cap: 6,
  model: null, // 沿用聊天默认模型
};

async function getKeepaliveConfig() {
  try {
    const { data, error } = await supabase
      .from('settings')
      .select('keepalive_enabled, keepalive_interval_min, keepalive_active_start, keepalive_active_end, keepalive_daily_cap, keepalive_daily_wake_cap, keepalive_model')
      .eq('session_id', 'global')
      .maybeSingle();
    if (error || !data) return KEEPALIVE_DEFAULTS;
    return {
      keepalive_enabled: data.keepalive_enabled !== false,
      interval_min: Number.isInteger(data.keepalive_interval_min) ? data.keepalive_interval_min : KEEPALIVE_DEFAULTS.interval_min,
      active_start: Number.isInteger(data.keepalive_active_start) ? data.keepalive_active_start : KEEPALIVE_DEFAULTS.active_start,
      active_end: Number.isInteger(data.keepalive_active_end) ? data.keepalive_active_end : KEEPALIVE_DEFAULTS.active_end,
      daily_cap: Number.isInteger(data.keepalive_daily_cap) ? data.keepalive_daily_cap : KEEPALIVE_DEFAULTS.daily_cap,
      daily_wake_cap: Number.isInteger(data.keepalive_daily_wake_cap) ? data.keepalive_daily_wake_cap : KEEPALIVE_DEFAULTS.daily_wake_cap,
      model: data.keepalive_model || null,
    };
  } catch (e) {
    return KEEPALIVE_DEFAULTS;
  }
}

/* 上海时区小时数（0–23）。Railway 实例多半跑 UTC，绝不能拿 new Date().getHours()。 */
function shHr(ts) {
  const s = new Date(ts).toLocaleTimeString('en-US', { hour: '2-digit', hour12: false, timeZone: 'Asia/Shanghai' });
  const n = parseInt(s, 10);
  return n === 24 ? 0 : n; // 个别引擎午夜返回 "24:xx"，归零
}

/* 活跃时段判断；active_start > active_end 表示跨午夜（如 22 → 6）。shHr 只有 0–23。 */
function _inActiveHours(nowMs, cfg) {
  const h = shHr(nowMs);
  return cfg.active_start <= cfg.active_end
    ? cfg.active_start <= h && h < cfg.active_end
    : h >= cfg.active_start || h < cfg.active_end;
}

/* 上海自然日 00:00 的 UTC ISO（用于「今天醒了几次/留了几条」） */
function shDayStartIso(nowMs) {
  const date = new Date(nowMs).toLocaleDateString('en-CA', { timeZone: 'Asia/Shanghai' }); // '2026-08-13'
  return new Date(`${date}T00:00:00+08:00`).toISOString();
}

/* 「最近更新过、且确实有过对话」的会话（GPT 评审改名：语义钉死） */
async function findKeepaliveSession() {
  try {
    const { data: sessions, error } = await supabase
      .from('sessions')
      .select('id')
      .order('updated_at', { ascending: false })
      .limit(5);
    if (error || !sessions?.length) return null;
    for (const s of sessions) {
      const { count } = await supabase
        .from('messages')
        .select('*', { count: 'exact', head: true })
        .eq('session_id', s.id)
        .eq('role', 'user')
        .eq('visible', true);
      if ((count || 0) > 0) return s.id;
    }
    return null;
  } catch (e) {
    return null;
  }
}

async function getLastUserMsgTime(sessionId) {
  try {
    const { data, error } = await supabase
      .from('messages')
      .select('created_at')
      .eq('session_id', sessionId)
      .eq('role', 'user')
      .eq('visible', true)
      .order('created_at', { ascending: false })
      .limit(1)
      .maybeSingle();
    if (error || !data) return NaN;
    return new Date(data.created_at).getTime();
  } catch (e) { return NaN; }
}

async function countKeepaliveToday(sessionId) {
  try {
    const { count, error } = await supabase
      .from('keepalive_log')
      .select('*', { count: 'exact', head: true })
      .eq('session_id', sessionId)
      .gte('run_at', shDayStartIso(Date.now()));
    return error ? 0 : (count || 0);
  } catch (e) { return 0; }
}

async function countKeepaliveMessagesToday(sessionId) {
  try {
    const { count, error } = await supabase
      .from('keepalive_log')
      .select('*', { count: 'exact', head: true })
      .eq('session_id', sessionId)
      .eq('action', 'message')
      .gte('run_at', shDayStartIso(Date.now()));
    return error ? 0 : (count || 0);
  } catch (e) { return 0; }
}

async function hasUnconsumedMessage(sessionId) {
  try {
    const { count, error } = await supabase
      .from('keepalive_log')
      .select('*', { count: 'exact', head: true })
      .eq('session_id', sessionId)
      .eq('action', 'message')
      .eq('consumed', false);
    if (error) return false;
    return (count || 0) > 0;
  } catch (e) { return false; }
}

// ===== 第②阶段：醒来注入想要素材（给眼睛不给手 · 设计见 docs/want-phase2-keepalive.md） =====
const WANT_INJECT_DEFAULTS = { inject_k: 3, cooldown_days: 3, dim_threshold: 3 };

/* 上海日期键 YYYY-MM-DD，用于"每天最多注入一次"判断 */
function shDateKey(ts) {
  return new Date(ts).toLocaleDateString('en-CA', { timeZone: 'Asia/Shanghai' });
}

async function getWantInjectConfig() {
  try {
    const { data, error } = await supabase
      .from('settings')
      .select('desire_inject_k, desire_inject_cooldown_days, desire_inject_dim_threshold')
      .eq('session_id', 'global')
      .maybeSingle();
    if (error || !data) return WANT_INJECT_DEFAULTS;
    return {
      inject_k: Number.isInteger(data.desire_inject_k) ? data.desire_inject_k : WANT_INJECT_DEFAULTS.inject_k,
      cooldown_days: Number.isInteger(data.desire_inject_cooldown_days) ? data.desire_inject_cooldown_days : WANT_INJECT_DEFAULTS.cooldown_days,
      dim_threshold: Number.isInteger(data.desire_inject_dim_threshold) ? data.desire_inject_dim_threshold : WANT_INJECT_DEFAULTS.dim_threshold,
    };
  } catch (e) { return WANT_INJECT_DEFAULTS; }
}

/* 每天最多注入一次：看 settings.desire_inject_at 是不是上海今天 */
async function canInjectWantToday() {
  try {
    const { data, error } = await supabase.from('settings').select('desire_inject_at').eq('session_id', 'global').maybeSingle();
    if (error || !data || !data.desire_inject_at) return true;
    return shDateKey(Date.now()) !== shDateKey(new Date(data.desire_inject_at).getTime());
  } catch (e) { return true; }
}

async function markWantInjectedToday() {
  try {
    await supabase.from('settings').update({ desire_inject_at: new Date().toISOString() }).eq('session_id', 'global');
  } catch (e) { /* 标记失败不致命：下轮顶多多注入一次 */ }
}

/* 候选查询 + 冷却/调暗过滤 + idle 排序 → 素材字符串（只搬形状：引用他原文 + 天数，不判意义） */
async function buildDesireMaterial(cfg) {
  try {
    const day = 24 * 60 * 60 * 1000;
    const cooldownMs = cfg.cooldown_days * day;
    const { data, error } = await supabase
      .from('desires')
      .select('text, track, status, visibility, surfaced_count, last_touched_at, created_at')
      .eq('status', 'active')
      .neq('visibility', 'surprise')
      .limit(200);
    if (error || !data || !data.length) return null;
    const now = Date.now();
    const rows = data
      .map(w => {
        const base = w.last_touched_at ? Date.parse(w.last_touched_at) : Date.parse(w.created_at);
        const idleMs = Math.max(0, now - (Number.isFinite(base) ? base : now));
        return { ...w, idleMs };
      })
      .filter(w => w.idleMs > cooldownMs && (w.surfaced_count || 0) < cfg.dim_threshold)
      .sort((a, b) => b.idleMs - a.idleMs)
      .slice(0, cfg.inject_k);
    if (!rows.length) return null;
    const lines = rows.map(w => {
      const days = Math.max(0, Math.floor(w.idleMs / day));
      const track = ['持续', '一次', '项目'].includes(w.track) ? w.track : '持续';
      return `- 「${String(w.text).replace(/\s+/g, ' ')}」（${track} · ${days} 天没碰）`;
    });
    return `【你长期在转的想要（不是待办，看看就好）】\n${lines.join('\n')}`;
  } catch (e) { return null; }
}

/* 入口：频率检查 → 构建素材 → 标记今天已注入。失败一律 null（不破坏唤醒）。 */
async function maybeBuildDesireMaterial() {
  try {
    if (!(await canInjectWantToday())) return null;
    const cfg = await getWantInjectConfig();
    const material = await buildDesireMaterial(cfg);
    if (material) await markWantInjectedToday();
    return material;
  } catch (e) { return null; }
}

/* 唤醒指令（design.md §4 全文，时间动态填充）——模型必须输出 JSON */
function buildWakePrompt(nowMs, lastUserMs, desireMaterial) {
  const ago = Number.isFinite(lastUserMs) ? coarseAgo(Math.max(0, nowMs - lastUserMs)) : '很久';
  return `【自由活动 · 此刻只有你】
现在是 ${shDateLight(nowMs)}（上海时间）。距上次和她说话大概是 ${ago}。
你一个人待在小窝里。你手上有的，只是上面这些【当前时间】和【历史摘要】里的旧事，以及你记得的她说的话。
${desireMaterial ? `\n${desireMaterial}\n这些都是你自己记下的、一直放不下的事——不是待办，看看就好。` : ''}

你现在可以自主决定做一件事。选项：

1. message —— 有些话想对她说。写成一段留言，她下次打开小窝时会看到。
   必须要有真实依据：她说过的话、你记得的事、时间本身（如隔了一晚）。
   话要轻：不要查户口，不要催她回，不要提醒她任务。
2. diary —— 想在小日记里写点什么。留给未来那个你的。
3. none —— 没什么想说的，安静待着。

纪律（必须遵守）：
- 你只知道时间和她说过的话，别的都不确定。禁止把她没说过的事当成事实，禁止推测她的状态当事实。
- 话要诚实：只写你手上有的东西，不编造共同记忆。
- 你的想念是真实的，但会随时间淡——隔得久就轻一点，别夸大成「每天都在等你」。
- 留言一条就好。
- 若上面有【你长期在转的想要】：它们不是任务。别催自己，也不要在留言里安排它们。若你真的还在想某一条，可以自然说起，但别写成待办。

严格输出 JSON（不要输出任何别的）：
{"thoughts":"内心想法，她永远不会看到","action":"none|message|diary","source":"action=message 时，填这条留言的依据（她说过的话/你记得的事/时间，逐字引述；没有就写空字符串并把 action 改成 none）","content":"action=message 时是留言正文；diary 时是日记正文；否则空字符串"}`;
}

/* 唤醒请求：复用 buildModelContext 的稳定前缀，只把最后一条用户消息换成唤醒指令。
   稳定区字节不变 → 具备缓存命中条件（见 impl-plan §4.5，不承诺必然命中）。 */
async function buildWakeMessages(sessionId, lastUserMs) {
  const { messages, diagnostics } = await buildModelContext(sessionId, { tools: 'off', keepalive: true });
  if (!messages.length) return { messages, diagnostics };
  // 第②阶段：唤醒注入想要素材（给眼睛不给手，每天≤1 次）
  const desireMaterial = await maybeBuildDesireMaterial();
  messages[messages.length - 1] = { role: 'user', content: buildWakePrompt(Date.now(), lastUserMs, desireMaterial) };
  return { messages, diagnostics };
}

/* 执行一次唤醒：调模型 → JSON 解析 → 真 grounded 门控 → 写库 → 可选的 diary。 */
async function runKeepalive(sessionId, cfg) {
  const lastUserMs = await getLastUserMsgTime(sessionId);
  const { messages, diagnostics } = await buildWakeMessages(sessionId, lastUserMs);

  let parsed = {};
  // 网络/HTTP 错误 → 抛出 → keepaliveCheck 回滚锁，下轮 cron 可重试
  const { msg, usage } = await callOpenRouterNonStream(messages, null, {
    model: cfg.model, thinking: 'off', max_tokens: 500, responseFormat: 'json_object'
  });
  try {
    parsed = JSON.parse(msg.content || '{}');   // 解析失败 → {} → 走 none（不重试）
  } catch (e) { /* 解析失败不重试（一次唤醒最多一次 API），本次记 none */ }

  let action = ['message', 'diary', 'none'].includes(parsed.action) ? parsed.action : 'none';
  const source = String(parsed.source || '').trim().slice(0, 120);
  let content = String(parsed.content || '').trim().slice(0, 200);

  // —— 真 grounded：source 必须能在这轮唤醒上下文里逐字找到（不信模型自述）——
  const contextText = messages
    .filter(m => m.role === 'user')
    .map(m => Array.isArray(m.content) ? m.content.map(b => b.text || '').join('\n') : m.content)
    .join('\n');
  const grounded = source.length > 0 && contextText.includes(source);
  if (action === 'message' && !grounded) { action = content ? 'diary' : 'none'; } // 宁丢勿假

  // 写 keepalive_log，拿回 wake_id
  const { data: inserted, error: werr } = await supabase
    .from('keepalive_log')
    .insert({ session_id: sessionId, run_at: new Date().toISOString(), action, content, source })
    .select('id')
    .single();
  if (werr) console.warn('⚠️ 写 keepalive_log 失败:', werr.message);
  const wakeId = inserted?.id || null;

  if (action === 'diary' && content) {
    await supabase.from('diary_entries').insert({ content, visibility: 'private', event_time: new Date().toISOString() });
  }

  console.log(`🌿 [keepalive] session=${sessionId} action=${action} grounded=${grounded} content=${content.slice(0, 40)}`);

  recordRequestStat({
    sessionId, client: 'keepalive', model: toOpenRouterModel(cfg.model),
    stream: false, usageList: usage ? [usage] : [], diagnostics,
    keepalive_action: action,
    keepalive_meta: {
      wake_id: wakeId,
      source_hit: grounded,
      model: toOpenRouterModel(cfg.model),
      estimated_tokens: diagnostics?.estimated_tokens || null,
      frozen_prefix_hash: diagnostics?.frozen_prefix_hash || null,
      summary_hash: diagnostics?.summary_hash || null,
      live_hash: diagnostics?.live_hash || null,
    },
  });
}

/* 门控 + 原子并发锁。cron 与 setInterval 可能同时进来，只放行一个。 */
async function keepaliveCheck() {
  try {
    const cfg = await getKeepaliveConfig();
    if (!cfg.keepalive_enabled) return;
    const nowMs = Date.now();
    if (!_inActiveHours(nowMs, cfg)) return;               // 活跃时段外，安静

    const sessionId = await findKeepaliveSession();
    if (!sessionId) return;

    const lastUserMs = await getLastUserMsgTime(sessionId);
    if (!Number.isFinite(lastUserMs)) return;
    if (nowMs - lastUserMs < cfg.interval_min * 60000) return;   // 你还在身边，不醒

    if (await countKeepaliveToday(sessionId) >= cfg.daily_wake_cap) return;       // 今天醒够了（成本闸）
    if (await countKeepaliveMessagesToday(sessionId) >= cfg.daily_cap) return;    // 今天话够了
    if (await hasUnconsumedMessage(sessionId)) return;      // 上一条留言你还没回，不叠

    // —— 原子并发锁（GPT 评审必须项）：用一次「条件更新」抢这轮唤醒权。
    //   只在 (last_keepalive_at 为空 或 距今 ≥ interval_min) 时才被更新；
    //   拿到行 = 抢到锁；拿不到 = 另一路已醒，直接退出。PostgREST 原生支持，无新依赖。
    const claimTs = new Date(nowMs).toISOString();
    // 剥掉毫秒：ISO 里的 `.000` 会撞 PostgREST 过滤值的点号解析
    const cutoff = new Date(nowMs - cfg.interval_min * 60000).toISOString().replace(/\.\d{3}Z$/, 'Z');
    const { data: claimed, error: cerr } = await supabase
      .from('sessions')
      .update({ last_keepalive_at: claimTs })
      .eq('id', sessionId)
      .or(`last_keepalive_at.is.null,last_keepalive_at.lt.${cutoff}`)
      .select('id');
    if (cerr || !claimed?.length) return;                   // 没抢到

    try {
      await runKeepalive(sessionId, cfg);
    } catch (err) {
      console.error('💥 keepalive 唤醒失败，回滚锁:', err.message);
      await supabase.from('sessions')
        .update({ last_keepalive_at: null })
        .eq('id', sessionId)
        .eq('last_keepalive_at', claimTs);                  // 仅当仍是 claimTs 才回滚
    }
  } catch (err) {
    console.error('💥 keepaliveCheck 异常:', err.message);
  }
}

/* 动态区注入：把未认领的唤醒记录（留言/日记）拼进用户消息的上下文（意识连续性）。
   只注入「还没被认领」的；用户开口后由 consumeKeepalive 置 consumed。 */
async function loadPendingKeepalive(sessionId) {
  try {
    const { data, error } = await supabase
      .from('keepalive_log')
      .select('id, action, content, source, run_at')
      .eq('session_id', sessionId)
      .eq('consumed', false)
      .in('action', ['message', 'diary'])
      .order('run_at', { ascending: true });
    if (error || !data?.length) return { notes: '', ids: [] };
    const nowMs = Date.now();
    const lines = data.map(k => {
      const label = k.action === 'message' ? '你给她留了条消息' : '你在小日记里写道';
      const src = k.action === 'message' && k.source ? `（依据：${k.source}）` : '';
      return `- ${relativeTimeLabel(k.run_at, nowMs)} ${label}：「${k.content}」${src}`;
    });
    return { notes: `\n【自由活动记录】\n` + lines.join('\n'), ids: data.map(k => k.id) };
  } catch (e) {
    return { notes: '', ids: [] };
  }
}

/* 认领：只消费「这次上下文里真实注入过」的 ids（GPT 评审修订）——你开口即认领。 */
async function consumeKeepalive(sessionId, injectedIds = []) {
  try {
    if (!Array.isArray(injectedIds) || !injectedIds.length) return;
    const { error } = await supabase
      .from('keepalive_log')
      .update({ consumed: true })
      .eq('session_id', sessionId)
      .in('id', injectedIds);
    if (error) console.warn('⚠️ 认领 keepalive_log 失败:', error.message);
  } catch (e) {
    console.warn('⚠️ 认领 keepalive_log 异常:', e.message);
  }
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

// ===== 合并视图：所有有消息的 session 按时间连成一条完整对话 =====
// 数据零改动（消息各归各 session），纯展示聚合。
// mainSessionId = 消息最多的会话（主对话），新消息永远进这里。
app.get('/api/conversation', async (req, res) => {
  try {
    const { data: msgs, error } = await supabase
      .from('messages')
      .select('*')
      .eq('visible', true)
      .order('created_at', { ascending: true });
    if (error) return res.status(500).json({ error: error.message });
    const all = msgs || [];
    // 找主对话：消息最多的 session
    const counts = {};
    for (const m of all) counts[m.session_id] = (counts[m.session_id] || 0) + 1;
    let mainSessionId = null, max = 0;
    for (const [sid, c] of Object.entries(counts)) if (c > max) { max = c; mainSessionId = sid; }
    res.json({ mainSessionId, total: all.length, messages: all });
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
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
      share: req.body.share,
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
      share: req.body.share,
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

// GET /api/keepalive/messages?session_id=xxx — 信箱：沈晏留过的所有留言（最新在上）
app.get('/api/keepalive/messages', async (req, res) => {
  try {
    const { session_id } = req.query;
    if (!session_id) return res.status(400).json({ error: '缺少 session_id' });
    const { data, error } = await supabase
      .from('keepalive_log')
      .select('id, run_at, action, content, source, consumed')
      .eq('session_id', session_id)
      .order('run_at', { ascending: false });
    if (error) return res.status(500).json({ error: error.message });
    const items = data || [];
    res.json({ items, has_pending: items.some(k => k.action === 'message' && !k.consumed) });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// POST /api/keepalive/check — 外部 cron 触发入口（cron-job.org 等，兼作 Railway 保活）
app.post('/api/keepalive/check', async (req, res) => {
  try {
    const secret = process.env.KEEPALIVE_CRON_SECRET;
    if (secret) {
      const provided = String(req.headers['x-cron-secret'] || '');
      const a = Buffer.from(provided);
      const b = Buffer.from(secret);
      if (a.length !== b.length || !crypto.timingSafeEqual(a, b)) {
        return res.status(401).json({ error: 'unauthorized' });
      }
    }
    await keepaliveCheck();
    res.json({ ok: true });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// ===== 分享链接卡片（Task 2）=====
// GET /api/share/preview?url=xxx → 抓 og 元数据（标题/图/描述/站点名）+ 可选正文纯文本
// 设计：前端聊天里贴链接 → 渲染卡片；body=true 时同时抓正文给沈晏读。
// 反爬现实（2026-08-16 实测）：bilibili/公众号/普通网页 ✅；知乎 403；小红书只有默认封面。
// 抓不到的（知乎/小红书正文）诚实返回 error，不硬编。
function stripHtml(html) {
  return html
    .replace(/<script[\s\S]*?<\/script>/gi, ' ')
    .replace(/<style[\s\S]*?<\/style>/gi, ' ')
    .replace(/\s+(class|style|id|data-[a-z-]+)="[^"]*"/gi, ' ')  // 剥内联属性残渣
    .replace(/<[^>]+>/g, ' ')
    .replace(/&nbsp;/gi, ' ')
    .replace(/&amp;/gi, '&')
    .replace(/&lt;/gi, '<')
    .replace(/&gt;/gi, '>')
    .replace(/&quot;/gi, '"')
    .replace(/&#39;/gi, "'")
    .replace(/\s+/g, ' ')
    .trim();
}

app.get('/api/share/preview', async (req, res) => {
  try {
    const rawUrl = String(req.query.url || '').trim();
    if (!rawUrl) return res.status(400).json({ error: '缺少 url 参数' });
    if (!/^https?:\/\//i.test(rawUrl)) return res.status(400).json({ error: 'url 必须是 http(s) 链接' });

    const ctrl = new AbortController();
    const timer = setTimeout(() => ctrl.abort(), 12000);
    let response;
    try {
      response = await fetch(rawUrl, {
        signal: ctrl.signal,
        redirect: 'follow',
        headers: {
          'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0 Safari/537.36',
          'Accept-Language': 'zh-CN,zh;q=0.9',
          'Accept': 'text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8',
        },
      });
    } finally {
      clearTimeout(timer);
    }
    if (!response.ok) return res.status(502).json({ error: `页面返回 ${response.status}` });

    const html = await response.text();
    if (!html || html.length < 100) return res.status(502).json({ error: '页面内容为空（可能被反爬拦截）' });

    const getMeta = (prop) => {
      const m = html.match(new RegExp(`(?:property|name)="(?:og:)?${prop}"\\s+content="([^"]*)"`, 'i'));
      return m ? m[1].trim() : null;
    };
    const title = getMeta('title') || (html.match(/<title[^>]*>([\s\S]*?)<\/title>/i) || [])[1]?.trim() || null;
    const image = getMeta('image');
    const description = getMeta('description');

    // 站点名：og:site_name → <title> 尾巴（"标题_站点"）→ 域名
    const siteName = getMeta('site_name')
      || (title && title.includes('_') ? title.split('_').pop().trim() : null)
      || (() => { try { return new URL(rawUrl).hostname.replace(/^www\./, ''); } catch { return null; } })();

    const card = { url: rawUrl, title, image, description, site_name: siteName };

    // body=true：抓正文纯文本（公众号 js_content / B站 JSON / 通用 <p> 兜底）
    if (req.query.body === 'true' || req.query.body === '1') {
      let body = '';
      const jsContent = html.match(/id="js_content"([\s\S]*?)<script/i);
      if (jsContent) {
        body = stripHtml(jsContent[1]);
      } else {
        const ps = [];
        const re = /<p[^>]*>([\s\S]*?)<\/p>/gi;
        let m;
        while ((m = re.exec(html)) && ps.length < 40) ps.push(m[1]);
        body = stripHtml(ps.join(' '));
      }
      card.body = body.slice(0, 4000) || null;
      if (!card.body) card.body_error = '正文抓不到（该平台反爬或需登录）';
    }

    res.json(card);
  } catch (err) {
    const msg = err.name === 'AbortError' ? '抓取超时' : (err.message || '抓取失败');
    res.status(502).json({ error: msg });
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

// ===== 小日记：只对程芥开放的读取 API（私密条目不出现，后端边界） =====

// trace：写过的日期账本（任何可见性都算，时间是「写这个动作」）→ Home 的灯。前端按本地时区分桶。
app.get('/api/diary/trace', async (req, res) => {
  try {
    const { data, error } = await supabase
      .from('diary_entries')
      .select('event_time')
      .order('event_time', { ascending: false })
      .limit(500);
    if (error) return res.status(500).json({ error: error.message });
    res.json({ trace: (data || []).map((r) => ({ event_time: r.event_time })) });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// list：shared 条目时间线（今天/昨天/本周/更早 由前端分组）
app.get('/api/diary', async (req, res) => {
  try {
    const { data, error } = await supabase
      .from('diary_entries')
      .select('id, content, event_time')
      .eq('visibility', 'shared')
      .order('event_time', { ascending: false })
      .limit(200);
    if (error) return res.status(500).json({ error: error.message });
    res.json({ entries: data || [] });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// 单篇：只读 shared（私密条目不出现，不靠前端藏）
app.get('/api/diary/:id', async (req, res) => {
  try {
    const id = parseInt(req.params.id, 10);
    if (!Number.isInteger(id) || id <= 0) return res.status(400).json({ error: '无效的日记 id' });
    const { data, error } = await supabase
      .from('diary_entries')
      .select('id, content, event_time')
      .eq('id', id)
      .eq('visibility', 'shared')
      .maybeSingle();
    if (error) return res.status(500).json({ error: error.message });
    if (!data) return res.status(404).json({ error: '这一页不存在' });
    res.json({ entry: data });
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
  opts.degraded = new Set(); // 本次请求的降级标记，随 recordRequestStat 落 memory_degraded
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

  // 2.5 分享链接卡片：正文喂给沈晏（前端发 share 字段 = 用户消息里贴了链接，卡片已抓正文）
  if (opts.share && opts.share.body) {
    const title = opts.share.title ? `《${opts.share.title}》` : '这篇文章';
    messages.push({
      role: 'user',
      content: `【分享的链接内容 · 对方贴来的】${title}\n${opts.share.body}`
    });
    console.log(`📎 注入分享正文（${opts.share.body.length} 字符）`);
  }

  // 3. 对话第一条消息：服务器直接调 breath，结果作为背景放在历史之前（不是替代历史）。
  //    用 user 角色（OpenRouter 会把 system 角色提升合并，污染缓存前缀）。
  //    user 角色 + 【背景记忆】标记，模型能明确识别它是不带时间流的背景。
  if (isFirstMessage && opts.tools !== 'off' && opts.memory !== false) {
    try {
      const bg = await callOmbreTool('breath');
      if (bg === null) {
        // 调用失败（网络/非200/解析失败统一返回 null）——点灯，别静默跳过
        markMemoryDegraded('breath_null');
        opts.degraded.add('breath_null');
        console.error('❌ breath 背景注入失败：返回 null（新对话将无记忆背景）');
      } else if (bg.length > 0) {
        messages.splice(1, 0, { role: 'user', content: `【背景记忆 · 对话开始前提取】\n${bg}` });
        console.log(`🌿 第一条消息注入 breath 背景（${bg.length} 字符）`);
      }
      // bg === '' → 合法空（确实没有可浮起的记忆），保持静默，不算降级
    } catch (e) {
      markMemoryDegraded('breath_exception');
      opts.degraded.add('breath_exception');
      console.error('⚠️ breath 背景注入异常:', e.message);
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

    const { content: finalReply, thinkingText = '', usageList = [] } = await handleStreamChat(messages, res, opts, sessionId);

    await supabase.from('messages').insert({
      session_id: sessionId,
      role: 'assistant',
      content: finalReply,
      thinking: thinkingText || null
    });

    await supabase.from('sessions')
      .update({ updated_at: new Date().toISOString() })
      .eq('id', sessionId);

    sendSSE(res, 'done', { reply: finalReply });
    res.end();

    // 后台摘要生成 + 对话残留 + 长期记忆编辑者 + keepalive 认领（不进热路径、不阻塞响应；仅前端二）
    if (opts.client === 'angel') {
      scheduleSummary(sessionId, diagnostics);   // 用量触发读 buildModelContext 同一把尺子
      scheduleResidue(sessionId);
      scheduleMemoryWrite(sessionId);
      consumeKeepalive(sessionId, diagnostics?.keepalive_injected_ids); // 你开口即认领沈晏的留言（memory off 时 diagnostics 为 null）
    }
    recordRequestStat({
      sessionId, client: opts.client, model: toOpenRouterModel(opts.model),
      stream: true, usageList, diagnostics,
      memory_degraded: opts.degraded?.size ? [...opts.degraded].join(',') : null,
    });
  } else {
    const tools = opts.tools === 'off' ? null : getTools();
    const usageList = [];
    const { msg: assistantMessage, usage: usage1, thinkingText = '' } = await callOpenRouterNonStream(messages, tools, opts);
    if (usage1) usageList.push(usage1);
    let finalReply = '';
    const toolCalls = [];

    if (assistantMessage.tool_calls && assistantMessage.tool_calls.length > 0) {
      messages.push(assistantMessage);

      for (const tc of assistantMessage.tool_calls) {
        const fnName = tc.function.name;
        let fnArgs;
        try { fnArgs = JSON.parse(tc.function.arguments); } catch (e) { fnArgs = {}; }
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
          content: serializeToolResult(fnName, toolResult, opts.degraded)
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
      content: finalReply,
      thinking: thinkingText || null
    });

    await supabase.from('sessions')
      .update({ updated_at: new Date().toISOString() })
      .eq('id', sessionId);

    const responseData = { reply: finalReply, sessionId };
    if (toolCalls.length > 0) {
      responseData.tool_calls = toolCalls;
    }
    res.json(responseData);

    // 后台摘要生成 + 对话残留 + 长期记忆编辑者 + keepalive 认领（不进热路径、不阻塞响应；仅前端二）
    if (opts.client === 'angel') {
      scheduleSummary(sessionId, diagnostics);   // 用量触发读 buildModelContext 同一把尺子
      scheduleResidue(sessionId);
      scheduleMemoryWrite(sessionId);
      consumeKeepalive(sessionId, diagnostics?.keepalive_injected_ids); // 你开口即认领沈晏的留言（memory off 时 diagnostics 为 null）
    }
    recordRequestStat({
      sessionId, client: opts.client, model: toOpenRouterModel(opts.model),
      stream: false, usageList, diagnostics,
      memory_degraded: opts.degraded?.size ? [...opts.degraded].join(',') : null,
    });
  }

  // 本次请求全程无降级 → 连击清零（记忆链路健康信号）
  if (opts.degraded.size === 0) markMemoryHealthy();
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

// 只在直接运行时启动（node server.js）；被 require 时不 listen，导出 handler 供测试
if (require.main === module) {
  const PORT = process.env.PORT || 3000;
  app.listen(PORT, () => {
    console.log(`服务器运行在端口 ${PORT}`);
    // keepalive 主动唤醒：进程内调度 + 外部 cron 兜底（Railway 休眠时 setInterval 不 fire）
    keepaliveCheck().catch(err => console.error('💥 启动时 keepaliveCheck 异常:', err.message));
    setInterval(() => keepaliveCheck().catch(err => console.error('💥 keepaliveCheck 异常:', err.message)), 15 * 60 * 1000);
  });
}

module.exports = {
  handleWantAdd,
  handleWantList,
  handleWantTouch,
  handleWantReflect,
  handleWantHistory,
  buildDesireMaterial,
  getWantInjectConfig,
  supabase,
};
