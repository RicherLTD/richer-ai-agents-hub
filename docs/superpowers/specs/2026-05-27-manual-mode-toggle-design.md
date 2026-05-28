# Manual Mode Toggle — Design Spec

> **תאריך**: 2026-05-27
> **מטרה**: כשנציג מתערב ידנית בשיחה, השיחה עוברת ל"מצב ידני" וה-AI מפסיק לענות — עד שנציג לוחץ כפתור להחזיר אותה לניהול AI.

---

## 1. סקירה

היום ה-AI agent loop ב-`whatsapp-webhook` רץ רק כשלשיחה יש `status='active'`. אבל שליחה ידנית של אופרטור (`whatsapp-send`) **לא** משנה שום סטטוס — אז ה-AI ממשיך לענות גם אחרי שאופרטור התערב. אין דרך "להשתלט" על שיחה ולהחזיר אותה ל-AI.

הפיצ'ר מוסיף **מצב ידני** ברמת השיחה הבודדת:

- **טריגר אוטומטי**: ברגע שאופרטור שולח הודעה ידנית → השיחה עוברת למצב ידני, ה-AI שותק.
- **כפתור מפורש**: "השתלט" / "החזר לניהול AI" — שליטה דו-כיוונית גם בלי לשלוח הודעה.
- **דביקות**: השיחה נשארת במצב ידני גם אם הליד ממשיך לכתוב, עד החזרה מפורשת.
- **נראות מלאה**: באדג' ייעודי ברשימות, באנר בשיחה, ופילטר "מצב ידני".

## 2. מצב קיים (מה כבר בנוי)

| רכיב | מצב | קובץ |
|---|---|---|
| Gate של ה-loop על `status='active'` | קיים | [whatsapp-webhook/index.ts:581](../../../supabase/functions/whatsapp-webhook/index.ts) |
| דפוס release-on-block (BLOCKING_TAGS) שנחקה אותו | קיים | [whatsapp-webhook/index.ts:620](../../../supabase/functions/whatsapp-webhook/index.ts) |
| upsert הודעה נכנסת ש**לא** דורס עמודות (שמירת pause) | קיים | [whatsapp-webhook/index.ts:1163](../../../supabase/functions/whatsapp-webhook/index.ts) |
| `whatsapp-send` (תגובת אופרטור) | קיים — לא נוגע בסטטוס | [whatsapp-send/index.ts:221](../../../supabase/functions/whatsapp-send/index.ts) |
| Display taxonomy נגזר ב-read-time | קיים | [conversation-status.ts](../../../src/lib/conversation-status.ts) |
| באדג' + פילטר נגזרים אוטומטית מ-`DISPLAY_STATUSES` | קיים | `DisplayStatusBadge.tsx`, `StatusFilterChips.tsx` |
| ReplyBox + mutation שליחה | קיים | [ConversationDetail.tsx:161](../../../src/components/conversations/ConversationDetail.tsx) |

## 3. הכרעות עיצוב (מאושרות)

1. **עמודה ייעודית `manual_mode_since`** — לא ערך חדש ב-`conversation_status_enum`. תואם ל-convention המתועד ב-migration 0025 (נמנעים מ-`ALTER TYPE ADD VALUE` בגלל מגבלות transaction שמערערות את כלי ה-migration). העמודה אורתוגונלית ל-`status` ול-`current_tag`.
2. **כולל `manual_mode_by`** — תיעוד מי השתלט (מוכן לריבוי אופרטורים).
3. **החזרה ל-AI רק מפעילה מחדש מענה אוטומטי** — לא מייצרת תגובה מיידית להודעה הממתינה. הבוט יענה על ההודעה הנכנסת הבאה.

## 4. שינויי סכמה — migration `0030_conversation_manual_mode.sql`

```sql
ALTER TABLE public.conversations
  ADD COLUMN IF NOT EXISTS manual_mode_since timestamptz,
  ADD COLUMN IF NOT EXISTS manual_mode_by uuid REFERENCES auth.users(id) ON DELETE SET NULL;

COMMENT ON COLUMN public.conversations.manual_mode_since IS
  'When an operator took manual control. NULL = AI mode (agent loop replies). Non-null = manual mode (agent loop skips). Set by whatsapp-send (auto) or conversation-set-mode (explicit). Never written by inbound upsert, so it sticks across lead replies.';
COMMENT ON COLUMN public.conversations.manual_mode_by IS
  'auth.users.id of the operator who last took manual control. NULL when in AI mode.';
```

- אין צורך באינדקס: ה-gate של ה-loop קורא שיחה בודדת לפי `id`, והפילטר ב-UI נגזר client-side מהשורות שכבר נטענו.
- אחרי ה-migration: `supabase gen types typescript` כדי לעדכן את `src/types/database.ts`.

## 5. Agent loop guard — `whatsapp-webhook/index.ts`

ב-`generateAndSendAgentResponse`, מרחיבים את ה-`.select()` של תפיסת ה-lock (כיום `"id, current_tag, status"`) ל-`"id, current_tag, status, manual_mode_since"`. מיד אחרי בדיקת `BLOCKING_TAGS` (סביב שורה 620), מוסיפים guard מקביל:

