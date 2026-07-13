-- 0033_conversation_zoom_booked_by.sql
--
-- New column: conversations.zoom_booked_by
--
-- Why: a Zoom can reach `current_tag='zoom_scheduled'` via three distinct
-- routes, and today nothing distinguishes them — which makes the
-- "conversation → zoom" conversion rate meaningless:
--
--   1. 'agent'           — the bot itself booked the meeting in-chat via the
--                          Mooz `book_meeting` tool (moozTools.handleBookMeeting).
--                          The ONLY route that is a true agent conversion and
--                          the only value counted in the conversion %.
--   2. 'self'            — the lead booked themselves via the Mooz hosted page;
--                          the booking.created webhook carries no agent marker.
--   3. 'consent_handoff' — the memory extractor saw explicit consent + email +
--                          all 5 questions and handed off, WITHOUT an actual
--                          Mooz booking (extractMemory.shouldTriggerZoomHandoff).
--
-- The bot stamps every booking it makes with the Mooz notes
-- "WhatsApp lead — conversation {id}"; the mooz-webhook uses that marker to
-- tell 'agent' from 'self'. Attribution follows a never-downgrade precedence
-- agent > consent_handoff > self (enforced by the three edge writers).
--
-- NULL = legacy/unknown (zoom predates this column). We cannot backfill it —
-- Mooz notes were never persisted — so historical zooms stay unclassified.

ALTER TABLE public.conversations
  ADD COLUMN IF NOT EXISTS zoom_booked_by text;

DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint WHERE conname = 'conversations_zoom_booked_by_check'
  ) THEN
    ALTER TABLE public.conversations
      ADD CONSTRAINT conversations_zoom_booked_by_check
      CHECK (zoom_booked_by IS NULL OR zoom_booked_by IN ('agent', 'self', 'consent_handoff'));
  END IF;
END $$;

COMMENT ON COLUMN public.conversations.zoom_booked_by IS
  'How the zoom was booked: agent (bot booked in-chat via Mooz book_meeting — the only value counted in conversion %), self (lead booked via the Mooz hosted page), consent_handoff (consent observed + handed off, no actual Mooz booking). NULL = legacy/unclassified. Never downgraded: agent > consent_handoff > self.';
