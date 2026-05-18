// dispatch-scheduled-templates/index.ts
//
// Cron-fired endpoint that drains the scheduled_messages queue. Runs
// every minute via pg_cron; each call:
//
//   1. CLAIMs up to N pending+due rows atomically (via the
//      `claim_scheduled_messages` SQL function which uses
//      `FOR UPDATE SKIP LOCKED` + stamps `claimed_at` so overlapping
//      ticks cant double-pick the same row).
//   2. For each row -> if the agent has the Mooz pre-send check enabled,
//      ASK Mooz whether the lead already booked a Zoom.
//        - booked=true                -> cancel row, tag conversation, skip
//        - booked=false (not_booked)  -> send the template
//        - anything else (timeout, http error, network, missing token,
//          missing URL, non-Israeli phone)  -> FAIL-CLOSED: release the
//          claim, bump attempts, do NOT send. The next cron tick will
//          retry. After `MAX_ATTEMPTS_PER_ROW` failures the row is
//          marked `failed` so we dont retry forever on a permanently
//          dead Mooz.
//   3. Otherwise (Mooz check not enabled for this agent) -> send.
//   4. On send success -> insert outbound message + mark row `sent`.
//   5. On send failure -> bump attempts; release the claim if still
//      retryable, mark `failed` if exhausted.
//
// Why fail-CLOSED instead of fail-open?
//   Operator explicit requirement: "no template is sent without a clean
//   Mooz answer". A duplicate WhatsApp template to a lead who already
//   booked is worse than a delayed first-touch. The trade-off is that a
//   degraded Mooz can hold the queue; the operator can manually
//   `UPDATE agents SET meeting_check_enabled = false WHERE name = ?`
//   to bypass during an outage.
//
// Concurrency:
//   `claim_scheduled_messages` (migration 0025) uses FOR UPDATE SKIP
//   LOCKED in a CTE that also stamps `claimed_at`. The combination
//   means a second concurrent dispatcher tick:
//     - cannot see rows that are locked (SKIP LOCKED)
//     - and after the first tick commits, sees them filtered out by
//       `claimed_at IS NULL` (until the claim grace window expires).
//   A 10-minute grace window built into the function handles crashed
//   dispatchers automatically.
//
// Tick deadline:
//   With up to 50 rows per tick, each row taking up to ~13 seconds
//   under degraded Mooz, a single tick could exceed the Edge Function
//   wall-clock limit. We stop picking new rows when within 10 seconds
//   of the soft deadline.
//
// Auth: shared-secret bearer (CRON_SHARED_SECRET) -- same pattern as
// re-engage-cold-leads. pg_cron cant carry JWTs.
//
// Required env:
//   CRON_SHARED_SECRET, WHATSAPP_API_URL, WHATSAPP_ACCESS_TOKEN,
//   WHATSAPP_PHONE_NUMBER_ID. Auto-injected: SUPABASE_*.
// Optional env:
//   MOOZ_API_TOKEN -- Bearer token sent to the per-agent Mooz endpoint.
//   Required IF any agent has `meeting_check_enabled = true`; if
//   missing while checks are required, affected rows are held pending
//   (fail-closed) until the token is configured.

import { createClient, type SupabaseClient } from "https://esm.sh/@supabase/supabase-js@2.45.4";
import { corsHeaders } from "../_shared/cors.ts";
import { logError } from "../_shared/logError.ts";
import { checkMoozBooking, type MoozCheckOutcome } from "../_shared/moozCheck.ts";
import {
  renderTemplatePreview,
  sendWhatsAppTemplate,
} from "../_shared/whatsappTemplateSend.ts";

const SOURCE = "dispatch-scheduled-templates";
const DEFAULT_BATCH = 50;
const MAX_ATTEMPTS_PER_ROW = 3;
const TICK_DEADLINE_MS = 50_000;

function jsonResponse(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { ...corsHeaders, "Content-Type": "application/json" },
  });
}

interface ClaimedRow {
  id: string;
  agent_id: string;
  conversation_id: string | null;
  lead_phone: string;
  lead_name: string | null;
  template_name: string;
  template_language: string;
  template_variables: unknown;
  attempts: number;
  agent_is_paused: boolean;
  agent_meeting_check_url: string | null;
  agent_meeting_check_enabled: boolean;
}

