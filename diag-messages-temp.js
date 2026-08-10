/* 临时诊断：直接读 messages 表看测试对话（用完删） */
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
  // 最近会话
  const { data: sessions } = await supabase
    .from('sessions').select('id, name, updated_at').order('updated_at', { ascending: false }).limit(5);
  console.log('=== 最近会话 ===');
  for (const s of sessions || []) console.log(`${s.updated_at} | id=${s.id} | ${s.name}`);

  const sid = process.argv[2] || (sessions && sessions[0] && sessions[0].id);
  if (!sid) { console.log('无会话'); return; }

  const { data: msgs } = await supabase
    .from('messages').select('role, content, created_at')
    .eq('session_id', sid).eq('visible', true).order('created_at', { ascending: true });
  console.log(`\n=== 会话 ${sid} 消息（${(msgs || []).length} 条）===`);
  for (const m of msgs || []) {
    const who = m.role === 'user' ? '她' : '沈晏';
    console.log(`${m.created_at.slice(11, 19)} [${who}] ${m.content}`);
  }

  const { data: residue } = await supabase
    .from('dialogue_residue').select('created_at, grounding, concern, unfinished, evidence')
    .eq('session_id', sid).order('created_at', { ascending: false }).limit(5);
  console.log(`\n=== 该会话残留 ===`);
  for (const r of residue || []) {
    console.log(`${r.created_at} | g=${r.grounding} | concern=${r.concern}`);
    console.log(`  evidence=${JSON.stringify(r.evidence)} | unfinished=${r.unfinished || '(无)'}`);
  }
})().catch(e => console.error('💥', e.message));
