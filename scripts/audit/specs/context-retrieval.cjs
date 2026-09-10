/* 分区第 3 步 · lib/context/retrieval.js 的行为基线 spec
   同一份 spec 跑两个来源，输出必须逐字节一致：
     node scripts/audit/baseline-dump.cjs --spec scripts/audit/specs/context-retrieval.cjs --rev 2b9c8c5 --out test/fixtures/context-retrieval.baseline.json
     node scripts/audit/baseline-dump.cjs --spec scripts/audit/specs/context-retrieval.cjs --module lib/context/retrieval.js --compare test/fixtures/context-retrieval.baseline.json

   检索层和上一片（纯选择器）不是一回事：它的行为**一半在返回值里、一半在 IO 调用序列里**。
   所以这里的基线不是「几个函数的输出」，而是每一组调用回一个四元组：
     value     返回值（或 null）
     io        假 supabase 记录的查询序列（表名/方法/参数，含 select 的列清单）
     warns     warnConfigFallback 被调用的次数与原因（配置静默降级的唯一出口）
     deepseek  voiceify 真的调了几次 DeepSeek —— 这是 voiceCache 唯一能看见的地方
     logs      console.warn/error 的输出（关系扩展失败、世界书失败、🚨 记忆全灭）
   任何一项变了都算行为变了。

   ⚠️ 时间相关：向量里的 updated_at / created_at 全部写成「相对现在的 N 天前」（day(n)），
      这样搬到任何一天跑都成立。排序靠 importance 拉开距离，毫秒漂移翻不了序。 */

const ROOT = require('path').resolve(__dirname, '..', '..', '..');
const { sha256 } = require(ROOT + '/lib/cache-control.js');
const select = require(ROOT + '/lib/context/select.js');
const { makeFakeSb, FROZEN, FrozenDate, RealDate, day, hash, T, W, SETTINGS } = require('../testkit.cjs');

const N0 = FROZEN;
const sb = makeFakeSb();
const S = { residue: null, warns: [], deepseek: [], deepseekMode: 'ok' };

const DEPS = {
  supabase: sb,
  // 配置静默降级的唯一出口：只记「哪一组 + 为什么」，不打印
  warnConfigFallback: (group, err) => S.warns.push(`${group}:${err && err.message ? err.message : (err ? String(err) : 'no-row')}`),
  // voiceify 的模型调用。S.deepseek 的长度 = 真的打了几次模型（voiceCache 唯一的观测口）
  callDeepSeekJson: async (contract, plain) => {
    S.deepseek.push(String(plain).slice(0, 24));
    if (S.deepseekMode === 'throw') throw new Error('deepseek 503');
    if (S.deepseekMode === 'empty') return { text: '   ' };
    return { text: `V[${String(plain).slice(0, 12)}]` };
  },
  getLatestResidue: async () => S.residue,
  ageResidue: (r) => ({ concern: r && typeof r.concern === 'number' ? r.concern : 0 }),
  // 真的 memoryMdLabel 依赖当前时间，这里换成「距今 D 天」的稳定写法
  memoryMdLabel: (iso) => `D${Math.round((N0 - new RealDate(iso).getTime()) / 86400000)}`,
  sha256,
  // rev 模式下这条盖掉 harness 沙箱里的真 Date（deps 是最后展开的）
  Date: FrozenDate,
  // rev 模式下这几个是 server.js 里的裸符号；module 模式下由 retrieval.js 自己 require。
  // 两边给同一份，保证比的是同一件事。
  topicHits: select.topicHits,
  extractNgrams: select.extractNgrams,
  isExactWord: select.isExactWord,
  RELATION_HOP1_WEIGHT: select.RELATION_HOP1_WEIGHT,
  RELATION_HOP2_WEIGHT: select.RELATION_HOP2_WEIGHT,
};

/* ───────────────── 跑一组调用 ───────────────── */
let LOGS = [];
async function runCase(setup, fn) {
  sb.__clear();
  S.warns.length = 0; S.deepseek.length = 0; S.residue = null; S.deepseekMode = 'ok';
  LOGS = [];
  const rl = console.log, rw = console.warn, re = console.error, rd = global.Date;
  console.log = (...a) => LOGS.push('log ' + a.join(' '));
  console.warn = (...a) => LOGS.push('warn ' + a.join(' '));
  console.error = (...a) => LOGS.push('err ' + a.join(' '));
  global.Date = FrozenDate; // module 模式（模块里读的是全局 Date）；rev 模式那份走 deps.Date
  let value;
  try { if (setup) setup(); value = await fn(); }
  finally { console.log = rl; console.warn = rw; console.error = re; global.Date = rd; }
  return { value, io: sb.__log.map((e) => e.join(' | ')), warns: S.warns.slice(), deepseek: S.deepseek.slice(), logs: LOGS.slice() };
}

