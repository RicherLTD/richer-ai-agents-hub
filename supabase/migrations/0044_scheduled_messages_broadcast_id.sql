-- 0044_scheduled_messages_broadcast_id.sql
-- Additive: link scheduled_messages rows to their broadcast (nullable).
-- Existing inserts (lead-register, re-engage) leave it NULL => no behavior
-- change. The claim RPC and dispatcher do not read this column.

ALTER TABLE public.scheduled_messages
  ADD COLUMN broadcast_id uuid REFERENCES public.broadcasts(id) ON DELETE SET NULL;

CREATE INDEX scheduled_messages_broadcast_idx
  ON public.scheduled_messages (broadcast_id)
  WHERE broadcast_id IS NOT NULL;
