-- ============================================================
-- 性能索引补齐（2026-09-03）：给高频查询维度补索引，幂等可重复跑
-- 执行：Supabase Dashboard → SQL Editor → 粘贴本文件 → Run
-- ============================================================

-- 唤醒时间线：按 session 读、按 run_at 过滤/排序
CREATE INDEX IF NOT EXISTS idx_keepalive_log_session_run
  ON keepalive_log (session_id, run_at DESC);

-- 想要足迹：按 desire_id 读（handleWantList 批量 in 查询）
CREATE INDEX IF NOT EXISTS idx_desire_notes_desire
  ON desire_notes (desire_id, created_at DESC);

-- 记忆关系边：BFS 扩展从两端出发的查询
CREATE INDEX IF NOT EXISTS idx_memory_relations_src ON memory_relations (source_topic);
CREATE INDEX IF NOT EXISTS idx_memory_relations_tgt ON memory_relations (target_topic);

-- 镜子卡：按 session 拉候选
CREATE INDEX IF NOT EXISTS idx_mirror_cards_session
  ON mirror_cards (session_id, created_at DESC);