import { beforeEach, describe, expect, it, vi } from "vitest";

const { fromMock } = vi.hoisted(() => ({
  fromMock: vi.fn(),
}));

vi.mock("@/lib/supabase/client", () => ({
  supabase: { from: fromMock },
}));

import {
  BILLING_LOOKBACK_HOURS,
  META_PAYMENT_ISSUE_CODE,
  billingWarningState,
  getBillingSignal,
  type BillingSignal,
} from "./meta-billing";

const signal = (over: Partial<BillingSignal> = {}): BillingSignal => ({
  refusals: 0,
  lastRefusalAt: null,
  lastDeliveredAt: null,
  ...over,
});

describe("billingWarningState", () => {
  it("is none without refusals", () => {
    expect(billingWarningState(signal())).toBe("none");
    expect(billingWarningState(signal({ lastDeliveredAt: "2026-11-03T10:00:00Z" }))).toBe("none");
  });

  it("ignores one or two stray refusals", () => {
    expect(billingWarningState(signal({ refusals: 2, lastRefusalAt: "2026-11-03T10:00:00Z" }))).toBe("none");
  });

  it("is active at 3 refusals with nothing delivered since", () => {
    const s = signal({
      refusals: 3,
      lastRefusalAt: "2026-11-03T10:00:00Z",
      lastDeliveredAt: "2026-11-03T09:00:00Z",
    });
    expect(billingWarningState(s)).toBe("active");
  });

  it("stays active when the agent has never had a delivery", () => {
    expect(billingWarningState(signal({ refusals: 40, lastRefusalAt: "2026-11-03T10:00:00Z" }))).toBe("active");
  });

  it("is recovered once a send is delivered after the last refusal", () => {
    const s = signal({
      refusals: 68,
      lastRefusalAt: "2026-09-24T08:00:00Z",
      lastDeliveredAt: "2026-09-24T09:15:00Z",
    });
    expect(billingWarningState(s)).toBe("recovered");
  });

  it("treats a delivery at the same instant as still active", () => {
    const t = "2026-11-03T10:00:00Z";
    expect(billingWarningState(signal({ refusals: 5, lastRefusalAt: t, lastDeliveredAt: t }))).toBe("active");
  });
});

interface ChainCall {
  method: string;
  args: unknown[];
}

function makeChain(result: { data: unknown; error: unknown; count?: number | null }) {
  const calls: ChainCall[] = [];
  const chain: Record<string, ReturnType<typeof vi.fn>> & { calls: ChainCall[] } = { calls } as never;
  for (const m of ["select", "eq", "gte", "not", "order"]) {
    chain[m] = vi.fn((...args: unknown[]) => {
      calls.push({ method: m, args });
      return chain;
    });
  }
  chain.limit = vi.fn((...args: unknown[]) => {
    calls.push({ method: "limit", args });
    return Promise.resolve(result);
  });
  return chain;
}

describe("getBillingSignal", () => {
  beforeEach(() => {
    fromMock.mockReset();
  });

  it("counts payment refusals in the lookback window and reads the last delivery", async () => {
    const refusals = makeChain({
      data: [{ meta_failed_at: "2026-11-03T10:00:00Z" }],
      error: null,
      count: 7,
    });
    const delivered = makeChain({ data: [{ delivered_at: "2026-11-03T09:00:00Z" }], error: null });
    fromMock.mockReturnValueOnce(refusals).mockReturnValueOnce(delivered);

    const now = new Date("2026-11-03T12:00:00Z");
    const result = await getBillingSignal("agent-1", now);

    expect(result).toEqual({
      refusals: 7,
      lastRefusalAt: "2026-11-03T10:00:00Z",
      lastDeliveredAt: "2026-11-03T09:00:00Z",
    });
    expect(fromMock).toHaveBeenCalledWith("scheduled_messages");
    expect(refusals.calls).toContainEqual({ method: "eq", args: ["agent_id", "agent-1"] });
    expect(refusals.calls).toContainEqual({ method: "eq", args: ["meta_error_code", META_PAYMENT_ISSUE_CODE] });
    const since = new Date(now.getTime() - BILLING_LOOKBACK_HOURS * 3_600_000).toISOString();
    expect(refusals.calls).toContainEqual({ method: "gte", args: ["meta_failed_at", since] });
    expect(delivered.calls).toContainEqual({ method: "eq", args: ["agent_id", "agent-1"] });
  });

  it("returns an empty signal when nothing matches", async () => {
    fromMock
      .mockReturnValueOnce(makeChain({ data: [], error: null, count: 0 }))
      .mockReturnValueOnce(makeChain({ data: [], error: null }));

    expect(await getBillingSignal("agent-1")).toEqual({
      refusals: 0,
      lastRefusalAt: null,
      lastDeliveredAt: null,
    });
  });

  it("throws on a query error so react-query keeps the banner hidden", async () => {
    fromMock
      .mockReturnValueOnce(makeChain({ data: null, error: { message: "boom" } }))
      .mockReturnValueOnce(makeChain({ data: [], error: null }));

    await expect(getBillingSignal("agent-1")).rejects.toThrow(/payment refusals: boom/);
  });
});
