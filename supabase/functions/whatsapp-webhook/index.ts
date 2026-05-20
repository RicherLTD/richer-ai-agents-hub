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

import { callWithRetry } from "../_shared/anthropicRetry.ts";
import { judgeReply } from "../_shared/judgeReply.ts";
import { transcribeVoiceNote } from "../_shared/transcribeVoice.ts";
import { logError } from "../_shared/logError.ts";
import { enqueueFailedMessage } from "../_shared/dlq.ts";
import { sendWhatsAppText, type SendResult } from "../_shared/whatsappSend.ts";
import { validateAgentReply } from "../_shared/validateAgentReply.ts";
import { runMemoryExtraction } from "../_shared/extractMemory.ts";
import { alertOperators } from "../_shared/alertOperators.ts";
import { isQuietHourNow } from "../_shared/quietHours.ts";
import {
  type AnthropicUsage,
  computeSonnet46Cost,
  Langfuse,
  langfuseFromEnv,
} from "../_shared/langfuse.ts";

const SOURCE = "whatsapp-webhook";
const AGENT_LOOP_SOURCE = "agent-loop";
const POSTGRES_UNIQUE_VIOLATION = "23505";
const HISTORY_LIMIT = 30;
// When the conversation has more than this many message turns, replace
// the older portion with a single "earlier conversation summary" turn
// pulled from lead_memory.conversation_summary (which the memory
// extractor already maintains free of charge). Cuts per-turn cost
// by ~60% on long conversations without losing context quality.
const COMPRESSION_THRESHOLD = 20;
const COMPRESSION_KEEP_RECENT = 10;

type MessageType = "text" | "audio" | "image" | "sticker" | "video" | "document";

interface MetaContact {
  profile?: { name?: string };
  wa_id?: string;
}
interface MetaMediaRef { id?: string; mime_type?: string; }
interface MetaMessage {
  from?: string;
  type?: string;
  text?: { body?: string };
  audio?: MetaMediaRef;
  voice?: MetaMediaRef;
  image?: MetaMediaRef & { caption?: string };
  video?: MetaMediaRef & { caption?: string };
  document?: MetaMediaRef & { caption?: string; filename?: string };
  sticker?: MetaMediaRef;
  id?: string;
  timestamp?: string;
}
interface MetaMetadata {
  display_phone_number?: string;
  phone_number_id?: string;
}
interface MetaStatusError {
  code?: number;
  title?: string;
  message?: string;
  error_data?: { details?: string };
}
interface MetaStatus {
  id?: string;
  status?: string;
  timestamp?: string;
  recipient_id?: string;
  errors?: ReadonlyArray<MetaStatusError>;
}
interface MetaChange {
  field?: string;
  value?: {
    messages?: MetaMessage[];
    contacts?: MetaContact[];
    metadata?: MetaMetadata;
    statuses?: MetaStatus[];
  };
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
  usage?: {
    input_tokens?: number;
    output_tokens?: number;
    cache_read_input_tokens?: number;
    cache_creation_input_tokens?: number;
  };
}

const CLAUDE_MODEL = "claude-sonnet-4-6";

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
  /** `agents.name` slug — emitted on the handoff webhook. */
  agentName: string;
  leadPhone: string;
  anthropic: Anthropic;
  hookmyapp: HookMyAppCreds;
  /** Optional — when present, every Claude turn is traced. */
  langfuse: Langfuse | null;
  /** Optional fan-out webhook fired on zoom_scheduled transition. */
  handoffWebhookUrl: string | null;
  handoffWebhookSecret: string | null;
  /** Optional base URL of the dashboard — when present, the handoff
   *  webhook payload includes a deep link to the conversation. */
  dashboardBaseUrl: string | null;
}

