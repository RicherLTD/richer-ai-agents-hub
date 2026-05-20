-- 0030_agent_mooz_uuid_meeting_type.sql
--
-- Migrates the affiliate_marketing agent's meeting_type_id from the legacy
-- numeric_id ('2') to the UUID form ('9b5648d3-2a45-4bee-be6a-b463a92ac8a5').
--
-- Why: Mooz's create_booking API requires the UUID form of meeting_type_id,
-- not the numeric_id. The numeric form was a leftover from an earlier
-- prototype that never wired up real booking — only the existence check.
-- With the real Mooz tool-use integration landing, the bot needs to pass
-- this value straight through to create_booking, so it must be the UUID.
--
-- Source of truth: Mooz support confirmed on 2026-05-20 that:
--   9b5648d3-2a45-4bee-be6a-b463a92ac8a5  =  "פגישה ראשונית עם מנטור במסלול שיווק שותפים"
--
-- The agents.meeting_type_id column type is `text` so no schema change is
-- needed; just the value flips.

UPDATE public.agents
SET meeting_type_id = '9b5648d3-2a45-4bee-be6a-b463a92ac8a5'
WHERE name = 'affiliate_marketing'
  AND meeting_type_id = '2';
