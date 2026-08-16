-- ============================================================
-- 第③阶段：镜子卡 · 建表 + settings 参数列
-- 2026-08-16 · 对应 docs/want-phase3-mirror.md
-- 执行：Supabase Dashboard → SQL Editor → 粘贴本文件 → Run
-- 效果：建 mirror_cards 表（外部模型提卡，代码 exact match 验证）+ settings 加 2 个参数列
-- ============================================================

CREATE TABLE IF NOT EXISTS mirror_cards (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  run_id uuid NOT NULL,                       -- 一次镜子运行的批次（可回溯：谁提的/砍了什么/留下什么）
  claim text NOT NULL,                        -- 候选人格判断（外部模型提）
  quote text NOT NULL,                        -- 候选逐字引语（外部模型提，代码验证）
  verified boolean NOT NULL DEFAULT false,    -- 代码 exact match 结果（查无即弃）
  message_id bigint,                          -- PASS 时指向 messages 原文（messages.id 是整数，不是 uuid）
  session_id bigint,                          -- PASS 时所在 session（sessions.id 同）
  occurred_at timestamptz,                    -- PASS 时消息时间（跨10天复检输入，第⑤用）
  created_at timestamptz DEFAULT now()
);

CREATE INDEX IF NOT EXISTS idx_mirror_cards_run      ON mirror_cards(run_id);
CREATE INDEX IF NOT EXISTS idx_mirror_cards_verified ON mirror_cards(verified);

-- 可调参数（同第②阶段 desire_inject_* 风格）
ALTER TABLE settings ADD COLUMN IF NOT EXISTS mirror_days integer DEFAULT 90;
ALTER TABLE settings ADD COLUMN IF NOT EXISTS mirror_max_sessions integer DEFAULT 20;

-- 验证：SELECT * FROM mirror_cards ORDER BY created_at DESC LIMIT 5;
