/* ============================================================
   精确自由变量分析（2026-09-10，为分区第 3 步写的）

   为什么不用 dep.cjs：它靠一份硬编码的「已知符号」白名单猜依赖，第 3 步的
   context/memory/wake 三个域咬得紧，白名单漏一个就是运行期 ReferenceError。
   本工具用 esprima 真解析 + 真作用域，逐字节算「这块代码到底引用了块外的什么」。

   用法：
     node scripts/audit/free-vars.cjs <起始行> [结束行]
     node scripts/audit/free-vars.cjs 2853 3334
     node scripts/audit/free-vars.cjs --fn buildModelContext
     node scripts/audit/free-vars.cjs --list            # 列顶层声明及其行号

   输出三节：
     A. 区内定义的顶层名字（搬走要交出去）
     B. 自由的「本文件顶层符号」← 这才是要注入的依赖清单（带定义行号）
     C. 自由的「真外部」符号（console/process/require… 全局，不用管）

   注意：`--fn` 找的是顶层 function 声明（含 async）。块内嵌套函数用行号切。
   ============================================================ */
const ROOT = require('path').resolve(__dirname, '..', '..');
const fs = require('fs');
// acorn（devDependency）——esprima 4 停在 ES2017，server.js 里的对象展开
// （`{...extraHeaders}`，ES2018）它直接解析不了。生产 `npm install --omit=dev` 不装它。
const acorn = require(ROOT + '/node_modules/acorn');

const SRC = fs.readFileSync(ROOT + '/server.js', 'utf8').replace(/\r/g, '');

/* ---------- 1. 解析 ---------- */
let ast;
try {
  ast = acorn.parse(SRC, { ecmaVersion: 'latest', sourceType: 'script', locations: true });
} catch (e) {
  console.error('❌ 解析失败（server.js 有语法错误？）:', e.message);
  process.exit(1);
}

/* ---------- 2. 顶层声明表：名字 → 行号 ---------- */
const topLevel = new Map(); // name -> { line, kind }
function addTop(name, line, kind) {
  if (!topLevel.has(name)) topLevel.set(name, { line, kind });
}
for (const st of ast.body) {
  if (st.type === 'FunctionDeclaration' && st.id) addTop(st.id.name, st.loc.start.line, 'function');
  else if (st.type === 'ClassDeclaration' && st.id) addTop(st.id.name, st.loc.start.line, 'class');
  else if (st.type === 'VariableDeclaration') {
    for (const d of st.declarations) for (const n of patternNames(d.id)) addTop(n, st.loc.start.line, st.kind);
  }
}

/* ---------- 3. 模式里绑定的名字 ---------- */
function patternNames(node, out = []) {
  if (!node) return out;
  switch (node.type) {
    case 'Identifier': out.push(node.name); break;
    case 'ObjectPattern':
      for (const p of node.properties) {
        if (p.type === 'RestElement') patternNames(p.argument, out);
        else patternNames(p.value, out);
      }
      break;
    case 'ArrayPattern':
      for (const el of node.elements) if (el) patternNames(el, out);
      break;
    case 'AssignmentPattern': patternNames(node.left, out); break;
    case 'RestElement': patternNames(node.argument, out); break;
  }
  return out;
}

/* ---------- 4. 遍历器：需要哪些子节点、哪些是「引用」 ---------- */
const SKIP_KEYS = new Set(['loc', 'range', 'type', 'parent', 'leadingComments', 'trailingComments']);

function childNodes(node) {
  const out = [];
  for (const k of Object.keys(node)) {
    if (SKIP_KEYS.has(k)) continue;
    const v = node[k];
    if (Array.isArray(v)) for (const c of v) { if (c && c.type) out.push([k, c]); }
    else if (v && v.type) out.push([k, v]);
  }
  return out;
}

/* 在当前作用域链里找名字 */
function resolve(scopes, name) {
  for (let i = scopes.length - 1; i >= 0; i--) if (scopes[i].has(name)) return true;
  return false;
}

/* 收集一个函数/块「自己绑定」的名字（不含参数，参数单独处理） */
function hoistInto(scope, body) {
  // 只收 function 声明和 var（函数级提升）；let/const 严格来说块级，但保守多收只会少报自由变量，
  // 这里为了「宁可漏报也不误报成自由变量」，把块内的 let/const 也收进最近的函数作用域。
  const walk = (node) => {
    if (!node || typeof node !== 'object') return;
    if (node.type === 'FunctionDeclaration' && node.id) scope.add(node.id.name);
    if (node.type === 'VariableDeclaration') for (const d of node.declarations) for (const n of patternNames(d.id)) scope.add(n);
    if (node.type === 'ClassDeclaration' && node.id) scope.add(node.id.name);
    // 不下钻进嵌套函数（它们有自己的作用域，名字不外泄）
    if (node.type === 'FunctionExpression' || node.type === 'ArrowFunctionExpression' || node.type === 'FunctionDeclaration') return;
    for (const [, c] of childNodes(node)) walk(c);
  };
  for (const s of body) walk(s);
  return scope;
}

