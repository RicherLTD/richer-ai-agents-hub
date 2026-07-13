// guardHint.ts
//
// Builds the system-prompt hint appended on the agent loop's SECOND
// attempt, after the first reply was rejected by a safety guard
// (validateAgentReply or judgeReply). The hint is reason-aware: a blanket
// "avoid times/prices" steer is right for currency/AI leaks, but WRONG for
// an invented meeting time during a real booking flow — there we want the
// model to re-offer a REAL slot, not to drop times entirely.

/** Non-time rejections (prices / income / AI disclosure): tell the model
 *  to avoid the forbidden patterns wholesale. */
export const GENERIC_GUARD_HINT =
  "\n\n<!-- RETRY: previous reply was blocked by a safety guard. Generate a response that avoids: specific prices, currency amounts, exact meeting times (HH:MM format), and numbers adjacent to אלף/K. Keep the reply in 1-2 sentences. -->";

/**
 * Build the guard-retry hint, tailored to the rejection reason.
 *
 * For "invented_meeting_time" we steer the model back to the grounded
 * slots instead of telling it to drop times entirely:
 *   - slots were offered this turn → list the exact allowed times so it
 *     can re-offer one of them;
 *   - no slots were retrieved → tell it to stop stating times and either
 *     call list_available_slots or ask the lead for a convenient day.
 *
 * Any other reason falls back to GENERIC_GUARD_HINT.
 */
export function buildGuardHint(
  reason: string,
  allowedMeetingTimes: ReadonlyArray<string>,
): string {
  if (reason !== "invented_meeting_time") return GENERIC_GUARD_HINT;
  if (allowedMeetingTimes.length > 0) {
    return (
      "\n\n<!-- RETRY: your previous reply named a meeting time that is NOT a real available slot. " +
      "You may ONLY state these exact times (Israel time): " +
      allowedMeetingTimes.join(", ") +
      ". Offer 2-3 of them and let the lead pick — never invent any other time. Keep the reply in 1-2 sentences. -->"
    );
  }
  return (
    "\n\n<!-- RETRY: your previous reply named a specific meeting time (HH:MM) but NO real slots were retrieved this turn. " +
    "Do NOT state any specific time. Either call list_available_slots first to get real slots, or ask the lead which day/time is convenient. Keep the reply in 1-2 sentences. -->"
  );
}
