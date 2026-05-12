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
//   2. Parse Meta-format payload, upsert conversation by (agent, lead_phone)
//      using the conversations_agent_phone_unique index (migration 0010),
//      insert inbound message rows (idempotent via meta_message_id).
//   3. Fire-and-forget per touched conversation: load active prompt + last
//      30 messages → call Claude → validate reply → send via HookMyApp
//      with retry → insert outbound row (with Meta wamid). Runs via
//      EdgeRuntime.waitUntil so the webhook returns 200 immediately
//      (no HookMyApp/Cloudflare timeout).
//
// Failure handling (Phase A):
//   - Every failure path calls logError(error_logs) and, where the lead
//     was supposed to receive a reply but won't, enqueueFailedMessage
//     (failed_messages DLQ). The dashboard reads both.
//   - Duplicate inbound deliveries are detected by the partial unique
//     index on messages.meta_message_id and treated as a no-op skip —
//     the agent loop is NOT triggered for a duplicate.
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

import { createClient, type SupabaseClient } from "https://esm.sh/@supabase/supabase-js@2.45.4";
import Anthropic from "https://esm.sh/@anthropic-ai/sdk@0.88.0";

import { logError } from "../_shared/logError.ts";
import { enqueueFailedMessage } from "../_shared/dlq.ts";
import { sendWhatsAppText, type SendResult } from "../_shared/whatsappSend.ts";
import { validateAgentReply } from "../_shared/validateAgentReply.ts";

const SOURCE = "whatsapp-webhook";
const AGENT_LOOP_SOURCE = "agent-loop";
const POSTGRES_UNIQUE_VIOLATION = "23505";
const HISTORY_LIMIT = 30;

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

interface AnthropicContentBlock {
  type: string;
  text?: unknown;
}
interface AnthropicMessageResponse {
  content: ReadonlyArray<AnthropicContentBlock>;
  usage?: { input_tokens?: number; output_tokens?: number };
}

interface HistoryRow {
  direction: "inbound" | "outbound";
  content: string | null;
}

