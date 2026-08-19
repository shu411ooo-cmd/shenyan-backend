-- ============================================================
-- 沈晏欠账迁移 · 合并版（2026-08-16 整理）
-- 内容 = 2026-08-12-time-sense.sql + 2026-08-13-keepalive.sql（幂等，可重复跑）
-- 执行：Supabase Dashboard → SQL Editor → 粘贴本文件 → Run
-- 前置：无。执行后跑 node backfill-segments-temp.js 回填摘要段时间戳。
-- ============================================================

-- 时间感 P1：摘要段头显示日期范围
ALTER TABLE summary_segments ADD COLUMN IF NOT EXISTS period_start_ts timestamptz;
ALTER TABLE summary_segments ADD COLUMN IF NOT EXISTS period_end_ts   timestamptz;

-- 时间感 P2：时间心跳记住上次报时
ALTER TABLE sessions ADD COLUMN IF NOT EXISTS last_time_notice_at timestamptz;

-- 离开意图 P3：她走时亲口说的去向
ALTER TABLE dialogue_residue ADD COLUMN IF NOT EXISTS departure text;

-- keepalive：上次成功唤醒时间（兼作并发锁标记）
ALTER TABLE sessions ADD COLUMN IF NOT EXISTS last_keepalive_at timestamptz;

-- keepalive：唤醒日志（一次「自主醒来」一行）
CREATE TABLE IF NOT EXISTS keepalive_log (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  session_id text NOT NULL,
  run_at timestamptz NOT NULL,
  action text NOT NULL,          -- message | diary | none
  content text,                  -- message=留言正文 / diary=日记正文 / none=空
  source text,                   -- message 的依据（逐字引述）；空 = 没依据
  consumed boolean DEFAULT false,
  created_at timestamptz DEFAULT now()
);

-- keepalive：request_stats 记诊断
ALTER TABLE request_stats ADD COLUMN IF NOT EXISTS keepalive_action text;
ALTER TABLE request_stats ADD COLUMN IF NOT EXISTS keepalive_meta jsonb;
