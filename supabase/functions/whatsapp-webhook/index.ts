// whatsapp-webhook/index.ts
//
// Public webhook receiver for HookMyApp + autonomous AI agent loop.
//
// GET  /functions/v1/whatsapp-webhook
//   - Returns VERIFY_TOKEN as the response body (HookMyApp verify
//     challenge when the URL is first registered).
//
// POST /functions/v1/whatsapp-webhook
//   1. Verify HMAC-SHA256 of the raw body against X-HookMyApp-Signature-256.
//   2. Parse Meta-format payload, upsert conversation by (agent, lead_phone),
//      insert inbound message rows.
//   3. Fire-and-forget per touched conversation: load active prompt + last
//      30 messages → call Claude → send reply via HookMyApp → insert
//      outbound row. Runs via EdgeRuntime.waitUntil so the webhook returns
//      200 immediately (no HookMyApp/Cloudflare timeout).
//
// Required env (set as Supabase secrets):
//   VERIFY_TOKEN              - sandbox session HMAC (`hookmyapp sandbox env`)
//   HOOKMYAPP_AGENT_NAME      - agents.name slug to attribute inbound to
//   ANTHROPIC_API_KEY         - sk-ant-... (for the agent loop)
//   WHATSAPP_API_URL          - sandbox: https://sandbox.hookmyapp.com/v22.0
//   WHATSAPP_ACCESS_TOKEN     - sandbox activation code
//   WHATSAPP_PHONE_NUMBER_ID  - sandbox session phone
//
// Auto-injected by Supabase: SUPABASE_URL, SUPABASE_SERVICE_ROLE_KEY.

// deno-lint-ignore-file no-explicit-any
import { createClient, type SupabaseClient } from "https://esm.sh/@supabase/supabase-js@2.45.4";
import Anthropic from "https://esm.sh/@anthropic-ai/sdk@0.88.0";

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

interface HookMyAppCreds {
  apiUrl: string;
  accessToken: string;
  phoneNumberId: string;
}

interface AgentLoopCtx {
  admin: SupabaseClient;
  conversationId: string;
  agentId: string;
  leadPhone: string;
  anthropic: Anthropic;
  hookmyapp: HookMyAppCreds;
}

/**
 * One AI turn: load active prompt + last 30 messages, call Claude, send the
 * reply via HookMyApp, insert outbound row. Bails silently on any failure
 * (errors are logged) so a flaky AI provider can't bring the webhook down.
 */
async function generateAndSendAgentResponse(ctx: AgentLoopCtx): Promise<void> {
  const { data: prompt, error: promptErr } = await ctx.admin
    .from("prompts")
    .select("content, version")
    .eq("agent_id", ctx.agentId)
    .eq("is_active", true)
    .order("created_at", { ascending: false })
    .limit(1)
    .maybeSingle();
  if (promptErr || !prompt) {
    console.error("agent-loop: no active prompt", promptErr);
    return;
  }

  const { data: history, error: histErr } = await ctx.admin
    .from("messages")
    .select("direction, content")
    .eq("conversation_id", ctx.conversationId)
    .order("timestamp", { ascending: true })
    .limit(30);
  if (histErr || !history || history.length === 0) {
    console.error("agent-loop: empty/failed history", histErr);
    return;
  }

  const claudeMessages: Array<{ role: "user" | "assistant"; content: string }> = [];
  for (const m of history) {
    const text = ((m as any).content as string | null)?.trim();
    if (!text) continue;
    claudeMessages.push({
      role: (m as any).direction === "inbound" ? "user" : "assistant",
      content: text,
    });
  }
  // The agent only speaks when the user spoke last. If we somehow ended on an
  // assistant turn (race / replay), don't reply again.
  if (claudeMessages.length === 0 || claudeMessages[claudeMessages.length - 1].role !== "user") {
    return;
  }

  let replyText: string;
  try {
    const response: any = await ctx.anthropic.messages.create({
      model: "claude-sonnet-4-6",
      max_tokens: 1024,
      thinking: { type: "adaptive" },
      system: prompt.content as string,
      messages: claudeMessages,
    });
    const textBlock = response.content.find((b: any) => b.type === "text");
    replyText = textBlock?.text?.trim() ?? "";
    if (!replyText) {
      console.warn("agent-loop: Claude returned no text block");
      return;
    }
  } catch (err) {
    console.error("agent-loop: Claude API error", err);
    return;
  }

  const sendUrl = `${ctx.hookmyapp.apiUrl}/${ctx.hookmyapp.phoneNumberId}/messages`;
  const sendRes = await fetch(sendUrl, {
    method: "POST",
    headers: {
      Authorization: `Bearer ${ctx.hookmyapp.accessToken}`,
      "Content-Type": "application/json",
    },
    body: JSON.stringify({
      messaging_product: "whatsapp",
      to: ctx.leadPhone,
      type: "text",
      text: { body: replyText },
    }),
  });
  if (!sendRes.ok) {
    const errBody = await sendRes.text().catch(() => "");
    console.error("agent-loop: HookMyApp send failed", sendRes.status, errBody);
    return;
  }

  const ts = new Date().toISOString();
  const { error: insErr } = await ctx.admin.from("messages").insert({
    conversation_id: ctx.conversationId,
    direction: "outbound",
    message_type: "text",
    content: replyText,
    timestamp: ts,
  });
  if (insErr) {
    // Send already went through — log loudly but don't retry (would double-send).
    console.error("agent-loop: outbound insert failed (delivered but not recorded)", insErr);
  }
  await ctx.admin
    .from("conversations")
    .update({ last_interaction_at: ts, prompt_version_used: prompt.version })
    .eq("id", ctx.conversationId);
}

