/* 临时诊断2：查 memory_topics 是否被编辑者写过 + 崩溃前后信号 */
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
  const { data: mt, error: e } = await supabase
    .from('memory_topics')
    .select('topic, bucket_id, grounding, updated_at, created_at')
    .order('updated_at', { ascending: false })
    .limit(10);
  console.log('=== memory_topics 最近 10 条 ===');
  if (e) console.log('ERR', e.message);
  else for (const r of mt || [])
    console.log(`${r.updated_at} | ${r.topic} | grounding=${r.grounding} | bucket_id=${r.bucket_id}`);

  const { data: cnt } = await supabase.from('memory_topics').select('id', { count: 'exact', head: true });
  console.log(`\nmemory_topics 总行数: ${cnt ?? '?'}`);

  // 03:53 之后有没有任何 request_stats 记录（证明实例是否仍在处理）
  const { data: rs } = await supabase
    .from('request_stats')
    .select('created_at')
    .gte('created_at', '2026-08-10T03:53:30')
    .order('created_at', { ascending: false });
  console.log(`\n03:53:30 之后 request_stats 记录数: ${(rs || []).length}`);
  for (const r of rs || []) console.log(' ', r.created_at);
})().catch(e => console.error('💥', e.message));
