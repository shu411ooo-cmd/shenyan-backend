/* 分区第 3 步 · lib/context/session.js 的行为基线 spec
   同一份 spec 跑两个来源，输出必须逐字节一致：
     node scripts/audit/baseline-dump.cjs --spec scripts/audit/specs/context-session.cjs --rev f7e49da --out test/fixtures/context-session.baseline.json
     node scripts/audit/baseline-dump.cjs --spec scripts/audit/specs/context-session.cjs --module lib/context/session.js --compare test/fixtures/context-session.baseline.json

   这一片是「IO 管子」：它自己不组装任何东西，价值全在**失败时退化成什么**。
   所以每组向量比三样：
     value   返回值（读到的行 / true/false / {} / []）
     io      假 supabase 记录的查询序列 —— 尤其 fetchSessionHistory 的分页 range 和
             loadOtherSessionFlow 的 neq/eq/order/limit 顺序，改了就是改了
     logs    console.warn 的输出（每一条读失败都要留痕，静默降级正是 09-03 那次教训）
   写库的向量（insertSummarySegment）额外读一次表，确认真的落进去了。

   ⚠️ warnConfigFallback **不跟这一片走**。它看着和 getContextConfig 挨着（1993 行），但它是六个
      配置组的共同出口：mirror(831) / context(2012,2015) / satisfy(3272) / memory_gate(3877) /
      keepalive(4858) / want_inject(4990)。按「谁的依赖面就是谁的」它属于全文件，留在 server.js，
      跟 warnOnce 一样**注入**进来。检索层那片（context-retrieval.cjs:30）就是这么处理的。
      所以这里给的是**回声桩**：只记「被谁、以什么理由调了」，断言的是这一片**传出去**的东西。
   ⚠️ rev 模式的行区间是相对 baseRev 写的，`--rev` 必须给那个版本。
   ⚠️ liveAnchors 是 Map（进程内 fast path），跨向量会残留 —— 所以每条向量用不同的 session id。 */

const ROOT = require('path').resolve(__dirname, '..', '..', '..');
const { makeFakeSb, FROZEN, FrozenDate, fmtIo } = require('../testkit.cjs');

const sb = makeFakeSb();
const S = { warns: [] };

const DEPS = {
  supabase: sb,
  warnConfigFallback: (group, err) =>
    S.warns.push(`${group}:${err && err.message ? err.message : (err ? String(err) : 'no-row')}`),
  // rev 模式下这条盖掉 harness 沙箱里的真 Date（deps 是最后展开的）
  Date: FrozenDate,
};

/* ───────────────── 跑一组调用 ───────────────── */
let LOGS = [];
let dbSnap = null;
async function runCase(setup, fn) {
  sb.__clear();
  sb.__throw(null);
  S.warns.length = 0;
  LOGS = [];
  dbSnap = null;
  const rl = console.log, rw = console.warn, re = console.error, rd = global.Date;
  console.log = (...a) => LOGS.push('log ' + a.join(' '));
  console.warn = (...a) => LOGS.push('warn ' + a.join(' '));
  console.error = (...a) => LOGS.push('err ' + a.join(' '));
  global.Date = FrozenDate;
  let value;
  try {
    if (setup) setup();
    value = await fn();
    if (dbSnap) dbSnap = (sb.__data[dbSnap] && sb.__data[dbSnap].rows) || [];
  } finally { console.log = rl; console.warn = rw; console.error = re; global.Date = rd; }
  return { value, io: fmtIo(sb.__log), db: dbSnap, logs: LOGS.slice(), warns: S.warns.slice() };
}

const calls = [];
const C = (name, setup, fn) => calls.push({ name, run: (A) => runCase(setup, () => fn(A)) });

/** 造 n 条消息行，user/assistant 交替 */
const msgs = (n, sid = 'S') => Array.from({ length: n }, (_, i) => ({
  role: i % 2 === 0 ? 'user' : 'assistant',
  content: `m${i}`,
  created_at: new Date(FROZEN - (n - i) * 60000).toISOString(),
  session_id: sid,
  visible: true,
}));

