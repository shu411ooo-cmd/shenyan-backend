// ===== lib/context/select.js 单元测试（node:test）=====
//
// 这个文件有两层：
//   ① 「与搬迁前等价」——拿搬迁前 HEAD 的真实输出（test/fixtures/context-select.baseline.json）
//      逐字节压住。这是分区第 3 步的核心不变式：搬迁只许等价，不许顺手改行为。
//      ⚠️ 基线**不要**在重构里更新。它红了 = 你改了行为，先解释清楚再谈更新。
//   ② 「语义断言」——把几条容易读错的分支用白话钉死（口水词、mode×kind 矩阵、exact 判定），
//      这些是即便基线更新了也**不该**变的意思。

const { test } = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const path = require('node:path');

const sel = require('../lib/context/select.js');
const { topicHits, extractNgrams, isExactWord, selectWorldHits, isStopword, RELATION_TYPES } = sel;

/* ───────────────── ① 与搬迁前逐字节等价 ───────────────── */

// 基线由 scripts/audit/baseline-dump.cjs 生成（--rev HEAD = 搬迁前的 server.js）。
// 该工具的 norm() 把 Set/Map 规范化成排序数组，所以这里也按同一口径序列化。
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

const BASE = JSON.parse(fs.readFileSync(path.join(__dirname, 'fixtures', 'context-select.baseline.json'), 'utf8'));
const SPEC = require('../scripts/audit/specs/context-select.cjs');

for (const call of SPEC.calls) {
  test(`等价搬迁：${call.name} 与搬迁前的 HEAD 逐字节一致`, () => {
    assert.deepStrictEqual(norm(call.run(sel)), BASE[call.name],
      `${call.name} 的输出与基线不同 —— 搬迁必须是行为等价的。\n` +
      `如果你**有意**改了行为，请先在交接文档里写清楚为什么，再更新基线。`);
  });
}

/* ───────────────── ② 语义断言（白话钉死几条容易读错的分支）───────────────── */

test('topicHits：口水词命中不算命中（否则旧记忆每轮都被拽出来）', () => {
  // 「我们」是口水词：主题整词就是它、或整词出现在消息里，都不算提及
  assert.strictEqual(topicHits('我们今天出去', '我们'), false);
  assert.strictEqual(topicHits('我们', '我们'), false);
  // 长主题拆出来的 2 字片段若是口水词，也不算
  assert.strictEqual(topicHits('觉得', '什么觉得'), false);
  assert.strictEqual(topicHits('知道吗', '知道什么'), false);
  // 3/4 字片段足够具体，直接算命中
  assert.strictEqual(topicHits('今天又熬夜了', '熬夜习惯'), true);
  assert.strictEqual(topicHits('下雨了', '下雨的晚上'), true);
});

test('topicHits：空话题 / 空消息一律不命中', () => {
  assert.strictEqual(topicHits('', '猫'), false);
  assert.strictEqual(topicHits(null, '猫'), false);
  assert.strictEqual(topicHits('今天', ''), false);
  assert.strictEqual(topicHits('今天', '   '), false);
});

test('isExactWord：两侧是汉字就不算独立词（中文连写是常态）', () => {
  assert.strictEqual(isExactWord('小猫在吃猫粮', '猫'), false);
  assert.strictEqual(isExactWord('雨夜好眠', '雨夜'), false);
  // 「一只猫。」里的猫前面是「只」（汉字）→ 也不算独立词。中文里独立词天生少，
  // 所以世界书里 exact 是「奖励档」、contains 才是常态 —— 这条正是那个设计前提。
  assert.strictEqual(isExactWord('我养了一只猫。', '猫'), false);
  // ⚠️ 必须**两侧都**不是词字符才算独立。右边是标点不够 —— 「我说雨夜，好眠」左边
  //    还贴着「说」，所以仍然不是独立词（这条我第一次就写反了，实测才发现）。
  assert.strictEqual(isExactWord('我说雨夜，好眠', '雨夜'), false);
  // 两侧都不贴汉字才行
  assert.strictEqual(isExactWord('雨夜，好眠', '雨夜'), true);
  assert.strictEqual(isExactWord('the cat sat', 'cat'), true);
  assert.strictEqual(isExactWord('猫', '猫'), true);
  assert.strictEqual(isExactWord('scatter', 'cat'), false);
  // 全串只有这一个词时，串首/串尾两侧都算非词字符 → 独立
  assert.strictEqual(isExactWord('猫猫', '猫猫'), true);
  // 前面几次出现被汉字夹着、后面那次两侧是空格 → 循环必须继续往后找到它
  assert.strictEqual(isExactWord('猫猫 猫', '猫'), true);
  // 反例：全都夹着 → 一路找到 -1 才收手
  assert.strictEqual(isExactWord('猫猫猫。', '猫'), false);
});

