-- ============================================================
-- 2026-08-30 镜子日复查定时（整体框架·当前状态净本 §6 #1 / 三方共识 P1）
-- 在 Supabase SQL Editor 手动执行（不自动迁移）。幂等，可重跑。
--
-- 做什么：
--   镜子日 = 一个调度事件，两步职责解耦：
--     ① dormant 清扫（纯机械，不调模型）：每 mirror_sweep_hours 跑（已有）
--     ② 镜子复查（runMirrorOnce：支持/冲突/反证提卡，调 DeepSeek）：
--        NOT cron 到点就调——由「距上次复查 ≥ mirror_review_days」驱动。
--        No Change 是健康指标不是 KPI，不能为了「让镜子每天工作一次」而制造模型调用。
--   本迁移加两列：
--     settings.mirror_review_days  复查间隔（默认 7 天）
--     settings.last_mirror_review_at 上次复查时间（手动 /api/mirror/run 与定时复查共用，
--                                     写它 = 标记「已复查」，防止紧接着又跑一轮）
-- ============================================================

ALTER TABLE settings ADD COLUMN IF NOT EXISTS mirror_review_days integer DEFAULT 7;
ALTER TABLE settings ADD COLUMN IF NOT EXISTS last_mirror_review_at timestamptz;
COMMENT ON COLUMN settings.mirror_review_days IS '镜子复查间隔（天）：距上次复查超过它才跑 runMirrorOnce 提卡（No Change 不是 KPI，不制造模型调用）';
COMMENT ON COLUMN settings.last_mirror_review_at IS '上次镜子复查时间：手动 /api/mirror/run 与定时复查共用，写它=标记已复查';

-- 验证：
--   SELECT mirror_review_days, last_mirror_review_at FROM settings WHERE session_id='global';
