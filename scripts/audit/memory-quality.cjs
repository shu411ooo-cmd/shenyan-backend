#!/usr/bin/env node
/* ============================================================
   记忆系统质量报告（只读 · 纯机械统计 · 不调任何 LLM）

   用法：node scripts/audit/memory-quality.cjs [--json out.json]

   为什么有这个脚本（2026-09-12）：
   此前整套记忆层全是开环定值 —— 温度、座位数、压制因子、节流间隔全是手调常数，
   唯一的可见性是 recallDaily 的每日一行 console.log（进程一死就丢）。
   这个脚本从持久层把「跑得怎么样」还原出来：
     prompt_injections 注入台账（150 天窗口，prov.refs 带 topicId）
     memory_topics / memory_relations / personality_claim / stone_rings / change_ledger
     settings(global 行) / sessions / call_turns
   全程只读；任何一张表读不到就跳过那一节，绝不中断（审计脚本自己不能成为故障源）。

   口径说明：报告里的 🟡/🔴 是启发式提示，不是定论 —— 阈值写在对应小节注释里，可调。
   ============================================================ */

const path = require('path');
require('dotenv').config({ path: path.join(__dirname, '..', '..', '.env') });
const { createClient } = require('@supabase/supabase-js');

const DAY = 86400000;

/* ---------- 纯计算（可测试，不碰 IO） ---------- */

// A. 写入侧：桶的总量、分布、速度、打分通胀、重复桶嫌疑
function analyzeTopics(topics, now) {
  const t = now || Date.now();
  const r = {
    total: topics.length,
    grounding: {}, source: {},
    created7: 0, created30: 0, updated7: 0, updated30: 0,
    importance: { n: 0, mean: null, p50: null, p90: null, ge08: 0 },
    withEventTime: 0,
    dupPairs: [], // 名字互相包含的桶对（findExistingMemoryTopic 同款规则的逆用：说明建桶时没被合并住）
  };
  const imp = [];
  for (const x of topics) {
    r.grounding[x.grounding || '（空）'] = (r.grounding[x.grounding || '（空）'] || 0) + 1;
    r.source[x.source || '（空）'] = (r.source[x.source || '（空）'] || 0) + 1;
    const cAt = Date.parse(x.created_at || '') || null;
    const uAt = Date.parse(x.updated_at || '') || null;
    if (cAt) { if (t - cAt < 7 * DAY) r.created7++; if (t - cAt < 30 * DAY) r.created30++; }
    if (uAt) { if (t - uAt < 7 * DAY) r.updated7++; if (t - uAt < 30 * DAY) r.updated30++; }
    if (typeof x.importance === 'number') { imp.push(x.importance); if (x.importance >= 0.8) r.importance.ge08++; }
    if (x.event_time) r.withEventTime++;
  }
  imp.sort((a, b) => a - b);
  if (imp.length) {
    r.importance.n = imp.length;
    r.importance.mean = +(imp.reduce((s, v) => s + v, 0) / imp.length).toFixed(3);
    r.importance.p50 = imp[Math.floor(imp.length * 0.5)];
    r.importance.p90 = imp[Math.floor(imp.length * 0.9)];
  }
  // 重复桶嫌疑：a 名字包含 b（长度≥2 才有意义，与写入侧合并规则同尺度）
  for (let i = 0; i < topics.length; i++) for (let j = i + 1; j < topics.length; j++) {
    const a = topics[i].topic || '', b = topics[j].topic || '';
    if (a.length >= 2 && b.length >= 2 && a !== b && (a.includes(b) || b.includes(a))) r.dupPairs.push([a, b]);
  }
  return r;
}

