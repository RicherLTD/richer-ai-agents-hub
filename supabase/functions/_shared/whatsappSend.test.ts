import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { sendWhatsAppText } from "./whatsappSend.ts";

const SEND_ARGS = {
  apiUrl: "https://example.test/v22",
  accessToken: "tok-secret-123",
  phoneNumberId: "phone-1",
  to: "972500000000",
  body: "hello world",
};

function mockResponse(status: number, body: string | object): Response {
  const text = typeof body === "string" ? body : JSON.stringify(body);
  return new Response(text, {
    status,
    headers: { "Content-Type": typeof body === "string" ? "text/plain" : "application/json" },
  });
}

describe("sendWhatsAppText", () => {
  let fetchMock: ReturnType<typeof vi.fn>;

  beforeEach(() => {
    vi.useFakeTimers();
    fetchMock = vi.fn();
    vi.stubGlobal("fetch", fetchMock);
  });

  afterEach(() => {
    vi.useRealTimers();
    vi.unstubAllGlobals();
    vi.clearAllMocks();
  });

  it("returns ok + metaMessageId on a successful 200 with a wamid", async () => {
    fetchMock.mockResolvedValueOnce(
      mockResponse(200, { messages: [{ id: "wamid.ABC" }] }),
    );
    const result = await sendWhatsAppText(SEND_ARGS);
    expect(result).toEqual({
      ok: true,
      metaMessageId: "wamid.ABC",
      attempts: 1,
      status: 200,
    });
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });

  it("returns ok with null metaMessageId when body has no wamid", async () => {
    fetchMock.mockResolvedValueOnce(mockResponse(200, { messages: [] }));
    const result = await sendWhatsAppText(SEND_ARGS);
    expect(result.ok).toBe(true);
    if (result.ok) expect(result.metaMessageId).toBeNull();
  });

  it("returns ok with null metaMessageId when response is non-JSON", async () => {
    fetchMock.mockResolvedValueOnce(mockResponse(200, "OK"));
    const result = await sendWhatsAppText(SEND_ARGS);
    expect(result.ok).toBe(true);
    if (result.ok) expect(result.metaMessageId).toBeNull();
  });

  it("returns ok with null metaMessageId when JSON root is an array", async () => {
    fetchMock.mockResolvedValueOnce(mockResponse(200, [{ id: "wamid.X" }]));
    const result = await sendWhatsAppText(SEND_ARGS);
    expect(result.ok).toBe(true);
    if (result.ok) expect(result.metaMessageId).toBeNull();
  });

  it("returns terminal: true immediately on 401 (no retry)", async () => {
    fetchMock.mockResolvedValueOnce(mockResponse(401, "Unauthorized"));
    const result = await sendWhatsAppText(SEND_ARGS);
    expect(result).toMatchObject({ ok: false, status: 401, attempts: 1, terminal: true });
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });

  it("returns terminal: true immediately on 422", async () => {
    fetchMock.mockResolvedValueOnce(mockResponse(422, "Bad payload"));
    const result = await sendWhatsAppText(SEND_ARGS);
    expect(result).toMatchObject({ ok: false, status: 422, attempts: 1, terminal: true });
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });

  it("retries on 5xx and succeeds on the second attempt", async () => {
    fetchMock
      .mockResolvedValueOnce(mockResponse(503, "Service unavailable"))
      .mockResolvedValueOnce(mockResponse(200, { messages: [{ id: "wamid.RECOVER" }] }));
    const promise = sendWhatsAppText(SEND_ARGS);
    await vi.advanceTimersByTimeAsync(1100);
    const result = await promise;
    expect(result).toEqual({
      ok: true,
      metaMessageId: "wamid.RECOVER",
      attempts: 2,
      status: 200,
    });
    expect(fetchMock).toHaveBeenCalledTimes(2);
  });

  it("retries on 429 (rate limit)", async () => {
    fetchMock
      .mockResolvedValueOnce(mockResponse(429, "Too many"))
      .mockResolvedValueOnce(mockResponse(200, { messages: [{ id: "wamid.AFTER429" }] }));
    const promise = sendWhatsAppText(SEND_ARGS);
    await vi.advanceTimersByTimeAsync(1100);
    const result = await promise;
    expect(result.ok).toBe(true);
    expect(fetchMock).toHaveBeenCalledTimes(2);
  });

  it("returns ok: false, terminal: false after exhausting 3 attempts of 5xx", async () => {
    fetchMock
      .mockResolvedValueOnce(mockResponse(500, "boom"))
      .mockResolvedValueOnce(mockResponse(500, "boom"))
      .mockResolvedValueOnce(mockResponse(500, "boom"));
    const promise = sendWhatsAppText(SEND_ARGS);
    // 1s + 2s of backoff between attempts
    await vi.advanceTimersByTimeAsync(3100);
    const result = await promise;
    expect(result).toMatchObject({
      ok: false,
      status: 500,
      attempts: 3,
      terminal: false,
    });
    expect(fetchMock).toHaveBeenCalledTimes(3);
  });

  it("retries on network errors", async () => {
    fetchMock
      .mockRejectedValueOnce(new TypeError("network rejected"))
      .mockResolvedValueOnce(mockResponse(200, { messages: [{ id: "wamid.NET" }] }));
    const promise = sendWhatsAppText(SEND_ARGS);
    await vi.advanceTimersByTimeAsync(1100);
    const result = await promise;
    expect(result.ok).toBe(true);
    expect(fetchMock).toHaveBeenCalledTimes(2);
  });

  it("redacts Bearer tokens in errorBody before returning", async () => {
    fetchMock.mockResolvedValueOnce(
      mockResponse(401, "Invalid Bearer xyz123-secret-abc"),
    );
    const result = await sendWhatsAppText(SEND_ARGS);
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.errorBody).not.toContain("xyz123-secret-abc");
      expect(result.errorBody).toContain("Bearer [REDACTED]");
    }
  });

  it("truncates very long error bodies", async () => {
    const longBody = "x".repeat(5000);
    fetchMock.mockResolvedValueOnce(mockResponse(400, longBody));
    const result = await sendWhatsAppText(SEND_ARGS);
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.errorBody.length).toBeLessThanOrEqual(300);
      expect(result.errorBody.endsWith("…[truncated]")).toBe(true);
    }
  });

  it("sends the correct payload shape to HookMyApp", async () => {
    fetchMock.mockResolvedValueOnce(mockResponse(200, { messages: [{ id: "wamid.OK" }] }));
    await sendWhatsAppText(SEND_ARGS);
    expect(fetchMock).toHaveBeenCalledWith(
      "https://example.test/v22/phone-1/messages",
      expect.objectContaining({
        method: "POST",
        headers: expect.objectContaining({
          Authorization: "Bearer tok-secret-123",
          "Content-Type": "application/json",
        }),
        body: JSON.stringify({
          messaging_product: "whatsapp",
          to: "972500000000",
          type: "text",
          text: { body: "hello world" },
        }),
      }),
    );
  });
});
