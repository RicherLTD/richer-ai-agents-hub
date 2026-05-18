// moozCheck.ts
//
// Pre-send guard for `dispatch-scheduled-templates`: asks the lead's
// booking system (Mooz today) "is this phone already booked for a Zoom?".
// If yes, we cancel the queued WhatsApp template — the lead already has
// a meeting on the books and a follow-up would be noise at best,
// confusing at worst.
//
// Why this lives here and not inline in the dispatcher:
//   The dispatcher loop already does a lot (DB read, template send,
//   error logging, DLQ). Keeping the HTTP-and-normalisation concerns in
//   their own module means the dispatcher reads as plain orchestration
//   and the check is unit-testable with a fetch mock.
//
// Phone normalisation:
//   Our DB stores `+972XXXXXXXXX`. Mooz historically stores `0XXXXXXXXX`
//   but could change. To stay format-agnostic we send the last 9 digits
//   only and let Mooz match by suffix. This is documented in the Mooz
//   endpoint contract.
//
// Failure model — fail-open:
//   Any HTTP error, timeout, or malformed response → we report
//   `{ booked: false, reason: ... }` so the dispatcher sends the
//   template. Logic: a duplicate WhatsApp follow-up is recoverable
//   (annoying, not damaging). NOT sending a template to a cold lead
//   because Mooz had a 503 means losing the lead entirely. We prefer
//   the recoverable failure mode and surface the Mooz outage via
//   `error_logs` for the operator to diagnose.

const MAX_ATTEMPTS = 2;
const RETRY_DELAY_MS = 500;
const FETCH_TIMEOUT_MS = 5000;
const ERROR_BODY_MAX_CHARS = 500;

export interface MoozCheckArgs {
  /** Mooz endpoint URL — typically `https://mooz.example.com/api/bookings/lookup`. */
  url: string;
  /** Bearer token shared with Mooz. Stored in Supabase secret `MOOZ_API_TOKEN`. */
  token: string;
  /** Lead phone in our canonical `+972XXXXXXXXX` format. */
  phone: string;
}

export type MoozCheckOutcome =
  | { booked: true; scheduledAt: string | null; meetingId: string | null }
  | { booked: false; reason: "not_booked" }
  | { booked: false; reason: "bad_url"; detail: string }
  | { booked: false; reason: "http_error"; status: number; errorBody: string }
  | { booked: false; reason: "network_error"; detail: string }
  | { booked: false; reason: "timeout" }
  | { booked: false; reason: "invalid_response"; detail: string };

/**
 * Reduce any plausible phone format to "last 9 digits" so the Mooz side
 * can match on suffix regardless of how it stores numbers. Pure.
 *
 *   "+972551234567"  -> "551234567"
 *   "972551234567"   -> "551234567"
 *   "0551234567"     -> "551234567"
 *   "551234567"      -> "551234567"
 *   "+972-55-123-4567" -> "551234567"
 *
 * Returns "" for inputs with fewer than 9 digits. The caller should treat
 * "" as a non-checkable input and skip the lookup.
 */
export function normalizePhoneForMooz(phone: string): string {
  const digits = phone.replace(/\D/g, "");
  if (digits.length < 9) return "";
  return digits.slice(-9);
}

function looksLikeHttpUrl(s: string): boolean {
  try {
    const u = new URL(s);
    return u.protocol === "http:" || u.protocol === "https:";
  } catch {
    return false;
  }
}

