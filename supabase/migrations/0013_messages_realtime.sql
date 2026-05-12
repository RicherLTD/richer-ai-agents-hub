-- 0013_messages_realtime.sql
--
-- Enables Postgres logical replication on `public.messages` so the
-- dashboard can listen for INSERTs and refresh conversations live (Phase
-- B). Without adding the table to `supabase_realtime`, the Realtime
-- service has nothing to broadcast.
--
-- Why messages only (not conversations)? The dashboard already drives a
-- React Query refetch on every new message that lands — so the
-- conversation list + lead memory are invalidated as a side effect.
-- Subscribing to one table keeps the channel surface small.
--
-- Safe to re-run: `ALTER PUBLICATION ... ADD TABLE` errors if the table
-- is already a member, so we wrap it in a DO block that checks first.

DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_publication_tables
    WHERE pubname = 'supabase_realtime'
      AND schemaname = 'public'
      AND tablename = 'messages'
  ) THEN
    ALTER PUBLICATION supabase_realtime ADD TABLE public.messages;
  END IF;
END $$;
