// ===== lib/memory/index.js + lib/ui-markers.js 单元测试（node:test）=====
//
// 两层，和前四片同构：
//   ① 「与搬迁前等价」—— 拿搬迁前 HEAD（f7e49da）的真实输出逐字节压住（108 组搬迁向量 + 12 组复查补的分支，
//      后者同样从 f7e49da 录，2026-09-11 Opus 复查 §3）。
//      每组比五样：返回值 / 落库后的表快照 / 假 supabase 的查询序列 /
//      **Ombre 与 DeepSeek 的调用参数** / 日志与告警与降级标记。
//      ⚠️ 基线**不要**在重构里更新。它红了 = 你改了行为，先解释清楚再谈更新。
//   ② 「语义断言」—— 把基线说不清「为什么」的行为用白话钉死。
//
// ⚠️ 这一片曾有一条**真发现**（2026-09-11 修复，78409d5 转正）：
//    getAllMemoryTopics 只解构 `data`，PostgREST 的 `{error}` 响应会走到 `data || []`，
//    变成 **[]** 而不是注释声称的 null —— fail-closed 那道闸对**最常见的失败形态**不响。
//    修复后两条路（真抛 / error 字段）都回 null、都挡写回，语义断言已改成钉「修复后行为」，
//    基线里 wm_topicsErrorFieldProceeds / gm_topicsErrorFieldProceeds 两组向量也随 78409d5 重录。

const { test } = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const path = require('node:path');

const { makeFakeSb, FrozenDate, fmtIo } = require('../scripts/audit/testkit.cjs');
const { sha256 } = require('../lib/cache-control.js');

const createMemory = require('../lib/memory/index.js');
const { stripUiMarkers } = require('../lib/ui-markers.js');

/* ───────── 归一：把 Map/Set/NaN/undefined 都变成可 deepStrictEqual 的形状 ───────── */
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

const fixture = (n) => JSON.parse(fs.readFileSync(path.join(__dirname, 'fixtures', n), 'utf8'));

/* ═════════════ ① 与搬迁前逐字节等价 ═════════════ */

test('等价搬迁：记忆编辑者全部向量（返回值 + 表快照 + 查询序列 + Ombre/DeepSeek 调用参数 + 日志告警）逐字节一致', async () => {
  const SPEC = require('../scripts/audit/specs/memory-write.cjs');
  // ⚠️ 必须走 SPEC.adapt：它按 server.js 的接法把工厂拼起来（stripUiMarkers 从 lib/ui-markers.js 取，
  //    因为它没跟着这一片走）—— 拼错本身就算搬迁出错，基线要能抓住。
  const A = SPEC.adapt(createMemory);
  const out = {};
  for (const c of SPEC.calls) out[c.name] = norm(await c.run(A));
  assert.deepStrictEqual(out, fixture('memory-write.baseline.json'),
    '记忆编辑者的输出与搬迁前不同 —— 搬迁必须是行为等价的。\n' +
    '如果你**有意**改了行为，请先在交接文档里写清楚为什么，再更新基线。');
});

test('搬走的 22 个函数定义，server.js 里不该再有一份（边界没被搬回去）', () => {
  const src = fs.readFileSync(path.join(__dirname, '..', 'server.js'), 'utf8').replace(/\r/g, '');
  const namesUsed = Object.keys(createMemory({ supabase: {}, warnConfigFallback: () => {} })).filter((n) => n !== 'scheduleMemoryWrite');
  assert.ok(namesUsed.length >= 20, `工厂交回来的名字只有 ${namesUsed.length} 个，比预期少 —— 有函数没搬干净？`);
  for (const n of namesUsed) {
    assert.doesNotMatch(src, new RegExp(`^(?:async )?function ${n}\\b`, 'm'),
      `server.js 里又出现了一份 ${n} 的定义。它属于 lib/memory/index.js —— 别在这里再养一份。`);
  }
});

/* ═════════════ ② 语义断言 ═════════════ */