/* 核心：算一组语句的自由变量（自由 = 解析不到本组内绑定，且不在给定作用域链里） */
function freeVarsOfStatements(statements, outerScopes) {
  const free = new Map(); // name -> 出现行号列表
  const hit = (name, line) => {
    if (!free.has(name)) free.set(name, []);
    if (!free.get(name).includes(line)) free.get(name).push(line);
  };

  const visit = (node, scopes) => {
    if (!node || typeof node !== 'object') return;
    switch (node.type) {
      case 'Identifier':
        if (!resolve(scopes, node.name)) hit(node.name, node.loc.start.line);
        return;
      case 'ThisExpression':
      case 'Super':
      case 'Literal':
      case 'TemplateElement':
      case 'PrivateIdentifier':
        return;
      case 'MemberExpression':
        visit(node.object, scopes);
        if (node.computed) visit(node.property, scopes);
        return;
      case 'Property':
        if (node.computed) visit(node.key, scopes);
        visit(node.value, scopes);
        return;
      case 'MethodDefinition':
      case 'PropertyDefinition':
        if (node.computed) visit(node.key, scopes);
        visit(node.value, scopes);
        return;
      case 'LabeledStatement':
        visit(node.body, scopes);
        return;
      case 'BreakStatement':
      case 'ContinueStatement':
        return;
      case 'MetaProperty':
        return;
      case 'FunctionDeclaration':
      case 'FunctionExpression':
      case 'ArrowFunctionExpression': {
        const scope = new Set();
        for (const p of node.params) for (const n of patternNames(p)) scope.add(n);
        if (node.type === 'FunctionExpression' && node.id) scope.add(node.id.name);
        if (node.body.type === 'BlockStatement') hoistInto(scope, node.body.body);
        else scope.add('arguments'); // 表达式体箭头函数没有自己的 arguments，但无害
        const next = [...scopes, scope];
        if (node.body.type === 'BlockStatement') {
          for (const s of node.body.body) visit(s, next);
        } else visit(node.body, next);
        return;
      }
      case 'BlockStatement': {
        const scope = new Set();
        const stmts = node.body;
        const walk = (n) => {
          if (!n || typeof n !== 'object') return;
          if (n.type === 'VariableDeclaration') for (const d of n.declarations) for (const nm of patternNames(d.id)) scope.add(nm);
          if (n.type === 'FunctionDeclaration' && n.id) scope.add(n.id.name);
          if (n.type === 'ClassDeclaration' && n.id) scope.add(n.id.name);
          if (n.type === 'FunctionExpression' || n.type === 'ArrowFunctionExpression' || n.type === 'FunctionDeclaration') return;
          for (const [, c] of childNodes(n)) walk(c);
        };
        for (const s of stmts) walk(s);
        const next = [...scopes, scope];
        for (const s of stmts) visit(s, next);
        return;
      }
      case 'ForStatement':
      case 'ForInStatement':
      case 'ForOfStatement': {
        const scope = new Set();
        if (node.left && node.left.type === 'VariableDeclaration') {
          for (const d of node.left.declarations) for (const n of patternNames(d.id)) scope.add(n);
        }
        if (node.init && node.init.type === 'VariableDeclaration') {
          for (const d of node.init.declarations) for (const n of patternNames(d.id)) scope.add(n);
        }
        const next = [...scopes, scope];
        for (const [, c] of childNodes(node)) {
          if (c === node.left || c === node.init) { if (c.type !== 'VariableDeclaration') visit(c, next); }
          else visit(c, next);
        }
        return;
      }
      case 'CatchClause': {
        const scope = new Set(patternNames(node.param));
        for (const [, c] of childNodes(node.body)) visit(c, [...scopes, scope]);
        return;
      }
      case 'VariableDeclarator':
        if (node.init) visit(node.init, scopes);
        return;
      case 'ObjectPattern':
      case 'ArrayPattern':
      case 'AssignmentPattern':
      case 'RestElement':
        return; // 解构模式在 visit(decl) 那侧处理；这里只走「默认值里的引用」
      default:
        for (const [, c] of childNodes(node)) visit(c, scopes);
    }
  };

  for (const st of statements) visit(st, outerScopes);
  return free;
}

