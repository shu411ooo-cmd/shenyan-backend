/* 临时诊断（P1 部署验证）：summary_segments 表 + memory_topics 时间列 + 最近 request_stats 摘要字段 */
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

(async () => {
  // 1. summary_segments 表是否存在 + 行数
  const { data: segs, error: se } = await supabase
    .from('summary_segments')
    .select('session_id, period_start, period_end')
    .order('period_start', { ascending: false })
    .limit(10);
  console.log('=== summary_segments ===');
  if (se) console.log('ERR', se.message);
  else {
    for (const r of segs || []) console.log(`段 ${r.period_start}~${r.period_end} | ${r.session_id}`);
    const { count } = await supabase.from('summary_segments').select('id', { count: 'exact', head: true });
    console.log(`总段数: ${count ?? '?'}`);
  }

  // 2. memory_topics 是否有 event_time / conversation_time 列（P0 验证）
  const { data: mt } = await supabase.from('memory_topics').select('topic, event_time, conversation_time, created_at').limit(3);
  console.log('\n=== memory_topics 时间列 ===');
  console.log(mt ? JSON.stringify(mt, null, 1) : '（查询失败，可能列还没加）');

  // 3. 最近 request_stats：summary 字段，确认 P1 组装在跑
  const { data: rs } = await supabase
    .from('request_stats')
    .select('created_at, summary_present, summary_from, summary_to, summary_hash')
    .order('created_at', { ascending: false })
    .limit(5);
  console.log('\n=== 最近 request_stats 摘要字段 ===');
  for (const r of rs || []) console.log(`${r.created_at} | present=${r.summary_present} range=${r.summary_from}~${r.summary_to} hash=${r.summary_hash}`);
})().catch(e => console.error('💥', e.message));
