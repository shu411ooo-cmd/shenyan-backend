// ===== lib/memory/link-relations.js 单元测试（node:test）=====
//
// 钉的是 2026-09-12 把「连边」接进写入链时的纪律：
//   ① 孤儿边不入库 —— 主题名必须精确在候选清单里（旧脚本不验名字，
//      LLM 编出来的主题会变成永远打不着的边）。
//   ② 宁缺毋滥 —— 自环 / 类型外 / 已存在的边一律跳过。
//   ③ 节流 —— 30 分钟一轮，占座式，失败也不连环重试。
//   ④ fail-open —— 读库炸了、LLM 没产出，都只留日志，绝不抛给写入主链。

const { test } = require('node:test');
const assert = require('node:assert');

const { makeFakeSb } = require('../scripts/audit/testkit.cjs');
const { linkMemoryRelations, createAutoLinker, RELATION_TYPES } = require('../lib/memory/link-relations.js');

const TOPICS = [
  { topic: '打雷那晚', last_content: '她怕打雷', grounding: '实', importance: 0.8 },
  { topic: '躲进怀里', last_content: '那晚她躲进他怀里', grounding: '实', importance: 0.7 },
  { topic: '第一次做Neverland', last_content: '第一次做 Neverland', grounding: '实', importance: 0.6 },
];

function kit({ relationsRows = [], llmRet = null } = {}) {
  const sb = makeFakeSb();
  sb.__data.memory_topics = { rows: TOPICS.slice() };
  sb.__data.memory_relations = { rows: relationsRows.slice() };
  const logs = [];
  const log = {
    log: (...a) => logs.push('log ' + a.join(' ')),
    warn: (...a) => logs.push('warn ' + a.join(' ')),
    error: (...a) => logs.push('err ' + a.join(' ')),
  };
  const llmCalls = [];
  const callDeepSeekJson = async (sys, usr, tag) => { llmCalls.push(tag); return llmRet; };
  return { sb, logs, log, llmCalls, callDeepSeekJson };
}

test('孤儿边/自环/类型外/已存在的边全部跳过，只有合法新边入库', async () => {
  const k = kit({
    relationsRows: [{ source_topic: '打雷那晚', target_topic: '躲进怀里', rel_type: '触发' }],
    llmRet: {
      relations: [
        { source: '第一次做Neverland', target: '躲进怀里', type: '导致', note: '做Neverland那阵开始设计躲进怀里的场景' },
        { source: '清单里没有的主题', target: '躲进怀里', type: '触发', note: '孤儿边' },
        { source: '打雷那晚', target: '打雷那晚', type: '触发', note: '自环' },
        { source: '打雷那晚', target: '躲进怀里', type: '触发', note: '已存在' },
        { source: '打雷那晚', target: '躲进怀里', type: '暗恋', note: '类型外' },
      ],
    },
  });
  const r = await linkMemoryRelations({ supabase: k.sb, callDeepSeekJson: k.callDeepSeekJson, log: k.log });
  assert.strictEqual(r.ran, true);
  assert.strictEqual(r.created, 1, '只有一条该活下来');
  assert.strictEqual(r.skipped, 4);
  const rows = k.sb.__data.memory_relations.rows;
  assert.strictEqual(rows.length, 2);
  assert.deepStrictEqual(
    { s: rows[1].source_topic, t: rows[1].target_topic, ty: rows[1].rel_type },
    { s: '第一次做Neverland', t: '躲进怀里', ty: '导致' },
  );
});

test('主题太少（<3）连 LLM 都不调', async () => {
  const k = kit({});
  k.sb.__data.memory_topics = { rows: TOPICS.slice(0, 2) };
  const r = await linkMemoryRelations({ supabase: k.sb, callDeepSeekJson: k.callDeepSeekJson, log: k.log });
  assert.deepStrictEqual(r, { ran: false, reason: 'topics<3' });
  assert.deepStrictEqual(k.llmCalls, [], '候选池都不够，别花这次调用的钱');
});

test('LLM 没产出 = 这一轮不跑，不报错', async () => {
  const k = kit({ llmRet: null });
  const r = await linkMemoryRelations({ supabase: k.sb, callDeepSeekJson: k.callDeepSeekJson, log: k.log });
  assert.deepStrictEqual(r, { ran: false, reason: 'llm-null' });
});

test('节流：30 分钟内第二次直接 throttled（占座式）', async () => {
  const k = kit({ llmRet: { relations: [] } });
  const link = createAutoLinker({ supabase: k.sb, callDeepSeekJson: k.callDeepSeekJson, log: k.log });
  const first = await link();
  assert.strictEqual(first.ran, true, '第一次该真的跑');
  const second = await link();
  assert.deepStrictEqual(second, { ran: false, reason: 'throttled' });
  assert.strictEqual(k.llmCalls.length, 1, '第二次不许再调 LLM');
});

test('fail-open：读库炸了只留日志，不抛给写入主链', async () => {
  const k = kit({});
  k.sb.__throw('db down', 'memory_topics');
  const link = createAutoLinker({ supabase: k.sb, callDeepSeekJson: k.callDeepSeekJson, log: k.log });
  const r = await link(); // 不许 throw
  assert.strictEqual(r.ran, false);
  assert.match(k.logs.join('\n'), /自动连边失败|读 memory_topics 失败/);
});

test('MEMORY_AUTOLINK=off 整体关停（省钱开关）', async () => {
  const k = kit({});
  process.env.MEMORY_AUTOLINK = 'off';
  try {
    const link = createAutoLinker({ supabase: k.sb, callDeepSeekJson: k.callDeepSeekJson, log: k.log });
    assert.deepStrictEqual(await link(), { ran: false, reason: 'disabled' });
    assert.deepStrictEqual(k.llmCalls, []);
  } finally {
    delete process.env.MEMORY_AUTOLINK;
  }
});

test('RELATION_TYPES 七类一字不动（prompt 和校验共用这份词表）', () => {
  assert.deepStrictEqual(RELATION_TYPES, ['触发', '导致', '贡献', '改善', '解释', '更新', '同类']);
});
