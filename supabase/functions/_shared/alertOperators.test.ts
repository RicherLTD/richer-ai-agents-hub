import { describe, expect, it } from "vitest";
import { buildAlertTemplateVariables, sanitiseTemplateVariable } from "./alertOperators.ts";

// Meta rejects a template parameter that contains a newline, a tab, or more
// than 4 consecutive spaces (error 132000 / 131008 depending on the surface).
// A lead's WhatsApp message routinely contains all three, so every variable
// has to be flattened before it reaches the API. These tests are the contract.
describe("sanitiseTemplateVariable", () => {
  it("flattens newlines — the most common rejection cause", () => {
    expect(sanitiseTemplateVariable("שורה ראשונה\nשורה שנייה")).toBe(
      "שורה ראשונה שורה שנייה",
    );
    expect(sanitiseTemplateVariable("a\r\nb")).toBe("a b");
  });

  it("flattens tabs and collapses long space runs", () => {
    expect(sanitiseTemplateVariable("a\tb")).toBe("a b");
    expect(sanitiseTemplateVariable("a          b")).toBe("a b");
  });

  it("never returns an empty string — Meta rejects empty parameters", () => {
    expect(sanitiseTemplateVariable("")).toBe("—");
    expect(sanitiseTemplateVariable("   \n  ")).toBe("—");
    expect(sanitiseTemplateVariable(null)).toBe("—");
  });

  it("truncates to the cap so a long message can't blow the 1024-char body", () => {
    const out = sanitiseTemplateVariable("x".repeat(400), 250);
    expect(out.length).toBeLessThanOrEqual(250);
    expect(out.endsWith("…")).toBe(true);
  });
});

describe("buildAlertTemplateVariables", () => {
  const BASE = {
    leadName: "רונית לוי",
    leadPhone: "972543136618",
    agentLabel: "שיווק דיגיטלי",
    failureType: "judge_rejected_reply",
    failureDetail: "invented_fact",
    lastInbound: "כן אבל רק אחרי ה1.9",
  };

  it("emits exactly 5 variables in template order", () => {
    const v = buildAlertTemplateVariables(BASE);
    expect(v).toHaveLength(5);
    expect(v[0]).toBe("רונית לוי");
    // Israeli local format is what an operator can actually dial.
    expect(v[1]).toBe("0543136618");
    expect(v[2]).toBe("שיווק דיגיטלי");
    expect(v[3]).toContain("invented_fact");
    expect(v[4]).toBe("כן אבל רק אחרי ה1.9");
  });

  it("every variable is Meta-safe even when the lead's message is messy", () => {
    const v = buildAlertTemplateVariables({
      ...BASE,
      leadName: null,
      lastInbound: "שלום\n\nאני רוצה\tלקבוע     זום",
    });
    for (const value of v) {
      expect(value.length).toBeGreaterThan(0);
      expect(value).not.toMatch(/[\n\r\t]/);
      expect(value).not.toMatch(/ {5,}/);
    }
    expect(v[0]).toBe("(ללא שם)");
    expect(v[4]).toBe("שלום אני רוצה לקבוע זום");
  });
});
