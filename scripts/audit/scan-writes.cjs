/* 全仓扫描：代码里所有 .insert({...}) / .update({...}) 写的列，表里到底有没有。
   缺一个列 → 整条写入被 Postgres 拒绝 → 如果调用点是 fire-and-forget 或
   catch 里只 warn，就会永久静默失败（09-09 的 prompt_injections 就是这么死的十天）。
   全程只读：只做 .select(col).limit(1) 探列是否存在。 */
const ROOT = require('path').resolve(__dirname, '..', '..');   // 仓库根（scripts/audit/ 往上两级）

const fs = require('fs');
const NL = String.fromCharCode(10);
const t = fs.readFileSync(ROOT + '/.env', 'utf8');
for (const raw of t.split(NL)) {
  const l = raw.replace(/\r$/, ''); const i = l.indexOf('=');
  if (i > 0 && /^[A-Z][A-Z0-9_]*$/.test(l.slice(0, i))) process.env[l.slice(0, i)] = l.slice(i + 1);
}
const { createClient } = require(ROOT + '/node_modules/@supabase/supabase-js');
const sb = createClient(process.env.SUPABASE_URL, process.env.SUPABASE_KEY);

const src = fs.readFileSync(ROOT + '/server.js', 'utf8');

/* 找 .from('table') ... .insert({ ... }) 或 .update({ ... })
   只取对象字面量的**顶层键**；跨行、嵌套用括号配平找边界。 */
function extractWrites(text) {
  const out = [];
  const re = /\.from\(\s*['"`]([a-zA-Z_][\w]*)['"`]\s*\)([\s\S]{0,600}?)\.(insert|update|upsert)\(\s*\{/g;
  let m;
  while ((m = re.exec(text))) {
    const table = m[1], op = m[3];
    const start = re.lastIndex - 1;              // 指向 '{'
    let depth = 0, end = -1;
    for (let i = start; i < text.length && i < start + 4000; i++) {
      const ch = text[i];
      if (ch === '{') depth++;
      else if (ch === '}') { depth--; if (depth === 0) { end = i; break; } }
    }
    if (end < 0) continue;
    const body = text.slice(start + 1, end);
    // 顶层键：depth 0 处的 identifier: 或 'identifier':
    const keys = []; let d = 0;
    const lines = body.split(NL);
    for (const lineRaw of lines) {
      const line = lineRaw.replace(/\r$/, '');
      if (d === 0) {
        const km = line.match(/^\s*(?:\.\.\.)?\s*['"`]?([a-zA-Z_][\w]*)['"`]?\s*:/);
        if (km) keys.push(km[1]);
        if (/^\s*\.\.\./.test(line)) keys.push('…展开');
      }
      for (const ch of line) { if (ch === '{' || ch === '[' || ch === '(') d++; else if (ch === '}' || ch === ']' || ch === ')') d--; }
    }
    out.push({ table, op, keys, line: text.slice(0, m.index).split(NL).length });
  }
  return out;
}

(async () => {
  const writes = extractWrites(src);
  console.log(`扫到写入点 ${writes.length} 处${NL}`);

  // 按表汇总要检查的列
  const byTable = {};
  for (const w of writes) {
    byTable[w.table] = byTable[w.table] || { cols: new Set(), sites: [] };
    for (const k of w.keys) if (k !== '…展开') byTable[w.table].cols.add(k);
    byTable[w.table].sites.push(`L${w.line} ${w.op}`);
  }

  const problems = [];
  for (const table of Object.keys(byTable).sort()) {
    const { cols, sites } = byTable[table];
    const missing = [];
    for (const c of [...cols].sort()) {
      const { error } = await sb.from(table).select(c).limit(1);
      if (error && /does not exist/i.test(error.message)) missing.push(c);
      else if (error && !/does not exist/i.test(error.message)) missing.push(`${c}(?${error.message.slice(0, 40)})`);
    }
    if (missing.length) {
      problems.push({ table, missing, sites });
      console.log(`❌ ${table}`);
      console.log(`   缺列: ${missing.join(', ')}`);
      console.log(`   写入点: ${sites.slice(0, 4).join(' / ')}`);
    } else {
      console.log(`✅ ${table}  (${cols.size} 列全在，${sites.length} 处写入)`);
    }
  }
  console.log(`${NL}有缺列的表: ${problems.length} / ${Object.keys(byTable).length}`);
})();