// B. 召回侧：台账还原注入量、按 refs 还原「哪些记忆真的被想起过」
// rows: prompt_injections { layer, tag, prov, expression_eligible, created_at }
function analyzeInjections(rows, topics, now) {
  const t = now || Date.now();
  const r = {
    window: rows.length, oldest: null, newest: null,
    last7: 0, byLayer30: {},
    eligibleTrue: 0, // 铁律说系统材料默认 false；>0 需要确认是白名单
    refsWithTopicId: 0, refsMissing: 0, // attention 块带不带 topicId，决定「死记忆」口径可不可靠
    topicHits30: {}, // topicId → 近 30 天被注入次数
  };
  for (const x of rows) {
    const cAt = Date.parse(x.created_at || '') || null;
    if (cAt) {
      if (!r.oldest || cAt < r.oldest) r.oldest = cAt;
      if (!r.newest || cAt > r.newest) r.newest = cAt;
      if (t - cAt < 7 * DAY) r.last7++;
    }
    if (x.expression_eligible === true) r.eligibleTrue++;
    const inWindow = cAt && t - cAt < 30 * DAY;
    if (!inWindow) continue;
    const layer = x.layer || '（空）';
    r.byLayer30[layer] = (r.byLayer30[layer] || 0) + 1;
    const refs = x.prov && Array.isArray(x.prov.refs) ? x.prov.refs : [];
    if (layer === 'attention' || refs.length) {
      if (!refs.length) r.refsMissing++;
      for (const ref of refs) {
        const id = ref && (ref.topicId ?? ref.id);
        if (id == null) { r.refsMissing++; continue; }
        r.refsWithTopicId++;
        const k = String(id);
        r.topicHits30[k] = (r.topicHits30[k] || 0) + 1;
      }
    }
  }
  // 死记忆 / 头部集中（用 memory_topics.id 对齐；topicId 对不上的记 unknown）
  const idOf = new Map(topics.map((x) => [String(x.id), x]));
  const hitIds = Object.keys(r.topicHits30);
  r.unknownTopicIds = hitIds.filter((id) => !idOf.has(id)).length;
  const knownHits = hitIds.filter((id) => idOf.has(id));
  r.aliveTopics30 = knownHits.length;
  r.deadTopics30 = topics.length - knownHits.length; // 近 30 天从未被注入的桶
  r.deadRatio30 = topics.length ? +(r.deadTopics30 / topics.length).toFixed(3) : null;
  const sorted = knownHits.map((id) => [id, r.topicHits30[id]]).sort((a, b) => b[1] - a[1]);
  const totalHits = sorted.reduce((s, [, n]) => s + n, 0);
  const top5 = sorted.slice(0, 5);
  r.top5Share30 = totalHits ? +(top5.reduce((s, [, n]) => s + n, 0) / totalHits).toFixed(3) : null;
  r.top5Topics30 = top5.map(([id, n]) => ({ topic: idOf.get(id)?.topic || `#${id}`, hits: n }));
  return r;
}

// C. 关系侧：边量、类型分布、孤儿边（旧脚本遗产校验）、有边主题占比
function analyzeRelations(edges, topicNames) {
  const r = { total: edges.length, byType: {}, orphans: [], edgeSet: new Set(), topicsWithEdge: 0 };
  const names = new Set(topicNames);
  const touched = new Set();
  for (const e of edges) {
    r.byType[e.rel_type || '（空）'] = (r.byType[e.rel_type || '（空）'] || 0) + 1;
    for (const n of [e.source_topic, e.target_topic]) {
      if (n && !names.has(n)) r.orphans.push(`${e.source_topic} ─${e.rel_type}→ ${e.target_topic}`);
      if (n) touched.add(n);
    }
  }
  r.topicsWithEdge = [...touched].filter((n) => names.has(n)).length;
  return r;
}

// D. claim 侧：状态分布 + forming 卡死（超过 dormantDays 没动静）
function analyzeClaims(claims, dormantDays, now) {
  const t = now || Date.now();
  const r = { total: claims.length, byState: {}, stuckForming: [], columnsSeen: claims[0] ? Object.keys(claims[0]) : [] };
  const pick = (c, keys) => { for (const k of keys) if (c[k] != null) return c[k]; return null; };
  for (const c of claims) {
    const state = String(pick(c, ['state', 'status']) || '（无状态列）');
    r.byState[state] = (r.byState[state] || 0) + 1;
    const uAt = Date.parse(pick(c, ['updated_at', 'last_seen_at', 'created_at']) || '') || null;
    if (/forming/i.test(state) && uAt && dormantDays && t - uAt > dormantDays * DAY) {
      r.stuckForming.push(pick(c, ['claim', 'text', 'content']) || '(?)');
    }
  }
  return r;
}

// E. 参数定值看板：settings(global) 所有非密钥键 + 代码硬编码旋钮清单
const HARDCODED_KNOBS = [
  ['LLM 采样温度（全链路）', '0.7', 'lib/llm.js'],
  ['判官温度 / max_tokens', '0 / 100', 'lib/memory/index.js'],
  ['判官机械前置阈值', '<12 字直接放行', 'lib/memory/index.js'],
  ['关系边自动连：节流 / 上限', '30min / 一轮 ≤12 条', 'lib/memory/link-relations.js'],
  ['注入同轮上限（动态块）', '3 块（保留席另计）', 'lib/context/build.js'],
  ['attention 冷却轮数', '见 ATTENTION_COOLDOWN_TURNS', 'lib/context/retrieval.js'],
  ['attention 单条截断', '220 字', 'lib/context/retrieval.js'],
  ['注入台账保留', '150 天，每 200 次写入偶发清理', 'server.js maybePruneInjections'],
  ['记忆写回窗口哈希去重', '>5000 丢最旧一半', 'lib/memory/index.js'],
];
const SECRET_LIKE = /cookie|token|key|secret|password|prompt|userid/i; // system_prompt 是人格文本，userid 半敏感，都不进报告
function analyzeSettings(row) {
  const out = {};
  if (!row) return out;
  for (const [k, v] of Object.entries(row)) {
    if (SECRET_LIKE.test(k) || ['id', 'session_id', 'created_at', 'updated_at'].includes(k)) continue;
    if (typeof v === 'string' && v.length > 60) { out[k] = `（长文本 ${v.length} 字，略）`; continue; } // 长文本截断：报告不是取值工具
    out[k] = v;
  }
  return out;
}

