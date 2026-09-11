/* 分区第 3 步 · buildModelContext 的行为基线 spec（交接文档 §2-新 要的那条不变式）
   同一份 spec 跑两个来源，输出必须逐字节一致：
     node scripts/audit/baseline-dump.cjs --spec scripts/audit/specs/context-build.cjs --rev f7e49da --out test/fixtures/context-build.baseline.json
     node scripts/audit/baseline-dump.cjs --spec scripts/audit/specs/context-build.cjs --module lib/context/build.js --compare test/fixtures/context-build.baseline.json

   「给定固定输入 → 组装出的 messages 结构稳定」是这条不变式的全部内容。
   它比前两片都重：**整段上下文都在这里成型**，段切分 / 锚点塌缩 / 预算裁剪 /
   动态块排队与丢弃 / 缓存断点落点 —— 任何一处挪位，缓存前缀就断，而不是「看着不对」。

   每组向量回一个五元组，和一个**异常**通道：
     value   返回值。buildModelContext 回 { messages, diagnostics }（diagnostics 是
             request_stats 的同一副口径：frozen_turns / live_turns / summary_present /
             attention_injected …），所以它天然就是断言面。
     io      假 supabase 的完整查询序列 —— 分组读、分页 range、锚点 update 都在里面
     logs    console 输出（📖 世界书 / 🔔 注意力 / 🧩 动态注入 / 🌿 余温 / ContextAssembly）
     inj     logInjection 的调用（表达资格隔离台账，默认 off 的跨 session 也在内）
     side    侧效果：saveLiveAnchor 落的值、consumeResidueLine 消费的 id
     __threw 抛了什么（见下方 ⚠️）

   —— 依赖面的两条纪律 ——
   ① **在这个区间里的都是真货**：session 那一组（getContextConfig … saveLiveAnchor）
      跟着一起进 ranges，所以两个模式跑的都是真实现，只有 supabase 是假的。
      这条让本 spec 顺带成了「session + build 合起来」的集成基线。
   ② **区间外的一律是桩**，而且刻意做成「回声桩」（把入参写回返回值）：
      buildTemporalNarrative 回 ⟨time gap=… asks=… now=…⟩、buildResidueNarrative 回
      ⟨thread …|…m⟩。这样断言的不是桩自己，而是 **buildModelContext 算出来、传下去的东西**。
      RESOLVED_RETURN_RE 例外 —— 它是个字面量正则，照抄 server.js:1871，逐字相同。

   ⚠️ 唯一一条「非逐字」的接线：currentWeather。它是 server.js 里的模块级 `let`
     （GET/POST /api/location 读写）。搬走之后这个状态归模块所有，模块出 setWeather，
     server.js 那两条路由改成调它。函数体一个字没改（`currentWeather` 仍是闭包变量），
     变的是「谁持有它」。基线用 __setWeather 驱动这条路径。

   ⚠️⚠️ 已知会抛的向量：build_attention_hit 记的是 ReferenceError（见 spec 里那段长注释）。
     基线把它当**行为**压住 —— 搬迁不许「顺手修好」，也不许改成别的错。 */

const ROOT = require('path').resolve(__dirname, '..', '..', '..');
const { estimateTokens, sha256, withCacheControl } = require(ROOT + '/lib/cache-control.js');
const { shPartOfDay, segHeader } = require(ROOT + '/lib/time.js');
const { getTools } = require(ROOT + '/lib/tools-schema.js');
const { selectWorldHits } = require(ROOT + '/lib/context/select.js');
const { makeFakeSb, FROZEN, FrozenDate, fmtIo } = require('../testkit.cjs');

const MSG_GAP = 60000;      // 相邻消息间隔：1 分钟（远小于 resumeGap 的 60 分钟阈值）
const sb = makeFakeSb();
const S = { residue: null, residueMode: null, pending: { notes: '', ids: [] }, calendar: '', device: null, attention: null, worlds: [], injections: [], consumed: [], saved: [] };
let sidSeq = 0;

const CFG = (o = {}) => Object.assign({
  session_id: 'global', frozen_rounds: 10, live_rounds: 15, max_context_tokens: 24000, live_max_tokens: 40000,
}, o);

