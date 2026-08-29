-- ============================================================
-- dialogue_residue · 模式感知 convo_mode + 修复缺列（2026-08-29）
-- 在 Supabase SQL Editor 手动执行（不自动迁移），可重复跑（全幂等）
--
-- 做什么：
--   1. 修缺列：social / duty / stress 三列从 08-20 起进了代码（RESIDUE_DIMS /
--      normalizeResidue），但从未迁移落库 → 残留写入静默 400，residue 系统
--      自 08-19 最后一行为止已停止工作（生成在跑、落库必败）。补上即恢复。
--   2. 加 convo_mode：模式感知（设计见 更新整体框架·外部审核稿.md §5 #2）——
--      「上一段对话的性质」（闲聊/深入/亲密/正事），①层沉淀、④层首句/resume
--      消费（事后不急着抽离）、世界书触发门控（亲密不注入知识卡）。
--   3. request_stats 观测列 residue_mode：供验收「这次注入带没带模式」。
-- ============================================================

-- ---------- 1. 修缺列（08-20 代码已发射、DB 没有，写入 400 的根因） ----------
ALTER TABLE dialogue_residue ADD COLUMN IF NOT EXISTS social REAL NOT NULL DEFAULT 0;
ALTER TABLE dialogue_residue ADD COLUMN IF NOT EXISTS duty   REAL NOT NULL DEFAULT 0;
ALTER TABLE dialogue_residue ADD COLUMN IF NOT EXISTS stress REAL NOT NULL DEFAULT 0;

-- ---------- 2. 模式感知 ----------
-- convo_mode 用列名不用 mode：mode 是 Postgres 有序集聚合函数名，
-- PostgREST 的 select=mode 会被解析成聚合 → 42809（实测），列名取 convo_mode 避开。
ALTER TABLE dialogue_residue ADD COLUMN IF NOT EXISTS convo_mode text;

COMMENT ON COLUMN dialogue_residue.convo_mode IS '模式感知：上一段对话的性质（闲聊/深入/亲密/正事），④层首句/resume 消费 + 世界书触发门控（亲密不注入知识卡）';

-- ---------- 3. 观测 ----------
ALTER TABLE request_stats ADD COLUMN IF NOT EXISTS residue_mode text;
