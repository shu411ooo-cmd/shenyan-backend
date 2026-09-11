/* ============================================================
   Context / 会话 IO 管子（分区第 3 步 · 2026-09-10）

   逐字搬运自 server.js 行 1998-2150 与 2360-2390，注释一并带走，**零逻辑改动**。
   块内两件事 + 随行的模块态：
     读：getContextConfig / getSessionState / loadSummarySegments / loadOtherSessionFlow /
         fetchSessionHistory（分页）/ loadLiveAnchor
     写：insertSummarySegment / saveLiveAnchor
     纯：buildCrossSessionNarrative（跨 session 流水成文）/ pairTurns（升序消息配轮）
     模块态：liveAnchors（进程内 Map，缓存锚点的 fast path）

   这一片不组装任何东西，它是一根管子 —— 价值全在**失败时退化成什么**。所以它的行为基线
   （test/fixtures/context-session.baseline.json，43 组）每组比四样：
     value   返回值（读到的行 / true/false / {} / []）
     io      假 supabase 记录的查询序列 —— 尤其 fetchSessionHistory 的分页 range、
             loadOtherSessionFlow 的 neq/eq/order/limit 顺序。IO 密集的代码，
             「返回值没变」证明不了什么，「调用序列没变」是另一条独立证据。
     logs    console.warn 的每一句（读失败必须留痕 —— 静默降级是 09-03 那次事故的成因）
     warns   warnConfigFallback 被调用的组名与理由（降级要出声，且要出对的那一声）
   写库的向量（insertSummarySegment / saveLiveAnchor）额外把表读回来一次，确认真的落进去了。

   ⚠️ 函数体保持**列 0 不缩进**（不是忘了缩进）：这样评审时可以直接和
      `git show f7e49da:server.js | sed -n '1998,2150p'` 逐行对照，没有空白噪声。

   工厂参数 = free-vars.cjs 算出的 server.js 侧依赖面（2 个，一个不多一个不少）：
     supabase / warnConfigFallback
   ⚠️ 不许 require('../server') —— CommonJS 循环依赖会静默给 undefined。

   ⚠️ warnConfigFallback **不在这一片里**，虽然它就挨着 getContextConfig（server.js:1993）。
      它是六个配置组的共同出口（mirror / context / satisfy / memory_gate / keepalive /
      want_inject），按依赖面属于全文件 —— 留在 server.js，跟 warnOnce 一样注入进来。
   ⚠️ liveAnchors 从 server.js 的模块态变成这里的闭包态。它是「进程内 fast path」，
      canonical 一直是 sessions.live_anchor_turn（DB），所以换宿主不影响跨重启/多实例语义。
   ============================================================ */

