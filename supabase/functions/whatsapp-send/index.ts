// whatsapp-send/index.ts
//
// Authenticated edge function that proxies a text message to HookMyApp
// (sandbox or production) and records the outbound row in `messages`.
// Replaces the dashboard's direct insert path: the row only lands in the
// DB if the WhatsApp send succeeded, so no orphan outbound rows.
//
// Phase A reliability changes:
//   - Send via shared sendWhatsAppText helper (retry + timeout + Bearer
//     redaction in error bodies).
//   - Outbound row carries the Meta wamid returned by HookMyApp so the
//     dashboard can correlate with delivery receipts later.
//   - Insert failure after a successful send → log + DLQ (used to just
//     warn in console and return 200 silently).
//   - All console.error calls replaced with logError (structured).
//   - User-facing error messages are generic — raw upstream bodies stay
//     in error_logs.context, not in the response body.
//
// Request:
//   POST /functions/v1/whatsapp-send
//   Authorization: Bearer <user JWT>
//   { "conversation_id": string, "content": string }
//
// Required secrets (Supabase edge runtime env):
//   WHATSAPP_API_URL          — sandbox: https://sandbox.hookmyapp.com/v22.0
//                                production: https://graph.facebook.com/v22.0
//   WHATSAPP_ACCESS_TOKEN     — sandbox activation code or Meta token
//   WHATSAPP_PHONE_NUMBER_ID  — sandbox session phone or Meta phone id
//
// Auto-injected by Supabase: SUPABASE_URL, SUPABASE_SERVICE_ROLE_KEY,
// SUPABASE_ANON_KEY (used by requireUser).

import { corsHeaders } from "../_shared/cors.ts";
import { HttpError, jsonResponse, requireUser } from "../_shared/auth.ts";
import { logError } from "../_shared/logError.ts";
import { enqueueFailedMessage } from "../_shared/dlq.ts";
import { sendWhatsAppText } from "../_shared/whatsappSend.ts";

const SOURCE = "whatsapp-send";

interface SendPayload {
  conversation_id: string;
  content: string;
}

function isSendPayload(value: unknown): value is SendPayload {
  if (!value || typeof value !== "object") return false;
  const v = value as Record<string, unknown>;
  return (
    typeof v.conversation_id === "string" &&
    v.conversation_id.length > 0 &&
    typeof v.content === "string" &&
    v.content.trim().length > 0
  );
}

