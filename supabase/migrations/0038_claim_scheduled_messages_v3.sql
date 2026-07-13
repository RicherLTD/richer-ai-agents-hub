-- 0038_claim_scheduled_messages_v3.sql
--
-- Adds conversation_manual_mode_since to the claim_scheduled_messages()
-- return set so the dispatcher can DEFER (not cancel) a queued template
-- whose conversation an operator has taken over manually. Firing a
-- first-touch / re-engagement template into a live human-handled chat would
-- step on the operator. Unlike paused/blocking-tag rows (which the
-- dispatcher cancels), manual mode is temporary — the operator hands the
-- conversation back to AI — so the row stays pending and retries next tick.
--
-- Everything else is unchanged from 0036 (locking, claimed_at stamp,
-- quiet-hours + conversation_status/current_tag columns).

CREATE OR REPLACE FUNCTION public.claim_scheduled_messages(
  p_limit int,
  p_now timestamptz,
  p_claim_grace_seconds int DEFAULT 600
)
RETURNS TABLE (
  id                            uuid,
  agent_id                      uuid,
  conversation_id               uuid,
  lead_phone                    text,
  lead_name                     text,
  template_name                 text,
  template_language             text,
  template_variables            jsonb,
  attempts                      int,
  agent_is_paused               boolean,
  agent_quiet_hours_start_il    int,
  agent_quiet_hours_end_il      int,
  conversation_status           text,
  conversation_current_tag      text,
  conversation_manual_mode_since timestamptz
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
    c.current_tag                 AS conversation_current_tag,
    c.manual_mode_since           AS conversation_manual_mode_since
  FROM marked m
  JOIN public.agents a ON a.id = m.agent_id
  LEFT JOIN public.conversations c ON c.id = m.conversation_id;
END;
$$;

-- Grants are re-applied after CREATE OR REPLACE to be safe.
REVOKE EXECUTE ON FUNCTION public.claim_scheduled_messages(int, timestamptz, int) FROM PUBLIC;
GRANT  EXECUTE ON FUNCTION public.claim_scheduled_messages(int, timestamptz, int) TO service_role;
