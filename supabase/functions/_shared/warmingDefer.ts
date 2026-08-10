// warmingDefer.ts
//
// One predicate, extracted so it is testable without importing the
// dispatcher's index.ts (which calls Deno.serve at module load).
//
// It answers: "is this lead mid-conversation right now?" — the check that stops
// a CRM-warming opener from landing on top of a live exchange. The opener is a
// generic "היי, מה קורה?"; firing it while the bot is actively answering the
// lead's real question reads as a non-sequitur, and can race the agent loop's
// in-flight reply.
//
// Only warming rows consult this. Ordinary scheduled templates (first-touch,
// broadcasts) are unaffected.

/** How long after a lead's own message a CRM-warming opener is held back.
 *  Long enough to cover an in-flight agent turn and a normal back-and-forth;
 *  short enough that a lead who drifts off still gets the nudge the same hour. */
export const WARMING_QUIET_MINUTES = 60;

/**
 * True when the lead wrote to us inside the warming quiet window.
 *
 * A null last_inbound_at means the lead has never written to us at all — a pure
 * CRM lead. That is emphatically NOT "active": those are precisely the leads the
 * opener exists for, so they must not be deferred.
 */
export function isRecentInbound(
  lastInboundAt: string | null,
  now: number = Date.now(),
): boolean {
  if (!lastInboundAt) return false;
  const t = new Date(lastInboundAt).getTime();
  if (Number.isNaN(t)) return false;
  return now - t < WARMING_QUIET_MINUTES * 60_000;
}