/* ── 工具箱：每个用例一副干净的库 + 一份干净的模块态 ── */
function kit() {
  const sb = makeFakeSb();
  const S = { ombre: [], ds: [], warns: [], degraded: [], logs: [] };
  const OM = { resp: '新建→366aa7012c76', throwTag: null };
  const DS = { ret: null };
  const F = { impl: null };
  const mem = createMemory({
    supabase: sb,
    warnConfigFallback: (g, e) => S.warns.push(`${g}:${e && e.message ? e.message : (e ? String(e) : 'no-row')}`),
    markMemoryDegraded: (r) => S.degraded.push(r),
    sha256,
    callOmbreTool: async (tool, args) => {
      S.ombre.push([tool, args]);
      if (OM.throwTag && args && args.tags === OM.throwTag) throw new Error('ombre down');
      return OM.resp;
    },
    callDeepSeekJson: async (sys, usr, tag) => { S.ds.push([tag, usr]); return DS.ret; },
  });
  const rl = console.log, rw = console.warn, re = console.error, rd = global.Date, rf = globalThis.fetch;
  const hadKey = Object.prototype.hasOwnProperty.call(process.env, 'DEEPSEEK_API_KEY');
  const oldKey = process.env.DEEPSEEK_API_KEY;
  const capture = () => {
    S.logs.length = 0;
    console.log = (...a) => S.logs.push('log ' + a.join(' '));
    console.warn = (...a) => S.logs.push('warn ' + a.join(' '));
    console.error = (...a) => S.logs.push('err ' + a.join(' '));
    global.Date = FrozenDate;
    globalThis.fetch = (...a) => F.impl(...a);
    process.env.DEEPSEEK_API_KEY = 'test-key-not-real';
  };
  const release = () => {
    console.log = rl; console.warn = rw; console.error = re; global.Date = rd; globalThis.fetch = rf;
    if (hadKey) process.env.DEEPSEEK_API_KEY = oldKey; else delete process.env.DEEPSEEK_API_KEY;
  };
  /** 清干净再跑一段（返回 console/Date 抓到的日志一起交回去） */
  const run = async (setup, fn) => {
    sb.__clear(); sb.__throw(null);
    S.ombre.length = 0; S.ds.length = 0; S.warns.length = 0; S.degraded.length = 0; S.logs.length = 0;
    OM.resp = '新建→366aa7012c76'; OM.throwTag = null; DS.ret = null; F.impl = null;
    capture();
    let value, err = null;
    try { if (setup) setup(); value = await fn(); } catch (e) { err = e; } finally { release(); }
    return {
      value, err, io: fmtIo(sb.__log), ombre: S.ombre.slice(), ds: S.ds.slice(),
      logs: S.logs.slice(), warns: S.warns.slice(), degraded: S.degraded.slice(),
      rows: JSON.parse(JSON.stringify((sb.__data.memory_topics && sb.__data.memory_topics.rows) || [])),
    };
  };
  return { sb, mem, OM, DS, F, run, S };
}

const ROW = (o) => Object.assign({
  id: 1, topic: '猫', source: 'chat', kind: 'memory', grounding: '实',
  last_content: '旧正文', snapshot_hash: 'h', key_facts: null,
  evidence: '她说过', importance: 0.5, bucket_id: 'aaaaaaaaaaaa',
  song_key: null, event_time: null, conversation_time: null,
}, o);
const ITEM = (o) => Object.assign({
  topic: '猫', update_topic: null, song_key: null, content: '她养了一只叫团子的猫',
  grounding: '实', evidence: '她说团子', importance: 0.6,
  event_time: null, kind: 'memory', key_facts: null,
}, o);
const dsRaw = (s) => async () => ({ ok: true, json: async () => ({ choices: [{ message: { content: s } }] }) });
const dsReply = (o) => async () => ({ ok: true, json: async () => ({ choices: [{ message: { content: JSON.stringify(o) } }] }) });
const dsSeq = (...fs2) => { let i = 0; return () => fs2[Math.min(i++, fs2.length - 1)](); };

