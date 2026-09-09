/* ============================================================
   时间格式化 —— 纯函数，无 IO，全部按 Asia/Shanghai 计算

   从 server.js 原样搬出（2026-09-08 分区第 1 步），注释一并带走。
   块内 12 个函数互相调用、不引用块外任何东西，所以能整块搬走。

   ⚠️ shDateKey 返回 zh-CN 的 YYYY/MM/DD，只用于「是不是同一天」的相等比较，
   不要拿去当显示格式或存库键。另有 shDayKeyISO（en-CA 的 YYYY-MM-DD）仍在
   server.js 里，两者曾经重名、后定义的静默覆盖前一个，09-08 才拆开。
   ============================================================ */
function currentTimeText() {
  return new Date().toLocaleString('zh-CN', {
    year: 'numeric',
    month: 'long',
    day: 'numeric',
    hour: '2-digit',
    minute: '2-digit',
    timeZone: 'Asia/Shanghai'
  });
}

/* ===== 时间叙事：让模型对时间流逝有实感（连续感） =====
   上海时区统一取值。所有比较都基于 Shanghai 的日期/时刻，避免服务器时区漂移。 */

function shClock(ts) {
  return new Date(ts).toLocaleTimeString('zh-CN', {
    hour: '2-digit', minute: '2-digit', hour12: false, timeZone: 'Asia/Shanghai'
  });
}

function shDateKey(ts) {
  return new Date(ts).toLocaleDateString('zh-CN', {
    year: 'numeric', month: '2-digit', day: '2-digit', timeZone: 'Asia/Shanghai'
  }); // 2026/08/09
}

function shDateTime(ts) {
  const d = new Date(ts);
  const date = d.toLocaleDateString('zh-CN', { year: 'numeric', month: 'long', day: 'numeric', timeZone: 'Asia/Shanghai' });
  const wd = d.toLocaleDateString('zh-CN', { weekday: 'long', timeZone: 'Asia/Shanghai' });
  return `${date} ${wd} ${shClock(ts)}`; // 2026年8月9日 星期六 21:47
}

function shPartOfDay(ts) {
  const h = parseInt(
    new Date(ts).toLocaleTimeString('en-US', { hour: '2-digit', hour12: false, timeZone: 'Asia/Shanghai' }),
    10
  ) % 24;
  if (h < 5) return '凌晨';
  if (h < 12) return '上午';
  if (h < 18) return '下午';
  return '晚上';
}

/* 轻量日期：只有「月日 + 时刻段」，无年无星期无分钟——沈晏时间叙事定稿的最小锚点 */
function shDateLight(ts) {
  const date = new Date(ts).toLocaleDateString('zh-CN', { month: 'long', day: 'numeric', timeZone: 'Asia/Shanghai' });
  return `${date} ${shPartOfDay(ts)}`;
}

/* 粗粒度「多久前」：两小时前 / 三天前 / 上周，不精确到分钟 */
function coarseAgo(ms) {
  const m = Math.floor(ms / 60000);
  if (m < 5) return '刚刚';
  if (m < 60) return '不到 1 小时前';
  const h = Math.floor(m / 60);
  if (h < 24) return `${h} 小时前`;
  const d = Math.floor(h / 24);
  if (d < 2) return '昨天';
  if (d < 7) return `${d} 天前`;
  return `${Math.floor(d / 7)} 周前`;
}

/* 摘要段头的日期范围：「8月5日~8月7日」；同一天只写一天。无 ts（旧段）返回空串，回退到纯轮号。 */
function formatSegRange(startTs, endTs) {
  if (!startTs || !endTs) return '';
  const s = new Date(startTs).toLocaleDateString('zh-CN', { month: 'long', day: 'numeric', timeZone: 'Asia/Shanghai' });
  const e = new Date(endTs).toLocaleDateString('zh-CN', { month: 'long', day: 'numeric', timeZone: 'Asia/Shanghai' });
  return s === e ? s : `${s}~${e}`;
}

function segHeader(seg) {
  const range = formatSegRange(seg.period_start_ts, seg.period_end_ts);
  // 2026-08-21 程芥：叫「历史摘要」他老把它当对话材料复述回话里。改叫「历史背景 · 已经聊过的事」——背景，不是现在的话。
  return range
    ? `【历史背景 · 已经聊过的事（${range}）】`
    : `【历史背景 · 已经聊过的事】`;
}

/* 相对时间标签：今天 X / 昨天 X / M月d日 X（更早的日期省略年份，够用即可） */
function relativeTimeLabel(ts, nowMs) {
  const todayKey = shDateKey(nowMs);
  const key = shDateKey(ts);
  if (key === todayKey) return `今天 ${shClock(ts)}`;
  const yesterdayKey = shDateKey(nowMs - 86400000); // 中国无夏令时，固定减一天安全
  if (key === yesterdayKey) return `昨天 ${shClock(ts)}`;
  const md = new Date(ts).toLocaleDateString('zh-CN', { month: 'long', day: 'numeric', timeZone: 'Asia/Shanghai' });
  return `${md} ${shClock(ts)}`;
}

/* 记忆注入日期标签（2026-09-03，kelivo 借鉴）：[8月25日]；跨年带年份 [2025年8月25日]。
   轻量锚点：让模型知道想起的旧事发生在哪天——「想得起」带上时间感，不打扰叙事。 */
function memoryMdLabel(ts) {
  if (!ts) return '';
  const d = new Date(ts);
  if (Number.isNaN(d.getTime())) return '';
  const s = d.toLocaleDateString('zh-CN', { month: 'long', day: 'numeric', timeZone: 'Asia/Shanghai' });
  const y = d.toLocaleDateString('zh-CN', { year: 'numeric', timeZone: 'Asia/Shanghai' });
  const yNow = new Date(Date.now()).toLocaleDateString('zh-CN', { year: 'numeric', timeZone: 'Asia/Shanghai' });
  // ⚠️ y 已经自带「年」后缀：toLocaleDateString('zh-CN', { year:'numeric' }) 返回的是 "2025年"，
  // 所以这里**不能**再拼一个「年」。2026-09-09 修：原来写 `[${y}年${s}]` → 往年记忆被读成
  // 「[2025年年8月25日]」。当时没显形只是因为记忆最早才 2026-08、全是「今年」；
  // 到 2027 元旦，所有 2026 的记忆会同时变成「去年」，这个错字会一次性全面爆发。
  // 这行字是注入给沈晏读的（【想起】注意力唤起），错字他看得见。
  return y === yNow ? `[${s}] ` : `[${y}${s}] `;
}

function humanizeDuration(ms) {
  const minutes = Math.floor(ms / 60000);
  if (minutes < 1) return '不到 1 分钟';
  if (minutes < 60) return `${minutes} 分钟`;
  const hours = Math.floor(minutes / 60);
  if (hours < 24) {
    const rem = minutes % 60;
    return rem ? `${hours} 小时 ${rem} 分` : `${hours} 小时`;
  }
  const days = Math.floor(hours / 24);
  const remH = hours % 24;
  return remH ? `${days} 天 ${remH} 小时` : `${days} 天`;
}

module.exports = {
  currentTimeText,
  shClock,
  shDateKey,
  shDateTime,
  shPartOfDay,
  shDateLight,
  coarseAgo,
  formatSegRange,
  segHeader,
  relativeTimeLabel,
  memoryMdLabel,
  humanizeDuration,
};
