-- 0004_admin_mutation_policies.sql
--
-- Adds INSERT / UPDATE / DELETE policies for the `agents` table, restricted
-- to admins only (via the `public.is_admin()` function from 0003).
--
-- Read access stays untouched (any authenticated user can read active
-- agents — see 0002_auth_rls_update.sql).
--
-- Other tables (conversations, messages, …) intentionally still have
-- SELECT-only policies. Mutation policies for those will be added in the
-- PR that builds the conversation-management UI, where the role split
-- (admin vs. user) for each mutation is decided.
--
-- Idempotent: every CREATE has a matching DROP-IF-EXISTS.

-- ─────────────────────────────────────────────────────────────────────────
-- Tighten the agents SELECT policy: management UI needs to see *all*
-- agents (incl. inactive/draft) so admins can re-activate them. Regular
-- users still only see active ones.
-- ─────────────────────────────────────────────────────────────────────────
DROP POLICY IF EXISTS "authenticated_read_active_agents" ON public.agents;
CREATE POLICY "authenticated_read_active_agents"
  ON public.agents
  FOR SELECT
  TO authenticated
  USING (
    status = 'active' OR public.is_admin()
  );

-- ─────────────────────────────────────────────────────────────────────────
-- agents INSERT — admins only
-- ─────────────────────────────────────────────────────────────────────────
DROP POLICY IF EXISTS "admin_insert_agents" ON public.agents;
CREATE POLICY "admin_insert_agents"
  ON public.agents
  FOR INSERT
  TO authenticated
  WITH CHECK (public.is_admin());

-- ─────────────────────────────────────────────────────────────────────────
-- agents UPDATE — admins only
-- ─────────────────────────────────────────────────────────────────────────
DROP POLICY IF EXISTS "admin_update_agents" ON public.agents;
CREATE POLICY "admin_update_agents"
  ON public.agents
  FOR UPDATE
  TO authenticated
  USING (public.is_admin())
  WITH CHECK (public.is_admin());

-- ─────────────────────────────────────────────────────────────────────────
-- agents DELETE — admins only. (Soft-delete via status='archived' is the
-- preferred path; hard DELETE is here for completeness, e.g. test cleanup.)
-- ─────────────────────────────────────────────────────────────────────────
DROP POLICY IF EXISTS "admin_delete_agents" ON public.agents;
CREATE POLICY "admin_delete_agents"
  ON public.agents
  FOR DELETE
  TO authenticated
  USING (public.is_admin());
