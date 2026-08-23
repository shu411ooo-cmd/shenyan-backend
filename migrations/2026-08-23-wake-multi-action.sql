-- ============================================================
-- 第⑥b 唤醒多产物（路线1：行为先行，暂不拆表）· 2026-08-23
-- 对应 docs/desire-wake-engine-design.md §5/§7 开放问题
-- 效果：一次唤醒 = 一条主记录内嵌 actions 快照（先 dream 再 message 等）
-- ============================================================

-- actions: 本次唤醒的实际动作数组（[{type,content,source,merged,resolved_thought_ids,graduate_thought_ids}]）
-- 主记录 action/content/source 保留为「主动作」兼容旧读取；完整快照在这列
ALTER TABLE keepalive_log ADD COLUMN IF NOT EXISTS actions jsonb;

-- 验证：SELECT column_name FROM information_schema.columns
--   WHERE table_name = 'keepalive_log' AND column_name = 'actions';
