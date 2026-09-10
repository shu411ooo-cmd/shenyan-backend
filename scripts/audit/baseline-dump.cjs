/* ============================================================
   立行为基线 / 等价性比对（2026-09-10，为分区第 3 步写的）

   交接文档 §1 方法第 2 条要求「动刀前先立行为基线，用测试向量跑一遍存 JSON」。
   上一轮（第 1/2 步）是手工做的，这次做成常驻工具：**同一份 spec，既可以指向
   搬迁前的旧代码，也可以指向搬完后的新模块**，输出必须逐字节相同。

   两种取数方式：
     ① --rev HEAD            从 git 里取 server.js，按 spec.ranges 切行、eval 出函数
     ② --module lib/xxx.js   直接 require 搬完后的模块，用它的导出
   两次输出 JSON 一致 = 这次搬迁是行为等价的（不是「看起来对」）。

   用法：
     node scripts/audit/baseline-dump.cjs --spec scripts/audit/specs/context-select.cjs --rev HEAD
     node scripts/audit/baseline-dump.cjs --spec scripts/audit/specs/context-select.cjs --module lib/context/select.js
     node scripts/audit/baseline-dump.cjs --spec ... --rev HEAD --out test/fixtures/xxx.baseline.json
     node scripts/audit/baseline-dump.cjs --spec ... --module lib/... --compare test/fixtures/xxx.baseline.json

   spec 文件（CommonJS）：
     module.exports = {
       ranges: [[1992, 2037]],        // rev 模式：要 eval 的行区间（含首含尾）
       expose: ['topicHits'],         // rev 模式：要把哪些名字暴露出来
       prelude: '',                   // 可选：eval 前要垫的桩代码
       calls: [                       // 要跑并落盘的调用
         { name: 'topicHits', run: (A) => [[msg, topic], ...].map(([m, t]) => A.topicHits(m, t)) },
       ],
     };

   注意：结果里 Set/Map 会被规范化成排序数组，才能 JSON 往返比较（extractNgrams 返回 Set）。
   ============================================================ */
const ROOT = require('path').resolve(__dirname, '..', '..');
const fs = require('fs');
const path = require('path');
const vm = require('vm');
const { execFileSync } = require('child_process');

/* ---------- 结果规范化：Set/Map/undefined 都要能进 JSON ---------- */
function norm(v, depth = 0) {
  if (depth > 12) return '<deep>';
  if (v === undefined) return { __undefined: true };
  if (v === null) return null;
  if (typeof v === 'number') { if (Number.isNaN(v)) return { __nan: true }; if (!Number.isFinite(v)) return { __inf: v > 0 ? 1 : -1 }; return v; }
  if (typeof v === 'function') return '<function>';
  if (typeof v !== 'object') return v;
  if (v instanceof Set) return { __set: [...v].map((x) => norm(x, depth + 1)).sort() };
  if (v instanceof Map) return { __map: [...v.entries()].map(([k, x]) => [norm(k, depth + 1), norm(x, depth + 1)]).sort((a, b) => String(a[0]) < String(b[0]) ? -1 : 1) };
  if (Array.isArray(v)) return v.map((x) => norm(x, depth + 1));
  const out = {};
  for (const k of Object.keys(v).sort()) out[k] = norm(v[k], depth + 1);
  return out;
}

/* ---------- 从 git rev 切行 eval ---------- */
function fromRev(spec, rev) {
  const src = execFileSync('git', ['show', `${rev}:server.js`], { cwd: ROOT, encoding: 'utf8', maxBuffer: 64 * 1024 * 1024 });
  const L = src.replace(/\r/g, '').split('\n');
  let block = '';
  for (const [s, e] of spec.ranges) {
    const slice = L.slice(s - 1, e).join('\n');
    if (!slice.trim()) throw new Error(`rev 模式：区间 ${s}-${e} 切出来是空的（行号错了？）`);
    block += slice + '\n';
  }
  const code = `${spec.prelude || ''}\n${block}\n;({ ${spec.expose.join(', ')} })`;
  const sandbox = { console, Set, Map, Math, JSON, Object, Array, String, Number, Date, Boolean, RegExp, NaN, Infinity, isNaN, parseInt, parseFloat, undefined };
  return vm.runInNewContext(code, vm.createContext(sandbox), { filename: `<${rev}:server.js ${spec.ranges.map((r) => r.join('-')).join(',')}>` });
}

/* ---------- 从模块取 ---------- */
function fromModule(spec, rel) {
  const abs = path.resolve(ROOT, rel);
  if (!fs.existsSync(abs)) throw new Error(`模块不存在: ${rel}`);
  const mod = require(abs);
  const A = {};
  for (const n of spec.expose) {
    if (!(n in mod)) throw new Error(`模块 ${rel} 没有导出 ${n}（expose 里写了但它不在 module.exports 上？）`);
    A[n] = mod[n];
  }
  return A;
}

/* ---------- CLI ---------- */
const argv = process.argv.slice(2);
const arg = (name) => { const i = argv.indexOf(name); return i === -1 ? null : argv[i + 1]; };

const specPath = arg('--spec');
if (!specPath) { console.error('用法见文件头。至少要 --spec <spec.cjs> 和 --rev/--module 之一。'); process.exit(1); }
const spec = require(path.resolve(ROOT, specPath));

const rev = arg('--rev');
const modPath = arg('--module');
if (!rev && !modPath) { console.error('❌ 要 --rev <git rev> 或 --module <相对路径> 之一'); process.exit(1); }

const A = rev ? fromRev(spec, rev) : fromModule(spec, modPath);
const out = {};
for (const c of spec.calls) out[c.name] = norm(c.run(A));

const json = JSON.stringify(out, null, 2);
const comparePath = arg('--compare');

if (comparePath) {
  const abs = path.resolve(ROOT, comparePath);
  if (!fs.existsSync(abs)) { console.error(`❌ 基线文件不存在: ${comparePath}`); process.exit(1); }
  // 只把「行尾/文件尾空白」归一化——写文件时 `json + '\n'`、stdout 里没有那个换行，
  // 第一版就因为这个尾换行报了一次假「不一致」（逐键比对一条差异都打不出来）。
  const norm = (s) => s.replace(/\r/g, '').replace(/\s+$/, '');
  const base = norm(fs.readFileSync(abs, 'utf8'));
  const mine = norm(json);
  if (base === mine) {
    console.log(`✅ 与基线逐字节一致：${comparePath}`);
    console.log(`   （${spec.calls.length} 组调用，${spec.calls.map((c) => c.name).join(', ')}）`);
    process.exit(0);
  }
  console.error(`❌ 与基线**不一致**：${comparePath}\n`);
  const b = JSON.parse(base), m = JSON.parse(mine);
  for (const k of Object.keys(b)) {
    const bs = JSON.stringify(b[k]), ms = JSON.stringify(m[k]);
    if (bs !== ms) {
      console.error(`  ── ${k} 不同 ──`);
      console.error(`  基线: ${bs.slice(0, 800)}`);
      console.error(`  现在: ${ms.slice(0, 800)}`);
    }
  }
  process.exit(1);
}

const outPath = arg('--out');
if (outPath) {
  const abs = path.resolve(ROOT, outPath);
  fs.mkdirSync(path.dirname(abs), { recursive: true });
  fs.writeFileSync(abs, json + '\n', 'utf8');
  console.log(`✅ 基线已写入 ${outPath}（来源 ${rev ? `git rev ${rev}` : modPath}）`);
  console.log(`   ${spec.calls.map((c) => c.name).join(', ')}`);
} else {
  console.log(json);
}
