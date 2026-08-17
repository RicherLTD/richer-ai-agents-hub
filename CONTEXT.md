# Richer WhatsApp AI Agents

מערכת סוכני AI שמנהלים שיחות WhatsApp עם לידים של מכללת ריצ'ר, במטרה אחת: **לתאם פגישת זום עם יועץ**. המסמך הזה הוא **מילון מונחים בלבד** — השפה המשותפת של הפרויקט. ארכיטקטורה והחלטות מימוש נמצאות ב-[CLAUDE.md](./CLAUDE.md) וב-`docs/adr/`.

## Language

### ישויות

**Lead**:
אדם אמיתי שהשאיר פרטים בקמפיין ומקבל הודעות WhatsApp מהסוכן.
_Avoid_: user, customer, contact, לקוח

**Conversation**:
חוט השיחה בין Lead אחד ל-Agent אחד. אותו Lead יכול להחזיק Conversation נפרד מול כל Agent.
_Avoid_: chat, thread, session

**Agent**:
פרסונת AI מוגדרת + מספר ה-WhatsApp שלה + ה-config שלה (שורה ב-`agents`). היום שניים חיים: `affiliate_marketing` ו-`digital_marketing` ("תמיר").
_Avoid_: bot, channel, persona — כשמדובר בישות המוגדרת הזאת

**Advisor**:
אדם מהמכללה שמקבל את הליד בפגישת הזום. **לא** ה-Agent ולא האופרטור.
_Avoid_: rep, נציג, sales

**Operator**:
עובד שצופה בדשבורד ויכול להשתלט על שיחה. אנושי, פנימי.
_Avoid_: admin, user

### התקדמות ומטרה

**Qualification**:
חמש השאלות (q1–q5) שהסוכן צריך לאסוף מהליד. אין להחליף בין זה לבין הסכמה לפגישה — ליד יכול להיות מוכשר ולא להסכים.
_Avoid_: questionnaire, screening, שאלון

**Progression**:
מעבר של Conversation שלב אחד קדימה ב-Qualification. זה ה**אות המהיר** למידה — יש לו נפח נתונים גדול.
_Avoid_: engagement, activity

**Consent**:
אמירה מפורשת של הליד שהוא מסכים לפגישה (`meeting_consented_at`). **הסקה מתשובה חיובית אינה Consent** — נדרשת הסכמה מפורשת.
_Avoid_: agreement, opt-in (ש-`opt_outs` מתייחס לדבר אחר לגמרי)

**Booked Zoom**:
פגישת זום שנקבעה בפועל עבור הליד. זו המטרה של המערכת.
_Avoid_: meeting, appointment, conversion — כשמתכוונים לרשומה הזאת

**Bot-Booked Zoom**:
Booked Zoom שה-Agent עצמו קבע דרך כלי ההזמנה (`zoom_booked_by='agent'`). זה **האות האיטי והמחייב** להצלחה, וזה מה שנמדד כשמעריכים את הסוכן.
_Avoid_: זום סתם, conversion

**Self-Booked Zoom**:
Booked Zoom שהליד קבע בעצמו בדף Mooz (`zoom_booked_by='self'`). **לא** נחשב הצלחה של הסוכן.
_Avoid_: organic booking

**Handoff**:
ההעברה החתומה של ליד מוכשר ל-Make.com (ומשם ל-Advisor ול-CRM). קורה פעם אחת פר-Conversation.
_Avoid_: escalation — escalation הוא העברה לאדם בגלל בעיה, Handoff הוא הצלחה

### סטטוסים

**Funnel Stage**:
כמה מה-Qualification הושלם: `cold` (0 שאלות) · `mid` (1–4) · `done` (5). ציר של **התקדמות**.
_Avoid_: status, stage סתם

**Tag**:
ציר של **מצב חריג או סופי** של Conversation — נפרד לחלוטין מ-Funnel Stage. אוצר המילים החי: `zoom_scheduled` · `opted_out` · `requires_human` · `underage`.
_Avoid_: label, category

**Untagged**:
המצב שבו לא הוחלט כלום על ה-Conversation. בבסיס הנתונים זה מיוצג היום בערך `not_hotlist`, שהוא ה-DEFAULT של העמודה — **הוא לא אומר "הליד לא מתאים"**. `hotlist`, `hotlist_plus`, `questionnaire`, `block_risk` הם אוצר מילים מת (0 שורות מעולם), ו-`ghosted` כמעט מת (שורה אחת).
_Avoid_: not_hotlist כביטוי לאי-התאמה, cold כשמתכוונים לחוסר תיוג

