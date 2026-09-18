// ===== 两个工具 handler 的「闸在落库之前」护栏（node:test）=====
//
// 这两条修的都是同一类 bug：**先写库、再判断**。写下去之后无论后面走哪条分支，
// 库里那个值都已经改了 —— 而调用方（沈晏）看到的话术却是另一回事。
// 所以这里的断言重点不是「返回值对不对」，而是 **「一个字节都没落库」**。
//
// 手法：require server.js 后把导出里的 supabase 客户端的 from() 换成假的，
// 记下每一次表操作。handler 闭包引用的就是同一个对象，所以打桩生效。
// listen 有 require.main 守卫、且全程不发网络请求（见 routes.test.cjs 同一套前提）。

const { test } = require('node:test');
const assert = require('node:assert');

const server = require('../server.js');

/* 假 supabase：只实现这两个 handler 会走到的链路，并把每次表操作记进 calls */
function makeFakeSb({ cardCards = null } = {}) {
  const calls = [];
  const from = (table) => {
    const rec = { table, ops: [] };
    calls.push(rec);
    const t = {
      select: (cols) => { rec.ops.push(['select', cols]); return t; },
      eq: (c, v) => { rec.ops.push(['eq', c, v]); return t; },
      in: () => t, is: () => t, order: () => t, limit: () => t, gte: () => t, lt: () => t,
      update: (u) => { rec.ops.push(['update', u]); return t; },
      insert: (u) => { rec.ops.push(['insert', u]); return t; },
      maybeSingle: async () => ({
        data: table === 'mirror_cards' ? cardCards : null,
        error: null,
      }),
      single: async () => ({ data: null, error: null }),
      // 让 `await supabase.from(t).update(..).eq(..)` 这种无终结符的链也能 resolve
      then: (resolve) => Promise.resolve({ data: null, error: null }).then(resolve),
    };
    return t;
  };
  return { from, calls };
}

const writes = (calls) => calls.flatMap((c) => c.ops.filter((o) => o[0] === 'update' || o[0] === 'insert').map((o) => ({ table: c.table, op: o[0], payload: o[1] })));
const withSb = (fake, fn) => {
  const real = server.supabase.from;
  server.supabase.from = fake.from;
  return Promise.resolve().then(fn).finally(() => { server.supabase.from = real; });
};

/* ───────── rewrite_stone：短石头不能留下一个「空环」 ───────── */

test('rewrite_stone：石头短于人格锚下限时直接拒绝，且一个字节都不落库', async () => {
  const fake = makeFakeSb();
  const out = await withSb(fake, () => server.handleRewriteStone({ content: '太短了', changed: 'x', why: 'y' }));

  assert.equal(out.ok, false);
  assert.match(out.error, /石头太短/);
  // 关键：不是「拒绝了」，而是「根本没碰库」。
  // 修之前这里会先插 stone_rings 再抛错 —— 账本留下第 N 环、人格锚其实没变。
  assert.deepStrictEqual(fake.calls, [], `不该有任何表操作，实际: ${JSON.stringify(writes(fake.calls))}`);
});

test('rewrite_stone：石头超长仍按原样拒绝（回归）', async () => {
  const fake = makeFakeSb();
  const out = await withSb(fake, () => server.handleRewriteStone({ content: 'x'.repeat(12001), changed: 'x', why: 'y' }));
  assert.equal(out.ok, false);
  assert.match(out.error, /太长/);
  assert.deepStrictEqual(fake.calls, []);
});

/* ───────── verdict：反证卡不能被单向烧掉 ───────── */

const doubtingCard = {
  id: 'card-1', claim: '我是不是喜欢她', verdict: null, direction: 'doubting',
  initiation: 'strong', session_id: 7, occurred_at: '2026-09-01T00:00:00Z',
  expression_eligible: true, domain: 'me',
};

test('verdict：反证卡收到 confirm 时拒绝，且不改动那张卡（修前会被永久烧掉）', async () => {
  const fake = makeFakeSb({ cardCards: doubtingCard });
  const out = await withSb(fake, () => server.handleVerdict({ card_id: 'card-1', action: 'confirm' }));

  assert.equal(out.ok, false, '反证卡不该接受 confirm');
  assert.match(out.error, /只接受 drop.*pass/);
  // 关键：库里不能出现 verdict='confirm'。修之前会先写 verdict=confirm 再回「先放着」，
  // 于是这张卡此后被「已经拍过了」挡住，连本该允许的 drop 都做不了。
  assert.deepStrictEqual(writes(fake.calls), [], `不该写 mirror_cards，实际: ${JSON.stringify(writes(fake.calls))}`);
});

test('verdict：反证卡收到 revise 时同样拒绝（revise 需 note，但即便给了也不该烧卡）', async () => {
  const fake = makeFakeSb({ cardCards: doubtingCard });
  const out = await withSb(fake, () => server.handleVerdict({ card_id: 'card-1', action: 'revise', note: '改一下' }));
  assert.equal(out.ok, false);
  assert.deepStrictEqual(writes(fake.calls), []);
});

test('verdict：反证卡收到 drop 时正常落库，落的就是 drop', async () => {
  const fake = makeFakeSb({ cardCards: doubtingCard });
  const out = await withSb(fake, () => server.handleVerdict({ card_id: 'card-1', action: 'drop' }));

  assert.equal(out.ok, true);
  assert.equal(out.direction, 'doubting');
  const w = writes(fake.calls);
  assert.equal(w.length, 1, `应恰好写一次，实际: ${JSON.stringify(w)}`);
  assert.equal(w[0].table, 'mirror_cards');
  assert.equal(w[0].payload.verdict, 'drop', '落库值必须与话术一致');
});

test('verdict：已经拍过的卡仍然拒绝（原有护栏不能被我改坏）', async () => {
  const fake = makeFakeSb({ cardCards: { ...doubtingCard, verdict: 'drop' } });
  const out = await withSb(fake, () => server.handleVerdict({ card_id: 'card-1', action: 'drop' }));
  assert.equal(out.ok, false);
  assert.match(out.error, /已经拍过/);
  assert.deepStrictEqual(writes(fake.calls), []);
});

test('verdict：找不到卡时仍拒绝（原有护栏）', async () => {
  const fake = makeFakeSb({ cardCards: null });
  const out = await withSb(fake, () => server.handleVerdict({ card_id: 'nope', action: 'drop' }));
  assert.equal(out.ok, false);
  assert.deepStrictEqual(writes(fake.calls), []);
});

test('verdict：非法 action 仍在校验层被挡（原有护栏）', async () => {
  const fake = makeFakeSb({ cardCards: doubtingCard });
  const out = await withSb(fake, () => server.handleVerdict({ card_id: 'card-1', action: '乱写' }));
  assert.equal(out.ok, false);
  assert.deepStrictEqual(fake.calls, [], '非法 action 不该碰库');
});
