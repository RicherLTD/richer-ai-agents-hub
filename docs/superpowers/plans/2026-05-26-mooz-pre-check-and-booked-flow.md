# Mooz Pre-Check + Already-Booked Conversation Flow — Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Eliminate the "lead claims booking → bot believes blindly" failure (Shirley, 2026-05-26 ~11:30 IL) and prevent the "where's my link?" dead-end by adding a conditional Mooz pre-check + a v14 prompt that branches on injected booking status.

**Architecture:** A pure formatter (`bookingStatusBlock.ts`) renders a `# Lead booking status` block for the system prompt with three branches (booked / not-booked / lookup-failed). The webhook conditionally invokes it (turn 1 OR the lead's last message matched a booking keyword regex). The active prompt becomes `v14.md`, which copies `v13.md` and adds two sections that teach Claude to read the injected block and follow per-branch behavior. `moozTools.ts:349` is patched so `book_meeting` success always includes the link-delivery line.

**Tech Stack:** TypeScript (strict, no `any`), Deno (Supabase Edge Functions), vitest + happy-path fetch mocks, Anthropic SDK tool-use, Supabase service_role from inside the function.

**Related spec:** `docs/superpowers/specs/2026-05-26-mooz-pre-check-and-booked-flow-design.md`

**Branch (you must create it before Task 1):** `feat/mooz-pre-check-and-booked-flow`

---

## File Structure

| File | Status | Responsibility |
|---|---|---|
| `supabase/functions/_shared/bookingStatusBlock.ts` | NEW | Pure formatter — renders 3 prompt-block branches; pure predicate — `shouldPreCheckMooz`; exported regex `BOOKING_KEYWORD_RE` |
| `supabase/functions/_shared/bookingStatusBlock.test.ts` | NEW | Unit tests for the formatter + the predicate + the regex |
| `supabase/functions/_shared/moozTools.ts` | MODIFY | One-line change to `next_step` in `handleBookMeeting` success path |
| `supabase/functions/_shared/moozTools.test.ts` | MODIFY | Add one assertion that the new `next_step` string contains the link line |
| `supabase/functions/whatsapp-webhook/index.ts` | MODIFY | Call site of the conditional pre-check, before `runAgentTurn` |
| `prompts/affiliate_marketing/main/v14.md` | NEW | Copy of v13 + two added sections |
| `prompts/affiliate_marketing/_active.json` | MODIFY | Flip `main` to `v14` (LAST step) |

---

## Task 0: Create branch and confirm green baseline

**Files:** none (branch + sanity)

- [ ] **Step 0.1: Create the feature branch**

```bash
git checkout -b feat/mooz-pre-check-and-booked-flow
```

- [ ] **Step 0.2: Confirm baseline tests pass**

```bash
bun run test
```

Expected: all existing tests pass (no failures). If anything is red, STOP — fix or report before proceeding.

- [ ] **Step 0.3: Confirm baseline lint passes**

```bash
bun run lint
```

Expected: zero errors.

---

## Task 1: Pure helper — `bookingStatusBlock.ts` with TDD

**Files:**
- Create: `supabase/functions/_shared/bookingStatusBlock.ts`
- Test: `supabase/functions/_shared/bookingStatusBlock.test.ts`

- [ ] **Step 1.1: Write the failing test file**

Create `supabase/functions/_shared/bookingStatusBlock.test.ts` with this exact content:

```ts
import { describe, expect, it } from "vitest";
import {
  BOOKING_KEYWORD_RE,
  renderBookingStatusBlock,
  shouldPreCheckMooz,
} from "./bookingStatusBlock.ts";

describe("renderBookingStatusBlock", () => {
  it("booked branch — labels HAS confirmed, includes IL-formatted time + behavior rules", () => {
    const block = renderBookingStatusBlock({
      booked: true,
      scheduledAt: "2026-05-26T15:00:00.000Z", // 18:00 IDT
      meetingId: "abc-123",
    });
    expect(block).toContain("# Lead booking status (live from Mooz)");
    expect(block).toContain("HAS a confirmed Zoom meeting");
    // Asia/Jerusalem rendering should include the local time digits 18:00
    expect(block).toContain("18:00");
    expect(block).toContain("הקישור יישלח אליך 5 דקות לפני הפגישה לוואטסאפ");
    expect(block).toContain("DO NOT call list_available_slots");
    expect(block).toContain("RESCHEDULE");
    expect(block).toContain("CANCEL");
  });

  it("not booked branch — instructs gentle correction if lead claims booking", () => {
    const block = renderBookingStatusBlock({ booked: false });
    expect(block).toContain("# Lead booking status (live from Mooz)");
    expect(block).toContain("NO confirmed booking");
    expect(block).toContain("אני בודק במערכת ולא רואה לך זום מתואם");
    expect(block).not.toContain("HAS a confirmed");
  });

  it("lookup failed branch — instructs degraded behavior", () => {
    const block = renderBookingStatusBlock({
      booked: false,
      error: "timeout",
    });
    expect(block).toContain("# Lead booking status (live from Mooz)");
    expect(block).toContain("temporarily unavailable");
    expect(block).toContain("we'll re-check next turn");
    expect(block).not.toContain("HAS a confirmed");
    expect(block).not.toContain("NO confirmed");
  });

  it("booked branch — handles unparseable scheduledAt without throwing", () => {
    const block = renderBookingStatusBlock({
      booked: true,
      scheduledAt: "not-an-iso-date",
      meetingId: "x",
    });
    // Should still render the block (fall back to raw string)
    expect(block).toContain("HAS a confirmed Zoom meeting");
    expect(block).toContain("not-an-iso-date");
  });
});

describe("BOOKING_KEYWORD_RE", () => {
  it.each([
    ["אני קבעתי להיום זום ב12", true],
    ["יש לי פגישה מחר", true],
    ["איפה הקישור?", true],
    ["אפשר link?", true],
    ["מתי הזום?", true],
    ["באיזה שעה?", true],
    ["אפשר להזיז?", true],
    ["אני רוצה לבטל", true],
    ["תיאמתי כבר", true],
    ["תאמתי עם היועץ", true],
    ["שלום, מה שלומך?", false],
    ["1", false],
    ["אני בעבודה", false],
    ["במשרד", false],
  ])("matches %j → %s", (text, expected) => {
    expect(BOOKING_KEYWORD_RE.test(text)).toBe(expected);
  });
});

describe("shouldPreCheckMooz", () => {
  it("returns false when moozClient is absent", () => {
    expect(
      shouldPreCheckMooz({
        moozClientPresent: false,
        claudeMessageCount: 1,
        lastInboundText: "אני קבעתי זום",
      }),
    ).toBe(false);
  });

  it("returns true on turn 1 even without keywords", () => {
    expect(
      shouldPreCheckMooz({
        moozClientPresent: true,
        claudeMessageCount: 1,
        lastInboundText: "1",
      }),
    ).toBe(true);
  });

  it("returns true on later turns when text contains a booking keyword", () => {
    expect(
      shouldPreCheckMooz({
        moozClientPresent: true,
        claudeMessageCount: 14,
        lastInboundText: "אני קבעתי להיום זום ב12",
      }),
    ).toBe(true);
  });

  it("returns false on later turns when text has no booking keyword", () => {
    expect(
      shouldPreCheckMooz({
        moozClientPresent: true,
        claudeMessageCount: 7,
        lastInboundText: "אני בעבודה עכשיו, אדבר אחר כך",
      }),
    ).toBe(false);
  });
});
```

- [ ] **Step 1.2: Run the test to verify it fails**

```bash
bunx vitest run supabase/functions/_shared/bookingStatusBlock.test.ts
```

Expected: failures — *"Cannot find module './bookingStatusBlock.ts'"* (or similar). All 4 describe blocks unable to load.

- [ ] **Step 1.3: Write the implementation file**

Create `supabase/functions/_shared/bookingStatusBlock.ts` with this exact content:

```ts
// bookingStatusBlock.ts
//
// Two related concerns, kept in one module because both serve the
// "pre-check Mooz before generating a reply" flow:
//
//   1. shouldPreCheckMooz — pure predicate. Decides whether THIS turn
//      warrants an HTTP call to Mooz. Returns true on turn 1 of the
//      conversation, or when the lead's latest message hints at a
//      scheduling concern (regex below). Skips otherwise to keep our
//      Mooz quota / latency budget reasonable.
//
//   2. renderBookingStatusBlock — pure formatter. Takes the lookup
//      result and produces the markdown system-prompt block that
//      tells Claude what we know + how to behave this turn. Three
//      branches: booked, not booked, lookup failed.
//
// Hebrew note: `\b` in JS regex doesn't fire around Hebrew code points.
// All Hebrew tokens in BOOKING_KEYWORD_RE intentionally omit `\b`. We
// accept a tiny chance of substring false-positives (rare in practice).

/** Mirror of MoozClient.lookupByPhone's return type. Duplicated here
 *  (rather than imported) so the helper is testable without pulling
 *  in Anthropic / Supabase runtime types. */
export type BookingLookupResult =
  | { booked: true; scheduledAt: string; meetingId: string }
  | { booked: false }
  | { booked: false; error: string };

/** Booking-related Hebrew + English keywords. If a lead's latest
 *  inbound matches this on a non-first turn, we re-check Mooz. */
export const BOOKING_KEYWORD_RE =
  /קבעתי|קבעת|זום|פגישה|קישור|link|מועד|מתי|שעה|להזיז|לשנות|לבטל|תאמתי|תיאמתי/i;

export interface ShouldPreCheckArgs {
  moozClientPresent: boolean;
  /** Length of the Claude messages array AT THE MOMENT of decision.
   *  After we persist the inbound and load history, length === 1 means
   *  this is the very first inbound (turn 1). */
  claudeMessageCount: number;
  /** Raw text of the latest inbound user message. Empty string if
   *  unavailable. */
  lastInboundText: string;
}

export function shouldPreCheckMooz(args: ShouldPreCheckArgs): boolean {
  if (!args.moozClientPresent) return false;
  if (args.claudeMessageCount === 1) return true;
  return BOOKING_KEYWORD_RE.test(args.lastInboundText);
}

export function renderBookingStatusBlock(lookup: BookingLookupResult): string {
  if (lookup.booked === true) {
    return renderBookedBranch(lookup.scheduledAt);
  }
  if ("error" in lookup) {
    return renderDegradedBranch();
  }
  return renderNotBookedBranch();
}

function renderBookedBranch(scheduledAtIso: string): string {
  const ilTime = formatIL(scheduledAtIso);
  return `# Lead booking status (live from Mooz)

This lead HAS a confirmed Zoom meeting at ${ilTime}.

Behavior rules for this turn:
- DO NOT call list_available_slots or book_meeting unless the lead explicitly asks to reschedule.
- Respond in ONE short Hebrew message following this pattern:
  1. Briefly acknowledge what the lead actually said (paraphrase their content, not just "תודה").
  2. Note that you can see they already have a meeting with the advisor.
  3. Encourage preparation: "תבוא עם שאלות והמטרות שלך".

- If the lead asks about the link or "where is the link" / "didn't get a link":
  Reply exactly: "הקישור יישלח אליך 5 דקות לפני הפגישה לוואטסאפ".

- If the lead wants to RESCHEDULE (move to a different time):
  Call list_available_slots with the new preferred date, then book_meeting. Mooz replaces the prior booking.

- If the lead wants to CANCEL:
  First attempt — warmly understand why and offer to reschedule: "אני שומע, מה גרם לך לרצות לבטל? אפשר גם פשוט להזיז את הפגישה למועד שיותר נוח לך".
  Second attempt (if they push again) — same warmth, last try.
  Third time — accept and escalate to the human advisor.

`;
}

function renderNotBookedBranch(): string {
  return `# Lead booking status (live from Mooz)

This lead has NO confirmed booking yet.

Behavior rules:
- Standard conversation flow applies — warm, ask the qualification questions, and when appropriate offer to schedule via list_available_slots.
- If the lead claims "אני כבר קבעתי" / "יש לי זום" / "קבעתי זום":
  Gently clarify: "אני בודק במערכת ולא רואה לך זום מתואם — בוא נסדר את זה עכשיו".
  Then proceed to list_available_slots.

`;
}

function renderDegradedBranch(): string {
  return `# Lead booking status (live from Mooz)

[Booking status check is temporarily unavailable. Proceed with the standard conversation flow. If the lead claims they already booked, accept it at face value for this turn — we'll re-check next turn. Do not call list_available_slots if the lead says they're already booked.]

`;
}

function formatIL(utcIso: string): string {
  try {
    const d = new Date(utcIso);
    if (Number.isNaN(d.getTime())) return utcIso;
    return d.toLocaleString("he-IL", {
      timeZone: "Asia/Jerusalem",
      weekday: "long",
      day: "2-digit",
      month: "2-digit",
      year: "numeric",
      hour: "2-digit",
      minute: "2-digit",
    });
  } catch {
    return utcIso;
  }
}
```

- [ ] **Step 1.4: Run the tests to verify they pass**

```bash
bunx vitest run supabase/functions/_shared/bookingStatusBlock.test.ts
```

Expected: all tests pass (4 in `renderBookingStatusBlock`, 14 in `BOOKING_KEYWORD_RE` (it.each), 4 in `shouldPreCheckMooz`). No failures.

- [ ] **Step 1.5: Commit**

```bash
git add supabase/functions/_shared/bookingStatusBlock.ts supabase/functions/_shared/bookingStatusBlock.test.ts
git commit -m "$(cat <<'EOF'
feat(mooz): add pre-check predicate + booking status block renderer

Two pure helpers used by the agent loop on every inbound turn:

- shouldPreCheckMooz: returns true on turn 1 OR when the lead's
  latest message matches a booking-keyword regex. Saves ~80% of
  Mooz lookup calls vs. checking every turn, while still catching
  mid-conversation false-claim cases (the Shirley-A pattern from
  2026-05-26).

- renderBookingStatusBlock: three branches (booked, not booked,
  lookup failed/degraded). Output is a markdown block prepended to
  the system prompt; v14 prompt teaches Claude to read it and
  honor per-branch behavior.

Co-Authored-By: Claude Opus 4.7 (1M context) <noreply@anthropic.com>
EOF
)"
```

---

## Task 2: Update `moozTools.ts` `next_step` hint with TDD

**Files:**
- Modify: `supabase/functions/_shared/moozTools.ts:349`
- Modify: `supabase/functions/_shared/moozTools.test.ts` (add assertion in the existing happy-path test)

- [ ] **Step 2.1: Add the failing assertion**

Open `supabase/functions/_shared/moozTools.test.ts`. Find the test `it("happy path updates conversation + lead_memory + returns booking_id", async () => {`. Add this assertion at the END of the test (just before the closing `});` of the `it` block), right after the existing assertions about the booking:

```ts
    // book_meeting's next_step hint must include the proactive link line
    // so Claude verbalises it in the confirmation message (v14 behavior).
    const parsedResultObj = JSON.parse(result.resultJson) as { next_step: string };
    expect(parsedResultObj.next_step).toContain(
      "הקישור יישלח אליך בוואטסאפ 5 דקות לפני הפגישה",
    );
```

> **Note:** If the test already declares a parsed variable name like `parsed` or `parsedResult`, REUSE that name — don't introduce `parsedResultObj`. Match whatever variable is already in scope.

- [ ] **Step 2.2: Run the test to confirm it fails**

```bash
bunx vitest run supabase/functions/_shared/moozTools.test.ts
```

Expected: ONE failure — `expect(...).toContain("הקישור יישלח אליך בוואטסאפ 5 דקות לפני הפגישה")` fails because the current `next_step` says *"Don't promise links — they're sent by email separately"*.

- [ ] **Step 2.3: Update the `next_step` in `moozTools.ts`**

Open `supabase/functions/_shared/moozTools.ts`. Find the success path of `handleBookMeeting` — the `return` statement around line 341-352, specifically the `next_step` field. Replace:

```ts
      next_step:
        "Confirm the booking to the lead in one short message. Include the time in Israel timezone in natural Hebrew. Don't promise links — they're sent by email separately.",
```

with:

```ts
      next_step:
        "Confirm the booking to the lead in one short message. Include the time in Israel timezone in natural Hebrew. ALWAYS include the line verbatim: \"הקישור יישלח אליך בוואטסאפ 5 דקות לפני הפגישה\". A short closing word ('בהצלחה!' or a single emoji) is fine after the line, but nothing more.",
```

- [ ] **Step 2.4: Run the test to verify it passes**

```bash
bunx vitest run supabase/functions/_shared/moozTools.test.ts
```

Expected: all tests pass, including the new assertion. No other tests should regress.

- [ ] **Step 2.5: Commit**

```bash
git add supabase/functions/_shared/moozTools.ts supabase/functions/_shared/moozTools.test.ts
git commit -m "$(cat <<'EOF'
feat(mooz): make book_meeting next_step include the link-delivery line

After Mooz confirms a booking, the bot must proactively tell the lead
that the WhatsApp link arrives 5 minutes before the meeting. Without
this, leads ask "where's the link?" after the conversation is paused
(zoom_scheduled tag) and get no reply.

Changes the next_step hint that Claude receives as the tool_result
content from book_meeting. The v14 prompt also reinforces this pattern
in its own copy.

Co-Authored-By: Claude Opus 4.7 (1M context) <noreply@anthropic.com>
EOF
)"
```

---

## Task 3: Wire conditional pre-check into `whatsapp-webhook/index.ts`

**Files:**
- Modify: `supabase/functions/whatsapp-webhook/index.ts`

**Why no test in this task:** The webhook has no existing integration-test harness; building one is multi-day work and out of scope for this PR. The conditional logic itself IS tested as a pure unit (`shouldPreCheckMooz` in Task 1). The integration is verified manually in Task 6.

- [ ] **Step 3.1: Add the import for the new helper**

Open `supabase/functions/whatsapp-webhook/index.ts`. Find the existing import block near the top (around line 50-51 where `moozClientFromEnv` and `MoozDispatchCtx` are imported). Add this line right after the existing Mooz-related imports:

```ts
import {
  renderBookingStatusBlock,
  shouldPreCheckMooz,
} from "../_shared/bookingStatusBlock.ts";
```

- [ ] **Step 3.2: Insert the conditional pre-check block**

Open `supabase/functions/whatsapp-webhook/index.ts`. Find `generateAndSendAgentResponseLocked`. The current code constructs `moozCtx` then immediately enters a `runAgentTurn` call with a `dateHeader` injected into the system prompt. Locate the lines that look like this (around the existing block at lines ~702-723):

```ts
  const moozCtx: MoozDispatchCtx | null = moozClient && meetingTypeId
    ? {
        admin: ctx.admin,
        mooz: moozClient,
        meetingTypeId,
        conversationId: ctx.conversationId,
        agentId: ctx.agentId,
        leadPhone: ctx.leadPhone,
      }
    : null;

  let turnResult;
  const startTime = new Date();
  // Inject today's date in Asia/Jerusalem so the model resolves
```

Insert the following block on a new line BETWEEN the closing brace of `moozCtx = ... : null;` and the `let turnResult;` line (i.e., right after the `: null;` of moozCtx, before `let turnResult`):

```ts

  // ── Pre-check Mooz for an existing booking ───────────────────────
  // Runs only when we have a Mooz client AND either it's the very first
  // inbound of this conversation OR the lead's latest message mentions
  // scheduling. Output is a markdown block prepended to the system
  // prompt so v14 can branch on it. Fail-open: any error => degraded
  // block, not a hard skip of the turn.
  const lastClaudeMsg = turn.claudeMessages[turn.claudeMessages.length - 1];
  const lastInboundText =
    lastClaudeMsg?.role === "user" && typeof lastClaudeMsg.content === "string"
      ? lastClaudeMsg.content
      : "";
  const preCheckArgs = {
    moozClientPresent: moozClient !== null,
    claudeMessageCount: turn.claudeMessages.length,
    lastInboundText,
  };
  let bookingStatusBlock = "";
  if (moozClient && shouldPreCheckMooz(preCheckArgs)) {
    try {
      const lookup = await moozClient.lookupByPhone(ctx.leadPhone);
      bookingStatusBlock = renderBookingStatusBlock(lookup);
    } catch (err) {
      await logError({
        admin: ctx.admin,
        source: AGENT_LOOP_SOURCE,
        errorType: "mooz_lookup_failed",
        level: "warn",
        message: err instanceof Error ? err.message : String(err),
        context: {
          lead_phone: ctx.leadPhone,
          trigger:
            preCheckArgs.claudeMessageCount === 1 ? "first_turn" : "keyword",
        },
        agentId: ctx.agentId,
        conversationId: ctx.conversationId,
      });
      bookingStatusBlock = renderBookingStatusBlock({
        booked: false,
        error: "lookup_failed",
      });
    }
  }
```

- [ ] **Step 3.3: Prepend `bookingStatusBlock` to the system prompt**

Find the existing `systemPrompt: dateHeader + turn.promptContent,` line in the `runAgentTurn` call (around line ~732). Replace it with:

```ts
      systemPrompt: dateHeader + bookingStatusBlock + turn.promptContent,
```

(Just add `+ bookingStatusBlock` between `dateHeader` and `+ turn.promptContent`.)

- [ ] **Step 3.4: Run full test suite to confirm no regressions**

```bash
bun run test
```

Expected: ALL tests pass. The new `bookingStatusBlock.test.ts` tests from Task 1 + the updated `moozTools.test.ts` test from Task 2 are now part of the run. Zero failures.

- [ ] **Step 3.5: Run lint**

```bash
bun run lint
```

Expected: zero errors. If there are unused-import warnings on `MoozDispatchCtx` or other Mooz symbols, those are not from our changes — leave them.

- [ ] **Step 3.6: Build the React side (catches TS errors imported by client code)**

```bash
bun run build
```

Expected: clean build, zero errors. (The webhook is Deno and typed at deploy-time by Supabase; the React side is typed by vite/tsc. Our new helper `bookingStatusBlock.ts` is pure TS and is exercised by the vitest run in Step 3.4 — any type drift would surface there.)

- [ ] **Step 3.7: Commit**

```bash
git add supabase/functions/whatsapp-webhook/index.ts
git commit -m "$(cat <<'EOF'
feat(webhook): conditional Mooz pre-check before agent turn

Adds the actual call site for shouldPreCheckMooz + renderBookingStatusBlock
introduced in the previous commit. Order of operations per inbound:

  1. agentCfg + moozClient already constructed (existing code)
  2. NEW: derive lastInboundText from the loaded history
  3. NEW: if shouldPreCheckMooz, call mooz.lookupByPhone (fail-open on error)
  4. NEW: prepend renderBookingStatusBlock(...) into systemPrompt
  5. runAgentTurn as before

Fail-open: any Mooz timeout/4xx/parse-error => "degraded" block that
tells Claude to take the lead at face value for this turn. We never
block the agent on a Mooz outage.

Co-Authored-By: Claude Opus 4.7 (1M context) <noreply@anthropic.com>
EOF
)"
```

---

## Task 4: New prompt `prompts/affiliate_marketing/main/v14.md`

**Files:**
- Create: `prompts/affiliate_marketing/main/v14.md`

**No tests** (prompts are content). Verification is in the next task (sync + smoke).

- [ ] **Step 4.1: Copy v13 to v14**

```bash
cp prompts/affiliate_marketing/main/v13.md prompts/affiliate_marketing/main/v14.md
```

- [ ] **Step 4.2: Update the frontmatter notes line**

Open `prompts/affiliate_marketing/main/v14.md`. The first lines are frontmatter:

```markdown
---
notes: v13 — ...
---
```

Replace the `notes:` value so the file's frontmatter becomes:

```markdown
---
notes: v14 — adds Mooz pre-check branching (booked/not booked/degraded) + proactive link-delivery line in book_meeting confirmation + soft-handle for cancellation requests. Authored 2026-05-26.
---
```

- [ ] **Step 4.3: Insert the new "Lead booking status handling" section**

Open `prompts/affiliate_marketing/main/v14.md`. Find the existing `## Identity & Role` section (one of the first sections after the frontmatter). Insert this NEW section IMMEDIATELY AFTER the Identity & Role section, BEFORE whatever section follows it:

```markdown
## מצב booking של הליד — קרא לפני כל תגובה

בראש ה־system prompt (לפני התוכן של ה־prompt הזה) **יכולה להופיע** כותרת `# Lead booking status (live from Mooz)`. **אם היא קיימת — תקרא אותה לפני שאתה מנסח תגובה.** התוכן שלה קובע את ההתנהגות שלך לתור הזה:

- אם כתוב **HAS a confirmed Zoom meeting** → עקוב אחר ההוראות הספציפיות שמופיעות מתחת בבלוק. זה דורס את זרימת החימום הרגילה — אל תשאל שאלות חימום, אל תציע slots, אל תקרא ל־list_available_slots. הליד כבר בוקד.
- אם כתוב **NO confirmed booking** → המשך זרימה רגילה (חימום + 5 שאלות + הצעת זום).
- אם כתוב **temporarily unavailable** → המשך זרימה רגילה. אם הליד טוען שכבר קבע — קבל את זה ב־face value לתור הזה, אל תקרא ל־list_available_slots.

**אם הבלוק לא קיים** → המשך זרימה רגילה, התייחס כאילו הליד לא booked.

```

- [ ] **Step 4.4: Insert the new "After successful book_meeting" section**

In the same file, find the section about the booking/scheduling flow (the part of v13 that talks about offering Zoom — likely near the end of the existing prompt, around the conversation-flow section). Add this NEW section as the LAST section of the file, after everything else:

```markdown
## אחרי book_meeting הצליח

תגובת האישור חייבת לכלול בדיוק את שורת הקישור באופן פרואקטיבי:

> "סגור [שם] 🙌 [יום + שעה בעברית טבעית]. הקישור יישלח אליך בוואטסאפ 5 דקות לפני הפגישה. בהצלחה!"

**אל תוסיף:** שאלות נוספות, "תרגישי חופשי לשאול", "תיהיה לך כיף", או טקסט אחרי "בהצלחה!". התגובה חייבת להיות ממוקדת בלוגיסטיקה.

הסיבה: אחרי book_meeting השיחה עוברת ל־status=paused. אם הליד שואל "איפה הקישור?" אחר כך — לא תהיה לך הזדמנות לענות. הוא חייב לקבל את התשובה כבר עכשיו.
```

- [ ] **Step 4.5: Commit**

```bash
git add prompts/affiliate_marketing/main/v14.md
git commit -m "$(cat <<'EOF'
feat(prompts): v14 — branches on Mooz pre-check + proactive link line

Two new sections on top of v13:

- "מצב booking של הליד" — teaches Claude to read the injected
  `# Lead booking status (live from Mooz)` block (rendered by the
  webhook from a real Mooz lookup) and override the warming flow
  when the lead is already booked.

- "אחרי book_meeting הצליח" — pins the confirmation message format
  so the WhatsApp-link-delivery line is verbalised proactively.

Authored 2026-05-26. Not yet active — flip in a later commit after
prompts:sync.

Co-Authored-By: Claude Opus 4.7 (1M context) <noreply@anthropic.com>
EOF
)"
```

---

## Task 5: Flip active prompt to v14 + sync to DB

**Files:**
- Modify: `prompts/affiliate_marketing/_active.json`

- [ ] **Step 5.1: Flip `_active.json`**

Open `prompts/affiliate_marketing/_active.json`. Current contents:

```json
{"main":"v13","memory_extractor":"v2"}
```

Change to:

```json
{"main":"v14","memory_extractor":"v2"}
```

- [ ] **Step 5.2: Run prompts:sync to push v14 + the new active row to the DB**

```bash
bun run prompts:sync
```

Expected output: lines indicating that `affiliate_marketing/main/v14` was upserted and is now `is_active=true`, and that the previous `main/v13` was flipped to `is_active=false`. No errors.

- [ ] **Step 5.3: Verify in DB that v14 is the only active main prompt**

```bash
set -a; source .env.local; set +a
curl -sX POST "https://api.supabase.com/v1/projects/${SUPABASE_PROJECT_REF}/database/query" \
  -H "Authorization: Bearer ${SUPABASE_ACCESS_TOKEN}" \
  -H "Content-Type: application/json" \
  -d '{"query":"SELECT version, prompt_type, is_active FROM prompts WHERE prompt_type = $$main$$ ORDER BY created_at DESC LIMIT 5;"}'
