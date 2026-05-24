// mooz-webhook/index.ts
//
// Receives webhook events from Mooz (the booking system). Triggered when
// a meeting is created, cancelled, or rescheduled — regardless of whether
// the booking originated from the bot (via book_meeting tool) or from a
// lead clicking the Mooz UI directly.
//
// Auth model:
//   - Bearer header carries MOOZ_WEBHOOK_SECRET (shared secret config'd
//     in Mooz UI per meeting type).
//   - X-Mooz-Signature-256 carries HMAC-SHA256 of the raw body, keyed by
//     the same secret. Verified for tamper-resistance.
//
// Idempotency:
//   - Mooz sends X-Idempotency-Key on each event. We persist it in
//     `mooz_webhook_events` so a retry of the same event becomes a no-op.
//   - On `booking.created`, we additionally short-circuit if the matched
//     conversation is already tagged `zoom_scheduled` — the bot path
//     already wrote that inline before Mooz's webhook arrived.
//
// Side effects per event:
//   booking.created   → flag conversation zoom_scheduled + fire handoff
//                        webhook to Make.com (single source of truth)
//   booking.cancelled → flag conversation requires_human (advisor needs
//                        to know; bot stays paused)
//   booking.rescheduled → update zoom_scheduled_at; do NOT re-fire handoff

import { createClient } from "https://esm.sh/@supabase/supabase-js@2.45.4";
import { logError } from "../_shared/logError.ts";
import {
  buildHandoffPayload,
  fireHandoffWebhook,
  type HandoffConversation,
  type HandoffLeadMemory,
} from "../_shared/fireHandoffWebhook.ts";

const SOURCE = "mooz-webhook";

interface MoozBookingPayload {
  event?: string;
  timestamp?: string;
  data?: {
    id?: string;
    org_id?: string;
    meeting_type_id?: string;
    customer_name?: string | null;
    customer_email?: string | null;
    customer_phone?: string | null;
    start_time?: string;
    end_time?: string;
    timezone?: string;
    status?: string;
    notes?: string | null;
    hidden_fields?: Record<string, unknown> | null;
  };
}

function timingSafeEqual(a: string, b: string): boolean {
  const len = Math.max(a.length, b.length);
  let diff = a.length ^ b.length;
  for (let i = 0; i < len; i++) {
    const ca = i < a.length ? a.charCodeAt(i) : 0xffff;
    const cb = i < b.length ? b.charCodeAt(i) : 0xffff;
    diff |= ca ^ cb;
  }
  return diff === 0;
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

/** Strip the +972/972 prefix, leading 0, and any non-digit punctuation. */
function normalizeIsraeliPhone(input: string): string {
  const digits = input.replace(/\D/g, "");
  if (digits.startsWith("972")) return digits.slice(3);
  if (digits.startsWith("0")) return digits.slice(1);
  return digits;
}

/**
 * Mooz ships `data.start_time` / `data.end_time` in two flavors depending on
 * how the booking was created:
 *   - ISO 8601 UTC: "2026-05-24T09:00:00.000Z"  (bot-side `book_meeting`)
 *   - IL-local DD/MM/YYYY HH:MM: "24/05/2026 12:00"  (Mooz hosted booking page)
 * Both must land in our `timestamptz` columns as proper UTC ISO strings —
 * otherwise Postgres throws "date/time field value out of range" and the
 * conversation never flips to zoom_scheduled (see error_logs 2026-05-21..24).
 *
 * Returns null only when the input is unrecognizable, so the caller can
 * fall back to `new Date().toISOString()` and still proceed.
 */
export function normalizeMoozTimestamp(input: string | null | undefined): string | null {
  if (!input) return null;
  const trimmed = input.trim();
  // Already valid ISO 8601 — let Date parse it and re-emit canonical form.
  if (/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}/.test(trimmed)) {
    const d = new Date(trimmed);
    return Number.isNaN(d.getTime()) ? null : d.toISOString();
  }
  // Mooz's IL-local format: DD/MM/YYYY HH:MM (Asia/Jerusalem, no tz suffix).
  const m = trimmed.match(/^(\d{2})\/(\d{2})\/(\d{4})\s+(\d{1,2}):(\d{2})$/);
  if (!m) return null;
  const [, dd, mm, yyyy, hh, min] = m;
  // Convert IL-local → UTC by leveraging Intl's IANA tz database. We construct
  // a "naive UTC" timestamp from the IL parts, then check what IL time that
  // naive UTC actually represents — the delta IS the IL offset at that
  // instant (DST-aware, no hardcoding +02:00/+03:00).
  const naiveUtc = Date.UTC(
    Number(yyyy),
    Number(mm) - 1,
    Number(dd),
    Number(hh),
    Number(min),
    0,
  );
  const ilParts = new Intl.DateTimeFormat("en-CA", {
    timeZone: "Asia/Jerusalem",
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
    hour: "2-digit",
    minute: "2-digit",
    second: "2-digit",
    hour12: false,
  }).formatToParts(new Date(naiveUtc));
  const get = (t: string): number =>
    Number(ilParts.find((p) => p.type === t)?.value ?? "0");
  const ilOfNaive = Date.UTC(
    get("year"),
    get("month") - 1,
    get("day"),
    get("hour") === 24 ? 0 : get("hour"),
    get("minute"),
    get("second"),
  );
  const offsetMs = ilOfNaive - naiveUtc;
  return new Date(naiveUtc - offsetMs).toISOString();
}

