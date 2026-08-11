-- 0047_warming_release_controls.sql
--
-- Turns the warming queue into a paced "bank".
--
-- Until now a warming row became sendable the moment its timer expired, and
-- the dispatcher claims up to 50 due rows per tick and sends them in a loop.
-- So fifty templates could leave the same WhatsApp number within seconds.
-- Against a number whose quality rating the live bot depends on, that is the
-- fastest route to a Meta block — especially since warming deliberately
-- messages leads whose opt-in we cannot prove.
--
-- Three controls, all evaluated at release time rather than enqueue time:
--
--   1. warming_min_gap_seconds — minimum spacing between two warming sends
--      from the same agent. Converts a burst into a drip.
--   2. warming_daily_cap — the real brake. Spacing alone still permits
--      hundreds a day; the cap is what allows a deliberate ramp-up.
--   3. crm_status_rules.release_priority — who goes first when the cap binds
--      and a queue forms. Without it release is purely time-ordered and a hot
--      lead (ghosted a Zoom yesterday) waits behind a cold one.
--
-- All three are per-agent / per-status config, editable from the dashboard —
-- no deploy needed to slow the system down or speed it up.
--
-- Additive and idempotent. Defaults are deliberately conservative: an agent
-- that is switched on starts at 50 warming messages a day, one every 90
-- seconds, which is a drip rather than a campaign.

ALTER TABLE public.agents
  -- Per agent because Meta scores quality per phone number, and each agent
  -- owns its own number.
  ADD COLUMN IF NOT EXISTS warming_min_gap_seconds int NOT NULL DEFAULT 90
    CHECK (warming_min_gap_seconds >= 0),
  ADD COLUMN IF NOT EXISTS warming_daily_cap int NOT NULL DEFAULT 50
    CHECK (warming_daily_cap >= 0);

ALTER TABLE public.crm_status_rules
  -- Higher goes first. 50 is the neutral middle so an unseeded or
  -- operator-added row sorts sensibly without anyone thinking about it.
  ADD COLUMN IF NOT EXISTS release_priority int NOT NULL DEFAULT 50
    CHECK (release_priority BETWEEN 0 AND 100);

-- Priority seed. Ordered by how much intent the lead has already shown —
-- someone who booked a Zoom and did not turn up is a far warmer prospect than
-- someone a rep wrote off as not serious.
--
-- Only touches rows still sitting at the 50 default, so an operator who has
-- already tuned a priority keeps their value on a re-run.

-- 100 — booked and ghosted. Highest intent in the entire list.
UPDATE public.crm_status_rules SET release_priority = 100
  WHERE status_sub = 91 AND release_priority = 50;

-- 75 — the lead engaged and named a concrete, answerable objection.
UPDATE public.crm_status_rules SET release_priority = 75
  WHERE status_sub IN (14, 15, 16, 18, 19, 26, 51, 54, 58, 59, 60, 72, 80)
    AND release_priority = 50;

-- Status 24 ("ל״מ אחר" — objection recorded but not categorised) is deliberately
-- left at the neutral 50. We do not know what the objection is, so it belongs
-- neither above the answerable ones nor down with the written-off ones.

-- 60 — engaged, but the objection is softer or more personal.
UPDATE public.crm_status_rules SET release_priority = 60
  WHERE status_sub IN (22, 55, 56, 76)
    AND release_priority = 50;

-- 40 — never actually reached. No objection, just absence.
UPDATE public.crm_status_rules SET release_priority = 40
  WHERE status_sub IN (2, 3, 4, 5, 6, 7, 47, 73)
    AND release_priority = 50;

-- 20 — the rep read the lead as uninterested or hostile to the process.
-- Still worth a touch, but last in line when the cap binds.
UPDATE public.crm_status_rules SET release_priority = 20
  WHERE status_sub IN (20, 21, 23, 50, 52, 77)
    AND release_priority = 50;