/* ═══════════ ① getContextConfig（含「降级要出声」那一路） ═══════════
   09-03 的教训：8 组配置里 4 组静默失效，因为「没生效」和「本来就是默认」长得一样。
   所以每组读失败都必须是「退回默认值」**且**「喊一声」—— 两条一起断言，缺一条就是静默降级。 */
C('ctx_ok', () => {
  sb.__data.settings = { rows: [{ session_id: 'global', frozen_rounds: 8, live_rounds: 12, max_context_tokens: 20000, live_max_tokens: 30000 }] };
}, (A) => A.getContextConfig('S1'));
// Number.isInteger(0) 为真 —— 0 是**合法**配置值，不是缺省（改了守卫就会把 0 当坏值退回默认）
C('ctx_zeroAccepted', () => {
  sb.__data.settings = { rows: [{ session_id: 'global', frozen_rounds: 0, live_rounds: 0, max_context_tokens: 0, live_max_tokens: 0 }] };
}, (A) => A.getContextConfig('S2'));
C('ctx_badTypes', () => {
  sb.__data.settings = { rows: [{ session_id: 'global', frozen_rounds: 1.5, live_rounds: '20', max_context_tokens: null, live_max_tokens: -1 }] };
}, (A) => A.getContextConfig('S3'));
// PostgREST 只要有一个列不存在就整条查询报错 → 整组退回默认（09-09 线上实锤的静默失效）
C('ctx_error', () => { sb.__data.settings = { error: 'column live_max_tokens does not exist' }; }, (A) => A.getContextConfig('S4'));
C('ctx_noRow', () => { sb.__data.settings = { rows: [] }; }, (A) => A.getContextConfig('S5'));
// 抛异常（不是 error 字段）走另一个 catch 分支
C('ctx_throw', () => { sb.__throw('socket hang up'); }, (A) => A.getContextConfig('S6'));

/* ═══════════ ② getSessionState ═══════════ */
C('state_ok', () => {
  sb.__data.sessions = { rows: [{ id: 'S7', frozen_until_turn: 3, last_time_notice_at: '2026-09-09T00:00:00.000Z' }] };
}, (A) => A.getSessionState('S7'));
C('state_noRow', () => { sb.__data.sessions = { rows: [] }; }, (A) => A.getSessionState('S8'));
C('state_error', () => { sb.__data.sessions = { error: 'permission denied' }; }, (A) => A.getSessionState('S9'));
C('state_throw', () => { sb.__throw('connection reset'); }, (A) => A.getSessionState('S10'));

/* ═══════════ ③ loadSummarySegments ═══════════ */
C('seg_ok', () => {
  // 故意乱序塞进去：.order('period_start') 必须真的把它们排回来
  sb.__data.summary_segments = { rows: [
    { session_id: 'S11', period_start: 5, period_end: 10, period_start_ts: null, period_end_ts: null, content: '第二段' },
    { session_id: 'S11', period_start: 1, period_end: 4, period_start_ts: '2026-09-01T00:00:00Z', period_end_ts: '2026-09-02T00:00:00Z', content: '第一段' },
  ] };
}, (A) => A.loadSummarySegments('S11'));
C('seg_empty', () => { sb.__data.summary_segments = { rows: [] }; }, (A) => A.loadSummarySegments('S12'));
C('seg_error', () => { sb.__data.summary_segments = { error: 'relation does not exist' }; }, (A) => A.loadSummarySegments('S13'));
C('seg_throw', () => { sb.__throw('timeout'); }, (A) => A.loadSummarySegments('S14'));

