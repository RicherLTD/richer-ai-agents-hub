// conversation-set-mode/index.ts
//
// Admin-only endpoint that toggles a conversation between AI mode and
// manual mode. Conversations have no client-side RLS UPDATE policy
// (migration 0004) — all writes go through service_role here.
//
// Request:
//   POST /functions/v1/conversation-set-mode
//   Authorization: Bearer <user JWT>
//   { "conversation_id": string, "mode": "manual" | "ai" }

import { corsHeaders } from "../_shared/cors.ts";
import { HttpError, jsonResponse, requireAdmin } from "../_shared/auth.ts";
import { logError } from "../_shared/logError.ts";
import { isSetModePayload } from "./validate.ts";

const SOURCE = "conversation-set-mode";

Deno.serve(async (req) => {
  if (req.method === "OPTIONS") {
    return new Response(null, { headers: corsHeaders });
  }
  if (req.method !== "POST") {
    return jsonResponse({ error: "Method not allowed" }, { status: 405, headers: corsHeaders });
  }

  try {
    const { admin, callerId } = await requireAdmin(req);

    const body = await req.json().catch(() => null);
    if (!isSetModePayload(body)) {
      throw new HttpError(400, "Body must be { conversation_id, mode: 'manual'|'ai' }");
    }

    const manualSince = body.mode === "manual" ? new Date().toISOString() : null;
    const manualBy = body.mode === "manual" ? callerId : null;

    const { data: updated, error: updErr } = await admin
      .from("conversations")
      .update({ manual_mode_since: manualSince, manual_mode_by: manualBy })
      .eq("id", body.conversation_id)
      .select("id, manual_mode_since, manual_mode_by")
      .maybeSingle();

    if (updErr) {
      await logError({
        admin,
        source: SOURCE,
        errorType: "conversation_update_failed",
        message: updErr.message,
        context: { conversationId: body.conversation_id, mode: body.mode, dbCode: updErr.code ?? null },
        conversationId: body.conversation_id,
      });
      throw new HttpError(500, `Failed to set mode: ${updErr.message}`);
    }
    if (!updated) {
      throw new HttpError(404, "Conversation not found");
    }

    return jsonResponse(updated, { status: 200, headers: corsHeaders });
  } catch (err) {
    if (err instanceof HttpError) {
      return jsonResponse({ error: err.message }, { status: err.status, headers: corsHeaders });
    }
    console.error("conversation-set-mode: unexpected error", err);
    return jsonResponse({ error: "Internal server error" }, { status: 500, headers: corsHeaders });
  }
});
