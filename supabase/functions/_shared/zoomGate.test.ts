import { describe, expect, it } from "vitest";
import { meetsZoomQualificationFloor, MIN_CORE_ANSWERED } from "./zoomGate.ts";

const empty = {
  q1_age: null,
  q2_motivation: null,
  q3_dream_change: null,
  q4_blocker: null,
  q5_urgency: null,
};

describe("meetsZoomQualificationFloor", () => {
  it("blocks an empty lead and reports all three gaps", () => {
    const r = meetsZoomQualificationFloor(empty);
    expect(r.ok).toBe(false);
    expect(r.missing).toHaveLength(3);
  });

  it("blocks when the goal (q3) is missing — even with 3 other answers", () => {
    const r = meetsZoomQualificationFloor({
      ...empty,
      q1_age: 30,
      q2_motivation: "להגדיל הכנסה",
      q4_blocker: "אין זמן",
    });
    expect(r.ok).toBe(false);
    expect(r.missing.some((m) => m.includes("יעד"))).toBe(true);
  });

  it("blocks when the pain (q4) is missing", () => {
    const r = meetsZoomQualificationFloor({
      ...empty,
      q1_age: 30,
      q2_motivation: "להגדיל הכנסה",
      q3_dream_change: "עצמאות פיננסית",
    });
    expect(r.ok).toBe(false);
    expect(r.missing.some((m) => m.includes("כאב"))).toBe(true);
  });

  it("blocks when fewer than 3 core questions answered, even with goal + pain", () => {
    const r = meetsZoomQualificationFloor({
      ...empty,
      q3_dream_change: "עצמאות פיננסית",
      q4_blocker: "אין זמן",
    });
    expect(r.ok).toBe(false);
    expect(r.missing.some((m) => m.includes("שאלות"))).toBe(true);
  });

  it("passes with goal + pain + a third answer", () => {
    const r = meetsZoomQualificationFloor({
      ...empty,
      q2_motivation: "להגדיל הכנסה",
      q3_dream_change: "עצמאות פיננסית",
      q4_blocker: "אין זמן",
    });
    expect(r.ok).toBe(true);
    expect(r.missing).toEqual([]);
  });

  it("passes when all five core questions are answered", () => {
    const r = meetsZoomQualificationFloor({
      q1_age: 30,
      q2_motivation: "להגדיל הכנסה",
      q3_dream_change: "עצמאות פיננסית",
      q4_blocker: "אין זמן",
      q5_urgency: "החודש",
    });
    expect(r.ok).toBe(true);
  });

  it("MIN_CORE_ANSWERED is 3 (pain + goal + one more)", () => {
    expect(MIN_CORE_ANSWERED).toBe(3);
  });
});
