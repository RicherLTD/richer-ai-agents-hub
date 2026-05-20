import { beforeEach, describe, expect, it, vi } from "vitest";

const { fromMock } = vi.hoisted(() => ({
  fromMock: vi.fn(),
}));

vi.mock("@/lib/supabase/client", () => ({
  supabase: { from: fromMock },
}));

import { getActiveConversations, getConversationById } from "./conversations";

interface ChainCall {
  method: string;
  args: unknown[];
}

function makeChain(result: { data: unknown; error: unknown }, awaitable: "limit" | "maybeSingle") {
  const calls: ChainCall[] = [];
  const chain = {
    calls,
    select: vi.fn(),
    eq: vi.fn(),
    gte: vi.fn(),
    lte: vi.fn(),
    order: vi.fn(),
    or: vi.fn(),
    limit: vi.fn(),
    maybeSingle: vi.fn(),
  };
  for (const m of ["select", "eq", "gte", "lte", "order", "or"] as const) {
    chain[m].mockImplementation((...args: unknown[]) => {
      calls.push({ method: m, args });
      return chain;
    });
  }
  for (const m of ["limit", "maybeSingle"] as const) {
    chain[m].mockImplementation((...args: unknown[]) => {
      calls.push({ method: m, args });
      return m === awaitable ? Promise.resolve(result) : chain;
    });
  }
  return chain;
}

beforeEach(() => {
  fromMock.mockReset();
});

describe("getActiveConversations", () => {
  it("filters by agent_id by default (no status restriction)", async () => {
    const chain = makeChain({ data: [], error: null }, "limit");
    fromMock.mockReturnValue(chain);

    await getActiveConversations({ agentId: "agent-1" });

    expect(fromMock).toHaveBeenCalledWith("conversations");
    const eqCalls = chain.calls.filter((c) => c.method === "eq");
    expect(eqCalls).toEqual([{ method: "eq", args: ["agent_id", "agent-1"] }]);
  });

  it("applies created_at lower and upper bounds when provided", async () => {
    const chain = makeChain({ data: [], error: null }, "limit");
    fromMock.mockReturnValue(chain);

    await getActiveConversations({
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
    const chain = makeChain({ data: [], error: null }, "limit");
    fromMock.mockReturnValue(chain);

    await getActiveConversations({ agentId: "agent-1" });

    expect(chain.calls.find((c) => c.method === "gte")).toBeUndefined();
    expect(chain.calls.find((c) => c.method === "lte")).toBeUndefined();
  });

  it("adds the OR clause when search is provided", async () => {
    const chain = makeChain({ data: [], error: null }, "limit");
    fromMock.mockReturnValue(chain);

    await getActiveConversations({ agentId: "agent-1", search: "Alice" });

    const orCall = chain.calls.find((c) => c.method === "or");
    expect(orCall?.args[0]).toBe("lead_phone.ilike.%Alice%,lead_name.ilike.%Alice%");
  });

  it("orders by last_interaction_at desc and applies the default limit", async () => {
    const chain = makeChain({ data: [], error: null }, "limit");
    fromMock.mockReturnValue(chain);

    await getActiveConversations({ agentId: "agent-1" });

    const orderCall = chain.calls.find((c) => c.method === "order");
    expect(orderCall?.args[0]).toBe("last_interaction_at");
    const limitCall = chain.calls.find((c) => c.method === "limit");
    expect(limitCall?.args[0]).toBe(500);
  });

  it("throws a wrapped error", async () => {
    const chain = makeChain({ data: null, error: { message: "down" } }, "limit");
    fromMock.mockReturnValue(chain);

    await expect(getActiveConversations({ agentId: "agent-1" })).rejects.toThrow(
      "Failed to load conversations: down",
    );
  });
});

describe("getConversationById", () => {
  it("returns the row when found", async () => {
    const row = { id: "c1", lead_name: "Alice" };
    const chain = makeChain({ data: row, error: null }, "maybeSingle");
    fromMock.mockReturnValue(chain);

    const result = await getConversationById("c1");

    expect(result).toEqual(row);
    expect(fromMock).toHaveBeenCalledWith("conversations");
    const eqCall = chain.calls.find((c) => c.method === "eq");
    expect(eqCall?.args).toEqual(["id", "c1"]);
  });

  it("returns null when not found (RLS hides or no row)", async () => {
    const chain = makeChain({ data: null, error: null }, "maybeSingle");
    fromMock.mockReturnValue(chain);

    expect(await getConversationById("c1")).toBeNull();
  });

  it("throws a wrapped error when the query fails", async () => {
    const chain = makeChain({ data: null, error: { message: "boom" } }, "maybeSingle");
    fromMock.mockReturnValue(chain);

    await expect(getConversationById("c1")).rejects.toThrow("Failed to load conversation: boom");
  });
});
