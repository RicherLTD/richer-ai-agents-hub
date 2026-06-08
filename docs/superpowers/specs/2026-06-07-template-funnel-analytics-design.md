# אפיון: משפך לפי טמפלייט (Template Funnel Analytics)

> תאריך: 2026-06-07 · סטטוס: מאושר לביצוע · סוכן ראשון: `affiliate_marketing`

## Context — למה אנחנו עושים את זה

האופרטור (אדמין) צריך למדוד את ביצועי הפנייה היזומה בוואטסאפ כדי לשפר את המערכת.
היום הנתונים מפוזרים ולא מדויקים: מדידת "זום נקבע" סופרת את כולם יחד — גם מי שהסוכן קבע
לו בצ'אט וגם מי שקבע לעצמו עצמאית דרך דף Mooz — ולכן אחוז ההמרה "שיחה→זום" של הסוכן מעוות.
בנוסף אין מקור-אמת אחד למשפך פר־טמפלייט. זה מה שגורם לתחושת ה"בלאגן".

המטרה: תצוגה אחת, אמינה, מסוננת לפי תאריך, שמראה לכל טמפלייט את המשפך המלא והנכון:

> **נשלח → נמסר → נקרא → נענו → קבע זום (ע"י הסוכן)**

עם שיעורי המרה, כך שנוכל להשוות בין טמפלייטים (A/B): איזה טמפלייט מביא יותר שיחות וזומים.

## מטרות

1. משפך פר `template_name` עם המספרים: נשלח / נמסר / נקרא / נענו / קבע-זום-ע"י-הסוכן, + שיעורי המרה.
2. **הפרדת ייחוס הזום**: לספור באחוז ההמרה **רק זום שהסוכן קבע בעצמו**. "קבע עצמאית" ו"הסכים+הועבר ליועץ" מוצגים בשורות נפרדות (שקיפות, בלי להסתיר).
3. **לכידת מסירה/קריאה**: הדאטה כבר מגיע ל-webhook אבל רק נרשם ל-logs — נשמור אותו כדי לבנות את שלבי "נמסר/נקרא".
4. ספירת **שליחות שנכשלו** פר טמפלייט (אות אמון).
5. **סינון לפי טווח תאריכים** (semantics של קוהורט — ראה למטה).
6. **תאימות עתידית**: טמפלייט re-engagement עתידי ייכנס למדידה אוטומטית (עוד `template_name`).

## לא בתחום (Non-goals)

- בניית פנייה חוזרת (re-engagement) עכשיו — רק תאימות.
- זמן עד תגובה / זמן עד זום — שלב ב'.
- Backfill היסטורי של ייחוס זום (אי אפשר לשחזר — לא נשמר). מסירה/קריאה היסטוריים ניתנים לשחזור מ-`error_logs` אך אופציונלי בלבד.

## ארכיטקטורה — שלושה workstreams

הפיצ'ר מורכב משלושה חלקים מקושרים. סדר הביצוע למטה בונה אותם משכבה לשכבה.

### A. ייחוס הזום (`zoom_booked_by`) — DB + edge

היום 3 מסלולים כותבים `current_tag='zoom_scheduled'` בלי שום שדה שמבדיל ביניהם:

| מסלול | קוד | ערך `zoom_booked_by` |
|---|---|---|
| הבוט קרא ל-`book_meeting` בצ'אט | `moozTools.ts` `updateConversationOnBooking` | `agent` |
| Mooz webhook `booking.created` עם חתימת הבוט בהערות | `mooz-webhook/index.ts` `handleCreatedOrRescheduled` | `agent` |
| Mooz webhook `booking.created` **בלי** חתימה (הליד קבע לבד) | אותו handler | `self` (רק אם השדה null) |
| `shouldTriggerZoomHandoff` — הסכמה+אימייל, בלי קביעה בפועל | `extractMemory.ts` | `consent_handoff` (רק אם null) |

- **שדה חדש**: `conversations.zoom_booked_by text` (nullable; `agent` / `self` / `consent_handoff` / null=היסטורי).
- **הסימן שמבדיל**: הבוט חותם ב-Mooz `notes: "WhatsApp lead — conversation {id}"` (`moozTools.ts:327`). מי שקובע לבד — אין חתימה.
- **כלל קדימות — לעולם לא מורידים דרגה**: `agent` > `consent_handoff` > `self`.
  - מסלול הבוט (`moozTools`) קובע `agent` **ישירות במקור** — לא מסתמך על ה-webhook (חסין).
  - ה-webhook קובע `agent` אם יש חתימה; אחרת `self` רק כאשר השדה עדיין null (`update ... where zoom_booked_by is null`).
  - `extractMemory` קובע `consent_handoff` רק כאשר השדה null (לא דורס `agent`).
- **מדד ההמרה** סופר רק `zoom_booked_by='agent'`.

### B. לכידת מסירה/קריאה — DB + edge

`whatsapp-webhook` כבר מריץ `ingestDeliveryStatus(status)` שמוצא את ההודעה לפי `meta_message_id`,
אבל היום רק כותב ל-`error_logs` (info/error) ולא שומר סטטוס.

- **שדות חדשים**: `scheduled_messages.delivered_at timestamptz`, `read_at timestamptz` (nullable).
- **`meta_message_id` כבר קיים** על `scheduled_messages` (migration 0023) ו-`messages` (UNIQUE, migration 0007) — הקישור מיידי.
- **שינוי ב-`ingestDeliveryStatus`**: בנוסף ללוג, לעדכן את שורת ה-`scheduled_messages` לפי ה-wamid:
  - status `delivered`/`read` → `delivered_at = coalesce(delivered_at, ts)`.
  - status `read` → `read_at = coalesce(read_at, ts)`.
  - (העדכון על `scheduled_messages` תופס רק שליחות טמפלייט — תשובות הסוכן אין להן שורה שם, אז ה-scope טבעי.)
- במשפך: **נמסר** = `delivered_at` או `read_at` לא-null (read גורר delivered). **נקרא** = `read_at` לא-null.

### C. משפך התצוגה — frontend

- **קובץ חדש: `src/lib/template-funnel.ts`** — query + פונקציית aggregation טהורה (כמו `insights.ts`/`kpis.ts`).
- **שתי שאילתות נפרדות** (לא embed לפי FK): (1) `scheduled_messages` (template_name, status, sent_at, created_at, delivered_at, read_at, lead_phone), (2) `conversations` (lead_phone, last_inbound_at, current_tag, zoom_booked_by). שתיהן `.eq("agent_id", agentId)`, `limit(2000)`.
- **חיבור לפי טלפון מנורמל (ספרות בלבד), לא לפי `conversation_id`** ⚠️: בפרוד התגלה שהשליחה שומרת `+972…` וה-webhook הנכנס שומר `972…`, כך שלכל ליד נוצרות **שתי שורות conversation** — קונכייה ריקה (שאליה מקושרת השליחה) ושורת התגובה (עם last_inbound_at/זום). JOIN לפי FK היה מחזיר answered=0. התאמה לפי ספרות בלבד מאחדת אותן. (אומת: 0 התאמות exact מול 217 מנורמל על 1092 שליחות.) באג ה-conversations הכפולות הוא רחב יותר — תועד כ-task נפרד לתיקון במקור.
- **legacyZoom**: זום היסטורי (`current_tag='zoom_scheduled'` אבל `zoom_booked_by IS NULL`) מוצג בשורה נפרדת כדי לא לאבד 45 הזומים ההיסטוריים שעדיין לא מסווגים. precedence per-person: agent > self > consent_handoff > legacy.
- **semantics של קוהורט**: טווח התאריכים מסנן `sent_at` (מי נכנס לקוהורט). התוצאות (נמסר/נקרא/נענו/זום) נספרות על אותם אנשים **ללא תלות במתי קרו**. שליחות שנכשלו (`status='failed'`, אין להן `sent_at`) — חלון לפי `created_at`. כל הסינון בתוך הפונקציה הטהורה (לא ב-SQL), כדי לטפל ב-failed וב-testability.
- ספירת **אנשים ייחודיים** פר טמפלייט: Set לפי **טלפון מנורמל** (ספרות בלבד).
- **טיפוס פלט**:

```ts
export interface TemplateFunnelRow {
  templateName: string;
  sent: number;
  delivered: number;
  read: number;
  answered: number;          // מתוך sent: last_inbound_at != null
  agentZoom: number;         // מתוך sent: zoom_booked_by==='agent'  ← מדד ההמרה
  selfZoom: number;          // נפרד: zoom_booked_by==='self'
  consentHandoff: number;    // נפרד: zoom_booked_by==='consent_handoff'
  failed: number;
  // שיעורים (pct, עיגול לעשירית, חלוקה ב-0 → 0):
  deliveredRatePct: number;  // delivered / sent
  readRatePct: number;       // read / sent
  answeredRatePct: number;   // answered / sent
  agentZoomPerAnsweredPct: number; // agentZoom / answered  ← "שיחה→זום של הסוכן"
  agentZoomPerSentPct: number;     // agentZoom / sent
}
```

- **react-query key**: `["insights","template-funnel",agentId,range.from,range.to]`.
- **תצוגה**: `src/components/analytics/TemplateFunnelCard.tsx` בסגנון `InsightsCards.tsx` — `DateRangeFilter` בראש (state מקומי `{preset, range}`, ברירת מחדל `"all"`), שורה לכל טמפלייט עם המשפך + שיעורים, צ'יפים נפרדים ל"קבע עצמאית" / "הסכים+הועבר" / "נכשלו", פסי התקדמות דקים (בלי recharts). עיגון: טאב "ניתוחים מתקדמים" ב-`Index.tsx` (כבר admin-gated) + `Analytics.tsx` עם guard מפורש `useAuth().isAdmin`.

## קבצים

**חדשים:**
- `supabase/migrations/0033_conversation_zoom_booked_by.sql`
- `supabase/migrations/0034_scheduled_messages_delivery_status.sql`
- `src/lib/template-funnel.ts` + `src/lib/template-funnel.test.ts`
- `src/components/analytics/TemplateFunnelCard.tsx`

**שינוי (edge — flow חי, שינויים אדיטיביים בלבד):**
- `supabase/functions/_shared/moozTools.ts` — `zoom_booked_by='agent'` ב-update (+ test)
- `supabase/functions/mooz-webhook/index.ts` — `agent`/`self` לפי חתימת notes, עם never-downgrade
- `supabase/functions/_shared/extractMemory.ts` — `consent_handoff` כאשר null (+ test)
- `supabase/functions/whatsapp-webhook/index.ts` — `ingestDeliveryStatus` שומר delivered/read ל-scheduled_messages
- `src/types/database.ts` — regen אחרי ה-migrations
- `src/pages/Index.tsx`, `src/pages/Analytics.tsx` — עיגון

**ללא שינוי:** RLS על `scheduled_messages` כבר מאפשר קריאת אדמין (0023:72-74, אומת).

## סדר ביצוע

1. **Migrations** 0033 + 0034; `bun run db:apply`; `bun run db:types` (regen `database.ts`).
2. **Edge — ייחוס זום**: 3 האתרים + כלל הקדימות; Deno tests ל-`moozTools`/`extractMemory`.
3. **Edge — מסירה/קריאה**: `ingestDeliveryStatus` שומר ל-`scheduled_messages`; test.
4. **Frontend — משפך**: `template-funnel.ts` (TDD) → `TemplateFunnelCard.tsx` → עיגון בשני הדפים.
5. **אימות** (למטה). פריסת edge בסוף, באישור המשתמש.

## תוכנית בדיקות

**`src/lib/template-funnel.test.ts`** (vitest, פונקציה טהורה; helper `row(partial)` + `NOW` קבוע):
1. קלט ריק → `[]`.
2. טמפלייט אחד, כולם נשלחו, אף אחד לא ענה → אפסים.
3. כמה טמפלייטים → קיבוץ + מיון לפי `sent` יורד.
4. "נענה" לפי `last_inbound_at`; embed `null` נספר כ-sent ולא answered.
5. semantics של קוהורט: תוצאה בעתיד עדיין נספרת (לא מסוננת לפי תאריך).
6. **ייחוס זום**: `agent` נספר ב-`agentZoom`; `self`→`selfZoom`; `consent_handoff`→`consentHandoff`; null+tag=zoom → לא נספר ב-agent (היסטורי). מונוטוניות נשמרת.
7. **נמסר/נקרא**: `read_at` גורר delivered; ספירות נכונות; read ≤ delivered ≤ sent.
8. סינון `sent_at` לקוהורט; גבולות כוללים; null=ללא גבול.
9. אנשים ייחודיים: שתי שורות לאותו `conversation_id` = אדם אחד; fallback ל-`lead_phone`.
10. failed (`status='failed'`, חלון `created_at`) deduped; `pending`/`cancelled` מתעלמים.
11. עיגול שיעורים: 1/3 → `33.3`; חלוקה ב-0 → `0`.

**Deno tests (`_shared/*.test.ts`):**
- `moozTools`: הזמנה מוצלחת קובעת `zoom_booked_by='agent'`.
- `extractMemory`: handoff קובע `consent_handoff` כאשר null; לא דורס `agent`.
- מסירה/קריאה: עדכון לפי wamid; `read` קודם → delivered+read; אידמפוטנטי (coalesce).

## אימות (Verification)

- `bun run lint` · `bun run test` (vitest + Deno) · `bun run build` (type-check; strict, בלי `any`).
- ידני: `bun run dev`, אדמין → "ניתוחים מתקדמים" + `/analytics` → לוודא שה-card מציג `affiliate_first_touch`, החלפת פריסטים מרעננת, ושאינו מוצג ל-non-admin.
- בדיקת שפיות: `agentZoom + selfZoom + consentHandoff` (+ היסטורי) ≈ סך `current_tag='zoom_scheduled'` הקיים — פער = באג סיווג.
- edge: בדיקה ב-staging/conversation אמיתי שהזמנת בוט מסמנת `agent`, ושהזמנה עצמאית מסמנת `self`; ש-status callback מעדכן `delivered_at`/`read_at`.
- פריסה (באישור המשתמש): `bunx supabase functions deploy mooz-webhook whatsapp-webhook --no-verify-jwt --project-ref juoglkqtmjsziieqgmhf` (ל-whatsapp-webhook חובה `--no-verify-jwt`).

## סיכונים

- **flow חי (לידים = אנשים אמיתיים)**: שינויי ה-edge אדיטיביים (שדות חדשים + סימון), עם טסטים. לא נוגעים בלוגיקת השליחה/התשובה עצמה. פריסה הפיכה ובאישור המשתמש.
- **ייחוס היסטורי**: זומים ישנים יישארו `zoom_booked_by=null` ("לא מסווג") — אי אפשר לשחזר. הסיווג מצטבר קדימה.
- **קדימות/race על `zoom_booked_by`**: כלל never-downgrade דרך `update ... where zoom_booked_by is null` (ו-`agent` ישיר במקור), כך שהזמנת בוט לא תסומן בטעות `self` גם אם ה-webhook מגיע אחריה בלי חתימה (למשל Make.com משלים קביעה אחרי consent_handoff).
- **טמפלייט אחד היום**: התנהגות multi-template נבדקת ב-unit tests עד שייווצר `template_name` שני בפרוד.
