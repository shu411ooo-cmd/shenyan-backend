/* 一次性回溯脚本（2026-08-12 时间感改造配套）：
   ① 给 session 497 生成第 1~10 轮的摘要段（新纪律 prompt，把"凌晨两点多"这种推测洗掉）
   ② 给已有全部摘要段补 period_start_ts / period_end_ts（段头显示日期）
   前置：先在 Supabase SQL editor 跑——
     ALTER TABLE summary_segments ADD COLUMN IF NOT EXISTS period_start_ts timestamptz,
       ADD COLUMN IF NOT EXISTS period_end_ts timestamptz;
     ALTER TABLE sessions ADD COLUMN IF NOT EXISTS last_time_notice_at timestamptz;
   用法：cd shenyan-backend && node backfill-segments-temp.js
*/
const fs = require('fs');
const { createClient } = require('@supabase/supabase-js');
const env = {};
for (const line of fs.readFileSync('.env', 'utf8').split(/\r?\n/)) {
  const t = line.trim();
  if (!t || t.startsWith('#')) continue;
  const i = t.indexOf('=');
  if (i > 0) env[t.slice(0, i).trim()] = t.slice(i + 1).trim().replace(/^["']|["']$/g, '');
}
const supabase = createClient(env.SUPABASE_URL, env.SUPABASE_KEY);
const SESSION = process.argv[2] || '497';

function pairTurns(messages) {
  const turns = [];
  let current = null;
  for (const m of messages || []) {
    if (m.role === 'user') {
      current = { user: m, replies: [] };
      turns.push(current);
    } else if (current) {
      current.replies.push(m);
    }
  }
  return turns;
}

async function summarizeViaDeepSeek(text) {
  const SYSTEM = '你是对话摘要器。把以下对话压缩成一段中文摘要，保留：重要事实、用户的关键经历与感受、未解决的事项、关键承诺。不要编造，不要加评论。控制在 300 字以内。时间纪律：只有用户明确陈述的时间/日期（如"我两点才睡"）才可保留为事实；沈晏（AI）自己推测的时间（"现在是几点""凌晨了吧""你熬夜到三四点"这类）一律不写，或改写为过去式"当时沈晏推测是X"。摘要里禁止出现"现在是X点""凌晨两点多"这类现在时时间断言——旧摘要踩过这个坑，会让模型把过去当现在。';
  for (let attempt = 1; attempt <= 2; attempt++) {
    try {
      const res = await fetch('https://api.deepseek.com/v1/chat/completions', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', 'Authorization': `Bearer ${env.DEEPSEEK_API_KEY}` },
        body: JSON.stringify({
          model: 'deepseek-v4-flash',
          messages: [
            { role: 'system', content: SYSTEM },
            { role: 'user', content: text }
          ],
          max_tokens: 4000
        }),
        signal: AbortSignal.timeout(30000)
      });
      if (!res.ok) { console.warn('⚠️ 摘要请求失败:', res.status); return null; }
      const data = await res.json();
      const content = data.choices?.[0]?.message?.content;
      if (content) return content;
      console.warn(`⚠️ 摘要返回空内容（attempt ${attempt}/2，finish_reason=${data.choices?.[0]?.finish_reason}）`);
    } catch (err) {
      console.error('💥 摘要生成异常:', err.message);
    }
  }
  return null;
}

(async () => {
  const { data: msgs, error: merr } = await supabase
    .from('messages')
    .select('role, content, created_at')
    .eq('session_id', SESSION)
    .eq('visible', true)
    .order('created_at', { ascending: true });
  if (merr) { console.log('读消息失败', merr.message); return; }
  const turns = pairTurns(msgs);
  console.log(`session ${SESSION} 共 ${turns.length} 轮`);

  // ① 回溯第 1~10 轮（若第 1 段起点不是 1）
  const { data: segs, error: serr } = await supabase
    .from('summary_segments')
    .select('id, period_start, period_end')
    .eq('session_id', SESSION)
    .order('period_start', { ascending: true });
  if (serr) { console.log('读段失败', serr.message); return; }
  if (!segs.length || segs[0].period_start !== 1) {
    const end = segs.length ? Math.min(segs[0].period_start - 1, turns.length) : Math.min(10, turns.length);
    const newTurns = turns.slice(0, end);
    const textToCompress = newTurns.flatMap(t => {
      const lines = [`用户: ${t.user.content}`];
      for (const r of t.replies) lines.push(`沈晏: ${r.content}`);
      return lines;
    }).join('\n');
    console.log(`生成第 1~${end} 轮摘要（共 ${textToCompress.length} 字符）...`);
    const summary = await summarizeViaDeepSeek(textToCompress);
    if (!summary) { console.log('❌ 1~10 摘要生成失败，跳过'); }
    else {
      const lastTurn = newTurns[newTurns.length - 1];
      const lastMsg = lastTurn.replies.length ? lastTurn.replies[lastTurn.replies.length - 1] : lastTurn.user;
      const { error: ierr } = await supabase.from('summary_segments').insert({
        session_id: SESSION, period_start: 1, period_end: end, content: summary,
        period_start_ts: newTurns[0].user.created_at, period_end_ts: lastMsg.created_at,
      });
      if (ierr) console.log('❌ 插入 1~10 段失败:', ierr.message);
      else console.log('✅ 已插入第 1~', end, '轮摘要段\n', summary.slice(0, 200));
    }
  } else {
    console.log('第 1 段已从第 1 轮开始，跳过生成');
  }

  // ② 给全部段补 ts（段头日期用）
  let updated = 0;
  for (const seg of segs) {
    if (seg.period_start_ts && seg.period_end_ts) continue; // 已补过（重跑安全）
    const startTurn = turns[seg.period_start - 1];
    const endTurn = turns[seg.period_end - 1];
    if (!startTurn || !endTurn) { console.log(`⚠️ 段 ${seg.period_start}~${seg.period_end} 轮索引越界，跳过`); continue; }
    const lastMsg = endTurn.replies.length ? endTurn.replies[endTurn.replies.length - 1] : endTurn.user;
    const { error: uerr } = await supabase
      .from('summary_segments')
      .update({ period_start_ts: startTurn.user.created_at, period_end_ts: lastMsg.created_at })
      .eq('id', seg.id);
    if (uerr) console.log(`❌ 更新段 ${seg.id} ts 失败:`, uerr.message);
    else { updated++; console.log(`  ✅ 段 ${seg.period_start}~${seg.period_end} ts=${startTurn.user.created_at?.slice(0,10)} ~ ${lastMsg.created_at?.slice(0,10)}`); }
  }
  console.log(`\n完成：补 ts ${updated} 段。`);

  // 打印最新两段确认
  const { data: final } = await supabase
    .from('summary_segments')
    .select('period_start, period_end, period_start_ts, period_end_ts, content')
    .eq('session_id', SESSION)
    .order('period_start', { ascending: true });
  console.log('\n=== 最终段列表（最新 3 段） ===');
  for (const s of (final || []).slice(-3)) {
    console.log(`${s.period_start}~${s.period_end} | ${s.period_start_ts?.slice(0,10)} ~ ${s.period_end_ts?.slice(0,10)} | ${(s.content || '').slice(0, 40)}`);
  }
})().catch(e => console.error('💥', e.message));