interface AgentTurnContext {
  promptContent: string;
  promptVersion: string;
  /** UUID `prompts.id` — saved on the outbound row for replay/diff. */
  promptVersionId: string;
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
  // Notify operators on WhatsApp so a human can step in immediately.
  // This is best-effort — alertOperators never throws.
  try {
    await alertOperators({
      admin: ctx.admin,
      apiUrl: ctx.hookmyapp.apiUrl,
      accessToken: ctx.hookmyapp.accessToken,
      phoneNumberId: ctx.hookmyapp.phoneNumberId,
      agentId: ctx.agentId,
      conversationId: ctx.conversationId,
      leadPhone: ctx.leadPhone,
      failureType: errorType,
      failureDetail: errorDetail ?? message,
      dashboardBaseUrl: ctx.dashboardBaseUrl,
    });
  } catch (alertErr) {
    console.error(
      `[logAndDlq] alertOperators threw: ${alertErr instanceof Error ? alertErr.message : String(alertErr)}`,
    );
  }
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
    .select("id, content, version")
    .eq("agent_id", ctx.agentId)
    .eq("prompt_type", "main")
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
      typeof prompt.version !== "string" || prompt.version.length === 0 ||
      typeof prompt.id !== "string" || prompt.id.length === 0) {
    await logAndDlq(
      ctx,
      "prompt_content_missing",
      "active prompt row has empty content / version / id",
      null,
      {
        lead_phone: ctx.leadPhone,
        has_content: typeof prompt.content === "string",
        has_version: typeof prompt.version === "string",
        has_id: typeof prompt.id === "string",
      },
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

  // Compression: long conversations get the older portion replaced with
  // the lead_memory.conversation_summary. Free because the memory
  // extractor already populates it after every turn. Cuts tokens by ~60%
  // on conversations > 20 turns.
  let finalMessages = claudeMessages;
  if (claudeMessages.length > COMPRESSION_THRESHOLD) {
    const { data: mem } = await ctx.admin
      .from("lead_memory")
      .select("conversation_summary")
      .eq("conversation_id", ctx.conversationId)
      .maybeSingle();
    const summary = (mem?.conversation_summary as string | null | undefined)?.trim();
    if (summary && summary.length > 50) {
      // Keep the most-recent N turns verbatim so tone + immediate context
      // stay sharp; replace the rest with one summary turn.
      const recent = claudeMessages.slice(-COMPRESSION_KEEP_RECENT);
      // Synthesise an "assistant" turn carrying the summary so the
      // chronology stays consistent (the bot was the last speaker before
      // the compressed history; user came next).
      finalMessages = [
        {
          role: "assistant",
          content: `[סיכום שיחה עד כה]: ${summary}`,
        },
        ...recent,
      ];
    }
  }

  return {
    promptContent: prompt.content,
    promptVersion: prompt.version,
    promptVersionId: prompt.id,
    claudeMessages: finalMessages,
  };
}

interface OutboundTrace {
  metaMessageId: string | null;
  promptVersion: string;
  promptVersionId: string;
  langfuseTraceId: string | null;
  tokensInput: number | null;
  tokensOutput: number | null;
  costUsd: number | null;
  latencyMs: number | null;
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
  trace: OutboundTrace,
): Promise<void> {
  const ts = new Date().toISOString();
  const { error: insErr } = await ctx.admin.from("messages").insert({
    conversation_id: ctx.conversationId,
    direction: "outbound",
    message_type: "text",
    content: replyText,
    timestamp: ts,
    meta_message_id: trace.metaMessageId,
    langfuse_trace_id: trace.langfuseTraceId,
    prompt_version_id: trace.promptVersionId,
    tokens_input: trace.tokensInput,
    tokens_output: trace.tokensOutput,
    tokens_used: trace.tokensInput != null && trace.tokensOutput != null
      ? trace.tokensInput + trace.tokensOutput
      : null,
    cost_usd: trace.costUsd,
    ai_processing_time_ms: trace.latencyMs,
  });
  if (insErr) {
    await logAndDlq(
      ctx,
      "send_succeeded_insert_failed",
      insErr.message,
      insErr.message,
      {
        reply_text: replyText,
        meta_message_id: trace.metaMessageId,
        prompt_version: trace.promptVersion,
        prompt_version_id: trace.promptVersionId,
        langfuse_trace_id: trace.langfuseTraceId,
        lead_phone: ctx.leadPhone,
        db_code: insErr.code ?? null,
      },
    );
  }
  const { error: updErr } = await ctx.admin
    .from("conversations")
    .update({ last_interaction_at: ts, prompt_version_used: trace.promptVersion })
    .eq("id", ctx.conversationId);
  if (updErr) {
    // Not lead-facing damage — log only, no DLQ entry needed.
    await logError({
      admin: ctx.admin,
      source: AGENT_LOOP_SOURCE,
      errorType: "conversation_update_failed",
      message: updErr.message,
      context: { dbCode: updErr.code ?? null, promptVersion: trace.promptVersion },
      agentId: ctx.agentId,
      conversationId: ctx.conversationId,
    });
  }
}

/**
 * Send the validated reply via HookMyApp (with retry) and record the
 * outbound row on success. On failure: log + DLQ so the operator can
 * recover. The trace fields are populated from the Claude turn before
 * we get here, so we still persist them on the outbound row when send
 * succeeds.
 */
async function sendAndRecordReply(
  ctx: AgentLoopCtx,
  replyText: string,
  trace: Omit<OutboundTrace, "metaMessageId">,
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
        prompt_version: trace.promptVersion,
        prompt_version_id: trace.promptVersionId,
        langfuse_trace_id: trace.langfuseTraceId,
        lead_phone: ctx.leadPhone,
      },
    );
    return;
  }
  await recordOutbound(ctx, replyText, {
    ...trace,
    metaMessageId: sendResult.metaMessageId,
  });
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
// Tags that mean "do not auto-reply to this conversation". Either the
// lead has been handed off to a human, opted out, escalated, or is
// underage. The agent loop must skip these even if status='active'.
const BLOCKING_TAGS: ReadonlySet<string> = new Set([
  "zoom_scheduled",
  "opted_out",
  "requires_human",
  "underage",
]);

