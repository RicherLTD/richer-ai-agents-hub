import { beforeEach, describe, expect, it, vi } from "vitest";

const { fromMock } = vi.hoisted(() => ({
  fromMock: vi.fn(),
}));

vi.mock("@/lib/supabase/client", () => ({
  supabase: { from: fromMock },
}));

import { getDistinctPromptTypes, getPrompts } from "./prompts";

interface ChainCall {
  method: string;
  args: unknown[];
}

function makeChain(result: { data: unknown; error: unknown }, awaitable: "order" | "eq") {
  const calls: ChainCall[] = [];
  const chain = {
    calls,
    select: vi.fn(),
    eq: vi.fn(),
    order: vi.fn(),
  };
  // The supabase chain becomes awaitable on the LAST chained call. We
  // resolve the result on the last `order` (for getPrompts) or the last
  // `eq` (for getDistinctPromptTypes which has no order).
  let orderCount = 0;
  let eqCount = 0;
  const expectedOrders = awaitable === "order" ? 2 : 0;

  chain.select.mockImplementation((...args: unknown[]) => {
    calls.push({ method: "select", args });
    return chain;
  });
  chain.eq.mockImplementation((...args: unknown[]) => {
    calls.push({ method: "eq", args });
    eqCount += 1;
    if (awaitable === "eq" && eqCount === 1) {
      return Promise.resolve(result);
    }
    return chain;
  });
  chain.order.mockImplementation((...args: unknown[]) => {
    calls.push({ method: "order", args });
    orderCount += 1;
    if (orderCount === expectedOrders) {
      return Promise.resolve(result);
    }
    return chain;
  });
  return chain;
}

beforeEach(() => {
  fromMock.mockReset();
});

describe("getPrompts", () => {
  it("filters by agent_id only when promptType='all' and !activeOnly", async () => {
    const chain = makeChain({ data: [], error: null }, "order");
    fromMock.mockReturnValue(chain);

    await getPrompts({ agentId: "agent-1" });

    const eqCalls = chain.calls.filter((c) => c.method === "eq");
    expect(eqCalls).toEqual([{ method: "eq", args: ["agent_id", "agent-1"] }]);
  });

  it("adds prompt_type filter when set", async () => {
    const chain = makeChain({ data: [], error: null }, "order");
    fromMock.mockReturnValue(chain);

    await getPrompts({ agentId: "agent-1", promptType: "main" });

    const typeCall = chain.calls.find((c) => c.method === "eq" && c.args[0] === "prompt_type");
    expect(typeCall?.args).toEqual(["prompt_type", "main"]);
  });

  it("adds is_active=true filter when activeOnly=true", async () => {
    const chain = makeChain({ data: [], error: null }, "order");
    fromMock.mockReturnValue(chain);

    await getPrompts({ agentId: "agent-1", activeOnly: true });

    const activeCall = chain.calls.find((c) => c.method === "eq" && c.args[0] === "is_active");
    expect(activeCall?.args).toEqual(["is_active", true]);
  });

  it("returns rows on success", async () => {
    const rows = [{ id: "p1", version: "v1" }];
    const chain = makeChain({ data: rows, error: null }, "order");
    fromMock.mockReturnValue(chain);

    expect(await getPrompts({ agentId: "agent-1" })).toEqual(rows);
  });

  it("throws a wrapped error", async () => {
    const chain = makeChain({ data: null, error: { message: "boom" } }, "order");
    fromMock.mockReturnValue(chain);

    await expect(getPrompts({ agentId: "agent-1" })).rejects.toThrow("Failed to load prompts: boom");
  });
});

describe("getDistinctPromptTypes", () => {
  it("returns sorted unique prompt types", async () => {
    const chain = makeChain(
      {
        data: [
          { prompt_type: "main" },
          { prompt_type: "questionnaire" },
          { prompt_type: "main" },
          { prompt_type: "summarizer" },
        ],
        error: null,
      },
      "eq",
    );
    fromMock.mockReturnValue(chain);

    expect(await getDistinctPromptTypes("agent-1")).toEqual([
      "main",
      "questionnaire",
      "summarizer",
    ]);
  });

  it("throws a wrapped error", async () => {
    const chain = makeChain({ data: null, error: { message: "down" } }, "eq");
    fromMock.mockReturnValue(chain);

    await expect(getDistinctPromptTypes("agent-1")).rejects.toThrow(
      "Failed to load prompt types: down",
    );
  });
});

import { setActivePromptVersion } from "./prompts";

describe("setActivePromptVersion", () => {
  function selectChain(result: { data: unknown; error: unknown }) {
    const chain = {
      select: vi.fn(() => chain),
      eq: vi.fn(() => chain),
      maybeSingle: vi.fn(() => Promise.resolve(result)),
    };
    return chain;
  }
  function updateChain(result: { error: unknown }) {
    const chain = {
      update: vi.fn(() => chain),
      eq: vi.fn(() => chain),
      neq: vi.fn(() => Promise.resolve(result)),
    };
    return chain;
  }
  function finalUpdateChain(result: { error: unknown }) {
    const chain = {
      update: vi.fn(() => chain),
      eq: vi.fn(() => Promise.resolve(result)),
    };
    return chain;
  }

  it("returns early when the target is already active", async () => {
    const select = selectChain({
      data: { agent_id: "a1", prompt_type: "main", is_active: true },
      error: null,
    });
    fromMock.mockReturnValueOnce(select);

    await setActivePromptVersion("prompt-x");

    // Only the SELECT happened — no update chains were requested.
    expect(fromMock).toHaveBeenCalledTimes(1);
  });

  it("throws when the target prompt is not found", async () => {
    fromMock.mockReturnValueOnce(selectChain({ data: null, error: null }));
    await expect(setActivePromptVersion("missing")).rejects.toThrow("Prompt not found");
  });

  it("happy path: deactivates siblings then activates the target", async () => {
    fromMock
      .mockReturnValueOnce(
        selectChain({
          data: { agent_id: "a1", prompt_type: "main", is_active: false },
          error: null,
        }),
      )
      .mockReturnValueOnce(updateChain({ error: null }))
      .mockReturnValueOnce(finalUpdateChain({ error: null }));

    await setActivePromptVersion("prompt-x");

    // Three from("prompts") calls: select, deactivate-siblings, activate-target.
    expect(fromMock).toHaveBeenCalledTimes(3);
  });

  it("wraps deactivation errors", async () => {
    fromMock
      .mockReturnValueOnce(
        selectChain({
          data: { agent_id: "a1", prompt_type: "main", is_active: false },
          error: null,
        }),
      )
      .mockReturnValueOnce(updateChain({ error: { message: "deactivate boom" } }));

    await expect(setActivePromptVersion("prompt-x")).rejects.toThrow(
      /Failed to deactivate sibling versions: deactivate boom/,
    );
  });

  it("wraps activation errors", async () => {
    fromMock
      .mockReturnValueOnce(
        selectChain({
          data: { agent_id: "a1", prompt_type: "main", is_active: false },
          error: null,
        }),
      )
      .mockReturnValueOnce(updateChain({ error: null }))
      .mockReturnValueOnce(finalUpdateChain({ error: { message: "activate boom" } }));

    await expect(setActivePromptVersion("prompt-x")).rejects.toThrow(
      /Failed to activate target version: activate boom/,
    );
  });
});
