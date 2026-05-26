# Mooz Pre-Check + Already-Booked Conversation Flow

**Date**: 2026-05-26
**Author**: Brainstormed with operator (Izhak), drafted by Claude
**Status**: Awaiting implementation
**Branch (to be created)**: `feat/mooz-pre-check-and-booked-flow`

## Background

On 2026-05-26 ~11:30 IL a real lead (Shirley A., conversation `12b38c79-3171-4164-a341-32256c6b305b`) experienced a broken flow:

1. She said *"אני קבעתי להיום זום ב12"* (I scheduled a Zoom at 12 today).
2. Bot replied *"מעולה! אז הכל סגור להיום ב-12"* — without verifying.
3. She replied *"לא שלחו לי קישור"*.
4. Bot then "checked the system", offered fresh slots (real, from Mooz via `list_available_slots`), and rebooked her at 15:00 via `book_meeting`.
5. After booking succeeded, conversation paused (`status=paused, tag=zoom_scheduled`). Shirley asked *"שולח לי קישור?"* — got NO reply.

Verified causes (via DB query + `error_logs` inspection):

| # | Cause | Evidence |
|---|---|---|
| 1 | **No pre-check** before generating reply | `lookupByPhone` exists in `mooz.ts:223` but no production code calls it. |
| 2 | **Generic booking confirmation** | `moozTools.ts:349` `next_step` instructs Claude *"Don't promise links — they're sent by email separately"* (incorrect: link arrives via WhatsApp 5 min before). |
| 3 | **Pause kills follow-up** | `agent-loop` `conversation_paused_skip` for any inbound after booking. |

## Goal

After this PR ships:

1. Bot pre-checks Mooz booking status **conditionally** — on turn 1 of the conversation **and** on any later turn where the lead's last message contains a booking-related keyword. Budget-aware (~80% fewer calls than every-turn) while still catching the Shirley-at-turn-14 case.
2. If lead has a confirmed future booking, bot follows a short, fixed acknowledge-and-prepare reply pattern — does **not** try to re-qualify, does **not** propose new slots unless asked.
3. If lead claims a booking but Mooz says none, bot gently corrects and proceeds to schedule.
4. `book_meeting` success reply **always** includes the line *"הקישור יישלח אליך בוואטסאפ 5 דקות לפני הפגישה"* — proactive UX, prevents the "where's my link?" question.
5. If lead asks anyway (e.g., post-pause), the same canned response is the standard answer — kept consistent.
6. Cancellation/reschedule are handled with warmth:
   - Reschedule → `list_available_slots` + `book_meeting` again (Mooz replaces).
   - Cancellation → bot first warms the lead and tries to convert to reschedule. Only escalates to `requires_human` if the lead insists after two warm attempts.

## Non-goals (out of scope for this PR)

- Adding dedicated `cancel_booking` / `reschedule_booking` tools. Reschedule reuses `book_meeting`; cancellations escalate to human.
- Fixing recurring `claude_invalid_json` errors in `memory-extractor` (separate ticket).
- Restructuring the agent-loop pause behavior (we work around it via proactive link line).
- Two-way sync of Mooz cancellations into our `conversations` table (separate ticket — already implicit via `mooz-webhook`).

## Architecture

### Section 1 — Pre-check call site (conditional)

**File**: `supabase/functions/whatsapp-webhook/index.ts`
**Function**: `generateAndSendAgentResponseLocked`
**Location**: after `loadAgentTurnContext` returns, after `moozClient` is constructed (~line 690-702), before `runAgentTurn` (~line 723).

**When the pre-check fires** — only when BOTH `moozClient` exists AND one of these is true:
- (a) **Turn 1**: `turn.claudeMessages.length === 1` — the inbound we just persisted is the only message in the thread.
- (b) **Keyword trigger**: the latest inbound text matches the booking-keyword regex:

