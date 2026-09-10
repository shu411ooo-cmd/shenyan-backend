// ===== lib/context/retrieval.js 单元测试（node:test）=====
//
// 两层，和 lib-context-select.test.cjs 同构：
//   ① 「与搬迁前等价」—— 拿搬迁前 HEAD 的真实输出（test/fixtures/context-retrieval.baseline.json）
//      逐字节压住。这一层的向量比上一片重得多：每一组不只比返回值，还比
//      **IO 查询序列 / warnConfigFallback 调用 / DeepSeek 调用次数 / console 输出**。
//      ⚠️ 基线**不要**在重构里更新。它红了 = 你改了行为，先解释清楚再谈更新。
//   ② 「语义断言」—— 把几条基线说不清「为什么」的行为用白话钉死：
//      冷却/回声/近 N 天位限/牵挂闸/独立联想席/声音缓存/配置降级。
//
// 工厂每次调用都给一份**全新的模块态**（attentionCooldown / attentionEcho / voiceCache /
// recallDaily 全在工厂闭包里），所以下面每个用例互不串味 —— 搬迁前这些是进程级单例，
// 测试之间会互相污染。这是这次搬迁顺手赚到的（不是行为改动：线上只实例化一次）。

const { test } = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const path = require('node:path');

const { makeFakeSb, daysAgo, T, W, SETTINGS } = require('../scripts/audit/testkit.cjs');

const createRetrieval = require('../lib/context/retrieval.js');

/* ───────── 每个用例一副干净的工具箱 ───────── */
function kit() {
  const sb = makeFakeSb();
  const state = { residue: null, deepseek: [], mode: 'ok', warns: [], logs: [] };
  const r = createRetrieval({
    supabase: sb,
    warnConfigFallback: (g) => state.warns.push(g),
    callDeepSeekJson: async (contract, plain) => {
      state.deepseek.push(String(plain));
      if (state.mode === 'throw') throw new Error('deepseek 503');
      return { text: `V:${plain}` };
    },
    getLatestResidue: async () => state.residue,
    ageResidue: (x) => ({ concern: (x && x.concern) || 0 }),
    memoryMdLabel: () => 'MD',
  });
  const rl = console.log, rw = console.warn, re = console.error;
  const capture = () => { console.log = (...a) => state.logs.push('log ' + a.join(' ')); console.warn = (...a) => state.logs.push('warn ' + a.join(' ')); console.error = (...a) => state.logs.push('err ' + a.join(' ')); };
  const release = () => { console.log = rl; console.warn = rw; console.error = re; };
  return { r, sb, state, capture, release };
}
const titles = (r) => r.refs.map((x) => x.title);

/* ═════════════ ① 与搬迁前逐字节等价 ═════════════ */

const norm = (v, d = 0) => {
  if (d > 12) return '<deep>';
  if (v === undefined) return { __undefined: true };
  if (v === null) return null;
  if (typeof v === 'number') { if (Number.isNaN(v)) return { __nan: true }; if (!Number.isFinite(v)) return { __inf: v > 0 ? 1 : -1 }; return v; }
  if (typeof v !== 'object') return v;
  if (v instanceof Set) return { __set: [...v].map((x) => norm(x, d + 1)).sort() };
  if (v instanceof Map) return { __map: [...v.entries()].map(([k, x]) => [norm(k, d + 1), norm(x, d + 1)]).sort((a, b) => String(a[0]) < String(b[0]) ? -1 : 1) };
  if (Array.isArray(v)) return v.map((x) => norm(x, d + 1));
  const o = {};
  for (const k of Object.keys(v).sort()) o[k] = norm(v[k], d + 1);
  return o;
};

const BASE = JSON.parse(fs.readFileSync(path.join(__dirname, 'fixtures', 'context-retrieval.baseline.json'), 'utf8'));
const SPEC = require('../scripts/audit/specs/context-retrieval.cjs');

test('等价搬迁：39 组向量（返回值 + IO 序列 + 告警 + 模型调用 + 日志 + 计数器）与搬迁前逐字节一致', async () => {
  const A = SPEC.adapt(createRetrieval);
  const out = {};
  for (const c of SPEC.calls) out[c.name] = norm(await c.run(A));
  assert.deepStrictEqual(out, BASE,
    '检索层的输出与搬迁前不同 —— 搬迁必须是行为等价的。\n' +
    '如果你**有意**改了行为，请先在交接文档里写清楚为什么，再更新基线。');
});

/* ═════════════ ② 语义断言 ═════════════ */

test('冷却：注入过之后要歇满 4 次检查才再注入（连续拽旧记忆最伤连续感）', async () => {
  const { r, sb, state } = kit();
  sb.__data.settings = { rows: [SETTINGS()] };
  sb.__data.memory_topics = { rows: [T('八音盒', { importance: 0.9 })] };

  assert.ok(await r.getAttentionMaterial('S', '八音盒', {}), '第一次该注入');
  const quiet = [];
  for (let i = 0; i < 3; i++) quiet.push(await r.getAttentionMaterial('S', '八音盒', {}));
  assert.deepStrictEqual(quiet, [null, null, null], '注入后的 3 次检查都该是冷却');
  assert.ok(await r.getAttentionMaterial('S', '八音盒', {}), '第 5 次检查该放行');
  assert.strictEqual(r.recallDaily.cooldown, 3, '冷却闸要计进召回可见性');
  assert.strictEqual(state.logs.filter((l) => l.startsWith('err')).length, 0);
});

