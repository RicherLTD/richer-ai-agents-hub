// dlq-replay/index.ts
//
// Admin-only endpoint to retry rows from `failed_messages`. Two modes:
//
//   1. Targeted: { id: "<failed_message_id>" } — retry one row.
//   2. Batch:    { limit?: 50, error_type?: string, agent_id?: uuid }
//      Picks up to `limit` rows where retry_count < 3 and replays them.
//
// Currently supports replay of:
//   - hookmyapp_send_failed  → re-send the WhatsApp text via HookMyApp.
//   - handoff_webhook_failed → re-fire the handoff webhook to Make.com.
//
// On success we set `resolved_at = now()`. On failure we bump
// `retry_count` and update `last_retry_at`. After 3 attempts the row is
// considered terminal and skipped by the batch path.
//
// Auth: requireAdmin. The function ITSELF uses service_role so it can
// write to `failed_messages` regardless of RLS.

import "https://esm.sh/@supabase/supabase-js@2.45.4";
import { corsHeaders } from "../_shared/cors.ts";
import { HttpError, jsonResponse, requireAdmin } from "../_shared/auth.ts";
import { logError } from "../_shared/logError.ts";
import { sendWhatsAppText } from "../_shared/whatsappSend.ts";
import { fireHandoffWebhook, type HandoffPayload } from "../_shared/fireHandoffWebhook.ts";

const SOURCE = "dlq-replay";
const MAX_RETRIES = 3;
const DEFAULT_BATCH = 25;

interface ReplayRow {
  id: string;
  source: string;
  error_type: string;
  payload: Record<string, unknown>;
  retry_count: number;
  conversation_id: string | null;
  agent_id: string | null;
}

interface OneResult {
  id: string;
  success: boolean;
  reason: string;
}

async function replayHookmyappSend(
  row: ReplayRow,
): Promise<{ ok: boolean; detail: string }> {
  const apiUrl = Deno.env.get("WHATSAPP_API_URL");
  const accessToken = Deno.env.get("WHATSAPP_ACCESS_TOKEN");
  const phoneId = Deno.env.get("WHATSAPP_PHONE_NUMBER_ID");
  if (!apiUrl || !accessToken || !phoneId) {
    return { ok: false, detail: "HookMyApp env not configured" };
  }
  const text = typeof row.payload.reply_text === "string" ? row.payload.reply_text : null;
  const phone = typeof row.payload.lead_phone === "string" ? row.payload.lead_phone : null;
  if (!text || !phone) {
    return { ok: false, detail: "payload missing reply_text or lead_phone" };
  }
  const result = await sendWhatsAppText({
    apiUrl,
    accessToken,
    phoneNumberId: phoneId,
    to: phone,
    body: text,
  });
  if (!result.ok) {
    return { ok: false, detail: `status=${result.status} attempts=${result.attempts}` };
  }
  return { ok: true, detail: `sent, meta_id=${result.metaMessageId ?? "none"}` };
}

async function replayHandoffWebhook(
  row: ReplayRow,
): Promise<{ ok: boolean; detail: string }> {
  const url = Deno.env.get("HANDOFF_WEBHOOK_URL");
  const secret = Deno.env.get("HANDOFF_WEBHOOK_SECRET") ?? null;
  if (!url) return { ok: false, detail: "HANDOFF_WEBHOOK_URL not configured" };
  // The original handoff payload is the entire row.payload (we stash it
  // verbatim on enqueue). Re-fire as-is.
  const payload = row.payload as unknown as HandoffPayload;
  const result = await fireHandoffWebhook({ url, secret, payload });
  if (!result.ok) {
    return {
      ok: false,
      detail: `status=${result.status} attempts=${result.attempts} terminal=${result.terminal}`,
    };
  }
  return { ok: true, detail: `fired, status=${result.status}` };
}

async function replayOne(
  // deno-lint-ignore no-explicit-any
  admin: any,
  row: ReplayRow,
): Promise<OneResult> {
  let outcome: { ok: boolean; detail: string };
  switch (row.error_type) {
    case "hookmyapp_send_failed":
      outcome = await replayHookmyappSend(row);
      break;
    case "handoff_webhook_failed":
      outcome = await replayHandoffWebhook(row);
      break;
    default:
      outcome = { ok: false, detail: `unsupported error_type for replay: ${row.error_type}` };
  }
  const patch: Record<string, unknown> = {
    retry_count: row.retry_count + 1,
    last_retry_at: new Date().toISOString(),
  };
  if (outcome.ok) patch.resolved_at = new Date().toISOString();
  patch.resolution_note = outcome.detail;
  await admin.from("failed_messages").update(patch).eq("id", row.id);
  await logError({
    admin,
    source: SOURCE,
    errorType: outcome.ok ? "replay_succeeded" : "replay_failed",
    level: outcome.ok ? "info" : "warn",
    message: `${row.error_type}: ${outcome.detail}`,
    context: { failed_message_id: row.id, retry_count: row.retry_count + 1 },
    agentId: row.agent_id,
    conversationId: row.conversation_id,
  });
  return { id: row.id, success: outcome.ok, reason: outcome.detail };
}

interface ReplayRequest {
  id?: string;
  limit?: number;
  error_type?: string;
  agent_id?: string;
}

Deno.serve(async (req) => {
  if (req.method === "OPTIONS") return new Response(null, { headers: corsHeaders });
  if (req.method !== "POST") {
    return jsonResponse({ error: "Method not allowed" }, { status: 405, headers: corsHeaders });
  }

  try {
    const ctx = await requireAdmin(req);

    let body: ReplayRequest;
    try {
      body = (await req.json()) as ReplayRequest;
    } catch {
      throw new HttpError(400, "Invalid JSON body");
    }

    let rows: ReplayRow[];
    if (body.id) {
      const { data, error } = await ctx.admin
        .from("failed_messages")
        .select("id, source, error_type, payload, retry_count, conversation_id, agent_id")
        .eq("id", body.id)
        .maybeSingle();
      if (error) throw new HttpError(500, `Read failed: ${error.message}`);
      if (!data) throw new HttpError(404, "failed_message not found");
      rows = [data as ReplayRow];
    } else {
      const limit = Math.min(Math.max(body.limit ?? DEFAULT_BATCH, 1), 100);
      let q = ctx.admin
        .from("failed_messages")
        .select("id, source, error_type, payload, retry_count, conversation_id, agent_id")
        .lt("retry_count", MAX_RETRIES)
        .is("resolved_at", null)
        .order("created_at", { ascending: true })
        .limit(limit);
      if (body.error_type) q = q.eq("error_type", body.error_type);
      if (body.agent_id) q = q.eq("agent_id", body.agent_id);
      const { data, error } = await q;
      if (error) throw new HttpError(500, `Read failed: ${error.message}`);
      rows = (data ?? []) as ReplayRow[];
    }

    const results: OneResult[] = [];
    for (const row of rows) {
      results.push(await replayOne(ctx.admin, row));
    }

    return jsonResponse(
      {
        attempted: results.length,
        succeeded: results.filter((r) => r.success).length,
        failed: results.filter((r) => !r.success).length,
        results,
      },
      { status: 200, headers: corsHeaders },
    );
  } catch (err) {
    if (err instanceof HttpError) {
      return jsonResponse({ error: err.message }, { status: err.status, headers: corsHeaders });
    }
    const detail = err instanceof Error ? err.message : String(err);
    console.error("[dlq-replay] unexpected error", detail);
    return jsonResponse(
      { error: `Internal error: ${detail}` },
      { status: 500, headers: corsHeaders },
    );
  }
});
