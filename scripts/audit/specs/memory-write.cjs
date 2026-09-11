/* 分区第 3 步 · lib/memory/（记忆编辑者）的行为基线 spec
   同一份 spec 跑两个来源，输出必须逐字节一致：
     node scripts/audit/baseline-dump.cjs --spec scripts/audit/specs/memory-write.cjs --rev f7e49da --out test/fixtures/memory-write.baseline.json
     node scripts/audit/baseline-dump.cjs --spec scripts/audit/specs/memory-write.cjs --module lib/memory/index.js --compare test/fixtures/memory-write.baseline.json

   这一片是「写回器」：它自己不读任何东西，价值全在**什么条件下才写、写出去的是什么**。
   所以每组向量比五样：
     value   返回值 / 落库后的表快照（真的读回来，不信「我以为写了」）
     io      假 supabase 的查询序列（读窗口 → 读主题表 → upsert 的顺序本身就是语义）
     ombre   callOmbreTool 的调用序列与参数 —— hold 的 tags 是 string 不是数组，
             trace 的必填是 bucket_id 不是 id，这两条**只有调用参数能钉住**
     ds      callDeepSeekJson 的调用（refine 用）
     logs    console 三兄弟的每一句（记忆写入的每一步都必须留痕）
     warns   warnConfigFallback / markMemoryDegraded 被调的组名与理由

   ⚠️ warnConfigFallback **不跟这一片走**（同 session 片）：它是六个配置组的共同出口，
      按依赖面属于全文件，留在 server.js 注入。这里给的是**回声桩**。
   ⚠️ stripUiMarkers 也**不跟这一片走**：它是零依赖纯叶子，三个域在用
      （备份导出 server.js:1028 / 残留窗口 2510 / 记忆门控 3304），所以单独抽成
      lib/ui-markers.js，两边各 require 一次 —— 不注入、不留第二份副本。
      rev 模式仍然把它切进区间（见 ranges 第二段），这样两边跑的都是**同一份原始文本**。
   ⚠️ 进程内态 memoryWriteLocks / memoryWriteProcessed 跨向量会残留 ——
      所以每条向量用**不同的 session id 和不同的窗口内容**，谁也不撞谁。
   ⚠️ 冻钟：upsertMemoryTopic 盖 updated_at、refineFeelContent 盖 superseded_at，
      两条都读 new Date()，不冻就不逐字节相同。
   ⚠️ 这一片有两处**直连外部**（fetch + process.env.DEEPSEEK_API_KEY），
      所以这里临时改进程内的 DEEPSEEK_API_KEY 与 globalThis.fetch，跑完原样还原。
      **不读、不打印真 key** —— 只是把它换成一个假值再换回去。 */

const ROOT = require('path').resolve(__dirname, '..', '..', '..');
const { makeFakeSb, FROZEN, FrozenDate, fmtIo } = require('../testkit.cjs');
const { sha256 } = require(ROOT + '/lib/cache-control.js');

const sb = makeFakeSb();
const S = { warns: [], degraded: [] };
const OMBRE = { calls: [], resp: '新建→366aa7012c76', throwTag: null };
const DS = { calls: [], ret: null };
const FETCH = { impl: null };

const DEPS = {
  supabase: sb,
  warnConfigFallback: (group, err) =>
    S.warns.push(`${group}:${err && err.message ? err.message : (err ? String(err) : 'no-row')}`),
  markMemoryDegraded: (r) => S.degraded.push(r),
  sha256,
  callOmbreTool: async (tool, args) => {
    OMBRE.calls.push([tool, args]);
    if (OMBRE.throwTag && args && args.tags === OMBRE.throwTag) throw new Error('ombre down');
    return OMBRE.resp;
  },
  callDeepSeekJson: async (sys, usr, tag) => {
    DS.calls.push([tag, usr]);
    return DS.ret;
  },
  // rev 模式下这条盖掉沙箱里的真 Date（deps 是最后展开的）
  Date: FrozenDate,
  // 这两样是「真外部」：沙箱里没有，模块侧走 Node 全局。两边都换成同一批可控桩。
  process,
  AbortSignal,
  fetch: (...a) => FETCH.impl(...a),
};

/* ───────────────── 跑一组调用 ───────────────── */
let LOGS = [];
async function runCase(setup, fn) {
  sb.__clear();
  sb.__throw(null);
  S.warns.length = 0;
  S.degraded.length = 0;
  OMBRE.calls.length = 0;
  OMBRE.resp = '新建→366aa7012c76';
  OMBRE.throwTag = null;
  DS.calls.length = 0;
  DS.ret = null;
  FETCH.impl = null;
  LOGS = [];

  const rl = console.log, rw = console.warn, re = console.error, rd = global.Date, rf = globalThis.fetch;
  const hadKey = Object.prototype.hasOwnProperty.call(process.env, 'DEEPSEEK_API_KEY');
  const oldKey = process.env.DEEPSEEK_API_KEY;
  console.log = (...a) => LOGS.push('log ' + a.join(' '));
  console.warn = (...a) => LOGS.push('warn ' + a.join(' '));
  console.error = (...a) => LOGS.push('err ' + a.join(' '));
  global.Date = FrozenDate;
  globalThis.fetch = (...a) => FETCH.impl(...a);
  process.env.DEEPSEEK_API_KEY = 'test-key-not-real';
  let value;
  try {
    if (setup) setup();
    value = await fn();
  } finally {
    console.log = rl; console.warn = rw; console.error = re; global.Date = rd; globalThis.fetch = rf;
    if (hadKey) process.env.DEEPSEEK_API_KEY = oldKey; else delete process.env.DEEPSEEK_API_KEY;
  }
  return {
    value, io: fmtIo(sb.__log),
    topics: JSON.parse(JSON.stringify((sb.__data.memory_topics && sb.__data.memory_topics.rows) || [])),
    ombre: OMBRE.calls, ds: DS.calls,
    logs: LOGS.slice(), warns: S.warns.slice(), degraded: S.degraded.slice(),
  };
}

