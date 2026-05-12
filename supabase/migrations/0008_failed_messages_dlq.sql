-- 0008_failed_messages_dlq.sql
--
-- Dead-letter queue for outbound messages that failed to deliver (Claude
-- output invalid, HookMyApp send rejected, DB insert after send failed).
--
-- Why: today, if anything past the agent's "compose reply" step fails, the
-- failure is logged to `console.error` (lost in Supabase function logs
-- which the dashboard can't query) and the lead silently never gets a
-- reply. With this table:
--   - Every failed attempt is rowed and visible from the dashboard.
--   - An operator can review, fix the prompt / retry / mark resolved.
--   - We get a queryable history of failure types to feed phase D evals.
--
-- Design notes:
--   - `agent_id` is captured separately from `conversation_id` because a
--     failure can happen before the conversation row exists (agent
--     resolved → insert exploded). Keeping `agent_id` directly preserves
--     multi-tenant routing even when `conversation_id` is NULL.
--   - `conversation_id` is nullable + ON DELETE SET NULL so we keep the
--     failure record even if the conversation is later wiped.
--   - `payload` is the original attempted send (reply text + target phone
--     + whatever the function had in scope). Contains PII (phone numbers,
--     message bodies). SELECT is therefore restricted to admins — regular
--     dashboard users see a redacted summary via the failed_messages_safe
--     view defined below.
--   - `error_type` is a free-text bucket label (e.g. "claude_empty_reply",
--     "hookmyapp_5xx", "outbound_insert_failed", "validation_failed").
--     We deliberately don't use an enum because the categories will
--     evolve as we learn — we'll promote stable ones to an enum later.
--   - `resolved_by ON DELETE SET NULL`: trades audit permanence for
--     simpler user deletion. If audit becomes a hard requirement (legal
--     review of failure resolutions), we'll switch to RESTRICT and have
--     delete-user reassign to a sentinel user. Acceptable for the pilot.
--   - RLS: enabled. SELECT is admin-only on the base table (PII). INSERT
--     and DELETE are service_role only (no policy → blocked for
--     authenticated). UPDATE is admin-only for marking resolved.
--
-- Idempotent: CREATE TABLE IF NOT EXISTS + DROP POLICY IF EXISTS + CREATE.

CREATE TABLE IF NOT EXISTS public.failed_messages (
  id              uuid         PRIMARY KEY DEFAULT gen_random_uuid(),
  agent_id        uuid         REFERENCES public.agents(id) ON DELETE SET NULL,
  conversation_id uuid         REFERENCES public.conversations(id) ON DELETE SET NULL,
  source          text         NOT NULL,
  error_type      text         NOT NULL,
  error_detail    text,
  payload         jsonb        NOT NULL DEFAULT '{}'::jsonb,
  retry_count     int          NOT NULL DEFAULT 0,
  last_retry_at   timestamptz,
  created_at      timestamptz  NOT NULL DEFAULT now(),
  resolved_at     timestamptz,
  resolved_by     uuid         REFERENCES auth.users(id) ON DELETE SET NULL,
  resolution_note text
);

COMMENT ON TABLE public.failed_messages IS
  'Dead-letter queue for outbound message failures. Rows are inserted by '
  'edge functions (service_role) when a reply could not be delivered. '
  'Admins review and resolve via the dashboard. Contains PII in payload; '
  'non-admins read failed_messages_safe instead.';

CREATE INDEX IF NOT EXISTS failed_messages_unresolved_idx
  ON public.failed_messages (created_at DESC)
  WHERE resolved_at IS NULL;

CREATE INDEX IF NOT EXISTS failed_messages_conversation_idx
  ON public.failed_messages (conversation_id, created_at DESC);

CREATE INDEX IF NOT EXISTS failed_messages_agent_idx
  ON public.failed_messages (agent_id, created_at DESC);

CREATE INDEX IF NOT EXISTS failed_messages_source_type_idx
  ON public.failed_messages (source, error_type, created_at DESC);

ALTER TABLE public.failed_messages ENABLE ROW LEVEL SECURITY;

-- Base table: admin-only SELECT (payload may contain lead PII).
DROP POLICY IF EXISTS "admin_read_failed_messages" ON public.failed_messages;
CREATE POLICY "admin_read_failed_messages"
  ON public.failed_messages
  FOR SELECT
  TO authenticated
  USING (public.is_admin());

-- Admin-only UPDATE (mark resolved, add note).
DROP POLICY IF EXISTS "admin_resolve_failed_messages" ON public.failed_messages;
CREATE POLICY "admin_resolve_failed_messages"
  ON public.failed_messages
  FOR UPDATE
  TO authenticated
  USING (public.is_admin())
  WITH CHECK (public.is_admin());

-- Redacted view for non-admin operators: everything except `payload`
-- (which can contain phone numbers + message bodies). Useful for showing
-- "X failures today" counters without exposing PII to the whole team.
CREATE OR REPLACE VIEW public.failed_messages_safe AS
SELECT
  id,
  agent_id,
  conversation_id,
  source,
  error_type,
  error_detail,
  jsonb_build_object('redacted', true) AS payload,
  retry_count,
  last_retry_at,
  created_at,
  resolved_at,
  resolved_by,
  resolution_note
FROM public.failed_messages;

COMMENT ON VIEW public.failed_messages_safe IS
  'Non-admin-safe projection of failed_messages: payload is redacted to '
  '{"redacted":true} so phone numbers and message bodies are not exposed.';

GRANT SELECT ON public.failed_messages_safe TO authenticated;
