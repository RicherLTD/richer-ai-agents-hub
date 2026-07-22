import { describe, expect, it } from "vitest";
import {
  BOOKING_KEYWORD_RE,
  type BookingLookupResult,
  renderBookingStatusBlock,
  shouldPreCheckMooz,
} from "./bookingStatusBlock.ts";

// Compile-time guard: if mooz.ts's lookupByPhone return type ever drifts
// from BookingLookupResult, TypeScript catches it here. Erased at runtime
// (import type from mooz.ts is type-only — no runtime dep on esm.sh).
import type { MoozClient } from "./mooz.ts";
type _MoozReturnAssertion =
  Awaited<ReturnType<MoozClient["lookupByPhone"]>> extends BookingLookupResult
    ? true
    : never;
const _moozAssertion: _MoozReturnAssertion = true;
void _moozAssertion;

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
    expect(block).toContain("הקישור יישלח אליך בוואטסאפ 5 דקות לפני הפגישה");
    expect(block).toContain("DO NOT call list_available_slots");
    expect(block).toContain("RESCHEDULE");
    expect(block).toContain("CANCEL");
    // Post-booking the bot must stop warming and just answer the lead.
    expect(block).toContain("WARMING PHASE IS OVER");
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
    ["אני מבטל את הזום", true],
    ["מבטלת את הפגישה", true],
    ["אבטל מחר", true],
    ["פגישות שלי הסתיימו", true],
    ["באיזה תאריך?", true],
    ["אני רוצה להעביר את הפגישה", true],
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

  it("returns true when already booked, even without keywords", () => {
    // A lead who already has a confirmed Zoom must get the booked-status
    // block on every turn so the bot never re-offers a slot.
    expect(
      shouldPreCheckMooz({
        moozClientPresent: true,
        claudeMessageCount: 12,
        lastInboundText: "מגניב תודה רבה",
        alreadyBooked: true,
      }),
    ).toBe(true);
  });

  it("still returns false when already booked but moozClient is absent", () => {
    expect(
      shouldPreCheckMooz({
        moozClientPresent: false,
        claudeMessageCount: 12,
        lastInboundText: "מגניב תודה רבה",
        alreadyBooked: true,
      }),
    ).toBe(false);
  });
});
