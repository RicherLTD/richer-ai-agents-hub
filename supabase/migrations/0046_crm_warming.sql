-- 0046_crm_warming.sql
--
-- CRM-driven lead warming.
--
-- Today the bot learns about a lead through exactly two doors: an inbound
-- WhatsApp message, or a landing-form submit via lead-register. Once a human
-- sales rep touches the lead in Fireberry — calls, gets no answer, marks an
-- objection — that knowledge stays locked in the CRM and the lead goes cold.
--
-- This adds a third door. Fireberry fires a status change → Make → the new
-- crm-status-webhook edge function → the conversation is flagged 'warming',
-- a generic opener template is enqueued, and from the lead's reply onward the
-- EXISTING agent loop runs with per-status context injected into the system
-- prompt (the same slot bookingStatusBlock already occupies).
--
-- Design notes worth keeping in view:
--
--   * The decision key is (product, status_sub). product → agent via the
--     existing agents.mooz_product_code (B/R, migration 0041). Lead identity
--     is the canonical phone — fireberry_lead_id is stored when it arrives but
--     is NOT an identity key, because we have no guarantee it is populated.
--
--   * crm_status_rules is NOT an allow-list. Make already filters to
--     warming-relevant statuses on Izak's side (blacklist / invalid lead /
--     wrong number are simply never sent). A status that arrives without a
--     rule row falls back to an immediate default.
--
--   * There is no per-status message text. The opener is ONE generic template
--     per agent ("היי X מה קורה?"); all per-status differentiation lives in
--     warming_instructions, which is injected into the system prompt. That
--     means changing how the bot handles an objection is a DB edit — no Meta
--     template approval, no deploy.
--
--   * Everything here is additive. No existing column is altered or dropped,
--     and scheduled_messages.kind defaults to 'template' so every existing row
--     and the entire existing dispatcher path are untouched.
--
-- Voicenter was considered as a source of rep-call transcripts and dropped:
-- the cPanel endpoint is capped at 100 calls/day shared with manual listening.
-- The optional rep_note on the webhook payload covers the same need at zero
-- infrastructure cost, and lands in conversations.crm_rep_note below.
--
-- Idempotent: safe to re-run (applied via scripts/db/apply.ts, which has no
-- migration tracking). The seed uses ON CONFLICT DO NOTHING so it will never
-- clobber instruction text an operator has edited from the dashboard.

-- ---------------------------------------------------------------------------
-- 1. Enum
-- ---------------------------------------------------------------------------

-- NULL = a normal lead (the overwhelming majority). The column existing at all
-- is what keeps warming leads separable in the dashboard and in analytics.
DO $$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_type WHERE typname = 'crm_warming_status_enum') THEN
    CREATE TYPE public.crm_warming_status_enum AS ENUM (
      'warming',
      'warming_stopped',
      'warming_converted'
    );
  END IF;
END $$;

-- ---------------------------------------------------------------------------
-- 2. crm_status_rules — the per-agent, per-status playbook
-- ---------------------------------------------------------------------------

CREATE TABLE IF NOT EXISTS public.crm_status_rules (
  id                   uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  agent_id             uuid NOT NULL REFERENCES public.agents(id) ON DELETE CASCADE,

  -- Fireberry secondary status (pcfsystemfield103). This is the decision key.
  status_sub           int NOT NULL,

  -- Hebrew meaning, shown in the dashboard and injected into the prompt so the
  -- bot reads a label rather than an integer.
  status_label         text NOT NULL,

  -- Stable English slug for the objection. Used for Langfuse trace tags and as
  -- the join key for the Phase-2 asset catalog, so it must not drift.
  objection_key        text NOT NULL,

  -- Directive text for the bot: what this objection means and how to play it.
  -- This is the operator's surface — edited from the dashboard, no deploy.
  warming_instructions text NOT NULL,

  -- 0 = warm immediately. Otherwise the send is scheduled this far out, which
  -- is how "come back to a price objection in 15 days" is expressed.
  delay_hours          int NOT NULL DEFAULT 0 CHECK (delay_hours >= 0),

  -- Don't open a new warming send for this lead within this many days. Guards
  -- against a rep flipping a lead through four statuses in a week and the lead
  -- receiving four openers.
  cooldown_days        int NOT NULL DEFAULT 7 CHECK (cooldown_days >= 0),

  -- Data-driven replacement for a magic status number in the webhook: a lead
  -- who ghosted their Zoom carries zoom_scheduled state that would otherwise
  -- block the send outright. Only status 91 sets this today.
  clears_zoom_state    boolean NOT NULL DEFAULT false,

  is_active            boolean NOT NULL DEFAULT true,
  created_at           timestamptz NOT NULL DEFAULT now(),
  updated_at           timestamptz NOT NULL DEFAULT now(),

  UNIQUE (agent_id, status_sub)
);

