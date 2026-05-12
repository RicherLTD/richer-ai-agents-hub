-- 0011_drop_redacted_views.sql
--
-- Drops the `failed_messages_safe` and `error_logs_safe` views created in
-- 0008 and 0009.
--
-- Why: Postgres creates views with SECURITY DEFINER semantics by default,
-- which means the views bypass RLS on the underlying table. The
-- Supabase database linter (`security_definer_view`) flags this as ERROR
-- level, and the intent — "let non-admin operators read a redacted
-- projection" — is better implemented later as either:
--   (a) a SECURITY INVOKER view paired with a non-admin RLS SELECT policy
--       on the base table that uses column-level grants, or
--   (b) a SECURITY DEFINER set-returning function with explicit role
--       checks.
--
-- For Phase A, no UI consumes these views yet. Dropping them removes the
-- linter ERROR; we'll add the correct mechanism in Phase B alongside the
-- ops dashboard widgets that actually need it.
--
-- Idempotent: DROP VIEW IF EXISTS.

DROP VIEW IF EXISTS public.failed_messages_safe;
DROP VIEW IF EXISTS public.error_logs_safe;
