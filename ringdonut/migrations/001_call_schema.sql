CREATE EXTENSION IF NOT EXISTS pgcrypto;

CREATE TABLE IF NOT EXISTS call_sessions (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    session_id TEXT NOT NULL,
    model TEXT NOT NULL,
    status TEXT NOT NULL DEFAULT 'active' CHECK (status IN ('active', 'ended', 'failed')),
    context_snapshot JSONB NOT NULL DEFAULT '{}'::jsonb,
    token_budget INTEGER NOT NULL DEFAULT 4096,
    system_token_budget INTEGER NOT NULL DEFAULT 2900,
    duration_seconds INTEGER,
    summary TEXT,
    chat_message_id BIGINT,
    summary_status TEXT NOT NULL DEFAULT 'pending' CHECK (summary_status IN ('pending', 'complete', 'failed', 'skipped')),
    started_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    last_heartbeat_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    ended_at TIMESTAMPTZ,
    updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS idx_call_sessions_chat_started
    ON call_sessions (session_id, started_at DESC);

CREATE TABLE IF NOT EXISTS call_turns (
    id BIGSERIAL PRIMARY KEY,
    call_id UUID NOT NULL REFERENCES call_sessions(id) ON DELETE CASCADE,
    role TEXT NOT NULL CHECK (role IN ('user', 'assistant')),
    content TEXT NOT NULL,
    voice_tone JSONB,
    duration_seconds NUMERIC(6, 1),
    created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS idx_call_turns_call_created
    ON call_turns (call_id, created_at ASC, id ASC);

CREATE TABLE IF NOT EXISTS call_invites (
    id BIGSERIAL PRIMARY KEY,
    session_id TEXT NOT NULL,
    reason TEXT NOT NULL,
    status TEXT NOT NULL DEFAULT 'pending' CHECK (status IN ('pending', 'accepted', 'declined', 'missed', 'cancelled')),
    source TEXT NOT NULL DEFAULT 'companion',
    decline_note TEXT,
    expires_at TIMESTAMPTZ NOT NULL DEFAULT (NOW() + INTERVAL '90 seconds'),
    answered_at TIMESTAMPTZ,
    created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS idx_call_invites_session_pending
    ON call_invites (session_id, status, created_at DESC);

CREATE TABLE IF NOT EXISTS call_preferences (
    session_id TEXT PRIMARY KEY,
    dnd BOOLEAN NOT NULL DEFAULT FALSE,
    updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

-- Safe default for Supabase: server-side service-role access can bypass RLS,
-- while anonymous/browser clients receive no access until the host adds
-- deliberate policies.
ALTER TABLE call_sessions ENABLE ROW LEVEL SECURITY;
ALTER TABLE call_turns ENABLE ROW LEVEL SECURITY;
ALTER TABLE call_invites ENABLE ROW LEVEL SECURITY;
ALTER TABLE call_preferences ENABLE ROW LEVEL SECURITY;

NOTIFY pgrst, 'reload schema';
