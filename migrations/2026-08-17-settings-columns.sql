-- ============================================================
-- settings 表补列：keepalive 7 列 + 酷狗登录 2 列（幂等，可重复跑）
-- 前置：无。执行后把 keepalive_daily_wake_cap 设为 3 可降频。
-- 原因：getKeepaliveConfig 会一次 select 全部 7 列，缺一列就整体回退默认值
--       → 必须一次补齐，不能只加 wake_cap。
-- 执行：Supabase Dashboard → SQL Editor → 粘贴本文件 → Run
-- ============================================================

-- keepalive 配置（全 7 列一次补齐）
ALTER TABLE settings ADD COLUMN IF NOT EXISTS keepalive_enabled       boolean DEFAULT true;
ALTER TABLE settings ADD COLUMN IF NOT EXISTS keepalive_active_start  text DEFAULT '00:00';
ALTER TABLE settings ADD COLUMN IF NOT EXISTS keepalive_active_end    text DEFAULT '23:59';
ALTER TABLE settings ADD COLUMN IF NOT EXISTS keepalive_daily_cap     integer DEFAULT 6;
ALTER TABLE settings ADD COLUMN IF NOT EXISTS keepalive_daily_wake_cap integer DEFAULT 6;
ALTER TABLE settings ADD COLUMN IF NOT EXISTS keepalive_interval_min  integer DEFAULT 180;
ALTER TABLE settings ADD COLUMN IF NOT EXISTS keepalive_model         text;

-- 酷狗登录（扫码拿到的身份，转发歌单/播放时带上）
ALTER TABLE settings ADD COLUMN IF NOT EXISTS kugou_token   text;
ALTER TABLE settings ADD COLUMN IF NOT EXISTS kugou_userid  text;

-- session_id 加唯一约束：saveKugouAuth 的 upsert onConflict 依赖它
-- （若已有重复 global 行会失败，先删重再建；只针对 global 行避免误删其他 session）
DELETE FROM settings a USING settings b
  WHERE a.session_id = b.session_id AND a.id > b.id AND a.session_id = 'global';
-- 幂等：用 DO 块检查约束是否已存在，避免重复执行报错
DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint WHERE conname = 'settings_session_id_unique'
  ) THEN
    ALTER TABLE settings ADD CONSTRAINT settings_session_id_unique UNIQUE (session_id);
  END IF;
END $$;

-- 降频：每天主动唤醒 6 → 3（程芥拍板，留言/日记同一个沈晏，人格一致）
UPDATE settings SET keepalive_daily_wake_cap = 3 WHERE session_id = 'global' AND keepalive_daily_wake_cap IS NOT NULL;

-- 兜底：若 global 行不存在则插入（保持幂等）
INSERT INTO settings (session_id, keepalive_daily_wake_cap)
SELECT 'global', 3
WHERE NOT EXISTS (SELECT 1 FROM settings WHERE session_id = 'global');
