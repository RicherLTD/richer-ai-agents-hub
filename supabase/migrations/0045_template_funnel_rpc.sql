-- 0045_template_funnel_rpc.sql
--
-- Moves the template-funnel aggregation from the browser INTO the database.
--
-- WHY: the funnel widget (משפך לפי טמפלייט) used to fetch up to SAFETY_LIMIT
-- (2000) raw `scheduled_messages` + 2000 raw `conversations` rows to the client
-- and aggregate in JS. Once an agent grows past 2000 rows in either table (the
-- affiliate agent now has ~4.4k sends / ~4k conversations), the client received
-- an arbitrary, unordered 2000-row slice of EACH table. sent/delivered/read
-- (computed from one table) came out undercounted; answered/agent-zoom (which
-- need a phone to appear in BOTH slices) collapsed toward 0 because the two
-- independent arbitrary slices barely intersected. Result: a healthy cohort of
-- 767 answered / 41 agent-booked zooms rendered as 0.
--
-- FIX: aggregate server-side over the FULL tables and return only the already
-- summed per-template rows. No client-side row cap needed, correct at any scale,
-- and one small round-trip instead of thousands of rows.
--
-- This mirrors, 1:1, the pure aggregator `aggregateTemplateFunnel` in
-- src/lib/template-funnel.ts (kept as the reference spec + unit tests):
--   * sends/outcomes joined by NORMALIZED phone (digits only) — `+972…` and
--     `972…` sibling rows collapse to one person.
--   * cohort windowed by sent_at (sent) / created_at (failed); outcomes read
--     from the lead's CURRENT state regardless of when they happened.
--   * per (template, phone) de-dup; a phone counts once per template.
--   * zoom kept as the STRONGEST category per phone
--     (agent > self > consent_handoff > legacy), only `agent` is the conversion.
--
-- SECURITY INVOKER (default): the function reads under the CALLER's RLS, so the
-- existing admin-only read policies (migration 0018) govern access exactly as
-- the old direct client queries did. No RLS bypass is introduced.

CREATE OR REPLACE FUNCTION public.template_funnel(
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
  agent_zoom_per_sent_pct      numeric
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
  -- send rows; delivered/read gated on the same sent+in-window predicate as JS.
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
      ) AS is_failed
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
      count(*) FILTER (WHERE j.is_failed)        AS failed
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
    CASE WHEN a.sent = 0     THEN 0 ELSE round(a.agent_zoom::numeric / a.sent     * 1000) / 10 END AS agent_zoom_per_sent_pct
  FROM agg a
  WHERE a.sent > 0 OR a.failed > 0
  ORDER BY a.sent DESC, a.template_name ASC;
$$;

REVOKE EXECUTE ON FUNCTION public.template_funnel(uuid, timestamptz, timestamptz, uuid) FROM PUBLIC;
GRANT  EXECUTE ON FUNCTION public.template_funnel(uuid, timestamptz, timestamptz, uuid) TO authenticated;
