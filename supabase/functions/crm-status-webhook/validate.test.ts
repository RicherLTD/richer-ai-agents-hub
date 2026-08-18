import { describe, expect, it } from "vitest";
import {
  asInt,
  coercePayload,
  resolveLeadNameUpdate,
  resolveStatusRule,
  withinCooldown,
} from "./validate.ts";

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

describe("resolveStatusRule", () => {
  const activeRow = {
    status_label: "ל״מ אין זמן",
    objection_key: "no_time",
    warming_instructions: "הצע משהו קטן וקל.",
    delay_hours: 0,
    cooldown_days: 14,
    clears_zoom_state: false,
    is_active: true,
  };

  it("returns the operator's rule when the status is active", () => {
    const r = resolveStatusRule(activeRow);
    expect(r.matched).toBe(true);
    expect(r.disabled).toBe(false);
    expect(r.rule.objection_key).toBe("no_time");
    expect(r.rule.cooldown_days).toBe(14);
  });

  // The status is real but nobody has configured it. The caller already
  // filtered, so warm it generically rather than drop it silently.
  it("falls back to the default when no row exists", () => {
    const r = resolveStatusRule(null);
    expect(r.matched).toBe(false);
    expect(r.disabled).toBe(false);
    expect(r.rule.objection_key).toBe("unknown");
    expect(r.rule.delay_hours).toBe(0);
  });

  // THE REGRESSION GUARD. The query used to filter is_active = true, so a
  // switched-off rule returned no row, looked like an unknown status, and fell
  // through to the default — meaning the dashboard's "off" toggle caused
  // IMMEDIATE warming on generic instructions. Off must mean off.
  it("reports a switched-off status as disabled, NOT as missing", () => {
    const r = resolveStatusRule({ ...activeRow, is_active: false });
    expect(r.disabled).toBe(true);
    expect(r.matched).toBe(true);
  });

  it("distinguishes disabled from missing", () => {
    const disabled = resolveStatusRule({ ...activeRow, is_active: false });
    const missing = resolveStatusRule(null);
    expect(disabled.disabled).not.toBe(missing.disabled);
    expect(disabled.matched).not.toBe(missing.matched);
  });

  it("treats a null is_active as active rather than disabled", () => {
    expect(resolveStatusRule({ ...activeRow, is_active: null }).disabled).toBe(false);
  });

  it("fills gaps in a partially populated row without throwing", () => {
    const r = resolveStatusRule({ is_active: true });
    expect(r.disabled).toBe(false);
    expect(r.rule.cooldown_days).toBe(7);
    expect(r.rule.clears_zoom_state).toBe(false);
    expect(r.rule.warming_instructions.length).toBeGreaterThan(0);
  });

  it("does not let a caller mutate the shared default", () => {
    const a = resolveStatusRule(null);
    a.rule.delay_hours = 999;
    expect(resolveStatusRule(null).rule.delay_hours).toBe(0);
  });
});

describe("resolveLeadNameUpdate", () => {
  // THE BUG GUARD. A CRM status event carrying a name must never overwrite a
  // name already on the conversation — the WhatsApp/registration name is
  // authoritative. Discovered 2026-08-18 when a test payload clobbered a real
  // lead's name.
  it("never overwrites an existing name", () => {
    expect(resolveLeadNameUpdate("עינת", "בדיקת מערכת CRM")).toBeNull();
    expect(resolveLeadNameUpdate("ישראל ישראלי", "something")).toBeNull();
  });

  // Fill-if-empty: a row with no name yet is a strict improvement to fill.
  it("fills a missing name from the payload", () => {
    expect(resolveLeadNameUpdate(null, "עינת")).toBe("עינת");
    expect(resolveLeadNameUpdate(undefined, "עינת")).toBe("עינת");
    expect(resolveLeadNameUpdate("", "עינת")).toBe("עינת");
    expect(resolveLeadNameUpdate("   ", "עינת")).toBe("עינת");
  });

  it("trims the incoming name it decides to write", () => {
    expect(resolveLeadNameUpdate(null, "  עינת  ")).toBe("עינת");
  });

  it("leaves an empty row untouched when the payload has no usable name", () => {
    expect(resolveLeadNameUpdate(null, null)).toBeNull();
    expect(resolveLeadNameUpdate(null, "   ")).toBeNull();
    expect(resolveLeadNameUpdate("", null)).toBeNull();
  });

  it("keeps an existing name even when the payload is empty", () => {
    expect(resolveLeadNameUpdate("עינת", null)).toBeNull();
  });
});