async function generateAndSendAgentResponse(ctx: AgentLoopCtx): Promise<void> {
  // Atomic per-conversation lock + conversation-status gate. Two failure
  // modes are folded into one UPDATE:
  //
  //   1. Duplicate-reply race: Meta delivers each user message as its own
  //      webhook POST; when a lead fires multiple messages in seconds we
  //      get parallel agent loops. The atomic UPDATE-WHERE means only one
  //      instance claims the lock; the rest see rowCount=0 and bail.
  //
  //   2. Paused conversation: when a lead has been handed off
  //      (current_tag in BLOCKING_TAGS) or the operator paused the row
  //      (status != 'active'), the bot must not reply. Until 2026-05-19
  //      we relied on `status='paused'` alone — but the ingest upsert
  //      silently overwrote that back to 'active' on every inbound, so
  //      pause never stuck. The upsert is fixed in the same PR; this gate
  //      is the defense-in-depth half.
  //
  // We do not include the tag/status filter on the UPDATE itself because
  // `NOT IN (...)` does not match NULL in Postgres — new leads (NULL tag)
  // would be filtered out. Cheaper to claim the lock first, then check
  // tag/status on the returned row, and release if blocked.
  const lockTimeoutAt = new Date(Date.now() - 60_000).toISOString();
  const { data: claim } = await ctx.admin
    .from("conversations")
    .update({ agent_lock_taken_at: new Date().toISOString() })
    .eq("id", ctx.conversationId)
    .eq("status", "active")
    .or(`agent_lock_taken_at.is.null,agent_lock_taken_at.lt.${lockTimeoutAt}`)
    .select("id, current_tag, status");
  if (!claim || claim.length === 0) {
    // Distinguish "lock contention" from "conversation paused" so the
    // operator sees the right reason in error_logs.
    const { data: state } = await ctx.admin
      .from("conversations")
      .select("status, current_tag")
      .eq("id", ctx.conversationId)
      .maybeSingle();
    const status = (state?.status as string | null | undefined) ?? null;
    const tag = (state?.current_tag as string | null | undefined) ?? null;
    if (status !== null && status !== "active") {
      await logError({
        admin: ctx.admin,
        source: AGENT_LOOP_SOURCE,
        errorType: "conversation_paused_skip",
        level: "info",
        message: `conversation paused, agent loop skipped — status=${status} tag=${tag ?? "null"}`,
        context: { status, current_tag: tag, lead_phone: ctx.leadPhone },
        agentId: ctx.agentId,
        conversationId: ctx.conversationId,
      });
    } else {
      await logError({
        admin: ctx.admin,
        source: AGENT_LOOP_SOURCE,
        errorType: "duplicate_reply_skipped",
        level: "info",
        message: "agent lock held by another concurrent webhook delivery — skipping",
        context: { lead_phone: ctx.leadPhone },
        agentId: ctx.agentId,
        conversationId: ctx.conversationId,
      });
    }
    return;
  }

  const claimedTag = (claim[0] as { current_tag?: string | null }).current_tag ?? null;
  if (claimedTag && BLOCKING_TAGS.has(claimedTag)) {
    // Lock was claimed but the conversation is in a blocking tag — release
    // the lock and log the skip. The lock-release path mirrors the finally
    // block below.
    await ctx.admin
      .from("conversations")
      .update({ agent_lock_taken_at: null })
      .eq("id", ctx.conversationId);
    await logError({
      admin: ctx.admin,
      source: AGENT_LOOP_SOURCE,
      errorType: "conversation_tag_blocked_skip",
      level: "info",
      message: `current_tag=${claimedTag} is in BLOCKING_TAGS — agent loop skipped`,
      context: { current_tag: claimedTag, lead_phone: ctx.leadPhone },
      agentId: ctx.agentId,
      conversationId: ctx.conversationId,
    });
    return;
  }

  try {
    await generateAndSendAgentResponseLocked(ctx);
  } finally {
    // Always release the lock — even on error — so the next inbound from
    // this lead is not stuck waiting for the 60s expiry.
    await ctx.admin
      .from("conversations")
      .update({ agent_lock_taken_at: null })
      .eq("id", ctx.conversationId);
  }
}

