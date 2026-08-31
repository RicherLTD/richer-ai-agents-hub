import { describe, expect, it } from "vitest";
import {
  ATTENTION_ALERT_DEDUP_MS,
  ATTENTION_REASON_LABELS,
  shouldAlertNow,
} from "./needsAttention.ts";

const NOW = new Date("2026-08-30T12:00:00.000Z").getTime();

describe("shouldAlertNow", () => {
  it("alerts when nothing was ever sent for this conversation", () => {
    expect(shouldAlertNow({ lastAlertedAt: null, previousReason: null, reason: "bot_failed", nowMs: NOW }))
      .toBe(true);
  });

  it("suppresses a repeat of the SAME reason inside the window", () => {
    const recent = new Date(NOW - 60 * 60 * 1000).toISOString(); // 1h ago
    expect(
      shouldAlertNow({
        lastAlertedAt: recent,
        previousReason: "bot_failed",
        reason: "bot_failed",
        nowMs: NOW,
      }),
    ).toBe(false);
  });

  it("alerts again once the window has passed", () => {
    const old = new Date(NOW - ATTENTION_ALERT_DEDUP_MS - 1000).toISOString();
    expect(
      shouldAlertNow({
        lastAlertedAt: old,
        previousReason: "bot_failed",
        reason: "bot_failed",
        nowMs: NOW,
      }),
    ).toBe(true);
  });

  it("a DIFFERENT reason always alerts — it is new information for the operator", () => {
    const recent = new Date(NOW - 60 * 1000).toISOString(); // 1 min ago
    expect(
      shouldAlertNow({
        lastAlertedAt: recent,
        previousReason: "bot_failed",
        reason: "calendar_closed",
        nowMs: NOW,
      }),
    ).toBe(true);
  });

  it("tolerates an unparseable timestamp by alerting — never swallow a lead", () => {
    expect(
      shouldAlertNow({
        lastAlertedAt: "not-a-date",
        previousReason: "bot_failed",
        reason: "bot_failed",
        nowMs: NOW,
      }),
    ).toBe(true);
  });
});

describe("ATTENTION_REASON_LABELS", () => {
  it("gives every reason a Hebrew label for the operator alert", () => {
    for (const reason of ["bot_failed", "calendar_closed", "existing_student", "red_flag"] as const) {
      expect(ATTENTION_REASON_LABELS[reason]).toBeTruthy();
      // The label lands in a Meta template variable — no newlines allowed.
      expect(ATTENTION_REASON_LABELS[reason]).not.toMatch(/[\n\r\t]/);
    }
  });
});