function timingSafeEqual(a: string, b: string): boolean {
  // Constant-time XOR over the longer of the two strings so we don't
  // leak which length differed. Charcodes beyond a string's length are
  // taken as 0xFFFF — guaranteed to differ from any real ASCII char.
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

function extractFirstTextBlock(response: AnthropicMessageResponse): string | null {
  const block = response.content.find((b) => b.type === "text");
  if (!block || typeof block.text !== "string") return null;
  return block.text;
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

interface AgentTurnContext {
  promptContent: string;
  promptVersion: string;
  claudeMessages: Array<{ role: "user" | "assistant"; content: string }>;
}

/**
 * Record both a structured error AND a DLQ entry. Use whenever a failure
 * means a lead is owed a reply they won't get — the operator needs both
 * the searchable log (error_logs) and the recoverable queue entry
 * (failed_messages).
 */
async function logAndDlq(
  ctx: AgentLoopCtx,
  errorType: string,
  message: string,
  errorDetail: string | null,
  payload: Record<string, unknown>,
): Promise<void> {
  await logError({
    admin: ctx.admin,
    source: AGENT_LOOP_SOURCE,
    errorType,
    message,
    context: payload,
    agentId: ctx.agentId,
    conversationId: ctx.conversationId,
  });
  await enqueueFailedMessage({
    admin: ctx.admin,
    source: AGENT_LOOP_SOURCE,
    errorType,
    errorDetail,
    payload,
    agentId: ctx.agentId,
    conversationId: ctx.conversationId,
  });
}

/**
 * Load the active prompt and recent message history, build the Claude
 * messages array, and decide whether the agent should reply now.
 *
 * Returns null and (where appropriate) enqueues a DLQ entry whenever the
 * agent must skip — operator gets a recovery path for transient DB
 * failures, no silent drops.
 */
async function loadAgentTurnContext(
  ctx: AgentLoopCtx,
): Promise<AgentTurnContext | null> {
  const { data: prompt, error: promptErr } = await ctx.admin
    .from("prompts")
    .select("content, version")
    .eq("agent_id", ctx.agentId)
    .eq("is_active", true)
    .order("created_at", { ascending: false })
    .limit(1)
    .maybeSingle();
  if (promptErr || !prompt) {
    await logAndDlq(
      ctx,
      "missing_active_prompt",
      promptErr?.message ?? "no active prompt row for agent",
      promptErr?.message ?? null,
      { lead_phone: ctx.leadPhone, has_db_error: !!promptErr },
    );
    return null;
  }
  if (typeof prompt.content !== "string" || prompt.content.length === 0 ||
      typeof prompt.version !== "string" || prompt.version.length === 0) {
    await logAndDlq(
      ctx,
      "prompt_content_missing",
      "active prompt row has empty content or version",
      null,
      { lead_phone: ctx.leadPhone, has_content: typeof prompt.content === "string", has_version: typeof prompt.version === "string" },
    );
    return null;
  }

  // Fetch newest 30 first then reverse → chronological. `ascending: true`
  // with limit returned the OLDEST 30, which is exactly wrong for a chat
  // bot: at >30 turns the model lost all recent context. (Fixed here.)
  const { data: history, error: histErr } = await ctx.admin
    .from("messages")
    .select("direction, content")
    .eq("conversation_id", ctx.conversationId)
    .order("timestamp", { ascending: false })
    .limit(HISTORY_LIMIT)
    .returns<HistoryRow[]>();
  if (histErr || !history || history.length === 0) {
    await logAndDlq(
      ctx,
      "history_load_failed",
      histErr?.message ?? "empty history for conversation",
      histErr?.message ?? null,
      { lead_phone: ctx.leadPhone, has_db_error: !!histErr },
    );
    return null;
  }

  const orderedHistory = history.slice().reverse();
  const claudeMessages: Array<{ role: "user" | "assistant"; content: string }> = [];
  for (const row of orderedHistory) {
    const text = row.content?.trim();
    if (!text) continue;
    claudeMessages.push({
      role: row.direction === "inbound" ? "user" : "assistant",
      content: text,
    });
  }

  // The agent only speaks when the user spoke last. If we somehow ended
  // on an assistant turn (race / replay), don't reply again.
  const last = claudeMessages[claudeMessages.length - 1];
  if (!last || last.role !== "user") return null;

  return {
    promptContent: prompt.content,
    promptVersion: prompt.version,
    claudeMessages,
  };
}

/**
 * Insert the outbound row after a successful send. Failure here is a
 * "delivered but not recorded" situation — the lead saw the reply but
 * the dashboard won't, so we DLQ it for manual reconciliation. Always
 * update the conversation's last_interaction_at so it sorts correctly.
 */
async function recordOutbound(
  ctx: AgentLoopCtx,
  replyText: string,
  metaMessageId: string | null,
  promptVersion: string,
): Promise<void> {
  const ts = new Date().toISOString();
  const { error: insErr } = await ctx.admin.from("messages").insert({
    conversation_id: ctx.conversationId,
    direction: "outbound",
    message_type: "text",
    content: replyText,
    timestamp: ts,
    meta_message_id: metaMessageId,
  });
  if (insErr) {
    await logAndDlq(
      ctx,
      "send_succeeded_insert_failed",
      insErr.message,
      insErr.message,
      {
        reply_text: replyText,
        meta_message_id: metaMessageId,
        prompt_version: promptVersion,
        lead_phone: ctx.leadPhone,
        db_code: insErr.code ?? null,
      },
    );
  }
  const { error: updErr } = await ctx.admin
    .from("conversations")
    .update({ last_interaction_at: ts, prompt_version_used: promptVersion })
    .eq("id", ctx.conversationId);
  if (updErr) {
    // Not lead-facing damage — log only, no DLQ entry needed.
    await logError({
      admin: ctx.admin,
      source: AGENT_LOOP_SOURCE,
      errorType: "conversation_update_failed",
      message: updErr.message,
      context: { dbCode: updErr.code ?? null, promptVersion },
      agentId: ctx.agentId,
      conversationId: ctx.conversationId,
    });
  }
}

/**
 * Send the validated reply via HookMyApp (with retry) and record the
 * outbound row on success. On failure: log + DLQ so the operator can
 * recover.
 */
async function sendAndRecordReply(
  ctx: AgentLoopCtx,
  replyText: string,
  promptVersion: string,
): Promise<void> {
  const sendResult: SendResult = await sendWhatsAppText({
    apiUrl: ctx.hookmyapp.apiUrl,
    accessToken: ctx.hookmyapp.accessToken,
    phoneNumberId: ctx.hookmyapp.phoneNumberId,
    to: ctx.leadPhone,
    body: replyText,
  });
  if (!sendResult.ok) {
    await logAndDlq(
      ctx,
      "hookmyapp_send_failed",
      `send failed status=${sendResult.status} attempts=${sendResult.attempts} terminal=${sendResult.terminal}`,
      sendResult.errorBody,
      {
        reply_text: replyText,
        status: sendResult.status,
        attempts: sendResult.attempts,
        terminal: sendResult.terminal,
        prompt_version: promptVersion,
        lead_phone: ctx.leadPhone,
      },
    );
    return;
  }
  await recordOutbound(ctx, replyText, sendResult.metaMessageId, promptVersion);
}

/**
 * One AI turn: load prompt + history, call Claude, validate the reply,
 * send via HookMyApp (with retry), insert outbound. Every failure is
 * recorded in error_logs + (where relevant) failed_messages so the
 * dashboard surface picks it up.
 *
 * This function NEVER throws — it's called inside fireAndForget and an
 * unhandled rejection there would just go to console.
 */
async function generateAndSendAgentResponse(ctx: AgentLoopCtx): Promise<void> {
  const turn = await loadAgentTurnContext(ctx);
  if (!turn) return;

  let response: AnthropicMessageResponse;
  try {
    const raw = await ctx.anthropic.messages.create({
      model: "claude-sonnet-4-6",
      max_tokens: 1024,
      thinking: { type: "adaptive" },
      system: turn.promptContent,
      messages: turn.claudeMessages,
    });
    response = raw as unknown as AnthropicMessageResponse;
  } catch (err) {
    await logAndDlq(
      ctx,
      "claude_api_error",
      err instanceof Error ? err.message : String(err),
      err instanceof Error ? err.message : String(err),
      {
        model: "claude-sonnet-4-6",
        prompt_version: turn.promptVersion,
        lead_phone: ctx.leadPhone,
      },
    );
    return;
  }

  const rawReply = extractFirstTextBlock(response);
  const validation = validateAgentReply(rawReply);
  if (!validation.ok) {
    await logAndDlq(
      ctx,
      "claude_invalid_reply",
      `validation failed: ${validation.reason}`,
      validation.reason,
      {
        raw_reply: rawReply,
        reason: validation.reason,
        raw_length: rawReply?.length ?? 0,
        prompt_version: turn.promptVersion,
        lead_phone: ctx.leadPhone,
      },
    );
    return;
  }

  await sendAndRecordReply(ctx, validation.text, turn.promptVersion);
}

interface EdgeRuntimeShape {
  waitUntil(p: Promise<unknown>): void;
}

function fireAndForget(promise: Promise<void>): void {
  const wrapped = promise.catch((err) =>
    console.error("background task crashed", err instanceof Error ? err.message : err)
  );
  const runtime = (globalThis as { EdgeRuntime?: EdgeRuntimeShape }).EdgeRuntime;
  if (runtime && typeof runtime.waitUntil === "function") {
    runtime.waitUntil(wrapped);
  }
  // Without waitUntil the promise still resolves; we just don't extend the
  // function's lifetime. Supabase Edge runtime exposes waitUntil today.
}

interface InboundOutcome {
  needsAgentReply: boolean;
  conversationId: string;
  leadPhone: string;
}

/**
 * Persist a single inbound message. Returns whether the agent loop should
 * run for this conversation. Returns null on hard failure (logged).
 *
 * Idempotent: if the same Meta message id arrives twice, the second
 * insert hits the partial unique index (23505) and we treat it as a
 * no-op skip — the agent does not reply twice. Conversation creation is
 * race-safe via the unique index on (agent_id, lead_phone) + upsert
 * (migration 0010).
 */
async function ingestInboundMessage(
  admin: SupabaseClient,
  agentId: string,
  contacts: ReadonlyArray<MetaContact>,
  message: MetaMessage,
): Promise<InboundOutcome | null> {
  const phone = message.from;
  if (!phone) return null;

  const ts = metaTimestampToIso(message.timestamp);
  const leadName = contacts.find((c) => c.wa_id === phone)?.profile?.name ?? null;

  // Race-safe conversation upsert. Concurrent webhook deliveries for the
  // same new lead can both hit this — the unique index resolves the
  // conflict and only one row is created.
  const { data: upserted, error: upsertErr } = await admin
    .from("conversations")
    .upsert(
      {
        agent_id: agentId,
        lead_phone: phone,
        lead_name: leadName,
        status: "active",
        source_funnel: "whatsapp_sandbox",
        last_interaction_at: ts,
      },
      { onConflict: "agent_id,lead_phone", ignoreDuplicates: false },
    )
    .select("id")
    .single();
  if (upsertErr || !upserted) {
    await logError({
      admin,
      source: SOURCE,
      errorType: "conversation_upsert_failed",
      message: upsertErr?.message ?? "conversation upsert returned no row",
      context: { phone, agentId, dbCode: upsertErr?.code ?? null },
      agentId,
    });
    return null;
  }
  const conversationId = upserted.id as string;

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
    meta_message_id: message.id ?? null,
  });
  if (msgErr) {
    if (msgErr.code === POSTGRES_UNIQUE_VIOLATION) {
      // Webhook retry — already ingested. Log at info level (not an
      // error) and skip the agent loop so we don't double-reply.
      await logError({
        admin,
        source: SOURCE,
        errorType: "duplicate_inbound_skipped",
        level: "info",
        message: `skipped duplicate meta_message_id=${message.id ?? "?"}`,
        context: { metaMessageId: message.id ?? null, phone },
        agentId,
        conversationId,
      });
      return { needsAgentReply: false, conversationId, leadPhone: phone };
    }
    await logError({
      admin,
      source: SOURCE,
      errorType: "inbound_insert_failed",
      message: msgErr.message,
      context: { dbCode: msgErr.code, phone, metaMessageId: message.id ?? null },
      agentId,
      conversationId,
    });
    return null;
  }

  const { error: updErr } = await admin
    .from("conversations")
    .update({ last_interaction_at: ts })
    .eq("id", conversationId);
  if (updErr) {
    await logError({
      admin,
      source: SOURCE,
      errorType: "conversation_update_failed",
      message: updErr.message,
      context: { dbCode: updErr.code ?? null, phone },
      agentId,
      conversationId,
    });
  }

  // Only text triggers the agent — media placeholders ('[image]',
  // '[audio]') carry no semantic content for Claude to respond to yet.
  const needsAgentReply = type === "text" && content.trim().length > 0;
  return { needsAgentReply, conversationId, leadPhone: phone };
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
      headers: { "Content-Type": "text/plain", "Cache-Control": "no-store" },
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
    payload = JSON.parse(rawBody) as MetaPayload;
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
    await logError({
      admin,
      source: SOURCE,
      errorType: "agent_lookup_failed",
      message: agentErr.message,
      context: { agentName },
    });
    return new Response("Agent lookup failed", { status: 500 });
  }
  if (!agent) {
    await logError({
      admin,
      source: SOURCE,
      errorType: "agent_not_configured",
      message: `agent "${agentName}" not found`,
      context: { agentName },
    });
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
        const outcome = await ingestInboundMessage(admin, agentId, contacts, message);
        if (outcome?.needsAgentReply) {
          conversationsNeedingReply.set(outcome.conversationId, outcome.leadPhone);
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
    await logError({
      admin,
      source: SOURCE,
      errorType: "agent_loop_disabled_missing_env",
      level: "warn",
      message: "agent loop disabled — missing ANTHROPIC_API_KEY or WHATSAPP_* env",
      context: {
        hasAnthropic: !!anthropicApiKey,
        hasApiUrl: !!whatsappApiUrl,
        hasAccessToken: !!whatsappAccessToken,
        hasPhoneId: !!whatsappPhoneNumberId,
        conversationCount: conversationsNeedingReply.size,
      },
      agentId,
    });
  }

  return new Response(JSON.stringify({ status: "ok" }), {
    status: 200,
    headers: { "Content-Type": "application/json" },
  });
});
