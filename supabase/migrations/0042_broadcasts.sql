-- 0042_broadcasts.sql
-- New: broadcasts table (one row per bulk WhatsApp template send) + status enum.
-- Purely additive. Does not touch scheduled_messages or the dispatcher hot path.
-- Idempotent (applied via scripts/db/apply.ts, which has no migration tracking).

DO $$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_type WHERE typname = 'broadcast_status_enum') THEN
    CREATE TYPE public.broadcast_status_enum AS ENUM (
      'draft', 'queued', 'sending', 'completed', 'cancelled'
    );
  END IF;
END
$$;

CREATE TABLE IF NOT EXISTS public.broadcasts (
  id                    uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  agent_id              uuid NOT NULL REFERENCES public.agents(id) ON DELETE CASCADE,
  template_name         text NOT NULL,
  template_language     text NOT NULL DEFAULT 'he',
  template_variables    jsonb NOT NULL DEFAULT '[]'::jsonb,
  title                 text NOT NULL,
  status                public.broadcast_status_enum NOT NULL DEFAULT 'queued',
  scheduled_for         timestamptz,
  total_recipients      int NOT NULL DEFAULT 0,
  suppressed_count      int NOT NULL DEFAULT 0,
  suppressed_breakdown  jsonb NOT NULL DEFAULT '{}'::jsonb,
  created_by            uuid REFERENCES public.app_users(id) ON DELETE SET NULL,
  created_at            timestamptz NOT NULL DEFAULT now(),
  updated_at            timestamptz NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS broadcasts_agent_created_idx ON public.broadcasts (agent_id, created_at DESC);

CREATE OR REPLACE FUNCTION public.broadcasts_set_updated_at()
RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  NEW.updated_at := now();
  RETURN NEW;
END;
$$;

DROP TRIGGER IF EXISTS broadcasts_set_updated_at ON public.broadcasts;
CREATE TRIGGER broadcasts_set_updated_at
  BEFORE UPDATE ON public.broadcasts
  FOR EACH ROW EXECUTE FUNCTION public.broadcasts_set_updated_at();

ALTER TABLE public.broadcasts ENABLE ROW LEVEL SECURITY;

-- Admin-only, consistent with migration 0018. The edge function uses the
-- service_role key and bypasses RLS.
DROP POLICY IF EXISTS "admin_all_broadcasts" ON public.broadcasts;
CREATE POLICY "admin_all_broadcasts" ON public.broadcasts
  FOR ALL TO authenticated
  USING (public.is_admin())
  WITH CHECK (public.is_admin());