/* ───────────────── 区间外的桩（区间内的都是真货，见文件头） ───────────────── */
const DEPS = {
  supabase: sb,
  // —— 真货：lib/ 里已抽走的纯函数 ——
  estimateTokens, sha256, withCacheControl, segHeader, shPartOfDay, getTools, selectWorldHits,
  // —— 回声桩：断言的是「传了什么进去」，不是桩本身 ——
  buildStableSystemPrompt: async () => '⟨STABLE⟩',
  buildTemporalNarrative: ({ resumeGap, nowMs, prevTs, asksTime }) =>
    `⟨time gap=${resumeGap} asks=${asksTime} now=${nowMs} prev=${Number.isFinite(prevTs) ? prevTs : 'NaN'}⟩`,
  buildResidueNarrative: (r, ageMs) => `⟨thread ${(r && r.unfinished) || '—'}|${Math.round(ageMs / 60000)}m⟩`,
  buildModeNote: (r) => ((r && r.convo_mode) ? `⟨mode ${r.convo_mode}⟩` : ''),
  buildDeviceNotice: (d) => `⟨device ${JSON.stringify(d)}⟩`,
  // 逐字照抄 server.js:1871（它留在 server.js，不跟这一片走）。改了它 = 改了收尾信号的判定。
  RESOLVED_RETURN_RE: /(修完|修好|搞定|弄完|弄好|完成|做完|办完|解决|处理完|回来了)/,
  calendarModule: { buildCalendarBlock: async () => S.calendar },
  getLatestResidue: async () => S.residue,
  consumeResidueLine: async (id) => { S.consumed.push(id); },
  loadPendingKeepalive: async () => S.pending,
  getLatestResidueMode: async () => S.residueMode,
  getAttentionMaterial: async () => S.attention,
  retrieveWorld: async () => S.worlds,
  // 非 async：buildModelContext 里是 `void logInjection(...)`，同步 push 才落得进基线
  logInjection: (x) => { S.injections.push({ tag: x.tag, layer: x.prov && x.prov.layer, content: String(x.content || '').slice(0, 60), prov: x.prov }); },
  // warnConfigFallback 是 session 那一片的依赖（它自己留在 server.js，六个配置组共用）。
  // 这一片和 session 片都不直接调它 —— 这里只在「settings 读失败」时才可能响，向量不会走到。
  warnConfigFallback: () => {},
  // Date / process 只对 rev 模式的 vm 沙箱有意义（deps 最后展开，盖掉 harness 那份）。
  // 模块模式里模块读的是真全局，spec 在 runCase 里把 global.Date 换成冻钟、按需改 env。
  Date: FrozenDate,
  process,
};

/* ───────────────── 固定输入的一副世界 ───────────────── */
const mkHistory = (turns, sid, gapMin = 0, lastText = null) => {
  const n = turns * 2;
  const rows = Array.from({ length: n }, (_, i) => ({
    role: i % 2 === 0 ? 'user' : 'assistant',
    content: `m${i}`,
    session_id: sid,
    visible: true,
    created_at: new Date(FROZEN - (n - i) * MSG_GAP - gapMin * MSG_GAP).toISOString(),
  }));
  if (lastText != null && rows.length) rows[rows.length - 1].content = lastText;
  return rows;
};

/** 建一副干净的库，返回 session id（每条向量用自己的 id —— liveAnchors 是进程内 Map，会串味） */
function world(o = {}) {
  const sid = 'B' + (++sidSeq);
  S.residue = o.residue !== undefined ? o.residue : null;
  S.residueMode = o.residueMode || null;
  S.pending = o.pending || { notes: '', ids: [] };
  S.calendar = o.calendar || '';
  S.attention = o.attention || null;
  S.worlds = o.worlds || [];
  S.injections.length = 0; S.consumed.length = 0; S.saved.length = 0;
  sb.__clear();
  sb.__data.settings = { rows: [CFG(o.cfg)] };
  sb.__data.sessions = { rows: [Object.assign({ id: sid, last_time_notice_at: null }, o.sessionRow || {})] };
  sb.__data.messages = { rows: mkHistory(o.turns || 0, sid, o.gapMin || 0, o.lastText) };
  sb.__data.summary_segments = { rows: (o.segments || []).map((s) => Object.assign({ session_id: sid }, s)) };
  return sid;
}

