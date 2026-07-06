# Design — חיבור סוכן "שיווק דיגיטלי" (תמיר)

> תאריך: 2026-07-02
> סטטוס: מאושר לתכנון יישום
> מחבר: Claude Code (בשיתוף Izak)

## מטרה

להוסיף סוכן שני למערכת ה-multi-agent הקיימת: **שיווק דיגיטלי**, בדמות נציג בשם **תמיר**, עבור מסלול השיווק הדיגיטלי של מכללת ריצ'ר (המותג של שלו יפרח).

הסוכן החדש בעל **אותה מטרה בדיוק** כמו סוכן השותפים (`affiliate_marketing`): לחמם ליד בוואטסאפ, ללקט 5 שאלות, לקבל הסכמה, ולתאם זום עם יועץ לימודים. ההבדל היחיד הוא **המוצר** (הידע) וה**זהות** (תמיר במקום כפיר) — כל השאר זהה.

עיקרון מנחה: **לא נוגעים בארכיטקטורה.** התשתית כבר multi-agent-ready (ניתוב לפי `whatsapp_phone_number_id`, פרומפטים per-agent, brain/quiet-hours/handoff מסוננים לפי `agent_id`). העבודה היא משכפול זרימה קיימת + החלפת מוח + קונפיג.

## החלטות שסוכמו

1. **שאלות ליקוט (q1–q5)** — זהות לחלוטין לסוכן השותפים. אין שינוי בסכמת `lead_memory` או בלוגיקת funnel/handoff.
2. **יועצים** — אותם יועצי לימודים בדיוק. משתמשים ב-`meeting_type_id` נפרד ב-Mooz שמפנה לאותו צוות.
3. **טמפלייט פתיחה** — נוסח השאלה יהיה 1:1 כמו השותפים (1. להכניס עוד כסף / 2. לצאת ממסגרת / 3. ללמוד מקצוע אמיתי / 4. חופש לעבוד מכל מקום). המשתמש יספק שם טמפלייט Meta מאושר נפרד.
4. **הפרדת נתונים** — אופציה א': אותם מנהלים מנהלים את שני הסוכנים; רוצים תצוגות מופרדות ונקיות. **לא** נדרש per-user RBAC (`user_agents`/RLS). מספיק לתקן את דליפת ה-deep-link ב-`getConversationById`.
5. **פרומפט** — נבנה על שלד `main/v16` של השותפים; כל פרט מוצר עובר התאמה לשלו יפרח + פרטי המסלול; כל השאר זהה מילה במילה.
6. **הפרדה פיזית של ה-webhook (דרך A)** — המספר החדש הוא **channel נפרד ב-HookMyApp עם קרדנציאלס משלו** (VERIFY_TOKEN, ACCESS_TOKEN, WABA, API URL שונים). לכן כל סוכן מקבל **פונקציית edge webhook נפרדת**, ששתיהן מייבאות handler משותף אחד. אפס שינוי התנהגותי לזרימת השותפים.

## הפער הקריטי שהתגלה ותוקן בתכנון

ה-webhook הקיים **מנתב** inbound לסוכן הנכון לפי `whatsapp_phone_number_id` — אבל שני נתיבים משתמשים ב-**env גלובלי אחד**, לא per-agent:

1. **אימות HMAC** (`whatsapp-webhook/index.ts:1629`) — מאמת כל inbound מול `VERIFY_TOKEN` אחד, **לפני** שידוע לאיזה סוכן ההודעה שייכת. המספר החדש חותם עם secret שונה → הודעותיו היו נכשלות באימות ומושמטות בשקט.
2. **שליחה יוצאת** (`index.ts:1715‑1832`) — בונה קרדנציאלס מ-`WHATSAPP_ACCESS_TOKEN`/`WHATSAPP_PHONE_NUMBER_ID`/`WHATSAPP_API_URL` גלובליים. תגובות תמיר היו נשלחות עם הטוקן/המספר של כפיר או נכשלות.

**המשמעות:** "webhook אחד לשניהם" נכון לניתוב, שגוי לקרדנציאלס. הפתרון: הפרדה פיזית (דרך A).

### אילוץ Supabase: secrets ברמת פרויקט

Secrets ב-Supabase Edge Functions הם **ברמת הפרויקט** (משותפים לכל הפונקציות) — אי אפשר לתת לפונקציה השנייה `VERIFY_TOKEN` אחר תחת אותו שם. לכן ההפרדה נעשית ב**שמות env נפרדים** לכל channel, וכל entrypoint שולף את הסט שלו ומעביר אותו ל-handler המשותף.

