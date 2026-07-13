-- 0040_drop_global_lead_phone_unique.sql
--
-- Removes the legacy GLOBAL unique constraint on conversations.lead_phone
-- (`conversations_lead_phone_key`), a leftover from the original single-agent
-- schema (`lead_phone text UNIQUE`). It predates multi-agent and was never
-- created by a migration.
--
-- WHY: it makes lead_phone unique ACROSS ALL agents, so the same person can
-- only ever have one conversation in the whole system. With a second agent
-- (digital_marketing / תמיר) live, a lead who already exists under
-- affiliate_marketing cannot be created under digital_marketing: the ingest
-- upsert's INSERT hits 23505 on this global constraint, and the race-recovery
-- UPDATE (correctly scoped to agent_id + lead_phone) finds no row for the new
-- agent → `conversation_race_recovery_failed` → the inbound is dropped.
--
-- The correct constraint already exists: `conversations_agent_phone_unique`
-- UNIQUE (agent_id, lead_phone) (migration 0010), which the webhook upsert and
-- the 0035 phone-dedup both key off. That one stays — it enforces one
-- conversation per (agent, phone), the documented multi-tenant model.
--
-- SAFE: dropping this constraint does not touch data and does not affect
-- affiliate_marketing (its rows remain unique per agent+phone). It only allows
-- the same phone to exist under different agents — the intended behaviour.
--
-- IDEMPOTENT via IF EXISTS.

ALTER TABLE public.conversations
  DROP CONSTRAINT IF EXISTS conversations_lead_phone_key;
