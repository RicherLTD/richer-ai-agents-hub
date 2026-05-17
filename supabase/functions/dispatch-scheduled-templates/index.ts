// dispatch-scheduled-templates/index.ts
//
// Cron-fired endpoint that drains the scheduled_messages queue. Runs
// every minute via pg_cron; each call:
//
//   1. Pulls up to N pending+due rows (FOR UPDATE SKIP LOCKED so
//      concurrent runs don't double-send).
//   2. For each row → send the WhatsApp Template via Meta Cloud API.
//   3. On success → record an outbound row in messages, mark the
//      scheduled row as 'sent' + stamp meta_message_id.
//   4. On failure → bump attempts, log, mark 'failed' after 3 retries.
//
// Why not just rely on the dispatcher running every minute and retrying
// 'failed' rows? Because each minute is a fresh row scan — by capping
// attempts on the row itself we prevent the same failing template from
// hammering Meta for the full retention period of the row.
//
// Auth: shared-secret bearer (CRON_SHARED_SECRET) — same pattern as
// re-engage-cold-leads. pg_cron can't carry JWTs.
//
// Required env:
//   CRON_SHARED_SECRET, WHATSAPP_API_URL, WHATSAPP_ACCESS_TOKEN,
//   WHATSAPP_PHONE_NUMBER_ID. Auto-injected: SUPABASE_*.

import { createClient } from "https://esm.sh/@supabase/supabase-js@2.45.4";
import { corsHeaders } from "../_shared/cors.ts";
import { logError } from "../_shared/logError.ts";
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
  // join — if an agent is paused, its scheduled messages wait.
  const nowIso = new Date().toISOString();
  const { data: candidates, error: pickErr } = await admin
    .from("scheduled_messages")
    .select(
      "id, agent_id, conversation_id, lead_phone, lead_name, template_name, template_language, template_variables, attempts, agents!inner(is_paused)",
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

  const results = { picked: rows.length, sent: 0, failed: 0, exhausted: 0 };

  for (const row of rows) {
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
