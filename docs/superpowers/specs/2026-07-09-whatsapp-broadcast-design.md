# אפיון: דיוור WhatsApp בתפוצה רחבה (Broadcast)

> **תאריך**: 2026-07-09
> **סטטוס**: אפיון לאישור
> **הקשר**: פיצ'ר חדש על גבי תשתית `scheduled_messages` + `dispatch-scheduled-templates` הקיימת.

---

## 1. מטרה

לאפשר לאופרטור (admin) לשלוח הודעת template של WhatsApp בתפוצה רחבה — מיידית או מתוזמנת — לקהל שמורכב מלידים קיימים במערכת ו/או מרשימת טלפונים שמועלית כ-CSV, כשהבחירה נעשית **לפי מוצר (=סוכן)**, ותוך **סינון מוחלט של מי שביקש הסרה** גם אם הועלה דרך ה-CSV.

### דרישות מפורשות מהלקוח
1. שליחה ללידים שכבר רשומים במערכת.
2. העלאת CSV ושליחה גם למי שעדיין לא רשום.
3. בחירת הדיוור לפי סוג מוצר.
4. **קריטי**: מי שביקש הסרה לא יקבל דיוור — גם אם הטלפון שלו נמצא ב-CSV.

---

## 2. עקרון מנחה

לא בונים מנוע שליחה חדש. ה-dispatcher הקיים (`dispatch-scheduled-templates`, cron כל דקה) כבר מטפל בשליחה, quiet hours, ניתוב פר-ערוץ, atomic claim, retries והתראות אופרטור. הפיצ'ר מוסיף רק:
- **דלת כניסה** אחת (edge function `broadcast-enqueue`) שמזריקה שורות לתור.
- **מסך** לניהול הדיוור.
- **קיבוץ** (`broadcast_id`) כדי לראות ולנהל דיוור כיחידה.
- **רישום templates מאושרים** (`broadcast_templates`) כדי למנוע טעויות הקלדה.
- **בדיקת opt-out שנייה** ב-dispatcher (הגנה על הדרישה הקריטית).

---

## 3. הגדרות מוצר / סוכן

דיוור שייך תמיד ל**סוכן אחד**. בחירת הסוכן קובעת בו-זמנית:
- את **המוצר** (affiliate = סיטון, digital = תמיר).
- את **ערוץ ה-WhatsApp** (הקרדנציאלס שממנו נשלח, per-channel routing קיים ב-dispatcher).
- את מאגר ה-**templates המאושרים** הזמינים לבחירה.
- את **רשימת הלידים הקיימים** הרלוונטית לסינון.

---

## 4. מודל נתונים

### 4.1 טבלה חדשה: `broadcasts`

כל דיוור כיחידה אחת (campaign/batch).