const calls = [];
const C = (name, setup, fn) => calls.push({ name, run: (A) => runCase(setup, () => fn(A)) });

/* 每条向量一个唯一串，避免 memoryWriteProcessed / memoryWriteLocks 串味 */
let SEQ = 0;
const uniq = () => `w${++SEQ}`;

/** 造 n 条消息（升序，最后一条是最新），content 带唯一串 */
const msgs = (n, sid, tag) => Array.from({ length: n }, (_, i) => ({
  role: i % 2 === 0 ? 'user' : 'assistant',
  content: `${tag}-m${i}-${'长'.repeat(i % 3)}`,
  created_at: new Date(FROZEN - (n - i) * 60000).toISOString(),
  session_id: sid,
  visible: true,
}));

/** memory_topics 一行 */
const ROW = (o) => Object.assign({
  id: 1, topic: '猫', source: 'chat', kind: 'memory', grounding: '实',
  last_content: '旧正文', snapshot_hash: 'h', key_facts: null,
  evidence: '她说过', importance: 0.5, bucket_id: 'aaaaaaaaaaaa',
  song_key: null, event_time: null, conversation_time: null,
}, o);

/** writeMemoryItems 吃的一条 item（normalizeMemoryWrite 的产物形状） */
const ITEM = (o) => Object.assign({
  topic: '猫', update_topic: null, song_key: null, content: '她养了一只叫团子的猫',
  grounding: '实', evidence: '她说团子', importance: 0.6,
  event_time: null, kind: 'memory', key_facts: null,
}, o);

/** DeepSeek 分类器的假响应：{"should_write":...,"items":[...]} */
/* 这三个返回的都是 **fetch 的实现函数**（不是 Response 对象）—— FETCH.impl 就是被当函数调的。 */
const dsReply = (obj) => async () => ({ ok: true, json: async () => ({ choices: [{ message: { content: JSON.stringify(obj) } }] }) });
const dsRaw = (s) => async () => ({ ok: true, json: async () => ({ choices: [{ message: { content: s } }] }) });
/* 判官和分类器走的是同一个 fetch —— 同一组向量里它们前后脚各打一次，
   所以假响应必须**按次序发**，不能一条通吃（否则测的是「判官说了分类器的话」）。 */
const dsSeq = (...fs) => { let i = 0; return () => fs[Math.min(i++, fs.length - 1)](); };
/** 关掉判官，让向量只压主分类那一段 */
const NO_GATE = { settings: [{ session_id: 'global', memory_gate_enabled: false }] };

/* ═══════════ ① stripUiMarkers（搬去 lib/ui-markers.js 的那个纯叶子） ═══════════ */
C('ui_plain', null, (A) => A.stripUiMarkers('她: 今天好累'));
C('ui_askBlock', null, (A) => A.stripUiMarkers('她说 [[ask]]选项一\n选项二[[/ask]] 然后沉默了'));
C('ui_eventAlarm', null, (A) => A.stripUiMarkers('好 [[event 2026-09-12 看展]] 记下了\n[[alarm 明天8点]]'));
C('ui_empty', null, (A) => [A.stripUiMarkers(''), A.stripUiMarkers(null), A.stripUiMarkers(undefined)]);
C('ui_collapseSpace', null, (A) => A.stripUiMarkers('前  [[ask]]A[[/ask]]   后'));

/* ═══════════ ② parseEventTime（防 LLM 幻觉年份是唯一守卫） ═══════════ */
C('ev_ok', null, (A) => A.parseEventTime('2026-07-28'));
C('ev_withTime', null, (A) => A.parseEventTime('2026-07-28T09:30:00+08:00'));
C('ev_bad', null, (A) => A.parseEventTime('上周三'));
C('ev_oldYear', null, (A) => A.parseEventTime('1999-12-31'));
C('ev_futureYear', null, (A) => A.parseEventTime('2101-01-01'));
C('ev_notString', null, (A) => [A.parseEventTime(null), A.parseEventTime(20260728), A.parseEventTime(''), A.parseEventTime('   ')]);

/* ═══════════ ③ normalizeMemoryWrite（LLM 输出的第一道闸） ═══════════ */
C('nw_ok', null, (A) => A.normalizeMemoryWrite({
  should_write: true,
  items: [{ topic: '猫', content: '她养了一只叫团子的猫', grounding: '实', evidence: '她说团子', importance: 0.8 }],
}));
C('nw_nonObject', null, (A) => [A.normalizeMemoryWrite(null), A.normalizeMemoryWrite('x'), A.normalizeMemoryWrite(undefined)]);
C('nw_itemsNotArray', null, (A) => A.normalizeMemoryWrite({ should_write: true, items: 'nope' }));
// grounding=空 / 缺 topic / content 不足 4 字 —— 三条过滤各自独立，都要钉住
C('nw_filters', null, (A) => A.normalizeMemoryWrite({
  should_write: true,
  items: [
    { topic: '空证据', content: '这条没有根据', grounding: '空' },
    { topic: '', content: '没有主题但够长', grounding: '实' },
    { topic: '太短', content: '嗯', grounding: '实' },
    { topic: '', content: '', grounding: '实' },
    { topic: '好', content: '她是杭州人', grounding: '悬' },
  ],
}));
C('nw_sliceAndClamp', null, (A) => A.normalizeMemoryWrite({
  should_write: true,
  items: [{
    topic: '一二三四五六七八九十甲乙丙丁', update_topic: '一二三四五六七八九十甲乙丙丁',
    content: '长'.repeat(80), evidence: '证'.repeat(80),
    grounding: '实', importance: 9, song_key: '歌'.repeat(210),
  }],
}));
C('nw_importanceEdges', null, (A) => A.normalizeMemoryWrite({
  should_write: true,
  items: [
    { topic: 'a', content: '事实一', grounding: '实', importance: -3 },
    { topic: 'b', content: '事实二', grounding: '实', importance: 'abc' },
    { topic: 'c', content: '事实三', grounding: '实', importance: 0 },
  ],
}));
C('nw_kindAndKeys', null, (A) => A.normalizeMemoryWrite({
  should_write: true,
  items: [{
    topic: '亲', content: '她说过最喜欢亲我', grounding: '实',
    kind: 'feel', key_facts: ['她喜欢亲我', '', '   ', 'x'.repeat(100), 42, null],
  }],
}));
// should_write=true 但 items 被过滤空了 → 仍是 false（「凑记忆」不算数）
C('nw_shouldWriteFalseWhenEmpty', null, (A) => A.normalizeMemoryWrite({
  should_write: true, items: [{ topic: 'x', content: '短', grounding: '实' }],
}));
C('nw_shouldWriteTruthyNotBool', null, (A) => A.normalizeMemoryWrite({
  should_write: 'true', items: [{ topic: '猫', content: '她养了猫', grounding: '实' }],
}));

