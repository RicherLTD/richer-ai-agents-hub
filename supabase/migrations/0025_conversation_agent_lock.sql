-- 0025_conversation_agent_lock.sql
--
-- Per-conversation atomic lock for the agent reply loop.
--
-- Why: Meta delivers each user message as a separate webhook POST. When a
-- lead sends two messages within a few seconds we get two webhook
-- deliveries and two parallel agent loops, both calling Claude with
-- slightly different history. Result: two replies to the user (Orel case
-- at 16:30:53 + 16:30:54 IL on 2026-05-18).
--
-- The lock is taken via atomic UPDATE-WHERE at the top of the agent loop:
--   UPDATE conversations SET agent_lock_taken_at = now()
--   WHERE id = $1 AND (agent_lock_taken_at IS NULL OR agent_lock_taken_at < now() - interval '60 seconds')
--   RETURNING id;
-- If the UPDATE returns 0 rows, another instance has the lock — skip.
-- Released by UPDATE ... SET agent_lock_taken_at = NULL after send (in
-- finally{} so a crash mid-flight doesn't leave the lock held).
--
-- The 60-second fallback expiry is a safety net for the case where a
-- worker actually crashes between claim and release. Normal agent turns
-- complete in 5-12 seconds.

ALTER TABLE public.conversations
  ADD COLUMN IF NOT EXISTS agent_lock_taken_at timestamptz;

CREATE INDEX IF NOT EXISTS conversations_agent_lock_idx
  ON public.conversations (agent_lock_taken_at)
  WHERE agent_lock_taken_at IS NOT NULL;