**Manual Mode**:
מצב שבו Operator השתלט על Conversation וה-Agent שותק בה.
_Avoid_: paused — `is_paused` הוא kill-switch לכל ה-Agent, לא לשיחה בודדת

### סוגי נתונים

הגבול בין שלושת הסוגים הוא **First Inbound** — ההודעה הראשונה שהליד שלח. לפניה: Reach ו-Marketing. אחריה: Bot Quality. ראה [ADR-0002](./docs/adr/0002-data-classes-and-what-may-drive-prompt-changes.md).

**First Inbound**:
ההודעה הראשונה שהגיעה מה-Lead ב-Conversation. הגבול הקנוני בין נתוני שיווק לנתוני איכות הסוכן.
_Avoid_: first contact, first touch (אלה השליחה **שלנו**, לא התשובה שלו)

**Reach Data**:
האם ההודעה הגיעה פיזית — `sent` / `delivered` / `read` / `failed` + קוד השגיאה של Meta. שייך לתשתית ולמוניטין מול Meta, **לא** לשיווק ולא לאיכות הסוכן.
_Avoid_: engagement, open rate

**Marketing Data**:
הקהל, הטמפלייט, זמן השליחה, והאם התקבל First Inbound. עונה על "האם ההודעה הנכונה הגיעה לאדם הנכון בזמן הנכון". מנהל **טמפלייטים ותזמון**.
_Avoid_: performance data, funnel data

**Bot Quality Data**:
כל מה שקורה אחרי First Inbound — Progression, ציוני guard ו-judge, טיפול בהתנגדויות, Consent, Bot-Booked Zoom. עונה על "בהינתן שיחה חיה, כמה טוב ה-Agent שוחח". **רק זה מורשה להניע שינוי Prompt.**
_Avoid_: conversation data, AI data

**Reach Record**:
מה שיודעים על Lead שקיבל הודעה ולא ענה: טמפלייט, זמן שליחה, וב**איזה** מהשלושה זה נעצר — `never delivered` (תשתית) · `delivered unread` (תזמון/התראות) · `read but ignored` (קופי). אסור לאחד את השלושה ל"לא ענה".
_Avoid_: bounce, non-responder כקטגוריה אחת

### מדידה ולמידה

**Fast Signal**:
אות בעל נפח נתונים גדול שמאפשר מסקנה שבועית — Lead ענה, ו-Progression התרחש. זה מה שהלופ השבועי מורשה לפעול לפיו.
_Avoid_: KPI, metric סתם

**Slow Signal**:
Bot-Booked Zoom — האות המחייב, אבל בנפח של ~20 בשבוע. מאשר או פוסל מסקנות על חלון של שבועות, **לא** בסיס להחלטה שבועית.
_Avoid_: conversion rate כשמתכוונים למשהו שאפשר למדוד שבועית

**Score**:
תווית תוצאה שנצמדת ל-trace או ל-session ב-Langfuse (למשל `lead_replied`, `judge_verdict`, `bot_booked_zoom`). זה הפנקס של "תשובה טובה מול תשובה רעה".
_Avoid_: rating, grade

**Active Prompt**:
גרסת ה-Prompt שהמערכת באמת מריצה. מקור האמת הוא **הקובץ ב-git** שמופיע ב-`_active.json`; טבלת `prompts` היא cache. גרסה שקיימת רק בטבלה היא **drift**, לא release. ראה [ADR-0001](./docs/adr/0001-prompts-stay-in-git-langfuse-for-evaluation.md).
_Avoid_: latest prompt, current prompt

### שליחות יזומות

**First-Touch Template**:
טמפלייט מאושר-Meta שנשלח לליד חדש מההרשמה, לפני שיש שיחה.
_Avoid_: welcome message, greeting

**Broadcast**:
שליחה יזומה של טמפלייט לקהל רחב מתוך הדשבורד, כיחידה אחת נמדדת.
_Avoid_: campaign, blast, דיוור בהקשר של first-touch

**Re-engagement**:
נודניק חד-פעמי ללידים ששתקו. אינו Broadcast ואינו First-Touch.
_Avoid_: follow-up, nudge
