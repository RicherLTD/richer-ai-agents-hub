-- 0025_dispatcher_atomic_claim.sql
--
-- Closes the race in `dispatch-scheduled-templates` where two overlapping
-- cron ticks (60-second cadence; a slow tick under degraded Mooz can run
-- longer than that) could both pick up the same pending row, both call
-- Mooz, and both fire the WhatsApp template.
--
-- Approach: a SECURITY DEFINER function that:
--   1. SELECTs eligible rows with FOR UPDATE SKIP LOCKED so a concurrent
--      tick cant see them.
--   2. Stamps `claimed_at = now()` on each row in the SAME statement
--      (CTE) so the row is invisible to the next tick once the function
--      returns.
--   3. Returns the rows joined with the agent fields the dispatcher
--      needs (is_paused, meeting_check_url, meeting_check_enabled).
--
-- Why not add a `processing` value to the scheduled_message_status enum?
--   Postgres ALTER TYPE ADD VALUE has historical transaction restrictions
--   that make migration tooling unreliable. A nullable `claimed_at`
--   column avoids the issue entirely and gives us a free crash-recovery
--   knob: a row with `claimed_at` older than the grace window is
--   re-claimable, which means a dispatcher crash mid-batch wont strand
--   the row forever.
--
-- The dispatcher pairs this with two release patterns:
--   a) On terminal outcome (sent/cancelled/failed) -> status changes
--      and the row drops out of the `status = pending` filter naturally.
--      `claimed_at` value is left in place but irrelevant.
--   b) On fail-closed hold (Mooz timeout/5xx/network/etc) -> dispatcher
--      sets `claimed_at = NULL` + bumps attempts so the next tick can
--      retry.
--
-- A 10-minute grace window covers Edge Function wall-clock limits with
-- room to spare; a row claimed more than 10 minutes ago is treated as
-- "crashed mid-process" and re-claimable.

-- 1. Claim marker column.
ALTER TABLE public.scheduled_messages
  ADD COLUMN IF NOT EXISTS claimed_at timestamptz;

-- 2. Index supporting the dispatcher claim query. Partial index keeps
--    it tiny: only rows that are actually eligible for dispatch live in it.
CREATE INDEX IF NOT EXISTS scheduled_messages_pending_unclaimed_idx
  ON public.scheduled_messages (scheduled_for)
  WHERE status = 'pending' AND claimed_at IS NULL;

-- 3. Atomic claim function. Returns 0..N rows; never throws on empty.
--    The CTE pattern (claimed -> marked -> joined) ensures the lock,
--    the stamp, and the read happen in one statement -- there is no
--    window where another tick can see the row "claimed but not stamped".
CREATE OR REPLACE FUNCTION public.claim_scheduled_messages(
  p_limit int,
  p_now timestamptz,
  p_claim_grace_seconds int DEFAULT 600
)
RETURNS TABLE (
  id uuid,
  agent_id uuid,
  conversation_id uuid,
  lead_phone text,
  lead_name text,
  template_name text,
  template_language text,
  template_variables jsonb,
  attempts int,
  agent_is_paused boolean,
  agent_meeting_check_url text,
  agent_meeting_check_enabled boolean
)
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
BEGIN
  RETURN QUERY
  WITH claimed AS (
    SELECT sm.id
    FROM public.scheduled_messages sm
    JOIN public.agents a ON a.id = sm.agent_id
    WHERE sm.status = 'pending'
      AND sm.scheduled_for <= p_now
      AND a.is_paused = false
      AND (
        sm.claimed_at IS NULL
        OR sm.claimed_at < p_now - make_interval(secs => p_claim_grace_seconds)
      )
    ORDER BY sm.scheduled_for
    LIMIT p_limit
    FOR UPDATE OF sm SKIP LOCKED
  ),
  marked AS (
    UPDATE public.scheduled_messages sm
    SET claimed_at = p_now, updated_at = p_now
    FROM claimed
    WHERE sm.id = claimed.id
    RETURNING sm.*
  )
  SELECT
    m.id, m.agent_id, m.conversation_id, m.lead_phone, m.lead_name,
    m.template_name, m.template_language, m.template_variables, m.attempts,
    a.is_paused, a.meeting_check_url, a.meeting_check_enabled
  FROM marked m
  JOIN public.agents a ON a.id = m.agent_id;
END;
$$;

-- 4. Tighten the grants. SECURITY DEFINER + restricted execute means
--    only the service-role-bearing edge function can call this, even
--    though the function bypasses RLS internally.
REVOKE EXECUTE ON FUNCTION public.claim_scheduled_messages(int, timestamptz, int) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION public.claim_scheduled_messages(int, timestamptz, int) TO service_role;