```ts
const claimedManualSince =
  (claim[0] as { manual_mode_since?: string | null }).manual_mode_since ?? null;
if (claimedManualSince) {
  await ctx.admin
    .from("conversations")
    .update({ agent_lock_taken_at: null })   // משחררים את ה-lock
    .eq("id", ctx.conversationId);
  await logError({
    admin: ctx.admin,
    source: AGENT_LOOP_SOURCE,
    errorType: "conversation_manual_mode_skip",
    level: "info",
    message: `conversation in manual mode since ${claimedManualSince} — agent loop skipped`,
    context: { manual_mode_since: claimedManualSince, lead_phone: ctx.leadPhone },
    agentId: ctx.agentId,
    conversationId: ctx.conversationId,
  });
  return;
}
```

**דביקות**: ה-upsert של הודעה נכנסת ([index.ts:1165](../../../supabase/functions/whatsapp-webhook/index.ts)) נוגע רק ב-`last_interaction_at` ו-`lead_name`; הוא לא יכתוב את `manual_mode_since`, אז מצב ידני נשמר לאורך תגובות הליד — אותה הגנה שתיקנה את באג ה-handoff של 2026-05-19.

## 6. טריגר אוטומטי — `whatsapp-send/index.ts`

אחרי insert מוצלח של ההודעה היוצאת ולפני/יחד עם עדכון `last_interaction_at` (סביב שורה 221):

- **סימון ההודעה כידנית**: ב-`insert` של ה-message להוסיף `ai_provider: "manual"` (ה-enum כבר תומך — `ai_provider_enum: "claude" | "gpt" | "pending" | "manual"`).
- **כניסה למצב ידני (only-if-null)**: עדכון השיחה כך ש-`manual_mode_since` נקבע רק אם הוא עדיין null (שומר על זמן ההשתלטות המקורי גם בהודעה השנייה והשלישית):

```ts
await admin
  .from("conversations")
  .update({ manual_mode_since: ts, manual_mode_by: userId })
  .eq("id", conversation.id)
  .is("manual_mode_since", null);   // לא דורס השתלטות קודמת
```

- `userId` = `callerId` המוחזר מ-`requireAdmin` (השדה כבר קיים ב-`AdminContext`; כיום `whatsapp-send` עושה `const { admin } = await requireAdmin(req)` — פשוט מוסיפים `callerId` ל-destructure). עדכון `last_interaction_at` נשאר כפי שהוא.
- עדכון זה הוא best-effort: כשל בו לא מפיל את ה-response (ההודעה כבר נשלחה לליד), אבל יירשם ב-`error_logs`.

## 7. כפתור מפורש — edge function חדש `conversation-set-mode`

לשיחות אין RLS update מהקליינט (migration 0004 — כל כתיבה לשיחות עוברת service_role), אז הכפתור עובר edge function, בדיוק כמו `whatsapp-send`.

- **קובץ**: `supabase/functions/conversation-set-mode/index.ts`
- **חוזה**: `POST { conversation_id: string, mode: "manual" | "ai" }`, `Authorization: Bearer <JWT>`
- **שער**: `requireAdmin` (כמו `whatsapp-send`)
- **לוגיקה**:
  - `mode="manual"` → `update { manual_mode_since: now(), manual_mode_by: userId }`. אפשר only-if-null כדי לשמר זמן השתלטות מקורי, אבל מקובל גם re-stamp.
  - `mode="ai"` → `update { manual_mode_since: null, manual_mode_by: null }`.
  - מחזיר את שורת השיחה המעודכנת.
- **deploy**: עם JWT verification (ברירת מחדל — *לא* `--no-verify-jwt`), כי הוא admin-gated.
- **client lib**: פונקציה ב-`src/lib/conversations.ts` (או `messages.ts`) שעוטפת `supabase.functions.invoke("conversation-set-mode", { body })`, בדומה ל-[messages.ts:88](../../../src/lib/messages.ts).

## 8. Display taxonomy — `src/lib/conversation-status.ts`

- להוסיף `"manual"` ל-`DISPLAY_STATUSES` (ה-tuple).
- `DISPLAY_STATUS_LABEL.manual = "מצב ידני"`.
- `DISPLAY_STATUS_VARIANT.manual = "secondary"` (או טון ייחודי — להחליט ב-UI; שונה מ-`requires_human` ה-`destructive`).
- להוסיף `manual_mode_since` ל-`ConversationStatusInput`.
- ב-`deriveDisplayStatus`, להוסיף branch בעדיפות **אחרי zoom, לפני requires_human**:

```ts
// 1. zoom wins outright (קיים)
if (tag === "zoom_scheduled") return "zoom_scheduled";
// 2. מצב ידני — אופרטור השתלט בפועל (גובר על requires_human/closed/opened)
if (conv.manual_mode_since) return "manual";
// 3. requires_human ... (קיים)
```