Deno.serve(async (req) => {
  if (req.method === "OPTIONS") {
    return new Response(null, { headers: corsHeaders });
  }
  if (req.method !== "POST") {
    return jsonResponse({ error: "Method not allowed" }, { status: 405, headers: corsHeaders });
  }

  try {
    const apiUrl = Deno.env.get("WHATSAPP_API_URL");
    const accessToken = Deno.env.get("WHATSAPP_ACCESS_TOKEN");
    const phoneId = Deno.env.get("WHATSAPP_PHONE_NUMBER_ID");
    if (!apiUrl || !accessToken || !phoneId) {
      throw new HttpError(500, "HookMyApp env not configured");
    }

    const { admin } = await requireUser(req);

    const body = await req.json().catch(() => null);
    if (!isSendPayload(body)) {
      throw new HttpError(400, "Body must be { conversation_id, content }");
    }
    const content = body.content.trim();

    const { data: conversation, error: convErr } = await admin
      .from("conversations")
      .select("id, lead_phone, agent_id")
      .eq("id", body.conversation_id)
      .maybeSingle();
    if (convErr) {
      await logError({
        admin,
        source: SOURCE,
        errorType: "conversation_lookup_failed",
        message: convErr.message,
        context: { conversationId: body.conversation_id },
      });
      throw new HttpError(500, `Conversation lookup failed: ${convErr.message}`);
    }
    if (!conversation) {
      throw new HttpError(404, "Conversation not found");
    }
    if (!conversation.lead_phone) {
      // Data-integrity defect — surfacing as 422 (not 502) so the
      // dashboard can tell this apart from an upstream gateway issue.
      await logError({
        admin,
        source: SOURCE,
        errorType: "conversation_missing_phone",
        message: "conversation row has null lead_phone",
        context: { conversationId: conversation.id },
        agentId: conversation.agent_id ?? null,
        conversationId: conversation.id,
      });
      throw new HttpError(422, "Conversation has no lead_phone — cannot send");
    }

    const sendResult = await sendWhatsAppText({
      apiUrl,
      accessToken,
      phoneNumberId: phoneId,
      to: conversation.lead_phone,
      body: content,
    });
    if (!sendResult.ok) {
      await logError({
        admin,
        source: SOURCE,
        errorType: "hookmyapp_send_failed",
        message: `send failed status=${sendResult.status} attempts=${sendResult.attempts} terminal=${sendResult.terminal}`,
        context: {
          status: sendResult.status,
          attempts: sendResult.attempts,
          terminal: sendResult.terminal,
          errorBody: sendResult.errorBody,
        },
        agentId: conversation.agent_id ?? null,
        conversationId: conversation.id,
      });
      await enqueueFailedMessage({
        admin,
        source: SOURCE,
        errorType: "hookmyapp_send_failed",
        errorDetail: sendResult.errorBody,
        payload: {
          reply_text: content,
          status: sendResult.status,
          attempts: sendResult.attempts,
          terminal: sendResult.terminal,
          lead_phone: conversation.lead_phone,
        },
        agentId: conversation.agent_id ?? null,
        conversationId: conversation.id,
      });
      // 4xx (non-429) → terminal: caller error or upstream rejection;
      // surface 401/403 as-is. Everything else maps to 502. Raw
      // upstream body is in error_logs, not in this response.
      const status = sendResult.terminal &&
          (sendResult.status === 401 || sendResult.status === 403)
        ? sendResult.status
        : 502;
      throw new HttpError(
        status,
        `WhatsApp send failed (status ${sendResult.status}, attempts=${sendResult.attempts}). Check error_logs for details.`,
      );
    }

    const ts = new Date().toISOString();
    const { data: inserted, error: insertErr } = await admin
      .from("messages")
      .insert({
        conversation_id: conversation.id,
        direction: "outbound",
        message_type: "text",
        content,
        timestamp: ts,
        meta_message_id: sendResult.metaMessageId,
      })
      .select("*")
      .single();
    if (insertErr || !inserted) {
      // Send went out but row insert failed — the lead got the message,
      // we just don't have the dashboard record. Log + DLQ so an operator
      // can reconcile manually. Return 200 with a warning so the UI
      // doesn't show "send failed" (because it didn't).
      await logError({
        admin,
        source: SOURCE,
        errorType: "send_succeeded_insert_failed",
        message: insertErr?.message ?? "insert returned no row",
        context: {
          metaMessageId: sendResult.metaMessageId,
          dbCode: insertErr?.code ?? null,
        },
        agentId: conversation.agent_id ?? null,
        conversationId: conversation.id,
      });
      await enqueueFailedMessage({
        admin,
        source: SOURCE,
        errorType: "send_succeeded_insert_failed",
        errorDetail: insertErr?.message ?? "insert returned no row",
        payload: {
          reply_text: content,
          meta_message_id: sendResult.metaMessageId,
          lead_phone: conversation.lead_phone,
          db_code: insertErr?.code ?? null,
        },
        agentId: conversation.agent_id ?? null,
        conversationId: conversation.id,
      });
      return jsonResponse(
        {
          warning: "Message sent but DB insert failed — recovery enqueued in failed_messages",
          error: insertErr?.message ?? null,
          meta_message_id: sendResult.metaMessageId,
        },
        { status: 200, headers: corsHeaders },
      );
    }

    const { error: updErr } = await admin
      .from("conversations")
      .update({ last_interaction_at: ts })
      .eq("id", conversation.id);
    if (updErr) {
      await logError({
        admin,
        source: SOURCE,
        errorType: "conversation_update_failed",
        message: updErr.message,
        context: { dbCode: updErr.code ?? null },
        agentId: conversation.agent_id ?? null,
        conversationId: conversation.id,
      });
      // Not lead-facing damage — don't fail the response.
    }

    return jsonResponse(inserted, { status: 200, headers: corsHeaders });
  } catch (err) {
    if (err instanceof HttpError) {
      return jsonResponse({ error: err.message }, { status: err.status, headers: corsHeaders });
    }
    // Last-ditch: we may not have an admin client (requireUser threw) so
    // fall back to console only. Use a generic user-facing message; the
    // raw err is only in the server log.
    console.error("whatsapp-send: unexpected error", err);
    return jsonResponse(
      { error: "Internal server error" },
      { status: 500, headers: corsHeaders },
    );
  }
});