/* ───────────────── 跑一组 ───────────────── */
let LOGS = [];
async function runCase(setup, fn) {
  LOGS = [];
  const rl = console.log, rw = console.warn, re = console.error, rd = global.Date;
  console.log = (...a) => LOGS.push('log ' + a.join(' '));
  console.warn = (...a) => LOGS.push('warn ' + a.join(' '));
  console.error = (...a) => LOGS.push('err ' + a.join(' '));
  global.Date = FrozenDate;   // module 模式读的是全局 Date；rev 模式那份走 deps.Date
  const origCross = process.env.CROSS_SESSION_FLOW;
  let value, threw = null;
  try {
    if (setup) setup();
    if (process.env.__cross !== undefined) process.env.CROSS_SESSION_FLOW = process.env.__cross;
    value = await fn();
  } catch (e) {
    threw = `${e && e.constructor ? e.constructor.name : 'Error'}: ${e && e.message}`;
  } finally {
    console.log = rl; console.warn = rw; console.error = re; global.Date = rd;
    if (origCross === undefined) delete process.env.CROSS_SESSION_FLOW; else process.env.CROSS_SESSION_FLOW = origCross;
    delete process.env.__cross;
  }
  return {
    value: value === undefined ? { __undefined: true } : value,
    threw,
    io: fmtIo(sb.__log),
    logs: LOGS.slice(),
    inj: S.injections.slice(),
    side: { saved: S.saved.slice(), consumed: S.consumed.slice() },
  };
}
const calls = [];
const C = (name, setup, fn) => calls.push({ name, run: (A) => runCase(setup, () => fn(A)) });

/* 常用：只取 messages 的骨架（role + 前缀 + 有无 cache_control），messages 全文太大 */
const shape = (ms) => ms.map((m) => ({
  role: m.role,
  head: String(typeof m.content === 'string' ? m.content : JSON.stringify(m.content)).slice(0, 28),
  cc: !!(m.cache_control || (Array.isArray(m.content) && m.content[0] && m.content[0].cache_control)),
}));

/* ═══════════ ① 短历史 / 退化输入 ═══════════ */
C('build_tiny_noSeg', () => world({ turns: 2 }), async (A) => {
  const r = await A.buildModelContext(sidOf(), { userMessage: 'm3' });
  return { shape: shape(r.messages), diag: r.diagnostics, msgs: r.messages.length };
});
C('build_emptyHistory', () => world({ turns: 0 }), async (A) => {
  const r = await A.buildModelContext(sidOf(), { userMessage: '' });
  return { shape: shape(r.messages), diag: r.diagnostics };
});
// 首句（history 只有 1 条）：isFirstTurn → 摘要/天气/日历/设备都开了口
C('build_firstTurn', () => world({ turns: 0, calendar: '⟨cal 今天是你生日⟩', pending: { notes: '\n【自由活动记录】醒了', ids: [11] } }), async (A) => {
  const r = await A.buildModelContext(sidOf(), { userMessage: '在吗' });
  return { shape: shape(r.messages), diag: r.diagnostics };
});

/* ═══════════ ② 段切分（frozen / middle / live） ═══════════ */
// 有摘要水位线：frozen = 水位线后第一批；middle 补中间；live = 最近 live_rounds 轮
C('build_seg_split', () => world({ turns: 30, cfg: { frozen_rounds: 3, live_rounds: 5 }, segments: [{ period_start: 1, period_end: 6, content: '前六轮的摘要' }] }), async (A) => {
  const r = await A.buildModelContext(sidOf(), { userMessage: 'm59' });
  return { shape: shape(r.messages).slice(0, 6), diag: r.diagnostics, msgs: r.messages.length };
});
// 水位线正好顶到 live 起点 → middle 为空
C('build_seg_noMiddle', () => world({ turns: 30, cfg: { frozen_rounds: 10, live_rounds: 5 }, segments: [{ period_start: 1, period_end: 20, content: '很长的摘要' }] }), async (A) => {
  const r = await A.buildModelContext(sidOf(), { userMessage: 'm59' });
  return { shape: shape(r.messages).slice(0, 4), diag: r.diagnostics };
});
// 无摘要但已超预算 → 前端冻结兜底（frozen 取头部）
C('build_noSeg_overBudget', () => world({ turns: 30, cfg: { frozen_rounds: 4, live_rounds: 5 } }), async (A) => {
  const r = await A.buildModelContext(sidOf(), { userMessage: 'm59' });
  return { diag: r.diagnostics, msgs: r.messages.length };
});
// 摘要段只在「首句 / 隔很久回来」注入（08-21 拍板：否则每轮拽着沈晏跳）
C('build_summary_injected_firstTurn', () => world({ turns: 1, segments: [{ period_start: 1, period_end: 4, content: '旧事摘要' }] }), async (A) => {
  const r = await A.buildModelContext(sidOf(), { userMessage: 'm1' });
  return { shape: shape(r.messages), diag: r.diagnostics };
});
C('build_summary_injected_resumeGap', () => world({ turns: 6, gapMin: 180, segments: [{ period_start: 1, period_end: 4, content: '旧事摘要' }] }), async (A) => {
  const r = await A.buildModelContext(sidOf(), { userMessage: 'm11' });
  return { shape: shape(r.messages), diag: r.diagnostics };
});
C('build_summary_present_notInjected', () => world({ turns: 6, segments: [{ period_start: 1, period_end: 2, content: '旧事摘要' }] }), async (A) => {
  const r = await A.buildModelContext(sidOf(), { userMessage: 'm11' });
  return { summary_present: r.diagnostics.summary_present, hasSegText: JSON.stringify(r.messages).includes('旧事摘要'), diag: r.diagnostics };
});

