-- 0016_coach_attachments.sql
--
-- Image attachments for the Prompt Coach. The operator can paste a
-- screenshot (e.g. of a problematic WhatsApp conversation, a lead
-- response, or a layout they want changed) and the Coach AI (Claude
-- Sonnet 4.6 vision-enabled) reasons about it directly.
--
-- Storage layout:
--   bucket `coach-uploads` (private; URL signing is short-lived)
--   path   `<agent_id>/<uuid>.<ext>`
--
-- The frontend uploads the file via the standard supabase-js storage
-- client (admin-only insert RLS), then includes both:
--   - the storage path  (saved on coach_messages.attachment_url)
--   - the file content as base64 in the edge-function request body, so
--     the Coach edge function doesn't have to round-trip to Storage to
--     reach Claude's vision API.

-- 1. coach_messages column to remember the attachment for display in
--    the chat history. Nullable — most messages are text-only.
alter table public.coach_messages
  add column if not exists attachment_url text null;

-- 2. private bucket for the screenshots.
insert into storage.buckets (id, name, public)
values ('coach-uploads', 'coach-uploads', false)
on conflict (id) do nothing;

-- 3. RLS on the storage objects so only admins can upload and view.
drop policy if exists "coach-uploads admin insert" on storage.objects;
create policy "coach-uploads admin insert"
  on storage.objects
  for insert
  to authenticated
  with check (bucket_id = 'coach-uploads' and public.is_admin());

drop policy if exists "coach-uploads admin select" on storage.objects;
create policy "coach-uploads admin select"
  on storage.objects
  for select
  to authenticated
  using (bucket_id = 'coach-uploads' and public.is_admin());

drop policy if exists "coach-uploads admin update" on storage.objects;
create policy "coach-uploads admin update"
  on storage.objects
  for update
  to authenticated
  using (bucket_id = 'coach-uploads' and public.is_admin())
  with check (bucket_id = 'coach-uploads' and public.is_admin());

drop policy if exists "coach-uploads admin delete" on storage.objects;
create policy "coach-uploads admin delete"
  on storage.objects
  for delete
  to authenticated
  using (bucket_id = 'coach-uploads' and public.is_admin());