/* ── fail-closed：真抛和 error 字段两条路都挡得住（2026-09-11 修复，78409d5 转正） ── */
test('fail-closed：主题表真抛 / 回 error 字段，两条路都挡写回', async () => {
  const k = kit();

  // (a) 真抛 → 该挡：既不 hold，也不 upsert，还要留两个痕
  const thrown = await k.run(() => { k.sb.__throw('memory_topics read failed'); },
    () => k.mem.writeMemoryItems([ITEM()]));
  assert.deepStrictEqual(thrown.ombre, [], '真抛时不该去 Ombre hold 新桶');
  assert.deepStrictEqual(thrown.degraded, ['memory_topics_read_failed'], '真抛必须打 memory_degraded 标记');
  assert.match(thrown.logs.join('\n'), /记忆写回跳过：读取现有主题失败/);

  // (b) 回 error 字段 → 同样挡：修复前这条路会 hold 出新桶（「重复建桶」的成因），
  //    78409d5 起 getAllMemoryTopics 对 error 字段也回 null，闸门两条路都响
  const errored = await k.run(() => { k.sb.__data.memory_topics = { error: 'permission denied' }; },
    () => k.mem.writeMemoryItems([ITEM({ topic: '本该被挡住的新桶' })]));
  assert.deepStrictEqual(errored.ombre, [], 'error 字段也必须被 fail-closed 挡住');
  assert.deepStrictEqual(errored.degraded, ['memory_topics_read_failed'], 'error 字段同样要打降级标记');

  // 两条路的返回值一致都是 null（修复前 error 字段漏成 []，闸门（=== null）就是这么漏的）
  assert.strictEqual(await k.run(() => { k.sb.__data.memory_topics = { error: 'permission denied' }; },
    () => k.mem.getAllMemoryTopics()).then((r) => r.value), null);
});

test('hold 的 tags 必须是 string、trace 的必填是 bucket_id —— 传错的形状在返回值上看不出来', async () => {
  const k = kit();
  await k.run(null, () => k.mem.holdNewMemory({ topic: '猫', grounding: '实' }, '她养了猫'));
  assert.strictEqual(typeof k.S.ombre[0][1].tags, 'string',
    'Ombre hold 的 tags 传数组会 validation error（历史上 hold 因此从未成功过）—— 它必须是字符串。');
  assert.strictEqual(k.S.ombre[0][1].tags, '猫');
  assert.ok(!('content' in k.S.ombre[0][1]) === false, 'hold 要带 content');

  const k2 = kit();
  await k2.run(null, () => k2.mem.traceUpdateMemory('aaaaaaaaaaaa', '旧', '新'));
  assert.strictEqual(k2.S.ombre[0][0], 'trace');
  assert.strictEqual(k2.S.ombre[0][1].bucket_id, 'aaaaaaaaaaaa');
  assert.ok(!('id' in k2.S.ombre[0][1]), 'trace 的必填是 bucket_id 不是 id（传 id 是 validation error）');
});

test('memory_topics 的唯一键是 (source, topic)：source 缺省必须兜成 chat，否则同一主题会开出两行', async () => {
  const k = kit();
  const r = await k.run(() => { k.sb.__data.memory_topics = { rows: [ROW({ id: 1, topic: '猫', source: 'chat' })] }; },
    () => k.mem.upsertMemoryTopic({ topic: '猫', last_content: '不带 source' }));
  assert.strictEqual(r.rows.length, 1, '没兜 source 就会被当成另一行 —— 唯一键 (source,topic) 就失效了');
  assert.strictEqual(r.rows[0].source, 'chat');
  assert.match(r.io.join('\n'), /"onConflict":"source,topic"/);
});

test('normalizeMemoryWrite 的三条过滤各自独立：空 grounding / 缺 topic / content 不足 4 字', async () => {
  const k = kit();
  const v = (await k.run(null, () => k.mem.normalizeMemoryWrite({
    should_write: true,
    items: [
      { topic: '空证据', content: '这条没有根据', grounding: '空' },
      { topic: '', content: '没有主题但够长', grounding: '实' },
      { topic: '太短', content: '嗯', grounding: '实' },
      { topic: '好', content: '她是杭州人', grounding: '悬' },
    ],
  }))).value;
  assert.deepStrictEqual(v.items.map((i) => i.topic), ['好'], '只有最后一条该活下来');
  assert.strictEqual(v.should_write, true);

  // grounding 没有「空」这个选项 —— 没根据就根本不该写这条
  const none = (await k.run(null, () => k.mem.normalizeMemoryWrite({
    should_write: true, items: [{ topic: 'x', content: '这条没根据', grounding: '空' }],
  }))).value;
  assert.deepStrictEqual(none, { should_write: false, items: [] });

  // should_write 传字符串 'true' 不算数（必须是布尔 true）
  const strTrue = (await k.run(null, () => k.mem.normalizeMemoryWrite({
    should_write: 'true', items: [{ topic: '猫', content: '她养了猫', grounding: '实' }],
  }))).value;
  assert.strictEqual(strTrue.should_write, false);
});

