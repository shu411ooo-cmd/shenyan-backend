-- ============================================================
-- 2026-08-26 世界书（world_entries）
-- 她定下的世界设定/客观知识：对话里提到某关键词，沈晏把它想起。
-- 与 memory_topics 的区别：记忆是他「记住的」（自动形成、可推断），
-- 世界书是她「写下的」（她定义客观事实，他按关键词取用）。
-- 在 Supabase SQL Editor 手动执行（不自动迁移）。幂等，可重跑。
-- ============================================================

CREATE TABLE IF NOT EXISTS world_entries (
  id UUID DEFAULT gen_random_uuid() PRIMARY KEY,
  content TEXT NOT NULL,                        -- 世界设定正文（客观陈述）
  keywords TEXT[] NOT NULL DEFAULT '{}',        -- 触发关键词 tag（他对话里命中就想起）
  enabled BOOLEAN NOT NULL DEFAULT true,        -- 停用开关：写了不想让他想起就关掉
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS idx_world_entries_enabled ON world_entries (enabled);

ALTER TABLE world_entries DISABLE ROW LEVEL SECURITY;
