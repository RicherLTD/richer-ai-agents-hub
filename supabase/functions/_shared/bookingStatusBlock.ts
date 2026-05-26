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
  /קבעתי|קבעת|זום|פגישה|פגישות|קישור|link|מועד|מתי|שעה|להזיז|לשנות|להעביר|לבטל|מבטל|מבטלת|אבטל|תאריך|תאמתי|תיאמתי/i;

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
  Reply exactly: "הקישור יישלח אליך בוואטסאפ 5 דקות לפני הפגישה".

- If the lead wants to RESCHEDULE (move to a different time):
  Call list_available_slots with the new preferred date, then book_meeting. Mooz replaces the prior booking.

- If the lead wants to CANCEL:
  First attempt — warmly understand why and offer to reschedule: "אני שומע, מה גרם לך לרצות לבטל? אפשר גם פשוט להזיז את הפגישה למועד שיותר נוח לך".
  Second attempt (if they push again) — same warmth, last try.
  Third time — accept their decision warmly ("בסדר, אני מבין. אם תרצה לקבוע שוב בעתיד אני כאן.") and STOP. Do not call any tools, do not propose anything else. The conversation will be left for the operator to follow up on — there is no automatic escalation tag.

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
