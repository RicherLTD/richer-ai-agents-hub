-- 0010_conversations_agent_phone_unique.sql
--
-- Adds a unique index on `conversations(agent_id, lead_phone)` to close a
-- race condition in the WhatsApp webhook: two simultaneous deliveries for
-- a new lead could both SELECT, both miss, and both INSERT a new
-- conversation row → the lead's history is silently split across two
-- conversation ids, the agent gets half the context, and the dashboard
-- shows two phantom conversations for one person.
--
-- With this index, the webhook can use an upsert with onConflict and is
-- safe under concurrent deliveries.
--
-- Migration safety: if any duplicate (agent_id, lead_phone) pairs exist
-- in production already, this CREATE will fail. We expect no dupes at
-- pilot volume (single sandbox phone, single agent) — operator should
-- run the diagnostic query in the comment block below if the migration
-- errors out and merge the rows manually before re-running.
--
-- Diagnostic (run before re-applying if migration fails):
--   SELECT agent_id, lead_phone, COUNT(*), array_agg(id)
--     FROM public.conversations
--    GROUP BY agent_id, lead_phone
--   HAVING COUNT(*) > 1;
--
-- Idempotent: CREATE UNIQUE INDEX IF NOT EXISTS.

CREATE UNIQUE INDEX IF NOT EXISTS conversations_agent_phone_unique
  ON public.conversations (agent_id, lead_phone);

COMMENT ON INDEX public.conversations_agent_phone_unique IS
  'Guarantees one conversation row per (agent, lead phone). Required by '
  'the whatsapp-webhook upsert so concurrent webhook deliveries cannot '
  'create duplicate conversation rows for the same lead.';
