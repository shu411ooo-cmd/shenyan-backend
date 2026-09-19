-- 每轮真实线路 / Agent SDK 会话模式 / 上下文与额度观测。
-- 所有 JSONB 都是后端已经归一、去敏的小快照：不含消息正文、工具参数/结果、
-- SDK session id、文件路径或任何鉴权信息。
--
-- 代码仍兼容“迁移晚于部署”：request_stats 缺列时会逐列剥离后写入旧字段，
-- 不会因为这些新列尚不存在而停止进货。

ALTER TABLE request_stats ADD COLUMN IF NOT EXISTS transport text;
ALTER TABLE request_stats ADD COLUMN IF NOT EXISTS transport_reason text;
ALTER TABLE request_stats ADD COLUMN IF NOT EXISTS agent_session_mode text;
ALTER TABLE request_stats ADD COLUMN IF NOT EXISTS agent_forked boolean;
ALTER TABLE request_stats ADD COLUMN IF NOT EXISTS raw_estimated_tokens int;
ALTER TABLE request_stats ADD COLUMN IF NOT EXISTS claude_context_snapshot jsonb;
ALTER TABLE request_stats ADD COLUMN IF NOT EXISTS claude_quota_before jsonb;
ALTER TABLE request_stats ADD COLUMN IF NOT EXISTS claude_quota_after jsonb;

COMMENT ON COLUMN request_stats.transport IS '实际线路：claude-subscription / deepseek / api';
COMMENT ON COLUMN request_stats.agent_session_mode IS 'Agent SDK 会话准备模式：fresh / resume / rebuild / model-change / missing-transcript / degraded / off';
COMMENT ON COLUMN request_stats.raw_estimated_tokens IS 'Context Assembly 裁剪前估算；estimated_tokens 是裁剪后';