/* ═══════════ ④ loadOtherSessionFlow：过滤 + 倒序取最近 + 再翻回升序 ═══════════ */
C('flow_filtersAndReverses', () => {
  sb.__data.messages = { rows: [
    { session_id: 'ME', role: 'user', content: '本会话的，要排除', created_at: '2026-09-10T11:00:00Z', visible: true },
    { session_id: 'A', role: 'user', content: 'a1', created_at: '2026-09-10T01:00:00Z', visible: true },
    { session_id: 'B', role: 'assistant', content: 'b1', created_at: '2026-09-10T02:00:00Z', visible: true },
    { session_id: 'A', role: 'user', content: '隐藏的，要排除', created_at: '2026-09-10T03:00:00Z', visible: false },
    { session_id: 'C', role: 'user', content: 'c1', created_at: '2026-09-10T04:00:00Z', visible: true },
  ] };
}, (A) => A.loadOtherSessionFlow('ME'));
// limit 真生效：默认 24，这里显式给 2，应只回**最近**的两条（倒序取完再翻回升序）
C('flow_limit', () => {
  sb.__data.messages = { rows: [
    { session_id: 'A', role: 'user', content: '最早', created_at: '2026-09-01T00:00:00Z', visible: true },
    { session_id: 'A', role: 'user', content: '中间', created_at: '2026-09-05T00:00:00Z', visible: true },
    { session_id: 'A', role: 'user', content: '最新', created_at: '2026-09-09T00:00:00Z', visible: true },
  ] };
}, (A) => A.loadOtherSessionFlow('ME', 2));
C('flow_error', () => { sb.__data.messages = { error: 'timeout' }; }, (A) => A.loadOtherSessionFlow('ME'));
C('flow_throw', () => { sb.__throw('ECONNRESET'); }, (A) => A.loadOtherSessionFlow('ME'));

/* ═══════════ ⑤ buildCrossSessionNarrative ═══════════ */
C('cross_narrative', null, (A) => A.buildCrossSessionNarrative([
  { role: 'user', content: '第一行\n第二行不该出现', created_at: '2026-09-01T10:00:00Z' },
  { role: 'assistant', content: '  '.trim() ? 'x' : '', created_at: '2026-09-02T10:00:00Z' },   // 空内容 → 跳过
  { role: 'assistant', content: '沈晏说的话', created_at: '2026-09-03T10:00:00Z' },
  { role: 'user', content: '长'.repeat(120), created_at: '2026-09-04T10:00:00Z' },              // 截到 80 字
]));
C('cross_narrative_empty', null, (A) => A.buildCrossSessionNarrative([]));
C('cross_narrative_allBlank', null, (A) => A.buildCrossSessionNarrative([{ role: 'user', content: '\n\n', created_at: '2026-09-01T10:00:00Z' }]));

/* ═══════════ ⑥ insertSummarySegment（写库，读回来验） ═══════════ */
C('insert_ok', () => { dbSnap = 'summary_segments'; }, (A) => A.insertSummarySegment('S20', 1, 5, '第一段摘要', '2026-09-01T00:00:00Z', '2026-09-05T00:00:00Z'));
C('insert_noTimestamps', () => { dbSnap = 'summary_segments'; }, (A) => A.insertSummarySegment('S21', 6, 9, '不带时间戳'));
C('insert_error', () => { dbSnap = 'summary_segments'; sb.__data.summary_segments = { error: 'duplicate key value' }; },
  (A) => A.insertSummarySegment('S22', 1, 5, 'x'));
C('insert_throw', () => { sb.__throw('payload too large'); }, (A) => A.insertSummarySegment('S23', 1, 5, 'x'));

/* ═══════════ ⑦ pairTurns ═══════════ */
C('pair_normal', null, (A) => A.pairTurns(msgs(5)));
// assistant 出现在任何 user 之前 → 直接丢（current 还是 null）
C('pair_leadingAssistant', null, (A) => A.pairTurns([
  { role: 'assistant', content: '孤儿', created_at: '2026-09-01T00:00:00Z' },
  { role: 'user', content: 'u1', created_at: '2026-09-01T00:01:00Z' },
  { role: 'assistant', content: 'a1', created_at: '2026-09-01T00:02:00Z' },
]));
// 一轮里多条 assistant（工具续调/重试）→ 全挂同一轮
C('pair_multiReply', null, (A) => A.pairTurns([
  { role: 'user', content: 'u1', created_at: '2026-09-01T00:00:00Z' },
  { role: 'assistant', content: 'a1', created_at: '2026-09-01T00:01:00Z' },
  { role: 'assistant', content: 'a2', created_at: '2026-09-01T00:02:00Z' },
  { role: 'user', content: 'u2', created_at: '2026-09-01T00:03:00Z' },
]));
C('pair_empty', null, (A) => A.pairTurns([]));
C('pair_null', null, (A) => A.pairTurns(null));

