-- ============================================================
-- 2026-08-29 世界书注入分层（世界书注入分层·外部审核稿 落地）
-- 在 Supabase SQL Editor 手动执行（不自动迁移）。幂等，可重跑。
--
-- 做什么：
--   1. world_entries 加 kind 列：setting 设定 / remind 关系提醒 / know 知识卡。
--      一条一个主 kind（不设 mixed，混合拆两条、关键词可重叠）；旧条目全部回落 setting，
--      符合「存量不动」惯例（kind NOT NULL DEFAULT 'setting' 天然做到）。
--   2. request_stats 观测列：world_injected / world_kind / world_mode——
--      验收「这次注入带没带世界书、带了什么 kind、在什么 mode 门下」。
-- ============================================================

-- ---------- 1. 世界书条目类型 ----------
ALTER TABLE world_entries ADD COLUMN IF NOT EXISTS kind TEXT NOT NULL DEFAULT 'setting';
CREATE INDEX IF NOT EXISTS idx_world_entries_kind ON world_entries (kind);
COMMENT ON COLUMN world_entries.kind IS '世界书注入分层 kind：setting 设定（她定的世界）/ remind 关系提醒（我们的规矩·约定·专属称呼）/ know 知识卡（客观知识·工具卡）。一条一个主 kind，混合拆两条；亲密 mode 下 remind 只走 exact（保留席，≤1）';

-- ---------- 2. request_stats 观测 ----------
ALTER TABLE request_stats ADD COLUMN IF NOT EXISTS world_injected BOOLEAN;
ALTER TABLE request_stats ADD COLUMN IF NOT EXISTS world_kind TEXT;
ALTER TABLE request_stats ADD COLUMN IF NOT EXISTS world_mode TEXT;
