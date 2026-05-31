# עיצוב: מניעת כפילות שיחות + handoff ל-CRM רק כשהבוט קבע

**תאריך:** 2026-05-27
**סטטוס:** עיצוב לאישור
**הקשר:** חקירת תקלה של ליד "דניאל" (טלפון `524208490`) שהופיע עם שתי שיחות נפרדות ושני זומים, ועם CRM שמראה "נקבע זום ע״י הבוט" כשהבוט לא קבע בכלל.

---

## 1. רקע ושורש הבעיה

חקירה על נתוני הפרודקשן (read-only) העלתה שני באגים שמצטברים:

### באג A — כפילות שיחות מפער נרמול טלפון
- `lead-register` (דף נחיתה) שומר `lead_phone` בפורמט E.164 קנוני: `+972XXXXXXXXX`.
- `whatsapp-webhook` שומר את `message.from` הגולמי מ-Meta: `972XXXXXXXXX` (בלי `+`).
- ה-constraint `UNIQUE(agent_id, lead_phone)` לא תופס את הכפילות כי המחרוזות שונות → **שתי שורות conversation לאותו אדם**, כל אחת מריצה loop נפרד.
- היקף בפרודקשן: 502 שיחות `+972` מול 87 שיחות `972`; **~85 זוגות כפולים**, מתוכם ~13 עם `zoom_scheduled`.

### באג B — handoff ל-CRM נורה על כל booking, גם כשהבוט לא קבע
- `mooz-webhook` יורה handoff ל-Make.com (→ Fireberry/יועצים) על **כל** `booking.created` מ-Mooz — כולל כשהליד קבע לבד.
- אצל דניאל הבוט מעולם לא ענה (אפס agent turns), אבל שני זומים שהוא קבע לבד דרך Mooz הפעילו שני handoff-ים, ו-Make תייג אותם "שבוט קבע".

### תקלות משניות שתרמו
- `mooz-webhook` בורר את "השיחה הכי עדכנית" לפי טלפון (`order by last_interaction_at desc limit 1`) → אירוע booking נחת על השיחה הלא-נכונה מבין הכפילות.
- `dispatch-scheduled-templates` שולח template בלי לבדוק אם כבר נקבע זום (אין בו את בדיקת ה-Mooz ש-CLAUDE.md מתאר). לכן דניאל קיבל template אחרי שכבר היה לו זום.

---

## 2. דרישות

1. למנוע יצירת שיחות כפולות מסיבות כמו פער פורמט הטלפון.
2. handoff ל-CRM ייורה **רק** כשהבוט קבע את הזום. כשליד קובע לבד — המערכת תדע (תיוג `zoom_scheduled` בדאטה/דשבורד) אבל **לא** ייורה handoff.
3. מניעת שליחת template לליד שכבר נקבע לו זום.

---

## 3. החלטות עיצוב

- **פורמט קנוני:** `+972XXXXXXXXX` (E.164). תואם את הרוב (502/589), את `lead-register` ואת payload ה-handoff.
- **handoff (החלטה מאושרת — "דרך א'"):** הבוט יורה את ה-handoff בעצמו כשהוא קובע (`book_meeting` הצליח), ו-`mooz-webhook` הופך ל**תיוג בלבד** ולא יורה handoff יותר. נבחר על פני "זיהוי בוט-מול-ליד ב-mooz-webhook" כי אין צורך במנגנון זיהוי, אין race, ואין תלות בכך ש-Mooz יחזיר marker. מודע לכך שזה משנה החלטה של קפיר מ-24/05 (handoff מ-mooz-webhook אחרי אישור Mooz); הכיסוי לכשל נשמר דרך retries + DLQ.
- **תיקון קדימה בלבד:** לא ממזגים את 85 הכפילויות הקיימות.

---

## 4. רכיבי המימוש

### רכיב 1 — נרמול טלפון אחיד
- **חדש:** `_shared/phone.ts` עם `toE164Israel(raw: string): string | null` — אותה לוגיקה שכבר נכונה ב-`lead-register` (`+972`/`972`/`0` → `+972…`, אחרת `null`). `lead-register` יעבור להשתמש בה (הסרת ההעתק המקומי).
- **`whatsapp-webhook`** (ב-`ingestInbound`/upsert השיחה):
  - לחשב `canonical = toE164Israel(message.from)` (fallback ל-raw אם לא ניתן לנרמל, כדי לא לשבור edge-cases לא-ישראליים).
  - **lookup אגנוסטי לפורמט:** לחפש שיחה קיימת לפי `lead_phone IN (canonical, bare)` (כש-`bare` = canonical בלי `+`).
    - אם קיימת שורה קנונית → להשתמש בה.
    - אחרת אם קיימת שורה חשופה → להשתמש בה ו-**self-heal**: לעדכן את `lead_phone` שלה ל-canonical (בטוח — אין שורה קנונית מתנגשת).
    - אחרת → INSERT עם `lead_phone = canonical`.
  - לשמור על ה-UPDATE-first ועל recovery מ-`23505` (כעת על בסיס canonical).
