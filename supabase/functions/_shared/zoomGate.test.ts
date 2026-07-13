import { describe, expect, it } from "vitest";
import { meetsZoomQualificationFloor } from "./zoomGate.ts";

const empty = {
  q1_age: null,
  q2_motivation: null,
  q3_dream_change: null,
  q4_blocker: null,
  q5_urgency: null,
};

describe("meetsZoomQualificationFloor", () => {
  it("blocks a lead who has shared neither a goal nor a pain", () => {
    const r = meetsZoomQualificationFloor(empty);
    expect(r.ok).toBe(false);
    expect(r.missing).toHaveLength(1);
  });

  it("blocks even when non-core answers exist but goal AND pain are missing", () => {
    const r = meetsZoomQualificationFloor({
      ...empty,
      q1_age: 30,
      q2_motivation: "להגדיל הכנסה",
      q5_urgency: "החודש",
    });
    expect(r.ok).toBe(false);
  });

  it("passes with a goal (q3) alone", () => {
    const r = meetsZoomQualificationFloor({
      ...empty,
      q3_dream_change: "עצמאות פיננסית",
    });
    expect(r.ok).toBe(true);
    expect(r.missing).toEqual([]);
  });

  it("passes with a pain (q4) alone", () => {
    const r = meetsZoomQualificationFloor({
      ...empty,
      q4_blocker: "אין זמן",
    });
    expect(r.ok).toBe(true);
    expect(r.missing).toEqual([]);
  });

  it("passes with both goal and pain", () => {
    const r = meetsZoomQualificationFloor({
      ...empty,
      q3_dream_change: "עצמאות פיננסית",
      q4_blocker: "אין זמן",
    });
    expect(r.ok).toBe(true);
  });
});