| עמודה | טיפוס | הערות |
|---|---|---|
| `id` | uuid PK, default `gen_random_uuid()` | |
| `agent_id` | uuid NOT NULL, FK → `agents(id)` ON DELETE CASCADE | הסוכן=המוצר=הערוץ |
| `template_name` | text NOT NULL | שם ה-template המאושר ב-Meta |
| `template_language` | text NOT NULL DEFAULT `'he'` | קוד שפה |
| `template_variables` | jsonb NOT NULL DEFAULT `'[]'` | ערכי משתנים ברירת-מחדל לדיוור (ordered) |
| `title` | text NOT NULL | תווית שהאופרטור נותן ("דיוור מחזור יולי") |
| `status` | enum `broadcast_status_enum` NOT NULL DEFAULT `'queued'` | ראה 4.3 |
| `scheduled_for` | timestamptz NULL | `null` = מיידי (נכתב כ-`now()` בשורות התור) |
| `total_recipients` | int NOT NULL DEFAULT 0 | כמה שורות נכנסו בפועל לתור |
| `suppressed_count` | int NOT NULL DEFAULT 0 | כמה סוננו (סה"כ) |
| `suppressed_breakdown` | jsonb NOT NULL DEFAULT `'{}'` | פירוט: `{opt_out, zoom_scheduled, underage, requires_human, duplicate, invalid_phone}` |
| `created_by` | uuid NULL, FK → `app_users(id)` | מי יצר |
| `created_at` | timestamptz NOT NULL DEFAULT `now()` | |
| `updated_at` | timestamptz NOT NULL DEFAULT `now()` | trigger |

**אינדקסים**: `(agent_id, created_at DESC)` לרשימת הדיוורים.

**RLS**: קריאה + כתיבה = admin בלבד (עקבי עם migration 0018). ה-edge function רץ עם service_role ועוקף.

### 4.2 תוספת ל-`scheduled_messages`

עמודה חדשה: `broadcast_id` uuid NULL, FK → `broadcasts(id)` ON DELETE SET NULL.
- שורות דיוור מצביעות על ה-broadcast.
- הזרימה הקיימת (`lead-register`) משאירה `null` — אין שינוי התנהגות.
- אינדקס: `(broadcast_id)` לצורך ספירת סטטוס פר-דיוור וביטול מרוכז.

### 4.3 טבלה חדשה: `broadcast_templates` (רישום templates מאושרים)

מונע טעות הקלדה בשם template (שגורמת ל-Meta לדחות את כל הדיוור בשקט).

| עמודה | טיפוס | הערות |
|---|---|---|
| `id` | uuid PK | |
| `agent_id` | uuid NOT NULL, FK → `agents(id)` ON DELETE CASCADE | |
| `name` | text NOT NULL | שם ה-template כפי שאושר ב-Meta |
| `language` | text NOT NULL DEFAULT `'he'` | |
| `label` | text NOT NULL | תווית קריאה לאדם ל-dropdown |
| `variable_count` | int NOT NULL DEFAULT 0 | כמה `{{n}}` יש בגוף — לבניית שדות הזנה ב-UI |
| `body_preview` | text NULL | טקסט הגוף לתצוגה מקדימה (מוזן ידנית, לא נמשך מ-Meta) |
| `is_active` | boolean NOT NULL DEFAULT true | להסתרה מבלי למחוק |
| `created_at` | timestamptz NOT NULL DEFAULT `now()` | |

**UNIQUE** על `(agent_id, name, language)`.
**RLS**: admin בלבד.
**אכלוס ראשוני**: ניתן להזין דרך SQL/migration; UI לניהול (CRUD) הוא scope עתידי אופציונלי — לא חוסם את v1.

### 4.4 enum חדש

```sql
CREATE TYPE broadcast_status_enum AS ENUM ('draft', 'queued', 'sending', 'completed', 'cancelled');
```

**מעברי סטטוס**:
- `queued` — נוצר, שורות בתור, טרם נשלחו (או מתוזמן לעתיד).
- `sending` — לפחות שורה אחת נשלחה, יש עוד pending.
- `completed` — אין שורות pending (כולן sent/failed).
- `cancelled` — האופרטור ביטל; שורות pending סומנו `cancelled` ב-`scheduled_messages`.
- `draft` — שמור לעתיד (טיוטה לפני שליחה); v1 לא יוצר drafts.

> הערה: עדכון סטטוס ה-broadcast מ-`queued`→`sending`→`completed` יחושב לפי מצב השורות. ב-v1 נחשב אותו on-read (query aggregation) בדף הרשימה כדי לא לסבך את ה-dispatcher. עמודת `status` תשמש בעיקר ל-`cancelled` (state מפורש שהאופרטור קובע).

---

## 5. זרימת ה-Enqueue (edge function חדש: `broadcast-enqueue`)

**טריגר**: POST מהדשבורד. **Auth**: `requireAdmin` (JWT). רץ עם service_role (עוקף RLS, ניגש ל-`opt_outs`).

**Body (JSON)**:
```jsonc
{
  "agent_id": "uuid",
  "template_name": "string",       // חייב להתאים לרשומה ב-broadcast_templates של הסוכן
  "template_language": "he",
  "template_variables": ["..."],   // ברירת מחדל לכל הנמענים (אופציונלי)
  "title": "דיוור מחזור יולי",
  "scheduled_for": null,            // null = מיידי; אחרת ISO timestamp
  "existing_lead_conversation_ids": ["uuid", ...],  // לידים קיימים שנבחרו
  "csv_recipients": [               // נמענים מ-CSV (כבר נפרס בדפדפן)
    { "phone": "050...", "name": "...", "variables": ["..."] }
  ]
}
```

**שלבים**:

1. **ולידציה**:
   - `agent_id` קיים ולא `is_paused`? (אם paused — נחסום עם הודעה ברורה).
   - `template_name`+`language` קיימים ב-`broadcast_templates` עבור הסוכן ו-`is_active`. אחרת → 400.
   - חייב להיות לפחות מקור קהל אחד לא-ריק.

2. **בניית קבוצת הנמענים** (איחוד):
   - לידים קיימים: שליפת `lead_phone` (+ `conversation_id`) לפי ה-IDs שנבחרו, מסונן ל-`agent_id`.
   - CSV: הרשומות מה-body.

3. **נרמול טלפונים**: כל טלפון → פורמט קנוני E.164 ישראלי, באמצעות לוגיקת הנרמול הקיימת (אותה שב-webhook). טלפון לא תקין → נספר ב-`invalid_phone`, מסונן החוצה.

4. **Dedupe** לפי טלפון קנוני (נספר ב-`duplicate`).

5. **Suppression pass (server-side)**:
   - טלפון ב-`opt_outs` → החוצה (`opt_out`). **זו הצליבה הקריטית מול ה-CSV.**
   - שיחה קיימת של אותו סוכן עם `current_tag`/`status` חוסם (`zoom_scheduled` / `opted_out` / `underage` / `requires_human`) → החוצה (נספר בקטגוריה המתאימה).

6. **net-new מ-CSV**: טלפון שאין לו שיחה תחת הסוכן → upsert `conversation` תחת הסוכן (כדי שיהיה `conversation_id` ל-tracking ושתשובת הליד תנותב נכון). משתמשים ב-upsert הקיים `UNIQUE(agent_id, lead_phone)`. לא דורסים סטטוס של שיחה קיימת.

7. **INSERT**:
   - שורת `broadcasts` (סטטוס `queued`, `total_recipients`, `suppressed_count`, `suppressed_breakdown`).
   - N שורות `scheduled_messages`: `agent_id`, `conversation_id`, `lead_phone` (קנוני), `lead_name`, `template_name`, `template_language`, `template_variables` (פר-נמען אם הגיע ב-CSV, אחרת ברירת המחדל של הדיוור), `scheduled_for` (=הזמן שנבחר או `now()`), `status='pending'`, `broadcast_id`.

8. **תגובה**: סיכום JSON — `{ broadcast_id, total_recipients, suppressed_count, suppressed_breakdown }`.

**אידמפוטנטיות**: הגנה מפני double-submit — אם קיים broadcast עם אותו `(agent_id, title, created_by)` שנוצר ב-60 השניות האחרונות, מחזירים את הקיים במקום ליצור חדש.

**נפח**: הכנסת השורות ב-batch inserts (chunks של ~500). אין תקרת נמענים קשיחה ב-v1, אבל ראה 8 (קצב).

---

## 6. שינוי ב-dispatcher (הגנה קריטית שנייה)

`dispatch-scheduled-templates` / פונקציית ה-claim (`claim_scheduled_messages`):
- **תוספת**: לפני שליחה, לסנן שורות שה-`lead_phone` שלהן נמצא כעת ב-`opt_outs`. שורה כזו מסומנת `cancelled` (לא `failed`) עם `last_error='opted_out_before_send'`.

**למה**: מישהו יכול לבקש הסרה *אחרי* ה-enqueue אבל *לפני* השליחה. הבדיקה בזמן השליחה סוגרת את חלון הזמן הזה. עדיף לממש כחלק מ-`claim_scheduled_messages` (SQL, atomic) — join ל-`opt_outs` שמחריג/מבטל שורות opted-out. זו ההגנה שהופכת את דרישת ההסרה ל-bulletproof.

בדיקת ה-tags החוסמים (`zoom_scheduled` וכו') ב-dispatcher היא nice-to-have; לפחות `opt_outs` חובה. quiet hours כבר מטופל.

---

## 7. UI (דף חדש: "דיוור", admin בלבד)

**`src/pages/Broadcasts.tsx`** + entry ב-sidebar (מאחורי `AdminOnly`).

### 7.1 Composer (`BroadcastComposer`)
צעדים:
1. **בחירת סוכן** — dropdown מ-`agents` (לא paused).
2. **בחירת template** — dropdown מ-`broadcast_templates` של הסוכן; מציג `label` + `body_preview`. אם `variable_count > 0` → שדות הזנת משתני ברירת-מחדל.
3. **קהל**:
   - **לידים קיימים** — טבלה מסוננת (funnel stage / tag / חיפוש) עם checkboxes; מנצל את קומפוננטת ה-leads הקיימת ככל האפשר.
   - **CSV** — העלאה + פירוס בדפדפן (עמודות: `phone`, `name`, ו-`var1..varN` אופציונלי). הצגת שגיאות פירוס (טלפון לא תקין / כפילויות) לפני שליחה.
4. **תזמון** — רדיו "עכשיו" / "בזמן מסוים" + date-time picker.
5. **תצוגה מקדימה + שליחה** — קורא ל-`broadcast-enqueue`, מציג: *"312 ישלחו · 47 סוננו (28 הסרה, 12 זום, 7 טיפול אנושי)"*, ומאשר.

### 7.2 רשימת דיוורים (`BroadcastList`)
- כל הדיוורים של הסוכן הפעיל: title, template, מתוזמן/נשלח, ספירות (pending/sent/failed מחושב מ-`scheduled_messages`), סטטוס.
- פעולת **ביטול** לדיוור עם שורות pending → מסמן שורות pending כ-`cancelled`, ו-broadcast כ-`cancelled`.

### 7.3 CSV
נפרס **client-side** ל-JSON ונשלח ל-edge function (שמאמת שוב server-side). מאפשר תצוגה מקדימה בלי טיפול multipart ב-Deno.

---

## 8. שיקולים ואזהרות

1. **קצב שליחה / Meta throttling**: ה-dispatcher שולף `limit` שורות פר-tick (כל דקה). לפיילוט (50 לידים) — לא רלוונטי. ל-2,000+ — הקצב הטבעי של הcron מפזר את השליחה על פני מספר דקות. אם צריך פיזור מהיר יותר / איטי יותר בעתיד — פרמטר על ה-broadcast (scope עתידי, YAGNI ל-v1).
2. **חוק הספאם**: הפיצ'ר מיועד ללידים שנרשמו עם הסכמה (landing page). דיוור לרשימה קרה חיצונית = חשיפה משפטית — באחריות האופרטור. אין gate טכני על מקור ההסכמה ב-v1, אבל ה-opt-out נאכף בכל מקרה.
3. **פורמט טלפון**: נרמול חובה (סקציה 5.3) כדי למנוע שיחות כפולות וכשל בצליבת opt-out.
4. **template לא מאושר**: נמנע ע"י `broadcast_templates` (רק שמות רשומים נבחרים). אם Meta דחתה בכל זאת (למשל template נפסל) → השורות נכשלות דרך מנגנון ה-retry/DLQ הקיים ומסומנות `failed`.
5. **race על opt-out**: נסגר ע"י הבדיקה הכפולה (enqueue + send).

---

## 9. מה בונים — סיכום רכיבים

| רכיב | סוג | חדש/קיים |
|---|---|---|
| `broadcasts` table | migration | חדש |
| `broadcast_templates` table | migration | חדש |
| `scheduled_messages.broadcast_id` | migration (ALTER) | תוספת |
| `broadcast_status_enum` | migration | חדש |
| `claim_scheduled_messages` opt-out filter | migration (עדכון function) | עדכון |
| `broadcast-enqueue` | edge function | חדש |
| נרמול טלפון | shared util | קיים (שימוש חוזר) |
| `dispatch-scheduled-templates` | edge function | ללא שינוי מהותי (הסינון ב-RPC) |
| `src/pages/Broadcasts.tsx` + קומפוננטות | UI | חדש |
| `src/lib/broadcasts.ts` (queries) | UI lib | חדש |
| טסטים: נרמול, suppression, פירוס CSV, claim opt-out filter | tests | חדש |

---

## 10. מה מפורשות מחוץ ל-scope (v1)

- UI לניהול `broadcast_templates` (CRUD) — אכלוס ראשוני דרך SQL.
- משיכת templates/סטטוס אישור אוטומטית מ-Meta API.
- פרמטרי קצב שליחה (pacing) פר-דיוור.
- drafts (שמירת דיוור לפני שליחה).
- דף פירוט פר-נמען עם delivery/read status (הנתונים קיימים ב-`scheduled_messages`; דף ייעודי — עתידי).
- round-robin / שיוך יועצים.