test('回声压制：24h 内刚念叨过的 topic 降权 → 换人上场（治「天天念同一本经」）', async () => {
  const { r, sb } = kit();
  sb.__data.settings = { rows: [SETTINGS({ attention_k: 1 })] }; // 只给 1 席，才看得出换人
  sb.__data.memory_topics = { rows: [T('八音盒', { importance: 0.6 }), T('八音盒音准', { importance: 0.5 })] };

  const first = await r.getAttentionMaterial('S', '八音盒', {});
  assert.deepStrictEqual(titles(first), ['八音盒'], '第一次该是分数高的那条');
  for (let i = 0; i < 3; i++) await r.getAttentionMaterial('S', '八音盒', {});
  const after = await r.getAttentionMaterial('S', '八音盒', {});
  assert.deepStrictEqual(titles(after), ['八音盒音准'], '被回声降权之后该轮到另一条');
  assert.ok(r.recallDaily.echoDemoted > 0, '降权要计进召回可见性');
});

test('近 N 天位限：最近的记忆最多占 recent_seats 位（上限不是保底），其余名额让给远期', async () => {
  const { r, sb } = kit();
  sb.__data.settings = { rows: [SETTINGS({ attention_k: 3, attention_recent_seats: 1 })] };
  sb.__data.memory_topics = { rows: [
    T('搬家', { importance: 0.9, updated: daysAgo(1) }),
    T('搬家计划', { importance: 0.8, updated: daysAgo(2) }),
    T('搬家的事', { importance: 0.7, updated: daysAgo(3) }),
    T('搬家的院子', { importance: 0.6, updated: daysAgo(100) }),
    T('搬家那天', { importance: 0.5, updated: daysAgo(200) }),
  ] };
  const got = await r.getAttentionMaterial('S', '搬家', {});
  assert.deepStrictEqual(titles(got), ['搬家', '搬家的院子', '搬家那天'],
    '3 条近期的只该进 1 条，另外两席让给远期 —— 否则「最近发生的事霸榜」');
  assert.strictEqual(r.recallDaily.recentCap, 2, '被位限拦下的要计数');
});

test('牵挂闸：靠的是**去掉标点后的 n-gram**，补的正是提及闸会漏的那种写法', async () => {
  const topicRow = T('搬家', { importance: 0.7, content: '她想搬到有院子的房子' });
  const residue = { unfinished: '搬家的事还没说完', evidence: [], created_at: daysAgo(1), concern: 0.9 };

  // ① 正常写法：「搬家」连着 —— 提及闸直接中，没有牵挂注记
  const a = kit();
  a.sb.__data.settings = { rows: [SETTINGS()] };
  a.sb.__data.memory_topics = { rows: [topicRow] };
  a.state.residue = residue;
  const viaMention = await a.r.getAttentionMaterial('S', '关于搬家', {});
  assert.ok(viaMention, '提及闸该中');
  assert.ok(!viaMention.text.includes('惦记着'), '提及闸中就不该再挂牵挂注记');

  // ② 中间被空格切开：「提及闸」按原始串 includes 会漏，「牵挂闸」按净化后的 n-gram 能补上
  const b = kit();
  b.sb.__data.settings = { rows: [SETTINGS()] };
  b.sb.__data.memory_topics = { rows: [topicRow] };
  b.state.residue = residue;
  const viaConcern = await b.r.getAttentionMaterial('S', '关于搬 家', {});
  assert.ok(viaConcern, '提及闸漏了，牵挂闸该补上');
  assert.ok(viaConcern.text.includes('（你心里还惦记着：搬家的事还没说完）'),
    '牵挂是背景情绪，措辞是「你心里还惦记着」而不是「还有没说完的」（后者会被模型当成待办去办）');

  // ③ 闸的两个条件：线头没到阈值 / 没有共享词 → 都不进
  for (const [why, over] of [
    ['线头没到阈值', { concern: 0.2, unfinished: '搬家的事还没说完' }],
    ['没有共享词', { concern: 0.9, unfinished: '八音盒还没调好' }],
  ]) {
    const c = kit();
    c.sb.__data.settings = { rows: [SETTINGS()] };
    c.sb.__data.memory_topics = { rows: [topicRow] };
    c.state.residue = { evidence: [], created_at: daysAgo(1), ...over };
    assert.strictEqual(await c.r.getAttentionMaterial('S', '关于搬 家', {}), null, `${why} 时不该进闸`);
    assert.strictEqual(c.r.recallDaily.noMatch, 1);
  }
});

