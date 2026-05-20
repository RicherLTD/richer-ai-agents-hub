// mooz.ts
//
// Typed wrapper for Mooz's booking API. We talk to Mooz from two surfaces:
//
//   1. The agent reply loop (whatsapp-webhook) — lists real available
//      slots before offering them to the lead, then books on confirmation.
//   2. The bookings-lookup endpoint — checks whether a phone already has
//      a future booking (used to gate template dispatch + reconciliation).
//
// Endpoints reference (Mooz docs, 2026-05-20):
//   GET  /api-gateway?action=list_meeting_types
//   GET  /api-gateway?action=list_available_slots
//        ?meeting_type_id=<UUID>&from=<UTC ISO>&to=<UTC ISO>
//   POST /api-gateway?action=create_booking
//   GET  /bookings-lookup?phone=<digits>
//
// Auth model:
//   - api-gateway uses a per-org Bearer key (MOOZ_ORG_API_KEY)
//   - bookings-lookup uses a global Bearer token (MOOZ_API_TOKEN)
//
// All times returned/sent are UTC ISO 8601 strings. The bot converts to
// Asia/Jerusalem at the presentation layer only.

import { logError } from "./logError.ts";
import type { SupabaseClient } from "https://esm.sh/@supabase/supabase-js@2.45.4";

export const MOOZ_BASE_URL =
  "https://sxszrfumtwxayxkfncwa.supabase.co/functions/v1";

const REQUEST_TIMEOUT_MS = 8000;

export interface MoozMeetingType {
  id: string;
  numeric_id?: number;
  name: string;
  duration_minutes?: number;
  is_active?: boolean;
}

export interface MoozAvailableSlot {
  /** UTC ISO timestamp — when the slot starts. */
  start: string;
  /** UTC ISO timestamp — when the slot ends. */
  end: string;
}

export interface MoozCreateBookingArgs {
  meetingTypeId: string;
  customerName: string;
  customerEmail: string;
  customerPhone?: string;
  /** UTC ISO. */
  startTime: string;
  /** UTC ISO. */
  endTime: string;
  /** Optional override; defaults to Asia/Jerusalem on Mooz side. */
  timezone?: string;
  notes?: string;
}

export interface MoozBooking {
  id: string;
  meeting_type_id: string;
  customer_name: string;
  customer_email: string;
  customer_phone: string | null;
  start_time: string;
  end_time: string;
  timezone: string;
  status: string;
  cancel_token?: string;
  reschedule_token?: string;
  created_at?: string;
}

export type MoozCreateBookingResult =
  | { ok: true; booking: MoozBooking }
  | { ok: false; kind: "slot_full"; message: string }
  | { ok: false; kind: "duplicate"; message: string }
  | { ok: false; kind: "invalid_input"; message: string }
  | { ok: false; kind: "not_found"; message: string }
  | { ok: false; kind: "server_error"; message: string; status: number };

/** Strict ISO-8601 UTC: yyyy-mm-ddTHH:MM:SS(.sss)?Z */
const ISO_UTC = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d+)?Z$/;

function assertIsoUtc(label: string, value: string): void {
  if (!ISO_UTC.test(value)) {
    throw new Error(`mooz.${label} must be UTC ISO 8601 (got "${value}")`);
  }
}

interface MoozClientArgs {
  /** Org API key — used for api-gateway calls. */
  orgApiKey: string;
  /** Global token — used for bookings-lookup. Optional; lookup disabled if missing. */
  lookupToken?: string | null;
  /** Override the base URL in tests. Defaults to MOOZ_BASE_URL. */
  baseUrl?: string;
  /** Inject fetch for tests. */
  fetchImpl?: typeof fetch;
}

export class MoozClient {
  private readonly orgApiKey: string;
  private readonly lookupToken: string | null;
  private readonly baseUrl: string;
  private readonly fetchImpl: typeof fetch;

