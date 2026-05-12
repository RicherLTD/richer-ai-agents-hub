// whatsappSend.ts
//
// Send a text message via HookMyApp (sandbox or production) with
// exponential backoff retry on transient failures.
//
// Retry policy:
//   - We retry on network errors (fetch rejected) and on 5xx responses
//     and on 429 (rate limit).
//   - We DO NOT retry on 4xx (other than 429) — those are caller errors
//     (bad token, malformed payload, blocked number). Retrying just
//     makes them louder.
//   - Three total attempts max. Delays: 1s, 2s.
//   - Each fetch is wrapped in an 8-second AbortController so a stalled
//     HookMyApp connection cannot pin the background task open and burn
//     the function's wall-clock budget.
//
// Returns a discriminated result instead of throwing — callers in
// edge-function background tasks need to keep going on failure to
// record the DLQ entry without an unhandled rejection.

export interface SendWhatsAppTextArgs {
  apiUrl: string;
  accessToken: string;
  phoneNumberId: string;
  to: string;
  body: string;
}

export type SendResult =
  | {
    ok: true;
    /** Meta wamid for the outbound message (when HookMyApp returns it). */
    metaMessageId: string | null;
    attempts: number;
    status: number;
  }
  | {
    ok: false;
    /** Last HTTP status seen, or 0 if the request never produced a response. */
    status: number;
    /** Sanitised error body (Bearer tokens redacted, truncated). */
    errorBody: string;
    attempts: number;
    /** True if we gave up because the failure was non-retryable (e.g. 401). */
    terminal: boolean;
  };

const MAX_ATTEMPTS = 3;
const RETRY_DELAYS_MS: ReadonlyArray<number> = [1000, 2000];
const FETCH_TIMEOUT_MS = 8000;
const ERROR_BODY_MAX_CHARS = 300;

// Defensive: keep the delays array length consistent with the attempt count.
// If this ever drifts, the sleep between attempts gets silently skipped and
// retries hammer the upstream — fail loudly at module load instead.
if (RETRY_DELAYS_MS.length !== MAX_ATTEMPTS - 1) {
  throw new Error(
    `whatsappSend: RETRY_DELAYS_MS length must equal MAX_ATTEMPTS - 1 ` +
      `(got ${RETRY_DELAYS_MS.length} delays for ${MAX_ATTEMPTS} attempts)`,
  );
}

function isRetryableStatus(status: number): boolean {
  return status === 429 || (status >= 500 && status <= 599);
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

// Strip any Bearer tokens that an upstream error body might echo back and
// cap the length so a multi-KB HTML error page doesn't bloat the log row.
function sanitiseErrorBody(raw: string): string {
  const redacted = raw.replace(/Bearer\s+[A-Za-z0-9._\-]+/gi, "Bearer [REDACTED]");
  return redacted.length > ERROR_BODY_MAX_CHARS
    ? redacted.slice(0, ERROR_BODY_MAX_CHARS - 14) + "…[truncated]"
    : redacted;
}

interface MetaSendResponseShape {
  messages?: Array<{ id?: unknown }>;
}

function extractMetaMessageId(parsed: unknown): string | null {
  if (!parsed || typeof parsed !== "object") return null;
  // Arrays pass `typeof === "object"`; HookMyApp's success shape is an
  // object root with a `messages` array, so anything else is "no parseable id".
  if (Array.isArray(parsed)) return null;
  const shaped = parsed as MetaSendResponseShape;
  const first = shaped.messages?.[0];
  if (first && typeof first.id === "string") return first.id;
  return null;
}

export async function sendWhatsAppText(args: SendWhatsAppTextArgs): Promise<SendResult> {
  const sendUrl = `${args.apiUrl}/${args.phoneNumberId}/messages`;
  const payload = JSON.stringify({
    messaging_product: "whatsapp",
    to: args.to,
    type: "text",
    text: { body: args.body },
  });

  let lastStatus = 0;
  let lastBody = "";

  for (let attempt = 1; attempt <= MAX_ATTEMPTS; attempt++) {
    const controller = new AbortController();
    const timeoutId = setTimeout(() => controller.abort(), FETCH_TIMEOUT_MS);
    try {
      const res = await fetch(sendUrl, {
        method: "POST",
        headers: {
          Authorization: `Bearer ${args.accessToken}`,
          "Content-Type": "application/json",
        },
        body: payload,
        signal: controller.signal,
      });

      if (res.ok) {
        const text = await res.text();
        let parsed: unknown = null;
        try {
          parsed = text ? JSON.parse(text) : null;
        } catch {
          // HookMyApp returned 2xx with non-JSON body — still a successful
          // send, just no message id to capture.
        }
        return {
          ok: true,
          metaMessageId: extractMetaMessageId(parsed),
          attempts: attempt,
          status: res.status,
        };
      }

      lastStatus = res.status;
      const rawBody = await res.text().catch(() => "");
      lastBody = sanitiseErrorBody(rawBody);

      if (!isRetryableStatus(res.status)) {
        return {
          ok: false,
          status: res.status,
          errorBody: lastBody,
          attempts: attempt,
          terminal: true,
        };
      }
    } catch (networkErr) {
      // fetch rejected (DNS, TLS, abort/timeout, connection reset) — retry.
      lastStatus = 0;
      const detail = networkErr instanceof Error ? networkErr.message : String(networkErr);
      lastBody = sanitiseErrorBody(detail);
    } finally {
      clearTimeout(timeoutId);
    }

    // index is always 0 or 1 because attempt < MAX_ATTEMPTS (i.e. 1 or 2)
    const delay = RETRY_DELAYS_MS[attempt - 1];
    if (attempt < MAX_ATTEMPTS && delay != null) {
      await sleep(delay);
    }
  }

  return {
    ok: false,
    status: lastStatus,
    errorBody: lastBody,
    attempts: MAX_ATTEMPTS,
    terminal: false,
  };
}
