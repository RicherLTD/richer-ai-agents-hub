-- 0054_broadcast_template_button_actions.sql
--
-- Per-template quick-reply button actions for the "pre-message" broadcast
-- flow: the template asks "לשלוח לכם את הלינק?" with two Quick reply buttons,
-- and the webhook answers the tap deterministically (no AI) —
-- whatsappWebhookHandler.ts → broadcastButtonAction.ts.
--
-- Shape (validated in _shared/quickReply.ts parseButtonActions):
--   {
--     "yes":  { "match": ["כן, שלחו לי"],    "reply": "...link..." },
--     "stop": { "match": ["לא, הסירו אותי"], "reply": "...",  "optout": true }
--   }
-- `match` = button labels and/or payloads (compared normalised). Keys are
-- free labels for logs. NULL = no button actions: taps go to the agent as text.
--
-- Additive, nullable, idempotent. Rollback: ALTER TABLE ... DROP COLUMN for
-- the three columns below, only after the code that reads them is rolled back.

alter table public.broadcast_templates
  add column if not exists button_actions jsonb;

do $$
begin
  if not exists (
    select 1 from pg_constraint
    where conname = 'broadcast_templates_button_actions_is_object'
  ) then
    alter table public.broadcast_templates
      add constraint broadcast_templates_button_actions_is_object
      check (button_actions is null or jsonb_typeof(button_actions) = 'object');
  end if;
end $$;

-- Double-tap guard for the deterministic reply (broadcastButtonAction.ts):
-- before sending, a tap claims (broadcast, button) on the conversation row with
-- a conditional UPDATE, so two concurrent deliveries of the same tap send one
-- reply. Nullable and additive; nothing else reads these columns.
alter table public.conversations
  add column if not exists button_reply_claimed_at timestamptz,
  add column if not exists button_reply_claimed_key text;

comment on column public.broadcast_templates.button_actions is
  'Quick-reply button actions: {"<name>": {"match": [label|payload...], "reply": text, "optout": bool}}. NULL = taps go to the agent as text.';
