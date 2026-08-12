-- keepalive 主动唤醒 v1（2026-08-13，方案见 docs/keepalive-impl-plan.md，已过 GPT 评审）
-- 设计要点：keepalive 不合并进 messages 历史（保 pairTurns 冻结字节 + 缓存前缀），
--           独立写 keepalive_log，靠 consumed 认领维持意识连续性。

-- 会话表：最近一次成功唤醒的时间（兼作并发锁标记，见 keepaliveCheck 原子条件更新）
ALTER TABLE sessions ADD COLUMN IF NOT EXISTS last_keepalive_at timestamptz;

-- 唤醒日志：一次「自主醒来」一行
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

-- 观测：request_stats 记 keepalive 诊断（client='keepalive' 区分；action + 元数据）
ALTER TABLE request_stats ADD COLUMN IF NOT EXISTS keepalive_action text;
ALTER TABLE request_stats ADD COLUMN IF NOT EXISTS keepalive_meta jsonb;

-- settings 6 键不写迁移：代码侧 KEEPALIVE_DEFAULTS 兜底，想改在 Supabase 插 settings 行
-- 键：keepalive_enabled / keepalive_interval_min / keepalive_active_start / keepalive_active_end
--      keepalive_daily_cap / keepalive_daily_wake_cap / keepalive_model
