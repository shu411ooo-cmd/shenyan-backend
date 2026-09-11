/* ============================================================
   只读探针：拉出 personality_claim 的全部行 + 关联的 source 卡
   (2026-09-11) 全程只读。
   ============================================================ */
const ROOT = require('path').resolve(__dirname, '..', '..');
const fs = require('fs');
const NL = String.fromCharCode(10);
const t = fs.readFileSync(ROOT + '/.env', 'utf8');
for (const raw of t.split(NL)) {
  const l = raw.replace(/\r$/, '');
  const i = l.indexOf('=');
  if (i > 0 && /^[A-Z][A-Z0-9_]*$/.test(l.slice(0, i))) process.env[l.slice(0, i)] = l.slice(i + 1);
}
const { createClient } = require(ROOT + '/node_modules/@supabase/supabase-js');
const sb = createClient(process.env.SUPABASE_URL, process.env.SUPABASE_KEY);
const iso = (x) => (x ? new Date(x).toISOString().replace('T', ' ').slice(0, 16) : '—');

async function run() {
  console.log('===== personality_claim 全部 =====');
  const { data, error } = await sb.from('personality_claim').select('*');
  if (error) { console.log('❌', error.message); return; }
  for (const c of data || []) {
    console.log('---');
    console.log('claim:', c.claim);
    console.log('state:', c.state, '| confidence:', c.confidence, '| support:', c.support_count,
      '| strong:', c.strong_count, '| weak:', c.weak_count, '| contradiction:', c.contradiction_count);
    console.log('distinct_sessions:', JSON.stringify(c.distinct_sessions));
    console.log('confirmed_ats:', JSON.stringify((c.confirm_occurred_ats || []).map(iso)));
    console.log('first/last confirmed:', iso(c.first_confirmed_at), '/', iso(c.last_confirmed_at));
    console.log('source_card_ids:', (c.source_card_ids || []).join(', ') || '(none)');
    console.log('ring/grew_from/superseded:', c.ring_id || '-', '/', c.grew_from || '-', '/', c.superseded_by || '-');
    console.log('created/updated:', iso(c.created_at), '/', iso(c.updated_at));
    // 关联卡
    const ids = (c.source_card_ids || []).slice(0, 50);
    if (ids.length) {
      const { data: cards, error: ce } = await sb.from('mirror_cards').select('*').in('id', ids);
      if (!ce && cards) {
        console.log('-- 关联卡', cards.length, '张 --');
        for (const m of cards) {
          console.log(`  [${m.direction || '?'}] verified=${m.verified} echo=${m.echo ?? '-'} elig=${m.expression_eligible ?? '-'} speaker=${m.speaker ?? '-'} ini=${m.initiation ?? '-'} at ${iso(m.occurred_at)}`);
          console.log(`     quote: ${m.quote}`);
          console.log(`     claim: ${m.claim}`);
        }
      }
    }
  }
  console.log('（结束 · 全程只读）');
}
run().catch((e) => { console.error('异常:', e.message); process.exit(1); });