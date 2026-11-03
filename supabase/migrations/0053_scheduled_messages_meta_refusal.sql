-- 0053_scheduled_messages_meta_refusal.sql
--
-- Makes Meta's ASYNC refusals of template sends visible on the send row and in
-- the template funnel.
--
-- WHY: the dispatcher marks a template `sent` the moment HookMyApp accepts it.
-- Meta can still refuse it seconds later through the status webhook (status
-- `failed`): 131049 = per-user marketing limit, 131026 = unreachable,
-- 131042 = business payment issue. Until now that refusal only landed in
-- error_logs, so the funnel showed "sent, not delivered" with no reason, and a
-- sustained run of refusals (e.g. a payment issue, or a high per-user
-- marketing-limit rate) was invisible on the dashboard.
--
--   1. scheduled_messages.meta_failed_at / meta_error_code — written by the
--      webhook handler (ingestDeliveryStatus) when Meta reports `failed`.
--   2. Partial index on meta_message_id — every status callback looks the send
--      up by wamid, and there was no index (≈29k rows, a seq scan per callback).
--   3. One-time backfill from error_logs: `meta_delivery_failed` rows carry the
--      wamid and the Meta error code in `context`. First failure per wamid wins,
--      matching the handler's `meta_failed_at IS NULL` guard.
--   4. template_funnel() gains refused / refused_marketing_limit /
--      refused_rate_pct, mirroring aggregateTemplateFunnel in
--      src/lib/template-funnel.ts 1:1: a person is refused when an in-window
--      sent row was refused AND no in-window send of the template reached them.
--      The return type changes, so the function is DROPPED first —
--      CREATE OR REPLACE cannot change OUT columns (42P13).
--
-- Idempotent: IF NOT EXISTS / IF EXISTS everywhere, backfill only fills NULLs.
-- Backwards compatible: the old dashboard ignores the extra RPC columns.

BEGIN;

ALTER TABLE public.scheduled_messages
  ADD COLUMN IF NOT EXISTS meta_failed_at  timestamptz,
  ADD COLUMN IF NOT EXISTS meta_error_code integer;

COMMENT ON COLUMN public.scheduled_messages.meta_failed_at IS
  'When Meta''s status webhook reported `failed` for this send (async refusal after the API accepted it). NULL = no refusal seen.';
COMMENT ON COLUMN public.scheduled_messages.meta_error_code IS
  'Meta error code of that refusal, e.g. 131049 (per-user marketing limit), 131026 (unreachable), 131042 (payment issue).';

CREATE INDEX IF NOT EXISTS scheduled_messages_meta_message_id_idx
  ON public.scheduled_messages (meta_message_id)
  WHERE meta_message_id IS NOT NULL;

UPDATE public.scheduled_messages sm
SET meta_failed_at  = f.failed_at,
    meta_error_code = f.code
FROM (
  SELECT DISTINCT ON (e.context->>'wamid')
    e.context->>'wamid' AS wamid,
    e.created_at        AS failed_at,
    CASE WHEN (e.context->>'meta_error_code') ~ '^[0-9]+$'
         THEN (e.context->>'meta_error_code')::int END AS code
  FROM public.error_logs e
  WHERE e.source = 'whatsapp-status-callback'
    AND e.error_type = 'meta_delivery_failed'
    AND e.context ? 'wamid'
  ORDER BY e.context->>'wamid', e.created_at ASC
) f
WHERE sm.meta_message_id = f.wamid
  AND sm.meta_failed_at IS NULL;

DROP FUNCTION IF EXISTS public.template_funnel(uuid, timestamptz, timestamptz, uuid);