```

Expected: top row shows `version=v14, is_active=true`. All other rows for `main` should be `is_active=false`.

- [ ] **Step 5.4: Commit**

```bash
git add prompts/affiliate_marketing/_active.json
git commit -m "$(cat <<'EOF'
chore(prompts): activate v14 for affiliate_marketing

Flips _active.json. prompts:sync was run against production
juoglkqtmjsziieqgmhf in the same step — DB reflects v14 as the only
active main prompt for affiliate_marketing.

Rollback path: dashboard ↺ button on the Prompts page (admin only)
flips is_active back to v13 instantly without redeploy.

Co-Authored-By: Claude Opus 4.7 (1M context) <noreply@anthropic.com>
EOF
)"
```

---

## Task 6: Deploy webhook + manual smoke test

**Files:** none (deploy + verification only)

- [ ] **Step 6.1: Deploy the webhook edge function**

```bash
bunx supabase functions deploy whatsapp-webhook \
  --no-verify-jwt \
  --project-ref juoglkqtmjsziieqgmhf
```

Expected: `Deployed Functions on project juoglkqtmjsziieqgmhf: whatsapp-webhook`. No errors.

- [ ] **Step 6.2: Smoke test scenario A — fresh lead replies to template**

In a real WhatsApp number that hasn't been booked, reply to the template message with "1". Wait for the bot's reply.

Expected: bot replies with a warm acknowledgement of "להכניס עוד כסף" and asks a follow-up question (standard v14 flow, not-booked branch). NO mention of "אני רוצה שאקבע" / list of times yet.

If the bot mentions seeing a booking that doesn't exist → ABORT, ROLLBACK (Step 6.4).

- [ ] **Step 6.3: Smoke test scenario B — already-booked lead claims a false booking**

Find a lead who has a future booking in Mooz (query as in Step 5.3 above — pick one with `current_tag='zoom_scheduled'` AND `zoom_scheduled_at` > NOW). Have the operator (or a tester) send "אני קבעתי זום מחר ב-15" or similar from that lead's phone via WhatsApp.

Expected: bot acknowledges the lead's message + says "ואני גם רואה שקבעת פגישה עם יועץ הלימודים שלנו" + encourages preparation. Does NOT call list_available_slots. Does NOT offer fresh slots.

If the bot offers fresh slots → ABORT, ROLLBACK.

- [ ] **Step 6.4: Rollback path (if any smoke test fails)**

Flip v14 → v13 immediately via the dashboard ↺ button on the Prompts page (admin only), OR run:

```bash
set -a; source .env.local; set +a
curl -sX POST "https://api.supabase.com/v1/projects/${SUPABASE_PROJECT_REF}/database/query" \
  -H "Authorization: Bearer ${SUPABASE_ACCESS_TOKEN}" \
  -H "Content-Type: application/json" \
  -d '{"query":"UPDATE prompts SET is_active = (version = $$v13$$) WHERE prompt_type = $$main$$ AND agent_id = (SELECT id FROM agents WHERE name = $$affiliate_marketing$$);"}'