- **תוצאה:** אין כפילות חדשה; פעילות עתידית מתאחדת על השורה הקנונית; שורות חשופות בודדות מתרפאות במגע.

### רכיב 2 — הבוט יורה handoff בעת קביעה
- ב-`whatsapp-webhook`, אחרי `runAgentTurn` **ואחרי** `runMemoryExtraction` (כדי שה-memory יהיה טרי), אם `turnResult.bookingCreated === true`:
  - לבנות payload מ-`conversations` (כולל `zoom_scheduled_at` שכבר נכתב ע״י `updateConversationOnBooking`) + `lead_memory` + קונפיג הסוכן, ולירות דרך `fireHandoffWebhook` (עם DLQ בכשל) — אותו דפוס שקיים כבר ב-`extractMemory.ts`.
  - לפצל את בניית ה-payload ל-helper משותף כדי לא לשכפל (extractMemory ו-webhook ישתמשו באותו builder).
- **`extractMemory.ts`** — נשאר כפי שהוא. כשהבוט קובע, `book_meeting` כבר קבע `funnel_stage='done'`, ולכן `shouldTriggerZoomHandoff` מחזיר `false` (תנאי `currentStage === 'done'`) ולא יהיה double-fire.

### רכיב 3 — `mooz-webhook` הופך לתיוג בלבד
- **להסיר** את ירי ה-handoff מ-`handleCreatedOrRescheduled` (כולל בניית payload, טעינת agent config ל-payload).
- **לשמור:** תיוג `current_tag='zoom_scheduled'`, `funnel_stage='done'`, `status='paused'`, `zoom_scheduled_at`, מירור `q7_email`+`meeting_consented_at` ל-`lead_memory`, וטיפול ב-`booking.cancelled` (→ `requires_human`).
- **שמירה:** idempotency דרך `mooz_webhook_events`.
- **התאמת שיחה דטרמיניסטית:** במקום "הכי עדכנית", להעדיף את שורת ה-`+972` (קנונית) בהתאמת suffix, tie-break לפי `last_interaction_at`. (תיוג בלבד, אז גם אם נבחרה שורה מבין כפילות ישנות — אין נזק של handoff.)

### רכיב 4 — מניעת template לליד שכבר נקבע
- ב-`dispatch-scheduled-templates`, לפני השליחה: לדלג אם השיחה (`row.conversation_id`) כבר מתויגת `zoom_scheduled` (או תג סופי אחר כמו `opted_out`/`requires_human`).
- מימוש: להרחיב את ה-`select` ב-join ל-`conversations.current_tag`, ולסמן את ה-`scheduled_message` כ-`sent`/`skipped` (לא לשלוח, לא להשאיר pending שינסה שוב).

---

## 5. מחוץ ל-scope (מסומן ביודעין)
- **handoff של extractMemory על העפלה ללא booking** — כשהבוט אסף q1-q5+הסכמה+מייל אך לא קבע דרך הכלי, עדיין ייורה handoff. מסלול נפרד, לא הבעיה של דניאל. נשאר כפי שהוא; ניתן לטפל בנפרד אם נרצה ש"handoff = רק כשיש booking בפועל".
- **איפוס status ב-`lead-register`** — ה-upsert מחזיר שיחה booked ל-`active`. סיכון ידוע שנשאר (יכול לגרום לבוט לחזור לדבר עם ליד שכבר נקבע). לא בתיקון הזה לפי החלטת המשתמש.
- **85 הכפילויות הקיימות** — לא ממוזגות (תיקון קדימה בלבד).

## 6. בדיקות (Deno, colocated)
- `phone.test.ts`: כל הפורמטים (`+972`/`972`/`0`/עם רווחים-מקפים/לא-תקין) → canonical או null. שקילות בין פורמטים.
- lookup אגנוסטי ב-webhook: שורה קנונית קיימת; שורה חשופה קיימת (self-heal); אין שורה (insert canonical); זוג כפול (בוחר קנונית, לא ממזג).
- handoff בעת booking: `bookingCreated=true` → handoff נורה פעם אחת; אין double-fire עם extractMemory.
- `mooz-webhook`: `booking.created` של ליד → מתייג אך **לא** יורה handoff; `cancelled` → `requires_human`.
- dispatch: שיחה `zoom_scheduled` → ה-template מדולג.

## 7. סיכונים / Rollout
- **שינוי טריגר ה-handoff** (מ-mooz-webhook ל-bot): מנוטר דרך Langfuse + `error_logs`. אם handoff-ים נעלמים — DLQ + `dlq-replay`. מאושר ע״י המשתמש כסיכון מחושב.
- אין מיגרציית דאטה הרסנית. אם נדרש column/table חדש (לא צפוי בדרך א') — ייווסף כ-migration רגיל.
- **עדכון CLAUDE.md** בסוף: הוספת `mooz-webhook` לרשימת ה-functions, ותיקון התיאור השגוי של "Mooz pre-check" ב-dispatcher.
