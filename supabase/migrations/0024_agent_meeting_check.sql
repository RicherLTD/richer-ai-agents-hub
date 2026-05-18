-- 0024_agent_meeting_check.sql
--
-- Adds the "pre-send Mooz check" knobs to agents.
--
-- Problem this solves:
--   A lead registers on a landing page and gets queued for a 40-minute
--   first-touch template (migration 0023). During those 40 minutes the
--   lead may book a Zoom directly in Mooz on his own. If we still send
--   the template, the lead receives a follow-up about a meeting he
--   already has -- bad experience, looks like nobody at the company is
--   talking to anybody.
--
-- Fix:
--   Just before `dispatch-scheduled-templates` sends a template row, it
--   pings the booking system (Mooz today; the URL is per-agent so a
--   different agent could point at Calendly etc.) asking "is this phone
--   already booked?". If yes -> cancel the row, tag the conversation as
--   zoom_scheduled, pause it. If no -> send as planned.
--
-- This migration only stores the per-agent config. The check itself is
-- wired in `supabase/functions/dispatch-scheduled-templates/index.ts` and
-- `supabase/functions/_shared/moozCheck.ts`. The bearer token used to
-- authenticate against Mooz is a Supabase secret (`MOOZ_API_TOKEN`),
-- shared across agents -- only the URL is per-agent.
--
-- Defaults are opt-in: every existing agent stays `meeting_check_enabled = false`
-- until the operator wires up the Mooz endpoint and flips the switch.
-- We deliberately do NOT backfill the affiliate_marketing agent here --
-- the URL must be known and reachable before enablement, and that
-- happens via the Settings UI / SQL after Mooz is deployed.

ALTER TABLE public.agents
  ADD COLUMN IF NOT EXISTS meeting_check_url text,
  ADD COLUMN IF NOT EXISTS meeting_check_enabled boolean NOT NULL DEFAULT false;

-- A URL is meaningless without enablement, but `meeting_check_enabled = true`
-- with a NULL/blank URL would be a misconfiguration that silently disables
-- the safety check. Guard at the schema level.
ALTER TABLE public.agents
  ADD CONSTRAINT agents_meeting_check_url_when_enabled
  CHECK (
    meeting_check_enabled = false
    OR (meeting_check_url IS NOT NULL AND length(trim(meeting_check_url)) > 0)
  );