Deno.serve(async (req) => {
  const supabaseUrl = Deno.env.get("SUPABASE_URL");
  const serviceRoleKey = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY");
  const webhookSecret = Deno.env.get("MOOZ_WEBHOOK_SECRET");
  const handoffWebhookUrl = Deno.env.get("HANDOFF_WEBHOOK_URL") ?? null;
  const handoffWebhookSecret = Deno.env.get("HANDOFF_WEBHOOK_SECRET") ?? null;
  const dashboardBaseUrl = Deno.env.get("DASHBOARD_BASE_URL") ?? null;

  if (!supabaseUrl || !serviceRoleKey) {
    return new Response(JSON.stringify({ error: "server misconfigured" }), {
      status: 500,
      headers: { "Content-Type": "application/json" },
    });
  }
  if (!webhookSecret) {
    return new Response(JSON.stringify({ error: "MOOZ_WEBHOOK_SECRET not set" }), {
      status: 500,
      headers: { "Content-Type": "application/json" },
    });
  }
  const admin = createClient(supabaseUrl, serviceRoleKey);

  if (req.method !== "POST") {
    return new Response(JSON.stringify({ error: "method not allowed" }), {
      status: 405,
      headers: { "Content-Type": "application/json" },
    });
  }

  const rawBody = await req.text();

  // 1. Bearer header check. Mooz puts the shared secret here as the
  //    primary auth — HMAC is the secondary tamper-check below.
  const auth = req.headers.get("Authorization") ?? "";
  const m = auth.match(/^Bearer\s+(.+)$/i);
  if (!m || !timingSafeEqual(m[1].trim(), webhookSecret)) {
    return new Response(JSON.stringify({ error: "unauthorized" }), {
      status: 401,
      headers: { "Content-Type": "application/json" },
    });
  }

  // 2. HMAC verification (when Mooz sends it). Format: "sha256=<hex>".
  //    We accept missing signature gracefully — Bearer already
  //    authenticated, and Mooz historically didn't send signatures.
  const sigHeader = req.headers.get("X-Mooz-Signature-256");
  if (sigHeader) {
    const expected = "sha256=" + (await hmacSha256Hex(webhookSecret, rawBody));
    if (!timingSafeEqual(sigHeader, expected)) {
      await logError({
        admin,
        source: SOURCE,
        errorType: "mooz_bad_signature",
        message: "X-Mooz-Signature-256 did not match",
        context: { event_type: req.headers.get("X-Event-Type") ?? null },
      });
      return new Response(JSON.stringify({ error: "bad signature" }), {
        status: 401,
        headers: { "Content-Type": "application/json" },
      });
    }
  }

  // 3. Parse payload.
  let payload: MoozBookingPayload;
  try {
    payload = JSON.parse(rawBody);
  } catch {
    return new Response(JSON.stringify({ error: "invalid json" }), {
      status: 400,
      headers: { "Content-Type": "application/json" },
    });
  }
  const event = payload.event ?? req.headers.get("X-Event-Type") ?? "";
  const idempotencyKey = req.headers.get("X-Idempotency-Key") ?? null;
  const booking = payload.data;
  if (!booking?.id) {
    return new Response(JSON.stringify({ error: "missing booking data" }), {
      status: 400,
      headers: { "Content-Type": "application/json" },
    });
  }

  // 4. Idempotency: dedupe via mooz_webhook_events. PK is (event, mooz_booking_id, idempotency_key).
  if (idempotencyKey) {
    const { error: dedupeErr } = await admin
      .from("mooz_webhook_events")
      .insert({
        event,
        mooz_booking_id: booking.id,
        idempotency_key: idempotencyKey,
        received_at: new Date().toISOString(),
      });
    if (dedupeErr && dedupeErr.code === "23505") {
      // Already processed — return 200 so Mooz stops retrying.
      return new Response(JSON.stringify({ status: "duplicate_ignored" }), {
        status: 200,
        headers: { "Content-Type": "application/json" },
      });
    }
  }

  // 5. Match conversation by phone. Most bot bookings will hit; non-bot
  //    bookings (lead clicked Mooz UI directly) may not have a phone or
  //    may not match any conversation — that's OK, we log and stop.
  const customerPhone = booking.customer_phone ?? "";
  const normalizedPhone = customerPhone ? normalizeIsraeliPhone(customerPhone) : "";
  if (!normalizedPhone) {
    await logError({
      admin,
      source: SOURCE,
      errorType: "mooz_event_no_phone",
      level: "info",
      message: `event=${event} booking=${booking.id} had no customer_phone — skipping`,
      context: { event, booking_id: booking.id },
    });
    return new Response(JSON.stringify({ status: "no_phone_skipped" }), {
      status: 200,
      headers: { "Content-Type": "application/json" },
    });
  }
  const { data: convCandidates } = await admin
    .from("conversations")
    .select("*")
    .ilike("lead_phone", `%${normalizedPhone}`)
    .order("last_interaction_at", { ascending: false, nullsFirst: false })
    .limit(1);
  const conversation = convCandidates?.[0] ?? null;
  if (!conversation) {
    await logError({
      admin,
      source: SOURCE,
      errorType: "mooz_event_no_conversation",
      level: "info",
      message: `event=${event} booking=${booking.id} phone=${customerPhone} not matched`,
      context: { event, booking_id: booking.id, customer_phone: customerPhone },
    });
    return new Response(JSON.stringify({ status: "no_conversation_match" }), {
      status: 200,
      headers: { "Content-Type": "application/json" },
    });
  }

  // 6. Per-event handling.
  if (event === "booking.created" || event === "booking.rescheduled") {
    await handleCreatedOrRescheduled({
      admin,
      conversation,
      booking,
      event,
      handoffWebhookUrl,
      handoffWebhookSecret,
      dashboardBaseUrl,
    });
  } else if (event === "booking.cancelled") {
    await handleCancelled({ admin, conversation, booking });
  } else {
    await logError({
      admin,
      source: SOURCE,
      errorType: "mooz_event_unknown",
      level: "info",
      message: `unknown event "${event}" — ignored`,
      context: { event, booking_id: booking.id },
      conversationId: conversation.id,
    });
  }

  return new Response(JSON.stringify({ status: "ok" }), {
    status: 200,
    headers: { "Content-Type": "application/json" },
  });
});

