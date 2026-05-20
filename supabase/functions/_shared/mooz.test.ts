import { describe, expect, it } from "vitest";
import { MoozClient } from "./mooz.ts";

interface RecordedCall {
  url: string;
  method: string;
  headers: Record<string, string>;
  body: string | null;
}

function makeFetch(
  respond: (call: RecordedCall) => { status: number; body: string },
): { fetchImpl: typeof fetch; calls: RecordedCall[] } {
  const calls: RecordedCall[] = [];
  const fetchImpl = (async (
    input: string | URL | Request,
    init?: RequestInit,
  ): Promise<Response> => {
    const url = typeof input === "string" ? input : input.toString();
    const headers: Record<string, string> = {};
    const rawHeaders = init?.headers as Record<string, string> | Headers | undefined;
    if (rawHeaders instanceof Headers) {
      rawHeaders.forEach((v, k) => (headers[k] = v));
    } else if (rawHeaders) {
      Object.assign(headers, rawHeaders);
    }
    const call: RecordedCall = {
      url,
      method: init?.method ?? "GET",
      headers,
      body: typeof init?.body === "string" ? init.body : null,
    };
    calls.push(call);
    const r = respond(call);
    return new Response(r.body, {
      status: r.status,
      headers: { "Content-Type": "application/json" },
    });
  }) as unknown as typeof fetch;
  return { fetchImpl, calls };
}

const VALID_UTC = "2026-05-21T11:00:00.000Z";
const VALID_END = "2026-05-21T11:30:00.000Z";

describe("MoozClient.listAvailableSlots", () => {
  it("builds the URL with all 3 params and Bearer header", async () => {
    const { fetchImpl, calls } = makeFetch(() => ({
      status: 200,
      body: JSON.stringify({ data: [{ start: VALID_UTC, end: VALID_END }] }),
    }));
    const mooz = new MoozClient({
      orgApiKey: "ORG_KEY_123",
      baseUrl: "https://test.mooz.local/functions/v1",
      fetchImpl,
    });
    const slots = await mooz.listAvailableSlots({
      meetingTypeId: "uuid-1",
      from: VALID_UTC,
      to: VALID_END,
    });
    expect(slots).toHaveLength(1);
    expect(calls).toHaveLength(1);
    expect(calls[0].url).toContain("action=list_available_slots");
    expect(calls[0].url).toContain("meeting_type_id=uuid-1");
    expect(calls[0].url).toContain("from=2026-05-21T11");
    expect(calls[0].url).toContain("to=2026-05-21T11");
    expect(calls[0].headers.Authorization).toBe("Bearer ORG_KEY_123");
  });

  it("rejects non-UTC ISO inputs", async () => {
    const { fetchImpl } = makeFetch(() => ({ status: 200, body: '{"data":[]}' }));
    const mooz = new MoozClient({ orgApiKey: "k", fetchImpl });
    await expect(
      mooz.listAvailableSlots({
        meetingTypeId: "uuid-1",
        from: "2026-05-21",
        to: VALID_END,
      }),
    ).rejects.toThrow(/UTC ISO/);
  });
});