test('extractNgrams：只留中文/字母/数字，2~4 字全都收', () => {
  assert.deepStrictEqual([...extractNgrams('雷雨')].sort(), ['雷雨']);
  assert.deepStrictEqual([...extractNgrams('打雷了')].sort(), ['打雷', '打雷了', '雷了']);
  assert.strictEqual(extractNgrams('').size, 0);
  assert.strictEqual(extractNgrams(null).size, 0);
  // 标点被剔掉：'a1-b2' → 'a1b2'，所以「a1」「1b」也算邻接 n-gram（跨过原标点）
  assert.deepStrictEqual([...extractNgrams('a1-b2')].sort(), ['1b', '1b2', 'a1', 'a1b', 'a1b2', 'b2']);
});

test('isStopword：只认「恰好 2 字且在表里」的', () => {
  assert.strictEqual(isStopword('我们'), true);
  assert.strictEqual(isStopword('今天'), true);
  assert.strictEqual(isStopword('熬夜'), false);
  assert.strictEqual(isStopword('我们啊'), false); // 3 字 → 永不判口水
  assert.strictEqual(isStopword(''), false);
});

/* —— 世界书 mode×kind 矩阵（世界书注入分层 §7 的三条刹车）—— */
const W = (kind, _hit, title) => ({ id: 1, title: title ?? `${kind}-${_hit}`, content: `${kind}内容`, kind, _hit });

test('世界书矩阵：亲密模式只放 remind，且只有 exact 进保留席', () => {
  // remind + exact → 保留席，普通块空
  const a = selectWorldHits([W('remind', 'exact'), W('setting', 'exact')], '亲密');
  assert.strictEqual(a.seat && a.seat.kind, 'remind');
  assert.strictEqual(a.block.length, 0);
  // 刹车②：remind + contains 在亲密下**不注入**（只有 exact 才算「亲密的确定性」）
  const b = selectWorldHits([W('remind', 'contains'), W('setting', 'exact')], '亲密');
  assert.strictEqual(b.seat, null);
  assert.strictEqual(b.block.length, 0);
});

test('世界书矩阵：深入模式无保留席，exact 优先、第 3 席才轮到 contains', () => {
  const a = selectWorldHits([W('remind', 'exact'), W('setting', 'exact'), W('know', 'exact'), W('know', 'contains')], '深入');
  assert.strictEqual(a.seat, null);
  assert.deepStrictEqual(a.block.map((h) => h._hit), ['exact', 'exact', 'exact']);
  // 没有 exact 知识 → 第 3 席补 contains（但不硬塞一条都没有的知识）
  const b = selectWorldHits([W('remind', 'contains'), W('setting', 'contains'), W('know', 'contains')], '深入');
  assert.strictEqual(b.block.length, 1);
  assert.strictEqual(b.block[0]._hit, 'contains');
});

test('世界书矩阵：正事/闲聊的破例——remind+exact 进席，普通块不再重复注 remind', () => {
  const a = selectWorldHits([W('remind', 'exact'), W('setting', 'exact'), W('know', 'contains')], '正事');
  assert.strictEqual(a.seat && a.seat.kind, 'remind');
  assert.ok(a.block.every((h) => h.kind !== 'remind'), '普通块里不该再出现 remind');
  // contains 的 remind 连破例都够不上（破例只认 exact）
  const b = selectWorldHits([W('remind', 'contains'), W('setting', 'exact')], '正事');
  assert.strictEqual(b.seat, null);
});

test('世界书矩阵：闲聊的 setting 是弱档，最多 1 条', () => {
  const a = selectWorldHits([W('setting', 'exact'), W('setting', 'contains'), W('know', 'exact')], '闲聊');
  assert.strictEqual(a.block.length, 1);
});

test('世界书矩阵：mode 不认识/为空 → 按「深入」兜底', () => {
  const hits = [W('know', 'exact')];
  for (const m of [null, '', '不认识的模式', undefined]) {
    assert.deepStrictEqual(selectWorldHits(hits, m).block, selectWorldHits(hits, '深入').block, `mode=${m} 应等于深入`);
  }
});

test('世界书矩阵：空命中永远返回空，且 seat 是 null 不是 undefined', () => {
  for (const m of ['亲密', '深入', '正事', '闲聊']) {
    const r = selectWorldHits([], m);
    assert.strictEqual(r.seat, null);
    assert.deepStrictEqual(r.block, []);
  }
});

test('RELATION_TYPES 是七类关系，顺序即契约（写入时要按它校验）', () => {
  assert.deepStrictEqual(RELATION_TYPES, ['触发', '导致', '贡献', '改善', '解释', '更新', '同类']);
});
