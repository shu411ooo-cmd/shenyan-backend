-- ============================================================
-- keepalive_log 补列：breath + feel + trace（幂等，可重复跑）
-- 背景：昨天（08-17 凌晨）程芥与沈晏讨论定稿——唤醒主记录，
--       每次醒来是一个完整事件：先 breath 看一圈，再 feel 留感受，
--       无论做不做都留一条 trace（"我来过"的证明）。
-- 执行：Supabase Dashboard → SQL Editor → 粘贴本文件 → Run
-- ============================================================

ALTER TABLE keepalive_log ADD COLUMN IF NOT EXISTS breath text; -- breath：醒来看到的东西（时间/手上有什么/什么悬着）
ALTER TABLE keepalive_log ADD COLUMN IF NOT EXISTS feel   text; -- feel：breath 后的情绪感受
ALTER TABLE keepalive_log ADD COLUMN IF NOT EXISTS trace  text; -- trace：这句唤醒留的"我来过"（none 也要有）
