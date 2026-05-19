-- 0027_agent_quiet_hours.sql
--
-- Per-agent quiet hours, evaluated in Asia/Jerusalem time. Operator
-- requested this during the early-pilot supervision period: bot off
-- between 20:00 and 08:00 so a human is always around for any reply.
--
-- Both layers respect this:
--   1. Template dispatcher — skips scheduled_messages whose agent is in
--      quiet hours. The row stays pending; auto-drains at wake-up.
--   2. Agent reply loop (whatsapp-webhook) — inbound row is persisted as
--      usual, but Claude is not called. An operator alert fires instead.
--
-- Stored as 0-23 hour ints, Asia/Jerusalem.
-- start > end wraps midnight (e.g. 20 → 8 = quiet from 20:00 to 07:59).
-- Set both to NULL to disable quiet hours (24/7 operation).

ALTER TABLE public.agents
  ADD COLUMN IF NOT EXISTS quiet_hours_start_il integer
    CHECK (quiet_hours_start_il IS NULL OR (quiet_hours_start_il BETWEEN 0 AND 23)),
  ADD COLUMN IF NOT EXISTS quiet_hours_end_il integer
    CHECK (quiet_hours_end_il IS NULL OR (quiet_hours_end_il BETWEEN 0 AND 23));

UPDATE public.agents
SET quiet_hours_start_il = 20,
    quiet_hours_end_il = 8
WHERE name = 'affiliate_marketing';