רציונל: אם הבוט סימן `requires_human` ואז אופרטור השתלט, "מצב ידני" מתאר נכון יותר את המצב הנוכחי. zoom_scheduled (הצלחה/terminal) נשאר עליון.

- **אוטומטי בלי קוד נוסף**: `DisplayStatusBadge` ו-`StatusFilterChips` ממפים על `DISPLAY_STATUSES`/המפות, אז הבאדג' והפילטר "מצב ידני" מופיעים בכל הרשימות (`Conversations.tsx`, `Leads.tsx`) ללא שינוי נוסף.

## 9. UI שיחה — `ConversationDetail.tsx`

הרכיב כבר טוען את שורת השיחה ומריץ `sendMutation`. נוסיף:

- **באנר/שורת-מצב מעל ה-ReplyBox**:
  - מצב ידני (`manual_mode_since != null`): "מצב ידני · ה-AI מושהה" + כפתור **"החזר לניהול AI"** → קורא `conversation-set-mode` עם `mode: "ai"`.
  - מצב AI: חיווי דק "AI פעיל" + כפתור **"השתלט"** → `mode: "manual"`.
- **אחרי כל פעולה** (שליחה דרך ReplyBox *או* כפתור): `queryClient.invalidateQueries` על שאילתת השיחה כדי לרענן את `manual_mode_since`. `conversations` **לא** ב-realtime publication (רק `messages`/`coach_messages`), אז לא יגיע push אוטומטי — חובה refetch ידני אחרי mutation.
- אופציונלי: עדכון טקסט ה-hint ב-`ReplyBox.tsx` ל"שליחה ידנית תעביר את השיחה למצב ידני".

## 10. Edge cases

1. **מירוץ שליחה במקביל**: אם הליד שולח הודעה בדיוק כשהאופרטור שולח/משתלט, ייתכן שה-loop כבר עבר את ה-gate ותצא תגובת AI אחת אחרונה לצד הודעת האופרטור. כל ההודעות הבאות חסומות. מקובל (חלון נדיר).
2. **החזרה ל-AI לא עונה מיד**: מאפסת `manual_mode_since` ומאפשרת מענה אוטומטי להודעות **הבאות** בלבד. לא מייצרת תגובה להודעה הממתינה (out of scope — ראה §12).
3. **אורתוגונליות ל-zoom/kill-switch**: `current_tag='zoom_scheduled'` + `status='paused'` (handoff) ו-`agents.is_paused` (kill switch גלובלי) נשארים בלתי תלויים. ה-loop נחסם ע"י כל אחד מהם בנפרד; בתצוגה zoom גובר על manual.
4. **only-if-null בטריגר האוטומטי**: הודעות ידניות חוזרות לא דורסות את זמן ההשתלטות המקורי.
5. **שדה `manual_mode_by`**: FK ל-`auth.users`. אם משתמש נמחק — להשאיר את ההתנהגות פשוטה (`ON DELETE` ברירת מחדל / SET NULL לפי הצורך; לא קריטי).

## 11. בדיקות

- `conversation-status.test.ts`: מקרים חדשים — `manual_mode_since != null` → `"manual"`; עדיפות zoom > manual > requires_human; manual גובר על opened/closed.
- `conversation-set-mode`: טסט בסיסי — admin-gate, set/clear, validation של ה-body.
- guard ב-`whatsapp-webhook`: שקילת חילוץ ה-guard ל-helper טהור קטן (כמו utilities אחרים ב-`_shared`) לבדיקה דטרמיניסטית של "manual_mode_since לא-null → skip".
- אין בדיקות UI styling (לפי policy).

## 12. מחוץ ל-scope

- "החזר ל-AI **וענה עכשיו**" (לייצר תגובת AI מיידית להודעה הממתינה בעת חזרה).
- round-robin / שיוך אוטומטי של אופרטור.
- הוספת `conversations` ל-realtime publication (נסתפק ב-refetch-after-mutation).
- ניהול הרשאות מעבר ל-admin (כל האופרטורים שמורשים לשלוח הם admin היום).

## 13. רשימת קבצים מושפעים

| קובץ | שינוי |
|---|---|
| `supabase/migrations/0030_conversation_manual_mode.sql` | **חדש** — שתי עמודות |
| `supabase/functions/whatsapp-webhook/index.ts` | guard ב-agent loop + הרחבת `.select()` |
| `supabase/functions/whatsapp-send/index.ts` | טריגר אוטומטי + `ai_provider='manual'` |
| `supabase/functions/conversation-set-mode/index.ts` | **חדש** — endpoint לכפתור |
| `src/lib/conversation-status.ts` | display status `'manual'` + עדיפות |
| `src/lib/conversations.ts` (או `messages.ts`) | wrapper ל-`conversation-set-mode` |
| `src/components/conversations/ConversationDetail.tsx` | באנר + כפתור + refetch |
| `src/components/conversations/ReplyBox.tsx` | (אופ') עדכון hint |
| `src/types/database.ts` | regen אחרי migration |
| `src/lib/conversation-status.test.ts` | מקרי manual |
| `supabase/functions/conversation-set-mode/*.test.ts` | טסט בסיסי |