/* ═══════════ ④ buildMemoryWritePrompt（纯串；已有主题列表会截断去空白） ═══════════ */
C('bp_noTopics', null, (A) => A.buildMemoryWritePrompt('2026年9月10日', []));
C('bp_withTopics', null, (A) => A.buildMemoryWritePrompt('2026年9月10日', [
  { topic: '猫', last_content: '她养了一只叫\n团子的猫' },
  { topic: '搬家', last_content: null },
]));

/* ═══════════ ⑤ normalizeGateResult ═══════════ */
C('gr_true', null, (A) => A.normalizeGateResult('true'));
C('gr_false', null, (A) => A.normalizeGateResult('false'));
C('gr_upper', null, (A) => A.normalizeGateResult('TRUE'));
C('gr_noMatch', null, (A) => [A.normalizeGateResult('不知道'), A.normalizeGateResult(''), A.normalizeGateResult(null)]);

/* ═══════════ ⑥ getMemoryGateConfig（fail-open 是它的全部语义） ═══════════ */
C('gc_enabled', () => { sb.__data.settings = { rows: [{ session_id: 'global', memory_gate_enabled: true }] }; },
  (A) => A.getMemoryGateConfig());
// 判定用的是 `!== false`：0 / null / 缺列都算「开」
C('gc_notFalse', () => { sb.__data.settings = { rows: [{ session_id: 'global', memory_gate_enabled: null }] }; },
  (A) => A.getMemoryGateConfig());
C('gc_disabled', () => { sb.__data.settings = { rows: [{ session_id: 'global', memory_gate_enabled: false }] }; },
  (A) => A.getMemoryGateConfig());
C('gc_error', () => { sb.__data.settings = { error: 'column memory_gate_enabled does not exist' }; },
  (A) => A.getMemoryGateConfig());
C('gc_noRow', () => { sb.__data.settings = { rows: [] }; }, (A) => A.getMemoryGateConfig());
C('gc_throw', () => { sb.__throw('socket hang up'); }, (A) => A.getMemoryGateConfig());

/* ═══════════ ⑦ findExistingMemoryTopic（containment 两向 + 长度门槛） ═══════════ */
const TOPICS = [
  { topic: '猫' }, { topic: '搬家' }, { topic: '上海' },
  { topic: 'a' },            // 单字主题：两个 containment 分支都要求 length>=2，所以它只可能被精确命中
  { topic: null },
];
C('fm_exact', null, (A) => A.findExistingMemoryTopic(TOPICS, '搬家'));
C('fm_newContainsOld', null, (A) => A.findExistingMemoryTopic(TOPICS, '月底搬家到杭州'));
C('fm_oldContainsNew', null, (A) => A.findExistingMemoryTopic(TOPICS, '上海'));
C('fm_singleCharExactOnly', null, (A) => A.findExistingMemoryTopic(TOPICS, 'a'));
C('fm_noMatch', null, (A) => A.findExistingMemoryTopic(TOPICS, '完全无关的词'));
C('fm_empty', null, (A) => [A.findExistingMemoryTopic(TOPICS, ''), A.findExistingMemoryTopic(TOPICS, null)]);

/* ═══════════ ⑧ buildMarkedContent ═══════════ */
C('bm_ok', null, (A) => A.buildMarkedContent({ content: '  她养了一只猫  ' }));
C('bm_missing', null, (A) => [A.buildMarkedContent({}), A.buildMarkedContent({ content: null })]);

/* ═══════════ ⑨ extractBucketIdFromHoldResponse（Ombre 是外部后端，四种格式） ═══════════ */
C('eb_holdFormat', null, (A) => A.extractBucketIdFromHoldResponse('新建→366aa7012c76'));
C('eb_bucketIdKey', null, (A) => A.extractBucketIdFromHoldResponse('[bucket_id: abc123xyz]'));
C('eb_uuid', null, (A) => A.extractBucketIdFromHoldResponse('{"id": "3f2b9c1e-1111-2222-3333-444455556666"}'));
C('eb_bareHex', null, (A) => A.extractBucketIdFromHoldResponse('ok 366aa7012c76'));
C('eb_noMatch', null, (A) => [A.extractBucketIdFromHoldResponse('没有 ID'), A.extractBucketIdFromHoldResponse(''), A.extractBucketIdFromHoldResponse(null)]);

