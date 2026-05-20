-- 0029_conversation_last_inbound_at.sql
--
-- Adds `conversations.last_inbound_at` — the timestamp of the most recent
-- inbound (lead → agent) message. NULL means the lead has not replied at
-- all yet (i.e. only a template/outreach message was sent).
--
-- Why: the unified 5-status taxonomy ("טמפלייט נשלח" / "שיחה נפתחה" /
-- "נקבע זום" / "דרוש נציג" / "שיחה סגורה") needs a cheap way to
-- distinguish "outbound exists, lead never replied" from "lead replied"
-- and to detect 48h-since-last-reply auto-close — without scanning the
-- whole `messages` table on every dashboard render.
--
-- Maintained by:
--   - `whatsapp-webhook` edge function on every inbound message ingest.
--   - Backfill below populates historical rows from existing messages.

ALTER TABLE public.conversations
  ADD COLUMN IF NOT EXISTS last_inbound_at TIMESTAMPTZ;

COMMENT ON COLUMN public.conversations.last_inbound_at IS
  'Timestamp of the most recent inbound (lead -> agent) message. NULL when the lead has not replied yet. Maintained by whatsapp-webhook.';

UPDATE public.conversations c
SET last_inbound_at = sub.max_ts
FROM (
  SELECT conversation_id, MAX(timestamp) AS max_ts
  FROM public.messages
  WHERE direction = 'inbound'
  GROUP BY conversation_id
) sub
WHERE c.id = sub.conversation_id
  AND c.last_inbound_at IS DISTINCT FROM sub.max_ts;

CREATE INDEX IF NOT EXISTS idx_conversations_last_inbound_at
  ON public.conversations (last_inbound_at DESC NULLS LAST);
