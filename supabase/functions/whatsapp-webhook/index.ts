// whatsapp-webhook/index.ts
//
// Public webhook receiver for HookMyApp (sandbox + production share the
// same shape — see AGENTS.md in the webhook-starter-kit). Replaces the
// n8n inbound path while we're in sandbox testing.
//
// GET  /functions/v1/whatsapp-webhook
//   - Returns VERIFY_TOKEN as the response body (HookMyApp verify
//     challenge when the URL is first registered).
//
// POST /functions/v1/whatsapp-webhook
//   - Verifies HMAC-SHA256 of the raw body against
//     X-HookMyApp-Signature-256 (key = VERIFY_TOKEN).
//   - Parses the Meta-format payload, upserts conversation by
//     (agent, lead_phone), inserts inbound message rows.
//
// Required env (set as Supabase secrets, or via --env-file when running
// `bunx supabase functions serve` locally):
//   HOOKMYAPP_VERIFY_TOKEN  — sandbox session HMAC (`hookmyapp sandbox env`)
//   HOOKMYAPP_AGENT_NAME    — agents.name slug to attribute inbound to
//
// Auto-injected by Supabase: SUPABASE_URL, SUPABASE_SERVICE_ROLE_KEY.

// deno-lint-ignore-file no-explicit-any
import { createClient } from "https://esm.sh/@supabase/supabase-js@2.45.4";

type MessageType = "text" | "audio" | "image" | "sticker" | "video" | "document";

interface MetaContact {
  profile?: { name?: string };
  wa_id?: string;
}
interface MetaMessage {
  from?: string;
  type?: string;
  text?: { body?: string };
  id?: string;
  timestamp?: string;
}
interface MetaChange {
  field?: string;
  value?: { messages?: MetaMessage[]; contacts?: MetaContact[] };
}
interface MetaEntry {
  id?: string;
  changes?: MetaChange[];
}
interface MetaPayload {
  object?: string;
  entry?: MetaEntry[];
}

function timingSafeEqual(a: string, b: string): boolean {
  if (a.length !== b.length) return false;
  let diff = 0;
  for (let i = 0; i < a.length; i++) diff |= a.charCodeAt(i) ^ b.charCodeAt(i);
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

const SUPPORTED_TYPES: ReadonlySet<MessageType> = new Set([
  "text",
  "audio",
  "image",
  "sticker",
  "video",
  "document",
]);

function normaliseType(metaType: string | undefined): MessageType {
  return metaType && SUPPORTED_TYPES.has(metaType as MessageType)
    ? (metaType as MessageType)
    : "text";
}

function metaTimestampToIso(ts: string | undefined): string {
  if (!ts) return new Date().toISOString();
  const seconds = parseInt(ts, 10);
  if (Number.isNaN(seconds)) return new Date().toISOString();
  return new Date(seconds * 1000).toISOString();
}

Deno.serve(async (req) => {
  const verifyToken = Deno.env.get("HOOKMYAPP_VERIFY_TOKEN");
  const agentName = Deno.env.get("HOOKMYAPP_AGENT_NAME");
  const supabaseUrl = Deno.env.get("SUPABASE_URL");
  const serviceRoleKey = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY");

  if (!verifyToken || !agentName || !supabaseUrl || !serviceRoleKey) {
    console.error("whatsapp-webhook: missing env", {
      hasToken: !!verifyToken,
      hasAgent: !!agentName,
      hasUrl: !!supabaseUrl,
      hasKey: !!serviceRoleKey,
    });
    return new Response("Server misconfigured", { status: 500 });
  }

  // GET = HookMyApp verification challenge — echo VERIFY_TOKEN.
  if (req.method === "GET") {
    return new Response(verifyToken, {
      status: 200,
      headers: { "Content-Type": "text/plain" },
    });
  }
  if (req.method !== "POST") {
    return new Response("Method not allowed", { status: 405 });
  }

  const rawBody = await req.text();
  const signature = req.headers.get("X-HookMyApp-Signature-256");
  if (!signature) {
    return new Response("Missing signature", { status: 401 });
  }
  const expected = "sha256=" + (await hmacSha256Hex(verifyToken, rawBody));
  if (!timingSafeEqual(signature, expected)) {
    console.warn("whatsapp-webhook: invalid signature");
    return new Response("Invalid signature", { status: 401 });
  }

  let payload: MetaPayload;
  try {
    payload = JSON.parse(rawBody);
  } catch {
    return new Response("Bad JSON", { status: 400 });
  }

  const admin = createClient(supabaseUrl, serviceRoleKey, {
    auth: { persistSession: false, autoRefreshToken: false },
  });

  // Resolve the configured agent (sandbox = single agent).
  const { data: agent, error: agentErr } = await admin
    .from("agents")
    .select("id")
    .eq("name", agentName)
    .maybeSingle();
  if (agentErr) {
    console.error("whatsapp-webhook: agent lookup failed", agentErr);
    return new Response("Agent lookup failed", { status: 500 });
  }
  if (!agent) {
    console.error(`whatsapp-webhook: agent "${agentName}" not found`);
    return new Response("Agent not configured", { status: 500 });
  }
  const agentId = agent.id as string;

  for (const entry of payload.entry ?? []) {
    for (const change of entry.changes ?? []) {
      if (change.field !== "messages") continue;
      const contacts = change.value?.contacts ?? [];
      for (const message of change.value?.messages ?? []) {
        const phone = message.from;
        if (!phone) continue;

        const ts = metaTimestampToIso(message.timestamp);

        const { data: existing, error: findErr } = await admin
          .from("conversations")
          .select("id")
          .eq("agent_id", agentId)
          .eq("lead_phone", phone)
          .maybeSingle();
        if (findErr) {
          console.error("whatsapp-webhook: find conversation failed", findErr);
          continue;
        }

        let conversationId: string | undefined = existing?.id as string | undefined;
        if (!conversationId) {
          const leadName = contacts.find((c) => c.wa_id === phone)?.profile?.name ?? null;
          const { data: created, error: insertErr } = await admin
            .from("conversations")
            .insert({
              agent_id: agentId,
              lead_phone: phone,
              lead_name: leadName,
              status: "active",
              source_funnel: "whatsapp_sandbox",
              last_interaction_at: ts,
            })
            .select("id")
            .single();
          if (insertErr || !created) {
            console.error("whatsapp-webhook: create conversation failed", insertErr);
            continue;
          }
          conversationId = created.id as string;
        }

        const type = normaliseType(message.type);
        const content = type === "text"
          ? message.text?.body ?? ""
          : `[${message.type ?? "unknown"}]`;

        const { error: msgErr } = await admin.from("messages").insert({
          conversation_id: conversationId,
          direction: "inbound",
          message_type: type,
          content,
          timestamp: ts,
        });
        if (msgErr) {
          console.error("whatsapp-webhook: insert message failed", msgErr);
          continue;
        }

        await admin
          .from("conversations")
          .update({ last_interaction_at: ts })
          .eq("id", conversationId);
      }
    }
  }

  return new Response(JSON.stringify({ status: "ok" }), {
    status: 200,
    headers: { "Content-Type": "application/json" },
  });
});
