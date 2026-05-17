-- 0020_kill_switch_and_re_engagement.sql
--
-- Two new ops/safety capabilities:
--
-- 1. agents.is_paused — Kill Switch. When true, whatsapp-webhook accepts
--    inbound but does NOT call Claude. Lets the operator stop the bot
--    instantly without redeploying or rotating secrets.
--
-- 2. conversations.re_engaged_at — cooldown tracker. The re-engagement
--    cron sends one follow-up to cold leads. This timestamp marks
--    "already nudged once" so subsequent runs skip the row.

ALTER TABLE public.agents
  ADD COLUMN IF NOT EXISTS is_paused boolean NOT NULL DEFAULT false;

ALTER TABLE public.conversations
  ADD COLUMN IF NOT EXISTS re_engaged_at timestamptz;

CREATE INDEX IF NOT EXISTS conversations_re_engagement_idx
  ON public.conversations (last_interaction_at)
  WHERE re_engaged_at IS NULL AND status = 'active';