/* ═══════════ ⑩ normalizeKeyFacts（字符串/对象两种存量都要能归一） ═══════════ */
C('kf_strings', null, (A) => A.normalizeKeyFacts(['她喜欢猫', '  ', '她住杭州']));
C('kf_objects', null, (A) => A.normalizeKeyFacts([
  { text: '甲', status: 'superseded', superseded_by: '乙', superseded_at: '2026-09-01T00:00:00.000Z' },
  { text: '丙' },
]));
C('kf_mixedAndJunk', null, (A) => A.normalizeKeyFacts(['甲', { text: '  ' }, null, 42, { text: '乙', status: 'weird' }]));
// 幂等：规范对象再归一化必须不变（sameKf 比对靠它稳定）
C('kf_idempotent', null, (A) => {
  const once = A.normalizeKeyFacts(['甲', { text: '乙', status: 'superseded' }]);
  return [once, A.normalizeKeyFacts(once)];
});
C('kf_null', null, (A) => [A.normalizeKeyFacts(null), A.normalizeKeyFacts(undefined)]);

/* ═══════════ ⑪ getAllMemoryTopics（fail-closed：读失败回 null 不是 []） ═══════════ */
C('gt_ok', () => { sb.__data.memory_topics = { rows: [ROW({ topic: '猫' }), ROW({ id: 2, topic: '搬家' })] }; },
  (A) => A.getAllMemoryTopics());
// 回 [] 会把所有主题当不存在 → 全部重新 hold → Ombre 重复建桶（永久污染）。这条钉的是 null。
C('gt_throw', () => { sb.__throw('permission denied'); }, (A) => A.getAllMemoryTopics());
// supabase-js 最常见的失败形态：回 error 字段、不抛（列不存在 / RLS / 权限）
C('gt_errorField', () => { sb.__data.memory_topics = { error: 'permission denied' }; }, (A) => A.getAllMemoryTopics());

/* ═══════════ ⑫ upsertMemoryTopic（onConflict 是 (source,topic)） ═══════════ */
C('up_existingMerged', () => {
  sb.__data.memory_topics = { rows: [ROW({ id: 1, topic: '猫', source: 'chat' })] };
}, (A) => A.upsertMemoryTopic({ topic: '猫', source: 'chat', last_content: '新正文' }));
C('up_newRowAppended', () => {
  sb.__data.memory_topics = { rows: [ROW({ id: 1, topic: '猫', source: 'chat' })] };
}, (A) => A.upsertMemoryTopic({ topic: '搬家', last_content: '她要搬家' }));
// source 缺省兜底 chat —— 唯一键是 (source,topic)，兜错就成了新行
C('up_sourceDefaultsChat', () => {
  sb.__data.memory_topics = { rows: [ROW({ id: 1, topic: '猫', source: 'chat' })] };
}, (A) => A.upsertMemoryTopic({ topic: '猫', last_content: '不带 source' }));
C('up_error', () => { sb.__data.memory_topics = { error: 'duplicate key value' }; },
  (A) => A.upsertMemoryTopic({ topic: '猫', last_content: 'x' }));
C('up_throw', () => { sb.__throw('socket hang up'); }, (A) => A.upsertMemoryTopic({ topic: '猫', last_content: 'x' }));

/* ═══════════ ⑬ holdNewMemory（tags 必须是 string —— 传数组会 validation error） ═══════════ */
C('hold_ok', null, (A) => A.holdNewMemory({ topic: '猫', grounding: '实' }, '她养了猫'));
C('hold_unparsableId', () => { OMBRE.resp = '（没有 ID 的一段话）'; },
  (A) => A.holdNewMemory({ topic: '猫', grounding: '实' }, '她养了猫'));

/* ═══════════ ⑭ locateBucketIdByTopic / BySongKey ═══════════ */
C('loc_topic', null, (A) => A.locateBucketIdByTopic('猫'));
C('loc_songKey', null, (A) => A.locateBucketIdBySongKey('起风了|买辣椒也用券'));
// 空歌名直接回 null —— 不能白打一次 breath_search
C('loc_songKeyEmpty', null, (A) => [A.locateBucketIdBySongKey(''), A.locateBucketIdBySongKey(null)]);

/* ═══════════ ⑮ traceUpdateMemory（trace 的必填是 bucket_id 不是 id） ═══════════ */
C('tr_ok', null, (A) => A.traceUpdateMemory('aaaaaaaaaaaa', '旧', '新'));
C('tr_emptyResp', () => { OMBRE.resp = ''; }, (A) => A.traceUpdateMemory('aaaaaaaaaaaa', '旧', '新'));

/* ═══════════ ⑯ refineFeelContent（feel 桶更新时带旧正文重新提炼） ═══════════ */
C('rf_ok', () => {
  DS.ret = { content: '她说过最喜欢亲我', key_facts: [{ text: '她喜欢亲我', status: 'active' }] };
}, (A) => A.refineFeelContent(
  ROW({ kind: 'feel', last_content: '她亲过我', key_facts: ['她喜欢亲我'] }),
  ITEM({ kind: 'feel' }), '她: 我特别喜欢亲你'));
// 关键事实只增不减：模型漏掉的旧事实按原状态保留
C('rf_unionKeepsOld', () => {
  DS.ret = { content: '更新后的正文', key_facts: [{ text: '新事实', status: 'active' }] };
}, (A) => A.refineFeelContent(
  ROW({ kind: 'feel', last_content: '旧正文', key_facts: [{ text: '旧事实', status: 'active' }, { text: '作废事实', status: 'superseded', superseded_at: '2026-08-01T00:00:00.000Z' }] }),
  ITEM({ kind: 'feel' }), '窗口'));
// 模型把已作废的标回 active → 必须纠回 superseded（证据可废止不可撕掉）
C('rf_supersededNotRevived', () => {
  DS.ret = { content: '正文', key_facts: [{ text: '作废事实', status: 'active' }] };
}, (A) => A.refineFeelContent(
  ROW({ kind: 'feel', last_content: '旧', key_facts: [{ text: '作废事实', status: 'superseded', superseded_at: '2026-08-01T00:00:00.000Z' }] }),
  ITEM({ kind: 'feel' }), '窗口'));
