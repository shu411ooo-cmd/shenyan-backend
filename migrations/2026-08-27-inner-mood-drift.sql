-- ②③ 内在引擎 v2：情绪 + 驱动自主涨落（2026-08-27 程芥拍板）
-- ② 念头/唤醒带情绪：mood text[]（MIND_MOODS_20 二十选，首位主情绪；机械判定，先不上页面）
ALTER TABLE thought_pool   ADD COLUMN IF NOT EXISTS mood text[];
ALTER TABLE keepalive_log  ADD COLUMN IF NOT EXISTS mood text[];

-- ③ 驱动自主涨落不需要新列（server.js buildInnerState 读时按 age 向基线回归，叠加执念反哺）。
--    这里只加 ② 的两列。
