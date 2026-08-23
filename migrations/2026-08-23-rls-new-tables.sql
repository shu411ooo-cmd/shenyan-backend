-- ============================================================
-- RLS 补全：新建表裸奔修复 · 2026-08-23
-- 背景：2026-08-13-rls.sql 开了老 10 表 RLS（ENABLE + 零 policy = 只允许 service_role）。
--       8.16 之后新建的 5 张表（石头/镜子卡/念头池/想要账本）从没跑过 RLS → anon 可读，裸奔。
--       后端已换 service_role（.env 已确认 sb_secret_...），应用绕过 RLS 不受影响，补开安全。
-- 策略：跟老表一致——ENABLE RLS + 不建 policy = 只允许 service_role；前端不直连库，不需要 anon 权限。
-- ============================================================

ALTER TABLE public.desires           ENABLE ROW LEVEL SECURITY;  -- want 账本（河）
ALTER TABLE public.mirror_cards      ENABLE ROW LEVEL SECURITY;  -- 镜子卡（支持/冲突/反证）
ALTER TABLE public.personality_claim ENABLE ROW LEVEL SECURITY;  -- 石头声明（人格生长）
ALTER TABLE public.stone_rings       ENABLE ROW LEVEL SECURITY;  -- 石头环
ALTER TABLE public.thought_pool      ENABLE ROW LEVEL SECURITY;  -- 念头池

-- 验证（Supabase SQL Editor 跑完查）：
-- SELECT relname, relrowsecurity FROM pg_class
--   WHERE relname IN ('desires','mirror_cards','personality_claim','stone_rings','thought_pool');