function variablesArray(raw: unknown): string[] {
  if (!Array.isArray(raw)) return [];
  const out: string[] = [];
  for (const v of raw) {
    if (typeof v === "string") out.push(v);
    else if (v == null) out.push("");
    else out.push(String(v));
  }
  return out;
}

/**
 * Build the `error_logs.context` payload for a Mooz failure WITHOUT
 * spreading the outcome. We pick safe fields explicitly so we never
 * leak `errorBody` (which could echo the Bearer token in a 401 body)
 * and so the shape is stable across MoozCheckOutcome variant changes.
 */
function moozContext(outcome: MoozCheckOutcome): Record<string, unknown> {
  const base: Record<string, unknown> = { reason: outcome.booked ? "booked" : outcome.reason };
  if (outcome.booked === false) {
    if (outcome.reason === "http_error") base.httpStatus = outcome.status;
    if (outcome.reason === "bad_url") base.detail = outcome.detail;
    if (outcome.reason === "network_error") base.detail = outcome.detail;
    if (outcome.reason === "invalid_response") base.detail = outcome.detail;
    if (outcome.reason === "non_israeli_phone") base.detail = outcome.detail;
  }
  return base;
}

/** Release a claim so the next tick can retry this row. */
async function holdRowPending(
  admin: SupabaseClient,
  rowId: string,
  nextAttempts: number,
  lastError: string,
): Promise<void> {
  await admin
    .from("scheduled_messages")
    .update({
      claimed_at: null,
      attempts: nextAttempts,
      last_error: lastError,
    })
    .eq("id", rowId);
}

/** Mark a row terminally failed. claimed_at left in place (irrelevant once status != pending). */
async function markRowFailed(
  admin: SupabaseClient,
  rowId: string,
  nextAttempts: number,
  lastError: string,
): Promise<void> {
  await admin
    .from("scheduled_messages")
    .update({
      status: "failed",
      attempts: nextAttempts,
      last_error: lastError,
    })
    .eq("id", rowId);
}

