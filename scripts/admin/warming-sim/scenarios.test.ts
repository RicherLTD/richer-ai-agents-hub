import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { describe, expect, it } from "vitest";
import { ScenarioValidationError, selectScenarios, validateScenarios, type Scenario } from "./scenarios.ts";

// vitest runs from the repo root; import.meta.url is not a file URL under jsdom.
const SCENARIOS_PATH = resolve(process.cwd(), "scripts/admin/warming-sim/scenarios.json");
const ACTIVE_STATUSES = [2, 4, 6, 7, 14, 15, 18, 20, 21, 22, 23, 24, 26, 47, 50, 51, 52, 54, 55, 56, 58, 59, 60, 72, 73, 76, 77, 80, 91];

function valid(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    id: "status-1", statusSub: 1, title: "t", persona: "p", plan: ["a"],
    mustHappen: ["x"], mustNotHappen: ["y"], maxTurns: 6, ...overrides,
  };
}

describe("validateScenarios", () => {
  it("accepts the shipped scenarios.json and covers every active status", () => {
    const raw: unknown = JSON.parse(readFileSync(SCENARIOS_PATH, "utf8"));
    const scenarios = validateScenarios(raw);
    const covered = new Set(scenarios.map((s) => s.statusSub));
    expect(ACTIVE_STATUSES.filter((status) => !covered.has(status))).toEqual([]);
    expect(scenarios.map((s) => s.id)).toEqual(expect.arrayContaining(["x-23-already-said", "x-26-loan-denied"]));
  });

  it("plays a lukewarm beat in the first two beats of every plan", () => {
    const raw: unknown = JSON.parse(readFileSync(SCENARIOS_PATH, "utf8"));
    const lukewarm = /סבבה|הכל טוב/;
    validateScenarios(raw).forEach((s) => expect(`${s.id}: ${s.plan.slice(0, 2).join(" | ")}`).toMatch(lukewarm));
  });

  it("rejects a non-array and an empty array", () => {
    expect(() => validateScenarios({})).toThrow(ScenarioValidationError);
    expect(() => validateScenarios([])).toThrow(ScenarioValidationError);
  });

  it("lists every problem, not just the first", () => {
    const bad = [valid({ plan: [], maxTurns: 0 }), valid({ id: "status-1" }), valid({ statusSub: "2", id: "b" })];
    try {
      validateScenarios(bad);
      throw new Error("should have thrown");
    } catch (error) {
      expect(error).toBeInstanceOf(ScenarioValidationError);
      const problems = (error as ScenarioValidationError).problems.join("\n");
      expect(problems).toContain("plan must be a non-empty list");
      expect(problems).toContain("maxTurns must be a positive integer");
      expect(problems).toContain("duplicate id 'status-1'");
      expect(problems).toContain("statusSub must be an integer");
    }
  });
});

describe("selectScenarios", () => {
  const all = validateScenarios([
    valid({ id: "status-22", statusSub: 22 }),
    valid({ id: "status-23", statusSub: 23 }),
    valid({ id: "x-23-already-said", statusSub: 23 }),
    valid({ id: "status-3", statusSub: 3 }),
  ]);
  const activeStatuses = new Set([22, 23, 24]);

  it("skips scenarios whose status is disabled and reports uncovered active statuses", () => {
    const result = selectScenarios(all, { only: [], activeStatuses });
    expect(result.selected.map((s: Scenario) => s.id)).toEqual(["status-22", "status-23", "x-23-already-said"]);
    expect(result.skippedInactive.map((s) => s.id)).toEqual(["status-3"]);
    expect(result.uncoveredStatuses).toEqual([24]);
  });

  it("matches --only by id or by status number", () => {
    expect(selectScenarios(all, { only: ["22"], activeStatuses }).selected.map((s) => s.id)).toEqual(["status-22"]);
    expect(selectScenarios(all, { only: ["23"], activeStatuses }).selected).toHaveLength(2);
    expect(selectScenarios(all, { only: ["x-23-already-said"], activeStatuses }).selected).toHaveLength(1);
  });
});