  constructor(args: MoozClientArgs) {
    if (!args.orgApiKey) throw new Error("MoozClient: orgApiKey is required");
    this.orgApiKey = args.orgApiKey;
    this.lookupToken = args.lookupToken ?? null;
    this.baseUrl = args.baseUrl ?? MOOZ_BASE_URL;
    this.fetchImpl = args.fetchImpl ?? fetch;
  }

  async listMeetingTypes(): Promise<MoozMeetingType[]> {
    const url = `${this.baseUrl}/api-gateway?action=list_meeting_types`;
    const res = await this.request("GET", url);
    return (res?.data ?? []) as MoozMeetingType[];
  }

  /**
   * Returns up to 50 available slots between `from` and `to` (UTC ISO).
   * Slots are already filtered server-side by min_notice_hours,
   * max_days_ahead, capacity, and existing bookings.
   */
  async listAvailableSlots(args: {
    meetingTypeId: string;
    from: string;
    to: string;
  }): Promise<MoozAvailableSlot[]> {
    assertIsoUtc("from", args.from);
    assertIsoUtc("to", args.to);
    const url =
      `${this.baseUrl}/api-gateway?action=list_available_slots` +
      `&meeting_type_id=${encodeURIComponent(args.meetingTypeId)}` +
      `&from=${encodeURIComponent(args.from)}` +
      `&to=${encodeURIComponent(args.to)}`;
    const res = await this.request("GET", url);
    return (res?.data ?? []) as MoozAvailableSlot[];
  }

  /**
   * Books the slot. Network retries are NOT layered on top — Mooz's 409
   * idempotency (same email + meeting_type + start_time) is the safety
   * net for our retries. Returns a structured outcome rather than
   * throwing on business errors (slot full / duplicate) so the caller
   * can react conversationally.
   */
  async createBooking(args: MoozCreateBookingArgs): Promise<MoozCreateBookingResult> {
    assertIsoUtc("startTime", args.startTime);
    assertIsoUtc("endTime", args.endTime);
    const url = `${this.baseUrl}/api-gateway?action=create_booking`;
    const body = {
      meeting_type_id: args.meetingTypeId,
      customer_name: args.customerName,
      customer_email: args.customerEmail,
      customer_phone: args.customerPhone ?? undefined,
      start_time: args.startTime,
      end_time: args.endTime,
      timezone: args.timezone ?? "Asia/Jerusalem",
      notes: args.notes ?? undefined,
    };
    let res: Response;
    try {
      res = await this.fetchWithTimeout(url, {
        method: "POST",
        headers: this.headersOrg("application/json"),
        body: JSON.stringify(body),
      });
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      return { ok: false, kind: "server_error", status: 0, message };
    }
    const text = await res.text();
    let parsed: unknown = null;
    try {
      parsed = text ? JSON.parse(text) : null;
    } catch {
      return {
        ok: false,
        kind: "server_error",
        status: res.status,
        message: `mooz returned non-JSON (${res.status})`,
      };
    }
    if (res.status === 201 && parsed && typeof parsed === "object") {
      const data = (parsed as { data?: MoozBooking }).data;
      if (data?.id) return { ok: true, booking: data };
      return {
        ok: false,
        kind: "server_error",
        status: 201,
        message: "mooz 201 without booking data",
      };
    }
    const errMsg = parsed && typeof parsed === "object"
      ? String((parsed as { error?: string }).error ?? "unknown")
      : `mooz ${res.status}`;
    if (res.status === 409 && /Duplicate/i.test(errMsg)) {
      return { ok: false, kind: "duplicate", message: errMsg };
    }
    if (res.status === 409) {
      return { ok: false, kind: "slot_full", message: errMsg };
    }
    if (res.status === 400) {
      return { ok: false, kind: "invalid_input", message: errMsg };
    }
    if (res.status === 404) {
      return { ok: false, kind: "not_found", message: errMsg };
    }
    return { ok: false, kind: "server_error", status: res.status, message: errMsg };
  }

