import { describe, expect, it } from "vitest";
import { asInt, coercePayload, withinCooldown } from "./validate.ts";

const NOW = new Date("2026-08-10T12:00:00.000Z").getTime();

function daysAgoIso(n: number): string {
  return new Date(NOW - n * 24 * 60 * 60 * 1000).toISOString();
}

describe("asInt", () => {
  it("accepts numbers and numeric strings — Make sends both", () => {
    expect(asInt(60)).toBe(60);
    expect(asInt("60")).toBe(60);
    expect(asInt(" 60 ")).toBe(60);
    expect(asInt(0)).toBe(0);
    expect(asInt("-3")).toBe(-3);
  });

  it("rejects anything that isn't a whole number", () => {
    expect(asInt(6.5)).toBeNull();
    expect(asInt("6.5")).toBeNull();
    expect(asInt("60abc")).toBeNull();
    expect(asInt("")).toBeNull();
    expect(asInt(null)).toBeNull();
    expect(asInt(undefined)).toBeNull();
    expect(asInt(NaN)).toBeNull();
    expect(asInt(true)).toBeNull();
    expect(asInt({})).toBeNull();
  });
});

describe("coercePayload", () => {
  const valid = {
    product: "B",
    lead_phone: "0501234567",
    status_sub: 60,
  };

  it("accepts the minimum payload and canonicalises the phone", () => {
    const p = coercePayload(valid);
    expect(p).not.toBeNull();
    expect(p!.product).toBe("B");
    expect(p!.status_sub).toBe(60);
    // toCanonicalPhone: digits + 972 country code, no leading '+'.
    expect(p!.lead_phone).toBe("972501234567");
    expect(p!.status_main).toBeNull();
    expect(p!.lead_name).toBeNull();
    expect(p!.rep_note).toBeNull();
    expect(p!.fireberry_lead_id).toBeNull();
  });

  it("canonicalises every phone format Make might send to the same value", () => {
    const forms = ["0501234567", "+972501234567", "972501234567", "050-123-4567"];
    const canonical = forms.map((f) => coercePayload({ ...valid, lead_phone: f })?.lead_phone);
    expect(new Set(canonical).size).toBe(1);
    expect(canonical[0]).toBe("972501234567");
  });

  it("carries the optional fields through", () => {
    const p = coercePayload({
      ...valid,
      status_main: "5",
      lead_name: "  ישראל  ",
      rep_note: "אמר שאין לו זמן",
      fireberry_lead_id: "abc-123",
    });
    expect(p!.status_main).toBe(5);
    expect(p!.lead_name).toBe("ישראל");
    expect(p!.rep_note).toBe("אמר שאין לו זמן");
    expect(p!.fireberry_lead_id).toBe("abc-123");
  });

  it("treats whitespace-only optional fields as absent", () => {
    const p = coercePayload({ ...valid, lead_name: "   ", rep_note: "" });
    expect(p!.lead_name).toBeNull();
    expect(p!.rep_note).toBeNull();
  });

  // status_sub === 0 is falsy; a naive `!statusSub` guard would reject it.
  it("accepts status_sub of 0", () => {
    expect(coercePayload({ ...valid, status_sub: 0 })?.status_sub).toBe(0);
  });

  it("rejects payloads missing a required field", () => {
    expect(coercePayload({ ...valid, product: undefined })).toBeNull();
    expect(coercePayload({ ...valid, product: "  " })).toBeNull();
    expect(coercePayload({ ...valid, lead_phone: undefined })).toBeNull();
    expect(coercePayload({ ...valid, status_sub: undefined })).toBeNull();
    expect(coercePayload({ ...valid, status_sub: "not-a-number" })).toBeNull();
  });

  it("rejects an unusable phone rather than writing a junk row", () => {
    expect(coercePayload({ ...valid, lead_phone: "abc" })).toBeNull();
    expect(coercePayload({ ...valid, lead_phone: "123" })).toBeNull();
  });

  it("rejects non-objects", () => {
    expect(coercePayload(null)).toBeNull();
    expect(coercePayload(undefined)).toBeNull();
    expect(coercePayload("string")).toBeNull();
    expect(coercePayload(42)).toBeNull();
  });
});

describe("withinCooldown", () => {
  it("blocks a second opener inside the window", () => {
    expect(withinCooldown(daysAgoIso(3), 7, NOW)).toBe(true);
  });

  it("allows one once the window has passed", () => {
    expect(withinCooldown(daysAgoIso(8), 7, NOW)).toBe(false);
  });

  it("treats the exact boundary as expired", () => {
    expect(withinCooldown(daysAgoIso(7), 7, NOW)).toBe(false);
  });

  // A lead who has never been warmed must never be blocked.
  it("never blocks when there is no previous warm", () => {
    expect(withinCooldown(null, 7, NOW)).toBe(false);
  });

  it("never blocks when cooldown is disabled", () => {
    expect(withinCooldown(daysAgoIso(0), 0, NOW)).toBe(false);
    expect(withinCooldown(daysAgoIso(0), -1, NOW)).toBe(false);
  });

  it("fails open on an unparseable timestamp", () => {
    expect(withinCooldown("not-a-date", 7, NOW)).toBe(false);
  });
});
