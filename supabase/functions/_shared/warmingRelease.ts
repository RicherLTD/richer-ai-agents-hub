// warmingRelease.ts
//
// The "bank" release policy: given what an agent has already sent, decide how
// many warming messages may leave right now, and in what order.
//
// Pure — no Supabase, no fetch — so the pacing rules that stand between us and
// a Meta quality downgrade are unit-testable rather than only observable in
// production.
//
// Two controls, deliberately different in kind:
//   * min gap  — shapes the BURST. Stops fifty templates leaving in a loop.
//   * daily cap — shapes the VOLUME. Spacing alone still permits ~900/day at a
//     90s gap, which is not a ramp-up. The cap is the real brake.
//
// Both are per agent because Meta scores quality per phone number.

export type ReleaseBlockReason = "daily_cap" | "min_gap";

export interface AllowanceArgs {
  /** When this agent last actually sent a warming message. Null = never. */
  lastSentAt: string | null;
  /** Warming messages already sent by this agent since local midnight. */
  sentToday: number;
  /** agents.warming_min_gap_seconds. 0 disables spacing. */
  minGapSeconds: number;
  /** agents.warming_daily_cap. */
  dailyCap: number;
}

export interface Allowance {
  /** How many warming rows may be sent right now. */
  allowed: number;
  /** Why allowed is 0. Null when sending is permitted. */
  blockedBy: ReleaseBlockReason | null;
  /** Seconds until the gap clears. Only meaningful for blockedBy 'min_gap'. */
  retryAfterSeconds: number;
}

/**
 * A cap of 0 means zero sends, NOT unlimited.
 *
 * This is a deliberate fail-closed reading: an operator who types 0 into a
 * "daily cap" box and gets unlimited messaging to leads without provable
 * opt-in is the worst possible surprise in this feature. Turning warming off
 * is what `agents.crm_warming_enabled` is for.
 */
export function computeWarmingAllowance(
  args: AllowanceArgs,
  now: Date = new Date(),
): Allowance {
  const cap = Number.isFinite(args.dailyCap) ? Math.max(0, Math.trunc(args.dailyCap)) : 0;
  const sent = Number.isFinite(args.sentToday) ? Math.max(0, Math.trunc(args.sentToday)) : 0;
  const remaining = Math.max(0, cap - sent);

  if (remaining === 0) {
    return { allowed: 0, blockedBy: "daily_cap", retryAfterSeconds: 0 };
  }

  const gap = Number.isFinite(args.minGapSeconds) ? Math.max(0, Math.trunc(args.minGapSeconds)) : 0;
  if (gap === 0) {
    // Spacing disabled — the cap is the only limit.
    return { allowed: remaining, blockedBy: null, retryAfterSeconds: 0 };
  }

  if (args.lastSentAt) {
    const last = new Date(args.lastSentAt).getTime();
    // An unparseable timestamp must not hand out an unlimited allowance.
    // Treat it as "just sent" and wait out a full gap.
    if (Number.isNaN(last)) {
      return { allowed: 0, blockedBy: "min_gap", retryAfterSeconds: gap };
    }
    const elapsedMs = now.getTime() - last;
    // A future timestamp (clock skew) is also treated as "just sent".
    if (elapsedMs < gap * 1000) {
      const waitMs = gap * 1000 - elapsedMs;
      return {
        allowed: 0,
        blockedBy: "min_gap",
        retryAfterSeconds: Math.max(0, Math.ceil(waitMs / 1000)),
      };
    }
  }

  // Spacing is enforced one message at a time: releasing two at once would
  // itself violate the gap between them.
  return { allowed: 1, blockedBy: null, retryAfterSeconds: 0 };
}

export interface PrioritisableRow {
  release_priority?: number | null;
  scheduled_for?: string | null;
}

/**
 * Highest priority first, then oldest first inside a priority band.
 *
 * This is what stops a lead who ghosted a Zoom yesterday queueing behind a
 * batch of cold "no answer day 3" rows once the daily cap starts binding.
 * Returns a new array; the input is not mutated.
 */
export function sortByReleasePriority<T extends PrioritisableRow>(rows: ReadonlyArray<T>): T[] {
  return [...rows].sort((a, b) => {
    const pa = typeof a.release_priority === "number" ? a.release_priority : 50;
    const pb = typeof b.release_priority === "number" ? b.release_priority : 50;
    if (pa !== pb) return pb - pa;
    const ta = a.scheduled_for ? new Date(a.scheduled_for).getTime() : 0;
    const tb = b.scheduled_for ? new Date(b.scheduled_for).getTime() : 0;
    const safeA = Number.isNaN(ta) ? 0 : ta;
    const safeB = Number.isNaN(tb) ? 0 : tb;
    return safeA - safeB;
  });
}

/**
 * ISO instant of the most recent local midnight in Asia/Jerusalem — the
 * boundary the daily cap counts from.
 *
 * Derived by subtracting the current local wall-clock time rather than by
 * assuming a UTC offset, so it stays correct across Israel's DST changes.
 * (The one hour after a DST transition is off by an hour; the consequence is
 * at most a handful of messages counted against the wrong day, which is not
 * worth a timezone library in an edge function.)
 */
export function israelDayStartIso(now: Date = new Date()): string {
  const parts = new Intl.DateTimeFormat("en-GB", {
    timeZone: "Asia/Jerusalem",
    hour: "2-digit",
    minute: "2-digit",
    second: "2-digit",
    hour12: false,
  }).formatToParts(now);
  const get = (t: string) => Number(parts.find((p) => p.type === t)?.value ?? "0");
  // "24" appears at midnight in some ICU versions.
  const hours = get("hour") % 24;
  const elapsedMs = ((hours * 60 + get("minute")) * 60 + get("second")) * 1000;
  return new Date(now.getTime() - elapsedMs).toISOString();
}