const calls = [];
const C = (name, setup, fn) => calls.push({ name, run: (A) => runCase(setup, () => fn(A)) });

const OK = () => { sb.__data.settings = { rows: [SETTINGS()] }; };

/* ═══════════ ① 配置读取 getAttentionConfig ═══════════ */
C('cfg_ok', () => { sb.__data.settings = { rows: [SETTINGS()] }; }, (A) => A.getAttentionConfig());
C('cfg_allNull', () => { sb.__data.settings = { rows: [{ session_id: 'global' }] }; }, (A) => A.getAttentionConfig());
// 每个守卫各喂一个坏值：整数列给 0（Number.isInteger 真，会**收下**）、给小数/字符串/负数的退回默认
C('cfg_badTypes', () => {
  sb.__data.settings = { rows: [SETTINGS({
    attention_k: 0, attention_budget_chars: 1.5, attention_concern_threshold: 'x',
    attention_recent_days: 0, attention_recent_seats: -1, attention_assoc_seats: 1,
    attention_echo_24h_hours: '0', attention_echo_24h_factor: 2,
    attention_echo_72h_hours: null, attention_echo_72h_factor: -1,
  })] };
}, (A) => A.getAttentionConfig());
// PostgREST 有一个列不存在就整条查询报错 → 整组退回硬编码默认（09-09 线上实锤的静默失效）
C('cfg_error', () => { sb.__data.settings = { error: 'column attention_k does not exist' }; }, (A) => A.getAttentionConfig());
C('cfg_noRow', () => { sb.__data.settings = { rows: [] }; }, (A) => A.getAttentionConfig());

/* ═══════════ ② 注意力组装 getAttentionMaterial ═══════════ */
// —— 不跑的三种：开关关掉 / 空消息 ——
C('att_notRun_memoryFalse', OK, (A) => A.getAttentionMaterial('S1', '你好', { memory: false }));
C('att_notRun_emptyMsg', OK, (A) => A.getAttentionMaterial('S1', '', {}));
// —— 池子层的三种失败 ——
C('att_gate_memoryError', () => { OK(); sb.__data.memory_topics = { error: 'relation "memory_topics" does not exist' }; },
  (A) => A.getAttentionMaterial('S-err', '你好', {}));
C('att_gate_emptyPool', () => { OK(); sb.__data.memory_topics = { rows: [] }; },
  (A) => A.getAttentionMaterial('S-pool', '你好', {}));
C('att_gate_noMatch', () => { OK(); sb.__data.memory_topics = { rows: [T('八音盒', { importance: 0.8 })] }; },
  (A) => A.getAttentionMaterial('S-nomatch', '今天天气不错', {}));

// —— 牵挂闸：⚠️ 消息里那个**空格**是整条向量的命门 ——
//    提及闸走的是 msg.includes（原始串），牵挂闸走的是 extractNgrams（去过标点的串）。
//    「关于搬 家」被去掉空格后 n-gram 里有「搬家」，于是牵挂闸中、提及闸不中。
//    没有这个空格，这条向量永远只走提及闸，牵挂闸就是条死路径。
C('att_concern_hit', () => {
  OK();
  sb.__data.memory_topics = { rows: [T('搬家', { importance: 0.7, content: '她想搬到有院子的房子' })] };
  S.residue = { unfinished: '搬家的事还没说完', evidence: ['她提过下周搬'], created_at: day(1), concern: 0.9 };
}, (A) => A.getAttentionMaterial('S-concern', '关于搬 家', {}));
// 牵挂线头没到阈值 → 不进闸
C('att_concern_belowThreshold', () => {
  OK();
  sb.__data.memory_topics = { rows: [T('搬家', { importance: 0.7 })] };
  S.residue = { unfinished: '搬家的事还没说完', evidence: [], created_at: day(1), concern: 0.2 };
}, (A) => A.getAttentionMaterial('S-concern2', '关于搬 家', {}));
// 到了阈值但没有共享词 → 不进闸
C('att_concern_noSharedWord', () => {
  OK();
  sb.__data.memory_topics = { rows: [T('搬家', { importance: 0.7 })] };
  S.residue = { unfinished: '八音盒还没调好', evidence: ['音准不对'], created_at: day(1), concern: 0.9 };
}, (A) => A.getAttentionMaterial('S-concern3', '关于搬 家', {}));
// 残留是空的 → kw 为空集，连共享词都没得比
C('att_concern_emptyKw', () => {
  OK();
  sb.__data.memory_topics = { rows: [T('搬家', { importance: 0.7 })] };
  S.residue = { unfinished: '', evidence: [], created_at: day(1), concern: 0.9 };
}, (A) => A.getAttentionMaterial('S-concern4', '关于搬 家', {}));

