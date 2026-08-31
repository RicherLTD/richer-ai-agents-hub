-- 0046_conversation_needs_attention.sql
--
-- Separates "a human must act on this lead" from "the bot must stop talking".
--
-- Until now both lived in conversations.current_tag. Because 'requires_human'
-- is in the agent loop's BLOCKING_TAGS, the only way to flag a lead for an
-- operator was to mute the bot for good. That made the flag unusable for the
-- two cases that matter most, where the lead is warm and still talking:
--
--   * the bot failed to produce a reply (guard rejection / model outage) and
--     the lead is sitting in silence — 64 leads in 14 days, all invisible;
--   * the lead wants to book but Mooz has no open slot anywhere, so an
--     advisor has to schedule manually.
--
-- needs_attention is orthogonal to current_tag: it drives the operator queue
-- and the WhatsApp alert, and never affects whether the bot replies.
--
-- Additive and nullable — existing rows and the whole current flow are
-- untouched (NULL = nothing to do).

alter table public.conversations
  add column if not exists needs_attention text,
  add column if not exists needs_attention_at timestamptz,
  -- Set every time an alert is actually dispatched for this conversation.
  -- The dedup window is measured from here, NOT from needs_attention_at, so
  -- re-flagging a still-open item cannot re-alert.
  add column if not exists needs_attention_alerted_at timestamptz;

-- Keep the vocabulary closed so a typo can't create a category nobody reads.
-- Text + CHECK rather than an enum: adding a category later is a one-line
-- constraint swap instead of an enum migration that locks the table.
alter table public.conversations
  drop constraint if exists conversations_needs_attention_check;

alter table public.conversations
  add constraint conversations_needs_attention_check
  check (
    needs_attention is null
    or needs_attention in (
      'bot_failed',        -- no reply reached the lead; they are waiting
      'calendar_closed',   -- wants to book, Mooz has nothing open at all
      'existing_student',  -- Fireberry: already enrolled / blacklisted
      'red_flag'           -- memory extractor raised a red flag
    )
  );

-- The operator queue: open items, newest first.
create index if not exists conversations_needs_attention_idx
  on public.conversations (needs_attention, needs_attention_at desc)
  where needs_attention is not null;

comment on column public.conversations.needs_attention is
  'Why a human must act on this lead. NULL = nothing pending. Independent of current_tag: does NOT stop the agent loop.';
comment on column public.conversations.needs_attention_at is
  'When the current needs_attention was raised. Cleared with the flag.';
comment on column public.conversations.needs_attention_alerted_at is
  'When an operator alert was last dispatched for this conversation. Drives the alert dedup window.';
