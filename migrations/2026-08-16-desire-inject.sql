-- ============================================================
-- 第②阶段：醒来注入想要素材 · settings 宽表加参数列
-- 2026-08-16 · 对应 docs/want-phase2-keepalive.md
-- 执行：Supabase Dashboard → SQL Editor → 粘贴本文件 → Run
-- 效果：settings 表加 3 个可调参数列 + 1 个注入时间戳列
-- ============================================================

ALTER TABLE settings ADD COLUMN IF NOT EXISTS desire_inject_k integer DEFAULT 3;
ALTER TABLE settings ADD COLUMN IF NOT EXISTS desire_inject_cooldown_days integer DEFAULT 3;
ALTER TABLE settings ADD COLUMN IF NOT EXISTS desire_inject_dim_threshold integer DEFAULT 3;
ALTER TABLE settings ADD COLUMN IF NOT EXISTS desire_inject_at timestamptz;

-- 验证：SELECT desire_inject_k, desire_inject_cooldown_days, desire_inject_dim_threshold, desire_inject_at FROM settings WHERE session_id = 'global';
