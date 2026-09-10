/* ============================================================
   审计探针：把 request_stats 的「盲区窗口」和「live_* 首行」钉死（2026-09-10）

   起因：git 证据（6e26306 08-30 21:32 才引入 live_anchor_turn/collapsed/tokens_est）
   与「这三个非空的首行 = 08-30 20:33:57」互相矛盾 —— 至少有一个是错的。
   本探针只做一件事：把 DB 里的事实原样打出来，不解释。

   ⛔ 全程只读：只有 .select()，没有任何写操作。
   ⛔ 不打印任何密钥值。
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
const LIVE = ['live_anchor_turn', 'live_collapsed', 'live_tokens_est'];

/* 拉一个时间段的所有行（select * ，缺列/坏列都不会让整条查询 400） */
async function rowsBetween(from, to) {
  const { data, error } = await sb.from('request_stats')
    .select('*').eq('client', 'angel')
    .gte('created_at', from).lte('created_at', to)
    .order('id', { ascending: true }).limit(5000);
  return error ? { err: error.message } : { rows: data || [] };
}

/* 某列第一行非空 */
async function firstNonNull(col) {
  const { data, error } = await sb.from('request_stats')
    .select(`id,created_at,${col}`).not(col, 'is', null)
    .order('id', { ascending: true }).limit(1);
  return error ? { err: error.message } : { row: (data || [])[0] || null };
}

/* 打印一段里的行，顺带标出相邻两行间隔 > 20 分钟的「洞」 */
function report(label, rows) {
  if (!rows.length) { line(`${label}: 0 行`); return; }
  line(`${label}: ${rows.length} 行  首=${rows[0].created_at} (id ${rows[0].id})  末=${rows[rows.length - 1].created_at} (id ${rows[rows.length - 1].id})`);
  for (let i = 1; i < rows.length; i++) {
    const gapMin = (new Date(rows[i].created_at) - new Date(rows[i - 1].created_at)) / 60000;
    if (gapMin > 20) {
      line(`  ⏸ 洞 ${gapMin.toFixed(1)} 分：${rows[i - 1].created_at} (id ${rows[i - 1].id})  →  ${rows[i].created_at} (id ${rows[i].id})`);
      const a = rows[i - 1], b = rows[i];
      line(`     前一行 live_* = ${LIVE.map((k) => `${k}=${JSON.stringify(a[k])}`).join(' ')}`);
      line(`     后一行 live_* = ${LIVE.map((k) => `${k}=${JSON.stringify(b[k])}`).join(' ')}`);
      // 后一行有、前一行没有（或前者为 null）的键 = 洞期间新增/开始写的列
      const gained = Object.keys(b).filter((k) =>
        !(k in a) ? b[k] != null : (a[k] == null && b[k] != null));
      line(`     后一行新出现非空的列: ${gained.length ? gained.join(', ') : '（无）'}`);
    }
  }
}

