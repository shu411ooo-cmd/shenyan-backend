-- 2026-08-30 缓存锚定：sessions 加 live_anchor_turn（live 段塌缩锚点，canonical 持久化）
-- 背景：live 段从「每轮滚动滑窗」改「锚定攒批+双阈值塌缩」，锚点=live 段第一轮 turn。
--   锚点 canonical = 本列；server.js 进程内 Map 只是 fast path，重启后从本列恢复，
--   避免「一次重启=人为制造 cache miss」。
-- 降级：本列未建时 server.js 的 loadLiveAnchor/saveLiveAnchor 捕获错误 → 锚定退化为
--   进程内 Map（单实例仍有效）或滚动（锚点全丢），系统不崩、resumeGap/residue 不受影响。
-- 执行：程芥跑（PG_CONN_STRING 在她手里），跑完即生效，无需重启。
ALTER TABLE sessions ADD COLUMN IF NOT EXISTS live_anchor_turn int;
