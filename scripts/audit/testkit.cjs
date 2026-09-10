/* ============================================================
   分区重构的测试共件（2026-09-10）

   基线 spec（scripts/audit/specs/*.cjs）和等价性测试（test/lib-*.test.cjs）都要这两样：
   一个能记录查询序列的假 supabase，和一个可以冻住的时钟。
   两边各养一份必然漂，所以抽出来。

   —— 为什么必须冻钟 ——
   检索层有三处读时钟：打分带 30 天半衰（score 是浮点，差一毫秒就不逐位相同）、
   回声压制按「多久以前」判、召回日志按天切。不冻钟，同一份向量隔一分钟跑两遍都不一样，
   基线就成了跟时间赛跑。
   ⚠️ Date.now() 和 new Date() 是**两个口子**，天切走的是 new Date()，只补 Date.now 不够。

   —— 假 supabase 的纪律 ——
   eq / in **真的应用过滤**，不是把整表喂回去。否则 .in('topic', [...]) 那条测出来的
   东西和线上不是一回事，假货比不测更坏。
   ============================================================ */
const RealDate = Date;

const FROZEN = RealDate.parse('2026-09-10T12:00:00Z');
function FrozenDate(...a) {
  if (!new.target) return new RealDate(FROZEN).toString();
  return a.length === 0 ? new RealDate(FROZEN) : new RealDate(...a);
}
FrozenDate.now = () => FROZEN;
FrozenDate.parse = RealDate.parse;
FrozenDate.UTC = RealDate.UTC;
FrozenDate.prototype = RealDate.prototype;

/** 「相对冻住的现在 N 天前」的 ISO 串 —— 向量写在任何一天跑都成立 */
const day = (n) => new RealDate(FROZEN - n * 86400000).toISOString();
const hash = (s) => { let h = 0; for (const c of String(s)) h = (h * 31 + c.charCodeAt(0)) | 0; return h; };

/* ---------- 记录式假 supabase ----------
   只实现这套代码真正用到的方法。查询序列进 __log，数据从 __data 按表名取。
   两个 await 口子都要挡：`.maybeSingle()` 和自己就是 thenable 的查询链。 */
function makeFakeSb() {
  const log = [];
  const data = {};
  const from = (table) => {
    log.push([`from:${table}`]);
    const chain = [];
    const q = {};
    const step = (op, ...a) => { chain.push([op, ...a]); log.push([`${table}.${op}`, ...a]); return q; };
    const result = () => {
      const rec = data[table];
      if (!rec) return { data: [], error: null };
      if (rec.error) return { data: null, error: { message: rec.error } };
      let rows = rec.rows || [];
      for (const [op, col, val] of chain) {
        if (op === 'eq') rows = rows.filter((r) => r[col] === val);
        else if (op === 'in') rows = rows.filter((r) => val.includes(r[col]));
      }
      return { data: JSON.parse(JSON.stringify(rows)), error: null };
    };
    q.select = (c) => step('select', c);
    q.eq = (c, v) => step('eq', c, v);
    q.in = (c, v) => step('in', c, v);
    q.limit = (n) => step('limit', n);
    q.maybeSingle = () => { step('maybeSingle'); const r = result(); return Promise.resolve({ data: (r.data && r.data[0]) || null, error: r.error }); };
    q.then = (onF, onR) => { step('await'); return Promise.resolve(result()).then(onF, onR); };
    return q;
  };
  return {
    from,
    __log: log,
    __data: data,
    __reset() { log.length = 0; },
    __clear() { log.length = 0; for (const k of Object.keys(data)) delete data[k]; },
  };
}

/** 「相对**真实的**现在 N 天前」—— 语义测试要的是真·近 N 天，不能冻在 2026-09-10 */
const daysAgo = (n) => new RealDate(RealDate.now() - n * 86400000).toISOString();

/* ---------- 注意力/检索层的夹具词汇 ---------- */
/** memory_topics 一行。updated_at 默认走冻钟，要「真·近 N 天」请显式传 updated: daysAgo(n) */
const T = (topic, o = {}) => ({
  id: Math.abs(hash(topic)) % 900 + 1,
  topic,
  last_content: o.content !== undefined ? o.content : `正文-${topic}`,
  grounding: o.grounding !== undefined ? o.grounding : '实',
  importance: o.importance !== undefined ? o.importance : 0.5,
  updated_at: o.updated || day(o.ageDays !== undefined ? o.ageDays : 3),
  kind: o.kind || 'memory',
  evidence: o.evidence || [],
  source: 'test',
});

/** world_entries 一行（enabled 必给，查询带 .eq('enabled', true)）*/
const W = (title, keywords, kind) => ({
  id: Math.abs(hash(title)) % 900 + 1, title, content: `${title}的内容`,
  keywords, kind: kind || 'setting', enabled: true,
});

/** settings 表的 global 行（注意力那 10 列）*/
const SETTINGS = (o = {}) => Object.assign({
  session_id: 'global',
  attention_k: 2, attention_budget_chars: 700, attention_concern_threshold: 0.5,
  attention_recent_days: 7, attention_recent_seats: 3, attention_assoc_seats: 2,
  attention_echo_24h_hours: 24, attention_echo_24h_factor: 0.5,
  attention_echo_72h_hours: 72, attention_echo_72h_factor: 0.8,
}, o);

module.exports = { makeFakeSb, FROZEN, FrozenDate, RealDate, day, daysAgo, hash, T, W, SETTINGS };
