-- 0036_claim_scheduled_messages_v2.sql
--
-- Replaces claim_scheduled_messages() with a v2 that returns:
--   • agent_quiet_hours_start_il / agent_quiet_hours_end_il — so the
--     dispatcher can honour quiet-hours without a second round-trip.
--   • conversation_status / conversation_current_tag — so the dispatcher
--     can skip rows whose conversation is paused, zoom-scheduled, etc.
--     (previously the dispatcher fired templates into ANY conversation
--     regardless of its current state, including zoom_scheduled leads).
--
-- Drops the old meeting_check_url / meeting_check_enabled columns from the
-- return set — the Mooz pre-check path was removed from the dispatcher in
-- the same refactor cycle, so those fields are no longer consumed.
--
-- The locking logic (FOR UPDATE OF sm SKIP LOCKED + claimed_at CTE stamp)
-- is unchanged from 0025.

CREATE OR REPLACE FUNCTION public.claim_scheduled_messages(
  p_limit int,
  p_now timestamptz,
  p_claim_grace_seconds int DEFAULT 600
)
RETURNS TABLE (
  id                        uuid,
  agent_id                  uuid,
  conversation_id           uuid,
  lead_phone                text,
  lead_name                 text,
  template_name             text,
  template_language         text,
  template_variables        jsonb,
  attempts                  int,
  agent_is_paused           boolean,
  agent_quiet_hours_start_il int,
  agent_quiet_hours_end_il  int,
  conversation_status       text,
  conversation_current_tag  text
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
    m.id,
    m.agent_id,
    m.conversation_id,
    m.lead_phone,
    m.lead_name,
    m.template_name,
    m.template_language,
    m.template_variables,
    m.attempts,
    a.is_paused                   AS agent_is_paused,
    a.quiet_hours_start_il        AS agent_quiet_hours_start_il,
    a.quiet_hours_end_il          AS agent_quiet_hours_end_il,
    c.status                      AS conversation_status,
    c.current_tag                 AS conversation_current_tag
  FROM marked m
  JOIN public.agents a ON a.id = m.agent_id
  LEFT JOIN public.conversations c ON c.id = m.conversation_id;
END;
$$;

-- Grants are re-applied after CREATE OR REPLACE to be safe.
REVOKE EXECUTE ON FUNCTION public.claim_scheduled_messages(int, timestamptz, int) FROM PUBLIC;
GRANT  EXECUTE ON FUNCTION public.claim_scheduled_messages(int, timestamptz, int) TO service_role;