async function generateAndSendAgentResponseLocked(ctx: AgentLoopCtx): Promise<void> {
  // Quiet-hours check. Operator-configured window in Asia/Jerusalem during
  // which the agent stays silent. Inbound row is already persisted; we
  // just don't generate or send a reply. Operator gets a WhatsApp alert
  // so they can step in if they want — the lead is not forgotten.
  const { data: agentCfg } = await ctx.admin
    .from("agents")
    .select("quiet_hours_start_il, quiet_hours_end_il")
    .eq("id", ctx.agentId)
    .maybeSingle();
  const quietStart = (agentCfg?.quiet_hours_start_il as number | null | undefined) ?? null;
  const quietEnd = (agentCfg?.quiet_hours_end_il as number | null | undefined) ?? null;
  if (isQuietHourNow({ startIl: quietStart, endIl: quietEnd })) {
    // Quiet hours = silent for everyone. The operator explicitly does
    // NOT want WhatsApp alerts during the night — the whole point of
    // quiet hours is the operator's off-time. The inbound is persisted
    // (visible in the dashboard come morning) and the agent simply does
    // not reply. Logged at info level so it shows in error_logs as an
    // audit trail without paging anyone.
    await logError({
      admin: ctx.admin,
      source: AGENT_LOOP_SOURCE,
      errorType: "quiet_hours_skip",
      level: "info",
      message: `agent is in quiet hours (${quietStart}-${quietEnd} IL) — skipping reply (no alerts during quiet hours)`,
      context: { quiet_start_il: quietStart, quiet_end_il: quietEnd, lead_phone: ctx.leadPhone },
      agentId: ctx.agentId,
      conversationId: ctx.conversationId,
    });
    return;
  }

  const turn = await loadAgentTurnContext(ctx);
  if (!turn) return;

  let response: AnthropicMessageResponse;
  const startTime = new Date();
  try {
    const raw = await callWithRetry(
      () =>
        ctx.anthropic.messages.create({
          model: CLAUDE_MODEL,
          // 1024 was too tight once v6/v7 + adaptive-thinking landed —
          // adaptive thinking can use most of the budget on internal
          // reasoning and return an empty visible reply (the Natan
          // claude_invalid_reply / reply_is_null incident at 18:45). 2048
          // gives the model headroom for thinking AND a 1-3 sentence
          // visible response.
          max_tokens: 2048,
          thinking: { type: "adaptive" },
          system: turn.promptContent,
          messages: turn.claudeMessages,
        }),
      {
        maxAttempts: 3,
        baseDelayMs: 1000,
        onRetry: ({ attempt, delayMs, status }) => {
          void logError({
            admin: ctx.admin,
            source: AGENT_LOOP_SOURCE,
            errorType: "anthropic_retry",
            level: "info",
            message: `retry ${attempt} after ${delayMs}ms (status=${status})`,
            context: { attempt, delayMs, status, model: CLAUDE_MODEL },
            agentId: ctx.agentId,
            conversationId: ctx.conversationId,
          });
        },
      },
    );
    response = raw as unknown as AnthropicMessageResponse;
  } catch (err) {
    await logAndDlq(
      ctx,
      "claude_api_error",
      err instanceof Error ? err.message : String(err),
      err instanceof Error ? err.message : String(err),
      {
        model: CLAUDE_MODEL,
        prompt_version: turn.promptVersion,
        prompt_version_id: turn.promptVersionId,
        lead_phone: ctx.leadPhone,
      },
    );
    return;
  }
  const endTime = new Date();

  const usage: AnthropicUsage = {
    inputTokens: response.usage?.input_tokens,
    outputTokens: response.usage?.output_tokens,
    cacheReadTokens: response.usage?.cache_read_input_tokens,
    cacheCreationTokens: response.usage?.cache_creation_input_tokens,
  };
  const costUsd = computeSonnet46Cost(usage);
  const latencyMs = endTime.getTime() - startTime.getTime();

  const rawReply = extractFirstTextBlock(response);
  const validation = validateAgentReply(rawReply);

  // Trace the turn regardless of validation outcome — failed turns are
  // exactly what we want to see in Langfuse so the operator can debug.
  let langfuseTraceId: string | null = null;
  if (ctx.langfuse) {
    langfuseTraceId = await ctx.langfuse.traceAgentTurn(
      {
        agentId: ctx.agentId,
        conversationId: ctx.conversationId,
        leadPhone: ctx.leadPhone,
        promptVersion: turn.promptVersion,
        promptVersionId: turn.promptVersionId,
        model: CLAUDE_MODEL,
        systemPrompt: turn.promptContent,
        claudeMessages: turn.claudeMessages,
        startTime,
        endTime,
        output: validation.ok
          ? validation.text
          : `(invalid: ${validation.reason})`,
        usage,
        failureTag: validation.ok ? undefined : `invalid_${validation.reason}`,
      },
      async (detail) => {
        await logError({
          admin: ctx.admin,
          source: AGENT_LOOP_SOURCE,
          errorType: "langfuse_ingestion_failed",
          level: "warn",
          message: `Langfuse ingestion failed status=${detail.status}`,
          context: {
            status: detail.status,
            body: detail.body,
            prompt_version: turn.promptVersion,
          },
          agentId: ctx.agentId,
          conversationId: ctx.conversationId,
        });
      },
    );
  }

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
        prompt_version_id: turn.promptVersionId,
        langfuse_trace_id: langfuseTraceId,
        cost_usd: costUsd,
        lead_phone: ctx.leadPhone,
      },
    );
    return;
  }

  // Second-layer safety: ask Haiku to judge the reply against semantic
  // rules the regex validator can\'t enforce ("5 אלף בחודש", subtle AI
  // disclosure, income hints without "מובטח"). Degrades open on
  // judge failure so a Haiku outage doesn\'t stop legitimate traffic.
  const verdict = await judgeReply(ctx.anthropic, validation.text, async (msg) => {
    await logError({
      admin: ctx.admin,
      source: AGENT_LOOP_SOURCE,
      errorType: "judge_unavailable",
      level: "warn",
      message: msg,
      context: { prompt_version: turn.promptVersion },
      agentId: ctx.agentId,
      conversationId: ctx.conversationId,
    });
  });
  if (!verdict.ok) {
    await logAndDlq(
      ctx,
      "judge_rejected_reply",
      `Haiku judge rejected: ${verdict.reason}`,
      verdict.reason,
      {
        raw_reply: validation.text,
        judge_reason: verdict.reason,
        judge_tokens_in: verdict.tokensInput,
        judge_tokens_out: verdict.tokensOutput,
        prompt_version: turn.promptVersion,
        prompt_version_id: turn.promptVersionId,
        langfuse_trace_id: langfuseTraceId,
        lead_phone: ctx.leadPhone,
      },
    );
    return;
  }

  await sendAndRecordReply(ctx, validation.text, {
    promptVersion: turn.promptVersion,
    promptVersionId: turn.promptVersionId,
    langfuseTraceId,
    tokensInput: usage.inputTokens ?? null,
    tokensOutput: usage.outputTokens ?? null,
    costUsd,
    latencyMs,
  });

  // Memory extraction runs after the reply has shipped. The lead has
  // already received their message — this is pure analytics + tag
  // routing. Build the history "post-reply" so the extractor sees the
  // full turn including the bot's reply.
  await runMemoryExtraction({
    admin: ctx.admin,
    anthropic: ctx.anthropic,
    agentId: ctx.agentId,
    agentName: ctx.agentName,
    conversationId: ctx.conversationId,
    claudeMessages: [
      ...turn.claudeMessages,
      { role: "assistant", content: validation.text },
    ],
    handoffWebhookUrl: ctx.handoffWebhookUrl,
    handoffWebhookSecret: ctx.handoffWebhookSecret,
    dashboardBaseUrl: ctx.dashboardBaseUrl,
  });
}