test('importance 的钳位有个反直觉处：0 会被 `|| 0.5` 顶成 0.5，负数才是 0', async () => {
  const k = kit();
  const v = (await k.run(null, () => k.mem.normalizeMemoryWrite({
    should_write: true,
    items: [
      { topic: 'a', content: '她是杭州人', grounding: '实', importance: 0 },
      { topic: 'b', content: '她不吃香菜', grounding: '实', importance: -3 },
      { topic: 'c', content: '她养了一只猫', grounding: '实', importance: 9 },
      { topic: 'd', content: '她月底搬家', grounding: '实', importance: 'abc' },
    ],
  }))).value;
  assert.deepStrictEqual(v.items.map((i) => i.importance), [0.5, 0, 1, 0.5],
    'parseFloat(x) || 0.5 会把**合法的 0** 当缺省顶掉。这是个坑，但它是搬迁前的行为，基线照压。');
});

test('feel 桶关键事实只增不减，且模型把已作废的标回 active 会被纠回去', async () => {
  const k = kit();
  const r = await k.run(() => {
    k.DS.ret = { content: '更新后的正文', key_facts: [{ text: '新事实', status: 'active' }, { text: '作废事实', status: 'active' }] };
  }, () => k.mem.refineFeelContent(
    ROW({ kind: 'feel', last_content: '旧', key_facts: [{ text: '旧事实', status: 'active' }, { text: '作废事实', status: 'superseded', superseded_at: '2026-08-01T00:00:00.000Z' }] }),
    ITEM({ kind: 'feel' }), '窗口'));
  const v = r.value;
  assert.strictEqual(r.err, null);
  const byText = Object.fromEntries(v.key_facts.map((x) => [x.text, x.status]));
  assert.strictEqual(byText['旧事实'], 'active', '模型漏掉的旧事实要按原状态保留（只增不减）');
  assert.strictEqual(byText['作废事实'], 'superseded', '作废的证据可以废止、不能撕掉 —— 模型标回 active 要纠正');
  assert.strictEqual(byText['新事实'], 'active');
});

test('判官说 false 就真跳过：连主题表都不读（判官的全部价值就在这一次省掉的调用）', async () => {
  const k = kit();
  const r = await k.run(() => {
    k.F.impl = dsRaw('false');
    k.sb.__data.messages = { rows: [1, 2, 3, 4].map((i) => ({ role: i % 2 ? 'assistant' : 'user', content: `她说了很长的一段话${i}`, created_at: '2026-09-10T00:00:00.000Z', session_id: 'g1', visible: true })) };
  }, () => k.mem.generateMemoryWriteIfNeeded('g1'));
  assert.ok(!r.io.some((l) => l.startsWith('from:memory_topics')),
    '判官说了不值得，就别再去读主题表 —— 那正是判官要省掉的开销。');
  assert.match(r.io.join('\n'), /from:settings/);
});

test('判官失败/解析不出 → fail-open 继续走主分类（安全网不丢）', async () => {
  const k = kit();
  const r = await k.run(() => {
    k.F.impl = dsSeq(dsRaw('嗯……'), dsReply({ should_write: false, items: [] }));
    k.sb.__data.memory_topics = { rows: [] };
    k.sb.__data.messages = { rows: [1, 2, 3, 4].map((i) => ({ role: i % 2 ? 'assistant' : 'user', content: `她说了很长的一段话${i}`, created_at: '2026-09-10T00:00:00.000Z', session_id: 'g2', visible: true })) };
  }, () => k.mem.generateMemoryWriteIfNeeded('g2'));
  assert.match(r.io.join('\n'), /from:memory_topics/, '判官判不出来时必须往下走，不能当作「不值得」');
});