(async () => {
  line('request_stats 盲区探针 · 只读 · 2026-09-10');

  H('A. 表结构（拿一行看键）');
  const { data: one, error: e1 } = await sb.from('request_stats').select('*').order('id', { ascending: false }).limit(1);
  if (e1) line('  取行失败: ' + e1.message);
  else line('  当前列(' + Object.keys(one[0] || {}).length + '): ' + Object.keys(one[0] || {}).sort().join(', '));

  H('B. 08-30 全天（angel）');
  const d30 = await rowsBetween('2026-08-30T00:00:00Z', '2026-08-30T23:59:59Z');
  if (d30.err) line('  失败: ' + d30.err); else report('  08-30', d30.rows);

  H('C. 08-15 / 08-08（复核上次报告的两个窗口）');
  const d15 = await rowsBetween('2026-08-15T00:00:00Z', '2026-08-15T23:59:59Z');
  if (d15.err) line('  08-15 失败: ' + d15.err); else report('  08-15', d15.rows);
  const d08 = await rowsBetween('2026-08-08T00:00:00Z', '2026-08-08T23:59:59Z');
  if (d08.err) line('  08-08 失败: ' + d08.err); else report('  08-08', d08.rows);

  H('D. live_* 三列各自「第一行非空」');
  for (const c of LIVE) {
    const r = await firstNonNull(c);
    line(r.err ? `  ${c}: 查询失败 ${r.err}` : `  ${c}: ${r.row ? `${r.row.created_at} (id ${r.row.id})` : '全表都是 null'}`);
  }

  H('F. 洞期内到底有没有对话（决定 freeze 起点）');
  // 6e26306（08-30 21:32:35+0800 = 13:32:35Z）才给 INSERT 加了 live_* 三列。
  // 若 11:45:26Z–13:32:35Z 之间**没有**对话，则「洞」= 空窗期，freeze 起点就是该部署上线时；
  // 若**有**对话，则真实起点更早，6e26306 不是全部原因。
  const { data: msgs, error: e6 } = await sb.from('messages')
    .select('id,created_at,role').gte('created_at', '2026-08-30T11:45:26Z')
    .lte('created_at', '2026-08-30T20:33:57Z').order('created_at', { ascending: true }).limit(5000);
  if (e6) line('  查询失败: ' + e6.message);
  else {
    const rows = msgs || [];
    line(`  洞内消息总数: ${rows.length}`);
    const byRole = {};
    for (const r of rows) byRole[r.role] = (byRole[r.role] || 0) + 1;
    line('  按 role: ' + JSON.stringify(byRole));
    if (rows.length) line(`  首=${rows[0].created_at} 末=${rows[rows.length - 1].created_at}`);
    const cut = '2026-08-30T13:32:35Z'; // 6e26306 提交时刻
    const before = rows.filter((r) => r.created_at < cut);
    line(`  提交前(11:45:26Z–13:32:35Z = 本地 19:45–21:32) 的消息数: ${before.length}`);
    if (before.length) line(`    首=${before[0].created_at} 末=${before[before.length - 1].created_at}`);
  }

  H('G. 全表洞分析 —— 每个洞内到底丢了几轮对话');
  // 关键：request_stats 的「相邻两行间隔」本身**不是**丢行数。她可能整晚没聊天。
  // 只有「洞内真的有 assistant 回复」才叫丢。逐洞去 messages 里数。
  {
    const { data: all, error: eg } = await sb.from('request_stats')
      .select('id,created_at').eq('client', 'angel').order('id', { ascending: true }).limit(10000);
    if (eg) line('  取行失败: ' + eg.message);
    else {
      const rows = all || [];
      line(`  request_stats(angel) 总行数: ${rows.length}`);
      line(`  时间跨度: ${rows[0]?.created_at} → ${rows[rows.length - 1]?.created_at}`);
      let lostTotal = 0, gapCount = 0;
      for (let i = 1; i < rows.length; i++) {
        const a = rows[i - 1], b = rows[i];
        const gapMin = (new Date(b.created_at) - new Date(a.created_at)) / 60000;
        if (gapMin <= 30) continue;              // 30 分钟以内算正常活动间隙
        gapCount++;
        // 数洞内的 assistant 回复（= 真的被服务的轮次）
        const { data: inGap, error: ec } = await sb.from('messages')
          .select('id,created_at,session_id')
          .eq('role', 'assistant')
          .gt('created_at', a.created_at).lt('created_at', b.created_at)
          .order('created_at', { ascending: true }).limit(2000);
        const list = inGap || [];
        // 洞内回复里**最后一条**通常就是洞后那一行自己的回复（行在回复之后写），不算丢
        const lost = Math.max(0, list.length - 1);
        if (ec) line(`  洞 ${gapMin.toFixed(1)}分  查询失败: ${ec.message}`);
        else {
          lostTotal += lost;
          line(`  洞 ${gapMin.toFixed(1)}分 ${a.created_at} (id ${a.id}) → ${b.created_at} (id ${b.id})`);
          line(`     洞内 assistant 回复=${list.length}  ⇒ 丢 ${lost} 轮`
            + (list.length ? `；实际对话只占 ${list[0].created_at} → ${list[list.length - 1].created_at}` : ''));
          if (list.length > 1) {
            const sess = [...new Set(list.map((m) => m.session_id))];
            line(`     轮次 id 范围 ${list[0].id}–${list[list.length - 1].id}  session=${sess.join(',')}`);
          }
        }
      }
      line(`  ⇒ 所有洞合计：${gapCount} 个洞，洞内 assistant 回复共 ${lostTotal} 条（这些轮次的成本**没有**进账本）`);
    }
  }

  H('E. 列出所有「带 live_ 前缀」的列是否真的存在');
  if (one && one[0]) {
    const all = Object.keys(one[0]);
    line('  含 live 的列: ' + (all.filter((k) => /live/i.test(k)).join(', ') || '（无）'));
  }
})();