## ארכיטקטורת ה-webhook החדשה (דרך A)

**חילוץ handler משותף:**
- מעבירים את גוף ה-`Deno.serve` (שורות 1549‑1845) + פונקציות העזר שברמת המודול מ-`whatsapp-webhook/index.ts` אל `_shared/whatsappWebhookHandler.ts`, שמייצא `handleWhatsappWebhook(req, config)`.
- `config` נושא את הערכים ה-channel-specific בלבד: `verifyToken`, `whatsappApiUrl`, `whatsappAccessToken`, `whatsappPhoneNumberId`, `hookmyappAgentName`. כל שאר הסודות (ANTHROPIC/SUPABASE/LANGFUSE/HANDOFF/MOOZ/OPENAI) נשארים env גלובלי שנקרא בתוך ה-handler — הם זהים לשני הסוכנים.

**שני entrypoints דקים:**
- `whatsapp-webhook/index.ts` (קיים) → קורא את שמות ה-env הלא-מסופתחים (הקיימים) ומעביר ל-handler עם `hookmyappAgentName: "affiliate_marketing"`. **התנהגות זהה להיום.**
- `whatsapp-webhook-dm/index.ts` (חדש) → קורא את שמות ה-env בסיומת `_DM` ומעביר ל-handler עם `hookmyappAgentName: "digital_marketing"`.

**Env חדשים (Supabase secrets) עבור ה-channel של תמיר:**
```
VERIFY_TOKEN_DM              = Du75v38bYEz2em5yQKPV-wBik9Ezj3nT
WHATSAPP_ACCESS_TOKEN_DM     = hmat_live_g1jFFOSPFQZ1sR_XDM386AHCvIVJrR0w
WHATSAPP_PHONE_NUMBER_ID_DM  = 1183645111502568
WHATSAPP_API_URL_DM          = https://gateway.hookmyapp.com/meta/v22.0
```
(פרטי ה-channel: WABA `2240831796748191`, HookMyApp channel `ch_WhZYrfGT`.)

**Deploy:** שתי הפונקציות עם `--no-verify-jwt`. ב-HookMyApp מפנים את ה-channel החדש ל-URL של `whatsapp-webhook-dm`.

**עיקרון:** כל instance הוא single-channel — בדיוק מה שהקוד הקיים מניח. דליפת קרדנציאלס בין המוצרים הופכת בלתי אפשרית מבנית. השליטה בדשבורד עדיין מאוחדת לפי `agent_id`.

## Mooz — פרטי סוג הפגישה של שיווק דיגיטלי

```
שם:          פגישת זום - בדיקת התאמה למסלול שיווק בריצ'ר
UUID:        d44fe2dc-f849-4468-af5c-a6bdf1e91087   ← זה הערך שנכנס ל-meeting_type_id
Numeric ID:  1
Slug:        richer_marketing
```

הערה: העמודה `agents.meeting_type_id` מחזיקה את צורת ה-**UUID** (אומת מול migrations 0030/0032 שהעבירו את סוכן השותפים מ-`'2'` ל-UUID). ה-Mooz client (`_shared/mooz.ts`) שולח `meeting_type_id=<UUID>` ל-api-gateway.

## רכיבי היישום

### 1. Migration — `supabase/migrations/0037_add_digital_marketing_agent.sql`

מוסיף שורת `agents` חדשה (idempotent, `ON CONFLICT (name) DO NOTHING` או `WHERE NOT EXISTS`):

| עמודה | ערך |
|---|---|
| `name` | `digital_marketing` (slug — חייב להתאים לתיקיית הפרומפטים) |
| `display_name` | `שיווק דיגיטלי` |
| `status` | `active` |
| `meeting_type_id` | `d44fe2dc-f849-4468-af5c-a6bdf1e91087` |
| `meeting_duration_minutes` | `30` |
| `quiet_hours_start_il` | `20` |
| `quiet_hours_end_il` | `8` |
| `operator_alert_phones` | `ARRAY['+972512310702','+972525563338']` (זהה לשותפים) |
| `first_touch_delay_minutes` | `40` |
| `whatsapp_phone_number_id` | `1183645111502568` (ידוע — קריטי לניתוב) |
| `whatsapp_number` | `+972557113830` (E.164 לתצוגה) |
| `first_touch_template_name` | `series_marketing_1` (טמפלייט Meta מאושר) |

