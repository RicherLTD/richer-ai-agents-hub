import { beforeEach, describe, expect, it, vi } from "vitest";

const { invokeMock } = vi.hoisted(() => ({ invokeMock: vi.fn() }));
vi.mock("@/lib/supabase/client", () => ({
  supabase: { functions: { invoke: invokeMock } },
}));

import { fetchEmbedConversation } from "./embed";

beforeEach(() => invokeMock.mockReset());

describe("fetchEmbedConversation", () => {
  it("invokes conversation-view with the url params and returns data", async () => {
    invokeMock.mockResolvedValue({
      data: { lead: { name: "דני", phone: "972525188599" }, messages: [] },
      error: null,
    });
    const res = await fetchEmbedConversation({ p: "972525188599", product: "B", sig: "abc" });
    expect(invokeMock).toHaveBeenCalledWith("conversation-view", {
      body: { p: "972525188599", product: "B", sig: "abc" },
    });
    expect(res.lead?.name).toBe("דני");
    expect(res.messages).toEqual([]);
  });

  it("throws when the edge function errors", async () => {
    invokeMock.mockResolvedValue({ data: null, error: { message: "forbidden" } });
    await expect(
      fetchEmbedConversation({ p: "x", product: "B", sig: "bad" }),
    ).rejects.toThrow(/forbidden/);
  });
});