// —— 提及闸正常命中 ——
C('att_hit_basic', () => {
  OK();
  sb.__data.memory_topics = { rows: [T('八音盒', { importance: 0.9 }), T('熬夜习惯', { importance: 0.4 })] };
}, (A) => A.getAttentionMaterial('S-hit', '上次说的八音盒，现在做怎么样了？', {}));
// grounding 不在 [实,悬,空] 里 → 兜底成「悬」
C('att_groundingFallback', () => {
  OK();
  sb.__data.memory_topics = { rows: [T('八音盒', { grounding: '错' })] };
}, (A) => A.getAttentionMaterial('S-ground', '八音盒', {}));
// 命中但正文是空的 → 一条都进不去 → budget 闸
C('att_gate_budget_emptyContent', () => {
  OK();
  sb.__data.memory_topics = { rows: [T('八音盒', { content: '' })] };
}, (A) => A.getAttentionMaterial('S-b1', '八音盒', {}));
// 命中但一条就超字数预算 → 同样 budget 闸
C('att_gate_budget_chars', () => {
  sb.__data.settings = { rows: [SETTINGS({ attention_budget_chars: 10 })] };
  sb.__data.memory_topics = { rows: [T('八音盒', { importance: 0.9 })] };
}, (A) => A.getAttentionMaterial('S-b2', '八音盒', {}));

// —— 近 N 天位限：最近的事最多占 recent_seats 位，让位给远期 ——
C('att_recentCap', () => {
  sb.__data.settings = { rows: [SETTINGS({ attention_k: 3, attention_recent_seats: 1 })] };
  sb.__data.memory_topics = { rows: [
    T('搬家', { importance: 0.9, ageDays: 1 }),
    T('搬家计划', { importance: 0.8, ageDays: 2 }),
    T('搬家的事', { importance: 0.7, ageDays: 3 }),
    T('搬家的院子', { importance: 0.6, ageDays: 100 }),
    T('搬家那天', { importance: 0.5, ageDays: 200 }),
  ] };
}, (A) => A.getAttentionMaterial('S-recent', '搬家', {}));

// —— 冷却 + antiEcho：连打 5 次，看「第 1 次注入 → 3 次冷却 → 第 5 次被回声降权后换人」 ——
C('att_cooldown_and_echo', () => {
  sb.__data.settings = { rows: [SETTINGS({ attention_k: 1 })] };
  sb.__data.memory_topics = { rows: [T('八音盒', { importance: 0.6 }), T('八音盒音准', { importance: 0.5 })] };
}, async (A) => {
  const seq = [];
  for (let i = 0; i < 5; i++) seq.push(await A.getAttentionMaterial('S-echo', '八音盒', {}));
  return seq;
});

// —— 关系扩展：主命中后 1~2 hop 邻居吃独立的 assoc_seats 席 ——
C('att_relation', () => {
  OK();
  sb.__data.memory_topics = { rows: [
    T('打雷', { importance: 0.8 }),
    T('怕雷声', { importance: 0.6, kind: 'feel' }),   // feel 桶不声音化 → 不打 DeepSeek
    T('雨夜好眠', { importance: 0.9 }),
  ] };
  sb.__data.memory_relations = { rows: [
    { source_topic: '打雷', target_topic: '怕雷声', rel_type: '导致', note: '' },
    { source_topic: '怕雷声', target_topic: '雨夜好眠', rel_type: '解释', note: 'x' },
  ] };
}, (A) => A.getAttentionMaterial('S-rel', '昨晚打雷了', {}));

// —— 声音渲染：同一条记忆换个会话再浮现，voiceCache 命中 → **不该**再打一次 DeepSeek ——
C('att_voice_cacheHit', () => {
  OK();
  sb.__data.memory_topics = { rows: [T('八音盒', { importance: 0.9, content: '同一段正文' })] };
}, async (A) => {
  const first = await A.getAttentionMaterial('S-v1', '八音盒', {});
  const second = await A.getAttentionMaterial('S-v2', '八音盒', {});
  return { first, second };
});
// 渲染失败降级原文（展示层，不阻塞对话）
C('att_voice_throwFallback', () => {
  OK();
  sb.__data.memory_topics = { rows: [T('八音盒')] };
  S.deepseekMode = 'throw';
}, (A) => A.getAttentionMaterial('S-v3', '八音盒', {}));
// 模型返回的 text 是空白 → 也降级原文
C('att_voice_emptyTextFallback', () => {
  OK();
  sb.__data.memory_topics = { rows: [T('八音盒')] };
  S.deepseekMode = 'empty';
}, (A) => A.getAttentionMaterial('S-v4', '八音盒', {}));

