import { beforeEach, describe, expect, it, vi } from "vitest";

const { fromMock, invokeMock } = vi.hoisted(() => ({
  fromMock: vi.fn(),
  invokeMock: vi.fn(),
}));

vi.mock("@/lib/supabase/client", () => ({
  supabase: { from: fromMock, functions: { invoke: invokeMock } },
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

beforeEach(() => {
  fromMock.mockReset();
  invokeMock.mockReset();
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
  it("rejects empty content without invoking the edge function", async () => {
    await expect(sendOutboundMessage({ conversationId: "conv-1", content: "   " })).rejects.toThrow(
      "Cannot send an empty message",
    );
    expect(invokeMock).not.toHaveBeenCalled();
  });

  it("invokes whatsapp-send with trimmed content and returns the row", async () => {
    const row = {
      id: "m99",
      conversation_id: "conv-1",
      content: "hello",
      direction: "outbound",
      message_type: "text",
    };
    invokeMock.mockResolvedValue({ data: row, error: null });

    const result = await sendOutboundMessage({ conversationId: "conv-1", content: "  hello  " });

    expect(invokeMock).toHaveBeenCalledWith("whatsapp-send", {
      body: { conversation_id: "conv-1", content: "hello" },
    });
    expect(result).toEqual(row);
  });

  it("throws a wrapped error when the edge function fails", async () => {
    invokeMock.mockResolvedValue({ data: null, error: { message: "send failed" } });

    await expect(
      sendOutboundMessage({ conversationId: "conv-1", content: "hello" }),
    ).rejects.toThrow("Failed to send message: send failed");
  });
});
