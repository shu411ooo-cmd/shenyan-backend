-- ============================================================
-- 补 settings.netease_cookie（2026-09-09）
--
-- 病：音乐室换轨到网易云之后，代码用 settings.netease_cookie 存登录 cookie
--     （ncmCookie 读 / saveNeteaseCookie 写），但这个列**从来没建过**。
--     settings 表里躺着的还是酷狗时代的 kugou_token / kugou_userid。
--
-- 后果链（线上实测 column settings.netease_cookie does not exist）：
--     扫码登录成功(code 803) → saveNeteaseCookie(cookie) → update 报错返回 false
--     （调用处 `await saveNeteaseCookie(cookie)` 不检查返回值，所以无人察觉）
--     → 紧接着 ncmProfile() 走 ncmCookie() 拿到 null → 昵称/头像为空
--     → 此后 liked / daily / playlists / playlist 全部拿 null cookie → needLogin
--     搜索/播放/歌词仍能工作（免费歌匿名可用），所以「一半能用」掩盖了登录根本没存上。
--
-- 执行：Supabase Dashboard → SQL Editor → 粘贴 → Run（幂等，可重复跑）
-- ============================================================

ALTER TABLE settings ADD COLUMN IF NOT EXISTS netease_cookie text;
COMMENT ON COLUMN settings.netease_cookie IS '网易云登录 cookie（扫码登录后落库；ncmCookie/saveNeteaseCookie 用）';

-- 核对（跑完执行，应当返回一行）：
--   SELECT column_name, data_type FROM information_schema.columns
--    WHERE table_name='settings' AND column_name='netease_cookie';
--
-- 之后重新扫一次码登录，再看：
--   SELECT (netease_cookie IS NOT NULL) AS has_cookie FROM settings WHERE session_id='global';
