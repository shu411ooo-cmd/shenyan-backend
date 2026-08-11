-- 2026-08-12 沈晏时间感改造（P0/P1/P2）schema 迁移
-- 在 Supabase SQL Editor 里执行一次（幂等，可重复跑）。
-- 必须先跑这里，再跑 node backfill-segments-temp.js，最后再部署 server.js。

-- P1：摘要段头要显示日期范围 —— summary_segments 补两个时间戳列
ALTER TABLE summary_segments
  ADD COLUMN IF NOT EXISTS period_start_ts timestamptz,
  ADD COLUMN IF NOT EXISTS period_end_ts   timestamptz;

-- P2：时间心跳要记住上次报时 —— sessions 补一列
ALTER TABLE sessions
  ADD COLUMN IF NOT EXISTS last_time_notice_at timestamptz;
