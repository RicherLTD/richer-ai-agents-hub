# Supabase

Source of truth for the database schema, RLS policies, and edge functions.

## Project

- **Name**: `richer-whatsapp-ai`
- **Project ref**: `juoglkqtmjsziieqgmhf`
- **URL**: https://juoglkqtmjsziieqgmhf.supabase.co
- **Region**: Northeast Asia (Tokyo)

## Migrations

All schema changes go through migration files in `supabase/migrations/`.

Naming: `<NNNN>_<description>.sql` (4-digit sequence, snake_case).

```bash
# Create a new migration (creates timestamped file; rename to follow our convention)
bunx supabase migration new add_some_table

# Apply pending migrations to the linked remote project
bunx supabase db push

# Generate TS types from current remote schema
bunx supabase gen types typescript --linked > src/types/database.ts
```

### Legacy schema (pre-migration era)

The first 10 tables, ENUMs, and the initial seed agent (`affiliate_marketing`) were created
manually via Supabase Studio before migrations were adopted. They are **not** captured in a
migration file in this repo.

**Tables**: `agents`, `conversations`, `messages`, `lead_memory`, `advisors`, `agent_advisors`,
`prompts`, `experiments`, `opt_outs`, `ai_outages`.

**ENUMs**: `funnel_stage_enum`, `objection_enum`, `tag_enum`, `conversation_status_enum`,
`message_direction_enum`, `message_type_enum`, `ai_provider_enum`, `question_version_enum`,
`agent_status_enum`.

If we ever need to reproduce the project from scratch (disaster recovery, staging clone), we'll
need to either install Docker and run `bunx supabase db pull`, or manually re-create via Studio
following the handover spec.

From PR 5 onwards, every schema change is a migration file.

## Linking from a fresh clone

```bash
# 1. Login (one-time per machine; opens browser)
bunx supabase login

# 2. Link this clone to the remote project
bunx supabase link --project-ref juoglkqtmjsziieqgmhf
# (or: SUPABASE_ACCESS_TOKEN=... bunx supabase link --project-ref juoglkqtmjsziieqgmhf)
```

The link state lives in `supabase/.temp/` (gitignored).

## RLS

Every table that holds user/lead/conversation data MUST have RLS enabled and explicit policies.
See migration `0002_rls_policies.sql` (added in PR 5).

## DB password rotation

If the database password in any local `.env.local` becomes stale (after a rotation in Supabase
Studio), run `bunx supabase link` again to update the link credentials.
