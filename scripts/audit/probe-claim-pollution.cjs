/* ============================================================
   审计探针：历史 claim 污染范围（2026-09-11）

   目的：表达资格隔离（回响剔除）曾空转 ~10 天，之前产的 64 张镜子卡
         （44 张 verified）当时没做回声排除。若它们已毕业进
         personality_claim，石头里就混了「回响冒充的主动表达」。
   本探针只查：污染到底有没有发生、范围多大。

   判读逻辑（不是结论，是证据）：
     - mirror_cards 的 verified 卡里，有没有早于「台账可用」、又确实
       升进 personality_claim 的 → 如果有，逐个列出给沈晏拍板。
     - 边界处理：可靠下界 = prompt_injections 最早的入库时间
       （台账稳定的时刻）。早于此的 verified 卡 = 疑似未筛。
       若台账仍 0 行，则修复可能未生效 / 或历史上从未有过注入。

   ⛔ 全程只读：只有 .select()，没有 insert/update/delete。
   ⛔ 不打印任何密钥值（只读 .env 到 process.env，不输出）。
   ============================================================ */
const ROOT = require('path').resolve(__dirname, '..', '..');
const fs = require('fs');
const NL = String.fromCharCode(10);
const t = fs.readFileSync(ROOT + '/.env', 'utf8');
for (const raw of t.split(NL)) {
  const l = raw.replace(/\r$/, ''); const i = l.indexOf('=');
  if (i > 0 && /^[A-Z][A-Z0-9_]*$/.test(l.slice(0, i))) process.env[l.slice(0, i)] = l.slice(i + 1);
}
const { createClient } = require(ROOT + '/node_modules/@supabase/supabase-js');
const sb = createClient(process.env.SUPABASE_URL, process.env.SUPABASE_KEY);

const line = (s) => console.log(s);
const H = (s) => { line(''); line('===== ' + s + ' ====='); };
const iso = (x) => (x ? new Date(x).toISOString().replace('T', ' ').slice(0, 16) : '—');

// 动态探测一张表实际存在的列（历史 CSV 卡可能缺 08-23 后才加的列）
async function colsOf(table) {
  const { data, error } = await sb.from(table).select('*').limit(1);
  if (error || !data || !data[0]) return error ? { err: error.message } : { empty: true };
  return { cols: Object.keys(data[0]), sample: data[0], empty: false };
}

// 归一化去重键（claim_norm 同样逻辑：去引号/空白）
const norm = (s) => String(s || '').replace(/["“”"'']/g, '').replace(/\s+/g, '').trim();

// 去程度修饰词（claimMatch 同类：strict 子串优先，失败后删程度词再比）
const DE_MOD = ['其实', '真的', '确实', '实在', '非常', '特别', '超级', '很', '挺', '有点', '有些'];
function stripMod(s) { return DE_MOD.reduce((a, w) => a.replace(new RegExp(w, 'g'), ''), s); }

