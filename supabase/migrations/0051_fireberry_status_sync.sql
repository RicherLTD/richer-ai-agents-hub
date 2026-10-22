-- 0051_fireberry_status_sync.sql
--
-- Fireberry lead statuses mirrored onto conversations, so the broadcast page
-- can target leads by primary / secondary status. Filled by the
-- fireberry-status-sync edge function (incremental by modifiedon).
--
-- Deliberately SEPARATE from crm_status_main / crm_status_sub: those are
-- written by crm-status-webhook only for statuses that have a warming rule and
-- drive CRM warming. These columns are a plain mirror for targeting and are
-- read by nothing in the agent loop.
--
-- Additive and idempotent.

-- Which Fireberry product (pcfsystemfield122) each agent's leads belong to.
alter table public.agents
  add column if not exists fireberry_product_id text;

update public.agents set fireberry_product_id = 'BA890F3E-20C2-40E4-80E5-169EAD34E32E'
where name = 'affiliate_marketing' and fireberry_product_id is null;
update public.agents set fireberry_product_id = '74F47470-2097-4635-B523-0DEA877E3BD1'
where name = 'digital_marketing' and fireberry_product_id is null;

alter table public.conversations
  add column if not exists fb_account_id text,
  add column if not exists fb_status_main integer,
  add column if not exists fb_status_main_name text,
  add column if not exists fb_status_sub integer,
  add column if not exists fb_status_sub_name text,
  -- pcfvetekop ("תאריך הזדמנות אחרונה"): picks the current record when a
  -- phone has several Fireberry leads under the same product.
  add column if not exists fb_last_opportunity_at timestamptz,
  add column if not exists fb_status_synced_at timestamptz;

create index if not exists conversations_agent_fb_status_sub_idx
  on public.conversations (agent_id, fb_status_sub);

-- Resumable cursor per product: the last modifiedon applied, plus the ids
-- already applied AT that instant (Fireberry has no tie-breaker sort, so the
-- next run re-reads that second and skips them).
create table if not exists public.fireberry_sync_state (
  product_id text primary key,
  cursor_modified_on timestamptz,
  cursor_ids text[] not null default '{}',
  full_sync_done_at timestamptz,
  last_run_at timestamptz,
  last_error text,
  updated_at timestamptz not null default now()
);

alter table public.fireberry_sync_state enable row level security;

drop policy if exists fireberry_sync_state_admin_read on public.fireberry_sync_state;
create policy fireberry_sync_state_admin_read on public.fireberry_sync_state
  for select to authenticated
  using (public.is_admin());

-- Apply one batch of statuses for one agent. Rows are pre-deduplicated per
-- phone by the caller. A row only overwrites when it is the same Fireberry
-- record, or a record at least as recent by last-opportunity date — so an
-- old duplicate being edited cannot clobber the current one.
create or replace function public.apply_fireberry_statuses(p_agent_id uuid, p_rows jsonb)
returns integer
language sql
security invoker
set search_path = public
as $$
  with r as (
    select *
    from jsonb_to_recordset(p_rows) as x(
      phone text,
      account_id text,
      status_main integer,
      status_main_name text,
      status_sub integer,
      status_sub_name text,
      last_opportunity_at timestamptz
    )
  ), upd as (
    update public.conversations c
    set fb_account_id = r.account_id,
        fb_status_main = r.status_main,
        fb_status_main_name = r.status_main_name,
        fb_status_sub = r.status_sub,
        fb_status_sub_name = r.status_sub_name,
        fb_last_opportunity_at = r.last_opportunity_at,
        fb_status_synced_at = now()
    from r
    where c.agent_id = p_agent_id
      and c.lead_phone = r.phone
      and (
        c.fb_account_id is null
        or c.fb_account_id = r.account_id
        or r.last_opportunity_at >= coalesce(c.fb_last_opportunity_at, '-infinity'::timestamptz)
      )
    returning 1
  )
  select count(*)::integer from upd;
$$;

revoke all on function public.apply_fireberry_statuses(uuid, jsonb) from public, anon, authenticated;
grant execute on function public.apply_fireberry_statuses(uuid, jsonb) to service_role;

-- Status counts for the broadcast picker: active leads of one agent, inside an
-- optional registration window, grouped by primary and by secondary status.
-- code NULL = no Fireberry status. Runs as the caller, so the admin-only RLS
-- on conversations still applies.
create or replace function public.broadcast_status_counts(
  p_agent_id uuid,
  p_registered_from timestamptz default null,
  p_registered_before timestamptz default null
)
returns table (kind text, code integer, name text, leads bigint)
language sql
stable
security invoker
set search_path = public
as $$
  with base as (
    select fb_status_main, fb_status_main_name, fb_status_sub, fb_status_sub_name
    from public.conversations
    where agent_id = p_agent_id
      and status = 'active'
      and (p_registered_from is null or created_at >= p_registered_from)
      and (p_registered_before is null or created_at < p_registered_before)
  )
  select 'main'::text, fb_status_main, max(fb_status_main_name), count(*)
  from base group by fb_status_main
  union all
  select 'sub'::text, fb_status_sub, max(fb_status_sub_name), count(*)
  from base group by fb_status_sub;
$$;

revoke all on function public.broadcast_status_counts(uuid, timestamptz, timestamptz) from public, anon;
grant execute on function public.broadcast_status_counts(uuid, timestamptz, timestamptz) to authenticated, service_role;