**הערה**: `whatsapp_phone_number_id` ידוע ונכנס ל-migration. גם אם הוא היה `NULL` — אין סכנת ערבוב, כי ה-entrypoint של תמיר (`whatsapp-webhook-dm`) מנתב עם `hookmyappAgentName: "digital_marketing"` כ-fallback, ולא לשותפים.

יש לוודא שאין שדות `NOT NULL` נוספים בטבלת `agents` שאין להם default; אם יש — לספק ערך סביר ב-INSERT.

### 2. פרומפטים — `prompts/digital_marketing/`

```
prompts/digital_marketing/
├── _active.json                → {"main":"v1","memory_extractor":"v1"}
├── main/v1.md
└── memory_extractor/v1.md
```

**`main/v1.md`** — שלד `affiliate_marketing/main/v16.md` **בדיוק**, עם ההתאמות הבאות בלבד:

- **זהות (Identity & Role)**: "אתה תמיר, נציג של מסלול השיווק הדיגיטלי במכללת ריצ'ר." תשובת ה-"אתה בוט?" מותאמת לתמיר.
- **ידע מוצר** (מוזרק לאורך החימום/ההתנגדויות, מבוסס על הפאנל):
  - קורס דיגיטלי פרקטי, מעל 138 שעות תוכן, בעברית, מהטלפון/מחשב, בקצב אישי.
  - 4 מקצועות: קופירייטינג, כתיבת תוכן, ניהול קמפיינים (PPC), קידום אתרים (SEO).
  - 3 דרכים לייצר כסף: שיווק שותפים, מוצרי מידע דיגיטליים, מתן שירותי שיווק לעסקים.
  - AI עושה ~90% מהעבודה השחורה; לא צריך רקע טכני/תואר/ניסיון.
  - מנטור אישי (שמכניס לפחות 20K בחודש) + קבוצת ליווי 10–15 איש + לייב שבועי למשך 3 חודשים.
  - קהילה סגורה לכל החיים.
  - אחריות הצלחה: 70 יום ליווי, ואם לא — עוד 70 יום ליווי ללא עלות.
- **התנגדויות נפוצות** (מותאמות): אין ניסיון / לא טכנולוגי / "זה סקאם?" / אין זמן / יקר / "אני כבר יודע שיווק".
- **סיפור רקע** להזדהות: סיפורו של שלו יפרח (חובות ~250K, בלי תעודת בגרות, כישלונות עסקיים, יישום מהיר ששינה הכל) — במקום סיפור האחים סיטון.
- **כל השאר זהה מילה במילה** ל-v16: מנוע החימום (רמת מודעות → חלום → כאב → ודאות/מאמץ → אמפתי-קצר), 5 השאלות, השער (כאב+חלום+3 מ-5), גבולות קשיחים (מחיר/הכנסה/המצאת עובדות), פרשנות הטמפלייט הראשון, Cost & Pricing, כלי Mooz (`list_available_slots`/`book_meeting`) וזרימת הקביעה, פולאפים, חלון 24 שעות, ופורמט האישור אחרי `book_meeting`.

**`memory_extractor/v1.md`** — העתק של `affiliate_marketing/memory_extractor/v2.md` (כבר product-agnostic — "Richer College lead"). אין שינוי בשדות (q1_age, q2_motivation, q3_dream_change, q4_blocker, q5_urgency, q6_investment, q7_email, conversation_summary, primary_objection, red_flags, notes_for_advisor). ניתן להתאים את שורת ה-`notes` בלבד.

### 3. סנכרון פרומפטים

הרצת `prompts:sync` (`scripts/prompts/sync.ts`) — מזהה את התיקייה החדשה לפי `agent.name`, מכניס שורות ל-`public.prompts` על `(agent_id, prompt_type, version)`, ומסמן `is_active=true` לפי `_active.json`. הסנכרון per-agent ואטומי — **לא נוגע בפרומפטים של השותפים**.

תלות: שורת ה-agent (`digital_marketing`) חייבת להתקיים ב-DB **לפני** ההרצה (ה-sync ממפה שם→id). כלומר: migration 0037 רץ קודם, ואז sync.

### 4. תיקון הפרדה הרמטית — `getConversationById`

**קובץ**: `src/lib/conversations.ts:60` — הוספת פרמטר `expectedAgentId` אופציונלי וסינון `.eq("agent_id", expectedAgentId)` כשהוא ניתן.

**קובץ**: `src/components/conversations/ConversationDetail.tsx` — קריאה עם `activeAgent?.id`, ובדיקת בעלות לפני render (אם `conversation.agent_id !== activeAgent?.id` → הודעת "אין הרשאה"/"לא נמצאה").

