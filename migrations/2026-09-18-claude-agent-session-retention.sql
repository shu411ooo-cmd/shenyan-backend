-- Claude Agent SDK 会话保留期清理 · 2026-09-18
--
-- 服务端每 15 分钟按最后活动时间清理过期 transcript/link（默认保留 90 天，
-- env CLAUDE_AGENT_SESSION_RETENTION_DAYS 可调，0 关闭）。下面两个索引让
-- 年龄式 DELETE 在 transcript_entries 增长后仍保持廉价。均为幂等（IF NOT EXISTS）。
-- 过期即删、下轮自动 fresh 重建（优雅降级路径），不影响 messages / 记忆表。

CREATE INDEX IF NOT EXISTS idx_claude_agent_transcript_created_at
  ON public.claude_agent_transcript_entries(created_at);

CREATE INDEX IF NOT EXISTS idx_claude_agent_session_links_updated_at
  ON public.claude_agent_session_links(updated_at);

COMMENT ON INDEX public.idx_claude_agent_transcript_created_at IS
  '按条目时间清理过期 SDK transcript 镜像（保留期默认 90 天）。';
COMMENT ON INDEX public.idx_claude_agent_session_links_updated_at IS
  '按最后续写时间清理过期 app→SDK session 映射。';
