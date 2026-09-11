// ===== lib/context/session.js + lib/context/build.js 单元测试（node:test）=====
//
// 两层，和前两片同构：
//   ① 「与搬迁前等价」—— 拿搬迁前 HEAD 的真实输出逐字节压住（两条基线：session 43 组 +
//      build 48 组）。build 那一条比五样：messages 结构 / diagnostics 全套计数 /
//      假 supabase 的查询序列 / 日志 / 注入台账。**IO 密集的代码「返回值一致」证明不了什么。**
//      ⚠️ 基线**不要**在重构里更新。它红了 = 你改了行为，先解释清楚再谈更新。
//   ② 「语义断言」—— 把基线说不清「为什么」的行为用白话钉死：分页 / 锚点 fast path /
//      同轮最多 3 块 + prio 先丢谁 / 保留席不受限 / 唤醒轮不串味 / 裁剪保底 / 天气口子。
//
// ⚠️ 两条基线记的都是**搬迁前**的行为，唯一的有意偏离：build_attention_hit /
//    build_blocks_overflow_drop 两组在搬迁时记的是一次崩溃（`ReferenceError: attention is not defined`，
//    2026-08-30 provenance 改动引入）。2026-09-11 单独一条提交修掉，基线只有这两组跟着变。

const { test } = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const path = require('node:path');

const { makeFakeSb, FROZEN, FrozenDate, day } = require('../scripts/audit/testkit.cjs');

const createSession = require('../lib/context/session.js');
const createBuild = require('../lib/context/build.js');

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

test('等价搬迁：session 那一片 43 组向量（返回值 + 查询序列 + 日志 + 降级告警）与搬迁前逐字节一致', async () => {
  const SPEC = require('../scripts/audit/specs/context-session.cjs');
  const A = SPEC.adapt(createSession);
  const out = {};
  for (const c of SPEC.calls) out[c.name] = norm(await c.run(A));
  assert.deepStrictEqual(out, fixture('context-session.baseline.json'),
    '会话 IO 管子的输出与搬迁前不同 —— 搬迁必须是行为等价的。\n' +
    '如果你**有意**改了行为，请先在交接文档里写清楚为什么，再更新基线。');
});

test('等价搬迁：buildModelContext 47 组向量（messages + diagnostics + 查询序列 + 日志 + 注入台账）逐字节一致', async () => {
  const SPEC = require('../scripts/audit/specs/context-build.cjs');
  // ⚠️ 这里**必须**走 SPEC.adapt：它按 server.js 的接法把 session + build 两个工厂拼起来 ——
  //    拼错顺序（比如忘了把 Sess 摊进去）本身就算搬迁出错，基线要能抓住。
  const A = SPEC.adapt(createBuild);
  const out = {};
  for (const c of SPEC.calls) out[c.name] = norm(await c.run(A));
  assert.deepStrictEqual(out, fixture('context-build.baseline.json'),
    '组装层的输出与搬迁前不同 —— 搬迁必须是行为等价的。\n' +
    '（唯一的有意偏离是 attention 崩溃那两组，2026-09-11 已修，基线已随之更新。）');
});

test('注意力命中不再崩：整轮照常组装，注意力块带着 refs 进注入台账（2026-09-11 修 attention 越作用域）', () => {
  const B = fixture('context-build.baseline.json');
  for (const k of ['build_attention_hit', 'build_blocks_overflow_drop']) {
    assert.strictEqual(B[k].threw, null, `${k} 又抛了：${B[k].threw}`);
    assert.strictEqual(B[k].value.diag.attention_injected, true, `${k} 注意力没注入`);
  }
  const att = B.build_attention_hit.inj.find((x) => x.layer === 'attention');
  assert.ok(att, '命中那组的注入台账里没有 attention 块');
  assert.deepStrictEqual(att.prov.refs.map((r) => r.topicId), [7, 8],
    'provenance 的 refs 丢了 —— 那正是当初读越界变量想拿的东西');
});

/* ═════════════ ② 语义断言 ═════════════ */

