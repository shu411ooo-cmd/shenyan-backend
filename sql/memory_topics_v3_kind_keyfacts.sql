-- ============================================================
-- memory_topics v3 迁移：kind（memory/feel）+ key_facts（feel 桶防漂移）
-- 2026-08-29 · 在 Supabase SQL Editor 手动执行（不自动迁移）
--
-- 设计说明见 记忆正文人味·v2·外部审核稿.md §7（审后定稿）
-- 执行顺序：加列 → 建索引
-- ============================================================

-- ---------- 1. 加列 ----------
-- kind: memory=事实桶（正文中性，回想时经声音渲染层只改角度）
--       feel = 经历/关系/感受桶（正文第一人称+温度，写入时从原文提取，回想直接读）
-- key_facts: 仅 feel 桶维护，关键事实清单（正文可以漂、key_facts 不能；每次 trace 前后对齐）
ALTER TABLE memory_topics
  ADD COLUMN IF NOT EXISTS kind      TEXT NOT NULL DEFAULT 'memory',
  ADD COLUMN IF NOT EXISTS key_facts JSONB;

COMMENT ON COLUMN memory_topics.kind IS 'memory=事实桶（中性正文，回想时声音化）；feel=经历/关系/感受桶（第一人称+温度落库）';
COMMENT ON COLUMN memory_topics.key_facts IS 'feel 桶关键事实清单（防代际漂移；正文可漂，key_facts 只增不减，每次 trace 对齐）';

-- ---------- 2. 索引：feel 桶按 kind 查询 ----------
CREATE INDEX IF NOT EXISTS idx_memory_topics_kind
  ON memory_topics (kind);

-- ---------- 3. 存量回填（2026-08-29 人工核对）----------
-- 音乐沉淀桶（source='music'）恒为 feel：它们是「沈晏记得那一刻」的经历记忆，第一人称是内容本身。
UPDATE memory_topics SET kind = 'feel'
WHERE source = 'music';

-- 其余存量 chat 桶保持默认 'memory'（中性，trace 更新时由新写入重新判定 kind，不批量改写正文）。
-- 「悬」的经历在 v3 规则下自动成 memory（内容温度以证据为前提，悬=缺证据→无温度）——
-- 存量不迁移，等各自被 trace 更新时自然纠正。

-- ---------- 4. 业务代码配套（另见 server.js 改动，2026-08-29）----------
--  - buildMemoryWritePrompt / buildMusicMomentPrompt：kind 分流 + 温度纪律 + 负面清单
--  - normalizeMemoryWrite：解析 kind/key_facts
--  - writeMemoryItems：feel 桶更新走 refineFeelContent（带旧正文 + key_facts 并集 + 代际保底）
--  - getAttentionMaterial / getRelationNeighbors：select 加 kind；memory 桶正文浮出时经 voiceifyMemory 只改声音
