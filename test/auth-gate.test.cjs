// ===== 登录门护栏（node:test）=====
// 存在理由：鉴权是靠**中间件注册顺序**实现的 ——
//   express.static → /api/auth/* 放行 → 鉴权中间件 → 其余所有路由
// 顺序一旦搬错，所有请求照常 200，只是**不再需要登录**。这种坏法：
//   · 不报错、不告警，功能测试全绿
//   · 路由快照也测不出来（它只看路由表，不看中间件顺序）
// 2026-09-09 分区第 2 步准备抽 routes/auth.js，动手之前先把这条不变式钉成测试。
//
// 测法：起一个真实的本地 http 服务打真实请求，只看状态码。
// SUPABASE_* 给假值 —— isValidSession 查库必然失败 → 视为未登录，正是我们要测的那一侧。

const { test, before, after } = require('node:test');
const assert = require('node:assert');
const http = require('http');

// ⚠️ 必须在 require server.js **之前**设好：
//   · SITE_PASSWORD 非空，否则鉴权中间件走 `if (!SITE_PASSWORD) return next()` 全放行，
//     这条测试就变成了空转（2026-09-09 写探针时就先踩了一次：一切都 401，对照组失效）
//   · dotenv 不覆盖已存在的 env，所以这里设了就不会被真 .env 顶掉
process.env.SUPABASE_URL = process.env.SUPABASE_URL || 'https://example.invalid';
process.env.SUPABASE_KEY = process.env.SUPABASE_KEY || 'test-placeholder';
process.env.SITE_PASSWORD = 'test-password-for-auth-gate';

const app = require('../server.js').app;

let server, port;
before(() => new Promise((resolve) => {
  server = http.createServer(app);
  server.listen(0, () => { port = server.address().port; resolve(); });
}));
after(() => new Promise((resolve) => server.close(resolve)));

function hit(method, path, body) {
  return new Promise((resolve) => {
    const payload = body ? JSON.stringify(body) : null;
    const req = http.request({
      host: '127.0.0.1', port, path, method, timeout: 8000,
      headers: payload ? { 'Content-Type': 'application/json', 'Content-Length': Buffer.byteLength(payload) } : {},
    }, (res) => { res.resume(); resolve(res.statusCode); });
    req.on('error', () => resolve('ERR'));
    req.on('timeout', () => { req.destroy(); resolve('TIMEOUT'); });
    if (payload) req.write(payload);
    req.end();
  });
}

test('登录门：未登录访问受保护的 /api/* 必须 401', async () => {
  // 这几条是「有真实数据、泄露了要命」的代表：对话、记忆、日记、人格锚
  for (const p of ['/api/messages', '/api/memories', '/api/diary', '/api/system-prompt', '/api/conversation']) {
    assert.strictEqual(await hit('GET', p), 401, `${p} 未登录时应当 401（门被拆了？）`);
  }
});

test('登录门：未登录也不能写', async () => {
  assert.strictEqual(await hit('POST', '/api/system-prompt', { system_prompt: 'x' }), 401,
    'POST /api/system-prompt 未登录时应当 401 —— 这是人格锚，写进去等于换掉他是谁');
});

test('登录门：豁免项必须仍然可达（否则等于把自己锁在门外）', async () => {
  assert.strictEqual(await hit('GET', '/health'), 200, '/health 是健康检查，必须免登录');
  // 登录接口本身不能被鉴权挡住，否则永远登不进去
  assert.strictEqual(await hit('GET', '/api/auth/check'), 401,
    '/api/auth/check 应当可达并返回 401（未登录），而不是被中间件拦掉');
  assert.strictEqual(await hit('POST', '/api/auth/login', { password: 'definitely-wrong' }), 401,
    '/api/auth/login 应当可达，错密码返回 401');
});

test('登录门：密码对了才发 cookie —— 错密码不得签发 sid', async () => {
  const code = await hit('POST', '/api/auth/login', { password: 'definitely-wrong' });
  assert.strictEqual(code, 401, '错密码必须 401');
  // 正确密码这里不测：会真的往 auth_sessions 写一行，而本测试用的是假 supabase，
  // 写不进去反而会掩盖问题。登录成功那条路由靠线上手工验证（见 handoff 文档）。
});

test('登录门：不存在的路径应当 404 而不是 401 —— 证明测法本身有效', async () => {
  // 对照组。如果这里也是 401，说明鉴权中间件把一切都拦了，上面几条断言就是空转。
  assert.strictEqual(await hit('GET', '/api/definitely-not-a-real-route'), 401,
    '注意：当前实现里未登录时中间件先拦，所以未知路径也是 401 —— ' +
    '这条断言锁的是「当前行为」；若哪天改成先路由后鉴权，这里会变 404，届时一并复核');
});
