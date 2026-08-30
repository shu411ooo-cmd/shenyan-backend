-- ============================================================
-- moments — 朋友圈（程芥 × 沈晏 双向动态 feed）
-- 在 Supabase SQL Editor 手动执行（不自动迁移）
--
-- 设计说明：
--   基于「教程第六篇 朋友圈」的骨架，作者换成 程芥 + 沈晏。
--   · author：user = 程芥发；angel = 沈晏自己发（未来 keepalive 钩子）。
--   · 回复是延迟的：程芥发完 reply_due_at 8~20 分钟后到期，
--     processDueReplies 到期才生成沈晏的回复——像真人一样不秒回。
--   · 图只看一次（file-image-memory 同款纪律）：POST 时跑一次视觉描述
--     写进 image_description 存库，之后所有回复/评论只喂描述，不重看原图，省 token。
--   · liked = 沈晏的赞（她生成回复时决定）；user_liked = 程芥的赞。
--   · reply_seen_at = 程芥看过回复没（前端未读红点）。
--   · moment_comments = 动态下的评论；程芥评论沈晏的动态 → 3~8 分钟后她回。
--   · 图片存 Supabase Storage 公开桶 moments（public URL 进 images），展示走 URL，
--     AI 记忆走 image_description——「相册展示 + description 记忆」两条线。
-- ============================================================

CREATE TABLE IF NOT EXISTS moments (
  id UUID DEFAULT gen_random_uuid() PRIMARY KEY,
  author TEXT NOT NULL DEFAULT 'user' CHECK (author IN ('user', 'angel')),
  content TEXT NOT NULL DEFAULT '',
  context_note TEXT,                            -- 沈晏自己发时的念头来源（念池引用，可选）
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

-- 与其他表一致：关 RLS（默认开且无策略会 INSERT 被拒、SELECT 被静默过滤）
ALTER TABLE moments DISABLE ROW LEVEL SECURITY;
ALTER TABLE moment_comments DISABLE ROW LEVEL SECURITY;
