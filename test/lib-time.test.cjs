// ===== lib/time.js 单元测试（node:test）=====
// 全部用固定时间戳（禁止 Date.now()）——结果必须可复现。
// 模块按 Asia/Shanghai（UTC+8，无夏令时）计算；helper sh() 把「上海墙钟时刻」换成 epoch。

const { test } = require('node:test');
const assert = require('node:assert');
const t = require('../lib/time.js');

// 上海墙钟 (y, mo, d, h, mi) → epoch；mo 从 1 起（可读性），负小时由 Date.UTC 自动回拨
const sh = (y, mo, d, h, mi = 0) => Date.UTC(y, mo - 1, d, h - 8, mi);

test('shPartOfDay：上海时间分四档（凌晨/上午/下午/晚上）', () => {
  assert.strictEqual(t.shPartOfDay(sh(2026, 9, 9, 3, 0)), '凌晨');
  assert.strictEqual(t.shPartOfDay(sh(2026, 9, 9, 10, 30)), '上午');
  assert.strictEqual(t.shPartOfDay(sh(2026, 9, 9, 15, 45)), '下午');
  assert.strictEqual(t.shPartOfDay(sh(2026, 9, 9, 21, 47)), '晚上');
});

test('shDateKey：同一天两个不同时刻得到相同键（它的唯一用途就是同日比较）', () => {
  // 上海 09-09 00:05 与 09-09 23:50 是同一上海日
  assert.strictEqual(t.shDateKey(sh(2026, 9, 9, 0, 5)), t.shDateKey(sh(2026, 9, 9, 23, 50)));
  // 跨到次日则不同
  assert.notStrictEqual(t.shDateKey(sh(2026, 9, 9, 23, 50)), t.shDateKey(sh(2026, 9, 10, 0, 30)));
  // 键形如 2026/09/09
  assert.strictEqual(t.shDateKey(sh(2026, 9, 9, 12, 0)), '2026/09/09');
});

test('跨 UTC 日界：UTC 19:30 在上海已是次日凌晨 03:30，日期按上海算', () => {
  const ts = Date.UTC(2026, 8, 8, 19, 30); // 2026-09-08T19:30Z = 上海 2026-09-09 03:30
  assert.strictEqual(t.shDateKey(ts), '2026/09/09'); // 不是 UTC 的 2026/09/08
  assert.strictEqual(t.shClock(ts), '03:30');
  assert.strictEqual(t.shPartOfDay(ts), '凌晨');
});

test('relativeTimeLabel：今天 / 昨天 / 更早 三档', () => {
  const now = sh(2026, 9, 9, 12, 0); // 上海 2026-09-09 中午
  assert.strictEqual(t.relativeTimeLabel(sh(2026, 9, 9, 9, 0), now), '今天 09:00');
  assert.strictEqual(t.relativeTimeLabel(sh(2026, 9, 8, 9, 0), now), '昨天 09:00');
  assert.strictEqual(t.relativeTimeLabel(sh(2026, 8, 20, 9, 0), now), '8月20日 09:00');
});

test('coarseAgo：粗粒度多久前（不精确到分钟）', () => {
  assert.strictEqual(t.coarseAgo(0), '刚刚');
  assert.strictEqual(t.coarseAgo(30 * 1000), '刚刚'); // 30 秒
  assert.strictEqual(t.coarseAgo(45 * 60 * 1000), '不到 1 小时前');
  assert.strictEqual(t.coarseAgo(3 * 3600 * 1000), '3 小时前');
  assert.strictEqual(t.coarseAgo(26 * 3600 * 1000), '昨天');
  assert.strictEqual(t.coarseAgo(5 * 86400 * 1000), '5 天前');
  assert.strictEqual(t.coarseAgo(40 * 86400 * 1000), '5 周前');
});

test('humanizeDuration：不到1分 / 分 / 小时 / 小时+分 / 天+小时', () => {
  assert.strictEqual(t.humanizeDuration(30 * 1000), '不到 1 分钟');
  assert.strictEqual(t.humanizeDuration(5 * 60 * 1000), '5 分钟');
  assert.strictEqual(t.humanizeDuration(2 * 3600 * 1000), '2 小时');
  assert.strictEqual(t.humanizeDuration(2 * 3600 * 1000 + 30 * 60 * 1000), '2 小时 30 分');
  assert.strictEqual(t.humanizeDuration(24 * 3600 * 1000), '1 天');
  assert.strictEqual(t.humanizeDuration(26 * 3600 * 1000), '1 天 2 小时');
});

test('shClock / shDateTime / shDateLight：格式化形态', () => {
  assert.strictEqual(t.shClock(sh(2026, 9, 9, 21, 47)), '21:47');
  assert.strictEqual(t.shDateTime(sh(2026, 9, 9, 3, 0)), '2026年9月9日 星期三 03:00');
  assert.strictEqual(t.shDateLight(sh(2026, 9, 9, 3, 0)), '9月9日 凌晨');
});

test('formatSegRange / segHeader：日期范围、同一天、缺 ts 回退', () => {
  assert.strictEqual(t.formatSegRange(sh(2026, 8, 5, 0), sh(2026, 8, 7, 23, 59)), '8月5日~8月7日');
  assert.strictEqual(t.formatSegRange(sh(2026, 8, 5, 0), sh(2026, 8, 5, 10, 0)), '8月5日');
  assert.strictEqual(t.formatSegRange(null, null), '');
  assert.strictEqual(
    t.segHeader({ period_start_ts: sh(2026, 8, 5, 0), period_end_ts: sh(2026, 8, 7, 23, 59) }),
    '【历史背景 · 已经聊过的事（8月5日~8月7日）】'
  );
  assert.strictEqual(t.segHeader({}), '【历史背景 · 已经聊过的事】');
});

test('memoryMdLabel：今年不带年份；空 / 坏输入返回空串', () => {
  // 用运行时年份构造「今年」的时间戳，跨年跑测试也稳
  const y = new Date().getFullYear();
  assert.strictEqual(t.memoryMdLabel(Date.UTC(y, 7, 25, 2)), '[8月25日] ');
  assert.strictEqual(t.memoryMdLabel(null), '');
  assert.strictEqual(t.memoryMdLabel('bad'), '');
});

test('memoryMdLabel：往年要带年份，且只有一个「年」字', () => {
  // 2026-09-09 修的 bug：toLocaleDateString({year:'numeric'}) 返回的已是 "2025年"，
  // 原代码又拼了一个「年」→「[2025年年8月25日]」。这行字是注入给沈晏读的，错字他看得见。
  // 当时没显形只因记忆最早才 2026-08、全是「今年」；2027 元旦会一次性全面爆发。
  const y = new Date().getFullYear();
  const last = t.memoryMdLabel(Date.UTC(y - 1, 7, 25, 2));
  assert.strictEqual(last, `[${y - 1}年8月25日] `);
  assert.strictEqual((last.match(/年/g) || []).length, 1, '「年」字只能出现一次');
  // 更久以前也一样
  assert.strictEqual(t.memoryMdLabel(Date.UTC(y - 2, 0, 3, 2)), `[${y - 2}年1月3日] `);
});

test('currentTimeText：长中文时间格式的形态', () => {
  const s = t.currentTimeText();
  assert.match(s, /^\d{4}年\d{1,2}月\d{1,2}日 \d{2}:\d{2}$/, `实际: ${s}`);
});
