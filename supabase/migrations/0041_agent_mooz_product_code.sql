-- 0041_agent_mooz_product_code.sql
--
-- Adds agents.mooz_product_code — the Fireberry product code for the agent's
-- track, emitted as Mooz `hidden_fields.product` on every bot-initiated
-- booking (see _shared/mooz.ts createBooking + moozTools.ts).
--
-- Why: Mooz's native Fireberry scenario (Make 4491366) routes a booking to a
-- product via `hidden_fields.product` — the hosted booking page injects it for
-- self-service bookings, but the bot's create_booking API call never sent it.
-- Result: bot bookings reached Mooz with no product tag, the product-scoped
-- lead lookup failed ("🚨 לא נמצא ליד ב-MOOZ"), and a second, product-blind
-- writer (Make 5709133) picked up the slack — attaching the zoom to the
-- most-recently-created lead across ALL products and producing duplicate
-- cross-product meetings once a phone became a lead in two tracks.
--
-- Codes match the switch in Make 4491366:
--   B -> affiliate_marketing (Fireberry product ba890f3e-…)
--   R -> digital_marketing   (Fireberry product 74f47470-…)
--
-- Nullable: agents without a code just book without a product tag (the prior
-- behaviour) — no regression for any not-yet-configured agent.
--
-- Idempotent: re-running is a no-op.

ALTER TABLE public.agents
  ADD COLUMN IF NOT EXISTS mooz_product_code text;

UPDATE public.agents
SET mooz_product_code = 'B'
WHERE name = 'affiliate_marketing' AND mooz_product_code IS DISTINCT FROM 'B';

UPDATE public.agents
SET mooz_product_code = 'R'
WHERE name = 'digital_marketing' AND mooz_product_code IS DISTINCT FROM 'R';
