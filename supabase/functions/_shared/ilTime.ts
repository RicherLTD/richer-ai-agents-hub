// ilTime.ts
//
// One job: turn a UTC ISO timestamp into the Asia/Jerusalem wall-clock
// time as "HH:MM" (24h). Used to ground the invented-meeting-time guard
// — the only times the bot is allowed to state to a lead are the ones
// that came back from Mooz (list_available_slots / book_meeting) or an
// existing booking from the pre-check lookup, all expressed in this
// canonical IL HH:MM form so validateAgentReply can compare them against
// whatever HH:MM the model wrote.

/**
 * Returns the Israel-local "HH:MM" (24h, zero-padded) for a UTC ISO
 * timestamp, or "" if the input can't be parsed. Example:
 *   "2026-05-21T18:30:00.000Z" → "21:30" (summer, IDT +3)
 */
export function formatIlHHMM(utcIso: string): string {
  try {
    const d = new Date(utcIso);
    if (Number.isNaN(d.getTime())) return "";
    return d.toLocaleTimeString("en-GB", {
      timeZone: "Asia/Jerusalem",
      hour: "2-digit",
      minute: "2-digit",
      hourCycle: "h23",
    });
  } catch {
    return "";
  }
}

/**
 * Returns the Israel-local calendar date as "YYYY-MM-DD" for a UTC ISO
 * timestamp, or "" if unparseable. Used to compare the lead's requested
 * date against the last date Mooz actually has open — the booking window
 * is only ~24 business hours wide, so "is your date even reachable?" is a
 * question the bot has to answer on almost every scheduling turn.
 */
export function formatIlDate(utcIso: string): string {
  try {
    const d = new Date(utcIso);
    if (Number.isNaN(d.getTime())) return "";
    // en-CA gives ISO-ordered YYYY-MM-DD.
    return d.toLocaleDateString("en-CA", { timeZone: "Asia/Jerusalem" });
  } catch {
    return "";
  }
}
