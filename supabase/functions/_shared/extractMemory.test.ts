import { describe, expect, it } from "vitest";
import {
  coerceExtractedMemory,
  decideConversationTag,
  decideFunnelStage,
  shouldTriggerZoomHandoff,
} from "./extractMemory.ts";

describe("coerceExtractedMemory", () => {
  it("returns null when given a non-object", () => {
    expect(coerceExtractedMemory(null)).toBeNull();
    expect(coerceExtractedMemory("hello")).toBeNull();
    expect(coerceExtractedMemory([])).toBeNull();
    expect(coerceExtractedMemory(42)).toBeNull();
  });

  it("returns the all-nulls baseline when fields are absent", () => {
    expect(coerceExtractedMemory({})).toEqual({
      q1_age: null,
      q2_motivation: null,
      q3_dream_change: null,
      q4_blocker: null,
      q5_urgency: null,
      q6_investment: null,
      conversation_summary: null,
      primary_objection: null,
      red_flags: [],
      notes_for_advisor: null,
    });
  });

  it("coerces a clean Hebrew payload correctly", () => {
    const input = {
      q1_age: 23,
      q2_motivation: "להגדיל הכנסה",
      q3_dream_change: "עצמאות פיננסית",
      q4_blocker: "אין זמן",
      q5_urgency: "תוך כמה חודשים",
      q6_investment: "עד 10,000 ש\"ח",
      conversation_summary: "ליד צעיר עם רקע בבינה מלאכותית, מחפש הכנסה נוספת.",
      primary_objection: "timing",
      red_flags: [],
      notes_for_advisor: "מעוניין בזום בתוך השבוע.",
    };
    const out = coerceExtractedMemory(input);
    expect(out).toEqual(input);
  });

  it("treats q1_age as a number even when stringified", () => {
    const out = coerceExtractedMemory({ q1_age: "27" });
    expect(out?.q1_age).toBe(27);
  });

  it("rejects implausible ages (0, 200, negative, NaN)", () => {
    expect(coerceExtractedMemory({ q1_age: 0 })?.q1_age).toBeNull();
    expect(coerceExtractedMemory({ q1_age: 200 })?.q1_age).toBeNull();
    expect(coerceExtractedMemory({ q1_age: -5 })?.q1_age).toBeNull();
    expect(coerceExtractedMemory({ q1_age: "not a number" })?.q1_age).toBeNull();
  });

  it("drops unrecognized primary_objection values to null", () => {
    expect(coerceExtractedMemory({ primary_objection: "money" })?.primary_objection).toBe("money");
    expect(coerceExtractedMemory({ primary_objection: "skeptical" })?.primary_objection).toBeNull();
    expect(coerceExtractedMemory({ primary_objection: 42 })?.primary_objection).toBeNull();
  });

  it("filters red_flags to non-empty strings, caps at 5", () => {
    const out = coerceExtractedMemory({
      red_flags: ["underage", "", null, "scam-radar", 5, "x", "y", "z", "w"],
    });
    expect(out?.red_flags).toEqual(["underage", "scam-radar", "x", "y", "z"]);
  });

  it("trims whitespace in string fields and treats blanks as null", () => {
    const out = coerceExtractedMemory({
      q2_motivation: "   ",
      q3_dream_change: "  לעבוד מהבית   ",
    });
    expect(out?.q2_motivation).toBeNull();
    expect(out?.q3_dream_change).toBe("לעבוד מהבית");
  });
});

describe("decideConversationTag", () => {
  const baseMemory = {
    q1_age: null,
    q2_motivation: null,
    q3_dream_change: null,
    q4_blocker: null,
    q5_urgency: null,
    q6_investment: null,
    conversation_summary: null,
    primary_objection: null,
    red_flags: [],
    notes_for_advisor: null,
  };

  it("returns null when there are no flags", () => {
    expect(decideConversationTag(baseMemory, null)).toBeNull();
    expect(decideConversationTag(baseMemory, "hotlist")).toBeNull();
  });

  it("returns 'underage' when red_flags mentions underage (any case)", () => {
    expect(
      decideConversationTag({ ...baseMemory, red_flags: ["UNDERAGE"] }, "hotlist"),
    ).toBe("underage");
    expect(
      decideConversationTag({ ...baseMemory, red_flags: ["lead is underage"] }, null),
    ).toBe("underage");
  });

  it("returns 'requires_human' for any other non-empty red_flag set", () => {
    expect(
      decideConversationTag({ ...baseMemory, red_flags: ["mental distress"] }, null),
    ).toBe("requires_human");
  });

  it("does not overwrite terminal tags", () => {
    for (const terminal of ["zoom_scheduled", "opted_out", "ghosted"]) {
      expect(
        decideConversationTag(
          { ...baseMemory, red_flags: ["something"] },
          terminal,
        ),
      ).toBeNull();
    }
  });

  it("prefers 'underage' over 'requires_human' when both signals are present", () => {
    expect(
      decideConversationTag(
        { ...baseMemory, red_flags: ["mental distress", "underage"] },
        null,
      ),
    ).toBe("underage");
  });
});