/* ── 工具箱：每个用例一副干净的库 + 一份干净的模块态 ── */
function kit() {
  const sb = makeFakeSb();
  const S = {
    residue: null, residueMode: null, pending: { notes: '', ids: [] }, calendar: '', attention: null,
    worlds: [], injections: [], consumed: [], saved: [], warns: [], logs: [],
  };
  const sess = createSession({ supabase: sb, warnConfigFallback: (g, e) => S.warns.push(`${g}:${e && e.message}`) });
  let build;
  const buildKit = (over = {}) => {
    build = createBuild(Object.assign({}, sess, {
      supabase: sb,
      buildStableSystemPrompt: async () => 'STABLE',
      buildTemporalNarrative: ({ resumeGap, nowMs, prevTs, asksTime }) => `⟨time gap=${resumeGap} asks=${asksTime} now=${nowMs} prev=${prevTs}⟩`,
      buildResidueNarrative: (r) => `⟨thread ${r && r.unfinished}⟩`,
      buildModeNote: (r) => ((r && r.convo_mode) ? `⟨mode ${r.convo_mode}⟩` : ''),
      RESOLVED_RETURN_RE: /(修完|修好|搞定|弄完|弄好|完成|做完|办完|解决|处理完|回来了)/,
      buildDeviceNotice: (d) => `⟨device ${JSON.stringify(d)}⟩`,
      calendarModule: { buildCalendarBlock: async () => S.calendar },
      getLatestResidue: async () => S.residue,
      consumeResidueLine: async (id) => { S.consumed.push(id); },
      getLatestResidueMode: async () => S.residueMode,
      loadPendingKeepalive: async () => S.pending,
      getAttentionMaterial: async () => S.attention,
      retrieveWorld: async () => S.worlds,
      logInjection: (x) => { S.injections.push({ tag: x.tag, layer: x.prov && x.prov.layer, prov: x.prov }); },
    }, over));
    return build;
  };
  const rl = console.log, rw = console.warn, re = console.error, rd = global.Date;
  const capture = () => {
    S.logs.length = 0;
    console.log = (...a) => S.logs.push('log ' + a.join(' '));
    console.warn = (...a) => S.logs.push('warn ' + a.join(' '));
    console.error = (...a) => S.logs.push('err ' + a.join(' '));
    global.Date = FrozenDate;
  };
  const release = () => { console.log = rl; console.warn = rw; console.error = re; global.Date = rd; };
  /** 建一副干净的库；返回 session id */
  let seq = 0;
  const world = (o = {}) => {
    const sid = 'T' + (++seq);
    S.residue = o.residue || null;
    S.residueMode = o.residueMode || null;
    S.pending = o.pending || { notes: '', ids: [] };
    S.calendar = o.calendar || '';
    S.attention = o.attention || null;
    S.worlds = o.worlds || [];
    S.injections.length = 0; S.consumed.length = 0; S.saved.length = 0;
    sb.__clear();
    sb.__data.settings = { rows: [Object.assign({ session_id: 'global', frozen_rounds: 10, live_rounds: 15, max_context_tokens: 24000, live_max_tokens: 40000 }, o.cfg || {})] };
    sb.__data.sessions = { rows: [Object.assign({ id: sid, last_time_notice_at: null }, o.sessionRow || {})] };
    const n = (o.turns || 0) * 2;
    sb.__data.messages = { rows: Array.from({ length: n }, (_, i) => ({
      role: i % 2 === 0 ? 'user' : 'assistant',
      content: i === n - 1 && o.lastText != null ? o.lastText : `m${i}`,
      session_id: sid, visible: true,
      created_at: new Date(FROZEN - (n - i) * 60000 - (o.gapMin || 0) * 60000).toISOString(),
    })) };
    sb.__data.summary_segments = { rows: (o.segments || []).map((x) => Object.assign({ session_id: sid }, x)) };
    return sid;
  };
  return { sb, S, sess, buildKit, get build() { return build; }, capture, release, world };
}

test('分页：2500 条历史要分三段 range 拉全（1000 行是 PostgREST 硬上限，不分页会静默截掉最新消息）', async () => {
  const { sb, sess, world } = kit();
  const sid = world({ turns: 0 });
  sb.__data.messages.rows = Array.from({ length: 2500 }, (_, i) => ({
    role: i % 2 === 0 ? 'user' : 'assistant', content: `m${i}`, session_id: sid, visible: true,
    created_at: new Date(FROZEN - (2500 - i) * 1000).toISOString(),
  }));
  const rows = await sess.fetchSessionHistory(sid);
  assert.strictEqual(rows.length, 2500, '条数对不上 = 分页没拉全');
  assert.strictEqual(rows[0].content, 'm0');
  assert.strictEqual(rows[2499].content, 'm2499', '缺最新那条正是「聊天 400」的根因');
  assert.deepStrictEqual(sb.__log.filter((e) => e[0] === 'messages.range'), [
    ['messages.range', 0, 999], ['messages.range', 1000, 1999], ['messages.range', 2000, 2999],
  ]);
});

test('锚点：写过一次之后走进程内 Map，不再回源查库（重启才回源 —— 不然每轮一次 IO）', async () => {
  const { sb, sess } = kit();
  sb.__data.sessions = { rows: [{ id: 'A', live_anchor_turn: 12 }] };
  assert.strictEqual(await sess.loadLiveAnchor('A'), 12);
  const n = sb.__log.length;
  assert.strictEqual(await sess.loadLiveAnchor('A'), 12);
  assert.strictEqual(sb.__log.length - n, 0, '第二次不该再产生任何查询');
});

