-- ============================================================
-- 2026-08-29 音乐室记忆 + 点歌信箱
-- 参照 eryu 的音乐记忆模型，落到 supabase（不再是前端 localStorage / 进程内 JSON）。
--
-- music_songs：每首歌的记忆（key = '歌名|歌手'，与前端 src/music/memory.js 的 keyOf 对齐）
--   - listen_count  播完次数（听完才算）
--   - together_count 在音乐室(沈晏的房间)一起听过的次数 —— 沈晏记忆的计数器
--   - feeling/notes/lines/tags 歌记忆板字段（与前端 memory.js 同名字段）
--
-- music_letters：点歌信箱（一起听数据层，参照 eryu /music/remote）
--   - 推歌 INSERT 一行；收歌 GET 取最早未送达并标记 delivered_at（读到即删）
--
-- 在 Supabase SQL Editor 手动执行（不自动迁移）。幂等，可重跑。
-- ============================================================

CREATE TABLE IF NOT EXISTS music_songs (
  key TEXT PRIMARY KEY,                        -- '歌名|歌手'
  title TEXT NOT NULL DEFAULT '',
  artist TEXT NOT NULL DEFAULT '',
  cover TEXT NOT NULL DEFAULT '',
  listen_count INT NOT NULL DEFAULT 0,
  together_count INT NOT NULL DEFAULT 0,
  first_listened TEXT NOT NULL DEFAULT '',     -- 'M/D' 与前端一致
  last_listened TIMESTAMPTZ,
  feeling TEXT NOT NULL DEFAULT '',
  notes TEXT NOT NULL DEFAULT '',
  lines TEXT NOT NULL DEFAULT '',
  tags TEXT NOT NULL DEFAULT '',
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE TABLE IF NOT EXISTS music_letters (
  id UUID DEFAULT gen_random_uuid() PRIMARY KEY,
  name TEXT NOT NULL,
  artist TEXT NOT NULL DEFAULT '',
  cover TEXT NOT NULL DEFAULT '',
  ref TEXT,                                    -- 前端曲库 index（演示曲）
  sender TEXT NOT NULL DEFAULT '',             -- 前端 selfId（设备标识）
  ts BIGINT NOT NULL DEFAULT 0,
  delivered_at TIMESTAMPTZ                    -- 标记送达（读到即删）
);
CREATE INDEX IF NOT EXISTS idx_music_letters_undelivered
  ON music_letters (ts) WHERE delivered_at IS NULL;