CREATE INDEX IF NOT EXISTS crm_status_rules_agent_idx
  ON public.crm_status_rules (agent_id, is_active);

ALTER TABLE public.crm_status_rules ENABLE ROW LEVEL SECURITY;

DROP POLICY IF EXISTS "admin_all_crm_status_rules" ON public.crm_status_rules;
CREATE POLICY "admin_all_crm_status_rules" ON public.crm_status_rules
  FOR ALL TO authenticated
  USING (public.is_admin())
  WITH CHECK (public.is_admin());

CREATE OR REPLACE FUNCTION public.crm_status_rules_set_updated_at()
RETURNS trigger
LANGUAGE plpgsql
AS $$
BEGIN
  NEW.updated_at = now();
  RETURN NEW;
END;
$$;

DROP TRIGGER IF EXISTS crm_status_rules_set_updated_at ON public.crm_status_rules;
CREATE TRIGGER crm_status_rules_set_updated_at
  BEFORE UPDATE ON public.crm_status_rules
  FOR EACH ROW EXECUTE FUNCTION public.crm_status_rules_set_updated_at();

-- ---------------------------------------------------------------------------
-- 3. conversations — warming state
-- ---------------------------------------------------------------------------
--
-- Note what is NOT here: primary_objection and secondary_objections are left
-- alone. Those hold what the BOT concluded from the chat; the columns below
-- hold what the REP concluded from a phone call. Different observers, and when
-- they disagree that disagreement is itself signal worth keeping.
--
-- fireberry_lead_id already exists on this table — nothing to add.

ALTER TABLE public.conversations
  ADD COLUMN IF NOT EXISTS crm_warming_status public.crm_warming_status_enum,
  ADD COLUMN IF NOT EXISTS crm_status_sub     int,
  ADD COLUMN IF NOT EXISTS crm_status_main    int,
  ADD COLUMN IF NOT EXISTS crm_warming_reason text,
  ADD COLUMN IF NOT EXISTS crm_rep_note       text,
  -- When the most recent status event arrived. Drives the context time-box:
  -- a status is a snapshot, not a permanent fact about the person, so the
  -- prompt block stops being injected once this goes stale. A fresh event
  -- restarts the clock, so an actively-worked lead always has current context.
  ADD COLUMN IF NOT EXISTS crm_status_event_at timestamptz,
  -- When a warming opener was last QUEUED (not sent — the row may still be
  -- pending, or deferred behind a live conversation). Drives cooldown, and
  -- queue-time is the right basis: it stops a burst of status changes stacking
  -- up several openers before any of them has gone out. Deliberately separate
  -- from crm_status_event_at — context refreshes on every event, sends do not.
  ADD COLUMN IF NOT EXISTS crm_last_warmed_at  timestamptz,
  -- First time the lead answered after a warming send. Doubles as the
  -- idempotency guard for the Langfuse `lead_replied` session score: the agent
  -- loop claims it with a conditional UPDATE … WHERE crm_warming_replied_at IS
  -- NULL, so the score is emitted exactly once even under concurrent webhooks.
  ADD COLUMN IF NOT EXISTS crm_warming_replied_at timestamptz;

