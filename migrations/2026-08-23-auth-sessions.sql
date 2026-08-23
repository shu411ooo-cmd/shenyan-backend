-- ============================================================
-- C 方案：登录门 —— auth_sessions 会话表 · 2026-08-23
-- 背景：B 方案 SITE_KEY 防「路人乱扫」，但 key 在线上 JS 里可被扒。
--       C 方案 = 真正的门：密码登录 → HttpOnly cookie → 中间件校验 cookie，没密码谁都进不来。
-- session 存 DB（多实例可共享）；token 随机，HttpOnly 不进 JS。
-- ============================================================

CREATE TABLE IF NOT EXISTS auth_sessions (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  token text NOT NULL UNIQUE,             -- 随机 session token（Set-Cookie: sid=<token>）
  created_at timestamptz DEFAULT now(),
  expires_at timestamptz NOT NULL         -- 过期时间（默认 7 天，登录时算）
);

-- RLS：跟全站一致，只允许 service_role（前端不直连库）
ALTER TABLE public.auth_sessions ENABLE ROW LEVEL SECURITY;

-- 验证：
-- SELECT column_name FROM information_schema.columns
--   WHERE table_name = 'auth_sessions';
