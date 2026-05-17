-- 0022_q7_email_and_agent_meeting_config.sql
--
-- Adds:
--   1. lead_memory.q7_email     — captured by the bot in the warmup flow so
--      downstream automations (Mooz booking, Fireberry CRM) get the lead's
--      email without a manual follow-up.
--   2. agents.meeting_type_id   — per-agent meeting-type identifier consumed
--      by the Mooz "Create Booking" API. Stored on the agent row so the
--      handoff webhook stays generic (meeting type belongs to the product,
--      not to the lead).
--   3. agents.meeting_duration_minutes — fixed meeting length per agent.
--      Defaults to 30 because the first agent (affiliate_marketing /
--      האחים סיטון) is a half-hour consult. Used to compute meeting_end_at
--      when start_time is sent to Mooz.
--
-- Backfill: the production affiliate_marketing agent uses meeting_type_id='2'
--           (operator-confirmed). All other rows stay NULL until configured.

ALTER TABLE public.lead_memory
  ADD COLUMN IF NOT EXISTS q7_email text;

ALTER TABLE public.agents
  ADD COLUMN IF NOT EXISTS meeting_type_id text,
  ADD COLUMN IF NOT EXISTS meeting_duration_minutes integer NOT NULL DEFAULT 30
    CHECK (meeting_duration_minutes BETWEEN 5 AND 480);

UPDATE public.agents
SET meeting_type_id = '2',
    meeting_duration_minutes = 30
WHERE name = 'affiliate_marketing';
