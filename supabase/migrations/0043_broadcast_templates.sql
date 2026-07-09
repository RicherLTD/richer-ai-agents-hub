-- 0043_broadcast_templates.sql
-- New: registry of Meta-approved templates selectable in the broadcast UI.
-- A typo in template_name makes Meta reject the WHOLE broadcast silently, so
-- the UI picks from this table instead of free text. Seeds each agent's
-- existing first-touch template as an initial option.

CREATE TABLE public.broadcast_templates (
  id              uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  agent_id        uuid NOT NULL REFERENCES public.agents(id) ON DELETE CASCADE,
  name            text NOT NULL,
  language        text NOT NULL DEFAULT 'he',
  label           text NOT NULL,
  variable_count  int NOT NULL DEFAULT 0,
  body_preview    text,
  is_active       boolean NOT NULL DEFAULT true,
  created_at      timestamptz NOT NULL DEFAULT now(),
  UNIQUE (agent_id, name, language)
);

CREATE INDEX broadcast_templates_agent_idx ON public.broadcast_templates (agent_id, is_active);

ALTER TABLE public.broadcast_templates ENABLE ROW LEVEL SECURITY;

CREATE POLICY "admin_all_broadcast_templates" ON public.broadcast_templates
  FOR ALL TO authenticated
  USING (public.is_admin())
  WITH CHECK (public.is_admin());

-- Seed: register each agent's configured first-touch template as a broadcast
-- option so the dropdown is non-empty on day one.
INSERT INTO public.broadcast_templates (agent_id, name, language, label, variable_count)
SELECT id,
       first_touch_template_name,
       COALESCE(first_touch_template_language, 'he'),
       'הודעת פתיחה (first-touch)',
       0
FROM public.agents
WHERE first_touch_template_name IS NOT NULL
ON CONFLICT (agent_id, name, language) DO NOTHING;