function fireAndForget(promise: Promise<void>): void {
  const wrapped = promise.catch((err) => console.error("background task crashed", err));
  const runtime = (globalThis as any).EdgeRuntime;
  if (runtime && typeof runtime.waitUntil === "function") {
    runtime.waitUntil(wrapped);
  }
  // Without waitUntil the promise still resolves; we just don't extend the
  // function's lifetime. Supabase Edge runtime exposes waitUntil today.
}

Deno.serve(async (req) => {
  const verifyToken = Deno.env.get("VERIFY_TOKEN");
  const agentName = Deno.env.get("HOOKMYAPP_AGENT_NAME");
  const supabaseUrl = Deno.env.get("SUPABASE_URL");
  const serviceRoleKey = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY");
  // Optional — AI loop is best-effort. Missing keys disable auto-reply but
  // inbound messages still land in the DB so the dashboard stays usable.
  const anthropicApiKey = Deno.env.get("ANTHROPIC_API_KEY");
  const whatsappApiUrl = Deno.env.get("WHATSAPP_API_URL");
  const whatsappAccessToken = Deno.env.get("WHATSAPP_ACCESS_TOKEN");
  const whatsappPhoneNumberId = Deno.env.get("WHATSAPP_PHONE_NUMBER_ID");

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

  // Conversations that received an inbound text this webhook → trigger one
  // agent reply per conversation (not per message) to avoid double-replies
  // when a user fires off multiple messages in quick succession.
  const conversationsNeedingReply = new Map<string, string>(); // id → leadPhone

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

        // Only text triggers the agent — media placeholders (`[image]`,
        // `[audio]`) carry no semantic content for Claude to respond to yet.
        if (type === "text" && content.trim()) {
          conversationsNeedingReply.set(conversationId, phone);
        }
      }
    }
  }

  // Fire AI replies in the background so we can return 200 to HookMyApp now.
  if (
    conversationsNeedingReply.size > 0 &&
    anthropicApiKey &&
    whatsappApiUrl &&
    whatsappAccessToken &&
    whatsappPhoneNumberId
  ) {
    const anthropic = new Anthropic({ apiKey: anthropicApiKey });
    const hookmyapp: HookMyAppCreds = {
      apiUrl: whatsappApiUrl,
      accessToken: whatsappAccessToken,
      phoneNumberId: whatsappPhoneNumberId,
    };
    for (const [conversationId, leadPhone] of conversationsNeedingReply) {
      // Each conversation runs independently; one slow Claude call doesn't
      // block another conversation's reply.
      fireAndForget(
        generateAndSendAgentResponse({
          admin,
          conversationId,
          agentId,
          leadPhone,
          anthropic,
          hookmyapp,
        }),
      );
    }
  } else if (conversationsNeedingReply.size > 0) {
    console.warn("whatsapp-webhook: agent loop disabled — missing one of ANTHROPIC_API_KEY / WHATSAPP_API_URL / WHATSAPP_ACCESS_TOKEN / WHATSAPP_PHONE_NUMBER_ID");
  }

  return new Response(JSON.stringify({ status: "ok" }), {
    status: 200,
    headers: { "Content-Type": "application/json" },
  });
});