test('配置降级要出声：settings 读失败 → 退默认值**并且**喊一声（静默降级是 09-03 那次事故的成因）', async () => {
  const { sb, S, sess } = kit();
  sb.__data.settings = { error: 'column live_max_tokens does not exist' };
  assert.deepStrictEqual(await sess.getContextConfig('S'), { frozen_rounds: 10, live_rounds: 15, max_context_tokens: 24000, live_max_tokens: 40000 });
  assert.deepStrictEqual(S.warns, ['context:column live_max_tokens does not exist'], '退了默认却不吭声 = 静默降级又回来了');
});

test('配置守卫：0 是合法值（Number.isInteger(0) 为真），不是「缺省」', async () => {
  const { sb, sess } = kit();
  sb.__data.settings = { rows: [{ session_id: 'global', frozen_rounds: 0, live_rounds: 0, max_context_tokens: 0, live_max_tokens: 0 }] };
  assert.deepStrictEqual(await sess.getContextConfig('S'), { frozen_rounds: 0, live_rounds: 0, max_context_tokens: 0, live_max_tokens: 0 });
});

test('写摘要段：落库成功回 true，失败回 false 并留痕（append-only 水位线靠它推进）', async () => {
  const { sb, S, sess } = kit();
  sb.__data.summary_segments = { rows: [] };
  assert.strictEqual(await sess.insertSummarySegment('S', 1, 5, '第一段', '2026-09-01T00:00:00Z', '2026-09-05T00:00:00Z'), true);
  assert.strictEqual(sb.__data.summary_segments.rows.length, 1);
  assert.strictEqual(sb.__data.summary_segments.rows[0].content, '第一段');
  sb.__data.summary_segments = { error: 'duplicate key value' };
  assert.strictEqual(await sess.insertSummarySegment('S', 1, 5, '重复'), false);
});

/* ── 组装层 ── */

test('同轮上限 3：prio 小的先丢，丢谁写进 🧩 日志（「旧话题搬运工」先让位给「当下」）', async () => {
  const k = kit();
  k.buildKit();
  const sid = k.world({
    turns: 2, lastText: '几点了？', gapMin: 90, calendar: '⟨cal⟩', residueMode: '闲聊',
    residue: { id: 1, unfinished: '搬家', grounding: '实', concern: 0.9, convo_mode: '深入' },
    worlds: [{ id: 2, title: '猫', content: 'X', kind: 'setting', _hit: 'contains' }],
  });
  k.capture();
  try {
    k.build.setWeather({ city: '杭州', line: '晴', at: 'x' });
    const r = await k.build.buildModelContext(sid, { userMessage: '几点了？' });
    const line = k.S.logs.find((l) => l.includes('🧩 [动态注入]'));
    assert.match(line, /blocks=time,weather,calendar /, '留下的该是 prio 最高的三块（5/4/4）');
    assert.match(line, /dropped=residue,world\(1\)/, '丢的该是 prio 最小的 residue(3) 和 world(2)，且按 prio 升序');
    assert.strictEqual(r.messages.filter((m) => m.role === 'user').length <= r.messages.length, true);
  } finally { k.build.setWeather(null); k.release(); }
});

test('保留席（亲密 + remind + 世界书 exact）不进排队表，不受同轮上限 3 约束', async () => {
  const k = kit();
  k.buildKit();
  const sid = k.world({
    turns: 2, gapMin: 90, residueMode: '亲密',
    calendar: '⟨cal⟩', residue: { id: 1, unfinished: '搬家', grounding: '实', concern: 0.9, convo_mode: '深入' },
    worlds: [{ id: 11, title: '怕打雷', content: '打雷时要抱着她', kind: 'remind', _hit: 'exact' }],
  });
  k.capture();
  try {
    const r = await k.build.buildModelContext(sid, { userMessage: '晚上打雷了' });
    assert.ok(JSON.stringify(r.messages).includes('【她定过的一条约定】'), '保留席该在');
    const line = k.S.logs.find((l) => l.includes('🧩 [动态注入]'));
    assert.match(line, /world-seat\(remind\)/, '保留席要出现在日志里，但不占队列');
    assert.ok(k.S.injections.some((x) => x.tag === 'world-seat' && x.prov.expression_eligible === false),
      '保留席也是外来设定 → 必须带 expression_eligible:false');
  } finally { k.release(); }
});

