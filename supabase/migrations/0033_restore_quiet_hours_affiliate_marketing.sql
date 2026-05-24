-- 0033_restore_quiet_hours_affiliate_marketing.sql
--
-- Restores the original 20:00 -> 08:00 IL quiet-hours window for the
-- affiliate_marketing agent (cleared at some point between migration
-- 0027 and 2026-05-24 — both columns observed NULL in prod).
--
-- The bot already honors agents.quiet_hours_start_il / _end_il via
-- isQuietHourNow() in supabase/functions/_shared/quietHours.ts — this
-- migration just turns the policy back on for the affiliate agent.

UPDATE agents
SET quiet_hours_start_il = 20,
    quiet_hours_end_il = 8
WHERE name = 'affiliate_marketing';
