// whatsapp-send/index.ts
//
// Authenticated edge function that proxies a text message to HookMyApp
// (sandbox or production) and records the outbound row in `messages`.
// Replaces the dashboard's direct insert path: the row only lands in the
// DB if the WhatsApp send succeeded, so no orphan outbound rows.
//
// Request:
//   POST /functions/v1/whatsapp-send
//   Authorization: Bearer <user JWT>
//   { "conversation_id": string, "content": string }
//
// Required secrets (Supabase edge runtime env):
//   HOOKMYAPP_API_URL          — sandbox: https://sandbox.hookmyapp.com/v22.0
//                                production: https://graph.facebook.com/v22.0
//   HOOKMYAPP_ACCESS_TOKEN     — sandbox activation code or Meta token
//   HOOKMYAPP_PHONE_NUMBER_ID  — sandbox session phone or Meta phone id
//
// Auto-injected by Supabase: SUPABASE_URL, SUPABASE_SERVICE_ROLE_KEY,
// SUPABASE_ANON_KEY (used by requireUser).

import { corsHeaders } from "../_shared/cors.ts";
import { HttpError, jsonResponse, requireUser } from "../_shared/auth.ts";

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
    const apiUrl = Deno.env.get("HOOKMYAPP_API_URL");
    const accessToken = Deno.env.get("HOOKMYAPP_ACCESS_TOKEN");
    const phoneId = Deno.env.get("HOOKMYAPP_PHONE_NUMBER_ID");
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
      .select("id, lead_phone")
      .eq("id", body.conversation_id)
      .maybeSingle();
    if (convErr) {
      throw new HttpError(500, `Conversation lookup failed: ${convErr.message}`);
    }
    if (!conversation) {
      throw new HttpError(404, "Conversation not found");
    }

    const sendUrl = `${apiUrl}/${phoneId}/messages`;
    const sendRes = await fetch(sendUrl, {
      method: "POST",
      headers: {
        Authorization: `Bearer ${accessToken}`,
        "Content-Type": "application/json",
      },
      body: JSON.stringify({
        messaging_product: "whatsapp",
        to: conversation.lead_phone,
        type: "text",
        text: { body: content },
      }),
    });
    if (!sendRes.ok) {
      const errBody = await sendRes.text().catch(() => "");
      console.error("whatsapp-send: HookMyApp rejected", sendRes.status, errBody);
      throw new HttpError(
        sendRes.status === 401 || sendRes.status === 403 ? sendRes.status : 502,
        `WhatsApp send failed (${sendRes.status}): ${errBody.slice(0, 200)}`,
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
      })
      .select("*")
      .single();
    if (insertErr || !inserted) {
      // Send went out but row insert failed — log loudly; the human can
      // recover by reading the WhatsApp side. Don't 500 the caller since
      // the message *was* delivered.
      console.error("whatsapp-send: insert after send failed", insertErr);
      return jsonResponse(
        { warning: "Message sent but DB insert failed", error: insertErr?.message ?? null },
        { status: 200, headers: corsHeaders },
      );
    }

    await admin
      .from("conversations")
      .update({ last_interaction_at: ts })
      .eq("id", conversation.id);

    return jsonResponse(inserted, { status: 200, headers: corsHeaders });
  } catch (err) {
    if (err instanceof HttpError) {
      return jsonResponse({ error: err.message }, { status: err.status, headers: corsHeaders });
    }
    console.error("whatsapp-send: unexpected error", err);
    return jsonResponse(
      { error: err instanceof Error ? err.message : "Unknown error" },
      { status: 500, headers: corsHeaders },
    );
  }
});
