-- 0033_conversation_manual_mode.sql
--
-- Per-conversation manual mode. When an operator takes over a conversation
-- (manual send, or explicit "take over" button), the AI agent loop must
-- stop replying until an operator hands it back.
--
-- Why a dedicated column and NOT a new conversation_status_enum value:
-- migration 0025 documents that `ALTER TYPE ... ADD VALUE` has historical
-- transaction restrictions that make our migration tooling unreliable. A
-- nullable timestamp column is orthogonal to `status`/`current_tag`, sticks
-- across inbound messages (the inbound upsert never writes it), and gives a
-- free audit of WHEN the takeover happened.

ALTER TABLE public.conversations
  ADD COLUMN IF NOT EXISTS manual_mode_since timestamptz,
  ADD COLUMN IF NOT EXISTS manual_mode_by uuid REFERENCES auth.users(id) ON DELETE SET NULL;

COMMENT ON COLUMN public.conversations.manual_mode_since IS
  'When an operator took manual control. NULL = AI mode (agent loop replies). Non-null = manual mode (agent loop skips). Set by whatsapp-send (auto) or conversation-set-mode (explicit). Never written by the inbound upsert, so it sticks across lead replies.';
COMMENT ON COLUMN public.conversations.manual_mode_by IS
  'auth.users.id of the operator who last took manual control. NULL in AI mode.';
