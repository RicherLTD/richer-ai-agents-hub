// moozCheck.ts
//
// Pre-send guard for `dispatch-scheduled-templates`: asks the lead's
// booking system (Mooz today) "is this phone already booked for a Zoom?".
// If yes, we cancel the queued WhatsApp template -- the lead already has
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
//   Our DB stores `+972XXXXXXXXX` (E.164). Mooz also stores Israeli
//   numbers but may use the local `05X...` form. We collapse both ends
//   to the canonical 9-digit Israeli mobile suffix. Numbers that do not
//   look Israeli (no country code 972 and no leading 0 for a 10-digit
//   number) are REFUSED rather than blindly truncated -- otherwise a
//   foreign number could share its last 9 digits with an unrelated
//   Israeli lead's Mooz booking and cause a false cancel.
//
// Failure model -- fail-CLOSED:
//   Any HTTP error, timeout, malformed response, or non-Israeli phone
//   number returns `{ booked: false, reason: <specific> }` with
//   reason != "not_booked". The dispatcher treats *only*
//   `reason === "not_booked"` as "safe to send"; every other outcome
//   holds the row pending so a retry can resolve cleanly. This is the
//   opposite of the original fail-open design and was changed after the
//   operator made it explicit: "no template is sent without a clean
//   Mooz answer".
//
//   Trade-off accepted: if Mooz is degraded for >3 cron ticks, the row
//   exhausts its retries and is marked `failed`. The lead does not
//   receive a first-touch template. The operator can replay from the
//   DLQ once Mooz is back.
//
//   The dispatcher does NOT need to know how Mooz fails -- it only
//   asks "is reason === 'not_booked'?". Adding a new failure variant
//   here is safe; the dispatcher will continue to treat it as "hold".

const MAX_ATTEMPTS = 2;
const RETRY_DELAY_MS = 500;
const FETCH_TIMEOUT_MS = 5000;

export interface MoozCheckArgs {
  /** Mooz endpoint URL -- typically `https://mooz.example.com/api/bookings/lookup`. */
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
  | { booked: false; reason: "non_israeli_phone"; detail: string }
  | { booked: false; reason: "http_error"; status: number }
  | { booked: false; reason: "network_error"; detail: string }
  | { booked: false; reason: "timeout" }
  | { booked: false; reason: "invalid_response"; detail: string };

/**
 * Reduce an Israeli phone to its canonical 9-digit mobile suffix.
 * Returns "" if the number is not in a recognised Israeli format.
 *
 * Accepted shapes (after stripping non-digit characters):
 *   "+972551234567" -> "551234567"   (strip 972 prefix)
 *   "972551234567"  -> "551234567"   (same)
 *   "0551234567"    -> "551234567"   (strip leading 0)
 *   "551234567"     -> "551234567"   (already canonical)
 *   "+972-55-1234567", "(055) 123-4567" -> "551234567"
 *
 * Rejected (returns ""):
 *   "+12025551234"  (US number; last 9 digits could collide with an
 *                    Israeli mobile, causing a false Mooz match)
 *   "+97225551234"  (Israeli landline -- 8 digits after country code;
 *                    we only support mobile because only mobile carries
 *                    WhatsApp)
 *   too short / too long / blank
 */
export function normalizePhoneForMooz(phone: string): string {
  let digits = phone.replace(/\D/g, "");
  if (digits.startsWith("972")) digits = digits.slice(3);
  else if (digits.startsWith("0")) digits = digits.slice(1);
  if (digits.length !== 9) return "";
  return digits;
}

function looksLikeHttpUrl(s: string): boolean {
  try {
    const u = new URL(s);
    return u.protocol === "http:" || u.protocol === "https:";
  } catch {
    return false;
  }
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
 * The dispatcher treats `reason === "not_booked"` as the ONLY signal
 * that it's safe to send. Every other outcome (booked=true OR any
 * error variant) means "do not send right now". See the module
 * comment above for the fail-closed rationale.
 *
 * Token safety: errorBody from Mooz is NOT returned in the outcome
 * any more. A misconfigured Mooz that echoes the `Authorization`
 * header in a 401 body would otherwise leak the bearer token into
 * our logs. Only the HTTP status is surfaced; the body is dropped.
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
      reason: "non_israeli_phone",
      detail: `phone "${args.phone.slice(0, 20)}" did not normalise to an Israeli 9-digit suffix`,
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

      // Non-2xx. We deliberately do NOT capture the response body here --
      // some servers echo Authorization headers in 4xx responses, which
      // would leak the bearer token into our error_logs. Drain the body
      // so the connection can be pooled, but discard.
      lastStatus = res.status;
      try {
        await res.text();
      } catch {
        /* ignore */
      }
if (!isRetryableStatus(res.status)) {
        return {
          booked: false,
          reason: "http_error",
          status: res.status,
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
    } finally {
      clearTimeout(timeoutId);
    }

    if (attempt < MAX_ATTEMPTS) await sleep(RETRY_DELAY_MS);
  }

  return {
    booked: false,
    reason: "http_error",
    status: lastStatus,
  };
}
