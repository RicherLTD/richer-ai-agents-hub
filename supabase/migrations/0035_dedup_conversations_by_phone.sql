-- 0035_dedup_conversations_by_phone.sql
--
-- ONE-TIME DATA REPAIR — merge duplicate `conversations` rows created by the
-- +972 vs 972 phone-format split, then normalize every phone to canonical
-- digits-only (972…). See _shared/normalizePhone.ts (toCanonicalPhone) and the
-- lead-register fix that stops NEW duplicates.
--
-- ⚠️ RUN ORDER: deploy the lead-register fix FIRST, then apply this, so no new
-- duplicates form between the merge and the deploy.
--
-- Dry-run on 2026-06-08 (prod): 1317 conversations, 217 duplicate groups
-- (each a +972 "shell" + a 972 "reply"), 217 rows removed, 14 groups where
-- BOTH rows are active (survivor rule below resolves them deterministically).
--
-- SURVIVOR per (agent_id, normalized phone): the most-advanced row —
--   1. has last_inbound_at (the lead replied)   2. current_tag='zoom_scheduled'
--   3. latest last_interaction_at   4. earliest created_at (the original)
--   5. id (stable tiebreak).
-- Child rows (messages, scheduled_messages, failed_messages, error_logs,
-- lead_memory) are repointed to the survivor; selected survivor fields are
-- backfilled from losers (never overwritten); losers are deleted.
--
-- IDEMPOTENT: re-running after success is a no-op (no groups have >1 row, and
-- all phones are already canonical).

BEGIN;

-- 1. Resolve the survivor for every conversation row.
CREATE TEMP TABLE _dedup ON COMMIT DROP AS
WITH ranked AS (
  SELECT
    id,
    agent_id,
    regexp_replace(lead_phone, '\D', '', 'g') AS np,
    row_number() OVER (
      PARTITION BY agent_id, regexp_replace(lead_phone, '\D', '', 'g')
      ORDER BY
        (last_inbound_at IS NOT NULL) DESC,
        (current_tag = 'zoom_scheduled') DESC,
        last_interaction_at DESC NULLS LAST,
        created_at ASC NULLS LAST,
        id ASC
    ) AS rn
  FROM conversations
)
SELECT
  r.id,
  r.agent_id,
  r.np,
  (SELECT r2.id FROM ranked r2
     WHERE r2.agent_id = r.agent_id AND r2.np = r.np AND r2.rn = 1) AS survivor_id
FROM ranked r;

-- 2. Repoint child rows from losers to the survivor.
UPDATE messages m SET conversation_id = d.survivor_id
  FROM _dedup d WHERE m.conversation_id = d.id AND d.id <> d.survivor_id;

UPDATE scheduled_messages s SET conversation_id = d.survivor_id
  FROM _dedup d WHERE s.conversation_id = d.id AND d.id <> d.survivor_id;

UPDATE failed_messages f SET conversation_id = d.survivor_id
  FROM _dedup d WHERE f.conversation_id = d.id AND d.id <> d.survivor_id;

UPDATE error_logs e SET conversation_id = d.survivor_id
  FROM _dedup d WHERE e.conversation_id = d.id AND d.id <> d.survivor_id;

-- 3. lead_memory is 1:1 (PK = conversation_id). Move a loser's memory to the
--    survivor only when the survivor has none; otherwise drop the loser's.
UPDATE lead_memory lm SET conversation_id = d.survivor_id
  FROM _dedup d
  WHERE lm.conversation_id = d.id AND d.id <> d.survivor_id
    AND NOT EXISTS (SELECT 1 FROM lead_memory s WHERE s.conversation_id = d.survivor_id);

DELETE FROM lead_memory lm USING _dedup d
  WHERE lm.conversation_id = d.id AND d.id <> d.survivor_id;

-- 4. Backfill survivor fields from losers (fill NULLs / keep strongest); never
--    overwrite an existing survivor value. GREATEST/COALESCE ignore NULLs.
UPDATE conversations surv SET
  lead_name           = COALESCE(surv.lead_name, agg.lead_name),
  last_inbound_at     = GREATEST(surv.last_inbound_at, agg.last_inbound_at),
  last_interaction_at = GREATEST(surv.last_interaction_at, agg.last_interaction_at),
  re_engaged_at       = COALESCE(surv.re_engaged_at, agg.re_engaged_at),
  source_campaign     = COALESCE(surv.source_campaign, agg.source_campaign),
  source_funnel       = COALESCE(surv.source_funnel, agg.source_funnel)
FROM (
  SELECT
    d.survivor_id,
    max(c.lead_name)            FILTER (WHERE c.lead_name IS NOT NULL)       AS lead_name,
    max(c.last_inbound_at)                                                   AS last_inbound_at,
    max(c.last_interaction_at)                                               AS last_interaction_at,
    max(c.re_engaged_at)                                                     AS re_engaged_at,
    max(c.source_campaign)      FILTER (WHERE c.source_campaign IS NOT NULL) AS source_campaign,
    max(c.source_funnel)        FILTER (WHERE c.source_funnel IS NOT NULL)   AS source_funnel
  FROM _dedup d
  JOIN conversations c ON c.id = d.id
  WHERE d.id <> d.survivor_id
  GROUP BY d.survivor_id
) agg
WHERE surv.id = agg.survivor_id;

-- 5. Delete the loser rows (children already repointed).
DELETE FROM conversations c USING _dedup d
  WHERE c.id = d.id AND d.id <> d.survivor_id;

-- 6. Normalize ALL remaining phones to canonical digits-only. Safe now that
--    each (agent_id, lead_phone) is unique post-merge.
UPDATE conversations
  SET lead_phone = regexp_replace(lead_phone, '\D', '', 'g')
  WHERE lead_phone <> regexp_replace(lead_phone, '\D', '', 'g');

UPDATE scheduled_messages
  SET lead_phone = regexp_replace(lead_phone, '\D', '', 'g')
  WHERE lead_phone <> regexp_replace(lead_phone, '\D', '', 'g');

COMMIT;
