-- 0019_messages_index_and_phone_routing.sql
--
-- Two changes that unblock scale:
--
-- 1. Composite indexes on the two hottest queries:
--    - messages list per conversation (every conversation open + every
--      realtime invalidation hits this).
--    - conversations list per agent ordered by last interaction.
--
-- 2. agents.whatsapp_phone_number_id: lets the webhook route inbound
--    by phone number ID (from Meta payload) instead of HOOKMYAPP_AGENT_NAME
--    env var. Required before we can add a second agent without forking
--    the function. Nullable for backward compat — existing single-agent
--    deploys continue to work via the env fallback in whatsapp-webhook.

CREATE INDEX IF NOT EXISTS messages_conversation_timestamp_idx
  ON public.messages (conversation_id, timestamp DESC);

CREATE INDEX IF NOT EXISTS conversations_agent_interaction_idx
  ON public.conversations (agent_id, last_interaction_at DESC NULLS LAST);

ALTER TABLE public.agents
  ADD COLUMN IF NOT EXISTS whatsapp_phone_number_id text;

CREATE UNIQUE INDEX IF NOT EXISTS agents_whatsapp_phone_number_id_uq
  ON public.agents (whatsapp_phone_number_id)
  WHERE whatsapp_phone_number_id IS NOT NULL;