const NON_TEXT_CANNED_REPLY = "היי 😊 רק שתדע, אני יותר טוב/ה בטקסט מאשר בקבצי קול. תוכל/י לכתוב לי את זה במקום? תודה!";

/**
 * Send a fixed "please type in text" reply when the lead sends voice /
 * image / sticker / video / document. We DO NOT run Claude for this —
 * it's a constant string. Records as an outbound row so the operator
 * sees it in the dashboard. Never throws; logs to error_logs on failure.
 */
async function sendCannedNonTextReply(
  ctx: { admin: SupabaseClient; hookmyapp: HookMyAppCreds; agentId: string; conversationId: string; leadPhone: string },
): Promise<void> {
  const sendResult = await sendWhatsAppText({
    apiUrl: ctx.hookmyapp.apiUrl,
    accessToken: ctx.hookmyapp.accessToken,
    phoneNumberId: ctx.hookmyapp.phoneNumberId,
    to: ctx.leadPhone,
    body: NON_TEXT_CANNED_REPLY,
  });
  if (!sendResult.ok) {
    await logError({
      admin: ctx.admin,
      source: AGENT_LOOP_SOURCE,
      errorType: "canned_non_text_send_failed",
      level: "warn",
      message: `canned reply send failed status=${sendResult.status}`,
      context: { status: sendResult.status, errorBody: sendResult.errorBody },
      agentId: ctx.agentId,
      conversationId: ctx.conversationId,
    });
    return;
  }
  const ts = new Date().toISOString();
  await ctx.admin.from("messages").insert({
    conversation_id: ctx.conversationId,
    direction: "outbound",
    message_type: "text",
    content: NON_TEXT_CANNED_REPLY,
    timestamp: ts,
    meta_message_id: sendResult.metaMessageId,
  });
  await ctx.admin
    .from("conversations")
    .update({ last_interaction_at: ts })
    .eq("id", ctx.conversationId);
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
  /** Set when the inbound message was non-text (voice / image / sticker /
   *  video / document). We don't run the full agent loop but DO send a
   *  canned reply asking the lead to type — silent bot is the #1 way to
   *  lose Israeli leads who default to voice notes. */
  needsCannedNonTextReply: boolean;
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
interface IngestEnv {
  apiUrl: string | undefined;
  accessToken: string | undefined;
  openaiApiKey: string | undefined;
}


/**
 * Process a delivery-status callback from Meta. Outbound messages we ship
 * (template sends from the dispatcher, manual sends from the dashboard)
 * get one of these for each transition: sent → delivered → read, or
 * failed with a Meta error code.
 *
 * Without this handler the system was blind to the "Meta accepted my
 * request but couldn't actually deliver" failure mode — the operator saw
 * the outbound row in the dashboard and assumed it landed, even when Meta
 * had silently rejected the recipient (wrong number, missing opt-in,
 * template-quality throttling, etc).
 */
async function ingestDeliveryStatus(
  admin: SupabaseClient,
  agentId: string,
  status: MetaStatus,
): Promise<void> {
  const wamid = status.id;
  const recipient = status.recipient_id ?? null;
  const statusName = status.status;
  if (!wamid || !statusName) return;

  // Look up our messages row so failures get tied to the right conversation.
  const { data: row } = await admin
    .from("messages")
    .select("conversation_id")
    .eq("meta_message_id", wamid)
    .maybeSingle();
  const conversationId = (row?.conversation_id as string | undefined) ?? null;

  if (statusName === "failed") {
    const firstError = status.errors?.[0];
    await logError({
      admin,
      source: "whatsapp-status-callback",
      errorType: "meta_delivery_failed",
      message: `Meta delivery failed — code=${firstError?.code ?? "?"} title="${firstError?.title ?? ""}"`,
      context: {
        wamid,
        recipient,
        meta_error_code: firstError?.code,
        meta_error_title: firstError?.title,
        meta_error_message: firstError?.message,
        meta_error_details: firstError?.error_data?.details,
      },
      agentId,
      conversationId,
    });
    return;
  }

  // Non-failure status — log at info so we have an audit trail.
  await logError({
    admin,
    source: "whatsapp-status-callback",
    errorType: `meta_status_${statusName}`,
    level: "info",
    message: `Meta status: ${statusName} for ${recipient ?? "unknown"}`,
    context: { wamid, recipient, status: statusName, ts: status.timestamp },
    agentId,
    conversationId,
  });
}

async function ingestInboundMessage(
  admin: SupabaseClient,
  agentId: string,
  contacts: ReadonlyArray<MetaContact>,
  message: MetaMessage,
  envForTranscription: IngestEnv,
): Promise<InboundOutcome | null> {
  const phone = message.from;
  if (!phone) return null;

  const ts = metaTimestampToIso(message.timestamp);
  const leadName = contacts.find((c) => c.wa_id === phone)?.profile?.name ?? null;

  // Race-safe ensure-conversation. We used to `.upsert(...)` with
  // status='active' + source_funnel='whatsapp_sandbox' in the same payload,
  // but Supabase's upsert applies those fields on BOTH insert and update
  // paths — which silently resurrected paused conversations and rewrote
  // first-touch attribution on every inbound message. The handoff bug of
  // 2026-05-19 (lead tagged zoom_scheduled but bot kept replying) traced
  // back to that overwrite.
  //
  // Pattern now: UPDATE first (hot path — lead already exists), INSERT only
  // if UPDATE matched zero rows. Concurrency on brand-new leads is handled
  // by catching the unique-violation (23505) and falling back to UPDATE.
  // On UPDATE we touch only `lead_name` and `last_interaction_at`; `status`
  // and `source_funnel` are insert-once and never overwritten.
  const safeUpdates: Record<string, unknown> = { last_interaction_at: ts };
  if (leadName) safeUpdates.lead_name = leadName;
  const { data: updatedRows, error: updErr } = await admin
    .from("conversations")
    .update(safeUpdates)
    .eq("agent_id", agentId)
    .eq("lead_phone", phone)
    .select("id");
  if (updErr) {
    await logError({
      admin,
      source: SOURCE,
      errorType: "conversation_update_failed",
      message: updErr.message,
      context: { phone, agentId, dbCode: updErr.code ?? null },
      agentId,
    });
    return null;
  }
  let conversationId: string | null = updatedRows && updatedRows.length > 0
    ? (updatedRows[0].id as string)
    : null;
  if (!conversationId) {
    const { data: inserted, error: insErr } = await admin
      .from("conversations")
      .insert({
        agent_id: agentId,
        lead_phone: phone,
        lead_name: leadName,
        source_funnel: "whatsapp_sandbox",
        last_interaction_at: ts,
        // status omitted on purpose — column default ('active') applies.
      })
      .select("id")
      .maybeSingle();
    if (insErr?.code === "23505") {
      // Concurrent webhook for the same brand-new lead inserted first.
      // Re-run UPDATE so our last_interaction_at lands on the winning row.
      const { data: raced, error: racedErr } = await admin
        .from("conversations")
        .update(safeUpdates)
        .eq("agent_id", agentId)
        .eq("lead_phone", phone)
        .select("id")
        .maybeSingle();
      if (racedErr || !raced) {
        await logError({
          admin,
          source: SOURCE,
          errorType: "conversation_race_recovery_failed",
          message: racedErr?.message ?? "conflict but no row visible on re-read",
          context: { phone, agentId, dbCode: racedErr?.code ?? null },
          agentId,
        });
        return null;
      }
      conversationId = raced.id as string;
    } else if (insErr || !inserted) {
      await logError({
        admin,
        source: SOURCE,
        errorType: "conversation_insert_failed",
        message: insErr?.message ?? "insert returned no row",
        context: { phone, agentId, dbCode: insErr?.code ?? null },
        agentId,
      });
      return null;
    } else {
      conversationId = inserted.id as string;
    }
  }
  if (!conversationId) {
    // Defensive — every path above either sets conversationId or returns null.
    return null;
  }

  const rawType = normaliseType(message.type);
  let type: MessageType = rawType;
  let content: string;
  if (rawType === "text") {
    content = message.text?.body ?? "";
  } else if (
    (rawType === "audio" || message.type === "voice") &&
    envForTranscription.apiUrl &&
    envForTranscription.accessToken &&
    envForTranscription.openaiApiKey
  ) {
    // Voice note: try Whisper Hebrew transcription. On success we treat
    // the message as a text turn — the agent loop replies as if the lead
    // typed the words. On failure we fall through to the placeholder and
    // the canned "please type" reply.
    const mediaId = message.audio?.id ?? message.voice?.id;
    let transcript: string | null = null;
    if (mediaId) {
      transcript = await transcribeVoiceNote({
        mediaId,
        apiUrl: envForTranscription.apiUrl,
        accessToken: envForTranscription.accessToken,
        openaiApiKey: envForTranscription.openaiApiKey,
      });
    }
    if (transcript && transcript.length >= 2) {
      content = transcript;
      type = "text"; // override so the agent loop treats it as text
    } else {
      content = `[${message.type ?? "audio"}]`;
    }
  } else {
    content = `[${message.type ?? "unknown"}]`;
  }

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
      return { needsAgentReply: false, needsCannedNonTextReply: false, conversationId, leadPhone: phone };
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

  // Update both last_interaction_at (any message — used for chronological
  // sort) and last_inbound_at (lead-only — used by the 5-status display
  // taxonomy to detect "טמפלייט נשלח" vs "שיחה נפתחה" and the 48h
  // auto-close rule for "שיחה סגורה").
  const { error: updErr } = await admin
    .from("conversations")
    .update({ last_interaction_at: ts, last_inbound_at: ts })
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

  // Only text triggers the full agent loop. For non-text we'll send a
  // canned "please type" reply elsewhere — never leave the lead with
  // silence.
  const needsAgentReply = type === "text" && content.trim().length > 0;
  const needsCannedNonTextReply = type !== "text";
  return { needsAgentReply, needsCannedNonTextReply, conversationId, leadPhone: phone };
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

  // GET verification — Meta Cloud API style only:
  //   ?hub.mode=subscribe&hub.verify_token=X&hub.challenge=Y
  // → verify token matches, echo the `hub.challenge` back as the body.
  //
  // We DO NOT echo VERIFY_TOKEN on bare GETs anymore — doing so leaked the
  // HMAC signing secret to any unauthenticated caller, who could then forge
  // valid webhook signatures. If you need the legacy HookMyApp sandbox
  // echo for one-time URL registration, set HOOKMYAPP_SANDBOX_ECHO=true
  // temporarily, then unset.
  if (req.method === "GET") {
    const url = new URL(req.url);
    const challenge = url.searchParams.get("hub.challenge");
    const token = url.searchParams.get("hub.verify_token");

    if (challenge !== null) {
      // The token MUST be present AND match. Earlier version only checked
      // the match when `token !== null`, leaving the door open for a
      // tokenless caller to fish the endpoint and confirm arbitrary
      // challenge values get echoed.
      if (token === null || token !== verifyToken) {
        console.warn("whatsapp-webhook: GET challenge rejected (missing or bad verify_token)");
        return new Response("Forbidden", { status: 403 });
      }
      return new Response(challenge, {
        status: 200,
        headers: { "Content-Type": "text/plain", "Cache-Control": "no-store" },
      });
    }
    if (Deno.env.get("HOOKMYAPP_SANDBOX_ECHO") === "true") {
      return new Response(verifyToken, {
        status: 200,
        headers: { "Content-Type": "text/plain", "Cache-Control": "no-store" },
      });
    }
    return new Response("Method requires hub.challenge", { status: 400 });
  }
  if (req.method !== "POST") {
    return new Response("Method not allowed", { status: 405 });
  }

  const rawBody = await req.text();
  // Accept either header — Meta Cloud API sends `X-Hub-Signature-256`,
  // HookMyApp sandbox sends `X-HookMyApp-Signature-256`. Both are
  // sha256=HEX with the same body, and we treat VERIFY_TOKEN as the
  // shared HMAC secret in both cases.
  //
  // Behaviour on missing/invalid signature: respond 200 but DO NOT
  // process the payload. The HookMyApp setup flow does a "POST
  // verification" ping without a signature and requires a 2xx response
  // for the URL to save. Returning 401 there used to block the
  // configuration step entirely. Real WhatsApp deliveries always
  // include a valid signature; anything without one is dropped here
  // before it can reach the agent loop.
  const signature = req.headers.get("X-Hub-Signature-256")
    || req.headers.get("X-HookMyApp-Signature-256");

  let signatureValid = false;
  if (signature && rawBody) {
    const expected = "sha256=" + (await hmacSha256Hex(verifyToken, rawBody));
    signatureValid = timingSafeEqual(signature, expected);
  }
  if (!signatureValid) {
    if (rawBody) {
      console.warn("whatsapp-webhook: POST without valid signature; payload dropped", {
        bodyLen: rawBody.length,
        hasSignature: !!signature,
      });
    }
    return new Response(JSON.stringify({ status: "ok" }), {
      status: 200,
      headers: { "Content-Type": "application/json" },
    });
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

  // Resolve the agent for this inbound. Order of attempts:
  //   1. By phone_number_id from Meta payload metadata (multi-agent ready).
  //   2. By HOOKMYAPP_AGENT_NAME env (single-agent legacy fallback).
  // If neither matches, log and return 500 — the webhook caller will retry
  // and the operator gets a visible error in the dashboard.
  const inboundPhoneNumberId = payload.entry?.[0]?.changes?.[0]?.value?.metadata
    ?.phone_number_id ?? null;

  let agentId: string | null = null;
  let isPaused = false;
  if (inboundPhoneNumberId) {
    const { data: byPhone } = await admin
      .from("agents")
      .select("id, is_paused")
      .eq("whatsapp_phone_number_id", inboundPhoneNumberId)
      .maybeSingle();
    if (byPhone) {
      agentId = byPhone.id as string;
      isPaused = (byPhone.is_paused as boolean | null) ?? false;
    }
  }
  if (!agentId) {
    const { data: byName, error: agentErr } = await admin
      .from("agents")
      .select("id, is_paused")
      .eq("name", agentName)
      .maybeSingle();
    if (agentErr) {
      await logError({
        admin,
        source: SOURCE,
        errorType: "agent_lookup_failed",
        message: agentErr.message,
        context: { agentName, inboundPhoneNumberId },
      });
      return new Response("Agent lookup failed", { status: 500 });
    }
    if (!byName) {
      await logError({
        admin,
        source: SOURCE,
        errorType: "agent_not_configured",
        message: `no agent matched (phone_number_id=${inboundPhoneNumberId ?? "missing"}, name="${agentName}")`,
        context: { agentName, inboundPhoneNumberId },
      });
      return new Response("Agent not configured", { status: 500 });
    }
    agentId = byName.id as string;
    isPaused = (byName.is_paused as boolean | null) ?? false;
  }

  // Conversations that received an inbound text this webhook → trigger one
  // agent reply per conversation (not per message) to avoid double-replies
  // when a user fires off multiple messages in quick succession.
  const conversationsNeedingReply = new Map<string, string>(); // id → leadPhone
  const conversationsNeedingCannedReply = new Map<string, string>(); // id → leadPhone

  const openaiApiKey = Deno.env.get("OPENAI_API_KEY");
  const ingestEnv: IngestEnv = {
    apiUrl: whatsappApiUrl,
    accessToken: whatsappAccessToken,
    openaiApiKey,
  };

  for (const entry of payload.entry ?? []) {
    for (const change of entry.changes ?? []) {
      if (change.field !== "messages") continue;
      // Outbound delivery status callbacks from Meta — sent / delivered /
      // read / failed. Must process BEFORE inbound messages because the
      // same webhook payload can contain both, and a `failed` status
      // resolves "why didn't this lead get my template" instantly.
      for (const status of (change.value?.statuses ?? []) as ReadonlyArray<MetaStatus>) {
        await ingestDeliveryStatus(admin, agentId, status);
      }
      const contacts = change.value?.contacts ?? [];
      for (const message of change.value?.messages ?? []) {
        const outcome = await ingestInboundMessage(admin, agentId, contacts, message, ingestEnv);
        if (outcome?.needsAgentReply) {
          conversationsNeedingReply.set(outcome.conversationId, outcome.leadPhone);
        } else if (outcome?.needsCannedNonTextReply) {
          conversationsNeedingCannedReply.set(outcome.conversationId, outcome.leadPhone);
        }
      }
    }
  }

  // Kill switch: if the agent is paused, skip the AI loop entirely.
  // Inbound rows are already persisted above so the operator sees them.
  if (isPaused) {
    if (conversationsNeedingReply.size > 0) {
      await logError({
        admin,
        source: SOURCE,
        errorType: "agent_paused_skip",
        level: "info",
        message: `agent is paused — skipping AI loop for ${conversationsNeedingReply.size} conversation(s)`,
        context: { conversationCount: conversationsNeedingReply.size },
        agentId,
      });
    }
    return new Response(JSON.stringify({ status: "ok", paused: true }), {
      status: 200,
      headers: { "Content-Type": "application/json" },
    });
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
    // Langfuse is optional — if env vars are missing we fall through to
    // null and the agent loop runs without tracing.
    const langfuse = langfuseFromEnv();
    const handoffWebhookUrl = Deno.env.get("HANDOFF_WEBHOOK_URL") ?? null;
    const handoffWebhookSecret = Deno.env.get("HANDOFF_WEBHOOK_SECRET") ?? null;
    const dashboardBaseUrl = Deno.env.get("DASHBOARD_BASE_URL") ?? null;
    for (const [conversationId, leadPhone] of conversationsNeedingReply) {
      // Each conversation runs independently; one slow Claude call doesn't
      // block another conversation's reply.
      fireAndForget(
        generateAndSendAgentResponse({
          admin,
          conversationId,
          agentId,
          agentName,
          leadPhone,
          anthropic,
          hookmyapp,
          langfuse,
          handoffWebhookUrl,
          handoffWebhookSecret,
          dashboardBaseUrl,
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

  // Fire canned "please type" replies for non-text inbound (voice notes,
  // images, stickers). No Claude call — just a constant string. Critical:
  // Israeli WhatsApp users default to voice notes; without this reply the
  // bot looks broken to them.
  if (
    conversationsNeedingCannedReply.size > 0 &&
    whatsappApiUrl &&
    whatsappAccessToken &&
    whatsappPhoneNumberId
  ) {
    const hookmyapp: HookMyAppCreds = {
      apiUrl: whatsappApiUrl,
      accessToken: whatsappAccessToken,
      phoneNumberId: whatsappPhoneNumberId,
    };
    for (const [conversationId, leadPhone] of conversationsNeedingCannedReply) {
      fireAndForget(
        sendCannedNonTextReply({ admin, hookmyapp, agentId, conversationId, leadPhone }),
      );
    }
  }

  return new Response(JSON.stringify({ status: "ok" }), {
    status: 200,
    headers: { "Content-Type": "application/json" },
  });
});