```

The webhook code itself is safe to leave deployed (it adds a `bookingStatusBlock` to the prompt; v13 ignores unknown sections at the top of the prompt). But the prompt rollback restores known-good agent behavior immediately.

- [ ] **Step 6.5: Open the PR**

```bash
git push -u origin feat/mooz-pre-check-and-booked-flow

gh pr create --title "feat: Mooz pre-check + already-booked conversation flow (v14)" --body "$(cat <<'EOF'
## Summary

- Conditional Mooz pre-check (turn 1 OR booking keyword) — ~80% fewer Mooz API calls than every-turn while still catching mid-conversation false-claim cases like Shirley's on 2026-05-26.
- New pure helpers in `_shared/bookingStatusBlock.ts` (predicate + renderer + regex), unit tested.
- `book_meeting` `next_step` now instructs the proactive WhatsApp-link-delivery line.
- New prompt `main/v14.md` reads the injected booking-status block and branches behavior accordingly.

Closes the Shirley-2026-05-26 bug (conversation `12b38c79-3171-4164-a341-32256c6b305b`).

## Test plan

- [x] `bun run test` — unit tests pass (bookingStatusBlock, moozTools updated assertion)
- [x] `bun run lint` — clean
- [x] `bunx tsc --noEmit` — clean
- [ ] Manual smoke A: fresh lead replies "1" to template → standard v14 not-booked flow
- [ ] Manual smoke B: already-booked lead claims new booking → bot follows acknowledge-and-prepare pattern (no fresh slots offered)
- [ ] Monitor `error_logs` for `mooz_lookup_failed` rate in next 24h (should be ≤1% of triggered turns)

🤖 Generated with [Claude Code](https://claude.com/claude-code)
EOF
)"
```

Expected: the `gh pr create` command prints the PR URL. Open it for review.

---

## Post-merge checklist (NOT part of the plan execution, for operator reference)

- 24h monitoring of `error_logs.error_type = 'mooz_lookup_failed'` (threshold ≤1% of triggered turns).
- 24h monitoring of `requires_human` rate (must not spike — could indicate the cancel-handling section is too aggressive).
- Rotate the MOOZ_API_TOKEN the operator pasted in the chat during the spec phase (security hygiene).
- Delete the leftover `docs/n8n-migration-handoff.md` / `scripts/admin/provision-admin.ts` from the operator's stash if they're no longer needed.
- File a separate ticket for the recurring `memory-extractor / claude_invalid_json` errors (out of scope here).
