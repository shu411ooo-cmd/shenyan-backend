-- ============================================================
-- 第⑤b 阶段：石头审计闭环（冲突清单 + 自主表达分级 + 反证压回）
-- 2026-08-23 · 对应 docs/want-phase5b-audit.md · 审稿 P0-2 / 二审-2 / P0-1
-- 执行：Supabase Dashboard → SQL Editor → 粘贴本文件 → Run
-- 效果：mirror_cards 加 direction/initiation；personality_claim 加 strong_count/weak_count
-- ============================================================

-- ---- 1. mirror_cards：卡片方向 + 自主表达级别 ----
-- direction: support（支持证据，进候选毕业料池）| conflict（与石头相悖，沈晏裁决）| doubting（自我怀疑，压回 uncertain）
-- initiation: strong（自己主动引入）| weak（紧跟诱导）
ALTER TABLE mirror_cards ADD COLUMN IF NOT EXISTS direction text DEFAULT 'support';
ALTER TABLE mirror_cards ADD COLUMN IF NOT EXISTS initiation text;   -- strong | weak（仅 support 卡有，conflict/doubting 不适用）

-- ---- 2. personality_claim：自主表达计数（升级门槛输入）----
-- 至少一次 strong 才可毕业（sessions≥2 && span≥N && strong_count≥1）
ALTER TABLE personality_claim ADD COLUMN IF NOT EXISTS strong_count int DEFAULT 0;
ALTER TABLE personality_claim ADD COLUMN IF NOT EXISTS weak_count int DEFAULT 0;

-- 验证：SELECT column_name FROM information_schema.columns
--   WHERE table_name IN ('mirror_cards','personality_claim')
--   AND column_name IN ('direction','initiation','strong_count','weak_count');