function truncateForLog(s: string): string {
  return s.length > ERROR_BODY_MAX_CHARS
    ? s.slice(0, ERROR_BODY_MAX_CHARS - 14) + "…[truncated]"
    : s;
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function isRetryableStatus(status: number): boolean {
  return status === 429 || (status >= 500 && status <= 599);
}

interface MoozResponseShape {
  booked?: unknown;
  scheduled_at?: unknown;
  meeting_id?: unknown;
}

function coerceMoozOutcome(raw: unknown): MoozCheckOutcome | null {
  if (!raw || typeof raw !== "object") return null;
  const o = raw as MoozResponseShape;
  if (typeof o.booked !== "boolean") return null;
  if (!o.booked) return { booked: false, reason: "not_booked" };
  const scheduledAt = typeof o.scheduled_at === "string" && o.scheduled_at.trim().length > 0
    ? o.scheduled_at
    : null;
  const meetingId = typeof o.meeting_id === "string" && o.meeting_id.trim().length > 0
    ? o.meeting_id
    : null;
  return { booked: true, scheduledAt, meetingId };
}

/**
 * Check Mooz for an existing booking on this phone. Never throws.
 *
 * Returns a discriminated union so the dispatcher can:
 *   - `{ booked: true }`  → cancel the queued template, tag conversation
 *   - `{ booked: false, reason: "not_booked" }` → send as planned
 *   - any other `booked: false` → send as planned AND log a warning so
 *     the operator knows the safety check isn't running clean.
 */
export async function checkMoozBooking(args: MoozCheckArgs): Promise<MoozCheckOutcome> {
  if (!looksLikeHttpUrl(args.url)) {
    return {
      booked: false,
      reason: "bad_url",
      detail: `meeting_check_url is not http(s): "${args.url.slice(0, 80)}"`,
    };
  }
  const normalised = normalizePhoneForMooz(args.phone);
  if (!normalised) {
    return {
      booked: false,
      reason: "invalid_response",
      detail: `phone "${args.phone.slice(0, 20)}" yielded <9 digits after normalisation`,
    };
  }

  // We always append/replace the `phone` query param so the caller can
  // configure the base URL however they like (with or without trailing
  // params).
  let target: URL;
  try {
    target = new URL(args.url);
  } catch {
    return { booked: false, reason: "bad_url", detail: "URL constructor rejected the configured value" };
  }
  target.searchParams.set("phone", normalised);

  let lastStatus = 0;
  let lastBody = "";

  for (let attempt = 1; attempt <= MAX_ATTEMPTS; attempt++) {
    const controller = new AbortController();
    const timeoutId = setTimeout(() => controller.abort(), FETCH_TIMEOUT_MS);
    try {
      const res = await fetch(target.toString(), {
        method: "GET",
        headers: {
          Authorization: `Bearer ${args.token}`,
          Accept: "application/json",
          "User-Agent": "richer-mooz-check/1",
        },
        signal: controller.signal,
      });

      if (res.ok) {
        let parsed: unknown;
        try {
          parsed = await res.json();
        } catch (parseErr) {
          return {
            booked: false,
            reason: "invalid_response",
            detail: `Mooz returned ${res.status} but body was not JSON: ${
              parseErr instanceof Error ? parseErr.message : String(parseErr)
            }`,
          };
        }
        const outcome = coerceMoozOutcome(parsed);
        if (!outcome) {
          return {
            booked: false,
            reason: "invalid_response",
            detail: `Mooz returned ${res.status} but body lacked a boolean "booked" field`,
          };
        }
        return outcome;
      }

      // Non-2xx.
      lastStatus = res.status;
      const raw = await res.text().catch(() => "");
      lastBody = truncateForLog(raw);
      if (!isRetryableStatus(res.status)) {
        return {
          booked: false,
          reason: "http_error",
          status: res.status,
          errorBody: lastBody,
        };
      }
    } catch (networkErr) {
      const isAbort = networkErr instanceof Error && networkErr.name === "AbortError";
      if (isAbort && attempt >= MAX_ATTEMPTS) {
        return { booked: false, reason: "timeout" };
      }
      if (!isAbort && attempt >= MAX_ATTEMPTS) {
        return {
          booked: false,
          reason: "network_error",
          detail: networkErr instanceof Error ? networkErr.message : String(networkErr),
        };
      }
      lastStatus = 0;
      lastBody = networkErr instanceof Error ? networkErr.message : String(networkErr);
    } finally {
      clearTimeout(timeoutId);
    }

    if (attempt < MAX_ATTEMPTS) await sleep(RETRY_DELAY_MS);
  }

  return {
    booked: false,
    reason: "http_error",
    status: lastStatus,
    errorBody: lastBody,
  };
}
