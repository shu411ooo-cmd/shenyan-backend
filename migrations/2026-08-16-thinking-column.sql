-- ============================================================
-- 沈晏思考链入库 · 2026-08-16
-- 让沈晏的思考链（thinking）存进 messages，前端换设备也能看到历史思考链。
-- 执行：Supabase Dashboard → SQL Editor → 粘贴本文件 → Run
-- ============================================================

ALTER TABLE messages ADD COLUMN IF NOT EXISTS thinking text;