test('唤醒轮（keepalive:true）：不注留言、不跑注意力/世界书 —— 唤醒要自己决定，不被过去的自己带偏', async () => {
  const k = kit();
  k.buildKit();
  const sid = k.world({
    turns: 4,
    pending: { notes: '\n【自由活动记录】不该出现', ids: [33] },
    attention: { text: '不该出现', hits: 1, refs: [] },
    worlds: [{ id: 1, title: '猫', content: '不该出现', kind: 'setting', _hit: 'exact' }],
  });
  k.capture();
  try {
    const r = await k.build.buildModelContext(sid, { keepalive: true, tools: 'off' });
    assert.strictEqual(JSON.stringify(r.messages).includes('不该出现'), false, '三条泄漏路都得堵死');
    assert.deepStrictEqual(r.diagnostics.keepalive_injected_ids, []);
  } finally { k.release(); }
});

test('预算裁剪保底：预算掐到 1 也要留 live 3 轮 + frozen 2 轮（不能把他裁到看不见上一句）', async () => {
  const k = kit();
  k.buildKit();
  const sid = k.world({ turns: 30, cfg: { frozen_rounds: 6, live_rounds: 8, max_context_tokens: 1 }, segments: [{ period_start: 1, period_end: 3, content: 'S' }] });
  k.capture();
  try {
    const r = await k.build.buildModelContext(sid, { userMessage: 'm59', tools: 'off' });
    assert.ok(r.diagnostics.trimmed_turns > 0, '预算 1 必须真的裁了');
    assert.strictEqual(r.diagnostics.live_turns, 3, 'live 保底 3 轮');
    assert.strictEqual(r.diagnostics.frozen_turns, 2, 'frozen 保底 2 轮');
  } finally { k.release(); }
});

test('天气：绑定活在模块闭包里 —— setWeather 之后**同一个** buildModelContext 立刻读得到', async () => {
  const k = kit();
  k.buildKit();
  const sid = k.world({ turns: 0, lastText: '在吗' });
  k.capture();
  try {
    assert.strictEqual(k.build.getWeather(), null);
    k.build.setWeather({ city: '杭州', temp: 22, line: '外面在下小雨', at: 'x' });
    assert.strictEqual(k.build.getWeather().city, '杭州');
    const r = await k.build.buildModelContext(sid, { userMessage: '在吗' });
    assert.ok(JSON.stringify(r.messages).includes('外面在下小雨'), '首句该带上她那边的天');
    // 隔一会儿再看：还是那个天（按值注入会在这里露馅）
    assert.strictEqual(k.build.getWeather().line, '外面在下小雨');
  } finally { k.build.setWeather(null); k.release(); }
});

test('时间心跳：10 分钟前刚报过就不重复报（同一时刻段内不啰嗦）', async () => {
  const k = kit();
  k.buildKit();
  const sid = k.world({ turns: 2, sessionRow: { last_time_notice_at: new Date(FROZEN - 10 * 60000).toISOString() } });
  k.capture();
  try {
    const r = await k.build.buildModelContext(sid, { userMessage: 'm3' });
    // 与基线 build_heartbeat_recent 同一口径：这一轮一个动态块都不该有（连 🧩 日志都不打）
    assert.strictEqual(r.diagnostics.token_breakdown.dynamic, 0, '不该有动态注入块');
    assert.strictEqual(k.S.logs.filter((l) => l.includes('🧩')).length, 0, '一个块都没注入就不该有 🧩 日志');
    assert.strictEqual(r.diagnostics.resume_gap_min, null, '刚说过话，不是「隔很久回来」');
  } finally { k.release(); }
});

test('summary 只在首句 / 隔很久回来注入 —— 平时每轮拽着摘要，沈晏会一直跳回旧事', async () => {
  const k = kit();
  k.buildKit();
  const sid = k.world({ turns: 6, segments: [{ period_start: 1, period_end: 2, content: '旧事摘要' }] });
  k.capture();
  try {
    const r = await k.build.buildModelContext(sid, { userMessage: 'm11' });
    assert.strictEqual(r.diagnostics.summary_present, true, '摘要读到了');
    assert.strictEqual(JSON.stringify(r.messages).includes('旧事摘要'), false, '但这一轮不该注入');
  } finally { k.release(); }
});

test('写面只有两处：一次组装就只写 sessions 两次（报时戳 + 缓存锚点），绝不碰记忆/念头', async () => {
  const k = kit();
  k.buildKit();
  const sid = k.world({ turns: 4 });
  k.capture();
  try {
    await k.build.buildModelContext(sid, { userMessage: 'm7', tools: 'off' });
    const writes = k.sb.__log.filter((e) => e[0].endsWith('.insert') || e[0].endsWith('.update')).map((e) => e[0]);
    // sessions.update 两笔 = last_time_notice_at（报时）+ live_anchor_turn（缓存锚点）。
    // 这条是「组装层只读」的守门人：哪天有人在这里顺手写记忆/念头，它会红。
    assert.deepStrictEqual(writes, ['sessions.update', 'sessions.update'],
      `组装层的写面变了：${writes.join(', ')}`);
  } finally { k.release(); }
});