C('rf_noOldContent', () => { DS.ret = { content: 'x' }; },
  (A) => A.refineFeelContent(ROW({ kind: 'feel', last_content: '' }), ITEM({ kind: 'feel' }), '窗口'));
C('rf_noWindow', () => { DS.ret = { content: 'x' }; },
  (A) => A.refineFeelContent(ROW({ kind: 'feel', last_content: '旧' }), ITEM({ kind: 'feel' }), '   '));
C('rf_modelNull', () => { DS.ret = null; },
  (A) => A.refineFeelContent(ROW({ kind: 'feel', last_content: '旧' }), ITEM({ kind: 'feel' }), '窗口'));
C('rf_emptyContent', () => { DS.ret = { content: '   ' }; },
  (A) => A.refineFeelContent(ROW({ kind: 'feel', last_content: '旧' }), ITEM({ kind: 'feel' }), '窗口'));

/* ═══════════ ⑰ writeMemoryItems（差分写回本体） ═══════════ */
C('wm_empty', null, (A) => A.writeMemoryItems([]));
// 读主题表**真抛** → markMemoryDegraded + 一行大声的 error，**本轮一个桶都不建**
C('wm_topicsThrow', () => { sb.__throw('memory_topics read failed'); },
  (A) => A.writeMemoryItems([ITEM()]));
// ⚠️ 真发现（没改，只钉住）：supabase-js 的失败是**回 error 字段、不抛**，
//    而 getAllMemoryTopics 只解构 `data`（`const { data } = await ...`），于是
//    `{data:null, error:{...}}` 走到 `data || []` 变成 **[]** —— 文件头那句
//    「fail-closed：读失败返回 null（不是 []）」的闸门（调用方的 `topics === null`）**不响**。
//    后果：看不见旧桶 → 每个主题都当新的 → 全部 hold → Ombre 重复建桶，
//    正是那段注释说要防的「永久污染」。这条向量与上一条的落差就是那个缺口。
C('wm_topicsErrorFieldProceeds', () => { sb.__data.memory_topics = { error: 'permission denied' }; },
  (A) => A.writeMemoryItems([ITEM({ topic: '本该被挡住的新桶' })]));
C('wm_newTopic', () => { sb.__data.memory_topics = { rows: [] }; },
  (A) => A.writeMemoryItems([ITEM({ topic: '搬家', content: '她月底搬去上海' })], '2026-09-09T00:00:00.000Z', '窗口'));
// 正文与关键事实都没变 → 零变化跳过：一次 Ombre 调用都不该有
C('wm_zeroChangeSkips', () => {
  sb.__data.memory_topics = { rows: [ROW({ topic: '猫', last_content: '她养了一只叫团子的猫', key_facts: null })] };
}, (A) => A.writeMemoryItems([ITEM({ topic: '猫', content: '她养了一只叫团子的猫', key_facts: null })]));
// 正文变了 + 有 bucket_id → trace，然后落本地快照
C('wm_textChangedTraces', () => {
  sb.__data.memory_topics = { rows: [ROW({ topic: '猫', last_content: '旧正文', bucket_id: 'aaaaaaaaaaaa' })] };
}, (A) => A.writeMemoryItems([ITEM({ topic: '猫', content: '她养了一只叫团子的猫' })]));
// 只有 key_facts 变了 → 不动 Ombre，只更新本地快照
C('wm_onlyKeyFactsChanged', () => {
  sb.__data.memory_topics = { rows: [ROW({ topic: '猫', last_content: '她养了一只叫团子的猫', key_facts: [] })] };
}, (A) => A.writeMemoryItems([ITEM({ topic: '猫', content: '她养了一只叫团子的猫', kind: 'feel', key_facts: [{ text: '新事实', status: 'active' }] })]));
// 没 bucket_id → 先按主题定位（breath_search），定位到了再 trace
C('wm_noBucketIdLocates', () => {
  sb.__data.memory_topics = { rows: [ROW({ topic: '猫', last_content: '旧正文', bucket_id: null })] };
}, (A) => A.writeMemoryItems([ITEM({ topic: '猫', content: '新正文' })]));
C('wm_noBucketIdLocateFails', () => {
  sb.__data.memory_topics = { rows: [ROW({ topic: '猫', last_content: '旧正文', bucket_id: null })] };
  OMBRE.resp = '（定位不到）';
}, (A) => A.writeMemoryItems([ITEM({ topic: '猫', content: '新正文' })]));
// trace 失败 → 不更新本地快照（下轮重试）
C('wm_traceFailsKeepsSnapshot', () => {
  sb.__data.memory_topics = { rows: [ROW({ topic: '猫', last_content: '旧正文', bucket_id: 'aaaaaaaaaaaa' })] };
  OMBRE.resp = '';
}, (A) => A.writeMemoryItems([ITEM({ topic: '猫', content: '新正文' })]));
// 音乐桶按 song_key 精确匹配，不走 containment；没 bucket_id 就用歌名定位
C('wm_musicBySongKey', () => {
  sb.__data.memory_topics = { rows: [ROW({ topic: '起风了', source: 'music', song_key: '起风了|买辣椒也用券', bucket_id: null, last_content: '旧' })] };
}, (A) => A.writeMemoryItems([ITEM({ topic: '起风了', song_key: '起风了|买辣椒也用券', content: '新正文' })]));
// chat 分类器不得命中音乐桶（source!=music 过滤）
C('wm_chatSkipsMusicBuckets', () => {
  sb.__data.memory_topics = { rows: [ROW({ topic: '起风了', source: 'music', song_key: '起风了|买辣椒也用券' })] };
}, (A) => A.writeMemoryItems([ITEM({ topic: '起风了', content: '她今天也在听起风了' })]));
// feel 桶更新 → 走 refine，把提炼后的正文写出去
C('wm_feelRefines', () => {
  sb.__data.memory_topics = { rows: [ROW({ topic: '亲', kind: 'feel', last_content: '她亲过我', bucket_id: 'aaaaaaaaaaaa', key_facts: ['她喜欢亲我'] })] };
  DS.ret = { content: '她说过最喜欢亲我', key_facts: [{ text: '她喜欢亲我', status: 'active' }] };
}, (A) => A.writeMemoryItems([ITEM({ topic: '亲', kind: 'feel', content: '她又亲了我' })], '', '她: 我特别喜欢亲你'));
// refine 原样返回旧正文 → 视为没变，走零变化跳过
C('wm_feelRefineNoChange', () => {
  sb.__data.memory_topics = { rows: [ROW({ topic: '亲', kind: 'feel', last_content: '她亲过我', bucket_id: 'aaaaaaaaaaaa', key_facts: [] })] };
  DS.ret = { content: '她亲过我', key_facts: [] };
}, (A) => A.writeMemoryItems([ITEM({ topic: '亲', kind: 'feel', content: '她亲过我' })], '', '窗口'));
// 单条 item 抛异常不许带塌整批（hold 对「会炸的」这个 topic 抛，后一条照写）
C('wm_oneItemThrowsOthersGo', () => {
  sb.__data.memory_topics = { rows: [] };
  OMBRE.throwTag = '会炸的';
}, (A) => A.writeMemoryItems([ITEM({ topic: '会炸的' }), ITEM({ topic: '搬', content: '她月底搬去上海' })], '', '窗口'));