-- Indexed on the event timestamp rather than crm_warming_status, because the
-- dashboard has to show BOTH actually-warming leads and leads recorded while
-- the agent's kill switch was off (those keep crm_warming_status NULL by
-- design, so the prompt stays untouched — see the webhook's writeWarmingContext).
CREATE INDEX IF NOT EXISTS conversations_crm_warming_idx
  ON public.conversations (agent_id, crm_status_event_at DESC)
  WHERE crm_status_event_at IS NOT NULL;

-- ---------------------------------------------------------------------------
-- 4. agents — per-agent warming config
-- ---------------------------------------------------------------------------

ALTER TABLE public.agents
  -- Independent of is_paused: pausing the agent stops everything, this stops
  -- only warming. Defaults to false so applying this migration changes no
  -- behaviour until someone deliberately flips it.
  ADD COLUMN IF NOT EXISTS crm_warming_enabled boolean NOT NULL DEFAULT false,
  ADD COLUMN IF NOT EXISTS warming_template_name text,
  ADD COLUMN IF NOT EXISTS warming_template_language text NOT NULL DEFAULT 'he',
  -- How long a status event keeps steering the bot. See crm_status_event_at.
  ADD COLUMN IF NOT EXISTS warming_context_days int NOT NULL DEFAULT 14
    CHECK (warming_context_days > 0);

-- ---------------------------------------------------------------------------
-- 5. scheduled_messages — distinguish a warming row from a plain template
-- ---------------------------------------------------------------------------
--
-- The dispatcher applies one extra rule to 'warming' rows (defer while the
-- lead is actively chatting, so the bot never knocks over a live conversation).
-- 'template' rows take exactly the path they take today; the DEFAULT ensures
-- every existing row is already correct.

ALTER TABLE public.scheduled_messages
  ADD COLUMN IF NOT EXISTS kind text NOT NULL DEFAULT 'template';

DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint WHERE conname = 'scheduled_messages_kind_check'
  ) THEN
    ALTER TABLE public.scheduled_messages
      ADD CONSTRAINT scheduled_messages_kind_check
      CHECK (kind IN ('template', 'warming'));
  END IF;
END $$;

-- Lets the dispatcher find pending warming rows without scanning the whole
-- queue, and backs the "supersede any pending warming row" write.
CREATE INDEX IF NOT EXISTS scheduled_messages_warming_pending_idx
  ON public.scheduled_messages (conversation_id, scheduled_for)
  WHERE kind = 'warming' AND status = 'pending';

-- ---------------------------------------------------------------------------
-- 6. Seed — the status playbook, for every agent
-- ---------------------------------------------------------------------------
--
-- Delays come from Izak's list. Instructions are a first draft written against
-- the tone of the live prompts; they are meant to be edited from the dashboard
-- once real replies are visible. ON CONFLICT DO NOTHING means re-running this
-- migration will never overwrite those edits.
--
-- The hard limits from the agent prompts still apply on top of every line
-- below: never quote a price, never promise income, never invent facts, never
-- send an unapproved link.

INSERT INTO public.crm_status_rules
  (agent_id, status_sub, status_label, objection_key, delay_hours, cooldown_days, clears_zoom_state, warming_instructions)
