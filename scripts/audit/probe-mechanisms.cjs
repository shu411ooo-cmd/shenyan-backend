/* ============================================================
   审计探针：净本 §4 剩下的四条机制「到底在不在跑」（2026-09-10）

   四条 + 各自的留痕位置（读代码确认过，不是猜的）：
     ① provenance     → prompt_injections.prov / .layer
     ② 声音渲染层      → ⚠️ 无持久痕迹（进程内 Map + 静默降级），只能间接看
     ③ 关系边          → memory_relations 表 + request_stats.attention_hits
     ④ 感知天线(天气/device) → prompt_injections.layer in ('weather','device')

   ⛔ 全程只读：只有 .select()，没有 insert/update/delete。
   ⛔ 不打印任何密钥值（只读 .env 里的 URL/KEY 到 process.env，不输出）。
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

/* 只读计数：表不存在/列不存在都返回 {n:null, err}，不抛 */
async function count(table, build) {
  let q = sb.from(table).select('*', { count: 'exact', head: true });
  if (build) q = build(q);
  const { count: n, error } = await q;
  return error ? { n: null, err: error.message } : { n };
}

/* 只读取样 */
async function sample(table, cols, limit = 3000) {
  const { data, error } = await sb.from(table).select(cols).limit(limit);
  return error ? { data: null, err: error.message } : { data: data || [] };
}