/* ═══════════ ⑰b 复查补的分支（2026-09-11 Opus 复查 §3）═══════════
   spec 的 ITEM() 默认值太「乖」：update_topic 永远 null、一批一条、Ombre 永远成功、
   feel 桶的 refine 要么完美成功要么根本不走。下面压的是不乖的那一半。 */
// 一个 feel 桶的存量：一条现行事实 + 一条已作废（证据可废止不可撕掉 —— 作废行必须一直留着）
const FEEL_KF = [
  { text: '她喜欢亲我', status: 'active' },
  { text: '她住杭州', status: 'superseded', superseded_by: '她住上海', superseded_at: '2026-08-01T00:00:00.000Z' },
];
const FEEL_ROW = () => ROW({ topic: '亲', kind: 'feel', last_content: '她亲过我', bucket_id: 'aaaaaaaaaaaa', key_facts: FEEL_KF });
// A. feel 桶更新时 refine 失败（DeepSeek 挂了 → null）
C('wm_feelRefineFails', () => { sb.__data.memory_topics = { rows: [FEEL_ROW()] }; DS.ret = null; },
  (A) => A.writeMemoryItems([ITEM({ topic: '亲', kind: 'feel', content: '她今天又亲了我一下', key_facts: ['她今天亲了我'] })], '', '她: 亲你'));
// B. refine 说「没变」（原样回旧正文 + 旧事实），但分类器这一轮给的 content 不一样
C('wm_feelRefineSaysUnchanged', () => {
  sb.__data.memory_topics = { rows: [FEEL_ROW()] };
  DS.ret = { content: '她亲过我', key_facts: FEEL_KF };
}, (A) => A.writeMemoryItems([ITEM({ topic: '亲', kind: 'feel', content: '她今天又亲了我一下', key_facts: ['她今天亲了我'] })], '', '她: 亲你'));
// C. 原来是 feel 的桶，这一轮分类器标成 memory
C('wm_feelBucketGetsMemoryItem', () => { sb.__data.memory_topics = { rows: [FEEL_ROW()] }; },
  (A) => A.writeMemoryItems([ITEM({ topic: '亲', kind: 'memory', content: '她喜欢亲吻' })], '', '她: 亲你'));
// feel 桶、没有窗口原文 → refine 根本不走（另一条绕开 refine 的路）
C('wm_feelNoWindowText', () => { sb.__data.memory_topics = { rows: [FEEL_ROW()] }; },
  (A) => A.writeMemoryItems([ITEM({ topic: '亲', kind: 'feel', content: '她今天又亲了我一下', key_facts: ['她今天亲了我'] })], '', ''));
// memory 桶这一轮被标成 feel（升级方向）→ 走 refine
C('wm_memoryBucketGetsFeelItem', () => {
  sb.__data.memory_topics = { rows: [ROW({ topic: '猫', kind: 'memory', last_content: '她养了一只猫', key_facts: null })] };
  DS.ret = { content: '她养的团子总爱趴在我身边', key_facts: [{ text: '她养了一只猫', status: 'active' }] };
}, (A) => A.writeMemoryItems([ITEM({ topic: '猫', kind: 'feel', content: '团子趴在我身边', key_facts: ['她养了一只猫'] })], '', '她: 团子又来了'));
// E. update_topic 指回旧桶（08-30 三刀的核心机制）/ 指向不存在的主题（幻觉）
C('wm_updateTopicPointsBack', () => { sb.__data.memory_topics = { rows: [ROW({ topic: '搬家计划', last_content: '她打算搬家' })] }; },
  (A) => A.writeMemoryItems([
    ITEM({ topic: '新住处', update_topic: '搬家计划', content: '她月底搬去上海' }),
    ITEM({ topic: '工作', update_topic: '不存在的主题', content: '她换了新工作' }),
  ], '', 'w'));
// D. 同一批两条同 topic（prompt 要求「一窗多事实拆多条」）
C('wm_sameTopicTwiceInBatch', () => { sb.__data.memory_topics = { rows: [] }; },
  (A) => A.writeMemoryItems([ITEM({ topic: '搬家', content: '她月底搬去上海' }), ITEM({ topic: '搬家', content: '她新家离公司很近' })], '', 'w'));
