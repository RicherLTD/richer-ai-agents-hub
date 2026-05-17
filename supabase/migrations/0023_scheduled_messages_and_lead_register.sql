-- 0023_scheduled_messages_and_lead_register.sql
--
-- Adds the outbound "first touch" pipeline:
--
--   Lead registers on a landing page → Make.com webhook → our
--   lead-register edge function → row in scheduled_messages with
--   scheduled_for = now() + first_touch_delay_minutes. A pg_cron job
--   fires the dispatcher every minute; the dispatcher pops due rows,
--   sends a WhatsApp Template via Meta Cloud API, records the outbound
--   message, and marks the scheduled row as 'sent'.
--
-- Why a queue table instead of inline send-with-delay?
--   Edge functions are stateless and short-lived. A 40-minute setTimeout
--   would die with the request. A DB queue + cron is the standard pattern
--   for any scheduled-send workload at this scale.
--
-- Per-agent template config lives on agents so we don't hardcode per
-- product:
--   first_touch_template_name — Meta-approved template id (e.g.
--                                 'affiliate_first_touch').
--   first_touch_template_language — usually 'he'.
--   first_touch_delay_minutes — defaults to 40 (current product policy).

CREATE TYPE public.scheduled_message_status AS ENUM (
  'pending',
  'sent',
  'failed',
  'cancelled'
);

CREATE TABLE public.scheduled_messages (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  agent_id uuid NOT NULL REFERENCES public.agents(id) ON DELETE CASCADE,
  conversation_id uuid REFERENCES public.conversations(id) ON DELETE CASCADE,
  lead_phone text NOT NULL,
  lead_name text,
  -- Meta-approved template metadata. Resolved at send-time, but stamped
  -- here so we have an audit trail of "which template were we GOING to send".
  template_name text NOT NULL,
  template_language text NOT NULL DEFAULT 'he',
  -- Ordered array of variable values: variables[0] → {{1}}, [1] → {{2}}…
  template_variables jsonb NOT NULL DEFAULT '[]'::jsonb,
  -- Free-form context — what landing page / campaign produced the lead.
  -- Useful for the dispatcher to log and for the operator to debug.
  source_campaign text,
  source_funnel text,

  scheduled_for timestamptz NOT NULL,
  status public.scheduled_message_status NOT NULL DEFAULT 'pending',
  attempts int NOT NULL DEFAULT 0,
  last_error text,

  sent_at timestamptz,
  meta_message_id text,

  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now()
);

-- Dispatcher queries: "give me everything that's pending AND due."
CREATE INDEX scheduled_messages_pending_due_idx
  ON public.scheduled_messages (scheduled_for)
  WHERE status = 'pending';

-- Dashboard / debug: scheduled timeline per agent.
CREATE INDEX scheduled_messages_agent_status_idx
  ON public.scheduled_messages (agent_id, status, scheduled_for DESC);

ALTER TABLE public.scheduled_messages ENABLE ROW LEVEL SECURITY;

-- Admin-only read for the dashboard.
CREATE POLICY scheduled_messages_admin_read
  ON public.scheduled_messages FOR SELECT TO authenticated
  USING (public.is_admin());

-- Service-role bypasses RLS (used by lead-register + dispatcher edge functions).

-- Per-agent template config.
ALTER TABLE public.agents
  ADD COLUMN IF NOT EXISTS first_touch_template_name text,
  ADD COLUMN IF NOT EXISTS first_touch_template_language text NOT NULL DEFAULT 'he',
  ADD COLUMN IF NOT EXISTS first_touch_delay_minutes int NOT NULL DEFAULT 40
    CHECK (first_touch_delay_minutes BETWEEN 0 AND 1440);

-- Backfill the affiliate_marketing agent. The actual template_name
-- needs to be set when the operator creates it in Meta Business Manager;
-- we leave a placeholder so the operator gets a clean error if they
-- forget to update it.
UPDATE public.agents
SET first_touch_template_name = 'affiliate_first_touch',
    first_touch_template_language = 'he',
    first_touch_delay_minutes = 40
WHERE name = 'affiliate_marketing';

-- updated_at trigger.
CREATE OR REPLACE FUNCTION public.scheduled_messages_set_updated_at()
RETURNS trigger
LANGUAGE plpgsql
AS $$
BEGIN
  NEW.updated_at := now();
  RETURN NEW;
END;
$$;

CREATE TRIGGER scheduled_messages_set_updated_at
  BEFORE UPDATE ON public.scheduled_messages
  FOR EACH ROW
  EXECUTE FUNCTION public.scheduled_messages_set_updated_at();
