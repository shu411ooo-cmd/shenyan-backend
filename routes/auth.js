/* ============================================================
   C 方案登录门（2026-08-23 上线）

   2026-09-09 从 server.js 原样搬出（分区第 2 步收官）。逻辑一字未改。

   ⚠️ **这是整个分区里最危险的一块**：鉴权不是靠路由实现的，是靠**中间件注册顺序**：
        express.static → app.use('/api/auth', router) → app.use(requireAuth) → 其余所有路由
      顺序一旦搬错，所有请求照常 200、只是不再需要登录 —— 不报错、不告警，
      功能测试全绿，路由快照也测不出来（它只看路由表，不看中间件顺序）。
      所以动这块之前先补了 test/auth-gate.test.cjs，并往中间件里注入 `return next()`
      自证过它会红。**以后改这里，先跑 npm run test:auth。**

   交出两样，必须按这个顺序挂：
     router      —— /api/auth/login | logout | check
     requireAuth —— 门本身；它内部对 /health、/、/assets/、/api/auth/ 有豁免，
                    豁免项一条都不能少，少了等于把自己锁在门外（登录接口被自己拦住）

   历史：B 方案的 x-site-key 兜底已于 2026-09-08 全链路拆除（明文躺在公开 bundle 里，
   扒一次 JS 即可绕过）。现在**只认 cookie**，这也是为什么中间件顺序更要命了 ——
   它是唯一的门。
   ============================================================ */
const express = require('express');
const crypto = require('crypto');

module.exports = function createAuth({ supabase }) {
  if (!supabase) throw new Error('createAuth: 缺少 supabase 依赖');
  const router = express.Router();

// ===== C 方案：登录门（2026-08-23）=====
// 真正的门：密码登录 → HttpOnly cookie(sid) → 中间件校验 cookie。没密码谁都进不来。
// session 存 DB（auth_sessions，多实例可共享）；token 随机，HttpOnly+SameSite=Strict 不进 JS。
// 2026-09-08：B 方案 SITE_KEY 已正式退休（详见鉴权中间件注释）——登录只认 cookie。
const SITE_PASSWORD = process.env.SITE_PASSWORD || '';
const SESSION_TTL_MS = 7 * 24 * 3600 * 1000; // 7 天
const SESSION_COOKIE = 'sid';

function parseCookies(req) {
  const out = {};
  const h = req.headers.cookie || '';
  for (const part of h.split(';')) {
    const i = part.indexOf('=');
    if (i > 0) out[part.slice(0, i).trim()] = part.slice(i + 1).trim();
  }
  return out;
}

async function isValidSession(token) {
  if (!token) return false;
  try {
    const { data, error } = await supabase
      .from('auth_sessions')
      .select('id, expires_at')
      .eq('token', token)
      .maybeSingle();
    if (error || !data) return false;
    return new Date(data.expires_at).getTime() > Date.now();
  } catch { return false; }
}

// 登录：校验密码 → 种 HttpOnly cookie
// 登录频率限制：同一 IP 15 秒内最多 5 次尝试（防暴力破解）
const loginAttempts = new Map();
function checkLoginRateLimit(req) {
  const ip = req.ip || req.socket.remoteAddress || 'unknown';
  const now = Date.now();
  const key = `login:${ip}`;
  const entry = loginAttempts.get(key);
  if (entry && now - entry.since < 15000 && entry.count >= 5) return false;
  if (!entry || now - entry.since >= 15000) loginAttempts.set(key, { since: now, count: 1 });
  else entry.count++;
  return true;
}
// 每 5 分钟清理过期登录限流记录
setInterval(() => {
  const now = Date.now();
  for (const [k, v] of loginAttempts) if (now - v.since > 60000) loginAttempts.delete(k);
}, 5 * 60 * 1000).unref();

router.post('/login', async (req, res) => {
  if (!checkLoginRateLimit(req)) return res.status(429).json({ ok: false, error: '尝试太频繁，请稍后再试' });
  const pwd = String(req.body?.password || '');
  if (!SITE_PASSWORD || pwd !== SITE_PASSWORD) return res.status(401).json({ ok: false, error: '密码不对' });
  const token = require('crypto').randomBytes(32).toString('hex');
  const expires = new Date(Date.now() + SESSION_TTL_MS).toISOString();
  try {
    const { error } = await supabase.from('auth_sessions').insert({ token, expires_at: expires });
    if (error) return res.status(500).json({ ok: false, error: error.message });
  } catch (e) { return res.status(500).json({ ok: false, error: e.message }); }
  res.setHeader('Set-Cookie', `${SESSION_COOKIE}=${token}; HttpOnly; SameSite=Strict; Path=/; Max-Age=${SESSION_TTL_MS / 1000}`);
  res.json({ ok: true });
});

// 登出：删 session + 清 cookie
router.post('/logout', async (req, res) => {
  const token = parseCookies(req)[SESSION_COOKIE];
  if (token) {
    try {
      await supabase.from('auth_sessions').delete().eq('token', token);
    } catch { /* 删不掉就算了，cookie 已清 */ }
  }
  res.setHeader('Set-Cookie', `${SESSION_COOKIE}=; HttpOnly; SameSite=Strict; Path=/; Max-Age=0`);
  res.json({ ok: true });
});

// 检查登录态（前端 AuthGate 用）：无 cookie → 401，前端显示密码页
router.get('/check', async (req, res) => {
  const token = parseCookies(req)[SESSION_COOKIE];
  const ok = await isValidSession(token);
  if (ok) return res.json({ ok: true });
  return res.status(401).json({ ok: false });
});

// 鉴权中间件：静态资源/首页/健康检查放行；API 一律要登录态（cookie 登录门）
const requireAuth = async (req, res, next) => {
  try {
    if (req.path === '/health' || req.path === '/' || req.path.startsWith('/assets/')) return next();
    // 兜底锁：SITE_PASSWORD 没配时先不锁（防把自己锁死）
    if (!SITE_PASSWORD) return next();
    // auth 相关接口本身放行（login/logout/check 已各自处理）
    if (req.path.startsWith('/api/auth/')) return next();
    // 主校验：cookie session（await——isValidSession 是异步查库）
    const token = parseCookies(req)[SESSION_COOKIE];
    if (token && (await isValidSession(token))) return next();
    // B 方案 x-site-key 兜底已于 2026-09-08 拆除（server.js 的 SITE_KEY 常量 + Zeabur 环境变量一并清掉）。
    // 拆除理由与顺序（均已执行）：key 内联在公开 bundle 里、扒 JS 即得，只防路人不防定向；
    // 旧 bundle 还把 API_BASE 烧成 localhost → cookie 跨源不发，只能靠 key 撑着。
    // → 先前端同源化（src/config.js 生产 API_BASE=""，ed2a2a1）→ 无 key 前端部署
    //   （index-BepPaPQl.js，反断言无 key）+ 花园 cookie 承重确认 → 现在拆掉这个兜底。
    // ringdonut（backend/adapters/host.js）同源挂在主服务下，cookie 通道一致，一并拆除。
    return res.status(401).json({ error: 'unauthorized' });
  } catch (err) {
    console.error('💥 鉴权中间件异常:', err.message);
    return res.status(500).json({ error: 'auth error' });
  }
};

  return { router, requireAuth };
};