/* ---------- 输出 ---------- */

function fmtDist(obj) {
  return Object.entries(obj).sort((a, b) => b[1] - a[1]).map(([k, n]) => `${k}×${n}`).join(' ') || '（无）';
}
function iso(ms) { return ms ? new Date(ms).toISOString().slice(0, 10) : '—'; }

function buildReport({ topics, injections, relations, claims, settings, sessions7, sessions30, turns30, claimsDormantDays }, now) {
  const findings = [];
  const L = [];
  const A = analyzeTopics(topics, now);
  const B = analyzeInjections(injections, topics, now);
  const C = analyzeRelations(relations, topics.map((x) => x.topic).filter(Boolean));
  const D = analyzeClaims(claims, claimsDormantDays, now);

  L.push('══ A. 写入侧（memory_topics）══');
  L.push(`桶总数 ${A.total}｜grounding：${fmtDist(A.grounding)}｜source：${fmtDist(A.source)}`);
  L.push(`建桶速度：近7天 +${A.created7}，近30天 +${A.created30}；活跃更新：近7天 ${A.updated7}，近30天 ${A.updated30}`);
  L.push(`importance：均值 ${A.importance.mean ?? '—'}｜p50 ${A.importance.p50 ?? '—'}｜p90 ${A.importance.p90 ?? '—'}｜≥0.8 占比 ${A.importance.n ? Math.round(A.importance.ge08 / A.importance.n * 100) + '%' : '—'}（打分通胀探针）`);
  L.push(`事件时间覆盖：${A.withEventTime}/${A.total}`);
  if (A.dupPairs.length) {
    L.push(`🟡 重复桶嫌疑 ${A.dupPairs.length} 对（名字互相包含、建桶时没被合并住）：`);
    for (const [a, b] of A.dupPairs.slice(0, 10)) L.push(`    「${a}」 ∩ 「${b}」`);
    findings.push(`🟡 重复桶嫌疑 ${A.dupPairs.length} 对`);
  }

  L.push('══ B. 召回侧（prompt_injections 台账，窗口 ' + iso(B.oldest) + ' ~ ' + iso(B.newest) + '，共 ' + B.window + ' 行）══');
  L.push(`近 7 天注入 ${B.last7} 行；近 30 天分层：${fmtDist(B.byLayer30)}`);
  L.push(`refs 带 topicId ${B.refsWithTopicId} 条 / 缺 ${B.refsMissing} 条（缺的多说明「死记忆」口径不可靠）`);
  L.push(`近 30 天被想起过的桶 ${B.aliveTopics30}/${topics.length}，死记忆 ${B.deadTopics30}（${B.deadRatio30 == null ? '—' : Math.round(B.deadRatio30 * 100) + '%'}）`);
  L.push(`头部集中：top5 桶占全部命中 ${B.top5Share30 == null ? '—' : Math.round(B.top5Share30 * 100) + '%'}｜${B.top5Topics30.map((x) => `${x.topic}×${x.hits}`).join(' ') || '—'}`);
  if (B.unknownTopicIds) L.push(`（另：${B.unknownTopicIds} 个 topicId 对不上现存的桶 —— 桶被删过或 prov 记录口径漂移）`);
  if (B.window === 0 && sessions30 > 0) findings.push('🔴 台账整窗 0 行但近 30 天有对话 —— 表达资格隔离疑似空转（2026-08-30~09-09 空转十天事故的同形态）');
  else if (B.last7 === 0 && sessions7 > 0) findings.push('🔴 近 7 天有对话但台账 0 行 —— 表达资格隔离可能又在空转（与启动健康检查同源）');
  if (B.eligibleTrue > 0) findings.push(`🟡 台账里 ${B.eligibleTrue} 行 expression_eligible=true —— 铁律默认 false，请确认是白名单`);
  L.push(`背景：近 7 天会话 ${sessions7} 场 / 近 30 天 ${sessions30} 场 / 近 30 天对话 ${turns30} 轮`);

  L.push('══ C. 关系侧（memory_relations）══');
  L.push(`边 ${C.total} 条｜类型：${fmtDist(C.byType)}｜有边主题 ${C.topicsWithEdge}/${topics.length}`);
  if (C.orphans.length) {
    L.push(`🟡 孤儿边 ${C.orphans.length} 条（端点主题已不存在，联想永远打不着）：`);
    for (const s of C.orphans.slice(0, 10)) L.push(`    ${s}`);
    findings.push(`🟡 孤儿边 ${C.orphans.length} 条（旧脚本不验主题名的遗产，新校验已堵源头）`);
  }

  L.push('══ D. claim 侧（personality_claim）══');
  L.push(`claims ${D.total} 条｜状态：${fmtDist(D.byState)}`);
  if (!D.columnsSeen.includes('state') && !D.columnsSeen.includes('status')) L.push('（⚠️ 没找到 state/status 列，状态分布口径请对照建表迁移确认）');
  if (D.stuckForming.length) {
    L.push(`🟡 forming 卡死 ${D.stuckForming.length} 条（>${claimsDormantDays} 天没动静）：${D.stuckForming.slice(0, 5).join('；')}`);
    findings.push(`🟡 forming claim 卡死 ${D.stuckForming.length} 条`);
  }

  L.push('══ E. 参数定值看板 ══');
  const S = analyzeSettings(settings);
  L.push('settings(global)：' + (Object.keys(S).length ? Object.entries(S).map(([k, v]) => `${k}=${v}`).join('  ') : '（读不到）'));
  L.push('代码硬编码旋钮（开环，改它们要发版）：');
  for (const [name, val, where] of HARDCODED_KNOBS) L.push(`    ${name}：${val}（${where}）`);

  L.push('══ 提示（启发式，非定论）══');
  L.push(findings.length ? findings.join('\n') : '（无）');
  return { lines: L, findings, raw: { A, B, C, D, settings: S } };
}

