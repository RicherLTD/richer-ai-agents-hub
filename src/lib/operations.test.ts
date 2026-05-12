import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const fromMock = vi.fn();
vi.mock("./supabase/client", () => ({
  supabase: {
    from: (...args: unknown[]) => fromMock(...args),
  },
}));

import { getOperationsMetrics } from "./operations";

interface FakeRow {
  cost_usd: number | null;
  ai_processing_time_ms: number | null;
  tokens_output: number | null;
  timestamp: string | null;
}

function chain(returns: { data: FakeRow[] | null; error: { message: string } | null }) {
  // Chainable builder matching the calls in getOperationsMetrics.
  const builder = {
    select: vi.fn(() => builder),
    eq: vi.fn(() => builder),
    not: vi.fn(() => builder),
    gte: vi.fn(() => builder),
    order: vi.fn(() => builder),
    limit: vi.fn(() => builder),
    returns: vi.fn(() => Promise.resolve(returns)),
  };
  return builder;
}

function iso(date: Date): string {
  return date.toISOString();
}

describe("getOperationsMetrics", () => {
  beforeEach(() => {
    fromMock.mockReset();
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  it("returns all-zero metrics when there are no rows", async () => {
    fromMock.mockReturnValueOnce(chain({ data: [], error: null }));
    const m = await getOperationsMetrics("agent-1");
    expect(m).toEqual({
      costToday: 0,
      costThisWeek: 0,
      costThisMonth: 0,
      repliesToday: 0,
      repliesThisWeek: 0,
      repliesThisMonth: 0,
      latencyP50Ms: null,
      latencyP95Ms: null,
      avgTokensOutThisWeek: null,
    });
  });

  it("buckets rows correctly into today / week / month", async () => {
    // Fix "now" so the buckets are deterministic.
    const fakeNow = new Date("2026-05-12T12:00:00.000Z"); // Tuesday
    vi.useFakeTimers();
    vi.setSystemTime(fakeNow);

    const today = new Date(fakeNow);
    today.setHours(10, 0, 0, 0);
    const yesterday = new Date(fakeNow);
    yesterday.setDate(yesterday.getDate() - 1);
    const earlierThisMonth = new Date(fakeNow);
    earlierThisMonth.setDate(2);

    fromMock.mockReturnValueOnce(
      chain({
        data: [
          { cost_usd: 0.005, ai_processing_time_ms: 1000, tokens_output: 50, timestamp: iso(today) },
          { cost_usd: 0.01, ai_processing_time_ms: 2000, tokens_output: 100, timestamp: iso(yesterday) },
          {
            cost_usd: 0.003,
            ai_processing_time_ms: 3000,
            tokens_output: 30,
            timestamp: iso(earlierThisMonth),
          },
        ],
        error: null,
      }),
    );

    const m = await getOperationsMetrics("agent-1");
    expect(m.costToday).toBeCloseTo(0.005, 6);
    expect(m.repliesToday).toBe(1);
    // This week includes today + yesterday (both within the same Sun-start week).
    expect(m.costThisWeek).toBeCloseTo(0.015, 6);
    expect(m.repliesThisWeek).toBe(2);
    // This month also includes the earlier-in-month row.
    expect(m.costThisMonth).toBeCloseTo(0.018, 6);
    expect(m.repliesThisMonth).toBe(3);
  });

  it("computes P50 / P95 latency on the in-week rows", async () => {
    const fakeNow = new Date("2026-05-12T12:00:00.000Z");
    vi.useFakeTimers();
    vi.setSystemTime(fakeNow);

    const today = new Date(fakeNow);
    // 11 rows in-week with latencies 100..1100ms.
    const rows: FakeRow[] = Array.from({ length: 11 }, (_, i) => ({
      cost_usd: 0.001,
      ai_processing_time_ms: 100 + i * 100,
      tokens_output: 50,
      timestamp: iso(today),
    }));
    fromMock.mockReturnValueOnce(chain({ data: rows, error: null }));

    const m = await getOperationsMetrics("agent-1");
    // P50 of [100..1100ms step 100] = 600
    expect(m.latencyP50Ms).toBe(600);
    // P95 ≈ interpolated near 1050ms (between idx 9 and 10).
    expect(m.latencyP95Ms).toBeGreaterThanOrEqual(1000);
    expect(m.latencyP95Ms).toBeLessThanOrEqual(1100);
  });

  it("computes avg tokens out for the week", async () => {
    const fakeNow = new Date("2026-05-12T12:00:00.000Z");
    vi.useFakeTimers();
    vi.setSystemTime(fakeNow);
    const today = new Date(fakeNow);

    fromMock.mockReturnValueOnce(
      chain({
        data: [
          { cost_usd: 0.001, ai_processing_time_ms: null, tokens_output: 100, timestamp: iso(today) },
          { cost_usd: 0.001, ai_processing_time_ms: null, tokens_output: 200, timestamp: iso(today) },
          { cost_usd: 0.001, ai_processing_time_ms: null, tokens_output: 300, timestamp: iso(today) },
        ],
        error: null,
      }),
    );

    const m = await getOperationsMetrics("agent-1");
    expect(m.avgTokensOutThisWeek).toBe(200);
  });

  it("throws when the supabase query errors out", async () => {
    fromMock.mockReturnValueOnce(chain({ data: null, error: { message: "boom" } }));
    await expect(getOperationsMetrics("agent-1")).rejects.toThrow(/boom/);
  });
});
