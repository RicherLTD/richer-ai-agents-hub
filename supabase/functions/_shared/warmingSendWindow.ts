// warmingSendWindow.ts
//
// The hours a CRM-warming opener may leave, in Asia/Jerusalem time.
//
// Warming needs its own window because the agent's quiet hours can't carry it:
// affiliate_marketing has none (the bot answers leads 24/7, and that must stay
// true), so without this the daily cap resetting at midnight released the whole
// backlog at 00:00 — "היי, מה קורה?" to cold leads in the middle of the night.
// Delayed openers (15/30 days after the status change) can also come due at any
// hour.
//
// Outside the window a warming row is DEFERRED, never cancelled: it stays
// pending and competes for the first slots of the morning. Only warming rows
// consult this; first-touch and broadcast templates are unaffected.

import { isQuietHourNow, type QuietHoursWindow } from "./quietHours.ts";

/** First hour (IL) a warming opener may be sent. */
export const WARMING_SEND_START_HOUR_IL = 9;
/** Hour (IL) from which warming openers wait for the next morning. */
export const WARMING_SEND_END_HOUR_IL = 20;

const WARMING_OFF_HOURS: QuietHoursWindow = {
  startIl: WARMING_SEND_END_HOUR_IL,
  endIl: WARMING_SEND_START_HOUR_IL,
};

export function isOutsideWarmingSendWindow(at: Date = new Date()): boolean {
  return isQuietHourNow(WARMING_OFF_HOURS, at);
}