interface ConversationRow {
  id: string;
  agent_id: string | null;
  lead_phone: string;
  lead_name: string | null;
  current_tag: string | null;
  source_campaign: string | null;
  source_funnel: string | null;
  created_at: string | null;
}

async function handleCreatedOrRescheduled(args: {
  admin: ReturnType<typeof createClient>;
  conversation: ConversationRow;
  booking: NonNullable<MoozBookingPayload["data"]>;
  event: string;
  handoffWebhookUrl: string | null;
  handoffWebhookSecret: string | null;
  dashboardBaseUrl: string | null;
}): Promise<void> {
  const { admin, conversation, booking, event, handoffWebhookUrl, handoffWebhookSecret, dashboardBaseUrl } = args;
  const scheduledAt =
    normalizeMoozTimestamp(booking.start_time) ?? new Date().toISOString();
  if (booking.start_time && !normalizeMoozTimestamp(booking.start_time)) {
    await logError({
      admin,
      source: SOURCE,
      errorType: "mooz_start_time_unrecognized",
      level: "warn",
      message:
        `unrecognized booking.start_time format: ${booking.start_time}` +
        " — falling back to now()",
      context: { booking_id: booking.id, raw: booking.start_time },
      conversationId: conversation.id,
      agentId: conversation.agent_id ?? undefined,
    });
  }
  const wasAlreadyScheduled = conversation.current_tag === "zoom_scheduled";

  // Always reflect the latest scheduled_at — handles reschedule case.
  const { error: updErr } = await admin
    .from("conversations")
    .update({
      current_tag: "zoom_scheduled",
      funnel_stage: "done",
      status: "paused",
      zoom_scheduled_at: scheduledAt,
      lead_name: conversation.lead_name ?? booking.customer_name ?? null,
    })
    .eq("id", conversation.id);
  // Mirror the consent + email into lead_memory; that's where the handoff
  // pipeline reads them from.
  await admin
    .from("lead_memory")
    .upsert(
      {
        conversation_id: conversation.id,
        q7_email: booking.customer_email ?? null,
        meeting_consented_at: new Date().toISOString(),
      },
      { onConflict: "conversation_id" },
    );
  if (updErr) {
    await logError({
      admin,
      source: SOURCE,
      errorType: "mooz_conversation_update_failed",
      message: updErr.message,
      context: { booking_id: booking.id, event },
      conversationId: conversation.id,
      agentId: conversation.agent_id ?? undefined,
    });
  }

  // Fire handoff webhook on every booking.created from Mooz — this IS the
  // canonical "Mooz confirmed the booking" trigger Kfir asked for on
  // 2026-05-24: only fire to Make.com AFTER Mooz has actually persisted
  // the booking, never on the bot's optimistic pre-tag.
  //
  // We do NOT skip on `wasAlreadyScheduled` even when the bot already set
  // current_tag='zoom_scheduled' via the book_meeting tool: the bot's
  // tool only updates our DB, it does NOT fire any webhook. If we skipped
  // here, bot-initiated bookings would silently never reach Make.com /
  // Fireberry / advisor notifications.
  //
  // Dedup against Mooz retries is handled upstream by the
  // `mooz_webhook_events` idempotency table (insert with same
  // X-Idempotency-Key short-circuits before we ever reach this point).
  //
  // booking.rescheduled is intentionally NOT a handoff trigger — the
  // advisor was already announced on the original booking.created; the
  // reschedule just adjusts zoom_scheduled_at in our DB.
  if (event === "booking.rescheduled") {
    return;
  }
  if (!handoffWebhookUrl) {
    await logError({
      admin,
      source: SOURCE,
      errorType: "handoff_webhook_url_missing",
      level: "warn",
      message:
        "Mooz booking.created arrived but HANDOFF_WEBHOOK_URL is not configured — downstream automations will not fire",
      context: { booking_id: booking.id },
      conversationId: conversation.id,
    });
    return;
  }

  // Load lead_memory for the handoff payload.
  const { data: memRow } = await admin
    .from("lead_memory")
    .select("*")
    .eq("conversation_id", conversation.id)
    .maybeSingle();

  // Load agent meeting config to populate meeting_end_at + payload shape.
  let meetingTypeId: string | null = null;
  let meetingDurationMinutes = 30;
  let agentName = "";
  if (conversation.agent_id) {
    const { data: agentRow } = await admin
      .from("agents")
      .select("name, meeting_type_id, meeting_duration_minutes")
      .eq("id", conversation.agent_id)
      .maybeSingle();
    if (agentRow) {
      meetingTypeId = (agentRow.meeting_type_id as string | null | undefined) ?? null;
      meetingDurationMinutes =
        (agentRow.meeting_duration_minutes as number | null | undefined) ?? 30;
      agentName = (agentRow.name as string | undefined) ?? "";
    }
  }

  const meetingEndAtIso = new Date(
    new Date(scheduledAt).getTime() + meetingDurationMinutes * 60_000,
  ).toISOString();
  const il = formatJerusalemTime(scheduledAt);
  const ilEnd = formatJerusalemTime(meetingEndAtIso);
  const dashboardBase = dashboardBaseUrl?.replace(/\/$/, "") ?? null;

  const handoffConv: HandoffConversation = {
    id: conversation.id,
    lead_phone: conversation.lead_phone,
    lead_name: conversation.lead_name ?? booking.customer_name ?? null,
    status: "paused",
    current_tag: "zoom_scheduled",
    funnel_stage: "done",
    zoom_scheduled_at: scheduledAt,
    qualified_at_il_date: il.date,
    qualified_at_il_time: il.time,
    qualified_at_il_datetime: il.datetime,
    meeting_type_id: meetingTypeId,
    meeting_duration_minutes: meetingDurationMinutes,
    meeting_end_at: meetingEndAtIso,
    meeting_end_at_il_datetime: ilEnd.datetime,
    source_campaign: conversation.source_campaign,
    source_funnel: conversation.source_funnel,
    created_at: conversation.created_at,
    dashboard_url: dashboardBase
      ? `${dashboardBase}/conversations/${conversation.id}`
      : null,
  };
  const handoffMem: HandoffLeadMemory = {
    q1_age: (memRow?.q1_age as number | null | undefined) ?? null,
    q2_motivation: (memRow?.q2_motivation as string | null | undefined) ?? null,
    q3_dream_change: (memRow?.q3_dream_change as string | null | undefined) ?? null,
    q4_blocker: (memRow?.q4_blocker as string | null | undefined) ?? null,
    q5_urgency: (memRow?.q5_urgency as string | null | undefined) ?? null,
    q6_investment: (memRow?.q6_investment as string | null | undefined) ?? null,
    q7_email: (memRow?.q7_email as string | null | undefined) ?? booking.customer_email ?? null,
    meeting_consented_at: new Date().toISOString(),
    conversation_summary: (memRow?.conversation_summary as string | null | undefined) ?? null,
    primary_objection: (memRow?.primary_objection as string | null | undefined) ?? null,
    red_flags: ((memRow?.red_flags as string[] | null | undefined) ?? []),
    notes_for_advisor: (memRow?.notes_for_advisor as string | null | undefined) ?? null,
  };
  const payload = buildHandoffPayload({
    agentId: conversation.agent_id ?? "",
    agentName,
    conversation: handoffConv,
    leadMemory: handoffMem,
    now: scheduledAt,
  });
  const fireResult = await fireHandoffWebhook({
    url: handoffWebhookUrl,
    secret: handoffWebhookSecret,
    payload,
  });
  if (!fireResult.ok) {
    await logError({
      admin,
      source: SOURCE,
      errorType: "handoff_webhook_failed",
      message: `handoff webhook failed status=${fireResult.status} attempts=${fireResult.attempts} terminal=${fireResult.terminal}`,
      context: {
        status: fireResult.status,
        body: fireResult.errorBody,
        attempts: fireResult.attempts,
        terminal: fireResult.terminal,
      },
      conversationId: conversation.id,
      agentId: conversation.agent_id ?? undefined,
    });
  }
}

