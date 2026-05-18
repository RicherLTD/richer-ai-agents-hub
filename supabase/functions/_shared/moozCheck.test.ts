import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { checkMoozBooking, normalizePhoneForMooz } from "./moozCheck.ts";

describe("normalizePhoneForMooz", () => {
  it("strips +972 country code and returns last 9 digits", () => {
    expect(normalizePhoneForMooz("+972551234567")).toBe("551234567");
  });

  it("strips bare 972 country code", () => {
    expect(normalizePhoneForMooz("972551234567")).toBe("551234567");
  });

  it("strips Israeli leading zero (10-digit local form)", () => {
    expect(normalizePhoneForMooz("0551234567")).toBe("551234567");
  });

  it("returns 9-digit input unchanged", () => {
    expect(normalizePhoneForMooz("551234567")).toBe("551234567");
  });

  it("removes spaces, dashes, parentheses", () => {
    expect(normalizePhoneForMooz("+972-55-123-4567")).toBe("551234567");
    expect(normalizePhoneForMooz("(055) 123 4567")).toBe("551234567");
  });

  it("returns empty for too-short input", () => {
    expect(normalizePhoneForMooz("12345")).toBe("");
    expect(normalizePhoneForMooz("")).toBe("");
  });

  it("normalises +972 and 0XX forms to the same suffix", () => {
    expect(normalizePhoneForMooz("0551234567"))
      .toBe(normalizePhoneForMooz("+972551234567"));
  });

  it("REJECTS US number (+1) -- 11 digits, no Israeli prefix", () => {
    expect(normalizePhoneForMooz("+12025551234")).toBe("");
    expect(normalizePhoneForMooz("12025551234")).toBe("");
  });

  it("REJECTS Israeli landline (+972XYYYYYYY) -- only 8 digits after country code", () => {
    expect(normalizePhoneForMooz("+97225551234")).toBe("");
    expect(normalizePhoneForMooz("025551234")).toBe("");
  });

  it("REJECTS too-long inputs (avoid blind truncation)", () => {
    expect(normalizePhoneForMooz("+9725512345678")).toBe("");
  });
});