/* ═══════════ ③ 缓存锚点：活着 / 塌缩 / 死掉 ═══════════ */
C('build_anchor_alive', () => world({ turns: 30, cfg: { frozen_rounds: 4, live_rounds: 15 }, sessionRow: { live_anchor_turn: 20 } }), async (A) => {
  const r = await A.buildModelContext(sidOf(), { userMessage: 'm59' });
  return { diag: r.diagnostics, msgs: r.messages.length };
});
// 轮数超 live_rounds×2 → 塌缩（锚点前移回当前滚动起点）
C('build_anchor_collapse_rounds', () => world({ turns: 30, cfg: { live_rounds: 5 }, sessionRow: { live_anchor_turn: 2 } }), async (A) => {
  const r = await A.buildModelContext(sidOf(), { userMessage: 'm59' });
  return { diag: r.diagnostics, msgs: r.messages.length };
});
// token 超 live_max_tokens → 塌缩（另一条阈值）
C('build_anchor_collapse_tokens', () => world({ turns: 20, cfg: { live_rounds: 15, live_max_tokens: 1 }, sessionRow: { live_anchor_turn: 2 } }), async (A) => {
  const r = await A.buildModelContext(sidOf(), { userMessage: 'm39' });
  return { diag: r.diagnostics };
});
// 锚点死法四种：越界 / 小于 1 / 被摘要水位线吞掉 / 恰好等于总轮数
C('build_anchor_dead_oob', () => world({ turns: 10, sessionRow: { live_anchor_turn: 99 } }), async (A) => ({ diag: (await A.buildModelContext(sidOf(), { userMessage: 'm19' })).diagnostics }));
C('build_anchor_dead_zero', () => world({ turns: 10, sessionRow: { live_anchor_turn: 0 } }), async (A) => ({ diag: (await A.buildModelContext(sidOf(), { userMessage: 'm19' })).diagnostics }));
C('build_anchor_dead_byWatermark', () => world({ turns: 30, cfg: { live_rounds: 15 }, segments: [{ period_start: 1, period_end: 20, content: 'S' }], sessionRow: { live_anchor_turn: 10 } }), async (A) => ({ diag: (await A.buildModelContext(sidOf(), { userMessage: 'm59' })).diagnostics }));
C('build_anchor_equalTotal', () => world({ turns: 10, sessionRow: { live_anchor_turn: 10 } }), async (A) => ({ diag: (await A.buildModelContext(sidOf(), { userMessage: 'm19' })).diagnostics }));