test('同一扇窗只分类一次（窗口哈希去重）；用户话不足 12 字连分类都不跑', async () => {
  const k = kit();
  const msgs = [1, 2, 3, 4].map((i) => ({ role: i % 2 ? 'assistant' : 'user', content: `她说了很长的一段话${i}`, created_at: '2026-09-10T00:00:00.000Z', session_id: 'g3', visible: true }));
  const r = await k.run(() => {
    // 判官放行（说 true），主分类说不写 —— 这样才能看出「第二遍有没有再去读主题表」
    k.F.impl = dsSeq(dsRaw('true'), dsReply({ should_write: false, items: [] }));
    k.sb.__data.memory_topics = { rows: [] };
    k.sb.__data.messages = { rows: msgs.slice() };
  }, async () => { await k.mem.generateMemoryWriteIfNeeded('g3'); await k.mem.generateMemoryWriteIfNeeded('g3'); });
  const topicsReads = r.io.filter((l) => l === 'from:memory_topics').length;
  assert.strictEqual(topicsReads, 1, '同一扇窗跑第二遍必须被 windowId 挡在主题表之前');

  const k2 = kit();
  const r2 = await k2.run(() => {
    k2.F.impl = dsReply({ should_write: true, items: [] });
    k2.sb.__data.messages = { rows: [
      { role: 'user', content: '嗯', created_at: '2026-09-10T00:00:00.000Z', session_id: 'g4', visible: true },
      { role: 'assistant', content: '在的', created_at: '2026-09-10T00:00:00.000Z', session_id: 'g4', visible: true },
    ] };
  }, () => k2.mem.generateMemoryWriteIfNeeded('g4'));
  assert.ok(!r2.io.some((l) => l.startsWith('from:settings')), '用户话太少时连判官都不该调');
});

test('没有 item 就一个查询都不发；单条 item 抛异常不许带塌整批', async () => {
  const k = kit();
  const empty = await k.run(null, () => k.mem.writeMemoryItems([]));
  assert.deepStrictEqual(empty.io, [], '空数组应当原地返回，一次库都不碰');

  const k2 = kit();
  const r = await k2.run(() => {
    k2.sb.__data.memory_topics = { rows: [] };
    k2.OM.throwTag = '会炸的';
  }, () => k2.mem.writeMemoryItems([ITEM({ topic: '会炸的' }), ITEM({ topic: '搬', content: '她月底搬去上海' })], '', '窗口'));
  assert.match(r.logs.join('\n'), /💥 记忆写入「会炸的」异常/);
  assert.strictEqual(r.rows.filter((x) => x.topic === '搬').length, 1, '前一条炸了，后一条要照写');
});

test('零变化跳过：正文和关键事实都没变时，一次 Ombre 都不该调', async () => {
  const k = kit();
  const r = await k.run(() => {
    k.sb.__data.memory_topics = { rows: [ROW({ topic: '猫', last_content: '她养了一只叫团子的猫', key_facts: null })] };
  }, () => k.mem.writeMemoryItems([ITEM({ topic: '猫', content: '她养了一只叫团子的猫', key_facts: null })]));
  assert.deepStrictEqual(r.ombre, [], '没变就不许动 Ombre —— 这是差分写回最省的那一刀');
  assert.ok(!r.io.some((l) => l.includes('upsert')), '本地快照也不必写');
});

test('stripUiMarkers 剥的是前端渲染语法的纸卡，不是她说的话', async () => {
  assert.strictEqual(stripUiMarkers('她: 今天好累'), '她: 今天好累');
  assert.strictEqual(stripUiMarkers('她说 [[ask]]选项一\n选项二[[/ask]] 然后沉默了'), '她说 然后沉默了');
  assert.match(stripUiMarkers('好 [[event 2026-09-12 看展]] 记下了'), /^好\s+记下了$/);
  assert.strictEqual(stripUiMarkers(null), '');
  assert.strictEqual(stripUiMarkers('前  [[ask]]A[[/ask]]   后'), '前 后');
});
