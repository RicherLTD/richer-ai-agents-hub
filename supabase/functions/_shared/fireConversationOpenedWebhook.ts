// fireConversationOpenedWebhook.ts
//
// Outbound HTTP POST fired the moment a new WhatsApp conversation is
// created. The consumer (Make.com today) uses this to write a
// "conversation view" iframe into the CRM record for the lead, so an
// operator can see the live WhatsApp thread inline in Fireberry.
//
// Mirrors fireHandoffWebhook.ts's retry/timeout/never-throw contract
// closely — see that file for the reasoning. No HMAC signing here (no
// sensitive decision is being conveyed, just "a conversation exists"),
// which keeps this simpler than the handoff webhook.
//
// Never throws — the conversation has already been created in the DB by
// the time this fires. A failed webhook just means the CRM iframe embed
// doesn't get written; recoverable, must not block the caller.

const MAX_ATTEMPTS = 3;
const RETRY_DELAYS_MS: ReadonlyArray<number> = [1000, 2000];
const FETCH_TIMEOUT_MS = 8000;
const ERROR_BODY_MAX_CHARS = 500;

if (RETRY_DELAYS_MS.length !== MAX_ATTEMPTS - 1) {
  throw new Error(
    `fireConversationOpenedWebhook: RETRY_DELAYS_MS must equal MAX_ATTEMPTS - 1 ` +
      `(got ${RETRY_DELAYS_MS.length} delays for ${MAX_ATTEMPTS} attempts)`,
  );
}

/** Flat payload sent to the consumer. */
export interface ConversationOpenedPayload {
  lead_phone: string;
  lead_name: string | null;
  iframe: string | null;
  product: string | null;
  agent_name: string | null;
  conversation_view_url: string | null;
}

export interface BuildConversationOpenedInput {
  leadPhone: string;
  leadName: string | null;
  product: string | null;
  agentName: string | null;
  conversationViewUrl: string | null;
}

export type FireResult =
  | { ok: true; attempts: number; status: number }
  | {
    ok: false;
    /** Last HTTP status seen, or 0 if the request never produced a response. */
    status: number;
    /** Sanitised error body (truncated). */
    errorBody: string;
    attempts: number;
    /** True if we gave up because the failure was non-retryable (e.g. 401). */
    terminal: boolean;
    /** True iff the failure was a misconfigured URL (skip on its own). */
    badUrl?: boolean;
  };

export interface FireConversationOpenedArgs {
  url: string;
  payload: ConversationOpenedPayload;
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function isRetryableStatus(status: number): boolean {
  return status === 429 || (status >= 500 && status <= 599);
}

function truncateForLog(s: string): string {
  return s.length > ERROR_BODY_MAX_CHARS
    ? s.slice(0, ERROR_BODY_MAX_CHARS - 14) + "…[truncated]"
    : s;
}

/**
 * True if the string looks like an http(s) URL. We do NOT do full URL
 * validation here — fetch will reject malformed URLs at attempt time —
 * but a missing/blank/non-http url should short-circuit so we don't
 * waste 3 retries and emit confusing logs.
 */
function looksLikeHttpUrl(s: string): boolean {
  try {
    const u = new URL(s);
    return u.protocol === "http:" || u.protocol === "https:";
  } catch {
    return false;
  }
}

/**
 * Pure helper: assemble the flat payload from its parts. Kept separate
 * so we can unit-test the canonical shape without spinning up fetch
 * mocks.
 */
export function buildConversationOpenedPayload(
  input: BuildConversationOpenedInput,
): ConversationOpenedPayload {
  return {
    lead_phone: input.leadPhone,
    lead_name: input.leadName,
    product: input.product,
    agent_name: input.agentName,
    conversation_view_url: input.conversationViewUrl,
    iframe: input.conversationViewUrl == null
      ? null
      : `<iframe src="${input.conversationViewUrl}" style="width:100%;height:720px;border:0;border-radius:12px;" title="שיחה עם הליד"></iframe>`,
  };
}

/**
 * Build the canonical JSON body for a conversation-opened event, then
 * POST it to `url` with up to 3 attempts. Never throws.
 */
export async function fireConversationOpenedWebhook(
  args: FireConversationOpenedArgs,
): Promise<FireResult> {
  if (!looksLikeHttpUrl(args.url)) {
    return {
      ok: false,
      status: 0,
      errorBody: `conversation-opened URL is not http(s): "${args.url.slice(0, 80)}"`,
      attempts: 0,
      terminal: true,
      badUrl: true,
    };
  }

  const body = JSON.stringify(args.payload);
  const headers: Record<string, string> = {
    "Content-Type": "application/json",
    "User-Agent": "richer-conversation-opened/1",
  };

  let lastStatus = 0;
  let lastBody = "";

  for (let attempt = 1; attempt <= MAX_ATTEMPTS; attempt++) {
    const controller = new AbortController();
    const timeoutId = setTimeout(() => controller.abort(), FETCH_TIMEOUT_MS);
    try {
      const res = await fetch(args.url, {
        method: "POST",
        headers,
        body,
        signal: controller.signal,
      });
      if (res.ok) {
        return { ok: true, attempts: attempt, status: res.status };
      }
      lastStatus = res.status;
      const raw = await res.text().catch(() => "");
      lastBody = truncateForLog(raw);
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
      lastStatus = 0;
      const detail = networkErr instanceof Error ? networkErr.message : String(networkErr);
      lastBody = truncateForLog(detail);
    } finally {
      clearTimeout(timeoutId);
    }

    const delay = RETRY_DELAYS_MS[attempt - 1];
    if (attempt < MAX_ATTEMPTS && delay != null) await sleep(delay);
  }

  return {
    ok: false,
    status: lastStatus,
    errorBody: lastBody,
    attempts: MAX_ATTEMPTS,
    terminal: false,
  };
}
