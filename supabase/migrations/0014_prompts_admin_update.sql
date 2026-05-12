-- 0014_prompts_admin_update.sql
--
-- Lets admins flip `is_active` on prompt rows from the dashboard
-- (Phase D rollback button). Without this policy, the existing RLS
-- has SELECT for authenticated but no UPDATE for anyone — meaning
-- only service_role (i.e. server-side scripts) can flip the active
-- version. We want admins to do it live from the dashboard.
--
-- Idempotent: DROP POLICY IF EXISTS + CREATE.

DROP POLICY IF EXISTS "admin_update_prompts" ON public.prompts;
CREATE POLICY "admin_update_prompts"
  ON public.prompts
  FOR UPDATE
  TO authenticated
  USING (public.is_admin())
  WITH CHECK (public.is_admin());
