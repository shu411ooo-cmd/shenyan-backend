-- ============================================================
-- 2026-08-26 相册（keepsakes）
-- 聊天里发的每张图 = 一张 keepsake。图本身存 moments 桶 keepsakes/ 前缀，
-- 这表是它的索引 + 记忆：描述（=视觉记忆）+ 他当时说的话 + 他当时的思考。
-- 在 Supabase SQL Editor 手动执行（不自动迁移）。幂等，可重跑。
-- ============================================================

CREATE TABLE IF NOT EXISTS keepsakes (
  id UUID DEFAULT gen_random_uuid() PRIMARY KEY,
  image_url TEXT NOT NULL,                        -- moments 桶 keepsakes/ 前缀的 public URL
  session_id TEXT,                                -- 这张图来自哪段对话
  description TEXT,                               -- 视觉描述（= 沈晏对这张图的记忆，AI 生成）
  his_words TEXT,                                 -- 他当时说的话（聊天里回复的真货）
  his_thinking TEXT,                              -- 他当时的思考（聊天 thinking 链的真货）
  created_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS idx_keepsakes_created ON keepsakes (created_at DESC);

ALTER TABLE keepsakes DISABLE ROW LEVEL SECURITY;
