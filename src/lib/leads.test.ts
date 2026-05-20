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
    gte: vi.fn(),
    lte: vi.fn(),
    order: vi.fn(),
    limit: vi.fn(),
    or: vi.fn(),
  };
  for (const method of ["select", "eq", "gte", "lte", "order", "or"] as const) {
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

  it("applies created_at lower and upper bounds when provided", async () => {
    const chain = makeChain({ data: [], error: null });
    fromMock.mockReturnValue(chain);

    await getLeads({
      agentId: "agent-1",
      fromCreatedAt: "2026-05-01T00:00:00Z",
      toCreatedAt: "2026-05-20T23:59:59Z",
    });

    const gte = chain.calls.find((c) => c.method === "gte");
    const lte = chain.calls.find((c) => c.method === "lte");
    expect(gte?.args).toEqual(["created_at", "2026-05-01T00:00:00Z"]);
    expect(lte?.args).toEqual(["created_at", "2026-05-20T23:59:59Z"]);
  });

  it("skips date bounds when not provided", async () => {
    const chain = makeChain({ data: [], error: null });
    fromMock.mockReturnValue(chain);

    await getLeads({ agentId: "agent-1" });

    expect(chain.calls.find((c) => c.method === "gte")).toBeUndefined();
    expect(chain.calls.find((c) => c.method === "lte")).toBeUndefined();
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