/* ═══════════ ④ 时间心跳 / 感知注入的时机 ═══════════ */
// 从没报过时 → 心跳必报
C('build_heartbeat_never', () => world({ turns: 2 }), async (A) => ({ diag: (await A.buildModelContext(sidOf(), { userMessage: 'm3' })).diagnostics }));
// 10 分钟前刚报过 → 不报（同一时刻段内不重复报时）
C('build_heartbeat_recent', () => world({ turns: 2, sessionRow: { last_time_notice_at: new Date(FROZEN - 10 * 60000).toISOString() } }), async (A) => {
  const r = await A.buildModelContext(sidOf(), { userMessage: 'm3' });
  return { hasTime: JSON.stringify(r.messages).includes('⟨time'), diag: r.diagnostics };
});
// 30 分钟前报过（仍不到 1 小时），但**时刻段变了** → 仍要报（跨午夜那类）
// FROZEN = 上海 20:00（晚上）；19:40 也是晚上 → 这条要挑一个跨段的时间点，见下一条
C('build_heartbeat_crossMidnight', () => world({ turns: 2, sessionRow: { last_time_notice_at: new Date(FROZEN - 45 * 60000).toISOString() } }), async (A) => {
  const r = await A.buildModelContext(sidOf(), { userMessage: 'm3' });
  return { hasTime: JSON.stringify(r.messages).includes('⟨time'), diag: r.diagnostics };
});
// 问时间 → 必报（且叙事换精确时钟）
C('build_asksTime', () => world({ turns: 2, lastText: '现在几点了？' }), async (A) => {
  const r = await A.buildModelContext(sidOf(), { userMessage: '现在几点了？' });
  return { hasTime: JSON.stringify(r.messages).includes('⟨time'), diag: r.diagnostics };
});
C('build_weather_firstTurn', () => {
  const sid = world({ turns: 0, lastText: '在吗' });
  return sid;
}, async (A) => {
  A.__setWeather({ city: '杭州', temp: 22, line: '外面在下小雨', at: '2026-09-10T12:00:00Z' });
  const r = await A.buildModelContext(sidOf(), { userMessage: '在吗' });
  A.__setWeather(null);
  return { hasWeather: JSON.stringify(r.messages).includes('外面在下小雨'), diag: r.diagnostics };
});
C('build_weather_noCity', () => world({ turns: 0, lastText: '在吗' }), async (A) => {
  A.__setWeather({ city: '', temp: null, line: '阴', at: 'x' });
  const r = await A.buildModelContext(sidOf(), { userMessage: '在吗' });
  A.__setWeather(null);
  return { hasWeather: JSON.stringify(r.messages).includes('她那边阴'), diag: r.diagnostics };
});
// 活跃对话中（非首句、非 resumeGap）→ 天气/日历/设备一律不注入（感知不是通知）
C('build_perception_silent_midConversation', () => world({ turns: 4, calendar: '⟨cal⟩' }), async (A) => {
  A.__setWeather({ city: '杭州', line: '晴', at: 'x' });
  const r = await A.buildModelContext(sidOf(), { userMessage: 'm7', device: { onLine: true, battery: { level: 30, charging: false } } });
  A.__setWeather(null);
  return { body: JSON.stringify(r.messages).includes('晴') || JSON.stringify(r.messages).includes('⟨cal'), diag: r.diagnostics };
});
C('build_calendar_firstTurn', () => world({ turns: 0, calendar: '⟨cal 今天是你生日⟩' }), async (A) => ({ diag: (await A.buildModelContext(sidOf(), { userMessage: '在吗' })).diagnostics }));
C('build_device_withTimeBlock', () => world({ turns: 0, lastText: '在吗' }), async (A) => {
  const r = await A.buildModelContext(sidOf(), { userMessage: '在吗', device: { onLine: true, battery: { level: 30, charging: true } } });
  return { hasDevice: JSON.stringify(r.messages).includes('⟨device'), diag: r.diagnostics };
});
// 心跳关掉、但 device 有值 → 独立兜底成块（首句也感知得到）
C('build_device_standalone', () => world({ turns: 2, sessionRow: { last_time_notice_at: new Date(FROZEN - 10 * 60000).toISOString() } }), async (A) => {
  const r = await A.buildModelContext(sidOf(), { userMessage: 'm3', device: { onLine: false } });
  return { hasDevice: JSON.stringify(r.messages).includes('不在线'), hasTime: JSON.stringify(r.messages).includes('⟨time'), diag: r.diagnostics };
});