/* ═══════════ ③ 关系扩展 getRelationNeighbors ═══════════ */
const RELS = [
  { source_topic: '打雷', target_topic: '怕雷声', rel_type: '导致', note: '' },
  { source_topic: '怕雷声', target_topic: '雨夜好眠', rel_type: '解释', note: 'x' },
];
C('rel_ok', () => {
  sb.__data.memory_relations = { rows: RELS };
  sb.__data.memory_topics = { rows: [T('怕雷声', { importance: 0.6 }), T('雨夜好眠', { importance: 0.9 })] };
}, (A) => A.getRelationNeighbors(['打雷']));
C('rel_noRels', () => { sb.__data.memory_relations = { rows: [] }; }, (A) => A.getRelationNeighbors(['打雷']));
C('rel_readError', () => { sb.__data.memory_relations = { error: 'boom' }; }, (A) => A.getRelationNeighbors(['打雷']));
C('rel_rowsError', () => {
  sb.__data.memory_relations = { rows: RELS };
  sb.__data.memory_topics = { error: 'boom' };
}, (A) => A.getRelationNeighbors(['打雷']));
// 邻居那条的正文为空 → 被 filter 掉（但它仍然占掉了 hop 名额）
C('rel_filterEmptyContent', () => {
  sb.__data.memory_relations = { rows: RELS };
  sb.__data.memory_topics = { rows: [T('怕雷声', { content: '' }), T('雨夜好眠', { importance: 0.9 })] };
}, (A) => A.getRelationNeighbors(['打雷']));
// 边表里一条都不挨着命中话题 → 候选集为空，第二次查询都不发
C('rel_noCandidates', () => {
  sb.__data.memory_relations = { rows: [{ source_topic: '甲', target_topic: '乙', rel_type: '同类', note: '' }] };
}, (A) => A.getRelationNeighbors(['打雷']));

/* ═══════════ ④ 世界书检索 retrieveWorld ═══════════ */
C('world_exact', () => { sb.__data.world_entries = { rows: [W('八音盒', ['八音盒'], 'know')] }; },
  (A) => A.retrieveWorld('the 八音盒.'));
C('world_contains', () => { sb.__data.world_entries = { rows: [W('八音盒', ['八音盒'], 'know')] }; },
  (A) => A.retrieveWorld('我的八音盒坏了。'));
// 关键词表里 exact 的排在前面 → 一次 exact 就 break，不再降级成 contains
C('world_exactBreaksFirst', () => { sb.__data.world_entries = { rows: [W('猫', ['猫', '猫粮'], 'remind')] }; },
  (A) => A.retrieveWorld('猫 和 猫粮'));
// 大小写：msg 与关键词都 toLowerCase 后再比
C('world_caseInsensitive', () => { sb.__data.world_entries = { rows: [W('GPS', ['GPS'], 'know')] }; },
  (A) => A.retrieveWorld('用 gps 找路'));
// keywords 为 null / 空数组 → 不命中也不算错
C('world_noKeywords', () => {
  sb.__data.world_entries = { rows: [W('空', [], 'setting'), { id: 9, title: 'nullkw', content: 'c', keywords: null, kind: 'know', enabled: true }] };
}, (A) => A.retrieveWorld('随便说点什么'));
C('world_empty', () => { sb.__data.world_entries = { rows: [] }; }, (A) => A.retrieveWorld('八音盒'));
C('world_emptyMsg', () => { sb.__data.world_entries = { rows: [W('八音盒', ['八音盒'], 'know')] }; },
  (A) => A.retrieveWorld(''));
C('world_error', () => { sb.__data.world_entries = { error: 'boom' }; }, (A) => A.retrieveWorld('八音盒'));

/* ═══════════ ⑤ 召回可见性计数器（跑完全部用例后的累计值）═══════════ */
// 这个计数器搬迁前只活在模块态里、唯一出口是那条 📊 [recall] 日志（要跨天才打），
// 基线够不着 —— 所以模块多导出了它。见 lib/context/retrieval.js 文件头。
C('recallDaily', null, (A) => A.recallDaily);

module.exports = {
  // 搬迁前、抽出 lib/context/retrieval.js 之前的最后一个 commit（就是它自己）
  baseRev: '2b9c8c5',
  ranges: [[1956, 2295]],
  expose: ['getAttentionConfig', 'getAttentionMaterial', 'getRelationNeighbors', 'retrieveWorld', 'recallDaily'],
  deps: DEPS,
  // rev 模式交回的是裸符号集，module 模式交回的是工厂函数本身 —— 在这里归一成同一个形状
  adapt: (api) => (typeof api === 'function' ? api(DEPS) : api),
  calls,
};
