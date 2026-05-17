-- 0018_rls_admin_only_reads.sql
--
-- Lock down SELECT access on lead-data tables to admins only. Previously
-- migration 0002 set USING(true) on conversations / messages / lead_memory
-- for any authenticated user — a non-admin "user" role could read every
-- lead conversation across all agents. For the pilot (Kfir + Yitzhak,
-- both admins) this is the correct posture.
--
-- When per-agent RBAC ships (mapping users to specific agents), these
-- policies should be replaced with agent-membership checks. Until then
-- admin-only is the safe default.

DROP POLICY IF EXISTS "authenticated_read_conversations" ON public.conversations;
CREATE POLICY "authenticated_read_conversations"
  ON public.conversations
  FOR SELECT
  TO authenticated
  USING (public.is_admin());

DROP POLICY IF EXISTS "authenticated_read_messages" ON public.messages;
CREATE POLICY "authenticated_read_messages"
  ON public.messages
  FOR SELECT
  TO authenticated
  USING (public.is_admin());

DROP POLICY IF EXISTS "authenticated_read_lead_memory" ON public.lead_memory;
CREATE POLICY "authenticated_read_lead_memory"
  ON public.lead_memory
  FOR SELECT
  TO authenticated
  USING (public.is_admin());

-- prompts stays readable by all authenticated users (read-only) — operators
-- need to see which prompt version is active. Admin gate stays only on
-- the UPDATE policy (migration 0014).