```ts
const BOOKING_KEYWORD_RE =
  /קבעתי|קבעת|זום|פגישה|קישור|link|מועד|מתי|שעה|להזיז|לשנות|לבטל|תאמתי|תיאמתי/i;
```

The Hebrew patterns intentionally have no `\b` (per repo convention — `\b` doesn't work on Hebrew code points in JS regex).

**Logic**:

```ts
const lastMsg = turn.claudeMessages[turn.claudeMessages.length - 1];
const lastInboundText =
  lastMsg?.role === "user" && typeof lastMsg.content === "string"
    ? lastMsg.content
    : "";
const isFirstTurn = turn.claudeMessages.length === 1;
const messageMentionsBooking = BOOKING_KEYWORD_RE.test(lastInboundText);
const shouldPreCheck = !!moozClient && (isFirstTurn || messageMentionsBooking);

let bookingStatusBlock = "";
if (shouldPreCheck) {
  try {
    const lookup = await moozClient!.lookupByPhone(ctx.leadPhone);
    bookingStatusBlock = renderBookingStatusBlock(lookup);
  } catch (err) {
    // Fail-open: Mooz outage must not block the bot.
    await logError({
      admin: ctx.admin,
      source: AGENT_LOOP_SOURCE,
      errorType: "mooz_lookup_failed",
      level: "warn",
      message: err instanceof Error ? err.message : String(err),
      context: { lead_phone: ctx.leadPhone, trigger: isFirstTurn ? "first_turn" : "keyword" },
      agentId: ctx.agentId,
      conversationId: ctx.conversationId,
    });
    bookingStatusBlock = renderBookingStatusBlock({ booked: false, error: "lookup_failed" });
  }
}
const systemPrompt = dateHeader + bookingStatusBlock + turn.promptContent;
```

**Phone format**: pass `ctx.leadPhone` (E.164, e.g. `+972527929336`) verbatim. Verified on 2026-05-26 via a temporary `diag-mooz-lookup` edge function (since deleted) that the Mooz `/bookings-lookup` endpoint normalizes phone internally and accepts all four formats: `527929336`, `0527929336`, `+972527929336`, `972527929336`.

**Trigger frequency**: expected ~1-3 Mooz calls per typical conversation (vs ~15 if we checked every turn). Saves ~80% of calls.

**Behavior on turns where pre-check is skipped**: `bookingStatusBlock` is empty string. The system prompt has no booking-status info; the prompt's standard v13/v14 conversation rules apply. This is OK because:
- If the lead is booked, we already captured that in an earlier turn (turn 1 or a keyword turn) and the conversation state (`current_tag`) reflects it.
- If the lead newly mentions anything booking-related, the keyword regex triggers a fresh check.

**No short-circuit on `current_tag='zoom_scheduled'`** in the conditional gate — when we DO check, we always check via Mooz. Mooz is the source of truth, our DB might lag. We just don't check on every turn.

### Section 2 — `renderBookingStatusBlock` helper

**File**: new — `supabase/functions/_shared/bookingStatusBlock.ts`
**Exports**: `renderBookingStatusBlock(lookup: Awaited<ReturnType<MoozClient["lookupByPhone"]>>): string`

**Output (three branches)**:

**(a) Booked** — `lookup.booked === true`:

```
# Lead booking status (live from Mooz)

This lead HAS a confirmed Zoom meeting at <YYYY-MM-DD HH:mm Asia/Jerusalem>.

Behavior rules for this turn:
- DO NOT call list_available_slots or book_meeting unless the lead explicitly asks to reschedule.
- Respond in ONE short Hebrew message following this pattern:
  1. Briefly acknowledge what the lead actually said (paraphrase their content, not just "תודה").
  2. Note that you can see they already have a meeting with the advisor.
  3. Encourage preparation: "תבוא עם שאלות והמטרות שלך".

- If the lead asks about the link or "where is the link" / "didn't get a link":
  Reply exactly: "קישור לפגישה ישלח אליך 5 דקות לפני הפגישה לוואטסאפ".

- If the lead wants to RESCHEDULE (move to a different time):
  Call list_available_slots with the new preferred date, then book_meeting. Mooz replaces the prior booking.

- If the lead wants to CANCEL:
  First attempt — warmly understand why and offer to reschedule: "אני שומע, מה גרם לך לרצות לבטל? אפשר גם פשוט להזיז את הפגישה למועד שיותר נוח לך".
  Second attempt (if they push again) — same warmth, last try.
  Third time — accept and escalate: "אעביר אותך ליועצת שלנו שתוכל לעזור". Tag will flip to requires_human via the standard escalation path.
```

**(b) Not booked** — `lookup.booked === false` and no `error`:

```
# Lead booking status (live from Mooz)

This lead has NO confirmed booking yet.

Behavior rules:
- Standard conversation flow applies — warm, ask the qualification questions, and when appropriate offer to schedule via list_available_slots.
- If the lead claims "אני כבר קבעתי" / "יש לי זום" / "קבעתי זום":
  Gently clarify: "אני בודק במערכת ולא רואה לך זום מתואם — בוא נסדר את זה עכשיו".
  Then proceed to list_available_slots.
```

**(c) Lookup failed** — `lookup.booked === false` with `error`:

```
# Lead booking status (live from Mooz)

[Booking status check is temporarily unavailable. Proceed with the standard conversation flow. If the lead claims they already booked, accept it at face value for this turn — we'll re-check next turn. Do not call list_available_slots if the lead says they're already booked.]
```

### Section 3 — `moozTools.ts` update

**File**: `supabase/functions/_shared/moozTools.ts`
**Function**: `handleBookMeeting`
**Line**: ~349 (`next_step` field in success response).

**Before**:
```ts
next_step:
  "Confirm the booking to the lead in one short message. Include the time in Israel timezone in natural Hebrew. Don't promise links — they're sent by email separately.",
```

**After**:
```ts
next_step:
  "Confirm the booking to the lead in one short message. Include the time in Israel timezone in natural Hebrew. ALWAYS include the line verbatim: 'הקישור יישלח אליך בוואטסאפ 5 דקות לפני הפגישה'. A short closing word ('בהצלחה!' or a single emoji) is fine after the line, but nothing more.",
```

### Section 4 — New prompt: `main/v14.md`

**File**: `prompts/affiliate_marketing/main/v14.md`
**Base**: copy of `v13.md` with two added top-level sections (placed after the existing "Identity & Role" section, before "Meta / WhatsApp Compliance"):

**4a. New section: "מצב booking של הליד — קרא לפני כל תגובה"**

```markdown
## מצב booking של הליד — קרא לפני כל תגובה

בראש ה־system prompt תופיע כותרת `# Lead booking status (live from Mooz)`. **תקרא אותה לפני שאתה מנסח תגובה.** התוכן שלה קובע את ההתנהגות שלך לתור הזה:

- אם כתוב **HAS a confirmed Zoom meeting** → עקוב אחר ההוראות הספציפיות שמופיעות מתחת בבלוק. זה דורס את זרימת השיחה הרגילה.
- אם כתוב **NO confirmed booking** → המשך זרימה רגילה.
- אם כתוב **temporarily unavailable** → המשך זרימה רגילה אבל אם הליד טוען שכבר קבע — אל תוודא, אל תציע slots חדשים בתור הזה.
```

**4b. New section: "אחרי book_meeting הצליח"**

```markdown
## אחרי book_meeting הצליח

תגובת האישור חייבת לכלול בדיוק את שורת הקישור באופן פרואקטיבי:

> "סגור [שם] 🙌 [יום + שעה בעברית טבעית]. הקישור יישלח אליך בוואטסאפ 5 דקות לפני הפגישה. בהצלחה!"

לא להוסיף שאלות, לא להוסיף "תרגישי חופשי לשאול" וכדומה — תגובה ממוקדת בלוגיסטיקה.
```

**Activation**: update `prompts/affiliate_marketing/_active.json` → `{"main":"v14","memory_extractor":"v2"}`. The `prompts:sync` script will push v14 to the DB. Active flip is via DB (instant rollback via dashboard ↺ if needed).

### Section 5 — Tests

**New files**:

1. `supabase/functions/_shared/bookingStatusBlock.test.ts` — unit tests for the three branches of `renderBookingStatusBlock` (booked / not-booked / error). Validates output contains expected substrings and the IL-formatted time.

**Modified**:

2. `supabase/functions/_shared/moozTools.test.ts` — assert the new `next_step` hint contains "5 דקות לפני".

3. `supabase/functions/whatsapp-webhook/index.test.ts` (if it exists; create minimal one if not) — fetch-mocked Mooz, assert:
   - `lookupByPhone` called once per turn.
   - On lookup success → bookingStatusBlock injected before promptContent.
   - On lookup failure → fail-open: agent loop still runs, `mooz_lookup_failed` logged.

**No changes needed**:

- `mooz.test.ts` already covers `lookupByPhone` happy + error paths.

## Risks & mitigations

| Risk | Likelihood | Mitigation |
|---|---|---|
| Lead books **silently in another channel** mid-conversation without mentioning it → bot doesn't know until next keyword-trigger turn | Low | Most leads who booked elsewhere will mention it ("קבעתי", "קישור"). If they don't, the bot continues as "not booked" until it does — at worst we re-engage them on scheduling they've already done. Mooz's own `mooz-webhook` will eventually flip our DB tag too. |
| Bot mis-classifies sales objection as cancellation attempt | Med | Prompt section gives explicit "warm first, escalate only on insistence" behavior. Monitor `requires_human` rate post-rollout. |
| Lead's Mooz booking is at a slightly stale state vs. our DB at the moment we check | Low | When we DO check, Mooz is the source of truth. Within the same conversation, if the booking changed between turns and the lead doesn't mention it, see row 1. |
| Latency added (~200-500ms) on triggered turns | Low | Current turn latency is 2-5s; this is <10% increment. Most turns skip the check entirely. |
| Mooz down → triggered turn "fails open" with degraded block | Low | Degraded prompt explicitly handles this; bot doesn't double-book or hallucinate. |
| Keyword regex misses an edge variant (e.g., typo, slang) | Low | Regex is conservative — most reasonable Hebrew references to scheduling are caught. Iterate post-rollout if logs show misses. |

## Rollout plan

1. Branch from `main`: `feat/mooz-pre-check-and-booked-flow`.
2. Implement Sections 1-5 in order. Tests pass locally (`bun run test`).
3. PR review.
4. Merge → CI passes.
5. Deploy webhook function via `bunx supabase functions deploy whatsapp-webhook --no-verify-jwt --project-ref juoglkqtmjsziieqgmhf`.
6. Push v14 prompt to DB: `bun run prompts:sync`.
7. Flip active in DB via dashboard ↺ button → activate `affiliate_marketing/main/v14`.
8. Monitor for 24h:
   - `error_logs.error_type = 'mooz_lookup_failed'` → should be ≤1% of triggered turns.
   - `requires_human` rate vs. previous week → should not spike.
   - Spot-check 5 conversations of leads who answered the template while already-booked: did the bot follow the acknowledge pattern?
   - Rough call-count check: pull a sample day's `error_logs` for `mooz_lookup_failed` (a proxy — every check that fails logs; every success doesn't). If we see the expected ~3 calls per active conversation, the conditional logic is working.
9. **Rollback path**: dashboard ↺ → v13 (instant). Pre-check call site has no DB write — safe to leave deployed even if prompt rolls back.

## Open questions

None blocking — explicit decisions captured above. Future iteration if needed:

- Make the "warm-before-cancel" attempt-count configurable per agent.
- Add caching layer for Mooz lookups (60s within same conversation) if quota becomes a concern.
