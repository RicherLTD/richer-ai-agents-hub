import { describe, expect, it } from "vitest";
import { buildGuardHint, GENERIC_GUARD_HINT } from "./guardHint.ts";

describe("buildGuardHint", () => {
  it("returns the generic hint for non-time rejections", () => {
    expect(buildGuardHint("hallucination_currency_mention", [])).toBe(GENERIC_GUARD_HINT);
    expect(buildGuardHint("income_guarantee", ["10:30"])).toBe(GENERIC_GUARD_HINT);
    expect(buildGuardHint("ai_disclosure", [])).toBe(GENERIC_GUARD_HINT);
  });

  it("steers back to the real slots when an invented time was blocked and slots exist", () => {
    const hint = buildGuardHint("invented_meeting_time", ["10:30", "14:00"]);
    // Must enumerate the grounded times so the model re-offers a real one.
    expect(hint).toContain("10:30");
    expect(hint).toContain("14:00");
    expect(hint).toContain("ONLY state these exact times");
    expect(hint).toContain("never invent");
    // And it must NOT be the blanket "avoid all times" generic hint.
    expect(hint).not.toBe(GENERIC_GUARD_HINT);
  });

  it("tells the model to stop stating times when no slots were retrieved", () => {
    const hint = buildGuardHint("invented_meeting_time", []);
    expect(hint).toContain("Do NOT state any specific time");
    expect(hint).toContain("list_available_slots");
    expect(hint).not.toContain("ONLY state these exact times");
  });
});
