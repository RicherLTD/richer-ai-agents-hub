import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  buildHandoffPayload,
  fireHandoffWebhook,
  type HandoffConversation,
  type HandoffLeadMemory,
} from "./fireHandoffWebhook.ts";

const baseConversation: HandoffConversation = {
  id: "conv-1",
  lead_phone: "+972551234567",
  lead_name: "ישראל ישראלי",
  status: "paused",
  current_tag: "zoom_scheduled",
  funnel_stage: "done",
  zoom_scheduled_at: "2026-05-13T10:30:00.000Z",
  source_campaign: "fb-may-13",
  source_funnel: "whatsapp_sandbox",
  created_at: "2026-05-13T10:25:00.000Z",
};

const baseMemory: HandoffLeadMemory = {
  q1_age: 28,
  q2_motivation: "הכנסה נוספת",
  q3_dream_change: "חופש פיננסי",
  q4_blocker: "אין ניסיון",
  q5_urgency: "בחודש הקרוב",
  q6_investment: "עד 10,000",
  conversation_summary: "ליד בן 28 שמחפש הכנסה נוספת.",
  primary_objection: "timing",
  red_flags: [],
  notes_for_advisor: "מעוניין בזום השבוע.",
};

describe("buildHandoffPayload", () => {
  it("produces the canonical shape with all relevant fields", () => {
    const payload = buildHandoffPayload({
      agentId: "agent-1",
      agentName: "affiliate_marketing",
      conversation: baseConversation,
      leadMemory: baseMemory,
      now: "2026-05-13T10:30:00.000Z",
    });
    expect(payload).toEqual({
      event: "zoom_scheduled",
      timestamp: "2026-05-13T10:30:00.000Z",
      agent: { id: "agent-1", name: "affiliate_marketing" },
      conversation: baseConversation,
      lead_memory: baseMemory,
    });
  });

  it("defaults timestamp to current time when `now` is omitted", () => {
    const before = Date.now();
    const payload = buildHandoffPayload({
      agentId: "a",
      agentName: "x",
      conversation: baseConversation,
      leadMemory: baseMemory,
    });
    const ts = new Date(payload.timestamp).getTime();
    expect(ts).toBeGreaterThanOrEqual(before);
    expect(ts).toBeLessThanOrEqual(Date.now() + 1000);
  });
});

describe("fireHandoffWebhook", () => {
  const payload = buildHandoffPayload({
    agentId: "agent-1",
    agentName: "affiliate_marketing",
    conversation: baseConversation,
    leadMemory: baseMemory,
    now: "2026-05-13T10:30:00.000Z",
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
    const result = await fireHandoffWebhook({
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
    const result = await fireHandoffWebhook({
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
    expect(JSON.parse(init.body as string)).toEqual(payload);
  });

  it("includes X-Handoff-Signature-256 header when secret is provided", async () => {
    const fetchMock = vi.fn().mockResolvedValue(new Response(null, { status: 200 }));
    vi.stubGlobal("fetch", fetchMock);
    await fireHandoffWebhook({
      url: "https://hook.eu1.make.com/abc123",
      secret: "supersecret",
      payload,
    });
    const init = fetchMock.mock.calls[0][1] as RequestInit;
    const headers = init.headers as Record<string, string>;
    expect(headers["X-Handoff-Signature-256"]).toMatch(/^sha256=[0-9a-f]{64}$/);
  });

  it("does NOT include the signature header when no secret", async () => {
    const fetchMock = vi.fn().mockResolvedValue(new Response(null, { status: 200 }));
    vi.stubGlobal("fetch", fetchMock);
    await fireHandoffWebhook({
      url: "https://hook.eu1.make.com/abc123",
      payload,
    });
    const init = fetchMock.mock.calls[0][1] as RequestInit;
    const headers = init.headers as Record<string, string>;
    expect(headers["X-Handoff-Signature-256"]).toBeUndefined();
  });

  it("retries on 503 and succeeds on the second attempt", async () => {
    const fetchMock = vi.fn()
      .mockResolvedValueOnce(new Response("upstream temporarily down", { status: 503 }))
      .mockResolvedValueOnce(new Response(null, { status: 200 }));
    vi.stubGlobal("fetch", fetchMock);
    const promise = fireHandoffWebhook({
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
    const result = await fireHandoffWebhook({
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
    const promise = fireHandoffWebhook({
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
});
