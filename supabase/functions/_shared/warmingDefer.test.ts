import { describe, expect, it } from "vitest";
import { isRecentInbound, WARMING_QUIET_MINUTES } from "./warmingDefer.ts";

const NOW = new Date("2026-08-10T12:00:00.000Z").getTime();

function minutesAgoIso(n: number): string {
  return new Date(NOW - n * 60_000).toISOString();
}

describe("isRecentInbound", () => {
  it("defers while the lead is mid-conversation", () => {
    expect(isRecentInbound(minutesAgoIso(5), NOW)).toBe(true);
    expect(isRecentInbound(minutesAgoIso(WARMING_QUIET_MINUTES - 1), NOW)).toBe(true);
  });

  it("sends once the lead has gone quiet", () => {
    expect(isRecentInbound(minutesAgoIso(WARMING_QUIET_MINUTES), NOW)).toBe(false);
    expect(isRecentInbound(minutesAgoIso(120), NOW)).toBe(false);
  });

  // The whole point of the feature: a lead who exists only in the CRM and has
  // never messaged us must NOT be treated as "in an active conversation".
  it("does not defer a lead who has never written to us", () => {
    expect(isRecentInbound(null, NOW)).toBe(false);
  });

  it("does not defer on an unparseable timestamp", () => {
    expect(isRecentInbound("not-a-date", NOW)).toBe(false);
  });

  it("defers on a future timestamp rather than sending into a live chat", () => {
    expect(isRecentInbound(minutesAgoIso(-5), NOW)).toBe(true);
  });
});
