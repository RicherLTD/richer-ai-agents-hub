-- 0006_prompts_unique_version.sql
--
-- Adds a UNIQUE constraint on (agent_id, prompt_type, version) so the
-- prompts-sync script can use a clean ON CONFLICT upsert when re-running
-- the same migration / file twice.
--
-- This also enforces the invariant in code review: there is only one row
-- per (agent, prompt_type, version) tuple. Multiple versions for the same
-- prompt_type are still allowed; only one of them should have
-- `is_active = true`, but that invariant lives in the sync script.
--
-- Idempotent: the constraint name is fixed.

DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1
    FROM   pg_constraint
    WHERE  conname = 'prompts_agent_type_version_unique'
  ) THEN
    ALTER TABLE public.prompts
      ADD CONSTRAINT prompts_agent_type_version_unique
      UNIQUE (agent_id, prompt_type, version);
  END IF;
END $$;
