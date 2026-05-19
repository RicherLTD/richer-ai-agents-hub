-- 0027_meeting_consent.sql
--
-- New column: lead_memory.meeting_consented_at
--
-- Why: the original `funnel_stage='done'` rule (5 of q1-q5 filled) treats
-- "we have enough info" as "lead is ready for a meeting". Those are not the
-- same thing. On 2026-05-19 we shipped a lead to Mooz who had answered q1-q5
-- but never agreed to a Zoom -- the bot was still gathering context. Mooz
-- rejected the booking (no email, no consent), the scenario auto-disabled
-- itself, and the lead was left in a "scheduled but not really" limbo.
--
-- This column makes consent an explicit, separately-tracked signal: the
-- memory extractor populates it only when the lead actually said yes to a
-- meeting (or accepted a proposed time). `shouldTriggerZoomHandoff` is
-- being tightened in the same PR to require this field to be non-null
-- alongside q7_email and an empty red_flags array.

ALTER TABLE public.lead_memory
  ADD COLUMN IF NOT EXISTS meeting_consented_at timestamptz;

COMMENT ON COLUMN public.lead_memory.meeting_consented_at IS
  'Set by the memory extractor when the lead explicitly accepted a meeting (e.g. "ken, bo nikba", "matai?", or accepted a proposed time). NULL means consent has not been observed yet -- handoff must not fire.';
