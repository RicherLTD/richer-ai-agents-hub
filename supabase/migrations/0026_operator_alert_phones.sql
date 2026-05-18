-- 0026_operator_alert_phones.sql
--
-- Per-agent list of phone numbers that receive WhatsApp alerts when the
-- agent loop gives up on a lead. We send to each operator as a 1-on-1
-- message rather than to a WhatsApp group because Meta Cloud API does
-- not reliably support business→group sends for unverified WABAs.
--
-- Stored as +E.164 strings. Empty array → no alerts (default).

ALTER TABLE public.agents
  ADD COLUMN IF NOT EXISTS operator_alert_phones text[] NOT NULL DEFAULT '{}'::text[];

-- Backfill: Kfir + Yitzhak for the affiliate_marketing agent.
UPDATE public.agents
SET operator_alert_phones = ARRAY['+972512310702', '+972525563338']::text[]
WHERE name = 'affiliate_marketing';
