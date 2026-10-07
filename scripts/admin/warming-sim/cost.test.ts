import { describe, expect, it } from "vitest";
import { computeSonnet46Cost } from "../../../supabase/functions/_shared/langfuse.ts";
import { BudgetExceededError, CostTracker, HAIKU_MODEL, SONNET_MODEL, costOf } from "./cost.ts";

const ONE_MILLION = 1_000_000;

describe("costOf", () => {
  it("prices Sonnet with the production function", () => {
    const usage = { inputTokens: 1000, outputTokens: 500, cacheReadTokens: 2000, cacheCreationTokens: 300 };
    expect(costOf(SONNET_MODEL, usage)).toBeCloseTo(computeSonnet46Cost(usage), 10);
  });

  it("prices Haiku at $1 in / $5 out per million", () => {
    const usage = { inputTokens: ONE_MILLION, outputTokens: ONE_MILLION, cacheReadTokens: 0, cacheCreationTokens: 0 };
    expect(costOf(HAIKU_MODEL, usage)).toBeCloseTo(6, 6);
  });
});

describe("CostTracker", () => {
  it("rolls a child's spend up into the shared total", () => {
    const total = new CostTracker(25);
    const child = total.child();
    child.record(SONNET_MODEL, { input_tokens: ONE_MILLION });
    expect(child.total.costUsd).toBeCloseTo(3, 6);
    expect(total.total.costUsd).toBeCloseTo(3, 6);
    expect(total.total.calls).toBe(1);
  });

  it("aborts the next call once the limit is reached, for every child", () => {
    const total = new CostTracker(1);
    const first = total.child();
    const second = total.child();
    first.assertWithinBudget();
    first.record(SONNET_MODEL, { input_tokens: ONE_MILLION });
    expect(() => second.assertWithinBudget()).toThrow(BudgetExceededError);
  });

  it("allows calls while under the limit", () => {
    const total = new CostTracker(25);
    total.record(SONNET_MODEL, { input_tokens: 1000, output_tokens: 100 });
    expect(() => total.assertWithinBudget()).not.toThrow();
  });
});
