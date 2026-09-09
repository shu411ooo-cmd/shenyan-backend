// ===== 路由表护栏（node:test）=====
// 存在理由：server.js 曾经 9600 行、23 个业务域挤在一起，路由注册顺序的冲突肉眼看不出来。
// 2026-09-08 实锤：POST /api/keepalive/check 被 58 行之前的 /api/keepalive/:action 吃掉，
// 外部 cron 兜底入口从上线起就一直 400。这是第二次踩路由顺序（第一次是 reflection），
// 所以把规则钉成测试，而不是钉成注释。
//
// 2026-09-09 改为**运行时遍历**（原来是正则扫源码）：
//   分区第 2 步开始把路由域搬进 routes/*.js 并用 app.use('/前缀', router) 挂载，
//   源码正则看不见挂载路由 —— 第一次搬完 backup 就漏掉了两条。
//   改成 require server.js 后遍历 Express 真实路由栈，挂载与否都算得准。
//   Express 5 不再把挂载前缀暴露在 layer.path/regexp 上（藏在 matchers 闭包里），
//   所以先给 express 的 application.use 打补丁，注册那一刻把前缀记到 router 上。
//
// 两条断言：
//   ① 无遮蔽——同方法、同段数下，带 :param 的路由不得注册在同形静态路由之前。
//   ② 快照——完整路由表（方法+路径+顺序）与 routes.snapshot.json 一致。
//      拆分 server.js 时每搬一块就跑一次：快照没变 = 搬运没改变对外行为。
//      有意增删路由时用 `node test/routes.test.cjs --update` 重生成，diff 进 commit 复核。

const { test } = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const path = require('path');

const SNAPSHOT = path.join(__dirname, 'routes.snapshot.json');

function collectRoutes() {
  // require server.js 会连 supabase 客户端；给假值即可（不发请求，listen 有 require.main 守卫）
  process.env.SUPABASE_URL = process.env.SUPABASE_URL || 'https://example.supabase.co';
  process.env.SUPABASE_KEY = process.env.SUPABASE_KEY || 'test-placeholder';

  const application = require('express').application;
  if (!application.__mountPatched) {
    const origUse = application.use;
    application.use = function patchedUse(...args) {
      if (typeof args[0] === 'string') {
        for (const a of args.slice(1)) {
          if (typeof a === 'function' && a.stack) { try { a.__mountPath = args[0]; } catch (e) { /* 冻结的就算了 */ } }
        }
      }
      return origUse.apply(this, args);
    };
    application.__mountPatched = true;
  }

  const app = require('../server.js').app;
  assert.ok(app, 'server.js 必须导出 app，否则护栏无从遍历');

  const out = [];
  (function walk(stack, prefix) {
    for (const layer of stack) {
      if (layer.route) {
        for (const [method, on] of Object.entries(layer.route.methods || {})) {
          if (on) out.push({ method: method.toUpperCase(), path: prefix + layer.route.path });
        }
      } else if (layer.handle && layer.handle.stack) {
        walk(layer.handle.stack, prefix + (layer.handle.__mountPath || ''));
      }
    }
  })((app.router || app._router).stack, '');
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
      if (shadows && hasParam) bad.push({ later, earlier, li: i, ei: j });
    }
  }
  return bad;
}

if (require.main === module && process.argv.includes('--update')) {
  const list = collectRoutes().map((r) => `${r.method} ${r.path}`);
  fs.writeFileSync(SNAPSHOT, JSON.stringify(list, null, 2) + '\n');
  console.log(`✅ 快照已更新：${list.length} 条路由 → ${path.relative(process.cwd(), SNAPSHOT)}`);
  process.exit(0);
}

test('路由表：没有被动态路由遮蔽的静态路由', () => {
  const bad = findShadowed(collectRoutes());
  const detail = bad
    .map(({ later, earlier, li, ei }) =>
      `  ${later.method} ${later.path} (第 ${li + 1} 个注册) 永远匹配不到` +
      ` —— 被 ${earlier.path} (第 ${ei + 1} 个) 先接走了`)
    .join('\n');
  assert.strictEqual(bad.length, 0,
    `发现 ${bad.length} 处路由遮蔽：\n${detail}\n` +
    `修法：把静态路径的注册挪到带 :param 的那条之前。`);
});

test('路由表：与快照一致（拆分 server.js 时的行为不变式）', () => {
  const actual = collectRoutes().map((r) => `${r.method} ${r.path}`);
  assert.ok(fs.existsSync(SNAPSHOT), '缺少快照文件。先跑：node test/routes.test.cjs --update');
  const expected = JSON.parse(fs.readFileSync(SNAPSHOT, 'utf8'));
  assert.deepStrictEqual(actual, expected,
    '路由表变了。搬运路由到 routes/*.js 时这里应当纹丝不动；\n' +
    '若是有意增删，跑 `node test/routes.test.cjs --update` 重生成快照并 diff 复核。');
});