describe("MoozClient.createBooking", () => {
  it("201 returns ok=true with full booking row", async () => {
    const { fetchImpl, calls } = makeFetch(() => ({
      status: 201,
      body: JSON.stringify({
        data: {
          id: "book-1",
          meeting_type_id: "uuid-1",
          customer_name: "Shlomo",
          customer_email: "s@example.com",
          customer_phone: "+972500000000",
          start_time: VALID_UTC,
          end_time: VALID_END,
          timezone: "Asia/Jerusalem",
          status: "confirmed",
        },
      }),
    }));
    const mooz = new MoozClient({ orgApiKey: "k", fetchImpl });
    const r = await mooz.createBooking({
      meetingTypeId: "uuid-1",
      customerName: "Shlomo",
      customerEmail: "s@example.com",
      startTime: VALID_UTC,
      endTime: VALID_END,
    });
    expect(r.ok).toBe(true);
    if (r.ok) expect(r.booking.id).toBe("book-1");
    expect(calls[0].method).toBe("POST");
    expect(calls[0].url).toContain("action=create_booking");
    const sentBody = JSON.parse(calls[0].body ?? "{}");
    expect(sentBody.meeting_type_id).toBe("uuid-1");
    expect(sentBody.timezone).toBe("Asia/Jerusalem");
  });

  it("409 'fully booked' maps to slot_full", async () => {
    const { fetchImpl } = makeFetch(() => ({
      status: 409,
      body: JSON.stringify({ error: "This time slot is fully booked" }),
    }));
    const mooz = new MoozClient({ orgApiKey: "k", fetchImpl });
    const r = await mooz.createBooking({
      meetingTypeId: "uuid-1",
      customerName: "X",
      customerEmail: "x@example.com",
      startTime: VALID_UTC,
      endTime: VALID_END,
    });
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.kind).toBe("slot_full");
  });

  it("409 'Duplicate' maps to duplicate", async () => {
    const { fetchImpl } = makeFetch(() => ({
      status: 409,
      body: JSON.stringify({ error: "Duplicate booking – already booked for this slot" }),
    }));
    const mooz = new MoozClient({ orgApiKey: "k", fetchImpl });
    const r = await mooz.createBooking({
      meetingTypeId: "uuid-1",
      customerName: "X",
      customerEmail: "x@example.com",
      startTime: VALID_UTC,
      endTime: VALID_END,
    });
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.kind).toBe("duplicate");
  });

  it("400 maps to invalid_input", async () => {
    const { fetchImpl } = makeFetch(() => ({
      status: 400,
      body: JSON.stringify({ error: "invalid email format" }),
    }));
    const mooz = new MoozClient({ orgApiKey: "k", fetchImpl });
    const r = await mooz.createBooking({
      meetingTypeId: "uuid-1",
      customerName: "X",
      customerEmail: "bad",
      startTime: VALID_UTC,
      endTime: VALID_END,
    });
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.kind).toBe("invalid_input");
  });

  it("500 maps to server_error with status", async () => {
    const { fetchImpl } = makeFetch(() => ({
      status: 500,
      body: JSON.stringify({ error: "boom" }),
    }));
    const mooz = new MoozClient({ orgApiKey: "k", fetchImpl });
    const r = await mooz.createBooking({
      meetingTypeId: "uuid-1",
      customerName: "X",
      customerEmail: "x@example.com",
      startTime: VALID_UTC,
      endTime: VALID_END,
    });
    expect(r.ok).toBe(false);
    if (!r.ok && r.kind === "server_error") {
      expect(r.status).toBe(500);
    } else {
      throw new Error("expected server_error");
    }
  });

  it("refuses non-UTC start_time", async () => {
    const { fetchImpl } = makeFetch(() => ({ status: 201, body: "{}" }));
    const mooz = new MoozClient({ orgApiKey: "k", fetchImpl });
    await expect(
      mooz.createBooking({
        meetingTypeId: "uuid-1",
        customerName: "X",
        customerEmail: "x@example.com",
        startTime: "2026-05-21T11:00:00",
        endTime: VALID_END,
      }),
    ).rejects.toThrow(/UTC ISO/);
  });
});

describe("MoozClient.lookupByPhone", () => {
  it("uses lookup token, not org key", async () => {
    const { fetchImpl, calls } = makeFetch(() => ({
      status: 200,
      body: JSON.stringify({ booked: true, scheduled_at: VALID_UTC, meeting_id: "book-1" }),
    }));
    const mooz = new MoozClient({
      orgApiKey: "ORG_KEY",
      lookupToken: "LOOKUP_TOKEN",
      fetchImpl,
    });
    const r = await mooz.lookupByPhone("+972500000000");
    expect(r.booked).toBe(true);
    expect(calls[0].headers.Authorization).toBe("Bearer LOOKUP_TOKEN");
    expect(calls[0].url).toContain("/bookings-lookup");
  });

  it("returns booked=false with error when token missing", async () => {
    const { fetchImpl, calls } = makeFetch(() => ({ status: 200, body: "{}" }));
    const mooz = new MoozClient({ orgApiKey: "ORG_KEY", fetchImpl });
    const r = await mooz.lookupByPhone("+972500000000");
    expect(r.booked).toBe(false);
    if (!r.booked && "error" in r) {
      expect(r.error).toContain("MOOZ_API_TOKEN not configured");
    }
    expect(calls).toHaveLength(0);
  });
});
