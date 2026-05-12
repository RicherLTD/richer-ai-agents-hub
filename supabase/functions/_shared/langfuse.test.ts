import { describe, expect, it } from "vitest";
import { computeSonnet46Cost } from "./langfuse.ts";

describe("computeSonnet46Cost", () => {
  it("returns 0 for zero usage", () => {
    expect(computeSonnet46Cost({})).toBe(0);
  });

  it("computes a typical small turn (100 in / 50 out, no cache)", () => {
    const cost = computeSonnet46Cost({ inputTokens: 100, outputTokens: 50 });
    // 100 * $3/M + 50 * $15/M = $0.0003 + $0.00075 = $0.00105
    expect(cost).toBeCloseTo(0.00105, 6);
  });

  it("applies the 0.1× discount on cache reads", () => {
    const cost = computeSonnet46Cost({
      inputTokens: 0,
      outputTokens: 0,
      cacheReadTokens: 1000,
    });
    // 1000 * $0.30/M = $0.0003
    expect(cost).toBeCloseTo(0.0003, 6);
  });

  it("charges 1.25× for 5-minute cache writes", () => {
    const cost = computeSonnet46Cost({
      inputTokens: 0,
      outputTokens: 0,
      cacheCreationTokens: 1000,
    });
    // 1000 * $3.75/M = $0.00375
    expect(cost).toBeCloseTo(0.00375, 6);
  });

  it("sums all four buckets for a realistic cached turn", () => {
    const cost = computeSonnet46Cost({
      inputTokens: 50, // fresh input
      outputTokens: 200,
      cacheReadTokens: 2000, // history was cached
      cacheCreationTokens: 0,
    });
    // 50 * 3e-6 + 200 * 15e-6 + 2000 * 0.3e-6
    // = 0.00015 + 0.003 + 0.0006 = 0.00375
    expect(cost).toBeCloseTo(0.00375, 6);
  });

  it("ignores missing fields without errors", () => {
    // Only output_tokens is present.
    const cost = computeSonnet46Cost({ outputTokens: 100 });
    expect(cost).toBeCloseTo(0.0015, 6);
  });
});