SELECT a.id, r.status_sub, r.status_label, r.objection_key, r.delay_hours, r.cooldown_days, r.clears_zoom_state, r.warming_instructions
FROM public.agents a
CROSS JOIN (VALUES
  -- ---- No answer: the rep tried to call and could not reach them ----------
  -- These are NOT objections. Treat them as availability problems, and never
  -- let the lead feel chased.
  (2, 'א״מ יום 1', 'no_answer', 0, 7, false,
   'נציג ניסה להשיג את הליד בטלפון ולא הצליח לתפוס אותו. זו לא התנגדות — הליד פשוט לא היה זמין. אל תזכיר שניסינו להתקשר ואל תיצור תחושת מרדף. פתח קליל, והובל בעדינות לתיאום זום עם יועץ במועד שנוח לו.'),
  (3, 'א״מ יום 2', 'no_answer', 0, 7, false,
   'ניסיון התקשרות שני שלא נענה. אותו עיקרון — לא התנגדות, רק חוסר זמינות. הדגש בעדינות שאפשר לתאם הכל בוואטסאפ בלי שיחות טלפון, ושהזום נקבע למועד שהוא בוחר.'),
  (4, 'א״מ יום 3', 'no_answer', 0, 7, false,
   'שלושה ניסיונות התקשרות שלא נענו. אל תלחץ ואל תזכיר את מספר הניסיונות. שאל שאלה פתוחה קצרה שקל לענות עליה, כדי להחזיר אותו לשיחה.'),
  (5, 'א״מ יום 4', 'no_answer', 0, 7, false,
   'הליד לא זמין טלפונית כבר מספר ימים. הנח שהוא עסוק, לא שהוא לא מעוניין. הצע התקדמות בוואטסאפ ותן לו לבחור מתי נוח לו לזום.'),
  (6, 'א״מ יום 5', 'no_answer', 0, 10, false,
   'ניסיון אחרון בסבב ההתקשרויות. שמור על טון רגוע ולא נואש. תן לו דרך קלה לחזור — שאלה אחת פשוטה, או הצעה לקבוע זום קצר בזמן שנוח לו.'),
  (7, 'א״מ ממתינה', 'no_answer', 0, 7, false,
   'הליד בהמתנה אחרי סבב ניסיונות התקשרות. אין מידע על התנגדות. פתח שיחה קלילה, בדוק אם הנושא עדיין רלוונטי עבורו, ואם כן — הובל לתיאום זום.'),

  -- ---- Objections raised in an actual conversation with the rep ----------
  (14, 'ל״מ מחיר', 'price', 360, 14, false,
   'הליד העלה את נושא המחיר מול הנציג. אסור לך לנקוב במחירים, במספרים או ברמז להנחה. הסט את השיחה מ״כמה זה עולה״ ל״מה זה נותן״ — מה הליד מקבל ולאן זה יכול לקחת אותו. הסבר שהשיחה עם היועץ היא המקום שבו מדברים על ההשקעה ועל אפשרויות ההתאמה, ואל תתנצל על העלות.'),
  (15, 'ל״מ מתחרים', 'competitors', 0, 14, false,
   'הליד שוקל אלטרנטיבה אחרת. אל תדבר רעה על אף גורם אחר ואל תשווה ישירות. התמקד במה שמייחד את הליווי אצלנו ובשאלה מה בדיוק חשוב לו בבחירה — ואז הצע זום שבו יוכל לקבל תשובות מדויקות.'),
  (16, 'ל״מ אורך הקורס', 'course_length', 0, 14, false,
   'הליד הביע חשש מהיקף הזמן שהתוכנית דורשת. אל תמעיט בהיקף ואל תמציא מספרים. שאל כמה זמן הוא כן יכול להקדיש בשבוע, והראה שהשיחה עם היועץ נועדה בדיוק כדי לבדוק התאמה למציאות שלו.'),
  (18, 'ל״מ אמון במוצר', 'trust_product', 0, 14, false,
   'הליד לא בטוח שהתוכנית באמת עובדת. אל תבטיח תוצאות ואל תמציא נתונים. ברר מה ספציפית מעורר אצלו ספק, והצע שיחה עם יועץ שבה יוכל לשאול הכל ולראות בדיוק איך זה עובד בפועל.'),
  (19, 'ל״מ תכנים חסרים', 'missing_content', 0, 14, false,
   'הליד חושב שחסר בתוכנית משהו שהוא מחפש. ברר מה בדיוק חיפש — לעיתים קרובות זה קיים והוא פשוט לא שמע עליו. אל תמציא תכנים שאינך יודע שקיימים; במקום זה הובל לזום שבו היועץ יוכל לענות בדיוק.'),
  (20, 'ל״מ חוסר כימיה', 'no_chemistry', 0, 21, false,
   'השיחה עם הנציג לא זרמה. אל תתייחס לזה ישירות ואל תבקש התנצלות או הסבר. פתח דף חדש בטון נעים ורגוע, והצע שיחה קצרה עם יועץ — ייתכן שההתאמה האישית תהיה טובה יותר.'),
  (21, 'ל״מ מסנן', 'screening', 0, 21, false,
   'הליד סינן את עצמו מהתהליך. ברר בעדינות מה גרם לכך — לרוב מדובר בהנחה שגויה לגבי מה שנדרש ממנו. אל תלחץ; אם הוא באמת לא רלוונטי, סיים בנעימות.'),
  (22, 'ל״מ פוטנציאל עתידי', 'future_potential', 720, 30, false,
   'הליד מעוניין אבל לא בעיתוי הנוכחי. עבר זמן מאז. פתח בלי להזכיר את הדחייה הקודמת, בדוק אם הנסיבות השתנו, ואם כן — הצע לתאם זום עכשיו.'),
  (23, 'ל״מ לא רציני', 'not_serious', 0, 21, false,
   'הנציג התרשם שהליד לא רציני. התייחס לזה כהערכה של אדם אחד ולא כעובדה. שאל שאלה ממוקדת שתראה עד כמה הנושא באמת רלוונטי לו, ואל תשקיע לחץ מיותר אם התשובות רפויות.'),
  (24, 'ל״מ אחר', 'other', 0, 14, false,
   'הנציג סימן התנגדות שלא נכנסת לאף קטגוריה מוגדרת. אין לך מידע על מה מדובר. אל תנחש — פתח שיחה קלילה וגלה בעצמך מה עומד מאחורי החשש, ורק אז הובל לזום.'),
  (26, 'ל״ר דחוי מימון / אין כסף', 'financing_deferred', 0, 21, false,
   'הליד ציין קושי במימון. אל תנקוב במחירים, אל תבטיח הנחה ואל תמציא מסלולי תשלום. הכר בכך שזה שיקול לגיטימי, והסבר שהיועץ הוא מי שיכול לבדוק איתו אפשרויות התאמה.'),
  (47, 'ל״ב אחר', 'on_hold_other', 0, 14, false,
   'הליד בהמתנה מסיבה שלא פורטה. אין מידע על התנגדות. פתח שיחה קלילה, בדוק אם הנושא עדיין על השולחן, וגלה תוך כדי הדיאלוג מה חוסם.'),
  (50, 'ל״מ מסרב לפרט', 'refuses_detail', 0, 21, false,
   'הליד לא היה מוכן לשתף פרטים עם הנציג. אל תחקור ואל תשאל שאלות אישיות מוקדם. בנה אמון קודם — שאלה אחת קלה שקל לענות עליה, ורק אחר כך התקדם.'),
  (51, 'ל״מ חשב שזה חינם', 'thought_free', 0, 21, false,
   'הליד הופתע לגלות שמדובר בתוכנית בתשלום. אסור לך לנקוב במחיר. הסבר בקצרה מה כוללת התוכנית ומה ההבדל בינה לבין תוכן חינמי, והצע שיחה עם יועץ לפרטים המלאים.'),
  (52, 'ל״מ אנטיגוניזם למשפך', 'funnel_antagonism', 0, 30, false,
   'הליד הגיב בשלילה לתהליך עצמו — לשאלות, לשלבים או לפניות. קצר מאוד, ישיר, בלי שאלות סקר ובלי משפכים. תן לו לבחור: או שהוא רוצה פרטים, או שנשחרר אותו בנעימות.'),
  (54, 'ל״מ אין כסף', 'no_money', 0, 21, false,
   'הליד ציין שאין לו כרגע את התקציב. אל תנקוב במחירים ואל תבטיח הנחות. אל תלחץ. בדוק אם העיתוי הוא הבעיה ולא העיקרון, והצע שיחה עם יועץ אם הוא רוצה לבדוק אפשרויות.'),
  (55, 'ל״מ ניסיון שלילי', 'negative_experience', 24, 21, false,
   'לליד היה ניסיון רע בעבר עם תוכנית או גורם דומה. הקשב לפני שאתה מציע. אל תבטל את החוויה שלו ואל תבטיח שאצלנו זה שונה בלי בסיס. שאל מה קרה, והצע שיחה עם יועץ שיוכל להתייחס לזה ישירות.'),
  (56, 'ל״מ אמונה עצמית', 'self_belief', 48, 21, false,
   'הליד לא בטוח שהוא מסוגל. זו התנגדות רגשית, לא לוגית — אל תפגיז אותו בעובדות. חזק בעדינות, שאל מה גורם לו לחשוב כך, והצע שיחה עם יועץ שיוכל לומר לו בכנות אם זה מתאים לו.'),
  (58, 'ל״מ אמון בחברה', 'trust_company', 0, 21, false,
   'הליד לא בטוח לגבי המכללה עצמה. אל תמציא נתונים, מספרים או המלצות. ברר מה מטריד אותו ספציפית, והצע שיחה ישירה עם יועץ — שקיפות עובדת כאן טוב יותר מכל טיעון.'),
  (59, 'ל״מ ביקורות שליליות', 'negative_reviews', 24, 21, false,
   'הליד נתקל בביקורות שליליות. אל תתווכח, אל תכחיש ואל תמציא הסברים. הכר בכך שזה שיקול הגיוני, ברר מה בדיוק הוא ראה, והצע שיחה עם יועץ שיוכל להתייחס לזה בכנות.'),
  (60, 'ל״מ אין זמן', 'no_time', 0, 14, false,
   'הליד אמר שאין לו זמן. לרוב זו התנגדות מנומסת שמסתירה משהו אחר, אבל אל תניח זאת בקול. הצע משהו קטן וקל — שיחה קצרה במועד שהוא בוחר — וגלה תוך כדי הדיאלוג אם יש חשש אמיתי מתחת.'),
  (72, 'ל״מ צורך במוצר', 'product_need', 0, 14, false,
   'הליד לא בטוח שהוא בכלל צריך את זה. אל תמכור. ברר מה המצב שלו היום ומה היה רוצה שישתנה, ורק אם עולה פער אמיתי — הצע שיחה עם יועץ.'),
  (73, 'ל״מ ניתק בפתיח', 'hung_up', 0, 14, false,
   'הליד ניתק את שיחת הטלפון כבר בפתיחה. אין לך מידע על התנגדות, ויש סימן שהוא לא אוהב שיחות טלפון. הודעה קצרה מאוד, בלי שאלות מרובות, שמאפשרת לו לענות במילה אחת.'),
  (76, 'ל״מ בן/בת זוג', 'spouse', 720, 30, false,
   'ההחלטה תלויה בבן או בת הזוג. עבר זמן מאז. אל תנסה לעקוף את השותף להחלטה — להפך, הצע שיחה שבה שניהם יוכלו להיות נוכחים ולשאול. בדוק אם הנסיבות השתנו.'),
  (77, 'ל״מ לא מתחבר לתחום', 'not_connected_field', 0, 21, false,
   'הליד לא מתחבר לתחום עצמו. זו התנגדות מהותית — אל תדחוף. ברר מה כן מעניין אותו, ואם באמת אין חיבור, סיים בנעימות בלי לנסות לשכנע.'),
  (80, 'ל״מ התחרבן במימון', 'financing_failed', 336, 21, false,
   'תהליך המימון של הליד לא צלח. עבר זמן מאז. אל תזכיר את הכישלון ישירות ואל תנקוב בסכומים. בדוק בעדינות אם המצב השתנה, והצע שיחה עם יועץ לבדיקת אפשרויות.'),

  -- ---- Ghosted a booked Zoom ---------------------------------------------
  -- clears_zoom_state = true: without it, the lead's own stale zoom_scheduled
  -- tag would make the dispatcher cancel this send outright.
  (91, 'הבריז מזום', 'ghosted_zoom', 48, 14, true,
   'הליד קבע זום ולא הגיע. אל תשפוט, אל תאשים ואל תבקש הסבר — לרוב פשוט קרה משהו. הזכר בקלילות שהפגישה לא יצאה לפועל, והצע לקבוע מועד חדש שנוח לו. זה ליד חם: הוא כבר הביע נכונות.')
) AS r(status_sub, status_label, objection_key, delay_hours, cooldown_days, clears_zoom_state, warming_instructions)
ON CONFLICT (agent_id, status_sub) DO NOTHING;