/* ═══════════ ⑧ fetchSessionHistory：1000 行硬上限 → 必须真分页 ═══════════ */
C('hist_zero', () => { sb.__data.messages = { rows: [] }; }, (A) => A.fetchSessionHistory('S30'));
C('hist_onePage', () => { sb.__data.messages = { rows: msgs(7, 'S31') }; }, (A) => A.fetchSessionHistory('S31'));
// 2500 条 → 三段 range（0-999 / 1000-1999 / 2000-2999），最后一段只回 500
C('hist_paginates', () => { sb.__data.messages = { rows: msgs(2500, 'S32') }; }, async (A) => {
  const rows = await A.fetchSessionHistory('S32');
  return { len: rows.length, first: rows[0] && rows[0].content, last: rows[rows.length - 1] && rows[rows.length - 1].content };
});
// 分页中途回空 → break（早退，不再空转后续页）
// count 说有 5000 条但页里一条没有 —— 模拟「count 与真实页不一致」，没有 break 就会空转 5 轮
C('hist_breaksOnEmptyPage', () => { sb.__data.messages = { rows: [], count: 5000 }; }, (A) => A.fetchSessionHistory('S33'));
C('hist_isolatesSession', () => {
  sb.__data.messages = { rows: [...msgs(3, 'S34'), ...msgs(4, 'OTHER')] };
}, async (A) => (await A.fetchSessionHistory('S34')).length);

/* ═══════════ ⑨ 锚点：进程内 Map fast path + DB 回源 ═══════════ */
C('anchor_dbHitThenMapFastPath', () => {
  sb.__data.sessions = { rows: [{ id: 'A1', live_anchor_turn: 12 }] };
}, async (A) => {
  const first = await A.loadLiveAnchor('A1');
  const ioAfterFirst = sb.__log.length;
  const second = await A.loadLiveAnchor('A1');   // 该走 Map，不该再查一次库
  return { first, second, secondQueryCount: sb.__log.length - ioAfterFirst };
});
C('anchor_dbMiss', () => { sb.__data.sessions = { rows: [] }; }, (A) => A.loadLiveAnchor('A2'));
// 列存在但值不是整数（NULL / 字符串 / 浮点）→ 都不认，返回 null
C('anchor_nonInteger', () => { sb.__data.sessions = { rows: [{ id: 'A3', live_anchor_turn: '12' }] }; }, (A) => A.loadLiveAnchor('A3'));
C('anchor_nullValue', () => { sb.__data.sessions = { rows: [{ id: 'A4', live_anchor_turn: null }] }; }, (A) => A.loadLiveAnchor('A4'));
C('anchor_readError', () => { sb.__data.sessions = { error: 'column live_anchor_turn does not exist' }; }, (A) => A.loadLiveAnchor('A5'));
C('anchor_readThrow', () => { sb.__throw('db down'); }, (A) => A.loadLiveAnchor('A6'));
C('anchor_saveThenLoad', () => { sb.__data.sessions = { rows: [{ id: 'A7' }] }; }, async (A) => {
  const saved = await A.saveLiveAnchor('A7', 9);
  const loaded = await A.loadLiveAnchor('A7');   // save 已经写了 Map，这里不该再查库
  return { saved, loaded };
});
C('anchor_saveThrow', () => { sb.__throw('read-only'); }, (A) => A.saveLiveAnchor('A8', 3));

module.exports = {
  baseRev: 'f7e49da',
  ranges: [[1998, 2150], [2368, 2390]],
  expose: ['getContextConfig', 'getSessionState', 'loadSummarySegments',
    'loadOtherSessionFlow', 'buildCrossSessionNarrative', 'insertSummarySegment', 'pairTurns',
    'fetchSessionHistory', 'loadLiveAnchor', 'saveLiveAnchor'],
  deps: DEPS,
  // rev 模式交回裸符号集，module 模式交回工厂本身 —— 归一成同一个形状
  adapt: (api) => (typeof api === 'function' ? api(DEPS) : api),
  calls,
};