/* ---------- 主流程（只读；任何一节失败就跳过，不拖垮整份报告） ---------- */

async function main() {
  const jsonOut = (() => { const i = process.argv.indexOf('--json'); return i > -1 ? process.argv[i + 1] : null; })();
  const sb = createClient(process.env.SUPABASE_URL, process.env.SUPABASE_KEY, { auth: { persistSession: false } });
  const now = Date.now();
  const grab = async (label, fn, fallback) => {
    try { const v = await fn(); return v == null ? fallback : v; }
    catch (e) { console.warn(`⚠️ [${label}] 读不到，跳过这一节: ${e.message}`); return fallback; }
  };

  const topics = await grab('memory_topics', async () => (await sb.from('memory_topics').select('*')).data, []);
  const injections = await grab('prompt_injections', async () =>
    (await sb.from('prompt_injections')
      .select('layer, tag, prov, expression_eligible, created_at')
      .order('created_at', { ascending: false }).limit(20000)).data, []);
  const relations = await grab('memory_relations', async () => (await sb.from('memory_relations').select('*')).data, []);
  const claims = await grab('personality_claim', async () => (await sb.from('personality_claim').select('*').limit(500)).data, []);
  const settings = await grab('settings', async () =>
    (await sb.from('settings').select('*').eq('session_id', 'global').maybeSingle()).data, null);
  const countSince = async (table, days) => {
    const since = new Date(now - days * DAY).toISOString();
    const r = await sb.from(table).select('*', { count: 'exact', head: true }).gte('created_at', since);
    return r.count || 0;
  };
  const sessions7 = await grab('sessions', () => countSince('sessions', 7), 0);
  const sessions30 = await grab('sessions', () => countSince('sessions', 30), 0);
  const turns30 = await grab('call_turns', () => countSince('call_turns', 30), 0);

  const report = buildReport(
    { topics, injections, relations, claims, settings, sessions7, sessions30, turns30, claimsDormantDays: settings && settings.claim_dormant_days },
    now,
  );
  const text = report.lines.join('\n');
  console.log(`\n记忆系统质量报告（${new Date(now).toISOString()}，只读 · 纯机械统计）\n\n${text}\n`);
  if (jsonOut) {
    require('fs').writeFileSync(jsonOut, JSON.stringify({ generated_at: new Date(now).toISOString(), ...report.raw, findings: report.findings }, null, 2));
    console.log(`→ JSON 已存 ${jsonOut}`);
  }
}

if (require.main === module) {
  main().catch((e) => { console.error('💥 质量报告异常:', e.message); process.exit(1); });
}

module.exports = { analyzeTopics, analyzeInjections, analyzeRelations, analyzeClaims, analyzeSettings, buildReport, HARDCODED_KNOBS };