CREATE FUNCTION public.template_funnel(
  p_agent_id     uuid,
  p_from         timestamptz DEFAULT NULL,
  p_to           timestamptz DEFAULT NULL,
  p_broadcast_id uuid        DEFAULT NULL
)
RETURNS TABLE (
  template_name                text,
  sent                         integer,
  delivered                    integer,
  read                         integer,
  answered                     integer,
  agent_zoom                   integer,
  self_zoom                    integer,
  consent_handoff              integer,
  legacy_zoom                  integer,
  failed                       integer,
  delivered_rate_pct           numeric,
  read_rate_pct                numeric,
  answered_rate_pct            numeric,
  agent_zoom_per_answered_pct  numeric,
  agent_zoom_per_sent_pct      numeric,
  refused                      integer,
  refused_marketing_limit      integer,
  refused_rate_pct             numeric
)
LANGUAGE sql
STABLE
SET search_path = public
AS $$
  WITH
  -- Outcome per normalized phone across ALL of the agent's conversations
  -- (no window — current state). Keep the strongest zoom rank.
  outcomes AS (
    SELECT
      regexp_replace(c.lead_phone, '\D', '', 'g') AS k,
      bool_or(c.last_inbound_at IS NOT NULL)      AS answered,
      max(
        CASE
          WHEN c.zoom_booked_by = 'agent'           THEN 4
          WHEN c.zoom_booked_by = 'self'            THEN 3
          WHEN c.zoom_booked_by = 'consent_handoff' THEN 2
          WHEN c.current_tag    = 'zoom_scheduled'  THEN 1  -- legacy (pre-attribution)
          ELSE 0
        END
      )                                            AS zoom_rank
    FROM public.conversations c
    WHERE c.agent_id = p_agent_id
    GROUP BY 1
  ),
  -- One row per (template, normalized phone). Flags OR-ed across the phone's
  -- send rows; delivered/read/refusal gated on the same sent+in-window
  -- predicate as JS.
  sends AS (
    SELECT
      sm.template_name,
      regexp_replace(sm.lead_phone, '\D', '', 'g') AS k,
      bool_or(
        sm.status = 'sent' AND sm.sent_at IS NOT NULL
        AND (p_from IS NULL OR sm.sent_at >= p_from)
        AND (p_to   IS NULL OR sm.sent_at <= p_to)
      ) AS is_sent,
      bool_or(
        sm.status = 'sent' AND sm.sent_at IS NOT NULL
        AND (p_from IS NULL OR sm.sent_at >= p_from)
        AND (p_to   IS NULL OR sm.sent_at <= p_to)
        AND (sm.delivered_at IS NOT NULL OR sm.read_at IS NOT NULL)
      ) AS is_delivered,
      bool_or(
        sm.status = 'sent' AND sm.sent_at IS NOT NULL
        AND (p_from IS NULL OR sm.sent_at >= p_from)
        AND (p_to   IS NULL OR sm.sent_at <= p_to)
        AND sm.read_at IS NOT NULL
      ) AS is_read,
      bool_or(
        sm.status = 'failed'
        AND (p_from IS NULL OR sm.created_at >= p_from)
        AND (p_to   IS NULL OR sm.created_at <= p_to)
      ) AS is_failed,
      bool_or(
        sm.status = 'sent' AND sm.sent_at IS NOT NULL
        AND (p_from IS NULL OR sm.sent_at >= p_from)
        AND (p_to   IS NULL OR sm.sent_at <= p_to)
        AND sm.meta_failed_at IS NOT NULL
      ) AS has_refusal,
      bool_or(
        sm.status = 'sent' AND sm.sent_at IS NOT NULL
        AND (p_from IS NULL OR sm.sent_at >= p_from)
        AND (p_to   IS NULL OR sm.sent_at <= p_to)
        AND sm.meta_failed_at IS NOT NULL
        AND sm.meta_error_code = 131049
      ) AS has_limit_refusal
    FROM public.scheduled_messages sm
    WHERE sm.agent_id = p_agent_id
      AND (p_broadcast_id IS NULL OR sm.broadcast_id = p_broadcast_id)
    GROUP BY 1, 2
  ),
  joined AS (
    SELECT
      s.template_name,
      s.is_sent,
      s.is_delivered,
      s.is_read,
      s.is_failed,
      -- Delivered wins: a person reached by any in-window send isn't refused.
      (s.has_refusal       AND NOT s.is_delivered)       AS is_refused,
      (s.has_limit_refusal AND NOT s.is_delivered)       AS is_limit_refused,
      (s.is_sent AND COALESCE(o.answered, false))        AS is_answered,
      CASE WHEN s.is_sent THEN COALESCE(o.zoom_rank, 0) ELSE 0 END AS zoom_rank
    FROM sends s
    LEFT JOIN outcomes o ON o.k = s.k
  ),
  agg AS (
    SELECT
      j.template_name,
      count(*) FILTER (WHERE j.is_sent)          AS sent,
      count(*) FILTER (WHERE j.is_delivered)     AS delivered,
      count(*) FILTER (WHERE j.is_read)          AS read,
      count(*) FILTER (WHERE j.is_answered)      AS answered,
      count(*) FILTER (WHERE j.zoom_rank = 4)    AS agent_zoom,
      count(*) FILTER (WHERE j.zoom_rank = 3)    AS self_zoom,
      count(*) FILTER (WHERE j.zoom_rank = 2)    AS consent_handoff,
      count(*) FILTER (WHERE j.zoom_rank = 1)    AS legacy_zoom,
      count(*) FILTER (WHERE j.is_failed)        AS failed,
      count(*) FILTER (WHERE j.is_refused)       AS refused,
      count(*) FILTER (WHERE j.is_limit_refused) AS refused_marketing_limit
    FROM joined j
    GROUP BY 1
  )
  SELECT
    a.template_name,
    a.sent::int, a.delivered::int, a.read::int, a.answered::int,
    a.agent_zoom::int, a.self_zoom::int, a.consent_handoff::int,
    a.legacy_zoom::int, a.failed::int,
    CASE WHEN a.sent = 0     THEN 0 ELSE round(a.delivered::numeric  / a.sent     * 1000) / 10 END AS delivered_rate_pct,
    CASE WHEN a.sent = 0     THEN 0 ELSE round(a.read::numeric       / a.sent     * 1000) / 10 END AS read_rate_pct,
    CASE WHEN a.sent = 0     THEN 0 ELSE round(a.answered::numeric   / a.sent     * 1000) / 10 END AS answered_rate_pct,
    CASE WHEN a.answered = 0 THEN 0 ELSE round(a.agent_zoom::numeric / a.answered * 1000) / 10 END AS agent_zoom_per_answered_pct,
    CASE WHEN a.sent = 0     THEN 0 ELSE round(a.agent_zoom::numeric / a.sent     * 1000) / 10 END AS agent_zoom_per_sent_pct,
    a.refused::int, a.refused_marketing_limit::int,
    CASE WHEN a.sent = 0     THEN 0 ELSE round(a.refused::numeric    / a.sent     * 1000) / 10 END AS refused_rate_pct
  FROM agg a
  WHERE a.sent > 0 OR a.failed > 0
  ORDER BY a.sent DESC, a.template_name ASC;
$$;

REVOKE EXECUTE ON FUNCTION public.template_funnel(uuid, timestamptz, timestamptz, uuid) FROM PUBLIC;
GRANT  EXECUTE ON FUNCTION public.template_funnel(uuid, timestamptz, timestamptz, uuid) TO authenticated;

COMMIT;