/* ---------- 5. 取语句集合 ---------- */
function statementsInRange(startLine, endLine) {
  // 完全落在区间内的顶层语句
  return ast.body.filter((s) => s.loc.start.line >= startLine && s.loc.end.line <= endLine);
}
function findTopFunction(name) {
  return ast.body.find((s) => s.type === 'FunctionDeclaration' && s.id && s.id.name === name) || null;
}

/* ---------- 6. CLI ---------- */
const argv = process.argv.slice(2);
if (!argv.length) {
  console.log('用法: node scripts/audit/free-vars.cjs <起行> [止行] | --fn <名字> | --list');
  process.exit(0);
}
if (argv[0] === '--list') {
  console.log('server.js 顶层声明（名字 / 行号 / 种类）:');
  for (const [n, v] of [...topLevel].sort((a, b) => a[1].line - b[1].line)) {
    console.log(`  ${String(v.line).padStart(5)}  ${v.kind.padEnd(8)} ${n}`);
  }
  process.exit(0);
}

let statements, label;
if (argv[0] === '--fn') {
  const fn = findTopFunction(argv[1]);
  if (!fn) { console.error(`❌ 没找到顶层函数 ${argv[1]}`); process.exit(1); }
  statements = [fn];
  label = `${argv[1]}()  行 ${fn.loc.start.line}–${fn.loc.end.line}`;
} else {
  const S = Number(argv[0]);
  const E = argv[1] ? Number(argv[1]) : Number.MAX_SAFE_INTEGER;
  statements = statementsInRange(S, E);
  if (!statements.length) { console.error('❌ 该区间内没有完整的顶层语句'); process.exit(1); }
  const realEnd = Math.max(...statements.map((s) => s.loc.end.line));
  label = `行 ${statements[0].loc.start.line}–${realEnd}（${statements.length} 条顶层语句）`;
  const skipped = ast.body.filter((s) => s.loc.start.line < S && s.loc.end.line >= S);
  if (skipped.length) console.log(`⚠️ 区间起点切在语句中间：${skipped.map((s) => `行 ${s.loc.start.line}`).join(', ')}（已排除）`);
}

/* 区内定义的名字 */
const definedInside = new Set();
for (const st of statements) {
  if (st.type === 'FunctionDeclaration' && st.id) definedInside.add(st.id.name);
  if (st.type === 'ClassDeclaration' && st.id) definedInside.add(st.id.name);
  if (st.type === 'VariableDeclaration') for (const d of st.declarations) for (const n of patternNames(d.id)) definedInside.add(n);
}

const MODULE_SCOPE = new Set(topLevel.keys());
// ⚠️ 外层作用域传空数组，不能传 MODULE_SCOPE —— 那等于告诉解析器「同名的一切都已被绑定」，
// 结果 B 节永远报「无」（第一版就栽在这，一个都没报出来）。模块级名字要在解析**之后**
// 按 topLevel 表分类，而不是在解析**之前**当作已绑定。
const free = freeVarsOfStatements(statements, []);

const needsInject = [];
const globals = [];
for (const [name, lns] of [...free].sort((a, b) => a[1][0] - b[1][0])) {
  if (definedInside.has(name)) continue;      // 自己定义的
  if (MODULE_SCOPE.has(name)) needsInject.push([name, lns]);
  else globals.push([name, lns]);
}

console.log(`\n===== ${label} =====\n`);
console.log('A. 区内定义（搬走要么留、要么交出去）:');
console.log('  ' + ([...definedInside].join(', ') || '（无）'));

console.log('\nB. ⚠️ 引用到的「本文件顶层符号」= 要注入的依赖清单:');
if (!needsInject.length) console.log('  ✅ 无（纯函数，直接搬）');
else for (const [n, lns] of needsInject) {
  const t = topLevel.get(n);
  console.log(`  ${n.padEnd(28)} 定义于 server.js:${t.line} (${t.kind})   用 ${lns.length} 处 @ 行 ${lns.slice(0, 8).join(',')}${lns.length > 8 ? '…' : ''}`);
}

console.log('\nC. 真外部（全局/Node 内建，不用注入）:');
console.log('  ' + (globals.map(([n]) => n).join(', ') || '（无）'));

console.log(`\n合计：区内定义 ${definedInside.size} 个，需注入 ${needsInject.length} 个，真外部 ${globals.length} 个。`);