Deno.serve(async (req) => {
  if (req.method === "OPTIONS") return new Response(null, { headers: corsHeaders });
  if (req.method !== "POST") {
    return jsonResponse({ error: "Method not allowed" }, 405);
  }

  // Auth -- same pattern as re-engage-cold-leads.
  const cronSecret = Deno.env.get("CRON_SHARED_SECRET");
  if (!cronSecret) return jsonResponse({ error: "CRON_SHARED_SECRET not configured" }, 500);
  const auth = req.headers.get("Authorization") ?? "";
  if (auth !== `Bearer ${cronSecret}`) return jsonResponse({ error: "Unauthorized" }, 401);

  const supabaseUrl = Deno.env.get("SUPABASE_URL");
  const serviceRoleKey = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY");
  const apiUrl = Deno.env.get("WHATSAPP_API_URL");
  const accessToken = Deno.env.get("WHATSAPP_ACCESS_TOKEN");
  const phoneId = Deno.env.get("WHATSAPP_PHONE_NUMBER_ID");
  const moozToken = Deno.env.get("MOOZ_API_TOKEN") ?? null;
  if (!supabaseUrl || !serviceRoleKey) {
    return jsonResponse({ error: "Missing Supabase env" }, 500);
  }
  if (!apiUrl || !accessToken || !phoneId) {
    return jsonResponse({ error: "HookMyApp env not configured" }, 500);
  }

  const admin = createClient(supabaseUrl, serviceRoleKey, {
    auth: { persistSession: false, autoRefreshToken: false },
  });

  const url = new URL(req.url);
  const limitRaw = parseInt(url.searchParams.get("limit") ?? "", 10);
  const limit = Number.isFinite(limitRaw) && limitRaw > 0 && limitRaw <= 200
    ? limitRaw
    : DEFAULT_BATCH;

  // Atomic claim: invisibility-guarantee that overlapping ticks wont
  // see the same row. The RPC stamps `claimed_at = p_now`, so any
  // concurrent claim with `claimed_at IS NULL` filter passes us by.
  const nowIso = new Date().toISOString();
  const { data: claimed, error: claimErr } = await admin.rpc("claim_scheduled_messages", {
    p_limit: limit,
    p_now: nowIso,
  });
  if (claimErr) {
    await logError({
      admin,
      source: SOURCE,
      errorType: "claim_failed",
      message: claimErr.message,
      context: { limit },
    });
    return jsonResponse({ error: claimErr.message }, 500);
  }
  const rows = (claimed ?? []) as unknown as ClaimedRow[];

  const results = {
    picked: rows.length,
    sent: 0,
    failed: 0,
    exhausted: 0,
    skipped_already_booked: 0,
    held_mooz_failed: 0,
    deadline_break: false,
  };

  const tickStart = Date.now();

  for (const row of rows) {
    // Soft deadline: stop picking up new rows when we are close to
    // the Edge Function wall-clock limit. Released rows (claimed_at
    // still null after the grace window or via explicit clearing on
    // next tick) get a clean retry.
    if (Date.now() - tickStart > TICK_DEADLINE_MS) {
      results.deadline_break = true;
      // Release the rest by clearing claimed_at so next tick picks them.
      const remaining = rows.slice(rows.indexOf(row)).map((r) => r.id);
      if (remaining.length > 0) {
        await admin
          .from("scheduled_messages")
          .update({ claimed_at: null })
          .in("id", remaining);
      }
      break;
    }

    // ----- Pre-send Mooz check (fail-closed) -----
    if (row.agent_meeting_check_enabled) {
      // Defensive: a CHECK constraint prevents this combination at the
      // DB level, but if the constraint is ever dropped or bypassed we
      // refuse to send rather than silently skipping the safety guard.
      if (!row.agent_meeting_check_url) {
        const nextAttempts = row.attempts + 1;
        await logError({
          admin,
          source: SOURCE,
          errorType: "mooz_url_missing",
          level: "error",
          message: "meeting_check_enabled=true but meeting_check_url is null \u2014 row held (fail-closed)",
          context: { attempts: nextAttempts, max: MAX_ATTEMPTS_PER_ROW },
          agentId: row.agent_id,
          conversationId: row.conversation_id,
        });
        if (nextAttempts >= MAX_ATTEMPTS_PER_ROW) {
          await markRowFailed(admin, row.id, nextAttempts, "mooz_url_missing");
          results.exhausted++;
        } else {
          await holdRowPending(admin, row.id, nextAttempts, "mooz_url_missing");
          results.held_mooz_failed++;
        }
        continue;
      }

      if (!moozToken) {
        const nextAttempts = row.attempts + 1;
        await logError({
          admin,
          source: SOURCE,
          errorType: "mooz_token_missing",
          level: "error",
          message: "MOOZ_API_TOKEN missing while meeting_check_enabled=true \u2014 row held (fail-closed)",
          context: { attempts: nextAttempts, max: MAX_ATTEMPTS_PER_ROW },
          agentId: row.agent_id,
          conversationId: row.conversation_id,
        });
        if (nextAttempts >= MAX_ATTEMPTS_PER_ROW) {
          await markRowFailed(admin, row.id, nextAttempts, "mooz_token_missing");
          results.exhausted++;
        } else {
          await holdRowPending(admin, row.id, nextAttempts, "mooz_token_missing");
          results.held_mooz_failed++;
        }
        continue;
      }

      const moozResult = await checkMoozBooking({
        url: row.agent_meeting_check_url,
        token: moozToken,
        phone: row.lead_phone,
      });

      if (moozResult.booked === true) {
        // Lead already booked -- cancel the queued template, tag the
        // conversation as zoom_scheduled, skip the send.
        results.skipped_already_booked++;
        const ts = new Date().toISOString();
        const scheduledAt = moozResult.scheduledAt ?? ts;

        if (row.conversation_id) {
          const { error: convErr } = await admin
            .from("conversations")
            .update({
              current_tag: "zoom_scheduled",
              status: "paused",
              zoom_scheduled_at: scheduledAt,
            })
            .eq("id", row.conversation_id);
          if (convErr) {
            await logError({
              admin,
              source: SOURCE,
              errorType: "mooz_skip_conv_update_failed",
              level: "warn",
              message: convErr.message,
              context: { conversation_id: row.conversation_id },
              agentId: row.agent_id,
              conversationId: row.conversation_id,
            });
          }
        }

        const { error: cancelErr } = await admin
          .from("scheduled_messages")
          .update({
            status: "cancelled",
            last_error: "mooz_already_booked",
            attempts: row.attempts + 1,
          })
          .eq("id", row.id);
        if (cancelErr) {
          await logError({
            admin,
            source: SOURCE,
            errorType: "mooz_cancel_row_failed",
            level: "error",
            message: cancelErr.message,
            context: { scheduled_message_id: row.id },
            agentId: row.agent_id,
            conversationId: row.conversation_id,
          });
        }
        continue;
      }

      if (moozResult.reason !== "not_booked") {
        // FAIL-CLOSED: any Mooz failure (timeout, http error, network,
        // invalid response, non-Israeli phone, bad url) holds the row.
        const nextAttempts = row.attempts + 1;
        const exhausted = nextAttempts >= MAX_ATTEMPTS_PER_ROW;
        const errorTypeReason = moozResult.reason.replace(/[^a-z0-9_]/g, "_");
        await logError({
          admin,
          source: SOURCE,
          errorType: `mooz_check_${errorTypeReason}`,
          level: exhausted ? "error" : "warn",
          message: exhausted
            ? `Mooz check failed (${moozResult.reason}); attempts exhausted \u2014 row marked failed`
            : `Mooz check failed (${moozResult.reason}); row held for retry (attempt ${nextAttempts}/${MAX_ATTEMPTS_PER_ROW})`,
          context: { ...moozContext(moozResult), attempts: nextAttempts, max: MAX_ATTEMPTS_PER_ROW },
          agentId: row.agent_id,
          conversationId: row.conversation_id,
        });
        if (exhausted) {
          await markRowFailed(admin, row.id, nextAttempts, `mooz_${errorTypeReason}`);
          results.exhausted++;
        } else {
          await holdRowPending(admin, row.id, nextAttempts, `mooz_${errorTypeReason}`);
          results.held_mooz_failed++;
        }
        continue;
      }
      // moozResult.reason === "not_booked" -- safe to send.
    }
    // ----- End Mooz check -----

    const variables = variablesArray(row.template_variables);
    const send = await sendWhatsAppTemplate({
      apiUrl,
      accessToken,
      phoneNumberId: phoneId,
      to: row.lead_phone,
      templateName: row.template_name,
      languageCode: row.template_language,
      variables,
    });

    if (send.ok) {
      results.sent++;
      const ts = new Date().toISOString();
      if (row.conversation_id) {
        await admin.from("messages").insert({
          conversation_id: row.conversation_id,
          direction: "outbound",
          message_type: "text",
          content: send.renderedBody,
          timestamp: ts,
          meta_message_id: send.metaMessageId,
        });
        await admin
          .from("conversations")
          .update({ last_interaction_at: ts })
          .eq("id", row.conversation_id);
      }
      await admin
        .from("scheduled_messages")
        .update({
          status: "sent",
          sent_at: ts,
          meta_message_id: send.metaMessageId,
          attempts: row.attempts + 1,
        })
        .eq("id", row.id);
      continue;
    }

    // Send failed.
    const nextAttempts = row.attempts + 1;
    const exhausted = send.terminal || nextAttempts >= MAX_ATTEMPTS_PER_ROW;
    if (exhausted) results.exhausted++;
    else results.failed++;

    await logError({
      admin,
      source: SOURCE,
      errorType: send.terminal ? "template_send_terminal" : "template_send_failed",
      level: exhausted ? "error" : "warn",
      message: `template send failed status=${send.status} attempts=${nextAttempts}/${MAX_ATTEMPTS_PER_ROW}`,
      context: {
        status: send.status,
        errorBody: send.errorBody,
        attempts: nextAttempts,
        terminal: send.terminal,
        template_name: row.template_name,
      },
      agentId: row.agent_id,
      conversationId: row.conversation_id,
    });

    if (exhausted) {
      await markRowFailed(admin, row.id, nextAttempts, send.errorBody || "send_failed");
    } else {
      await holdRowPending(admin, row.id, nextAttempts, send.errorBody || "send_failed");
    }
  }

  // Anchor the import so dead-code analysis doesnt drop it when the
  // batch is empty.
  if (rows.length === 0 && typeof renderTemplatePreview !== "function") {
    // unreachable
  }

  return jsonResponse({ ok: true, ...results });
});
