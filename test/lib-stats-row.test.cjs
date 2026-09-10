// ===== lib/stats-row.js 单元测试（node:test）=====
// 这是**回归护栏**：2026-08-30 整个 request_stats 瞎了两小时（56 轮真实对话的成本没记上），
// 原因就是「代码先部署、迁移没跑 → 未知列让整行 400」。下面的用例把那个形状钉死 ——
// 缺列只该丢那一列，**绝不该丢整行**。

const { test } = require('node:test');
const assert = require('node:assert');
const s = require('../lib/stats-row.js');

// —— 假 PostgREST：schema 外的列一律整行 400，报错带第一个未知列名 ——
function fakeDb(schema) {
  const written = [];
  const insert = async (row) => {
    const bad = Object.keys(row).filter((k) => !schema.has(k));
    if (bad.length) return { error: { message: `column request_stats.${bad[0]} does not exist` } };
    written.push(row);
    return { error: null };
  };
  return { insert, written };
}

const BASE_SCHEMA = new Set(['session_id', 'client', 'model', 'prompt_tokens', 'cached_tokens']);

test('missingColumnFromError：四种真实文案都要认出来（其中 select 那条是本机实测的）', () => {
  assert.strictEqual(s.missingColumnFromError('column request_stats.residue_mode does not exist'), 'residue_mode');
  assert.strictEqual(s.missingColumnFromError('column "request_stats"."residue_mode" does not exist'), 'residue_mode');
  assert.strictEqual(s.missingColumnFromError('column "residue_mode" of relation "request_stats" does not exist'), 'residue_mode');
  assert.strictEqual(
    s.missingColumnFromError("Could not find the 'residue_mode' column of 'request_stats' in the schema cache"),
    'residue_mode',
  );
});

test('missingColumnFromError：认不出来就返回 null —— 绝不猜（猜错会剥掉不该剥的列）', () => {
  assert.strictEqual(s.missingColumnFromError('duplicate key value violates unique constraint'), null);
  assert.strictEqual(s.missingColumnFromError(''), null);
  assert.strictEqual(s.missingColumnFromError(null), null);
  assert.strictEqual(s.missingColumnFromError(undefined), null);
});

test('stripColumn / pickColumns：不改原对象；列不在时原样返回', () => {
  const row = { a: 1, b: 2 };
  assert.deepStrictEqual(s.stripColumn(row, 'b'), { a: 1 });
  assert.deepStrictEqual(row, { a: 1, b: 2 }, '原对象不能被动到');
  assert.strictEqual(s.stripColumn(row, 'zzz'), row);
  assert.deepStrictEqual(s.pickColumns(row, ['b', 'zzz']), { b: 2 });
  assert.deepStrictEqual(s.pickColumns(row, []), {});
});

test('insertRowResilient：顺风时一次写进，不剥不降级', async () => {
  const db = fakeDb(BASE_SCHEMA);
  const r = await s.insertRowResilient({ session_id: 1, client: 'angel', model: 'm', prompt_tokens: 5 }, db.insert);
  assert.strictEqual(r.error, null);
  assert.deepStrictEqual(r.stripped, []);
  assert.strictEqual(r.coreOnly, false);
  assert.strictEqual(db.written.length, 1);
});

test('insertRowResilient：缺一列 → 只丢那一列，其余字段照记', async () => {
  const db = fakeDb(BASE_SCHEMA);
  const r = await s.insertRowResilient(
    { session_id: 1, client: 'angel', model: 'm', prompt_tokens: 5, residue_mode: '亲密' },
    db.insert,
  );
  assert.strictEqual(r.error, null);
  assert.deepStrictEqual(r.stripped, ['residue_mode']);
  assert.strictEqual(db.written.length, 1);
  assert.strictEqual(db.written[0].residue_mode, undefined, '缺的列不该被写进去');
  assert.strictEqual(db.written[0].prompt_tokens, 5, '其余字段必须还在');
  assert.strictEqual(db.written[0].client, 'angel');
});

test('回归（2026-08-30 的形状）：三个诊断列同时缺 → 剥掉三列后仍写进整行，账本不冻结', async () => {
  // 现实中就是 live_anchor_turn/live_collapsed/live_tokens_est 三列没迁移，
  // 结果整行 400 → 整个账本两小时一行都没进。
  const db = fakeDb(BASE_SCHEMA);
  const r = await s.insertRowResilient(
    {
      session_id: 497, client: 'angel', model: 'anthropic/claude-opus-4-6', prompt_tokens: 37000,
      live_anchor_turn: 12, live_collapsed: false, live_tokens_est: 38000,
    },
    db.insert,
  );
  assert.strictEqual(r.error, null, '不该有残留错误——账本必须继续进货');
  assert.deepStrictEqual(r.stripped.sort(), ['live_anchor_turn', 'live_collapsed', 'live_tokens_est']);
  assert.strictEqual(db.written.length, 1);
  assert.strictEqual(db.written[0].prompt_tokens, 37000, '用量核心数字一个都不能少');
});

test('insertRowResilient：报错认不出（不是缺列）但有核心列 → 退核心列，尽量别丢这一行', async () => {
  // 造一个「非缺列」的报错：行里带着 junk 就报一个认不出来的错；只带核心列则成功
  const written = [];
  const insert = async (row) => {
    if ('junk' in row) return { error: { message: 'some unrelated postgres error' } };
    written.push(row);
    return { error: null };
  };
  const r = await s.insertRowResilient(
    { session_id: 1, client: 'angel', junk: 9 },
    insert,
    { coreColumns: ['session_id', 'client'] },
  );
  assert.strictEqual(r.error, null);
  assert.strictEqual(r.coreOnly, true);
  assert.deepStrictEqual(r.stripped, [], '核心列降级不算剥列');
  assert.deepStrictEqual(written, [{ session_id: 1, client: 'angel' }], '只该写核心列');
});

test('insertRowResilient：报错认不出、也没给核心列 → 如实返回 error（调用方据此大声喊）', async () => {
  const insert = async () => ({ error: { message: 'some unrelated postgres error' } });
  const r = await s.insertRowResilient({ session_id: 1 }, insert);
  assert.ok(r.error, '写不进去就必须让调用方知道——静默失败正是 08-30 没人发现的原因');
  assert.strictEqual(r.coreOnly, false);
});

test('insertRowResilient：剥列数达上限就停，不会无限重试', async () => {
  let calls = 0;
  const insert = async (row) => {
    calls++;
    const k = Object.keys(row)[0];
    return { error: { message: `column request_stats.${k} does not exist` } };
  };
  const row = { a: 1, b: 2, c: 3, d: 4, e: 5 };
  const r = await s.insertRowResilient(row, insert, { maxStrip: 2 });
  assert.strictEqual(r.stripped.length, 2);
  assert.ok(r.error);
  assert.strictEqual(calls, 3, '首次 1 次 + 剥 2 次 = 3 次，到上限即停');
});

test('insertRowResilient：报错提到的列不在行里就停（防把不存在的列名当指令空转）', async () => {
  let calls = 0;
  const insert = async () => { calls++; return { error: { message: 'column request_stats.ghost does not exist' } }; };
  const r = await s.insertRowResilient({ a: 1 }, insert);
  assert.ok(r.error);
  assert.strictEqual(calls, 1, '只该试一次');
  assert.deepStrictEqual(r.stripped, []);
});
