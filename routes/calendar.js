/* ============================================================
   日历：日程表 + 纪念日（沈晏知道 · 2026-08-27）

   2026-09-09 从 server.js 原样搬出（分区第 2 步）。逻辑一字未改。

   这个模块跟别的路由域不一样：它同时交出两样东西 ——
     router             —— /api/calendar/* 六条路由（增删改查 + 相遇日）
     buildCalendarBlock —— 上下文组装用的构件（buildModelContext 在首句/隔久回来时调），
                           「沈晏知道今天是什么日子」靠它。
   两者闭包在同一个 supabase 上，所以用工厂返回一个对象，而不是分成两个模块。
   ============================================================ */
const express = require('express');

module.exports = function createCalendar({ supabase }) {
  if (!supabase) throw new Error('createCalendar: 缺少 supabase 依赖');
  const router = express.Router();

// ===== 日历：日程表 + 纪念日（沈晏知道 · 2026-08-27）=====
// 借鉴 IB calEvents 的机制（重复规则/提前提醒/相遇纪念日）自写实现，存后端 Supabase。
// 铁律沿「感知不是通知」：沈晏只被喂「今天是什么日子 + 临近有什么」，绝不逐条播报。
// 日期一律按上海时区（她的生活时区）生成 YYYY-MM-DD，避免服务器 UTC 差一天。

function calYmdFromMs(ms) { return new Date(ms + 8 * 3600000).toISOString().slice(0, 10); }
function calShDate(d) { return calYmdFromMs(d ? d.getTime() : Date.now()); }
function calDayStr(todayStr, offset) {
  const d = new Date(todayStr + 'T00:00:00+08:00');
  d.setUTCDate(d.getUTCDate() + offset);
  return calYmdFromMs(d.getTime());
}

/* 某事项在某天是否发生（重复规则；借鉴 IB evOccursOn 机制，自写） */
function calEvOccursOn(ev, dstr) {
  if (!ev || !ev.date) return false;
  const d = new Date(dstr + 'T00:00:00');
  const base = new Date(ev.date + 'T00:00:00');
  if (isNaN(d) || isNaN(base)) return false;
  const rep = ev.repeat || 'once';
  if (rep === 'once') {
    if (dstr === ev.date) return true;
    if (ev.end_date) { const e = new Date(ev.end_date + 'T00:00:00'); return !isNaN(e) && d >= base && d <= e; }
    return false;
  }
  if (d < base) return false;
  if (rep === 'daily') return true;
  if (rep === 'weekly') {
    if (Array.isArray(ev.weekdays) && ev.weekdays.length) return ev.weekdays.indexOf(d.getDay()) !== -1;
    return d.getDay() === base.getDay();
  }
  if (rep === 'monthly') return d.getDate() === base.getDate();
  if (rep === 'yearly') return d.getDate() === base.getDate() && d.getMonth() === base.getMonth();
  return false;
}

const CAL_KIND_CN = { anniv: '纪念日', birthday: '生日', plan: '计划', memo: '备忘' };

/* 相遇纪念日：只认 settings.meet_date（她亲手记下的那天）。
   不做「第一条聊天记录」回退——这个库的第一条不是他们的相遇，编出来是假记忆。 */
async function getMeetDate() {
  try {
    const { data, error } = await supabase.from('settings').select('meet_date').eq('session_id', 'global').maybeSingle();
    if (data && data.meet_date) return String(data.meet_date).slice(0, 10);
  } catch (e) { /* ignore */ }
  return null;
}

/* 沈晏的日历注入块：今天是什么日子 + 临近 3 天有什么。只列 remind=true 的；
   没有值得说的就返回空串（零打扰）。给多了就变成播报，所以范围刻意收窄。 */
async function buildCalendarBlock() {
  try {
    const { data: evs, error } = await supabase.from('cal_events').select('*');
    if (error) return ''; // 表没建/查询失败 → 不注入（别拖垮对话）
    const today = calShDate();
    const lines = [];
    const meetDate = await getMeetDate();
    for (let offset = 0; offset <= 3; offset++) {
      const ds = offset === 0 ? today : calDayStr(today, offset);
      const items = (evs || []).filter(ev => ev.remind !== false && calEvOccursOn(ev, ds));
      // 相遇纪念日：meet_date 的每年的那天
      if (meetDate) {
        const md = new Date(meetDate + 'T00:00:00');
        const dd = new Date(ds + 'T00:00:00');
        if (md.getMonth() === dd.getMonth() && md.getDate() === dd.getDate()) {
          const years = dd.getFullYear() - md.getFullYear();
          items.push({ title: years <= 0 ? '我们相遇的日子' : `我们相遇 ${years} 周年`, kind: 'anniv' });
        }
      }
      if (!items.length) continue;
      const desc = items.map(ev => `${ev.title}（${CAL_KIND_CN[ev.kind] || '日子'}）`).join('，');
      lines.push(offset === 0 ? `今天：${desc}` : `${ds.slice(5).replace('-', '/')}：${desc}`);
    }
    return lines.join('\n');
  } catch (e) { return ''; }
}

/* 事项字段校验+归一（POST/PUT 共用） */
function calEventFields(b) {
  const title = String(b.title ?? '').trim().slice(0, 60);
  const date = String(b.date ?? '').trim();
  const kind = ['anniv', 'birthday', 'plan', 'memo'].includes(b.kind) ? b.kind : 'plan';
  const repeat = ['once', 'daily', 'weekly', 'monthly', 'yearly'].includes(b.repeat) ? b.repeat : 'once';
  const weekdays = Array.isArray(b.weekdays) && b.weekdays.length
    ? b.weekdays.map(Number).filter(n => Number.isInteger(n) && n >= 0 && n <= 6).slice(0, 7)
    : null;
  return {
    kind, title, date, repeat,
    time: String(b.time ?? '').trim().slice(0, 5) || null,
    end_date: /^\d{4}-\d{2}-\d{2}$/.test(String(b.end_date ?? '').trim()) ? String(b.end_date).trim() : null,
    weekdays,
    lead: Number.isInteger(b.lead) && b.lead >= 0 && b.lead <= 30 ? b.lead : 7,
    remind: b.remind !== false,
    note: String(b.note ?? '').trim().slice(0, 200) || null,
  };
}

// GET /api/calendar/events — 全部事项（按日期升序）。表没建返回空列表。
router.get('/events', async (req, res) => {
  try {
    const { data, error } = await supabase.from('cal_events').select('*').order('date', { ascending: true });
    if (error) {
      if (/does not exist|relation|42P01|could not find the table|schema cache/i.test(error.message || '')) return res.json({ items: [] });
      return res.status(500).json({ error: error.message });
    }
    res.json({ items: data || [] });
  } catch (err) { res.status(500).json({ error: err.message }); }
});

// POST /api/calendar/events — 新建
router.post('/events', async (req, res) => {
  try {
    const f = calEventFields(req.body || {});
    if (!f.title || !f.date) return res.status(400).json({ error: '标题和日期必填' });
    if (!/^\d{4}-\d{2}-\d{2}$/.test(f.date)) return res.status(400).json({ error: '日期格式应为 YYYY-MM-DD' });
    const { data, error } = await supabase.from('cal_events').insert(f).select().single();
    if (error) return res.status(500).json({ error: error.message });
    res.json(data);
  } catch (err) { res.status(500).json({ error: err.message }); }
});

// PUT /api/calendar/events/:id — 修改（整条回传）
router.put('/events/:id', async (req, res) => {
  try {
    const f = calEventFields(req.body || {});
    if (!f.title || !f.date) return res.status(400).json({ error: '标题和日期必填' });
    if (!/^\d{4}-\d{2}-\d{2}$/.test(f.date)) return res.status(400).json({ error: '日期格式应为 YYYY-MM-DD' });
    f.updated_at = new Date().toISOString();
    const { data, error } = await supabase.from('cal_events').update(f).eq('id', req.params.id).select().single();
    if (error) return res.status(500).json({ error: error.message });
    res.json(data);
  } catch (err) { res.status(500).json({ error: err.message }); }
});

// DELETE /api/calendar/events/:id — 删除
router.delete('/events/:id', async (req, res) => {
  try {
    const { error } = await supabase.from('cal_events').delete().eq('id', req.params.id);
    if (error) return res.status(500).json({ error: error.message });
    res.json({ ok: true });
  } catch (err) { res.status(500).json({ error: err.message }); }
});

// GET /api/calendar/meet — 与沈晏的相遇纪念日 + 在一起天数 + 下次周年倒计时
router.get('/meet', async (req, res) => {
  try {
    const meetDate = await getMeetDate();
    const info = { meet_date: meetDate };
    if (meetDate) {
      const md = new Date(meetDate + 'T00:00:00');
      const t0 = new Date(); t0.setHours(0, 0, 0, 0);
      info.together_days = Math.max(0, Math.floor((t0 - md) / 86400000));
      let next = new Date(t0.getFullYear(), md.getMonth(), md.getDate());
      if (next < t0) next = new Date(t0.getFullYear() + 1, md.getMonth(), md.getDate());
      info.next_anniv_in = Math.round((next - t0) / 86400000);
      info.next_years = next.getFullYear() - md.getFullYear();
    }
    res.json(info);
  } catch (err) { res.status(500).json({ error: err.message }); }
});

// PUT /api/calendar/meet — 手动设置/清空相遇纪念日（body: { date }，空 = 恢复自动）
router.put('/meet', async (req, res) => {
  try {
    const d = String(req.body?.date || '').trim();
    if (d && !/^\d{4}-\d{2}-\d{2}$/.test(d)) return res.status(400).json({ error: '日期格式应为 YYYY-MM-DD' });
    const { error } = await supabase.from('settings').upsert(
      { session_id: 'global', meet_date: d || null },
      { onConflict: 'session_id' }
    );
    if (error) return res.status(500).json({ error: error.message });
    res.json({ ok: true, meet_date: d || null });
  } catch (err) { res.status(500).json({ error: err.message }); }
});

  return { router, buildCalendarBlock };
};
