// quietHours.ts
//
// Per-agent quiet-hours check, evaluated in Asia/Jerusalem time. Used by
// both the agent reply loop (skip Claude calls) and the template dispatcher
// (defer sends).
//
// Semantics:
//   - Both nulls → no quiet hours (24/7).
//   - start === end → entire day is quiet (effectively paused).
//   - start > end → wraps midnight (the common case: 20 → 8).
//   - start < end → quiet within the day (e.g. 13 → 17 for siesta).

export interface QuietHoursWindow {
  /** 0-23 hour in Asia/Jerusalem, when quiet hours BEGIN. Null disables. */
  startIl: number | null;
  /** 0-23 hour in Asia/Jerusalem, when quiet hours END. Null disables. */
  endIl: number | null;
}

/** Hour-of-day 0-23 in Asia/Jerusalem at the given moment (or now). */
export function currentHourIl(at: Date = new Date()): number {
  const parts = new Intl.DateTimeFormat("en-GB", {
    timeZone: "Asia/Jerusalem",
    hour: "2-digit",
    hour12: false,
  }).formatToParts(at);
  const hourPart = parts.find((p) => p.type === "hour");
  if (!hourPart) return 0;
  const n = parseInt(hourPart.value, 10);
  return Number.isFinite(n) ? n : 0;
}

export function isQuietHourNow(window: QuietHoursWindow, at: Date = new Date()): boolean {
  const { startIl, endIl } = window;
  if (startIl == null || endIl == null) return false;
  const hour = currentHourIl(at);
  if (startIl === endIl) return true; // configured-as-paused
  if (startIl < endIl) {
    // Quiet within the same day: e.g. 13 → 17.
    return hour >= startIl && hour < endIl;
  }
  // Wraps midnight: e.g. 20 → 8. Quiet if hour >= 20 OR hour < 8.
  return hour >= startIl || hour < endIl;
}
