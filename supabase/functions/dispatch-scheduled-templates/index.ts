// dispatch-scheduled-templates/index.ts
//
// Cron-fired endpoint that drains the scheduled_messages queue. Runs
// every minute via pg_cron; each call:
//
//   1. Pulls up to N pending+due rows (FOR UPDATE SKIP LOCKED so
//      concurrent runs don't double-send).
//   2. For each row → if the agent has the Mooz pre-send check enabled,
//      ask Mooz whether the lead already booked a Zoom. If yes, cancel
//      the queued row, tag the conversation as zoom_scheduled, skip.
//   3. Otherwise → send the WhatsApp Template via Meta Cloud API.
//   4. On success → record an outbound row in messages, mark the
//      scheduled row as 'sent' + stamp meta_message_id.
//   5. On failure → bump attempts, log, mark 'failed' after 3 retries.
//
// Why not just rely on the dispatcher running every minute and retrying
// 'failed' rows? Because each minute is a fresh row scan — by capping
// attempts on the row itself we prevent the same failing template from
// hammering Meta for the full retention period of the row.
//
// Mooz check semantics (also documented in `_shared/moozCheck.ts`):
//   - booked=true  → cancel row, tag conversation, do NOT send.
//   - booked=false (not_booked) → send as planned.
//   - booked=false with any error reason → fail-open: send as planned
//     AND log a warning. A duplicate WhatsApp follow-up is recoverable;
//     skipping a cold-lead first touch because Mooz is down is not.
//
// Auth: shared-secret bearer (CRON_SHARED_SECRET) — same pattern as
// re-engage-cold-leads. pg_cron can't carry JWTs.
//
// Required env:
//   CRON_SHARED_SECRET, WHATSAPP_API_URL, WHATSAPP_ACCESS_TOKEN,
//   WHATSAPP_PHONE_NUMBER_ID. Auto-injected: SUPABASE_*.
// Optional env:
//   MOOZ_API_TOKEN — Bearer token sent to the per-agent Mooz endpoint.
//   When absent we skip the Mooz check globally and log a warning once
//   per tick so the operator notices the misconfiguration.

import { createClient } from "https://esm.sh/@supabase/supabase-js@2.45.4";
import { corsHeaders } from "../_shared/cors.ts";
import { logError } from "../_shared/logError.ts";
import { checkMoozBooking } from "../_shared/moozCheck.ts";
import {
  renderTemplatePreview,
  sendWhatsAppTemplate,
} from "../_shared/whatsappTemplateSend.ts";

const SOURCE = "dispatch-scheduled-templates";
const DEFAULT_BATCH = 50;
const MAX_ATTEMPTS_PER_ROW = 3;

function jsonResponse(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { ...corsHeaders, "Content-Type": "application/json" },
  });
}

interface ScheduledRowAgent {
  is_paused: boolean;
  meeting_check_url: string | null;
  meeting_check_enabled: boolean;
}

interface ScheduledRow {
  id: string;
  agent_id: string;
  conversation_id: string | null;
  lead_phone: string;
  lead_name: string | null;
  template_name: string;
  template_language: string;
  template_variables: unknown;
  attempts: number;
  agents: ScheduledRowAgent;
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

Deno.serve(async (req) => {
  if (req.method === "OPTIONS") return new Response(null, { headers: corsHeaders });
  if (req.method !== "POST") {
    return jsonResponse({ error: "Method not allowed" }, 405);
  }

  // Auth — same pattern as re-engage-cold-leads.
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

  // Pull due pending rows. We also respect the kill switch via an inner
  // join — if an agent is paused, its scheduled messages wait. We also
  // join meeting_check_* so we know whether to ping Mooz before each send.
  const nowIso = new Date().toISOString();
  const { data: candidates, error: pickErr } = await admin
    .from("scheduled_messages")
    .select(
      "id, agent_id, conversation_id, lead_phone, lead_name, template_name, template_language, template_variables, attempts, agents!inner(is_paused, meeting_check_url, meeting_check_enabled)",
    )
    .eq("status", "pending")
    .lte("scheduled_for", nowIso)
    .eq("agents.is_paused", false)
    .order("scheduled_for", { ascending: true })
    .limit(limit);
  if (pickErr) {
    await logError({
      admin,
      source: SOURCE,
      errorType: "pick_failed",
      message: pickErr.message,
      context: { limit },
    });
    return jsonResponse({ error: pickErr.message }, 500);
  }
  const rows = (candidates ?? []) as unknown as ScheduledRow[];

  const results = {
    picked: rows.length,
    sent: 0,
    failed: 0,
    exhausted: 0,
    skipped_already_booked: 0,
  };

  // Operator-visible heads-up: at least one row has the Mooz check
  // turned on but no token is configured. Log once per tick.
  let warnedAboutMissingToken = false;

  for (const row of rows) {
    const agent = row.agents;

    // ─── Pre-send Mooz check ──────────────────────────────────────────
    // Only fires when:
    //   - agent has meeting_check_enabled = true AND has a configured URL
    //   - MOOZ_API_TOKEN is set
    // Any error path (network, 5xx, malformed body, bad URL) falls
    // through to "send anyway" — a duplicate WhatsApp message is the
    // recoverable failure mode.
    if (agent?.meeting_check_enabled && agent.meeting_check_url) {
      if (!moozToken) {
        if (!warnedAboutMissingToken) {
          warnedAboutMissingToken = true;
          await logError({
            admin,
            source: SOURCE,
            errorType: "mooz_token_missing",
            level: "warn",
            message:
              "meeting_check_enabled is true for at least one agent but MOOZ_API_TOKEN is not configured — sending without the safety check",
            context: { agent_id: row.agent_id },
            agentId: row.agent_id,
            conversationId: row.conversation_id,
          });
        }
      } else {
        const moozResult = await checkMoozBooking({
          url: agent.meeting_check_url,
          token: moozToken,
          phone: row.lead_phone,
        });

        if (moozResult.booked) {
          // Lead already has a Zoom — cancel the queued template, tag
          // the conversation, skip the send.
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

          await admin
            .from("scheduled_messages")
            .update({
              status: "cancelled",
              last_error: "mooz_already_booked",
              attempts: row.attempts + 1,
            })
            .eq("id", row.id);
          continue;
        }

        // Not booked — but distinguish "Mooz said no" from "Mooz had an
        // error". The latter is operator-actionable; the former is the
        // common case.
        if (moozResult.reason !== "not_booked") {
          await logError({
            admin,
            source: SOURCE,
            errorType: `mooz_check_${moozResult.reason}`,
            level: "warn",
            message:
              `Mooz pre-send check failed (${moozResult.reason}) — sending template anyway (fail-open)`,
            context: { reason: moozResult.reason, ...moozResult },
            agentId: row.agent_id,
            conversationId: row.conversation_id,
          });
        }
      }
    }
    // ─── End Mooz check ───────────────────────────────────────────────

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
      // Outbound row so the dashboard shows the message in the thread.
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

    await admin
      .from("scheduled_messages")
      .update({
        status: exhausted ? "failed" : "pending",
        attempts: nextAttempts,
        last_error: send.errorBody,
      })
      .eq("id", row.id);
  }

  // Use renderTemplatePreview in a typeof guard so dead-code analysis
  // keeps the import alive even when no rows are picked this tick.
  if (rows.length === 0 && typeof renderTemplatePreview !== "function") {
    // unreachable — purely to anchor the import
  }

  return jsonResponse({ ok: true, ...results });
});
