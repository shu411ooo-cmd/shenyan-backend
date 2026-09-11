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
   两个 await 口子都要挡：`.maybeSingle()` 和自己就是 thenable 的查询链。

   2026-09-10 扩了 session/build 这一层要用的算子（neq/order/range/insert/update/count-head）。
   纪律不变：**每个算子都真的生效**，不是只记一笔。`.range(from,to)` 尤其要真切片 ——
   fetchSessionHistory 的分页全靠它，假货不切片就永远只测得到「不翻页」那条路。
   ⚠️ 旧的算子（eq/in/limit/select/await）日志格式一个字没动，老的基线才不用重录。 */
function makeFakeSb() {
  const log = [];
  const data = {};
  let throwMode = null;      // 模拟「不是 error 字段、而是直接抛」——catch 分支比 error 分支多
  let throwTable = null;     // 只让某一张表抛（不传 = 全表抛）。用来把「读 A 炸」和「读 B 炸」分开
  const from = (table) => {
    log.push([`from:${table}`]);
    const chain = [];
    let head = false;        // select(..., {head:true}) → 只回 count
    let write = null;        // 待落库的写（insert/update），读取时别把它当过滤条件
    const q = {};
    const step = (op, ...a) => { chain.push([op, ...a]); log.push([`${table}.${op}`, ...a]); return q; };
    const result = () => {
      if (throwMode && (!throwTable || throwTable === table)) throw new Error(throwMode);
      const rec = data[table];
      if (!rec) return head ? { data: null, error: null, count: 0 } : { data: [], error: null };
      if (rec.error) return head ? { data: null, error: { message: rec.error }, count: null } : { data: null, error: { message: rec.error } };
      // rec.count 显式给了就用它 —— 用于模拟「count 和真实分页对不上」
      if (head) return { data: null, error: null, count: rec.count !== undefined ? rec.count : (rec.rows || []).length };
      let rows = (rec.rows || []).slice();
      // 按链上记录的顺序依次生效（过滤 → 排序 → 切片），顺序会改变结果，所以不能分类批量套
      for (const [op, a1, a2] of chain) {
        if (op === 'eq') rows = rows.filter((r) => r[a1] === a2);
        else if (op === 'neq') rows = rows.filter((r) => r[a1] !== a2);
        else if (op === 'in') rows = rows.filter((r) => a2.includes(r[a1]));
        else if (op === 'order') {
          const asc = !a2 || a2.ascending !== false;
          rows = rows.slice().sort((x, y) => (x[a1] === y[a1] ? 0 : (x[a1] > y[a1] ? 1 : -1) * (asc ? 1 : -1)));
        } else if (op === 'range') rows = rows.slice(a1, a2 + 1);
        else if (op === 'limit') rows = rows.slice(0, a1);
      }
      if (write) {
        if (write.op === 'insert') { rec.rows = (rec.rows || []).concat([write.payload]); return { data: null, error: null }; }
        if (write.op === 'upsert') {
          // 真 upsert：按 onConflict 的列找得到就合并进那一行，找不到才追加。
          // 不真做的话「更新已有主题」和「新建主题」在假货里长得一模一样 —— 那正是差分写回的核心分支。
          const cols = String((write.opts && write.opts.onConflict) || '').split(',').map((s) => s.trim()).filter(Boolean);
          const hit = cols.length && (rec.rows || []).find((r) => cols.every((c) => r[c] === write.payload[c]));
          if (hit) Object.assign(hit, write.payload);
          else rec.rows = (rec.rows || []).concat([write.payload]);
          return { data: null, error: null };
        }
        for (const r of rows) Object.assign(r, write.payload);   // rows 是同一个对象引用的浅拷贝 → 原地改
        return { data: null, error: null };
      }
      return { data: JSON.parse(JSON.stringify(rows)), error: null };
    };
    q.select = (c, o) => { if (o && o.head) head = true; return o ? step('select', c, o) : step('select', c); };
    q.eq = (c, v) => step('eq', c, v);
    q.neq = (c, v) => step('neq', c, v);
    q.in = (c, v) => step('in', c, v);
    q.order = (c, o) => step('order', c, o);
    q.range = (a, b) => step('range', a, b);
    q.limit = (n) => step('limit', n);
    q.insert = (payload) => { write = { op: 'insert', payload }; if (!data[table]) data[table] = { rows: [] }; return step('insert', payload); };
    q.update = (payload) => { write = { op: 'update', payload }; return step('update', payload); };
    q.upsert = (payload, opts) => { write = { op: 'upsert', payload, opts }; if (!data[table]) data[table] = { rows: [] }; return step('upsert', payload, opts); };
    q.maybeSingle = () => { step('maybeSingle'); const r = result(); return Promise.resolve({ data: (r.data && r.data[0]) || null, error: r.error, count: r.count }); };
    q.then = (onF, onR) => { step('await'); return Promise.resolve(result()).then(onF, onR); };
    return q;
  };
  return {
    from,
    __log: log,
    __data: data,
    // 让下一次查询**抛异常**（而不是回 error 字段）—— catch 分支和 error 分支是两条路
    __throw(msg, onlyTable) { throwMode = msg || null; throwTable = onlyTable || null; },
    __reset() { log.length = 0; },
    __clear() { log.length = 0; for (const k of Object.keys(data)) delete data[k]; },
  };
}

/** 「相对**真实的**现在 N 天前」—— 语义测试要的是真·近 N 天，不能冻在 2026-09-10 */
const daysAgo = (n) => new RealDate(RealDate.now() - n * 86400000).toISOString();

/** __log → 一行一条的可比字符串。对象参数要 JSON 展开，`join` 会把它们全压成 "[object Object]"，
    那样 .order('x',{ascending:false}) 和 .order('x',{ascending:true}) 在基线里长得一模一样。 */
const fmtIo = (log) => log.map((e) => e.map((x) => (x && typeof x === 'object' ? JSON.stringify(x) : String(x))).join(' | '));

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

module.exports = { makeFakeSb, FROZEN, FrozenDate, RealDate, day, daysAgo, hash, fmtIo, T, W, SETTINGS };
