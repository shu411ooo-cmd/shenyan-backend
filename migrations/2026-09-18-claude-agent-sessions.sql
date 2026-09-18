-- Durable Claude Agent SDK sessions · 2026-09-18
--
-- Supabase remains the application's source of truth for messages and memory.
-- These tables only hold the Agent SDK's opaque resumable transcript plus the
-- mapping from an app chat session to its current SDK session.

CREATE TABLE IF NOT EXISTS public.claude_agent_session_links (
  app_session_id text PRIMARY KEY,
  sdk_session_id text NOT NULL,
  model text NOT NULL,
  updated_at timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE IF NOT EXISTS public.claude_agent_transcript_entries (
  id bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  project_key text NOT NULL,
  session_id text NOT NULL,
  subpath text NOT NULL DEFAULT '',
  entry_uuid text,
  entry jsonb NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now()
);

-- Most SDK transcript entries carry a stable UUID. NULL UUID entries are
-- intentionally not deduplicated: PostgreSQL UNIQUE permits multiple NULLs,
-- matching the SDK SessionStore contract for title/tag/mode marker entries.
CREATE UNIQUE INDEX IF NOT EXISTS uq_claude_agent_transcript_uuid
  ON public.claude_agent_transcript_entries(project_key, session_id, subpath, entry_uuid);

CREATE INDEX IF NOT EXISTS idx_claude_agent_transcript_load
  ON public.claude_agent_transcript_entries(project_key, session_id, subpath, id);

CREATE INDEX IF NOT EXISTS idx_claude_agent_transcript_session
  ON public.claude_agent_transcript_entries(session_id, subpath, id);

ALTER TABLE public.claude_agent_session_links ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.claude_agent_transcript_entries ENABLE ROW LEVEL SECURITY;

COMMENT ON TABLE public.claude_agent_session_links IS
  'Maps an application chat session to the resumable Claude Agent SDK session currently in use.';
COMMENT ON TABLE public.claude_agent_transcript_entries IS
  'Opaque Agent SDK SessionStore transcript entries; service-role access only via RLS.';
