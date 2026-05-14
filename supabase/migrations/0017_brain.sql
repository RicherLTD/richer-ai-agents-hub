-- 0017_brain.sql
--
-- "Brain" = persistent knowledge layer feeding the Prompt Coach.
-- Operators upload PDFs, paste images, or write short notes. Everything
-- that's `is_active=true` is injected into the Coach's system prompt on
-- every turn (Approach A: full inline, with Anthropic prompt caching so
-- the cost is amortised across the 5-minute cache TTL).
--
-- Cross-agent sharing: when `shared_across_agents=true`, the row is
-- visible to every Coach session regardless of which agent is active.
-- Use case: a brand brochure, an objection-handling cheatsheet, a
-- founder bio -- content that's true everywhere.
--
-- Bilingual fields: `title` / `description` are Hebrew for the operator
-- UI. `ai_title` / `ai_description` are optional English summaries that
-- Claude sees instead of the Hebrew when present. Most rows leave the
-- AI versions null and Claude reads the Hebrew directly -- Sonnet 4.6
-- handles Hebrew fine; the bilingual override exists for cases where
-- the operator wants tighter or cleaner phrasing for the model.
--
-- Storage layout (private bucket):
--   bucket `brain-uploads`
--   path   `<agent_id>/<uuid>.<ext>`      (per-agent)
--   path   `_shared/<uuid>.<ext>`         (shared rows)

create table if not exists public.brain_documents (
  id uuid primary key default gen_random_uuid(),

  -- Owning agent. Always set (even shared rows have an "uploader agent")
  -- so we can audit who introduced the content. Visibility is controlled
  -- by `shared_across_agents`, NOT by this column.
  agent_id uuid not null references public.agents(id) on delete cascade,

  -- 'pdf' / 'image' / 'note'. Note rows have no storage_path; the body
  -- lives in extracted_text directly.
  source_kind text not null check (source_kind in ('pdf', 'image', 'note')),

  -- Hebrew (operator-facing).
  title text not null check (length(title) between 1 and 200),
  description text check (length(coalesce(description, '')) <= 2000),

  -- English (Claude-facing). When null, Claude sees the Hebrew.
  ai_title text check (length(coalesce(ai_title, '')) <= 200),
  ai_description text check (length(coalesce(ai_description, '')) <= 2000),

  -- Storage pointer. Null for notes.
  storage_path text,

  -- Plain-text extraction. For notes this IS the body. For PDFs/images
  -- this is the OCR/extraction result. Capped to ~200K chars (~50K
  -- tokens) so a single rogue document can't blow the context window.
  extracted_text text check (length(coalesce(extracted_text, '')) <= 200000),

  -- Operator-set tags (e.g. {'pricing','objections'}). Used for the
  -- filter dropdown in the brain page.
  tags text[] not null default '{}',

  -- Metadata for the operator's "how big is my brain" indicator.
  page_count int,
  file_size_bytes bigint check (file_size_bytes >= 0),
  token_count int check (token_count >= 0),

  -- Visibility toggle. Inactive rows stay in the table for audit/restore
  -- but don't enter the Coach's context.
  is_active boolean not null default true,

  -- When true, every agent's Coach sees this row.
  shared_across_agents boolean not null default false,

  uploaded_by uuid not null references auth.users(id) on delete set null,
  uploaded_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

-- Hot path: "load the brain for agent X" = own active rows + shared active rows.
create index if not exists brain_documents_agent_active_idx
  on public.brain_documents (agent_id, is_active)
  where is_active = true;

create index if not exists brain_documents_shared_active_idx
  on public.brain_documents (shared_across_agents, is_active)
  where shared_across_agents = true and is_active = true;

-- updated_at auto-touch.
create or replace function public.brain_documents_touch_updated_at()
returns trigger
language plpgsql
as $$
begin
  new.updated_at := now();
  return new;
end;
$$;

drop trigger if exists brain_documents_touch_updated_at on public.brain_documents;
create trigger brain_documents_touch_updated_at
  before update on public.brain_documents
  for each row
  execute function public.brain_documents_touch_updated_at();

-- Audit: which brain rows were used in each Coach turn. Lets the UI
-- show "I saw: brochure_2025.pdf, objections.pdf" beneath each reply.
create table if not exists public.brain_usage_log (
  id uuid primary key default gen_random_uuid(),
  coach_message_id uuid not null references public.coach_messages(id) on delete cascade,
  brain_document_ids uuid[] not null default '{}',
  created_at timestamptz not null default now()
);

create index if not exists brain_usage_log_coach_message_idx
  on public.brain_usage_log (coach_message_id);

-- RLS -- admin-only (same pattern as coach_messages).
alter table public.brain_documents enable row level security;
alter table public.brain_usage_log enable row level security;

drop policy if exists "brain_documents_select_admin" on public.brain_documents;
create policy "brain_documents_select_admin"
  on public.brain_documents
  for select
  to authenticated
  using (public.is_admin());

drop policy if exists "brain_documents_insert_admin" on public.brain_documents;
create policy "brain_documents_insert_admin"
  on public.brain_documents
  for insert
  to authenticated
  with check (public.is_admin() and uploaded_by = auth.uid());

drop policy if exists "brain_documents_update_admin" on public.brain_documents;
create policy "brain_documents_update_admin"
  on public.brain_documents
  for update
  to authenticated
  using (public.is_admin())
  with check (public.is_admin());

drop policy if exists "brain_documents_delete_admin" on public.brain_documents;
create policy "brain_documents_delete_admin"
  on public.brain_documents
  for delete
  to authenticated
  using (public.is_admin());

drop policy if exists "brain_usage_log_select_admin" on public.brain_usage_log;
create policy "brain_usage_log_select_admin"
  on public.brain_usage_log
  for select
  to authenticated
  using (public.is_admin());

-- The Coach edge function (service_role) writes usage rows. Admin clients
-- never insert here directly, so we don't need a permissive insert policy.

-- Private storage bucket for brain uploads.
insert into storage.buckets (id, name, public)
values ('brain-uploads', 'brain-uploads', false)
on conflict (id) do nothing;

-- Admin-only access to the bucket objects.
drop policy if exists "brain-uploads admin insert" on storage.objects;
create policy "brain-uploads admin insert"
  on storage.objects
  for insert
  to authenticated
  with check (bucket_id = 'brain-uploads' and public.is_admin());

drop policy if exists "brain-uploads admin select" on storage.objects;
create policy "brain-uploads admin select"
  on storage.objects
  for select
  to authenticated
  using (bucket_id = 'brain-uploads' and public.is_admin());

drop policy if exists "brain-uploads admin update" on storage.objects;
create policy "brain-uploads admin update"
  on storage.objects
  for update
  to authenticated
  using (bucket_id = 'brain-uploads' and public.is_admin())
  with check (bucket_id = 'brain-uploads' and public.is_admin());

drop policy if exists "brain-uploads admin delete" on storage.objects;
create policy "brain-uploads admin delete"
  on storage.objects
  for delete
  to authenticated
  using (bucket_id = 'brain-uploads' and public.is_admin());