async function run() {
  H('镜像卡 与 人格主张 的列结构（判断历史卡能否追溯）');
  const mc = await colsOf('mirror_cards');
  const pc = await colsOf('personality_claim');
  if (mc.err || pc.err) { line('❌ 探列失败: ' + (mc.err || pc.err)); return; }
  line('mirror_cards 列: ' + (mc.empty ? '(空表)' : mc.cols.join(', ')));
  line('personality_claim 列: ' + (pc.empty ? '(空表)' : pc.cols.join(', ')));
  const hasElig = mc.empty || mc.cols.includes('expression_eligible');

  H('P0 台账整流期边界：prompt_injections 最早入库时刻');
  const { data: piFirst } = await sb.from('prompt_injections').select('created_at').order('created_at', { ascending: true }).limit(1);
  const { data: piLast } = await sb.from('prompt_injections').select('created_at').order('created_at', { ascending: false }).limit(1);
  const piCountR = await sb.from('prompt_injections').select('*', { count: 'exact', head: true });
  line(`prompt_injections 总行数: ${piCountR.error ? '❌' + piCountR.error.message : piCountR.count}`);
  line(`台账最早: ${iso(piFirst && piFirst[0] && piFirst[0].created_at)}`);
  line(`台账最晚: ${iso(piLast && piLast[0] && piLast[0].created_at)}`);
  if (piCountR.error && !piCountR.error.message) line('（表可能不存在）');

  H('P1 mirror_cards：全量时间轴 + verified 分段');
  const mcAll = await sb.from('mirror_cards').select('*').order('created_at', { ascending: true });
  if (mcAll.error) { line('❌ 读 mirror_cards 失败: ' + mcAll.error.message); return; }
  const cards = mcAll.data || [];
  line('mirror_cards 总行数: ' + cards.length);
  if (!cards.length) { line('→ 空表：无历史卡，污染无从谈起。结案。'); return; }
  const byVerified = {}, byDirection = {}, byState = {}, byMonth = {};
  let verifiedCount = 0, preVerified = 0, healthyVerified = 0;
  for (const c of cards) {
    byVerified[c.verified ? 'verified' : 'not_verified'] = (byVerified[c.verified ? 'verified' : 'not_verified'] || 0) + 1;
    if (c.direction) { byDirection[c.direction] = (byDirection[c.direction] || 0) + 1; }
    const m = (c.created_at || '').slice(0, 7);
    if (m) byMonth[m] = (byMonth[m] || 0) + 1;
    if (c.verified) verifiedCount++;
    const before = !piFirst || !piFirst[0] || !piFirst[0].created_at || (c.created_at < piFirst[0].created_at);
    if (c.verified && before) preVerified++;
    if (c.verified && !before) healthyVerified++;
  }
  line(`按 verified: ` + JSON.stringify(byVerified));
  line(`按 direction: ` + JSON.stringify(byDirection) + '  （历史卡无此列 → 显示空）');
  line(`按月分布: ` + JSON.stringify(byMonth));
  const boundaryTs = piFirst && piFirst[0] && piFirst[0].created_at;
  if (boundaryTs) {
    line(`— 台账可用下界 ${iso(boundaryTs)} —`);
    line(`· 早于下界的 verified 卡（疑似未筛）: ${preVerified}`);
    line(`· 晚于下界的 verified 卡（yoga 正常筛选）: ${healthyVerified}`);
    if (hasElig) {
      const elig = cards.filter(c => c.expression_eligible === false);
      line(`· expression_eligible=false 的回响卡: ${elig.length}（仅 08-23+ 有该列）`);
    }
  }

  H('P2 已升进 personality_claim 的可疑卡（污染实锤线）');
  const pcAll = await sb.from('personality_claim').select('*');
  if (pcAll.error) { line('❌ 读 personality_claim 失败: ' + pcAll.error.message); return; }
  const claims = pcAll.data || [];
  line('personality_claim 总行数: ' + claims.length);
  if (boundaryTs && preVerified > 0 && claims.length) {
    // 把早于下界的 verified 卡 与 所有 claim 匹配（claimMatch 语义）
    const suspicious = cards.filter(c => c.verified && c.created_at < boundaryTs);
    const hits = [];
    for (const c of suspicious) {
      const cNorm = norm(c.claim);
      for (const p of claims) {
        const pNorm = norm(p.claim);
        if (!cNorm || !pNorm) continue;
        let matched = cNorm === pNorm || (cNorm && pNorm && (pNorm.includes(cNorm) || cNorm.includes(pNorm)));
        if (!matched) {
          const cs = stripMod(cNorm), ps = stripMod(pNorm);
          matched = cs && ps && (ps.includes(cs) || cs.includes(ps));
        }
        if (matched) {
          hits.push({
            cardCreated: c.created_at, cardQuote: (c.quote || '').slice(0, 30),
            claim: p.claim, state: p.state,
            claimCreated: p.created_at,
            session: p.distinct_sessions && p.distinct_sessions.length ? p.distinct_sessions.length : (p.last_confirmed_at ? '…' : '?'),
          });
          break;
        }
      }
    }
    line(`早于下界的 verified 卡共 ${suspicious.length} 张；其中命中库里 claim 的 ${hits.length} 张：`);
    if (!hits.length) {
      line('→ 0 命中：没有历史卡对应到现有 claim → 污染实际未发生（可能那些卡当年就 DROP / 判决弱 / 未过门槛）。');
    } else {
      for (const h of hits) {
        line(`   🗿「${h.claim.slice(0, 26)}」state=${h.state}  session集=${h.session}  claim建=${iso(h.claimCreated)}  卡=${iso(h.cardCreated)}「${h.cardQuote}」`);
      }
      line('→ 命中这些 claim 需要人工复核：它们是否来自回响。方法是 P3。');
    }
  } else {
    line(boundaryTs ? '（无可疑卡或 claim 表空，跳过匹配）' : '（台账仍为空/无下界，无法切段——不能据此认定无污染，需人工定边界）');
  }

  // 参照输入
  H('参照：最近真实输入（判断「空」是否因没聊天）');
  for (const [tbl, col] of [['sessions', 'created_at'], ['mirror_cards', 'created_at']]) {
    const { data, error } = await sb.from(tbl).select(col).order(col, { ascending: false }).limit(1);
    line(`${tbl.padEnd(16)} 最新: ${error ? '❌' + error.message : iso(data && data[0] ? data[0][col] : null)}`);
  }
  line('');
  line('（结束 · 全程只读）');
}
run().catch((e) => { console.error('探针异常:', e.message); process.exit(1); });