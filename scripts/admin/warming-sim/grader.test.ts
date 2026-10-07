import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { describe, expect, it } from "vitest";
import { extractSpecSection } from "./grader.ts";
import {
  CROSS_STATUS_CRITERIA,
  GraderParseError,
  parseGraderOutput,
  reconcileGrade,
} from "./graderSchema.ts";

function rawGrade(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    criteria: CROSS_STATUS_CRITERIA.map((c) => ({ id: c.id, result: "pass", evidence: "ציטוט" })),
    scenario_checks: [{ kind: "must_happen", item: "x", result: "pass", evidence: "e" }],
    verdict: "PASS",
    summary_he: "  תקין  ",
    ...overrides,
  };
}

describe("parseGraderOutput", () => {
  it("parses a complete answer and trims the summary", () => {
    const grade = parseGraderOutput(rawGrade());
    expect(grade.verdict).toBe("PASS");
    expect(grade.summaryHe).toBe("תקין");
    expect(grade.criteria).toHaveLength(CROSS_STATUS_CRITERIA.length);
    expect(grade.criteria[0].label).toBe(CROSS_STATUS_CRITERIA[0].label);
  });

  it("rejects a missing criterion, an unknown one and a bad verdict", () => {
    const criteria = CROSS_STATUS_CRITERIA.slice(1).map((c) => ({ id: c.id, result: "pass", evidence: "" }));
    expect(() => parseGraderOutput(rawGrade({ criteria }))).toThrow(/missing criteria/);
    expect(() => parseGraderOutput(rawGrade({ criteria: [{ id: "nope", result: "pass", evidence: "" }] }))).toThrow(GraderParseError);
    expect(() => parseGraderOutput(rawGrade({ verdict: "GREAT" }))).toThrow(/verdict/);
    expect(() => parseGraderOutput("not an object")).toThrow(GraderParseError);
  });
});

describe("reconcileGrade", () => {
  it("forces a failure and FAIL verdict when the bot went silent", () => {
    const result = reconcileGrade(parseGraderOutput(rawGrade()), { silenceCount: 2 });
    expect(result.criteria.find((c) => c.id === "no_silence")?.result).toBe("fail");
    expect(result.verdict).toBe("FAIL");
  });

  it("never leaves PASS above a failed criterion", () => {
    const criteria = CROSS_STATUS_CRITERIA.map((c) => ({
      id: c.id, result: c.id === "no_dash" ? "fail" : "pass", evidence: "—",
    }));
    const result = reconcileGrade(parseGraderOutput(rawGrade({ criteria })), { silenceCount: 0 });
    expect(result.verdict).toBe("BORDERLINE");
  });

  it("keeps a clean PASS untouched", () => {
    expect(reconcileGrade(parseGraderOutput(rawGrade()), { silenceCount: 0 }).verdict).toBe("PASS");
  });
});

describe("extractSpecSection", () => {
  const spec = readFileSync(
    resolve(process.cwd(), "docs/superpowers/plans/2026-09-01-crm-warming-objection-handling.md"),
    "utf8",
  );

  it("returns the bullet of one status and stops at the next", () => {
    const section = extractSpecSection(spec, 14) ?? "";
    expect(section).toContain("מחיר");
    expect(section).not.toContain("26 — דחוי מימון");
  });

  it("finds a status inside a combined bullet", () => {
    expect(extractSpecSection(spec, 73)).toContain("מנתקים מוקדם");
  });

  it("returns null for a status without a section", () => {
    expect(extractSpecSection(spec, 999)).toBeNull();
  });
});
