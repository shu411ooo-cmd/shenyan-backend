-- ============================================================
-- memory_topics v2 迁移：source 隔离 + song_key 音乐身份键
-- 2026-08-29 · 在 Supabase SQL Editor 手动执行（不自动迁移）
--
-- 设计说明见 sql/memory_topics_v2_schema.md
-- 执行顺序：1) 加列 → 2) 建索引 → 3) 回填存量 → 4)（可选）唯一性升级
-- 回填基于 2026-08-29 拉取的真实数据核对，不是正则/猜测。
-- ============================================================

-- ---------- 1. 加列 ----------
ALTER TABLE memory_topics
  ADD COLUMN IF NOT EXISTS source   TEXT NOT NULL DEFAULT 'chat',
  ADD COLUMN IF NOT EXISTS song_key TEXT;

COMMENT ON COLUMN memory_topics.source IS '来源：chat=日常对话编辑者 / music=音乐室沉淀';
COMMENT ON COLUMN memory_topics.song_key IS '音乐桶身份键：歌名|歌手（与前端 keyOf、music_songs.key 对齐）；chat 桶为 NULL';

-- ---------- 2. 音乐桶唯一性：一首歌一个桶 ----------
-- 部分唯一索引：只约束 source='music' 且有 song_key 的行；chat 桶不受影响
CREATE UNIQUE INDEX IF NOT EXISTS uq_memory_topics_music_song
  ON memory_topics (song_key)
  WHERE source = 'music' AND song_key IS NOT NULL;

-- 建议给 Chat 解析器用的查询也建索引：按来源 + 主题
CREATE INDEX IF NOT EXISTS idx_memory_topics_source_topic
  ON memory_topics (source, topic);

-- ---------- 3. 回填存量（人工核对，2026-08-29 数据）----------
-- 82 条里仅 2 条是音乐沉淀桶（第一人称 + 歌/瞬间主题）；其余 80 条保持默认 'chat'。
UPDATE memory_topics
SET source = 'music'
WHERE topic IN ('一起听歌的温柔', '红豆与雨夜');

-- 存量音乐桶的 song_key：
--   - '红豆与雨夜' 内容含《红豆》，但歌手未知 → song_key 用 '红豆|'（歌名保真，歌手留空）
--   - '一起听歌的温柔' 内容无歌名 → 无法还原，保持 NULL（诚实：不猜）
-- 说明：这两条是旧沉淀路径产物，当时没有携带歌名。song_key 体系从迁移后新写入开始生效。
--        NULL song_key 的音乐桶无法被新写入精确命中（退化为只能靠 topic 包含匹配），
--        ChatGPT 级判断：与其猜一个错的 song_key 让它永远匹配不上，不如留 NULL 待人工认领。
UPDATE memory_topics
SET song_key = '红豆|'
WHERE topic = '红豆与雨夜' AND source = 'music';

-- ---------- 4. 唯一性升级：topic → (source, topic)（2026-08-29 拍板·方案 2）----------
-- 与第 2 步的音乐部分索引不冲突，可叠加。
-- 配套代码：upsertMemoryTopic 的 onConflict 改为 ['source','topic']，函数内兜底 row.source。
ALTER TABLE memory_topics DROP CONSTRAINT IF EXISTS memory_topics_topic_key;
ALTER TABLE memory_topics ADD CONSTRAINT uq_memory_topics_source_topic UNIQUE (source, topic);

-- ---------- 5.（不在本次范围）存量重复桶清理 ----------
-- 与 schema 变更独立，待单独确认。现状：
--   GitHub账号被封 / GitHub账号封禁 共享 bucket 366aa7012c76（后者是多余行）
--   GH账号被封 bucket 43e43bbb0f83（真正重复桶，需与 366aa7012c76 合并）
--   Junk journ / Junk journal / 沉迷古董布和蕾丝 三行同一件事（各自成桶）
-- 若要清理，见 memory_topics_v2_schema.md「不做的」——建议另开一次迁移单独做。
