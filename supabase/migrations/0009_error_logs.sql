-- 0009_error_logs.sql
--
-- Structured, queryable error log for edge functions and (later) other
-- server-side jobs.
--
-- Why: today errors land in `console.error` which goes to Supabase's edge
-- function logs — useful for one-off debugging via the Supabase dashboard,
-- useless for any of:
--   - showing the operator a "today's errors" panel
--   - grouping failures by source/error_type
--   - alerting on rates ("more than 5 of these in an hour")
--   - cross-referencing with a failed_messages row or a conversation
--
-- This table is the structured backbone. Phase B adds Langfuse on top for
-- per-message AI traces; this table stays as the place where any backend
-- code says "something is wrong, future-me wants to know."
--
-- Design notes:
--   - `level`: 'error' | 'warn' | 'info'. Hard CHECK constraint (not enum)
--     so we can DROP CONSTRAINT + recreate without an ALTER TYPE dance,
--     but ⚠ any new level requires a migration BEFORE the writing code
--     ships — otherwise the INSERT throws 23514 and the error is itself
--     unlogged. Edge functions only emit these three levels.
--   - `source`: free-text label of the emitter ('whatsapp-webhook',
--     'whatsapp-send', 'agent-loop', 'memory-extractor' eventually).
--   - `error_type`: short stable code per failure mode. Keep these stable
--     so we can group / alert on them. Examples:
--       'missing_active_prompt', 'claude_api_error', 'claude_empty_reply',
--       'claude_invalid_reply', 'hookmyapp_send_failed',
--       'send_succeeded_insert_failed', 'agent_lookup_failed',
--       'conversation_lookup_failed', 'duplicate_inbound_skipped'.
--   - `message`: free text. Callers MUST truncate to ~2000 chars before
--     writing (enforced in _shared/logError.ts) to avoid blowing up the
--     table with multi-megabyte Claude response bodies. No DB-level cap
--     because silent truncation in the DB hides the bug; we want the
--     truncation to live in code where it is visible.
--   - `context` jsonb: structured bag — status codes, retry counts,
--     truncated provider responses, anything that helps a human triage.
--     May contain PII (truncated message snippets, phone numbers) →
--     SELECT on the base table is admin-only, matching failed_messages.
--     A redacted `error_logs_safe` view exposes counts/timing/source to
--     all authenticated users so dashboards can show error volume
--     without leaking PII.
--   - RLS: enabled. SELECT admin-only. INSERT/UPDATE/DELETE blocked for
--     authenticated (no policy = deny); service_role bypasses RLS.
--
-- Follow-up (not in this migration):
--   - TTL/cleanup. At 1k rows/day this table reaches ~365k/year and
--     unboundedly grows. Before pilot we'll add a pg_cron job that
--     deletes rows older than 90 days. Tracked separately.
--
-- Idempotent: CREATE TABLE IF NOT EXISTS + DROP POLICY IF EXISTS + CREATE.

CREATE TABLE IF NOT EXISTS public.error_logs (
  id              uuid         PRIMARY KEY DEFAULT gen_random_uuid(),
  level           text         NOT NULL DEFAULT 'error'
                                CHECK (level IN ('error', 'warn', 'info')),
  source          text         NOT NULL,
  error_type      text         NOT NULL,
  message         text         NOT NULL,
  context         jsonb        NOT NULL DEFAULT '{}'::jsonb,
  agent_id        uuid         REFERENCES public.agents(id) ON DELETE SET NULL,
  conversation_id uuid         REFERENCES public.conversations(id) ON DELETE SET NULL,
  created_at      timestamptz  NOT NULL DEFAULT now()
);

COMMENT ON TABLE public.error_logs IS
  'Structured errors / warnings emitted by edge functions and server jobs. '
  'Replaces ad-hoc console.error calls so the dashboard can show & group '
  'failures, and ops can alert on volume. Context may contain PII; SELECT '
  'on the base table is restricted to admins. Non-admins read '
  'error_logs_safe (no message, no context).';

COMMENT ON COLUMN public.error_logs.level IS
  'Adding a new level requires a migration to extend the CHECK constraint '
  'BEFORE any edge function emits it, or INSERT will throw 23514 and the '
  'error will itself go unlogged.';

CREATE INDEX IF NOT EXISTS error_logs_created_at_idx
  ON public.error_logs (created_at DESC);

CREATE INDEX IF NOT EXISTS error_logs_source_type_idx
  ON public.error_logs (source, error_type, created_at DESC);

CREATE INDEX IF NOT EXISTS error_logs_agent_idx
  ON public.error_logs (agent_id, created_at DESC)
  WHERE agent_id IS NOT NULL;

CREATE INDEX IF NOT EXISTS error_logs_conversation_idx
  ON public.error_logs (conversation_id, created_at DESC)
  WHERE conversation_id IS NOT NULL;

ALTER TABLE public.error_logs ENABLE ROW LEVEL SECURITY;

DROP POLICY IF EXISTS "admin_read_error_logs" ON public.error_logs;
CREATE POLICY "admin_read_error_logs"
  ON public.error_logs
  FOR SELECT
  TO authenticated
  USING (public.is_admin());

-- Redacted view for non-admin operators: counts/timing/source/agent
-- without leaking message bodies or PII-bearing context. Matches the
-- 0008 failed_messages_safe pattern so future "ops dashboard" widgets
-- have a safe default to reach for instead of opening the base table.
CREATE OR REPLACE VIEW public.error_logs_safe AS
SELECT
  id,
  level,
  source,
  error_type,
  agent_id,
  conversation_id,
  created_at
FROM public.error_logs;

COMMENT ON VIEW public.error_logs_safe IS
  'Non-admin projection of error_logs: omits message and context because '
  'both may contain truncated PII (phone numbers, message bodies). '
  'Suitable for ops dashboards showing volume by source/type/agent.';

GRANT SELECT ON public.error_logs_safe TO authenticated;
