-- 0007_messages_idempotency.sql
--
-- Adds idempotency on inbound WhatsApp messages by recording Meta's
-- `message.id` (delivered as `id` in the webhook payload) and enforcing
-- uniqueness when present.
--
-- Why: Meta/HookMyApp can retry a webhook delivery if it doesn't get a 200
-- in time. Without this, the same inbound message would be inserted twice,
-- which then triggers the Claude reply loop twice → duplicate replies sent
-- to the lead. That's the single highest-impact bug we can hit in
-- production, so it MUST land before the first real-traffic pilot.
--
-- Companion change required: this column does nothing on its own — the
-- inbound insert in whatsapp-webhook/index.ts must (a) write the wamid
-- here and (b) treat the resulting Postgres 23505 unique_violation as a
-- successful no-op skip (don't re-trigger the agent loop for a duplicate
-- delivery). Both changes ship together in the same PR.
--
-- Design notes:
--   - Column is nullable because historical rows pre-migration lack one,
--     and outbound rows only get a wamid after HookMyApp returns it.
--   - The unique index is PARTIAL (WHERE meta_message_id IS NOT NULL) so
--     multiple NULL rows are still allowed without conflict.
--   - The scope of uniqueness is global (not per-conversation) because
--     Meta message ids are globally unique strings like
--     "wamid.HBgM..." — collisions across conversations are not a thing.
--
-- Idempotent: ADD COLUMN IF NOT EXISTS + CREATE UNIQUE INDEX IF NOT EXISTS.

ALTER TABLE public.messages
  ADD COLUMN IF NOT EXISTS meta_message_id text;

COMMENT ON COLUMN public.messages.meta_message_id IS
  'Meta/HookMyApp wamid. Set on inbound rows to deduplicate webhook '
  'retries (handler must insert this value + handle 23505 as a no-op '
  'skip); set on outbound rows from the HookMyApp send response to '
  'correlate dashboard sends with Meta delivery receipts.';

CREATE UNIQUE INDEX IF NOT EXISTS messages_meta_message_id_unique
  ON public.messages (meta_message_id)
  WHERE meta_message_id IS NOT NULL;
