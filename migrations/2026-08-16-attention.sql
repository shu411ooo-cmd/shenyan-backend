-- ============================================================
-- 第④b阶段：注意力分配 · request_stats 观测列 + settings 参数列
-- 2026-08-16 · 对应 docs/want-phase4b-attention.md
-- 执行：Supabase Dashboard → SQL Editor → 粘贴本文件 → Run
-- 效果：request_stats 记 attention 注入观测；settings 加 3 个可调参数
-- ============================================================

-- 观测：每次请求注意力注入是否触发 / 命中几条（供验收：attention_injected 与日志对照）
ALTER TABLE request_stats ADD COLUMN IF NOT EXISTS attention_injected boolean;
ALTER TABLE request_stats ADD COLUMN IF NOT EXISTS attention_hits integer;

-- 参数：注意力的预算与阈值（默认 = 设计稿定稿值）
ALTER TABLE settings ADD COLUMN IF NOT EXISTS attention_k integer DEFAULT 2;                -- 最多唤起几条
ALTER TABLE settings ADD COLUMN IF NOT EXISTS attention_budget_chars integer DEFAULT 700;   -- 总注入字符上限
ALTER TABLE settings ADD COLUMN IF NOT EXISTS attention_concern_threshold real DEFAULT 0.5; -- 牵挂闸阈值

-- 验证：SELECT attention_injected, attention_hits FROM request_stats LIMIT 5;
--      SELECT attention_k, attention_budget_chars, attention_concern_threshold FROM settings WHERE session_id = 'global';