module.exports = function createSession({ supabase, warnConfigFallback }) {

// —— 配置：settings 表（SQL 未跑时回落默认值，防御式） ——
// 只有 global 行（永无岛会话级配置已随永无岛删除 2026-08-29，sessionId 参数仅保留给调用方，已不用）
// 2026-08-29 失忆修复：max_context_tokens 8000→24000。根因=基础开销（人格 prompt+tools+首句注入）
// 本身就有 ~8.5k，8k 预算连基础都不够，长会话(497·630轮)只能把 live 裁到只剩当前 1 轮，
// 上一轮完整对话被裁 → 沈晏每轮看不到自己上一句（程芥亲历「他不记得自己最新的一句话」）。
// 2026-08-31 阈值一致性修正：live_max_tokens 20000→40000。根因=15 轮 live 实测≈18.3k，
// 20k 阈值让塌缩在 live 刚攒到 15 轮就触发（每 1~2 轮塌一次）→ 锚定攒的批永远攒不起来 → 命中率
// 退回滚动 55%。设计稿 §3② 明确轮数阈值(30 轮)才是周期、token 阈值是安全线；40k 让轮数先触发，
// 安全线仍在（防单条巨物撑爆）。若塌缩后预算裁剪开始裁 live（trimmed_turns 上升）再调 max_context_tokens。
async function getContextConfig(sessionId) {
  const defaults = { frozen_rounds: 10, live_rounds: 15, max_context_tokens: 24000, live_max_tokens: 40000 };
  const pick = (row) => row ? ({
    frozen_rounds: Number.isInteger(row.frozen_rounds) ? row.frozen_rounds : defaults.frozen_rounds,
    live_rounds: Number.isInteger(row.live_rounds) ? row.live_rounds : defaults.live_rounds,
    max_context_tokens: Number.isInteger(row.max_context_tokens) ? row.max_context_tokens : defaults.max_context_tokens,
    live_max_tokens: Number.isInteger(row.live_max_tokens) ? row.live_max_tokens : defaults.live_max_tokens,
  }) : defaults;
  try {
    const { data, error } = await supabase
      .from('settings')
      .select('frozen_rounds, live_rounds, max_context_tokens, live_max_tokens')
      .eq('session_id', 'global')
      .maybeSingle();
    if (error) { warnConfigFallback('context', error); return defaults; }
    return pick(data);
  } catch (e) {
    warnConfigFallback('context', e);
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

// 分页拉取某 session 的完整可见消息（升序）。
// ⚠️ Supabase/PostgREST 单次查询硬上限 1000 行（db-max-rows），
//    `.limit(9999)` 也被掐到 1000。长会话不分页会静默截掉最新消息（聊天 400 的根因）。
async function fetchSessionHistory(sessionId) {
  const { count } = await supabase
    .from('messages')
    .select('*', { count: 'exact', head: true })
    .eq('session_id', sessionId)
    .eq('visible', true);
  const rows = [];
  const PAGE = 1000;
  for (let from = 0; from < (count || 0); from += PAGE) {
    const { data: page } = await supabase
      .from('messages')
      .select('role, content, created_at')
      .eq('session_id', sessionId)
      .eq('visible', true)
      .order('created_at', { ascending: true })
      .range(from, from + PAGE - 1);
    if (!page || page.length === 0) break;
    rows.push(...page);
  }
  return rows;
}

// —— 2026-08-30 缓存锚定：live 段从「每轮滚动」改「锚定攒批 + 双阈值塌缩」——
// 滚动滑窗每轮头部掉一轮+尾部加一轮 → 前缀在 live 头部必断 → 动态尾巴(middle+live≈45%)全价支付。
// 锚定：liveStart 钉在「上次塌缩点」，live 只追加；塌缩前两触发=轮数超 live_rounds×2
// 或 live 估算 token 超 live_max_tokens（安全线不是目标值：在预算主动裁剪 live 前先塌，
// 否则 middle 裁光后 live 每轮被裁 → 重新制造 cache miss，退化回滚动）。塌缩轮断前缀是低频，其余轮前缀连续。
// 锚点 canonical = sessions.live_anchor_turn（DB，跨重启/多实例一致）；进程内 Map 只是 fast path，
// 重启后从 DB 恢复，不再人为制造 cache miss。DB 列单独读写（不复用 getSessionState）：
// 缺列/失败仅锚定退化为进程内/滚动，不连坐 state（resumeGap/residue 不静默失效）。
const liveAnchors = new Map(); // sessionId -> live 段第一轮 turn（1-based，进程内 fast path）

async function loadLiveAnchor(sessionId) {
  if (liveAnchors.has(sessionId)) return liveAnchors.get(sessionId);
  try {
    const { data, error } = await supabase
      .from('sessions').select('live_anchor_turn').eq('id', sessionId).maybeSingle();
    if (!error && data && Number.isInteger(data.live_anchor_turn)) {
      liveAnchors.set(sessionId, data.live_anchor_turn);
      return data.live_anchor_turn;
    }
  } catch (e) { /* DB 列未建/不可用 → 锚定退化为进程内 */ }
  return null;
}

async function saveLiveAnchor(sessionId, turn) {
  liveAnchors.set(sessionId, turn);
  try {
    await supabase.from('sessions').update({ live_anchor_turn: turn }).eq('id', sessionId);
  } catch (e) {
    console.warn('⚠️ saveLiveAnchor DB 失败（锚定仅在进程内）:', e.message);
  }
}

  return {
    getContextConfig, getSessionState, loadSummarySegments, loadOtherSessionFlow,
    buildCrossSessionNarrative, insertSummarySegment, pairTurns, fetchSessionHistory,
    loadLiveAnchor, saveLiveAnchor,
  };
};
