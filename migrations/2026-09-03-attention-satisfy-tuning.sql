-- ============================================================
-- 注意力召回 + 满足回落 调参列（2026-09-03 落地，默认值 = server.js 硬编码值）
-- 作用：把「近7天位限 / 联想席位 / 回声压制 / 满足回落」的参数提到 settings 表，
--       不重新部署也能调。server.js 读不到这些列时回退到同款默认值（可先跑代码后跑迁移）。
-- 执行：Supabase Dashboard → SQL Editor → 粘贴本文件 → Run（幂等，可重复跑）
-- ============================================================

-- —— 注意力召回名额与回声压制 ——
ALTER TABLE settings ADD COLUMN IF NOT EXISTS attention_recent_days      integer DEFAULT 7;   -- 近 N 天算「最近」
ALTER TABLE settings ADD COLUMN IF NOT EXISTS attention_recent_seats     integer DEFAULT 3;   -- 最近记忆最多占位数（上限非保底）
ALTER TABLE settings ADD COLUMN IF NOT EXISTS attention_assoc_seats      integer DEFAULT 2;   -- 关系扩展联想独立席位
ALTER TABLE settings ADD COLUMN IF NOT EXISTS attention_echo_24h_hours   integer DEFAULT 24;  -- 回声压制窗口①：N 小时内注入过
ALTER TABLE settings ADD COLUMN IF NOT EXISTS attention_echo_24h_factor  real    DEFAULT 0.5;  -- 窗口①内的打分系数（0~1，越小压得越狠）
ALTER TABLE settings ADD COLUMN IF NOT EXISTS attention_echo_72h_hours   integer DEFAULT 72;  -- 回声压制窗口②
ALTER TABLE settings ADD COLUMN IF NOT EXISTS attention_echo_72h_factor  real    DEFAULT 0.8;  -- 窗口②内的打分系数

-- —— 驱动满足回落（她刚来过 → 「想要」类驱动向底色回落）——
ALTER TABLE settings ADD COLUMN IF NOT EXISTS satisfy_window_hours integer DEFAULT 6;   -- 她 N 小时内来过 = 刚满足
ALTER TABLE settings ADD COLUMN IF NOT EXISTS satisfy_factor      real    DEFAULT 0.8;  -- 回落系数（0~1）