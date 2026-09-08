// ===== 路由表护栏（node:test，纯静态分析，不 require server.js）=====
// 存在理由：server.js 9600 行、23 个业务域挤在一起，路由注册顺序的冲突肉眼看不出来。
// 2026-09-08 实锤：POST /api/keepalive/check 被 58 行之前的 /api/keepalive/:action 吃掉，
// 外部 cron 兜底入口从上线起就一直 400（docs/keepalive-impl-plan.md:259 的「保活+触发二合一」）。
// 这是第二次踩路由顺序（第一次是 reflection）。所以把规则钉成测试，而不是钉成注释。
//
// 两条断言：
//   ① 无遮蔽——同方法、同段数下，带 :param 的路由不得注册在同形静态路由之前。
//   ② 快照——路由表（方法+路径+顺序）与 routes.snapshot.json 一致。
//      拆分 server.js 时每搬一块就跑一次：快照没变 = 搬运没改变对外行为。
//      有意增删路由时用 `node test/routes.test.cjs --update` 重生成快照，diff 进 commit 复核。

const { test } = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const path = require('path');

const SERVER = path.join(__dirname, '..', 'server.js');
const SNAPSHOT = path.join(__dirname, 'routes.snapshot.json');

// 只认顶格 app.<method>('path' —— 与实际注册顺序一一对应。
// 子路由（app.use('/api/call', callRouter)）不在此列：它们是前缀挂载，天然不参与遮蔽。
function collectRoutes() {
  const lines = fs.readFileSync(SERVER, 'utf8').split('\n');
  const out = [];
  lines.forEach((line, i) => {
    const m = line.match(/^app\.(get|post|put|delete|patch)\(\s*['"`]([^'"`]+)/);
    if (m) out.push({ method: m[1].toUpperCase(), path: m[2], line: i + 1 });
  });
  return out;
}

/* 遮蔽判定：同方法 + 同段数，逐段比对。
   前者含 :param 且每个静态段都相同 → 前者会先匹配走，后者永远够不着。 */
function findShadowed(routes) {
  const bad = [];
  for (let i = 0; i < routes.length; i++) {
    for (let j = 0; j < i; j++) {
      const earlier = routes[j], later = routes[i];
      if (earlier.method !== later.method) continue;
      const a = earlier.path.split('/'), b = later.path.split('/');
      if (a.length !== b.length) continue;
      let shadows = true, hasParam = false;
      for (let k = 0; k < a.length; k++) {
        if (a[k].startsWith(':')) { hasParam = true; continue; }
        if (a[k] !== b[k]) { shadows = false; break; }
      }
      if (shadows && hasParam) bad.push({ later, earlier });
    }
  }
  return bad;
}

if (require.main === module && process.argv.includes('--update')) {
  const routes = collectRoutes().map(({ method, path: p }) => `${method} ${p}`);
  fs.writeFileSync(SNAPSHOT, JSON.stringify(routes, null, 2) + '\n');
  console.log(`✅ 快照已更新：${routes.length} 条路由 → ${path.relative(process.cwd(), SNAPSHOT)}`);
  process.exit(0);
}

test('路由表：没有被动态路由遮蔽的静态路由', () => {
  const bad = findShadowed(collectRoutes());
  const detail = bad
    .map(({ later, earlier }) =>
      `  ${later.method} ${later.path} (L${later.line}) 永远匹配不到` +
      ` —— 被 ${earlier.path} (L${earlier.line}) 先接走了`)
    .join('\n');
  assert.strictEqual(bad.length, 0,
    `发现 ${bad.length} 处路由遮蔽：\n${detail}\n` +
    `修法：把静态路径的注册挪到带 :param 的那条之前。`);
});

test('路由表：与快照一致（拆分 server.js 时的行为不变式）', () => {
  const actual = collectRoutes().map(({ method, path: p }) => `${method} ${p}`);
  if (!fs.existsSync(SNAPSHOT)) {
    assert.fail(`缺少快照文件。先跑：node test/routes.test.cjs --update`);
  }
  const expected = JSON.parse(fs.readFileSync(SNAPSHOT, 'utf8'));
  assert.deepStrictEqual(actual, expected,
    '路由表变了。若是有意增删，跑 `node test/routes.test.cjs --update` 重生成快照并 diff 复核。');
});
