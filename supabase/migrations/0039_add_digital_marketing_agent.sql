-- 0039_add_digital_marketing_agent.sql
--
-- Adds the second production agent: digital_marketing (persona "תמיר"),
-- Richer College's digital-marketing course track (Shalev Yifrach brand).
--
-- Same goal/flow as affiliate_marketing (warm lead -> collect q1-q5 -> consent
-- -> Zoom with a study advisor); only the product knowledge and identity differ.
--
-- Routing: inbound is attributed by whatsapp_phone_number_id (multi-agent path
-- in the shared webhook handler). The new HookMyApp channel's phone_number_id
-- is seeded here so messages route to this agent from the first inbound.
--
-- meeting_type_id is the Mooz UUID for "פגישת זום - בדיקת התאמה למסלול שיווק
-- בריצ'ר" (numeric id 1, slug richer_marketing). Same Mooz org (915d9ade) and
-- same advisor team as affiliate_marketing, so the existing MOOZ_ORG_API_KEY
-- already covers it — only the meeting_type_id differs.
--
-- Idempotent: re-running does nothing if the agent already exists.

INSERT INTO public.agents (
  name,
  display_name,
  status,
  whatsapp_number,
  whatsapp_phone_number_id,
  whatsapp_provider,
  meeting_type_id,
  meeting_duration_minutes,
  quiet_hours_start_il,
  quiet_hours_end_il,
  first_touch_delay_minutes,
  first_touch_template_name,
  operator_alert_phones
)
SELECT
  'digital_marketing',
  'שיווק דיגיטלי',
  'active',
  '+972557113830',
  '1183645111502568',
  'hookmyapp',
  'd44fe2dc-f849-4468-af5c-a6bdf1e91087',
  30,
  20,
  8,
  40,
  'series_marketing_1',
  ARRAY['+972512310702', '+972525563338']::text[]
WHERE NOT EXISTS (
  SELECT 1 FROM public.agents WHERE name = 'digital_marketing'
);