(async () => {
  line('审计探针 · 只读 · 2026-09-10');

  // ---------- ① / ④ prompt_injections：provenance + 天气 + device ----------
  H('①④ prompt_injections（provenance / 天气 / device 的共同落点）');
  const piAll = await count('prompt_injections');
  if (piAll.err) {
    line(`❌ 查不到表: ${piAll.err}`);
  } else {
    line(`总行数: ${piAll.n}`);
    if (piAll.n === 0) {
      line('⚠️ 空表 —— 但先问「有没有输入」：她 08-31 后没聊天，空可能是正常的（见 §7 末尾纪律）');
    }
    const r = await sample('prompt_injections', 'layer, tag, prov, expression_eligible, created_at', 5000);
    if (r.err) { line(`❌ 取样失败: ${r.err}`); }
    else {
      const byLayer = {}, byTag = {};
      let provNull = 0, earliest = null, latest = null;
      for (const row of r.data) {
        byLayer[row.layer || '(null)'] = (byLayer[row.layer || '(null)'] || 0) + 1;
        byTag[row.tag || '(null)'] = (byTag[row.tag || '(null)'] || 0) + 1;
        if (row.prov == null) provNull++;
        const ts = row.created_at;
        if (ts) { if (!earliest || ts < earliest) earliest = ts; if (!latest || ts > latest) latest = ts; }
      }
      line(`取样 ${r.data.length} 行；时间跨度 ${earliest || '—'} → ${latest || '—'}`);
      line(`prov 为 null 的行: ${provNull} / ${r.data.length}`);
      line('-- 按 layer 分布 --');
      for (const k of Object.keys(byLayer).sort()) line(`   ${k.padEnd(18)} ${byLayer[k]}`);
      line('-- 按 tag 分布 --');
      for (const k of Object.keys(byTag).sort()) line(`   ${k.padEnd(18)} ${byTag[k]}`);
      line('');
      line('判读：provenance 的 8 种来源是否都出现过？天气/device 两个天线有没有进过货？');
    }
  }

  // ---------- ③ 关系边 ----------
  H('③ memory_relations（1~2 hop 因果邻居）');
  const relAll = await count('memory_relations');
  if (relAll.err) {
    line(`❌ 查不到表: ${relAll.err}`);
  } else {
    line(`总行数: ${relAll.n}`);
    if (relAll.n && relAll.n > 0) {
      const r = await sample('memory_relations', '*', 2000);
      if (r.err) line(`❌ 取样失败: ${r.err}`);
      else {
        const cols = Object.keys(r.data[0] || {});
        line(`列: ${cols.join(', ')}`);
        // 方向性：同一对点是否两个方向都有边
        const fwd = new Set(), rev = new Set();
        const pick = (o, names) => { for (const n of names) if (o[n] != null) return String(o[n]); return null; };
        for (const row of r.data) {
          const a = pick(row, ['source_topic', 'from_topic', 'from_topic_id', 'a', 'src', 'from']);
          const b = pick(row, ['target_topic', 'to_topic', 'to_topic_id', 'b', 'dst', 'to']);
          if (a == null || b == null) continue;
          fwd.add(`${a}->${b}`); rev.add(`${b}->${a}`);
        }
        const back = [...fwd].filter((k) => rev.has(k)).length;
        line(`方向统计: 有向边 ${fwd.size} 条；其中 ${back} 条的「反向边」也存在（双向），${fwd.size - back} 条只有单向`);
        const pred = {};
        for (const row of r.data) { const p = row.rel_type || row.predicate || row.kind || row.relation || row.type || '(无)'; pred[p] = (pred[p] || 0) + 1; }
        line('-- 边类型分布 --');
        for (const k of Object.keys(pred).sort()) line(`   ${k.padEnd(18)} ${pred[k]}`);
      }
    } else {
      line('⚠️ 空表 —— 关系边从没写进来过');
    }
    // 只读探一条已知存在的边，看能不能被检索层拿到（形状验证）
    const probe = await sb.from('memory_relations').select('*').limit(1);
    if (!probe.error && probe.data && probe.data[0]) {
      const r = probe.data[0];
      const idCol = ['from_topic', 'from_topic_id', 'source', 'from'].find((c) => r[c] != null);
      if (idCol) {
        const val = r[idCol];
        const { error: e2 } = await sb.from('memory_relations').select('*').eq(idCol, val).limit(1);
        line(`探列类型 ${idCol}=${JSON.stringify(val)}: ${e2 ? '❌ ' + e2.message : '✅ 可查'}`);
      }
    }
  }

  // ---------- ③c 关键：关系边的端点值能不能对上 memory_topics.topic ----------
  // 这是方法④「拿真实值去 .eq() 探」的变体：值对不上 = 关系扩展是死代码，
  // 形状和 prompt_injections.session_id 建成 uuid 那次一样（都是「表建对了，值接不上」）。
  H('③c 关系边端点 → memory_topics 能不能接上（关系扩展是否死代码）');
  {
    const rel = await sample('memory_relations', 'source_topic, target_topic', 2000);
    const top = await sample('memory_topics', 'topic, kind, grounding, last_content', 5000);
    if (rel.err || top.err) line(`❌ 查询失败: ${rel.err || top.err}`);
    else {
      const names = new Set(top.data.map((r) => String(r.topic || '')));
      const endpoints = new Set();
      for (const r of rel.data) { if (r.source_topic != null) endpoints.add(String(r.source_topic)); if (r.target_topic != null) endpoints.add(String(r.target_topic)); }
      const missing = [...endpoints].filter((e) => !names.has(e));
      const hit = endpoints.size - missing.length;
      line(`关系边用到 ${endpoints.size} 个不同端点；其中 ${hit} 个能在 memory_topics.topic 里找到，${missing.length} 个找不到`);
      if (missing.length) {
        line('找不到的端点（前 12 个）:');
        for (const m of missing.slice(0, 12)) line(`   ❌ ${JSON.stringify(m)}`);
        line('→ 如果全找不到，getRelationNeighbors 的过滤/匹配就是空转（死代码）');
      } else {
        line('✅ 全部端点都能对上 —— 关系扩展的数据接口是通的');
      }
      // 反向：有没有 memory_topics.topic 重复（.in() 匹配会放大）
      const dupCount = {};
      for (const r of top.data) { const k = String(r.topic || ''); dupCount[k] = (dupCount[k] || 0) + 1; }
      const dups = Object.entries(dupCount).filter(([, n]) => n > 1);
      line(`memory_topics 里 topic 名重复的有 ${dups.length} 个${dups.length ? '（.in() 匹配会放大行数）' : ''}`);
      for (const [k, n] of dups.slice(0, 8)) line(`   ⚠️ ${JSON.stringify(k)} × ${n}`);
      // voiceify 生效面：kind != 'feel' 的才走渲染
      const byKind = {};
      for (const r of top.data) { const k = r.kind || '(null)'; byKind[k] = (byKind[k] || 0) + 1; }
      line('memory_topics 按 kind: ' + Object.entries(byKind).map(([k, n]) => `${k}=${n}`).join('  ') + '  （kind≠feel 的才走 voiceify）');
    }
  }

  // ---------- ④b 世界书：为什么 672 行只注入 1 次 ----------
  H('④b world_entries（世界书为何几乎不注入）');
  {
    const we = await count('world_entries');
    if (we.err) line(`❌ 查不到表: ${we.err}`);
    else {
      line(`world_entries 总行数: ${we.n}`);
      if (we.n === 0) line('→ 空表：retrieveWorld 自然返回 []，worldInjected 恒 false。代码注释也写着「世界书空表（当前）」。');
      else {
        const r = await sample('world_entries', 'kind, enabled, title', 1000);
        if (r.err) line(`❌ 取样失败: ${r.err}`);
        else {
          const byKind = {}, byEnabled = {};
          for (const row of r.data) {
            const k = row.kind || '(null)'; byKind[k] = (byKind[k] || 0) + 1;
            const e = String(row.enabled); byEnabled[e] = (byEnabled[e] || 0) + 1;
          }
          line('按 kind: ' + Object.entries(byKind).map(([k, n]) => `${k}=${n}`).join('  '));
          line('按 enabled: ' + Object.entries(byEnabled).map(([k, n]) => `${k}=${n}`).join('  '));
          line('→ 若 enabled=false 占多数，或 kind 都不在 selectWorldHits 允许的档位里，就会「有行但不注入」');
        }
      }
    }
    // 保留席/普通块的两条路各自留过什么日志、需要什么条件（代码事实，供人判读）
    line('代码事实：注入需要 opts.userMessage && !opts.keepalive && opts.memory !== false，');
    line('          然后 retrieveWorld(userMessage) 有命中，再过 selectWorldHits(worlds, curMode) 的档位矩阵。');
  }

  // ---------- ③b request_stats：attention / 注入类诊断列 ----------
  H('③b request_stats.attention_hits（关系边有没有真的被用上）');
  const rsAll = await count('request_stats');
  if (rsAll.err) line(`❌ 查不到表: ${rsAll.err}`);
  else {
    line(`总行数: ${rsAll.n}`);
    const r = await sample('request_stats', 'attention_injected, attention_hits, world_injected, residue_injected, memory_degraded, created_at', 6000);
    if (r.err) { line(`❌ 取样失败（可能列没迁移）: ${r.err}`); }
    else {
      let ai = 0, ahPos = 0, ahMax = 0, wi = 0, ri = 0, md = 0, earliest = null, latest = null;
      for (const row of r.data) {
        if (row.attention_injected) ai++;
        const h = Number(row.attention_hits);
        if (Number.isFinite(h) && h > 0) { ahPos++; if (h > ahMax) ahMax = h; }
        if (row.world_injected) wi++;
        if (row.residue_injected) ri++;
        if (row.memory_degraded) md++;
        const ts = row.created_at;
        if (ts) { if (!earliest || ts < earliest) earliest = ts; if (!latest || ts > latest) latest = ts; }
      }
      const n = r.data.length;
      line(`取样 ${n} 行；时间跨度 ${earliest || '—'} → ${latest || '—'}`);
      line(`attention_injected 有值: ${ai}`);
      line(`attention_hits > 0    : ${ahPos}（最大 ${ahMax}）`);
      line(`world_injected 有值   : ${wi}`);
      line(`residue_injected 有值 : ${ri}`);
      line(`memory_degraded 有值  : ${md}`);
      line('');
      line('判读：attention_injected 有值但 attention_hits 恒 0 → 注意力块注入了但一条都没召回（≠关系边在跑）');
    }
  }

  // ---------- ② 声音渲染层：间接痕迹 ----------
  H('② voiceifyMemory（声音渲染层）—— 无直接痕迹，看间接证据');
  line('代码事实：渲染结果只进进程内 voiceCache，失败静默返回原文，不写任何表、成功不打日志。');
  line('→ 只能间接判：attention 块的内容是否与 memory_topics 原始正文不同（改了口吻）。');
  const att = await count('prompt_injections', (q) => q.eq('layer', 'attention'));
  if (att.err) line(`❌ prompt_injections(layer=attention) 查询失败: ${att.err}`);
  else line(`layer=attention 的注入行数: ${att.n}`);
  const mt = await count('memory_topics');
  if (mt.err) line(`❌ memory_topics 查询失败: ${mt.err}`);
  else line(`memory_topics 总行数: ${mt.n}`);

  // ---------- 参照：最近有没有输入 ----------
  H('参照：最近的真实输入（判断「空」是不是因为没输入）');
  for (const [tbl, col] of [['sessions', 'created_at'], ['request_stats', 'created_at'], ['prompt_injections', 'created_at']]) {
    const { data, error } = await sb.from(tbl).select(col).order(col, { ascending: false }).limit(1);
    if (error) line(`${tbl.padEnd(20)} ❌ ${error.message}`);
    else line(`${tbl.padEnd(20)} 最新 ${data && data[0] ? data[0][col] : '（空）'}`);
  }
  line('');
  line('（结束 · 全程只读）');
})();