// F. hold 失败（callOmbreTool → null）
C('wm_holdFails', () => { sb.__data.memory_topics = { rows: [] }; OMBRE.resp = null; },
  (A) => A.writeMemoryItems([ITEM({ topic: '生日', content: '她生日是三月五号' })], '', 'w'));
// G. 新 topic 同时包含两个旧 topic —— 命中哪个取决于数组顺序（线上 select('*') 无 order）
C('wm_containmentOrderDependent', () => {
  sb.__data.memory_topics = { rows: [
    ROW({ id: 1, topic: '上海', last_content: '旧-上海', bucket_id: 'b0b0b0b0b0b0' }),
    ROW({ id: 2, topic: '搬家', last_content: '旧-搬家', bucket_id: 'b1b1b1b1b1b1' }),
  ] };
}, (A) => A.writeMemoryItems([ITEM({ topic: '上海搬家', content: '她月底搬去上海' })], '', 'w'));
// H. 靠 breath_search 定位到的 bucket_id 会不会回写（现状：不回写）
C('wm_locatedBucketIdNotPersisted', () => {
  sb.__data.memory_topics = { rows: [ROW({ topic: '猫', bucket_id: null })] };
  OMBRE.resp = '[bucket_id: 366aa7012c76]';
}, (A) => A.writeMemoryItems([ITEM({ content: '新正文一' })], '', 'w'));
// I. 正文没变、grounding 从悬升到实 → 零变化跳过（现状：升级不落库）
C('wm_groundingUpgradeIgnored', () => {
  sb.__data.memory_topics = { rows: [ROW({ topic: '猫', last_content: '她养了一只叫团子的猫', grounding: '悬', evidence: '旧证据' })] };
}, (A) => A.writeMemoryItems([ITEM({ grounding: '实', evidence: '她亲口说团子' })], '', 'w'));

/* ═══════════ ⑱ generateMemoryWriteIfNeeded（一整条链路，含几道闸） ═══════════ */
const gmSetup = (sid, n, tag, o = {}) => () => {
  sb.__data.messages = { rows: msgs(n, sid, tag) };
  if (o.topics) sb.__data.memory_topics = { rows: o.topics };
  if (o.settings) sb.__data.settings = { rows: o.settings };
  if (o.error) sb.__data.messages = { error: o.error };
  if (o.fetch) FETCH.impl = o.fetch;
};

// 窗口不足 2 条 → 直接回，一次主题表都不读
C('gm_shortWindow', gmSetup('gm1', 1, uniq()), (A) => A.generateMemoryWriteIfNeeded('gm1'));
C('gm_readError', gmSetup('gm2', 4, uniq(), { error: 'permission denied' }), (A) => A.generateMemoryWriteIfNeeded('gm2'));
// 同一窗口跑两遍：第二遍被 windowId 去重挡掉（查询序列与第一遍一样长 = 真挡了）
C('gm_dedupeSameWindow', gmSetup('gm3', 4, uniq(), { fetch: dsReply({ should_write: false, items: [] }) }),
  (A) => A.generateMemoryWriteIfNeeded('gm3').then(() => A.generateMemoryWriteIfNeeded('gm3')));
// 用户话太少（<12 字）→ 不跑分类省一次调用
C('gm_lowUserChars', () => {
  const t = uniq();
  sb.__data.messages = { rows: [
    { role: 'user', content: '嗯', created_at: new Date(FROZEN - 3000).toISOString(), session_id: 'gm4', visible: true },
    { role: 'assistant', content: '在的', created_at: new Date(FROZEN - 2000).toISOString(), session_id: 'gm4', visible: true },
  ] };
}, (A) => A.generateMemoryWriteIfNeeded('gm4'));
// 判官说 false → 跳过主分类（连主题表都不读）
C('gm_gateSaysNo', gmSetup('gm5', 4, uniq(), { fetch: dsRaw('false') }), (A) => A.generateMemoryWriteIfNeeded('gm5'));
// 开关关掉 → 不调判官，直接主分类
C('gm_gateDisabled', gmSetup('gm6', 4, uniq(), Object.assign({ topics: [], fetch: dsReply({ should_write: false, items: [] }) }, NO_GATE)),
  (A) => A.generateMemoryWriteIfNeeded('gm6'));
// 判官失败/解析不出 → fail-open 继续走主分类（第二发才轮到分类器）
C('gm_gateFailOpen', gmSetup('gm7', 4, uniq(), { topics: [], fetch: dsSeq(dsRaw('嗯……'), dsReply({ should_write: false, items: [] })) }),
  (A) => A.generateMemoryWriteIfNeeded('gm7'));
// 主题表**真抛** → fail-closed 跳过本轮（看不见旧桶就不许写，连分类器都不调）
C('gm_topicsThrowCloses', gmSetup('gm8', 4, uniq(), {
  fetch: dsSeq(dsRaw('true'), dsReply({ should_write: true, items: [{ topic: '猫', content: '她养了猫', grounding: '实' }] })),
}), (A) => {
  sb.__throw('memory_topics read failed', 'memory_topics');
  return A.generateMemoryWriteIfNeeded('gm8');
});
// ⚠️ 真发现（没改）：error **字段**那条路不抛，getAllMemoryTopics 回的是 []、不是 null，
//    于是 fail-closed 那道闸不响，照样调分类器、照样 hold。与上一条对照着看就是落差本身。
C('gm_topicsErrorFieldProceeds', gmSetup('gm8b', 4, uniq(), {
  fetch: dsSeq(dsRaw('true'), dsReply({ should_write: true, items: [{ topic: '猫', content: '她养了猫', grounding: '实' }] })),
}), (A) => {
  sb.__data.memory_topics = { error: 'permission denied' };
  return A.generateMemoryWriteIfNeeded('gm8b');
});
// 分类器返回 should_write=false → 什么都不写
C('gm_classifierNoWrite', gmSetup('gm9', 4, uniq(), Object.assign({ topics: [], fetch: dsReply({ should_write: false, items: [] }) }, NO_GATE)),
  (A) => A.generateMemoryWriteIfNeeded('gm9'));
