-- 0001_rls_policies.sql
--
-- Initial RLS policies. At this stage the dashboard has no auth yet, so the
-- policies allow `anon` reads. PR 9 (`feat/auth-rls-update`) will tighten
-- these to `authenticated` only once login is wired up.
--
-- `opt_outs` intentionally has NO read policy — it contains sensitive PII
-- (phone numbers of leads who asked to be removed) and must never be
-- queryable from the client. n8n / server-side code uses the service_role
-- key which bypasses RLS.
--
-- All statements are idempotent (DROP IF EXISTS + CREATE) so the migration
-- can be re-run safely.

-- ─────────────────────────────────────────────────────────────────────────
-- Ensure RLS is enabled on every table we expose
-- ─────────────────────────────────────────────────────────────────────────
ALTER TABLE public.agents          ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.conversations   ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.messages        ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.lead_memory     ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.advisors        ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.agent_advisors  ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.prompts         ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.experiments     ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.ai_outages      ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.opt_outs        ENABLE ROW LEVEL SECURITY;

-- ─────────────────────────────────────────────────────────────────────────
-- agents — only active agents are visible
-- ─────────────────────────────────────────────────────────────────────────
DROP POLICY IF EXISTS "anon_read_active_agents" ON public.agents;
CREATE POLICY "anon_read_active_agents"
  ON public.agents
  FOR SELECT
  TO anon, authenticated
  USING (status = 'active');

-- ─────────────────────────────────────────────────────────────────────────
-- conversations — all rows visible (will be tightened to per-agent in PR 9)
-- ─────────────────────────────────────────────────────────────────────────
DROP POLICY IF EXISTS "anon_read_conversations" ON public.conversations;
CREATE POLICY "anon_read_conversations"
  ON public.conversations
  FOR SELECT
  TO anon, authenticated
  USING (true);

-- ─────────────────────────────────────────────────────────────────────────
-- messages — all rows visible (will be tightened to per-agent in PR 9)
-- ─────────────────────────────────────────────────────────────────────────
DROP POLICY IF EXISTS "anon_read_messages" ON public.messages;
CREATE POLICY "anon_read_messages"
  ON public.messages
  FOR SELECT
  TO anon, authenticated
  USING (true);

-- ─────────────────────────────────────────────────────────────────────────
-- lead_memory — all rows visible (will be tightened to per-agent in PR 9)
-- ─────────────────────────────────────────────────────────────────────────
DROP POLICY IF EXISTS "anon_read_lead_memory" ON public.lead_memory;
CREATE POLICY "anon_read_lead_memory"
  ON public.lead_memory
  FOR SELECT
  TO anon, authenticated
  USING (true);

-- ─────────────────────────────────────────────────────────────────────────
-- prompts — all versions visible (admin UI shows version history)
-- ─────────────────────────────────────────────────────────────────────────
DROP POLICY IF EXISTS "anon_read_prompts" ON public.prompts;
CREATE POLICY "anon_read_prompts"
  ON public.prompts
  FOR SELECT
  TO anon, authenticated
  USING (true);

-- ─────────────────────────────────────────────────────────────────────────
-- experiments — A/B test definitions are visible
-- ─────────────────────────────────────────────────────────────────────────
DROP POLICY IF EXISTS "anon_read_experiments" ON public.experiments;
CREATE POLICY "anon_read_experiments"
  ON public.experiments
  FOR SELECT
  TO anon, authenticated
  USING (true);

-- ─────────────────────────────────────────────────────────────────────────
-- advisors — only active advisors are visible
-- ─────────────────────────────────────────────────────────────────────────
DROP POLICY IF EXISTS "anon_read_active_advisors" ON public.advisors;
CREATE POLICY "anon_read_active_advisors"
  ON public.advisors
  FOR SELECT
  TO anon, authenticated
  USING (is_active = true);

-- ─────────────────────────────────────────────────────────────────────────
-- agent_advisors — only active mappings are visible
-- ─────────────────────────────────────────────────────────────────────────
DROP POLICY IF EXISTS "anon_read_active_agent_advisors" ON public.agent_advisors;
CREATE POLICY "anon_read_active_agent_advisors"
  ON public.agent_advisors
  FOR SELECT
  TO anon, authenticated
  USING (is_active = true);

-- ─────────────────────────────────────────────────────────────────────────
-- ai_outages — operational telemetry, visible
-- ─────────────────────────────────────────────────────────────────────────
DROP POLICY IF EXISTS "anon_read_ai_outages" ON public.ai_outages;
CREATE POLICY "anon_read_ai_outages"
  ON public.ai_outages
  FOR SELECT
  TO anon, authenticated
  USING (true);

-- ─────────────────────────────────────────────────────────────────────────
-- opt_outs — NO public read policy. Server-side only (service_role key).
-- (RLS is still enabled above, so without a policy nothing is visible.)
-- ─────────────────────────────────────────────────────────────────────────
