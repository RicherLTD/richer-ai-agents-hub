-- 0015_coach_messages.sql
--
-- "Prompt Coach" — admin-facing chat that helps refine the bot's main
-- prompt. Two operators (Kfir, Yitzhak) talk to an AI (Claude Sonnet 4.6)
-- in the dashboard; the AI reads the active prompt + recent lead
-- conversations and can propose a full replacement of the main prompt.
-- The proposed text is stored as a `proposed_prompt_content` column on
-- the assistant's message row; clicking "apply" in the UI flips a new
-- row into `prompts` with the proposed text and deactivates the old
-- one (admin-only INSERT policy is added below).
--
-- This is a coach for HUMANS, not the bot itself — the bot's behaviour
-- changes only when an admin explicitly approves a proposed edit.

create table if not exists public.coach_messages (
  id uuid primary key default gen_random_uuid(),
  agent_id uuid not null references public.agents(id) on delete cascade,
  -- "user" = the admin wrote it; "assistant" = the Coach AI replied.
  role text not null check (role in ('user', 'assistant')),
  -- For user rows: the admin who wrote it. For assistant rows: the admin
  -- whose call triggered the response. Always points to a real user so
  -- we can audit "who taught the coach what" later.
  user_id uuid not null references auth.users(id) on delete cascade,
  content text not null check (length(content) <= 50000),
  -- When the Coach proposes a prompt change, the FULL new prompt body
  -- goes here. NULL on regular conversational messages.
  proposed_prompt_content text null,
  -- Set when an admin clicks "apply": the prompts row that was created.
  applied_prompt_id uuid null references public.prompts(id) on delete set null,
  applied_at timestamptz null,
  applied_by uuid null references auth.users(id) on delete set null,
  -- Optional: an admin can reference a specific lead conversation while
  -- coaching, so the Coach can pull that conversation's history into
  -- context. NULL when not relevant.
  referenced_conversation_id uuid null references public.conversations(id) on delete set null,
  created_at timestamptz not null default now()
);

create index if not exists coach_messages_agent_created_idx
  on public.coach_messages (agent_id, created_at desc);

create index if not exists coach_messages_applied_prompt_idx
  on public.coach_messages (applied_prompt_id)
  where applied_prompt_id is not null;

alter table public.coach_messages enable row level security;

-- Only admins can see coaching history (it can quote prompt internals).
create policy "coach_messages_select_admin"
  on public.coach_messages
  for select
  to authenticated
  using (public.is_admin());

-- Admins can write their own user messages. The edge function inserts
-- assistant messages using service_role and bypasses this check.
create policy "coach_messages_insert_admin"
  on public.coach_messages
  for insert
  to authenticated
  with check (public.is_admin() and role = 'user' and user_id = auth.uid());

-- Admins can mark a proposed edit as applied (sets applied_prompt_id,
-- applied_at, applied_by). Other columns stay immutable for audit.
create policy "coach_messages_update_admin"
  on public.coach_messages
  for update
  to authenticated
  using (public.is_admin())
  with check (public.is_admin());

-- Allow admins to INSERT new prompt versions (needed when applying a
-- coach-proposed edit from the dashboard). Migration 0014 already gave
-- admins UPDATE on prompts for the Rollback button.
drop policy if exists "prompts_insert_admin" on public.prompts;
create policy "prompts_insert_admin"
  on public.prompts
  for insert
  to authenticated
  with check (public.is_admin());
