-- 0028_coach_messages_realtime.sql
--
-- Adds `public.coach_messages` to the `supabase_realtime` publication so
-- the Coach page can listen for INSERTs and refresh history live.
--
-- Why: prompt-coach now runs Claude in a background task (EdgeRuntime.waitUntil)
-- and returns 202 immediately. The client no longer receives the assistant
-- reply in the HTTP response — it arrives via Realtime when the background
-- task inserts the assistant row. Without this publication, the Coach UI
-- would never see the reply land.
--
-- Mirrors 0013_messages_realtime.sql; safe to re-run.

DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_publication_tables
    WHERE pubname = 'supabase_realtime'
      AND schemaname = 'public'
      AND tablename = 'coach_messages'
  ) THEN
    ALTER PUBLICATION supabase_realtime ADD TABLE public.coach_messages;
  END IF;
END $$;
