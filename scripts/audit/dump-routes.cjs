/* 遍历 Express 运行时路由栈，导出「方法 + 完整路径 + 注册顺序」。
   权威基线：不受源码正则盲区影响，挂载路由(app.use)也能看见。

   Express 5 不再把挂载前缀暴露在 layer.path/layer.regexp 上（藏在 matchers 闭包里），
   所以在 require server.js **之前**先给 express 的 application.use 打补丁，
   注册那一刻就把前缀记到 router 函数上。

   用法: node dump-routes.cjs <输出文件> */
const ROOT = require('path').resolve(__dirname, '..', '..');   // 仓库根（scripts/audit/ 往上两级）

const out = process.argv[2];
if (!out) { console.error('用法: node dump-routes.cjs <输出文件>'); process.exit(1); }

process.env.SUPABASE_URL = process.env.SUPABASE_URL || 'https://example.supabase.co';
process.env.SUPABASE_KEY = process.env.SUPABASE_KEY || 'probe';

const EXPRESS = ROOT + '/node_modules/express';
const application = require(EXPRESS + '/lib/application.js');
const origUse = application.use;
application.use = function patchedUse(...args) {
  if (typeof args[0] === 'string') {
    for (const a of args.slice(1)) {
      if (typeof a === 'function' && a.stack) { try { a.__mountPath = args[0]; } catch (e) {} }
    }
  }
  return origUse.apply(this, args);
};

const m = require(ROOT + '/server.js');
const app = m.app;
if (!app) { console.error('server.js 没导出 app'); process.exit(1); }

const routes = [];
function walk(stack, prefix) {
  for (const layer of stack) {
    if (layer.route) {
      // 挂载前缀 + router.get('/') 拼出来会是 '/api/moments/'，但 Express 实际把
      // 不带尾斜杠的 /api/moments 也路由到这个 handler（2026-09-09 起本地服务实测：
      // /api/moments 与 /api/moments/ 都进了 handler，对照组 /api/xxx 才 404）。
      // 所以这里归一化掉多余的尾斜杠，否则搬运前后比对会出现假差异。
      const rawPath = prefix + layer.route.path;
      const p = rawPath.length > 1 ? rawPath.replace(/\/+$/, '') : rawPath;
      for (const method of Object.keys(layer.route.methods || {})) {
        if (layer.route.methods[method]) routes.push(`${method.toUpperCase()} ${p}`);
      }
    } else if (layer.handle && layer.handle.stack) {
      const mount = layer.handle.__mountPath || '';
      walk(layer.handle.stack, prefix + mount);
    }
  }
}
walk((app.router || app._router).stack, '');

require('fs').writeFileSync(out, JSON.stringify(routes, null, 2) + '\n');
console.log(`导出 ${routes.length} 条路由 → ${out}`);
const un = routes.filter((r) => !/^[A-Z]+ \//.test(r));
if (un.length) console.log('⚠️ 路径可疑（前缀没解析出来？）:', un.slice(0, 5).join(' | '));
for (const r of routes.filter((x) => x.includes('/api/keepalive') || x.includes('/api/backup'))) console.log('   ' + r);