// 分类器非 2xx → 回 null
C('gm_classifierHttpError', gmSetup('gm10', 4, uniq(), Object.assign({ topics: [], fetch: async () => ({ ok: false, status: 429 }) }, NO_GATE)),
  (A) => A.generateMemoryWriteIfNeeded('gm10'));
// 分类器两次都空内容 → 重试两次后回 null（retry 是这条链路上唯一的重试）
C('gm_classifierEmptyRetries', gmSetup('gm11', 4, uniq(), Object.assign({ topics: [], fetch: dsRaw('') }, NO_GATE)),
  (A) => A.generateMemoryWriteIfNeeded('gm11'));
// 分类器返回坏 JSON → 异常分支
C('gm_classifierBadJson', gmSetup('gm12', 4, uniq(), Object.assign({ topics: [], fetch: dsRaw('{不是 JSON') }, NO_GATE)),
  (A) => A.generateMemoryWriteIfNeeded('gm12'));
// 走通：判官说值得 → 只有 source!=music 的主题进 prompt（按 importance 排）→ 写回
C('gm_happyPath', gmSetup('gm13', 4, uniq(), {
  topics: [
    ROW({ id: 1, topic: '猫', source: 'chat', importance: 0.9 }),
    ROW({ id: 2, topic: '起风了', source: 'music', song_key: '起风了|x', importance: 1 }),
    ROW({ id: 3, topic: '搬家', source: 'chat', importance: 0.1 }),
  ],
  fetch: dsSeq(dsRaw('true'), dsReply({ should_write: true, items: [{ topic: '猫', content: '她养了一只叫团子的猫', grounding: '实', evidence: '她说团子' }] })),
}), (A) => A.generateMemoryWriteIfNeeded('gm13'));

/* ═══════════ ⑲ scheduleMemoryWrite（单实例内存锁） ═══════════ */
// 同一 session 连排两次：第二次被锁挡掉 —— 用查询条数证明「真的只跑了一次」
C('sc_lockDedupes', gmSetup('sc1', 4, uniq(), Object.assign({ topics: [], fetch: dsReply({ should_write: false, items: [] }) }, NO_GATE)),
  (A) => { A.scheduleMemoryWrite('sc1'); A.scheduleMemoryWrite('sc1'); return new Promise((r) => setTimeout(r, 30)); });

/* ═══════════ ⑳ classifyMemoryWriteViaDeepSeek（直连 fetch） ═══════════ */
C('cl_ok', () => { FETCH.impl = dsReply({ should_write: true, items: [{ topic: '猫', content: '她养了猫', grounding: '实' }] }); },
  (A) => A.classifyMemoryWriteViaDeepSeek('她: 我养了猫', []));
C('cl_noKey', () => { delete process.env.DEEPSEEK_API_KEY; FETCH.impl = dsReply({ should_write: true, items: [] }); },
  (A) => A.classifyMemoryWriteViaDeepSeek('她: 我养了猫', []));
C('cl_throws', () => { FETCH.impl = async () => { throw new Error('network down'); }; },
  (A) => A.classifyMemoryWriteViaDeepSeek('她: 我养了猫', []));

/* ═══════════ ㉑ gateMemoryWriteViaDeepSeek ═══════════ */
C('gw_true', () => { FETCH.impl = dsRaw('true'); }, (A) => A.gateMemoryWriteViaDeepSeek('她: 我养了猫'));
C('gw_unparsable', () => { FETCH.impl = dsRaw('可能吧'); }, (A) => A.gateMemoryWriteViaDeepSeek('她: 我养了猫'));
C('gw_http', () => { FETCH.impl = async () => ({ ok: false, status: 500 }); }, (A) => A.gateMemoryWriteViaDeepSeek('她: 我养了猫'));
C('gw_throws', () => { FETCH.impl = async () => { throw new Error('socket hang up'); }; }, (A) => A.gateMemoryWriteViaDeepSeek('她: 我养了猫'));

module.exports = {
  baseRev: 'f7e49da',
  // 第一段 = 记忆编辑者本体；第二段 = 同一次搬迁里抽走的纯叶子 lib/ui-markers.js。
  // 两段都切进 rev 模式，等于两边跑的是同一份原始文本。
  ranges: [[3709, 3914], [3916, 3925], [3927, 4236]],
  expose: [
    'buildMemoryWritePrompt', 'parseEventTime', 'normalizeMemoryWrite', 'classifyMemoryWriteViaDeepSeek',
    'memoryWriteLocks', 'memoryWriteProcessed', 'MEMORY_GATE_PROMPT', 'normalizeGateResult',
    'getMemoryGateConfig', 'gateMemoryWriteViaDeepSeek', 'stripUiMarkers', 'scheduleMemoryWrite',
    'generateMemoryWriteIfNeeded', 'getAllMemoryTopics', 'upsertMemoryTopic', 'findExistingMemoryTopic',
    'buildMarkedContent', 'extractBucketIdFromHoldResponse', 'holdNewMemory', 'locateBucketIdByTopic',
    'locateBucketIdBySongKey', 'traceUpdateMemory', 'normalizeKeyFacts', 'refineFeelContent', 'writeMemoryItems',
  ],
  deps: DEPS,
  // rev 模式交回裸符号集（stripUiMarkers 已在区间里）；module 模式交回工厂，
  // 在这里按 server.js 的接法拼起来 —— stripUiMarkers 由 lib/ui-markers.js 提供（它没跟记忆片走）。
  adapt: (api) => {
    if (typeof api !== 'function') return api;
    return Object.assign({}, api(DEPS), { stripUiMarkers: require(ROOT + '/lib/ui-markers.js').stripUiMarkers });
  },
  calls,
};
