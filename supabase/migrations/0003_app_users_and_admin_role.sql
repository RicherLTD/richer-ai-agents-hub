-- 0003_app_users_and_admin_role.sql
--
-- Introduces the application-level user model (`public.app_users`) layered
-- on top of `auth.users`. This is what the dashboard reads from for role
-- checks and the users-management UI.
--
-- Why a separate table (instead of `auth.users.app_metadata`):
--   1. Role changes don't require the user to re-login (no JWT cache).
--   2. We can attach extra fields (full_name, created_by, …) and join
--      against it from RLS policies cleanly.
--   3. The `app_users` table itself can have RLS — admins see everyone,
--      regular users see only their own row.
--
-- Idempotent: every CREATE has a matching DROP-IF-EXISTS or IF NOT EXISTS.

-- ─────────────────────────────────────────────────────────────────────────
-- Role enum
-- ─────────────────────────────────────────────────────────────────────────
DO $$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_type WHERE typname = 'app_role') THEN
    CREATE TYPE public.app_role AS ENUM ('admin', 'user');
  END IF;
END $$;

-- ─────────────────────────────────────────────────────────────────────────
-- app_users table
-- ─────────────────────────────────────────────────────────────────────────
CREATE TABLE IF NOT EXISTS public.app_users (
  id          uuid PRIMARY KEY REFERENCES auth.users(id) ON DELETE CASCADE,
  email       text NOT NULL UNIQUE,
  full_name   text,
  role        public.app_role NOT NULL DEFAULT 'user',
  created_at  timestamptz NOT NULL DEFAULT now(),
  created_by  uuid REFERENCES auth.users(id) ON DELETE SET NULL
);

-- Trigger to keep `updated_at`-style behaviour minimal — we only have
-- created_at for now. If we add updated_at later, do it in a follow-up
-- migration with a BEFORE UPDATE trigger.

-- ─────────────────────────────────────────────────────────────────────────
-- is_admin() — used by RLS policies in 0004 and beyond.
--
-- SECURITY DEFINER so it can bypass RLS on app_users when reading the
-- caller's role (otherwise we'd hit a chicken-and-egg situation: to read
-- app_users you'd need a policy, and the policy itself needs is_admin()).
-- The function only reads — no mutations — so this is safe.
-- ─────────────────────────────────────────────────────────────────────────
CREATE OR REPLACE FUNCTION public.is_admin()
RETURNS boolean
LANGUAGE sql
STABLE
SECURITY DEFINER
SET search_path = public
AS $$
  SELECT EXISTS (
    SELECT 1
    FROM public.app_users
    WHERE id = auth.uid()
      AND role = 'admin'
  );
$$;

-- Allow `authenticated` to call the function (it's safe — it only checks
-- the caller's own row).
REVOKE ALL ON FUNCTION public.is_admin() FROM PUBLIC;
GRANT EXECUTE ON FUNCTION public.is_admin() TO authenticated;

-- ─────────────────────────────────────────────────────────────────────────
-- handle_new_auth_user() trigger — when a new auth.users row is created
-- (via Studio / admin API / future invite edge function), automatically
-- mirror it into app_users with role='user'. Admin can promote later.
--
-- SECURITY DEFINER because the trigger fires under the inserter's role
-- (often service_role) and we want predictable behaviour.
-- ─────────────────────────────────────────────────────────────────────────
CREATE OR REPLACE FUNCTION public.handle_new_auth_user()
RETURNS trigger
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
BEGIN
  INSERT INTO public.app_users (id, email, role)
  VALUES (NEW.id, NEW.email, 'user')
  ON CONFLICT (id) DO NOTHING;
  RETURN NEW;
END;
$$;

DROP TRIGGER IF EXISTS on_auth_user_created ON auth.users;
CREATE TRIGGER on_auth_user_created
  AFTER INSERT ON auth.users
  FOR EACH ROW
  EXECUTE FUNCTION public.handle_new_auth_user();

-- ─────────────────────────────────────────────────────────────────────────
-- Seed: promote the existing bootstrap user (Izak.cmo@richerltd.com) to
-- admin. Idempotent: safe to re-run.
--
-- This is the only hardcoded email in the schema. Once admins can manage
-- users from the dashboard (PR 11c), they can elevate others.
-- ─────────────────────────────────────────────────────────────────────────
INSERT INTO public.app_users (id, email, role)
SELECT id, email, 'admin'
FROM auth.users
WHERE lower(email) = lower('Izak.cmo@richerltd.com')
ON CONFLICT (id) DO UPDATE SET role = 'admin';

-- ─────────────────────────────────────────────────────────────────────────
-- RLS on app_users
-- ─────────────────────────────────────────────────────────────────────────
ALTER TABLE public.app_users ENABLE ROW LEVEL SECURITY;

-- SELECT: every authenticated user can read their own row; admins read all.
DROP POLICY IF EXISTS "authenticated_read_own_or_admin_all" ON public.app_users;
CREATE POLICY "authenticated_read_own_or_admin_all"
  ON public.app_users
  FOR SELECT
  TO authenticated
  USING (id = auth.uid() OR public.is_admin());

-- INSERT: admins only. (Regular invite flow goes through an edge function
-- that uses service_role and bypasses RLS; this policy is the safety net.)
DROP POLICY IF EXISTS "admin_insert_app_users" ON public.app_users;
CREATE POLICY "admin_insert_app_users"
  ON public.app_users
  FOR INSERT
  TO authenticated
  WITH CHECK (public.is_admin());

-- UPDATE: admins only (e.g. changing role, full_name).
DROP POLICY IF EXISTS "admin_update_app_users" ON public.app_users;
CREATE POLICY "admin_update_app_users"
  ON public.app_users
  FOR UPDATE
  TO authenticated
  USING (public.is_admin())
  WITH CHECK (public.is_admin());

-- DELETE: admins only.
DROP POLICY IF EXISTS "admin_delete_app_users" ON public.app_users;
CREATE POLICY "admin_delete_app_users"
  ON public.app_users
  FOR DELETE
  TO authenticated
  USING (public.is_admin());