**טסט**: `src/lib/conversation-status.test.ts` הוא מקום קיים לטסטים; להוסיף/לעדכן טסט ל-`getConversationById` (או קובץ טסט ל-conversations) שמאמת שקריאה עם `expectedAgentId` שגוי מחזירה `null`.

זהו התיקון היחיד ל-frontend. הפרדת התצוגות עצמה (שיחות/לידים/אנליטיקה/KPIs/פרומפטים/brain/הגדרות) כבר עובדת דרך ה-AgentSelector וסינון `agent_id` בכל שאילתה תפעולית — אומת בקוד.

## אימות (Verification)

- **DB**: אחרי migration + sync — שאילתה שמאמתת קיום שורת agent `digital_marketing` + 2 שורות `prompts` (`main@v1`, `memory_extractor@v1`) עם `is_active=true`.
- **Typecheck + lint + build + tests** עוברים (CI gate).
- **טסט הפרדה**: `getConversationById` עם agent שגוי מחזיר `null`.
- **בדיקה ידנית בדשבורד** (אחרי חיבור המספר): בחירת "שיווק דיגיטלי" ב-AgentSelector מציגה רק נתוני תמיר; מעבר לשותפים מציג רק שלהם.
- **End-to-end** (אחרי go-live): הודעת inbound למספר החדש מנותבת לתמיר (לפי `whatsapp_phone_number_id`) ומריצה את הפרומפט הנכון — לניטור ב-Langfuse.

## פעולות ידניות של המשתמש (מחוץ לקוד)

1. הזנת `whatsapp_number` + `whatsapp_phone_number_id` האמיתיים לשורת ה-agent (או ב-migration אם ידועים בזמן היישום).
2. הזנת `first_touch_template_name` (טמפלייט Meta מאושר) כשיאושר.
3. חיבור המספר החדש ב-HookMyApp לאותו webhook.
4. וידוא ש-scenario ה-handoff ב-Make.com מסתעף לפי שם הסוכן (הליד של שיווק דיגיטלי מגיע ליועצים הנכונים — אותם יועצים, אבל יש לוודא שאין הנחה קשיחה של `affiliate_marketing` ב-scenario).

## מה במפורש לא עושים (YAGNI / גבולות)

- **לא** יוצרים טבלת `user_agents` ו**לא** משנים RLS (אופציה א').
- **לא** משנים סכמת `lead_memory` / `messages` / funnel / handoff.
- **לא** משנים את התנהגות ה-webhook של השותפים — החילוץ ל-handler משותף הוא behavior-preserving; ה-entrypoint הקיים ממשיך לקרוא את אותם env ולפעול בדיוק אותו דבר.
- **לא** יוצרים edge function חדש לכל דבר אחר (memory/handoff/dispatch) — רק ה-webhook מקבל instance שני.
- **לא** נוגעים בפרומפטים או בקונפיג של סוכן השותפים.
- **לא** יוצרים סכמה/טבלאות נפרדות ל-Supabase — הפרדה לוגית לפי `agent_id` היא ה-pattern הנכון (החלטה ארכיטקטונית #6, תשתית משותפת).

## סדר יישום מוצע

1. **חילוץ handler משותף** — `_shared/whatsappWebhookHandler.ts` מייצא `handleWhatsappWebhook(req, config)`; `whatsapp-webhook/index.ts` הופך ל-entrypoint דק (behavior-preserving). אימות: typecheck + הטסטים הקיימים עוברים, ההתנהגות של השותפים זהה.
2. **entrypoint שני** — `whatsapp-webhook-dm/index.ts` שקורא env בסיומת `_DM` עם `hookmyappAgentName: "digital_marketing"`.
3. **Migration 0037** — שורת agent `digital_marketing` (עם `whatsapp_phone_number_id = 1183645111502568`).
4. **תיקיית פרומפטים** + `_active.json` (main v1 מבוסס v16 + memory_extractor v1).
5. **הרצת migration ל-DB + `prompts:sync`**.
6. **תיקון הפרדה** — `getConversationById` + `ConversationDetail` + טסט.
7. **אימות** — typecheck/lint/build/tests + בדיקת DB (שורת agent + 2 שורות prompts active).
8. **(ידני, המשתמש)** — הגדרת secrets `*_DM` ב-Supabase, deploy שתי הפונקציות עם `--no-verify-jwt`, הפניית ה-channel החדש ב-HookMyApp ל-`whatsapp-webhook-dm`, הזנת `first_touch_template_name` כשיאושר, בדיקת הסתעפות Make.com.