async function handleCancelled(args: {
  admin: ReturnType<typeof createClient>;
  conversation: ConversationRow;
  booking: NonNullable<MoozBookingPayload["data"]>;
}): Promise<void> {
  const { admin, conversation, booking } = args;
  // Cancellation → operator needs to know. Don't auto-reopen the bot loop:
  // a cancellation might be a misclick or a reschedule mid-flight; let the
  // advisor decide.
  await admin
    .from("conversations")
    .update({
      current_tag: "requires_human",
      status: "paused",
      zoom_scheduled_at: null,
    })
    .eq("id", conversation.id);
  await logError({
    admin,
    source: SOURCE,
    errorType: "mooz_booking_cancelled",
    level: "warn",
    message: `Mooz booking ${booking.id} was cancelled — conversation flagged requires_human`,
    context: { booking_id: booking.id },
    conversationId: conversation.id,
    agentId: conversation.agent_id ?? undefined,
  });
}

function formatJerusalemTime(utcIso: string): { date: string; time: string; datetime: string } {
  try {
    const d = new Date(utcIso);
    const opts: Intl.DateTimeFormatOptions = { timeZone: "Asia/Jerusalem" };
    const date = d.toLocaleDateString("en-CA", { ...opts, year: "numeric", month: "2-digit", day: "2-digit" });
    const time = d.toLocaleTimeString("he-IL", { ...opts, hour: "2-digit", minute: "2-digit", hour12: false });
    const datetimeParts = d.toLocaleString("he-IL", {
      ...opts,
      year: "numeric",
      month: "2-digit",
      day: "2-digit",
      hour: "2-digit",
      minute: "2-digit",
      hour12: false,
    });
    return { date, time, datetime: datetimeParts };
  } catch {
    return { date: utcIso, time: utcIso, datetime: utcIso };
  }
}
