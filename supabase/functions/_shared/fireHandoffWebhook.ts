// fireHandoffWebhook.ts
//
// Outbound HTTP POST that announces "a lead just qualified, please pick
// it up". One side of a two-party contract: the consumer (Make.com today,
// could be anything) sees the full lead picture in a single POST and
// routes it to wherever it needs to go — calendar booking, CRM, advisor
// notification, dashboards.
//
// Why a single fan-out webhook (instead of N targeted integrations)?
//   Calendly / Google Calendar / Fireberry are all moving parts that
//   change auth model every quarter. Make/Zapier/n8n exist precisely so
//   we don't have to chase those changes. We emit ONE stable event with
//   the full payload; the operator wires up whatever downstream pipes
//   they want without us touching code.
//
// Signed with HMAC-SHA256 so the consumer can verify "this really came
// from our webhook and not from a random caller poking the Make URL".
//
// Never throws — the lead has already been routed in the DB by the time
// this fires. A failed webhook is recoverable (DLQ) but must not block.

const HANDOFF_EVENT = "zoom_scheduled";
const MAX_ATTEMPTS = 3;
const RETRY_DELAYS_MS: ReadonlyArray<number> = [1000, 2000];
const FETCH_TIMEOUT_MS = 8000;
const ERROR_BODY_MAX_CHARS = 500;

if (RETRY_DELAYS_MS.length !== MAX_ATTEMPTS - 1) {
  throw new Error(
    `fireHandoffWebhook: RETRY_DELAYS_MS must equal MAX_ATTEMPTS - 1 ` +
      `(got ${RETRY_DELAYS_MS.length} delays for ${MAX_ATTEMPTS} attempts)`,
  );
}

/** Lead memory snapshot at the moment of handoff. Mirrors the
 *  ExtractedMemory shape used inside the extractor. */
export interface HandoffLeadMemory {
  q1_age: number | null;
  q2_motivation: string | null;
  q3_dream_change: string | null;
  q4_blocker: string | null;
  q5_urgency: string | null;
  q6_investment: string | null;
  /** Email collected by the bot in q7. null when the lead refused to share
   *  it — Make.com should fall back to phone-only CRM matching in that case. */
  q7_email: string | null;
  /** ISO-8601 timestamp of the moment the bot first observed explicit
   *  meeting consent from the lead ("כן, בוא נקבע", "מתי?", or an
   *  affirmative reply to a proposed time). Required to be non-null for
   *  the handoff to fire — Mooz/Calendly need an actual consent signal,
   *  not just "we collected 5 answers". */
  meeting_consented_at: string | null;
  conversation_summary: string | null;
  primary_objection: string | null;
  red_flags: string[];
  notes_for_advisor: string | null;
}

/** Conversation snapshot at the moment of handoff. */
export interface HandoffConversation {
  id: string;
  lead_phone: string;
  lead_name: string | null;
  status: "paused";
  current_tag: "zoom_scheduled";
  funnel_stage: "done";

  /** ISO-8601 UTC — the exact moment we tagged the lead as ready
   *  for a zoom. This is when Make.com should kick off Mooz / Fireberry.
   *  The ACTUAL meeting time is returned by Mooz inside Make.com — it
   *  isn't decided by the bot. */
  zoom_scheduled_at: string;

  /** ----- Make.com-friendly derived fields ----- */

  /** Same instant as `zoom_scheduled_at`, formatted as YYYY-MM-DD in
   *  Asia/Jerusalem. Easy to map into Fireberry "Date" fields. */
  qualified_at_il_date: string;

  /** Same instant, formatted as HH:mm in Asia/Jerusalem. Easy to map
   *  into Fireberry "Time" fields. */
  qualified_at_il_time: string;

  /** Hebrew-style combined display: "DD/MM/YYYY HH:mm" in Asia/Jerusalem.
   *  Drop straight into a single CRM text/note column. */
  qualified_at_il_datetime: string;

  /** ----- Meeting fields (used by Mooz / Calendly-style booking APIs) ----- */

