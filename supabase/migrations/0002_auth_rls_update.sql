-- 0002_auth_rls_update.sql
--
-- Tighten RLS policies from `anon, authenticated` to `authenticated` only.
-- After PR 8 (login + ProtectedRoute), every dashboard page requires an
-- authenticated session, so the `anon` role no longer needs read access to
-- agent/lead/conversation data.
--
-- Per-agent scoping (filtering rows by the user's agent membership) is
-- intentionally NOT in scope here — that depends on a user↔agent mapping
-- that doesn't exist yet. It will be addressed in a later PR alongside
-- user management.
--
-- `opt_outs` continues to have NO read policy (server-side / service_role
-- only). RLS stays enabled from migration 0001.
--
-- Idempotent: DROP IF EXISTS + CREATE so the migration can be re-run.

-- ─────────────────────────────────────────────────────────────────────────
-- Drop the legacy anon-readable policies from migration 0001
-- ─────────────────────────────────────────────────────────────────────────
DROP POLICY IF EXISTS "anon_read_active_agents"          ON public.agents;
DROP POLICY IF EXISTS "anon_read_conversations"          ON public.conversations;
DROP POLICY IF EXISTS "anon_read_messages"               ON public.messages;
DROP POLICY IF EXISTS "anon_read_lead_memory"            ON public.lead_memory;
DROP POLICY IF EXISTS "anon_read_prompts"                ON public.prompts;
DROP POLICY IF EXISTS "anon_read_experiments"            ON public.experiments;
DROP POLICY IF EXISTS "anon_read_active_advisors"        ON public.advisors;
DROP POLICY IF EXISTS "anon_read_active_agent_advisors"  ON public.agent_advisors;
DROP POLICY IF EXISTS "anon_read_ai_outages"             ON public.ai_outages;

-- ─────────────────────────────────────────────────────────────────────────
-- agents — only active agents are visible to authenticated users
-- ─────────────────────────────────────────────────────────────────────────
DROP POLICY IF EXISTS "authenticated_read_active_agents" ON public.agents;
CREATE POLICY "authenticated_read_active_agents"
  ON public.agents
  FOR SELECT
  TO authenticated
  USING (status = 'active');

-- ─────────────────────────────────────────────────────────────────────────
-- conversations — all rows visible to authenticated users
-- (per-agent scoping deferred to a later PR)
-- ─────────────────────────────────────────────────────────────────────────
DROP POLICY IF EXISTS "authenticated_read_conversations" ON public.conversations;
CREATE POLICY "authenticated_read_conversations"
  ON public.conversations
  FOR SELECT
  TO authenticated
  USING (true);

-- ─────────────────────────────────────────────────────────────────────────
-- messages — all rows visible to authenticated users
-- (per-agent scoping deferred to a later PR)
-- ─────────────────────────────────────────────────────────────────────────
DROP POLICY IF EXISTS "authenticated_read_messages" ON public.messages;
CREATE POLICY "authenticated_read_messages"
  ON public.messages
  FOR SELECT
  TO authenticated
  USING (true);

-- ─────────────────────────────────────────────────────────────────────────
-- lead_memory — all rows visible to authenticated users
-- (per-agent scoping deferred to a later PR)
-- ─────────────────────────────────────────────────────────────────────────
DROP POLICY IF EXISTS "authenticated_read_lead_memory" ON public.lead_memory;
CREATE POLICY "authenticated_read_lead_memory"
  ON public.lead_memory
  FOR SELECT
  TO authenticated
  USING (true);

-- ─────────────────────────────────────────────────────────────────────────
-- prompts — all versions visible to authenticated users
-- ─────────────────────────────────────────────────────────────────────────
DROP POLICY IF EXISTS "authenticated_read_prompts" ON public.prompts;
CREATE POLICY "authenticated_read_prompts"
  ON public.prompts
  FOR SELECT
  TO authenticated
  USING (true);

-- ─────────────────────────────────────────────────────────────────────────
-- experiments — A/B test definitions visible to authenticated users
-- ─────────────────────────────────────────────────────────────────────────
DROP POLICY IF EXISTS "authenticated_read_experiments" ON public.experiments;
CREATE POLICY "authenticated_read_experiments"
  ON public.experiments
  FOR SELECT
  TO authenticated
  USING (true);

-- ─────────────────────────────────────────────────────────────────────────
-- advisors — only active advisors are visible to authenticated users
-- ─────────────────────────────────────────────────────────────────────────
DROP POLICY IF EXISTS "authenticated_read_active_advisors" ON public.advisors;
CREATE POLICY "authenticated_read_active_advisors"
  ON public.advisors
  FOR SELECT
  TO authenticated
  USING (is_active = true);

-- ─────────────────────────────────────────────────────────────────────────
-- agent_advisors — only active mappings visible to authenticated users
-- ─────────────────────────────────────────────────────────────────────────
DROP POLICY IF EXISTS "authenticated_read_active_agent_advisors" ON public.agent_advisors;
CREATE POLICY "authenticated_read_active_agent_advisors"
  ON public.agent_advisors
  FOR SELECT
  TO authenticated
  USING (is_active = true);

-- ─────────────────────────────────────────────────────────────────────────
-- ai_outages — operational telemetry, visible to authenticated users
-- ─────────────────────────────────────────────────────────────────────────
DROP POLICY IF EXISTS "authenticated_read_ai_outages" ON public.ai_outages;
CREATE POLICY "authenticated_read_ai_outages"
  ON public.ai_outages
  FOR SELECT
  TO authenticated
  USING (true);

-- ─────────────────────────────────────────────────────────────────────────
-- opt_outs — still no public read policy. Server-side only (service_role).
-- ─────────────────────────────────────────────────────────────────────────