  /**
   * "Is this phone already booked?". Uses the global lookup token, not
   * the org key. Mooz returns the nearest future confirmed booking only,
   * across all orgs (this is intentional — the same phone might have
   * booked through any landing page).
   */
  async lookupByPhone(phone: string): Promise<
    | { booked: true; scheduledAt: string; meetingId: string }
    | { booked: false }
    | { booked: false; error: string }
  > {
    if (!this.lookupToken) {
      return { booked: false, error: "MOOZ_API_TOKEN not configured" };
    }
    const url = `${this.baseUrl}/bookings-lookup?phone=${encodeURIComponent(phone)}`;
    let res: Response;
    try {
      res = await this.fetchWithTimeout(url, {
        method: "GET",
        headers: { Authorization: `Bearer ${this.lookupToken}` },
      });
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      return { booked: false, error: message };
    }
    const text = await res.text();
    let parsed: unknown = null;
    try {
      parsed = text ? JSON.parse(text) : null;
    } catch {
      return { booked: false, error: `non-JSON ${res.status}` };
    }
    if (res.status !== 200 || !parsed || typeof parsed !== "object") {
      const errMsg = parsed && typeof parsed === "object"
        ? String((parsed as { error?: string }).error ?? "unknown")
        : `mooz ${res.status}`;
      return { booked: false, error: errMsg };
    }
    const data = parsed as {
      booked?: boolean;
      scheduled_at?: string;
      meeting_id?: string;
    };
    if (data.booked && data.scheduled_at && data.meeting_id) {
      return {
        booked: true,
        scheduledAt: data.scheduled_at,
        meetingId: data.meeting_id,
      };
    }
    return { booked: false };
  }

  // ----- internals -----

  private headersOrg(contentType?: string): Record<string, string> {
    const h: Record<string, string> = {
      Authorization: `Bearer ${this.orgApiKey}`,
      Accept: "application/json",
      "User-Agent": "richer-mooz/1",
    };
    if (contentType) h["Content-Type"] = contentType;
    return h;
  }

  private async request(method: "GET" | "POST", url: string, body?: unknown): Promise<{ data?: unknown }> {
    const res = await this.fetchWithTimeout(url, {
      method,
      headers: this.headersOrg(body === undefined ? undefined : "application/json"),
      body: body === undefined ? undefined : JSON.stringify(body),
    });
    const text = await res.text();
    if (!res.ok) {
      throw new Error(`mooz ${method} ${url} → ${res.status} ${text}`);
    }
    if (!text) return {};
    return JSON.parse(text);
  }

  private async fetchWithTimeout(url: string, init: RequestInit): Promise<Response> {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), REQUEST_TIMEOUT_MS);
    try {
      return await this.fetchImpl(url, { ...init, signal: controller.signal });
    } finally {
      clearTimeout(timer);
    }
  }
}

/**
 * Builds a MoozClient from env vars + lightly logs missing keys. Returns
 * null when the org key is absent — callers handle "Mooz disabled"
 * gracefully (don't crash the bot loop).
 */
export function moozClientFromEnv(args: {
  admin: SupabaseClient;
  agentId: string;
  conversationId?: string;
}): MoozClient | null {
  const orgKey = Deno.env.get("MOOZ_ORG_API_KEY")?.trim();
  if (!orgKey) {
    void logError({
      admin: args.admin,
      source: "mooz",
      errorType: "config_missing",
      message: "MOOZ_ORG_API_KEY not set — Mooz integration disabled",
      context: {},
      agentId: args.agentId,
      conversationId: args.conversationId ?? null,
      level: "warn",
    });
    return null;
  }
  return new MoozClient({
    orgApiKey: orgKey,
    lookupToken: Deno.env.get("MOOZ_API_TOKEN")?.trim() || null,
  });
}
