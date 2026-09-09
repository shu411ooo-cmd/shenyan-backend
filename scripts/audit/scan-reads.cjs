/* 全仓扫描：代码里所有 .from('t').select('a, b, c') 读的列，表里到底有没有。
   PostgREST 只要有一个列不存在就**整条查询报错** —— 配上 `if (error) return DEFAULTS`
   或 catch 吞掉，就是整组静默失效（09-09 已实证 4 组配置这么死的）。
   全程只读。 */
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

/* 只认紧跟在 .from('t') 之后的第一个 .select('字面量')，中间不许出现别的 .from(
   —— 这样不会把邻近调用的列张冠李戴（上一版写入扫描就栽在这）。
   跳过 storage.from()（那是存储桶不是表）。 */
const re = /(?<!storage)\.from\(\s*['"`]([a-zA-Z_][\w]*)['"`]\s*\)((?:(?!\.from\()[\s\S]){0,300}?)\.select\(\s*['"`]([^'"`]*)['"`]/g;

const byTable = {};
let m, sites = 0;
while ((m = re.exec(src))) {
  const table = m[1];
  const raw = m[3].trim();
  if (!raw || raw === '*') continue;                 // select('*') 不会因列缺失报错
  if (/\(/.test(raw)) continue;                      // 带嵌套关系的先跳过，单独看
  const line = src.slice(0, m.index).split(NL).length;
  const cols = raw.split(',').map((s) => s.trim()).filter(Boolean);
  if (!cols.length) continue;
  sites++;
  byTable[table] = byTable[table] || { cols: new Map() };
  for (const c of cols) {
    if (!byTable[table].cols.has(c)) byTable[table].cols.set(c, []);
    byTable[table].cols.get(c).push(line);
  }
}

(async () => {
  console.log(`扫到读取点 ${sites} 处，涉及 ${Object.keys(byTable).length} 张表${NL}`);
  let bad = 0;
  for (const table of Object.keys(byTable).sort()) {
    const cols = byTable[table].cols;
    const missing = [];
    for (const c of [...cols.keys()].sort()) {
      const { error } = await sb.from(table).select(c).limit(1);
      if (error && /does not exist/i.test(error.message)) missing.push({ c, lines: cols.get(c) });
    }
    if (missing.length) {
      bad++;
      console.log(`❌ ${table}`);
      for (const x of missing) console.log(`   缺 ${x.c}   （读取点 L${[...new Set(x.lines)].join(', L')}）`);
    } else {
      console.log(`✅ ${table}  (${cols.size} 列全在)`);
    }
  }
  console.log(`${NL}有缺列的表: ${bad} / ${Object.keys(byTable).length}`);
})();