  /** Configured meeting-type id from `agents.meeting_type_id`. Constant per
   *  agent. Make.com passes this straight through to Mooz; nullable because
   *  not every agent is fully configured yet. */
  meeting_type_id: string | null;

  /** Configured meeting length in minutes (default 30). Mooz uses this to
   *  compute the booking end-time when start_time is sent without end_time. */
  meeting_duration_minutes: number;

  /** ISO-8601 UTC — `zoom_scheduled_at + meeting_duration_minutes`. Sent
   *  alongside start_time so consumers that REQUIRE end_time get it for
   *  free. Make.com filters/maps can ignore if not needed. */
  meeting_end_at: string;

  /** Hebrew-style "DD/MM/YYYY HH:mm" of meeting_end_at in Asia/Jerusalem. */
  meeting_end_at_il_datetime: string;

  source_campaign: string | null;
  source_funnel: string | null;
  created_at: string | null;
  dashboard_url: string | null;
}

export interface HandoffPayload {
  /** Always `"zoom_scheduled"` for now — adding more events is forward-compat. */
  event: typeof HANDOFF_EVENT;
  /** ISO-8601 timestamp of the moment we fired. */
  timestamp: string;
  agent: {
    id: string;
    name: string;
  };
  conversation: HandoffConversation;
  lead_memory: HandoffLeadMemory;
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

export interface FireHandoffArgs {
  url: string;
  /** Optional shared secret. When present, request is signed with HMAC-SHA256
   *  over the raw JSON body, header `X-Handoff-Signature-256: sha256=HEX`. */
  secret?: string | null;
  payload: HandoffPayload;
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

async function hmacSha256Hex(key: string, body: string): Promise<string> {
  const enc = new TextEncoder();
  const cryptoKey = await crypto.subtle.importKey(
    "raw",
    enc.encode(key),
    { name: "HMAC", hash: "SHA-256" },
    false,
    ["sign"],
  );
  const sig = await crypto.subtle.sign("HMAC", cryptoKey, enc.encode(body));
  return Array.from(new Uint8Array(sig), (b) => b.toString(16).padStart(2, "0")).join("");
}

/**
 * True if the string looks like an http(s) URL. We do NOT do full URL
 * validation here — fetch will reject malformed URLs at attempt time —
 * but a missing/blank/non-http secret should short-circuit so we don't
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
 * Build the canonical JSON body and signature for a handoff event, then
 * POST it to `url` with up to 3 attempts. Never throws.
 *
 * Auth model: the consumer registers a shared secret with us. We sign the
 * raw body with HMAC-SHA256 and put the hex digest in
 * `X-Handoff-Signature-256: sha256=HEX`. The consumer (Make.com filter
 * module, custom webhook, anything) verifies before processing.
 */
export async function fireHandoffWebhook(args: FireHandoffArgs): Promise<FireResult> {
  if (!looksLikeHttpUrl(args.url)) {
    return {
      ok: false,
      status: 0,
      errorBody: `handoff URL is not http(s): "${args.url.slice(0, 80)}"`,
      attempts: 0,
      terminal: true,
      badUrl: true,
    };
  }

  const body = JSON.stringify(args.payload);
  const headers: Record<string, string> = {
    "Content-Type": "application/json",
    "User-Agent": "richer-handoff/1",
  };
  if (args.secret) {
    headers["X-Handoff-Signature-256"] = "sha256=" + (await hmacSha256Hex(args.secret, body));
  }

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

/**
 * Pure helper: assemble the payload from its parts. Kept separate so we
 * can unit-test the canonical shape without spinning up fetch mocks.
 */
export function buildHandoffPayload(input: {
  agentId: string;
  agentName: string;
  conversation: HandoffConversation;
  leadMemory: HandoffLeadMemory;
  /** Override for tests; defaults to `new Date().toISOString()`. */
  now?: string;
}): HandoffPayload {
  return {
    event: HANDOFF_EVENT,
    timestamp: input.now ?? new Date().toISOString(),
    agent: { id: input.agentId, name: input.agentName },
    conversation: input.conversation,
    lead_memory: input.leadMemory,
  };
}
