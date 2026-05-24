-- 0032_agent_mooz_correct_meeting_type.sql
--
-- Migration 0030 set affiliate_marketing.meeting_type_id to
--   9b5648d3-2a45-4bee-be6a-b463a92ac8a5
-- which Mooz support originally identified as the affiliate-marketing
-- mentor meeting. After live testing on 2026-05-24 Kfir confirmed that
-- the correct meeting type for the agent to book into is actually:
--
--   name:        "פגישת זום - בדיקת התאמה למסלול אפילייאט"
--   uuid:        d637d916-5ae6-4807-b856-2f7feea18173
--   numeric_id:  2
--   slug:        richer_affiliate
--   duration:    30 minutes
--   org_id:      915d9ade-c7e0-43c9-b8b5-871d9df97ad5  (unchanged)
--
-- Both meeting types live under the same Mooz org, so the existing
-- MOOZ_ORG_API_KEY keeps working. No env change required.

UPDATE agents
SET meeting_type_id = 'd637d916-5ae6-4807-b856-2f7feea18173'
WHERE name = 'affiliate_marketing';
