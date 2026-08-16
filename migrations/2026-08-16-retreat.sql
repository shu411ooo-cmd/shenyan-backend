-- ============================================================
-- 第④阶段：小黑屋（Retreat）· mirror_cards 加拍板列
-- 2026-08-16 · 对应 docs/want-phase4-retreat.md
-- 执行：Supabase Dashboard → SQL Editor → 粘贴本文件 → Run
-- 效果：mirror_cards 加 verdict（confirm/revise/drop/pass）+ note + 时间
-- ============================================================

ALTER TABLE mirror_cards ADD COLUMN IF NOT EXISTS verdict text;
ALTER TABLE mirror_cards ADD COLUMN IF NOT EXISTS verdict_note text;
ALTER TABLE mirror_cards ADD COLUMN IF NOT EXISTS verdict_at timestamptz;

-- 验证：SELECT verdict, count(*) FROM mirror_cards GROUP BY verdict;
