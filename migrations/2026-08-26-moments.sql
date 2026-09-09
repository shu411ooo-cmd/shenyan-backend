-- ============================================================
-- 2026-08-26 朋友圈（moments + moment_comments）
-- 在 Supabase SQL Editor 手动执行（不自动迁移）。幂等，可重跑。
-- 规范说明见 sql/moments.sql。
-- ============================================================

CREATE TABLE IF NOT EXISTS moments (
  id UUID DEFAULT gen_random_uuid() PRIMARY KEY,
  author TEXT NOT NULL DEFAULT 'user' CHECK (author IN ('user', 'angel')),
  content TEXT NOT NULL DEFAULT '',
  context_note TEXT,                            -- 沈晏自己发时的念头来源（可选）
  image_description TEXT,                       -- 图只看一次的描述（AI 记忆用，省 token）
  images JSONB NOT NULL DEFAULT '[]',           -- storage public URL 数组
  reply_due_at TIMESTAMPTZ NOT NULL,            -- 沈晏回复到期时刻（8~20 分钟后）
  reply_status TEXT NOT NULL DEFAULT 'pending'
    CHECK (reply_status IN ('pending', 'done', 'none')),   -- none = 沈晏选择安静不回
  liked BOOLEAN NOT NULL DEFAULT false,         -- 沈晏赞了（她生成回复时定）
  reply_content TEXT,                           -- 沈晏的回复
  replied_at TIMESTAMPTZ,
  reply_seen_at TIMESTAMPTZ,                    -- 程芥看过回复没（未读红点）
  user_liked BOOLEAN NOT NULL DEFAULT false,    -- 程芥赞了
  created_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS idx_moments_created ON moments (created_at DESC);
CREATE INDEX IF NOT EXISTS idx_moments_reply_due ON moments (reply_status, reply_due_at);

CREATE TABLE IF NOT EXISTS moment_comments (
  id UUID DEFAULT gen_random_uuid() PRIMARY KEY,
  moment_id UUID NOT NULL REFERENCES moments(id) ON DELETE CASCADE,
  author TEXT NOT NULL CHECK (author IN ('user', 'angel')),
  content TEXT NOT NULL,
  reply_due_at TIMESTAMPTZ,                     -- 沈晏回评论到期时刻（3~8 分钟后）
  reply_status TEXT NOT NULL DEFAULT 'none'
    CHECK (reply_status IN ('none', 'pending', 'done')),
  reply_content TEXT,
  seen_at TIMESTAMPTZ,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS idx_moment_comments_moment ON moment_comments (moment_id, created_at);

-- 2026-09-09 停用：这些迁移是幂等设计、随时可能被重跑，重跑一次就会把 RLS 关回去。
-- 后端用的是 secret key（绕过 RLS），前端不直连 Supabase，所以根本不需要关 RLS。
-- 原语句保留在下方注释里备查，不再执行。
-- ALTER TABLE moments DISABLE ROW LEVEL SECURITY;
-- ALTER TABLE moment_comments DISABLE ROW LEVEL SECURITY;
