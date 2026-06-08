-- 0034_scheduled_messages_delivery_status.sql
--
-- New columns: scheduled_messages.delivered_at, scheduled_messages.read_at
--
-- Why: WhatsApp/Meta delivery + read receipts ALREADY reach us — the
-- whatsapp-webhook routes `value.statuses[]` to ingestDeliveryStatus(), which
-- looks the message up by meta_message_id. Today it only writes them to
-- error_logs (info/error) and drops the state. Persisting delivered/read on
-- the template-send row lets the template funnel show the real
-- sent → delivered → read → answered → zoom progression.
--
-- These are DISTINCT from `status` (the SEND lifecycle: pending/sent/failed/
-- cancelled). delivered_at/read_at are the Meta DELIVERY lifecycle.
-- ingestDeliveryStatus sets them by meta_message_id with COALESCE (first write
-- wins — idempotent against Meta's repeated callbacks). read implies delivered.

ALTER TABLE public.scheduled_messages
  ADD COLUMN IF NOT EXISTS delivered_at timestamptz,
  ADD COLUMN IF NOT EXISTS read_at timestamptz;

COMMENT ON COLUMN public.scheduled_messages.delivered_at IS
  'When Meta reported the template message delivered (status=delivered, or implied by read). Set by ingestDeliveryStatus via meta_message_id. NULL = not yet delivered / pre-dates capture.';
COMMENT ON COLUMN public.scheduled_messages.read_at IS
  'When Meta reported the template message read (status=read). Set by ingestDeliveryStatus via meta_message_id. NULL = not yet read / pre-dates capture.';
