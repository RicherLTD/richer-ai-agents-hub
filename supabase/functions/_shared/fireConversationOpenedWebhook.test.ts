import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  buildConversationOpenedPayload,
  fireConversationOpenedWebhook,
} from "./fireConversationOpenedWebhook.ts";

describe("buildConversationOpenedPayload", () => {
  it("produces the canonical flat shape with event=conversation_opened", () => {
    const payload = buildConversationOpenedPayload({
      agentId: "agent-1",
      agentName: "affiliate_marketing",
      product: "B",
      conversationId: "conv-1",
      leadPhone: "+972551234567",
      leadName: "ישראל ישראלי",
      status: "active",
      sourceCampaign: "fb-may-13",
      sourceFunnel: "whatsapp_sandbox",
      createdAt: "2026-05-13T10:25:00.000Z",
      conversationViewUrl: "https://view.example.com/conv-1",
    });

    expect(payload).toEqual({
      event: "conversation_opened",
      agent_id: "agent-1",
      agent_name: "affiliate_marketing",
      product: "B",
      conversation_id: "conv-1",
      lead_phone: "+972551234567",
      lead_name: "ישראל ישראלי",
      status: "active",
      source_campaign: "fb-may-13",
      source_funnel: "whatsapp_sandbox",
      created_at: "2026-05-13T10:25:00.000Z",
      conversation_view_url: "https://view.example.com/conv-1",
      iframe:
        '<iframe src="https://view.example.com/conv-1" style="width:100%;height:720px;border:0;border-radius:12px;" title="שיחה עם הליד"></iframe>',
    });
  });

  it("sets iframe to null when conversationViewUrl is null", () => {
    const payload = buildConversationOpenedPayload({
      agentId: "agent-1",
      agentName: null,
      product: null,
      conversationId: "conv-1",
      leadPhone: "+972551234567",
      leadName: null,
      status: null,
      sourceCampaign: null,
      sourceFunnel: null,
      createdAt: null,
      conversationViewUrl: null,
    });

    expect(payload.conversation_view_url).toBeNull();
    expect(payload.iframe).toBeNull();
  });
});

describe("fireConversationOpenedWebhook", () => {
  const payload = buildConversationOpenedPayload({
    agentId: "agent-1",
    agentName: "affiliate_marketing",
    product: "B",
    conversationId: "conv-1",
    leadPhone: "+972551234567",
    leadName: "ישראל ישראלי",
    status: "active",
    sourceCampaign: "fb-may-13",
    sourceFunnel: "whatsapp_sandbox",
    createdAt: "2026-05-13T10:25:00.000Z",
    conversationViewUrl: "https://view.example.com/conv-1",
  });

  beforeEach(() => {
    vi.useFakeTimers();
  });
  afterEach(() => {
    vi.restoreAllMocks();
    vi.useRealTimers();
  });

  it("rejects non-http URLs without firing fetch (badUrl = true)", async () => {
    const fetchMock = vi.fn();
    vi.stubGlobal("fetch", fetchMock);
    const result = await fireConversationOpenedWebhook({
      url: "not-a-url",
      payload,
    });
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.badUrl).toBe(true);
      expect(result.terminal).toBe(true);
      expect(result.attempts).toBe(0);
    }
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it("POSTs to the URL with JSON content-type and returns ok on 200", async () => {
    const fetchMock = vi.fn().mockResolvedValue(
      new Response(JSON.stringify({ ok: true }), { status: 200 }),
    );
    vi.stubGlobal("fetch", fetchMock);
    const result = await fireConversationOpenedWebhook({
      url: "https://hook.eu1.make.com/abc123",
      payload,
    });
    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.attempts).toBe(1);
      expect(result.status).toBe(200);
    }
    expect(fetchMock).toHaveBeenCalledTimes(1);
    const [calledUrl, init] = fetchMock.mock.calls[0] as [string, RequestInit];
    expect(calledUrl).toBe("https://hook.eu1.make.com/abc123");
    expect(init.method).toBe("POST");
    expect((init.headers as Record<string, string>)["Content-Type"])
      .toBe("application/json");
    expect((init.headers as Record<string, string>)["User-Agent"])
      .toBe("richer-conversation-opened/1");
    expect(JSON.parse(init.body as string)).toEqual(payload);
  });

  it("retries on 503 and succeeds on the second attempt", async () => {
    const fetchMock = vi.fn()
      .mockResolvedValueOnce(new Response("upstream temporarily down", { status: 503 }))
      .mockResolvedValueOnce(new Response(null, { status: 200 }));
    vi.stubGlobal("fetch", fetchMock);
    const promise = fireConversationOpenedWebhook({
      url: "https://hook.eu1.make.com/abc",
      payload,
    });
    await vi.advanceTimersByTimeAsync(1000);
    const result = await promise;
    expect(result.ok).toBe(true);
    if (result.ok) expect(result.attempts).toBe(2);
    expect(fetchMock).toHaveBeenCalledTimes(2);
  });

  it("does NOT retry on 401 (non-retryable client error)", async () => {
    const fetchMock = vi.fn().mockResolvedValue(
      new Response("unauthorized", { status: 401 }),
    );
    vi.stubGlobal("fetch", fetchMock);
    const result = await fireConversationOpenedWebhook({
      url: "https://hook.eu1.make.com/abc",
      payload,
    });
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.terminal).toBe(true);
      expect(result.status).toBe(401);
      expect(result.attempts).toBe(1);
    }
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });

  it("gives up after MAX_ATTEMPTS on persistent 5xx (terminal=false)", async () => {
    const fetchMock = vi.fn().mockResolvedValue(new Response("nope", { status: 502 }));
    vi.stubGlobal("fetch", fetchMock);
    const promise = fireConversationOpenedWebhook({
      url: "https://hook.eu1.make.com/abc",
      payload,
    });
    await vi.advanceTimersByTimeAsync(3500);
    const result = await promise;
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.terminal).toBe(false);
      expect(result.attempts).toBe(3);
      expect(result.status).toBe(502);
    }
    expect(fetchMock).toHaveBeenCalledTimes(3);
  });

  it("never throws even when fetch rejects with a network error", async () => {
    const fetchMock = vi.fn().mockRejectedValue(new Error("network down"));
    vi.stubGlobal("fetch", fetchMock);
    const promise = fireConversationOpenedWebhook({
      url: "https://hook.eu1.make.com/abc",
      payload,
    });
    await vi.advanceTimersByTimeAsync(3500);
    await expect(promise).resolves.not.toThrow();
    const result = await promise;
    expect(result.ok).toBe(false);
  });
});