/* ═══════════ ⑤ 对话残留 / 余温 ═══════════ */
C('build_resumeGap_residue', () => world({
  turns: 6, gapMin: 180,
  residue: { id: 77, unfinished: '搬家的事', evidence: [], grounding: '实', concern: 0.9, convo_mode: '深入', departure: '去修 bug' },
}), async (A) => {
  const r = await A.buildModelContext(sidOf(), { userMessage: '我回来了' });
  return { hasResidue: JSON.stringify(r.messages).includes('上次对话的余温'), diag: r.diagnostics };
});
// 她回来第一句就带收尾信号 → 线头压掉，模式保留
C('build_resumeGap_resolvedReturn', () => world({
  turns: 6, gapMin: 180,
  residue: { id: 78, unfinished: '搬家的事', evidence: [], grounding: '实', concern: 0.9, convo_mode: '亲密', departure: '去修 bug' },
}), async (A) => {
  const r = await A.buildModelContext(sidOf(), { userMessage: '修好了' });
  return { hasResidue: JSON.stringify(r.messages).includes('上次对话的余温'), diag: r.diagnostics };
});
C('build_resumeGap_noResidue', () => world({ turns: 6, gapMin: 180 }), async (A) => ({ diag: (await A.buildModelContext(sidOf(), { userMessage: '在吗' })).diagnostics }));
// 残留有行但叙事两边都空 → 不注入、不消费
C('build_resumeGap_residue_blank', () => world({
  turns: 6, gapMin: 180,
  residue: { id: 79, unfinished: null, evidence: [], convo_mode: null, grounding: '空', concern: 0.9 },
}), async (A) => ({ diag: (await A.buildModelContext(sidOf(), { userMessage: '在吗' })).diagnostics }));
// 没到 resumeGap 就不读残留（活跃对话不碰这条库）
C('build_noResumeGap_skipsResidue', () => world({
  turns: 6,
  residue: { id: 80, unfinished: '搬家的事', evidence: [], grounding: '实', concern: 0.9, convo_mode: '深入' },
}), async (A) => ({ diag: (await A.buildModelContext(sidOf(), { userMessage: 'm11' })).diagnostics }));

/* ═══════════ ⑥ keepalive 留言 ═══════════ */
C('build_pendingKeepalive', () => world({
  turns: 2, sessionRow: { last_time_notice_at: new Date(FROZEN - 10 * 60000).toISOString() },
  pending: { notes: '\n【自由活动记录】我刚才去阳台站了会儿', ids: [31, 32] },
}), async (A) => {
  const r = await A.buildModelContext(sidOf(), { userMessage: 'm3' });
  return { hasNotes: JSON.stringify(r.messages).includes('阳台'), diag: r.diagnostics };
});
// opts.keepalive → 不注入留言、不跑注意力/世界书（唤醒要自己决定，不被过去的自己带偏）
C('build_keepaliveOpt', () => world({
  turns: 4,
  pending: { notes: '\n【自由活动记录】不该出现', ids: [33] },
  attention: { text: '不该出现', hits: 1, refs: [] },
  worlds: [{ id: 1, title: '猫', content: '不该出现', kind: 'setting', _hit: 'exact' }],
}), async (A) => {
  const r = await A.buildModelContext(sidOf(), { keepalive: true, tools: 'off' });
  return { leakage: JSON.stringify(r.messages).includes('不该出现'), diag: r.diagnostics };
});

/* ═══════════ ⑦ 注意力 / 世界书 ═══════════ */
/* ⚠️⚠️ 这条向量记的是**一次崩溃**，不是一次注入。
   server.js:2701 的 `const attention` 声明在 try 块里（块作用域），而 2719 行的
   `prov: { … refs: (attention && attention.refs) … }` 在 try 块**外面**引用它 →
   `ReferenceError: attention is not defined`。
   这段 prov 是 2026-08-30 那次 provenance 改动加进来的（提交 f05766c）；此前那行只写
   `{ prio: 1, tag, msg }`，不碰 attention，所以一直没暴露。
   实测（把这段代码单独切出来跑，见本节向量）：🔔 [注意力] 日志照常打印，
   紧接着整轮抛错。**这条不是本次搬迁引入的，也不是我改出来的 —— 是搬迁前就有的。**
   基线照原样压住它：搬迁不许顺手修，也不许改成别的错。修不修由程芥定（见交接文档）。 */
C('build_attention_hit', () => world({
  turns: 2, sessionRow: { last_time_notice_at: new Date(FROZEN - 10 * 60000).toISOString() },
  attention: { text: '搬家的事还没说完', hits: 2, refs: [{ topicId: 7, title: '搬家' }, { topicId: 8, title: '院子' }] },
}), async (A) => ({ diag: (await A.buildModelContext(sidOf(), { userMessage: 'm3' })).diagnostics }));
C('build_attention_null', () => world({ turns: 2, sessionRow: { last_time_notice_at: new Date(FROZEN - 10 * 60000).toISOString() } }), async (A) => ({ diag: (await A.buildModelContext(sidOf(), { userMessage: 'm3' })).diagnostics }));
C('build_attention_skipped_memoryFalse', () => world({ turns: 2, attention: { text: 'X', hits: 1, refs: [] } }), async (A) => ({ diag: (await A.buildModelContext(sidOf(), { userMessage: 'm3', memory: false })).diagnostics }));
C('build_attention_skipped_noUserMessage', () => world({ turns: 2, attention: { text: 'X', hits: 1, refs: [] } }), async (A) => ({ diag: (await A.buildModelContext(sidOf(), {})).diagnostics }));

