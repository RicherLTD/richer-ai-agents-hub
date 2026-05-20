-- 0031_mooz_webhook_events.sql
--
-- Idempotency log for inbound Mooz webhooks. Mooz delivers each event with
-- an `X-Idempotency-Key` header and retries with the same key on 5xx /
-- network failures, so we need a write-once record to detect duplicates
-- and short-circuit before we apply side-effects (conversation update +
-- handoff webhook fan-out).
--
-- Granularity: PK on (event, mooz_booking_id, idempotency_key). The same
-- booking can legitimately produce multiple events (created → cancelled →
-- rescheduled), each with its own idempotency key — but a given key for a
-- given (event, booking) pair is unique.
--
-- Retention: keep forever for audit. Rows are tiny (~150 bytes each) and
-- this table is the only ground-truth of "did we process this Mooz event?"
-- that's queryable without inspecting Make.com.

CREATE TABLE IF NOT EXISTS public.mooz_webhook_events (
  id BIGSERIAL PRIMARY KEY,
  event TEXT NOT NULL,
  mooz_booking_id TEXT NOT NULL,
  idempotency_key TEXT NOT NULL,
  received_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  CONSTRAINT mooz_webhook_events_unique UNIQUE (event, mooz_booking_id, idempotency_key)
);

CREATE INDEX IF NOT EXISTS idx_mooz_webhook_events_received_at
  ON public.mooz_webhook_events (received_at DESC);

CREATE INDEX IF NOT EXISTS idx_mooz_webhook_events_booking
  ON public.mooz_webhook_events (mooz_booking_id);

COMMENT ON TABLE public.mooz_webhook_events IS
  'Idempotency log for inbound Mooz webhooks. Insert before applying side effects; 23505 (unique violation) means duplicate retry — short-circuit and return 200.';

-- RLS: only the service role (used by the mooz-webhook edge function)
-- writes here. Authenticated users can read for audit purposes from the
-- dashboard.
ALTER TABLE public.mooz_webhook_events ENABLE ROW LEVEL SECURITY;

DROP POLICY IF EXISTS authenticated_read_mooz_webhook_events ON public.mooz_webhook_events;
CREATE POLICY authenticated_read_mooz_webhook_events
  ON public.mooz_webhook_events
  FOR SELECT
  TO authenticated
  USING (true);
