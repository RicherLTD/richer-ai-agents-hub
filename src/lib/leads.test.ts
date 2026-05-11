import { beforeEach, describe, expect, it, vi } from "vitest";

const { fromMock } = vi.hoisted(() => ({
  fromMock: vi.fn(),
}));

vi.mock("@/lib/supabase/client", () => ({
  supabase: { from: fromMock },
}));

import { getLeads } from "./leads";

interface ChainCall {
  method: string;
  args: unknown[];
}

function makeChain(result: { data: unknown; error: unknown }) {
  const calls: ChainCall[] = [];
  const chain = {
    calls,
    select: vi.fn(),
    eq: vi.fn(),
    order: vi.fn(),
    limit: vi.fn(),
    or: vi.fn(),
  };
  // Each method records its call and returns the same chain so the next
  // method can be invoked. `limit` is awaitable — it must resolve to the
  // result. We do that with a `then` so `await chain.limit(...)` works.
  for (const method of ["select", "eq", "order", "or"] as const) {
    chain[method].mockImplementation((...args: unknown[]) => {
      calls.push({ method, args });
      return chain;
    });
  }
  chain.limit.mockImplementation((...args: unknown[]) => {
    calls.push({ method: "limit", args });
    return Promise.resolve(result);
  });
  return chain;
}

beforeEach(() => {
  fromMock.mockReset();
});

describe("getLeads", () => {
  it("filters by agent_id and orders by last_interaction_at desc", async () => {
    const chain = makeChain({ data: [], error: null });
    fromMock.mockReturnValue(chain);

    await getLeads({ agentId: "agent-1" });

    expect(fromMock).toHaveBeenCalledWith("conversations");
    const eqCall = chain.calls.find((c) => c.method === "eq" && c.args[0] === "agent_id");
    expect(eqCall?.args).toEqual(["agent_id", "agent-1"]);
    const orderCall = chain.calls.find((c) => c.method === "order");
    expect(orderCall?.args[0]).toBe("last_interaction_at");
  });

  it("does NOT add funnel_stage filter when 'all'", async () => {
    const chain = makeChain({ data: [], error: null });
    fromMock.mockReturnValue(chain);

    await getLeads({ agentId: "agent-1", funnelStage: "all" });

    const stageCall = chain.calls.find((c) => c.method === "eq" && c.args[0] === "funnel_stage");
    expect(stageCall).toBeUndefined();
  });

  it("adds funnel_stage filter when set to a real stage", async () => {
    const chain = makeChain({ data: [], error: null });
    fromMock.mockReturnValue(chain);

    await getLeads({ agentId: "agent-1", funnelStage: "mid" });

    const stageCall = chain.calls.find((c) => c.method === "eq" && c.args[0] === "funnel_stage");
    expect(stageCall?.args).toEqual(["funnel_stage", "mid"]);
  });

  it("adds an OR clause when search is provided", async () => {
    const chain = makeChain({ data: [], error: null });
    fromMock.mockReturnValue(chain);

    await getLeads({ agentId: "agent-1", search: "ABC" });

    const orCall = chain.calls.find((c) => c.method === "or");
    expect(orCall?.args[0]).toBe("lead_phone.ilike.%ABC%,lead_name.ilike.%ABC%");
  });

  it("strips %_ wildcards from search to avoid RLS bypass tricks", async () => {
    const chain = makeChain({ data: [], error: null });
    fromMock.mockReturnValue(chain);

    await getLeads({ agentId: "agent-1", search: "a%b_c" });

    const orCall = chain.calls.find((c) => c.method === "or");
    expect(orCall?.args[0]).toBe("lead_phone.ilike.%abc%,lead_name.ilike.%abc%");
  });

  it("throws a wrapped error when the query fails", async () => {
    const chain = makeChain({ data: null, error: { message: "db down" } });
    fromMock.mockReturnValue(chain);

    await expect(getLeads({ agentId: "agent-1" })).rejects.toThrow("Failed to load leads: db down");
  });

  it("returns rows when query succeeds", async () => {
    const rows = [{ id: "c1", lead_name: "Alice" }];
    const chain = makeChain({ data: rows, error: null });
    fromMock.mockReturnValue(chain);

    const result = await getLeads({ agentId: "agent-1" });

    expect(result).toEqual(rows);
  });
});