describe("checkMoozBooking", () => {
  beforeEach(() => {
    vi.useFakeTimers();
  });
  afterEach(() => {
    vi.restoreAllMocks();
    vi.useRealTimers();
  });

  it("returns bad_url when the URL is not http(s)", async () => {
    const fetchMock = vi.fn();
    vi.stubGlobal("fetch", fetchMock);
    const result = await checkMoozBooking({
      url: "not-a-url",
      token: "t",
      phone: "+972551234567",
    });
    expect(result.booked).toBe(false);
    if (!result.booked) expect(result.reason).toBe("bad_url");
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it("returns non_israeli_phone for an unrecognised number", async () => {
    const fetchMock = vi.fn();
    vi.stubGlobal("fetch", fetchMock);
    const result = await checkMoozBooking({
      url: "https://mooz.example.com/api/bookings/lookup",
      token: "t",
      phone: "+12025551234",
    });
    expect(result.booked).toBe(false);
    if (!result.booked) expect(result.reason).toBe("non_israeli_phone");
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it("returns non_israeli_phone for too-short input", async () => {
    const fetchMock = vi.fn();
    vi.stubGlobal("fetch", fetchMock);
    const result = await checkMoozBooking({
      url: "https://mooz.example.com/api/bookings/lookup",
      token: "t",
      phone: "12345",
    });
    expect(result.booked).toBe(false);
    if (!result.booked) expect(result.reason).toBe("non_israeli_phone");
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it("returns booked=true with scheduledAt and meetingId from Mooz", async () => {
    const fetchMock = vi.fn().mockResolvedValue(
      new Response(
        JSON.stringify({
          booked: true,
          scheduled_at: "2026-05-20T14:00:00.000Z",
          meeting_id: "mtg_abc",
        }),
        { status: 200, headers: { "Content-Type": "application/json" } },
      ),
    );
    vi.stubGlobal("fetch", fetchMock);
    const result = await checkMoozBooking({
      url: "https://mooz.example.com/api/bookings/lookup",
      token: "secret",
      phone: "+972551234567",
    });
    expect(result.booked).toBe(true);
    if (result.booked) {
      expect(result.scheduledAt).toBe("2026-05-20T14:00:00.000Z");
      expect(result.meetingId).toBe("mtg_abc");
    }
    expect(fetchMock).toHaveBeenCalledTimes(1);
    const [calledUrl, init] = fetchMock.mock.calls[0] as [string, RequestInit];
    expect(calledUrl).toBe(
      "https://mooz.example.com/api/bookings/lookup?phone=551234567",
    );
    expect(init.method).toBe("GET");
    expect((init.headers as Record<string, string>).Authorization).toBe(
      "Bearer secret",
    );
  });

  it("returns booked=false (not_booked) when Mooz says booked=false", async () => {
    const fetchMock = vi.fn().mockResolvedValue(
      new Response(JSON.stringify({ booked: false }), {
        status: 200,
        headers: { "Content-Type": "application/json" },
      }),
    );
    vi.stubGlobal("fetch", fetchMock);
    const result = await checkMoozBooking({
      url: "https://mooz.example.com/api/bookings/lookup",
      token: "secret",
      phone: "+972551234567",
    });
    expect(result.booked).toBe(false);
    if (!result.booked) expect(result.reason).toBe("not_booked");
  });

  it("returns invalid_response when body lacks a boolean booked field", async () => {
    const fetchMock = vi.fn().mockResolvedValue(
      new Response(JSON.stringify({ status: "ok" }), {
        status: 200,
        headers: { "Content-Type": "application/json" },
      }),
    );
    vi.stubGlobal("fetch", fetchMock);
    const result = await checkMoozBooking({
      url: "https://mooz.example.com/api/bookings/lookup",
      token: "secret",
      phone: "+972551234567",
    });
    expect(result.booked).toBe(false);
    if (!result.booked) expect(result.reason).toBe("invalid_response");
  });

  it("returns invalid_response when body is not JSON", async () => {
    const fetchMock = vi.fn().mockResolvedValue(
      new Response("oops not json", { status: 200 }),
    );
    vi.stubGlobal("fetch", fetchMock);
    const result = await checkMoozBooking({
      url: "https://mooz.example.com/api/bookings/lookup",
      token: "secret",
      phone: "+972551234567",
    });
    expect(result.booked).toBe(false);
    if (!result.booked) expect(result.reason).toBe("invalid_response");
  });

  it("returns http_error on 401 (NOT retryable) -- and DOES NOT include errorBody (token-leak guard)", async () => {
    const fetchMock = vi.fn().mockResolvedValue(
      new Response("Bearer secret-leaked-in-body", { status: 401 }),
    );
    vi.stubGlobal("fetch", fetchMock);
    const result = await checkMoozBooking({
      url: "https://mooz.example.com/api/bookings/lookup",
      token: "bad",
      phone: "+972551234567",
    });
    expect(result.booked).toBe(false);
    if (!result.booked && result.reason === "http_error") {
      expect(result.status).toBe(401);
      // Critical: outcome must NOT expose the response body since Mooz
      // could echo the Authorization header value. The TS shape no
      // longer has `errorBody`.
      expect("errorBody" in result).toBe(false);
    }
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });

  it("retries on 503 and succeeds on the second attempt", async () => {
    const fetchMock = vi.fn()
      .mockResolvedValueOnce(new Response("upstream down", { status: 503 }))
      .mockResolvedValueOnce(
        new Response(JSON.stringify({ booked: true }), {
          status: 200,
          headers: { "Content-Type": "application/json" },
        }),
      );
    vi.stubGlobal("fetch", fetchMock);
    const promise = checkMoozBooking({
      url: "https://mooz.example.com/api/bookings/lookup",
      token: "secret",
      phone: "+972551234567",
    });
    await vi.advanceTimersByTimeAsync(500);
    const result = await promise;
    expect(result.booked).toBe(true);
    expect(fetchMock).toHaveBeenCalledTimes(2);
  });

  it("returns http_error after MAX_ATTEMPTS on persistent 5xx", async () => {
    const fetchMock = vi.fn().mockResolvedValue(
      new Response("nope", { status: 502 }),
    );
    vi.stubGlobal("fetch", fetchMock);
    const promise = checkMoozBooking({
      url: "https://mooz.example.com/api/bookings/lookup",
      token: "secret",
      phone: "+972551234567",
    });
    await vi.advanceTimersByTimeAsync(1000);
    const result = await promise;
    expect(result.booked).toBe(false);
    if (!result.booked) {
      expect(result.reason).toBe("http_error");
    }
    expect(fetchMock).toHaveBeenCalledTimes(2);
  });

  it("returns timeout when fetch is aborted on both attempts", async () => {
    const fetchMock = vi.fn().mockImplementation((_url: string, init?: RequestInit) => {
      return new Promise((_resolve, reject) => {
        const signal = init?.signal;
        if (signal) {
          signal.addEventListener("abort", () => {
            const err = new Error("aborted");
            err.name = "AbortError";
            reject(err);
          });
        }
      });
    });
    vi.stubGlobal("fetch", fetchMock);
    const promise = checkMoozBooking({
      url: "https://mooz.example.com/api/bookings/lookup",
      token: "secret",
      phone: "+972551234567",
    });
    await vi.advanceTimersByTimeAsync(11_000);
    const result = await promise;
    expect(result.booked).toBe(false);
    if (!result.booked) expect(result.reason).toBe("timeout");
    expect(fetchMock).toHaveBeenCalledTimes(2);
  });
});
