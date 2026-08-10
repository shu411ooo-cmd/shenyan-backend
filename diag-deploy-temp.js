/* 临时诊断：确认部署后状态——request_stats 新请求 + dialogue_residue 清空情况 */
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
  const { data: rs, error: e1 } = await supabase
    .from('request_stats')
    .select('created_at, model, stream, cached_tokens, cache_write_tokens, prompt_tokens')
    .order('created_at', { ascending: false })
    .limit(8);
  console.log('=== request_stats 最近 8 条 ===');
  if (e1) console.log('ERR', e1.message);
  else for (const r of rs || [])
    console.log(`${r.created_at} | ${r.model} | stream=${r.stream} | hit=${r.cached_tokens} | write=${r.cache_write_tokens} | prompt=${r.prompt_tokens}`);

  const { data: dr, error: e2 } = await supabase
    .from('dialogue_residue')
    .select('created_at, concern, grounding, unfinished, evidence');
  console.log('\n=== dialogue_residue ===');
  if (e2) console.log('ERR', e2.message);
  else {
    console.log(`行数: ${(dr || []).length}`);
    for (const r of (dr || []).slice(-5)) {
      console.log(`${r.created_at} | grounding=${r.grounding} | concern=${r.concern} | unfinished=${r.unfinished || '(无)'}`);
      console.log(`  evidence=${JSON.stringify(r.evidence)}`);
    }
  }
})().catch(e => console.error('💥', e.message));