describe("decideFunnelStage", () => {
  const baseMemory = {
    q1_age: null,
    q2_motivation: null,
    q3_dream_change: null,
    q4_blocker: null,
    q5_urgency: null,
    q6_investment: null,
    conversation_summary: null,
    primary_objection: null,
    red_flags: [],
    notes_for_advisor: null,
  };

  it("returns 'cold' for an empty memory on a brand-new conversation", () => {
    expect(decideFunnelStage(baseMemory, null, null)).toBe("cold");
  });

  it("returns null when nothing has changed (cold stays cold)", () => {
    expect(decideFunnelStage(baseMemory, null, "cold")).toBeNull();
  });

  it("promotes cold → mid when one core question is answered", () => {
    expect(
      decideFunnelStage({ ...baseMemory, q1_age: 25 }, null, "cold"),
    ).toBe("mid");
  });

  it("promotes cold → mid via any single core question (q3 only)", () => {
    expect(
      decideFunnelStage({ ...baseMemory, q3_dream_change: "להגיע לעצמאות" }, null, "cold"),
    ).toBe("mid");
  });

  it("does NOT count q6_investment alone — that is a bonus signal", () => {
    expect(
      decideFunnelStage({ ...baseMemory, q6_investment: "עד 10,000 ש\"ח" }, null, null),
    ).toBe("cold");
  });

  it("promotes mid → done when all 5 core questions are answered", () => {
    expect(
      decideFunnelStage(
        {
          ...baseMemory,
          q1_age: 28,
          q2_motivation: "הכנסה נוספת",
          q3_dream_change: "חופש פיננסי",
          q4_blocker: "אין ניסיון",
          q5_urgency: "בחודש הקרוב",
        },
        null,
        "mid",
      ),
    ).toBe("done");
  });

  it("treats terminal tags (zoom_scheduled / opted_out / ghosted) as done regardless of q-state", () => {
    for (const terminal of ["zoom_scheduled", "opted_out", "ghosted"]) {
      expect(decideFunnelStage(baseMemory, terminal, "cold")).toBe("done");
      expect(decideFunnelStage(baseMemory, terminal, "mid")).toBe("done");
    }
  });

  it("never downgrades once funnel_stage is 'done'", () => {
    expect(decideFunnelStage(baseMemory, null, "done")).toBeNull();
    expect(
      decideFunnelStage({ ...baseMemory, q1_age: 25 }, null, "done"),
    ).toBeNull();
  });

  it("returns null when the desired stage already matches current", () => {
    expect(
      decideFunnelStage({ ...baseMemory, q1_age: 25 }, null, "mid"),
    ).toBeNull();
  });

  it("advances even when red_flags are present — stage tracks engagement, not safety", () => {
    expect(
      decideFunnelStage(
        { ...baseMemory, q1_age: 16, red_flags: ["underage"] },
        "underage",
        "cold",
      ),
    ).toBe("mid");
  });
});

describe("shouldTriggerZoomHandoff", () => {
  const baseMemory = {
    q1_age: null,
    q2_motivation: null,
    q3_dream_change: null,
    q4_blocker: null,
    q5_urgency: null,
    q6_investment: null,
    conversation_summary: null,
    primary_objection: null,
    red_flags: [],
    notes_for_advisor: null,
  };

  const fullyAnsweredMemory = {
    ...baseMemory,
    q1_age: 28,
    q2_motivation: "הכנסה נוספת",
    q3_dream_change: "חופש פיננסי",
    q4_blocker: "אין ניסיון",
    q5_urgency: "בחודש הקרוב",
  };

  it("triggers on fresh cold → done transition for a clean lead", () => {
    expect(shouldTriggerZoomHandoff(fullyAnsweredMemory, null, "cold", "done")).toBe(true);
  });

  it("triggers on fresh mid → done transition for a clean lead", () => {
    expect(shouldTriggerZoomHandoff(fullyAnsweredMemory, null, "mid", "done")).toBe(true);
  });

  it("does NOT trigger when nextStage is null (no stage change)", () => {
    expect(shouldTriggerZoomHandoff(fullyAnsweredMemory, null, "done", null)).toBe(false);
  });

  it("does NOT trigger when nextStage is mid", () => {
    expect(
      shouldTriggerZoomHandoff({ ...baseMemory, q1_age: 25 }, null, "cold", "mid"),
    ).toBe(false);
  });

  it("does NOT trigger when already done (re-extraction race)", () => {
    expect(shouldTriggerZoomHandoff(fullyAnsweredMemory, null, "done", "done")).toBe(false);
  });

  it("does NOT trigger when red_flags are present (escalate to human instead)", () => {
    expect(
      shouldTriggerZoomHandoff(
        { ...fullyAnsweredMemory, red_flags: ["mental distress"] },
        null,
        "mid",
        "done",
      ),
    ).toBe(false);
  });

  it("does NOT trigger when underage red flag is set", () => {
    expect(
      shouldTriggerZoomHandoff(
        { ...fullyAnsweredMemory, q1_age: 16, red_flags: ["underage"] },
        "underage",
        "mid",
        "done",
      ),
    ).toBe(false);
  });

  it("does NOT trigger when conversation is already zoom_scheduled", () => {
    expect(
      shouldTriggerZoomHandoff(fullyAnsweredMemory, "zoom_scheduled", "mid", "done"),
    ).toBe(false);
  });

  it("does NOT trigger for opted_out / ghosted / requires_human tags", () => {
    for (const tag of ["opted_out", "ghosted", "requires_human"]) {
      expect(
        shouldTriggerZoomHandoff(fullyAnsweredMemory, tag, "mid", "done"),
      ).toBe(false);
    }
  });
});
