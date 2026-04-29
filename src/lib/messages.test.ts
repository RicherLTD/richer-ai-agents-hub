import { beforeEach, describe, expect, it, vi } from "vitest";

const { fromMock } = vi.hoisted(() => ({
  fromMock: vi.fn(),
}));

vi.mock("@/lib/supabase/client", () => ({
  supabase: { from: fromMock },
}));

import { getMessagesForConversation, sendOutboundMessage } from "./messages";

interface ChainCall {
  method: string;
  args: unknown[];
}

function makeReadChain(result: { data: unknown; error: unknown }) {
  const calls: ChainCall[] = [];
  const chain = {
    calls,
    select: vi.fn(),
    eq: vi.fn(),
    order: vi.fn(),
    limit: vi.fn(),
  };
  for (const m of ["select", "eq", "order"] as const) {
    chain[m].mockImplementation((...args: unknown[]) => {
      calls.push({ method: m, args });
      return chain;
    });
  }
  chain.limit.mockImplementation((...args: unknown[]) => {
    calls.push({ method: "limit", args });
    return Promise.resolve(result);
  });
  return chain;
}

function makeInsertChain(result: { data: unknown; error: unknown }) {
  const calls: ChainCall[] = [];
  const chain = {
    calls,
    insert: vi.fn(),
    select: vi.fn(),
    single: vi.fn(),
  };
  for (const m of ["insert", "select"] as const) {
    chain[m].mockImplementation((...args: unknown[]) => {
      calls.push({ method: m, args });
      return chain;
    });
  }
  chain.single.mockImplementation((...args: unknown[]) => {
    calls.push({ method: "single", args });
    return Promise.resolve(result);
  });
  return chain;
}

beforeEach(() => {
  fromMock.mockReset();
});

describe("getMessagesForConversation", () => {
  it("queries messages by conversation_id, ordered by timestamp asc", async () => {
    const chain = makeReadChain({ data: [], error: null });
    fromMock.mockReturnValue(chain);

    await getMessagesForConversation("conv-1");

    expect(fromMock).toHaveBeenCalledWith("messages");
    const eq = chain.calls.find((c) => c.method === "eq");
    expect(eq?.args).toEqual(["conversation_id", "conv-1"]);
    const order = chain.calls.find((c) => c.method === "order");
    expect(order?.args[0]).toBe("timestamp");
    expect((order?.args[1] as { ascending: boolean }).ascending).toBe(true);
  });

  it("returns rows on success", async () => {
    const rows = [{ id: "m1", content: "hi" }];
    const chain = makeReadChain({ data: rows, error: null });
    fromMock.mockReturnValue(chain);

    const result = await getMessagesForConversation("conv-1");

    expect(result).toEqual(rows);
  });

  it("throws a wrapped error", async () => {
    const chain = makeReadChain({ data: null, error: { message: "down" } });
    fromMock.mockReturnValue(chain);

    await expect(getMessagesForConversation("conv-1")).rejects.toThrow("Failed to load messages: down");
  });
});

describe("sendOutboundMessage", () => {
  it("rejects empty content without hitting the DB", async () => {
    await expect(sendOutboundMessage({ conversationId: "conv-1", content: "   " })).rejects.toThrow(
      "Cannot send an empty message",
    );
    expect(fromMock).not.toHaveBeenCalled();
  });

  it("inserts an outbound text message and returns the row", async () => {
    const row = {
      id: "m99",
      conversation_id: "conv-1",
      content: "hello",
      direction: "outbound",
      message_type: "text",
    };
    const chain = makeInsertChain({ data: row, error: null });
    fromMock.mockReturnValue(chain);

    const result = await sendOutboundMessage({ conversationId: "conv-1", content: "  hello  " });

    const insertCall = chain.calls.find((c) => c.method === "insert");
    const payload = insertCall?.args[0] as Record<string, unknown>;
    expect(payload.conversation_id).toBe("conv-1");
    expect(payload.direction).toBe("outbound");
    expect(payload.message_type).toBe("text");
    expect(payload.content).toBe("hello");
    expect(typeof payload.timestamp).toBe("string");
    expect(result).toEqual(row);
  });

  it("throws a wrapped error when the insert fails", async () => {
    const chain = makeInsertChain({ data: null, error: { message: "rls denied" } });
    fromMock.mockReturnValue(chain);

    await expect(
      sendOutboundMessage({ conversationId: "conv-1", content: "hello" }),
    ).rejects.toThrow("Failed to send message: rls denied");
  });
});
