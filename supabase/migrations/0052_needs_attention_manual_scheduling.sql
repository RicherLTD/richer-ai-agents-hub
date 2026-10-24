-- 0052_needs_attention_manual_scheduling.sql
--
-- New operator-queue reason: manual_scheduling.
--
-- The lead is setting a Zoom time the bot could not confirm from the Mooz
-- calendar (asked for 21:00, or "Monday after 17:00"). Until now the
-- meeting-time guard blocked the reply and the lead got the generic "I hit a
-- glitch" fallback — 30 operator alerts in Sep–Oct 2026 read "the bot could
-- not answer" when the real situation was "a warm lead wants to book". Now
-- the bot tells the lead an advisor will coordinate, and the queue says so.
--
-- Idempotent: drop + re-add the CHECK (see 0046 for why it is not an enum).

alter table public.conversations
  drop constraint if exists conversations_needs_attention_check;

alter table public.conversations
  add constraint conversations_needs_attention_check
  check (
    needs_attention is null
    or needs_attention in (
      'bot_failed',         -- no reply reached the lead; they are waiting
      'calendar_closed',    -- wants to book, Mooz has nothing open at all
      'manual_scheduling',  -- wants a time the bot could not confirm; advisor coordinates
      'existing_student',   -- Fireberry: already enrolled / blacklisted
      'red_flag'            -- memory extractor raised a red flag
    )
  );