test('关系扩展吃独立的联想席，不吃主召回名额', async () => {
  const { r, sb } = kit();
  sb.__data.settings = { rows: [SETTINGS({ attention_k: 1, attention_assoc_seats: 2 })] };
  sb.__data.memory_topics = { rows: [
    T('打雷', { importance: 0.8 }),
    T('怕雷声', { importance: 0.6, kind: 'feel' }),
    T('雨夜好眠', { importance: 0.9 }),
  ] };
  sb.__data.memory_relations = { rows: [
    { source_topic: '打雷', target_topic: '怕雷声', rel_type: '导致', note: '' },
    { source_topic: '怕雷声', target_topic: '雨夜好眠', rel_type: '解释', note: 'x' },
  ] };
  const got = await r.getAttentionMaterial('S', '昨晚打雷了', {});
  assert.deepStrictEqual(titles(got), ['打雷', '雨夜好眠', '怕雷声'], '主召回 1 席 + 联想 2 席，互不挤占');
  assert.ok(got.text.includes('（经由「怕雷声」：解释）'), 'hop2 要说清「经由谁」');
  assert.ok(got.text.includes('（因为「打雷」：导致）'), 'hop1 要说清「因为谁」');
});

test('声音渲染：同一条记忆（同 topic 同正文）只渲染一次，缓存放两个会话之间共用', async () => {
  const { r, sb, state } = kit();
  sb.__data.settings = { rows: [SETTINGS()] };
  sb.__data.memory_topics = { rows: [T('八音盒', { importance: 0.9, content: '同一段正文' })] };
  const first = await r.getAttentionMaterial('S1', '八音盒', {});
  const second = await r.getAttentionMaterial('S2', '八音盒', {});
  assert.strictEqual(state.deepseek.length, 1, '第二次该命中 voiceCache，不该再打模型');
  assert.strictEqual(first.text, second.text, '同一条记忆每次浮出的声音要一致');
});

test('声音渲染失败降级原文，不阻塞对话（它是展示层，不是核心链路）', async () => {
  const { r, sb, state } = kit();
  sb.__data.settings = { rows: [SETTINGS()] };
  sb.__data.memory_topics = { rows: [T('八音盒', { importance: 0.9, content: '中性正文' })] };
  state.mode = 'throw';
  const got = await r.getAttentionMaterial('S', '八音盒', {});
  assert.ok(got.text.includes('「中性正文」'), '渲染炸了要退回中性原文');
});

test('配置解析：整数列给 0 会被收下，小数/负数/超范围的退回默认；一个列不存在 = 整组退回默认', async () => {
  const { r, sb, state } = kit();
  sb.__data.settings = { rows: [SETTINGS({ attention_k: 0, attention_budget_chars: 1.5, attention_recent_seats: -1 })] };
  const cfg = await r.getAttentionConfig();
  assert.strictEqual(cfg.k, 0, 'Number.isInteger(0) 为真 —— 0 是**合法**配置，不是缺省');
  assert.strictEqual(cfg.budget_chars, 700, '小数不是整数 → 退回默认');
  assert.strictEqual(cfg.recent_seats, 3, '负数不满足 >=0 → 退回默认');

  // PostgREST 只要有一个列不存在就整条查询报错 → 该组**全部**退回硬编码默认（09-09 实锤的静默失效）
  const b = kit();
  b.sb.__data.settings = { error: 'column attention_k does not exist' };
  assert.strictEqual((await b.r.getAttentionConfig()).k, 2, '报错时整组退回默认');
  assert.deepStrictEqual(b.state.warns, ['attention'], '降级必须出声，否则「没生效」和「本来就是默认」分不清');
});

test('世界书：exact 优先于 contains，keywords 为空/null 不算错', async () => {
  const { r, sb } = kit();
  sb.__data.world_entries = { rows: [W('猫', ['猫', '猫粮'], 'remind'), W('空的', null, 'know')] };
  const exact = await r.retrieveWorld('猫 和 猫粮');
  assert.strictEqual(exact.length, 1);
  assert.strictEqual(exact[0]._hit, 'exact', '「猫」两侧是空格 → 独立词 → 奖励档');
  const contains = await r.retrieveWorld('买了猫粮');
  assert.strictEqual(contains[0]._hit, 'contains', '「猫粮」前贴着汉字 → 只算子串包含');
});

test('召回可见性：记忆表查询失败要当场喊出来，别静默全灭', async () => {
  const { r, sb, state, capture, release } = kit();
  sb.__data.settings = { rows: [SETTINGS()] };
  sb.__data.memory_topics = { error: 'relation "memory_topics" does not exist' };
  capture();
  try {
    assert.strictEqual(await r.getAttentionMaterial('S', '你好', {}), null);
  } finally { release(); }
  assert.strictEqual(r.recallDaily.memoryError, 1);
  assert.ok(state.logs.some((l) => l.startsWith('err') && l.includes('记忆召回可能静默全灭')),
    'memory_error 是静默缺陷，要即时告警（10 分钟限一次防刷屏）');
});