// 世界书三种出口：保留席（亲密+remind+exact）/ 普通块 / 矩阵过滤后无
C('build_world_seat', () => world({
  turns: 2, sessionRow: { last_time_notice_at: new Date(FROZEN - 10 * 60000).toISOString() },
  residueMode: '亲密',
  worlds: [{ id: 11, title: '怕打雷', content: '打雷时要抱着她', kind: 'remind', _hit: 'exact' }],
}), async (A) => {
  const r = await A.buildModelContext(sidOf(), { userMessage: '晚上打雷了' });
  return { seatText: JSON.stringify(r.messages).match(/【她定过的一条约定】[^"]{0,30}/), diag: r.diagnostics };
});
C('build_world_block', () => world({
  turns: 2, sessionRow: { last_time_notice_at: new Date(FROZEN - 10 * 60000).toISOString() },
  worlds: [{ id: 12, title: '猫', content: '家里有只猫叫炉猫', kind: 'setting', _hit: 'contains' }],
  residueMode: '闲聊',
}), async (A) => ({ diag: (await A.buildModelContext(sidOf(), { userMessage: '猫呢' })).diagnostics }));
C('build_world_filtered_empty', () => world({
  turns: 2, residueMode: '亲密',
  worlds: [{ id: 13, title: '猫', content: 'X', kind: 'setting', _hit: 'contains' }],
}), async (A) => ({ diag: (await A.buildModelContext(sidOf(), { userMessage: '猫呢' })).diagnostics }));
C('build_world_empty', () => world({ turns: 2 }), async (A) => ({ diag: (await A.buildModelContext(sidOf(), { userMessage: 'm3' })).diagnostics }));

/* ═══════════ ⑧ 同轮上限 3 + prio 丢弃 ═══════════ */
// 首句 / resume 常同时命中 6-8 块：prio 小的先丢（attention 1 → world 2 → residue 3 →
// weather/calendar 4 → time/device 5）
C('build_blocks_overflow_drop', () => world({
  turns: 0, lastText: '几点了？', gapMin: 0, calendar: '⟨cal⟩',
  residue: { id: 90, unfinished: '搬家', evidence: [], grounding: '实', concern: 0.9, convo_mode: '深入' },
  attention: { text: '旧事', hits: 1, refs: [{ topicId: 1, title: 'A' }] },
  worlds: [{ id: 14, title: '猫', content: 'X', kind: 'setting', _hit: 'contains' }],
  residueMode: '闲聊',
}), async (A) => {
  A.__setWeather({ city: '杭州', line: '晴', at: 'x' });
  const r = await A.buildModelContext(sidOf(), { userMessage: '几点了？', device: { onLine: true, battery: { level: 50 } } });
  A.__setWeather(null);
  return { dropped: (LOGS.find((l) => l.includes('🧩 [动态注入]')) || '').match(/dropped=[^\s]*/), diag: r.diagnostics };
});
/* 上面那条在「世界书推入之前」就撞上 attention 的 ReferenceError，压根走不到排序那几行 ——
   所以丢弃逻辑靠这条**不带 attention**的同族向量压住。
   隔 90 分钟回来（resumeGap>60min）→ 一次凑齐 5 块：world(2) + residue(3) + weather(4)
   + calendar(4) + time(5)，上限 3 → 留 time/weather/calendar，丢 world + residue（**两块**，
   slice(3).map 那一支才真的走全）。device 块与 time 互斥（`!injectTime`），所以不传 device，
   否则块数对不上、丢弃清单也就变了。 */
C('build_blocks_overflow_drop_noAttention', () => world({
  turns: 2, lastText: '几点了？', gapMin: 90, calendar: '⟨cal⟩',
  residue: { id: 91, unfinished: '搬家', evidence: [], grounding: '实', concern: 0.9, convo_mode: '深入' },
  worlds: [{ id: 15, title: '猫', content: 'X', kind: 'setting', _hit: 'contains' }],
  residueMode: '闲聊',
}), async (A) => {
  A.__setWeather({ city: '杭州', line: '晴', at: 'x' });
  const r = await A.buildModelContext(sidOf(), { userMessage: '几点了？' });
  A.__setWeather(null);
  const line = LOGS.find((l) => l.includes('🧩 [动态注入]')) || '';
  return { line: line.replace(/last_msg=.*$/, ''), diag: r.diagnostics };
});

/* ═══════════ ⑨ 预算裁剪：顺序 + 保底 ═══════════ */
// 预算掐到 1：middle 先裁光、live 保底 3、frozen 保底 2
C('build_trim_all', () => world({ turns: 30, cfg: { frozen_rounds: 6, live_rounds: 8, max_context_tokens: 1 }, segments: [{ period_start: 1, period_end: 3, content: 'S' }] }), async (A) => {
  const r = await A.buildModelContext(sidOf(), { userMessage: 'm59', tools: 'off' });
  return { diag: r.diagnostics, msgs: r.messages.length };
});
C('build_tools_off', () => world({ turns: 4 }), async (A) => ({ toolsTokens: (await A.buildModelContext(sidOf(), { userMessage: 'm7', tools: 'off' })).diagnostics.token_breakdown.tools }));
C('build_tools_on', () => world({ turns: 4 }), async (A) => ({ toolsTokens: (await A.buildModelContext(sidOf(), { userMessage: 'm7' })).diagnostics.token_breakdown.tools }));

/* ═══════════ ⑩ 跨 session 流水（默认关的环境开关） ═══════════ */
C('build_crossFlow_on', () => {
  process.env.__cross = 'on';
  const sid = world({ turns: 2, sessionRow: { last_time_notice_at: new Date(FROZEN - 10 * 60000).toISOString() } });
  sb.__data.messages = { rows: [...sb.__data.messages.rows,
    { session_id: 'OTHER', role: 'user', content: '另一条河里的第一句', visible: true, created_at: new Date(FROZEN - 3600000).toISOString() }] };
  return sid;
}, async (A) => {
  const r = await A.buildModelContext(sidOf(), { userMessage: 'm3' });
  return { hasCross: JSON.stringify(r.messages).includes('流水回望'), diag: r.diagnostics };
});
C('build_crossFlow_off', () => {
  const sid = world({ turns: 2 });
  sb.__data.messages = { rows: [...sb.__data.messages.rows,
    { session_id: 'OTHER', role: 'user', content: '不该出现', visible: true, created_at: new Date(FROZEN - 3600000).toISOString() }] };
  return sid;
}, async (A) => {
  const r = await A.buildModelContext(sidOf(), { userMessage: 'm3' });
  return { hasCross: JSON.stringify(r.messages).includes('流水回望') };
});

/* setup 刚建的那副世界的 session id —— 每条向量一个，避免 liveAnchors 那个进程内 Map 串味 */
function sidOf() {
  return sb.__data.sessions.rows[0].id;
}

module.exports = {
  baseRev: 'f7e49da',
  ranges: [[1793, 1793], [1998, 2150], [2368, 2390], [2396, 2404], [2406, 2886]],
  prelude: 'function __setWeather(w) { currentWeather = w; return currentWeather; }',
  expose: ['buildModelContext', '__setWeather', 'getContextConfig', 'getSessionState',
    'loadSummarySegments', 'loadOtherSessionFlow', 'buildCrossSessionNarrative', 'insertSummarySegment',
    'pairTurns', 'fetchSessionHistory', 'loadLiveAnchor', 'saveLiveAnchor'],
  deps: DEPS,
  // rev 模式交回裸符号集（已在 expose 里带上 __setWeather）；module 模式交回工厂，在这里把
  // session + build 两个模块**按 server.js 的接法拼起来** —— 拼错顺序也算搬迁出错。
  adapt: (api) => {
    if (typeof api !== 'function') return api;
    const createSession = require(ROOT + '/lib/context/session.js');
    const createBuild = require(ROOT + '/lib/context/build.js');
    const Sess = createSession({ supabase: sb, warnConfigFallback: DEPS.warnConfigFallback });
    const B = createBuild(Object.assign({}, Sess, DEPS));
    return Object.assign({}, Sess, { buildModelContext: B.buildModelContext, __setWeather: (w) => B.setWeather(w) });
  },
  calls,
};
