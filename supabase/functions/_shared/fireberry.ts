// fireberry.ts
//
// Minimal Fireberry (Powerlink) read client for ONE job: before the bot
// books a Zoom, check whether the lead's phone already belongs to a
// person we must NOT auto-book — a registered student (statuscode 2 =
// נרשם) or a blacklisted contact (statuscode 11 = רשימה שחורה).
//
// Why here and not in Make: the actual Mooz booking is created by the bot
// (moozTools.book_meeting) BEFORE any Make scenario runs. Make only records
// the booking in Fireberry afterward — so the only place to STOP a booking
// for an existing student/blacklist is right here, in the tool dispatcher.
//
// Fail-open by contract: if the token is missing or Fireberry is unreachable,
// the caller proceeds with the booking rather than losing a legitimate lead.
// The block is a safety gate, not an authority — a false "proceed" is
// recoverable (the Make safety-net skips status 2/11 too); a false "block"
// would silently drop real leads.
//
// Status codes: full map in docs/fireberry-status-codes.md. `statuscode` is
// the PRIMARY lead status (objecttype 1 / Account).

import type { SupabaseClient } from "https://esm.sh/@supabase/supabase-js@2.45.4";
import { logError } from "./logError.ts";

const FIREBERRY_BASE_URL = "https://api.fireberry.com";
const REQUEST_TIMEOUT_MS = 6000;

/** Primary statuses (`statuscode`) for which the bot must NOT book a Zoom.
 *  2 = נרשם (registered student), 11 = רשימה שחורה (blacklist). */
export const BOOKING_BLOCK_STATUSCODES: ReadonlySet<number> = new Set([2, 11]);

export interface FireberryBlockResult {
  /** true → the lead sits in a blocking primary status; do not book. */
  blocked: boolean;
  /** The specific blocking statuscode found (2 or 11), else null. */
  statuscode: number | null;
}

/** Narrow interface the dispatcher depends on — lets tests inject a stub
 *  without constructing the real HTTP client. */
export interface FireberryChecker {
  lookupBlockingStatus(phone: string): Promise<FireberryBlockResult>;
}

/**
 * Produce the IL phone formats Fireberry might have stored, most-likely
 * first. Fireberry records are inconsistent (0-prefixed from some flows,
 * raw international from others), so we try formats in order and stop at
 * the first that matches — this is the same normalization gap that caused
 * the duplicate-lead problems, so we defend against it explicitly.
 */
export function phoneVariantsIL(phone: string): string[] {
  const digits = (phone || "").replace(/\D/g, "");
  if (!digits) return [];
  let national = digits;
  if (national.startsWith("972")) national = national.slice(3);
  national = national.replace(/^0+/, "");
  if (!national) return [];
  const variants = [`0${national}`, national, `972${national}`, `+972${national}`];
  return [...new Set(variants)];
}

/** Pull numeric `statuscode` values out of a v3 /query response. Tolerant
 *  of string/number and missing rows. Pure — unit-tested directly. */
export function parseStatuscodes(json: unknown): number[] {
  const data = (json as { data?: unknown } | null)?.data;
  if (!Array.isArray(data)) return [];
  const out: number[] = [];
  for (const row of data) {
    const raw = (row as { statuscode?: unknown } | null)?.statuscode;
    const n = typeof raw === "number" ? raw : typeof raw === "string" ? Number(raw) : NaN;
    if (Number.isFinite(n)) out.push(n);
  }
  return out;
}

/** Given the statuscodes found for a phone, decide whether to block and on
 *  which code. Pure. */
export function pickBlockingStatus(statuscodes: readonly number[]): FireberryBlockResult {
  for (const s of statuscodes) {
    if (BOOKING_BLOCK_STATUSCODES.has(s)) return { blocked: true, statuscode: s };
  }
  return { blocked: false, statuscode: null };
}

type FetchImpl = (url: string, init: RequestInit) => Promise<Response>;

export class FireberryClient implements FireberryChecker {
  private token: string;
  private fetchImpl: FetchImpl;

  constructor(args: { token: string; fetchImpl?: FetchImpl }) {
    this.token = args.token;
    this.fetchImpl = args.fetchImpl ?? ((u, i) => fetch(u, i));
  }

  /**
   * Look up the lead by phone (trying each IL format) and report whether
   * they sit in a blocking primary status. Throws on transport/HTTP error
   * so the caller can fail-open explicitly.
   */
  async lookupBlockingStatus(phone: string): Promise<FireberryBlockResult> {
    const variants = phoneVariantsIL(phone);
    for (const value of variants) {
      const statuscodes = await this.queryStatuscodes(value);
      if (statuscodes.length > 0) {
        return pickBlockingStatus(statuscodes);
      }
    }
    return { blocked: false, statuscode: null };
  }

  private async queryStatuscodes(telephone1: string): Promise<number[]> {
    const body = JSON.stringify({
      objectType: 1,
      fields: [{ name: "accountid" }, { name: "statuscode" }],
      filter: [
        {
          type: "AND",
          conditions: [{ fieldName: "telephone1", operator: "eq", value: telephone1 }],
        },
      ],
      pageSize: 20,
      pageNumber: 1,
    });
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), REQUEST_TIMEOUT_MS);
    try {
      const res = await this.fetchImpl(`${FIREBERRY_BASE_URL}/api/v3/query`, {
        method: "POST",
        headers: { tokenid: this.token, "Content-Type": "application/json" },
        body,
        signal: controller.signal,
      });
      const text = await res.text();
      if (!res.ok) {
        throw new Error(`fireberry v3/query → ${res.status} ${text.slice(0, 200)}`);
      }
      return parseStatuscodes(text ? JSON.parse(text) : {});
    } finally {
      clearTimeout(timer);
    }
  }
}

/**
 * Build a FireberryClient from env, or null when FIREBERRY_API_TOKEN is
 * absent. Null → the booking gate is skipped (fail-open), logged once as a
 * warning so a missing secret is visible in error_logs.
 */
export function fireberryClientFromEnv(args: {
  admin: SupabaseClient;
  agentId: string;
  conversationId?: string;
}): FireberryClient | null {
  const token = Deno.env.get("FIREBERRY_API_TOKEN")?.trim();
  if (!token) {
    void logError({
      admin: args.admin,
      source: "fireberry",
      errorType: "config_missing",
      message: "FIREBERRY_API_TOKEN not set — booking status gate disabled",
      context: {},
      agentId: args.agentId,
      conversationId: args.conversationId ?? null,
      level: "warn",
    });
    return null;
  }
  return new FireberryClient({ token });
}
