-- ============================================================
-- 2026-08-26 朋友圈预设清理
-- moments / moment_comments 建表后只装了测试预设行（真功能上线前，
-- 表里这些行是假的，会污染她刷朋友圈时的观感）。
-- 清空这两张表，从一张空的朋友圈开始。
-- 在 Supabase SQL Editor 手动执行（不自动迁移）。幂等，可重跑。
-- ============================================================

TRUNCATE TABLE moment_comments, moments CASCADE;

-- 确认清空（应各返回 0）：
-- SELECT count(*) FROM moments;
-- SELECT count(*) FROM moment_comments;
