// extractMemory.ts
//
// Runs AFTER the agent sends a reply. Calls Claude a second time in
// JSON mode (assistant prefill technique) and asks it to read the whole
// conversation and return a structured snapshot of what we know about
// the lead so far. The result is upserted into `lead_memory`.
//
// Also drives a simple "escalate to human" rule: if red_flags contains
// "underage" we tag the conversation 'underage'; if any other flag is
// present we tag it 'requires_human'. Terminal tags (zoom_scheduled,
// opted_out) are never overwritten.
//
// Never throws — the lead has already received their reply, this is
// pure analytics. Any failure is recorded via logError.

import type { SupabaseClient } from "https://esm.sh/@supabase/supabase-js@2.45.4";
import Anthropic from "https://esm.sh/@anthropic-ai/sdk@0.88.0";
import { logError } from "./logError.ts";
import { enqueueFailedMessage } from "./dlq.ts";
import {
  buildHandoffPayload,
  fireHandoffWebhook,
  type HandoffConversation,
  type HandoffLeadMemory,
} from "./fireHandoffWebhook.ts";


// Format an ISO timestamp into Asia/Jerusalem date / time / datetime
// strings. Independent of the host timezone — uses Intl with the
// timeZone option so it works the same in Supabase Edge (UTC) and
// any other runtime. Returns three matched formats so Make.com can
// pick whichever fits the target CRM column.
function formatJerusalemTime(iso: string): {
  date: string;
  time: string;
  datetime: string;
} {
  const d = new Date(iso);
  // YYYY-MM-DD — sortable; works as a Fireberry Date field.
  const date = new Intl.DateTimeFormat("en-CA", {
    timeZone: "Asia/Jerusalem",
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
  }).format(d);
  // HH:mm 24-hour.
  const time = new Intl.DateTimeFormat("he-IL", {
    timeZone: "Asia/Jerusalem",
    hour: "2-digit",
    minute: "2-digit",
    hour12: false,
  }).format(d);
  // Hebrew-style "DD/MM/YYYY HH:mm" — drop into a single CRM note.
  const dt = new Intl.DateTimeFormat("he-IL", {
    timeZone: "Asia/Jerusalem",
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
    hour: "2-digit",
    minute: "2-digit",
    hour12: false,
  }).format(d);
  // Intl in "he-IL" returns "DD.MM.YYYY, HH:mm" — normalise the
  // separators so Make.com sees a predictable "DD/MM/YYYY HH:mm".
  const datetime = dt.replace(/\./g, "/").replace(",", "").replace(/\s+/g, " ").trim();
  return { date, time, datetime };
}

export const MEMORY_EXTRACTOR_MODEL = "claude-haiku-4-5";
export const MEMORY_EXTRACTOR_PROMPT_TYPE = "memory_extractor";

const TERMINAL_TAGS: ReadonlySet<string> = new Set([
  "zoom_scheduled",
  "opted_out",
  "ghosted",
]);

const PRIMARY_OBJECTION_VALUES: ReadonlySet<string> = new Set([
  "action",
  "trust",
  "belonging",
  "timing",
  "money",
  "analytical",
  "negative",
  "unknown",
]);

export interface ExtractedMemory {
  q1_age: number | null;
  q2_motivation: string | null;
  q3_dream_change: string | null;
  q4_blocker: string | null;
  q5_urgency: string | null;
  q6_investment: string | null;
  conversation_summary: string | null;
  primary_objection: string | null;
  red_flags: string[];
  notes_for_advisor: string | null;
}

/**
 * Coerce an arbitrary parsed JSON value into the ExtractedMemory shape.
 * Unknown / bad-typed fields collapse to null; this never throws.
 * Returns null only if the input is not an object at all.
 */
export function coerceExtractedMemory(parsed: unknown): ExtractedMemory | null {
  if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) return null;
  const o = parsed as Record<string, unknown>;

  function asTrimmedString(v: unknown): string | null {
    if (typeof v !== "string") return null;
    const t = v.trim();
    return t.length === 0 ? null : t;
  }
  function asPositiveInt(v: unknown): number | null {
    if (typeof v === "number" && Number.isFinite(v) && v > 0 && v < 130) {
      return Math.floor(v);
    }
    if (typeof v === "string") {
      const n = parseInt(v, 10);
      if (Number.isFinite(n) && n > 0 && n < 130) return n;
    }
    return null;
  }
  function asObjection(v: unknown): string | null {
    if (typeof v !== "string") return null;
    return PRIMARY_OBJECTION_VALUES.has(v) ? v : null;
  }
  function asStringArray(v: unknown): string[] {
    if (!Array.isArray(v)) return [];
    const out: string[] = [];
    for (const item of v) {
      if (typeof item === "string") {
        const t = item.trim();
        if (t.length > 0 && out.length < 5) out.push(t);
      }
    }
    return out;
  }

  return {
    q1_age: asPositiveInt(o.q1_age),
    q2_motivation: asTrimmedString(o.q2_motivation),
    q3_dream_change: asTrimmedString(o.q3_dream_change),
    q4_blocker: asTrimmedString(o.q4_blocker),
    q5_urgency: asTrimmedString(o.q5_urgency),
    q6_investment: asTrimmedString(o.q6_investment),
    conversation_summary: asTrimmedString(o.conversation_summary),
    primary_objection: asObjection(o.primary_objection),
    red_flags: asStringArray(o.red_flags),
    notes_for_advisor: asTrimmedString(o.notes_for_advisor),
  };
}

/**
 * Map extracted memory → conversation tag, given the current tag. Returns
 * the tag to write (or null to leave it alone). Terminal tags are
 * never overwritten.
 */
export function decideConversationTag(
  memory: ExtractedMemory,
  currentTag: string | null,
): string | null {
  const flags = memory.red_flags.map((f) => f.toLowerCase());
  // SAFETY OVERRIDE: underage red_flag wins over EVERYTHING including
  // terminal tags. A lead who answered the 5 questions ("done") and got
  // zoom_scheduled can later admit being a minor — we must re-tag so
  // advisors don't reach out. Legal exposure under Israeli consumer law.
  if (flags.some((f) => f.includes("underage"))) return "underage";
  // Other terminal tags otherwise stay (zoom_scheduled / opted_out / ghosted).
  if (currentTag && TERMINAL_TAGS.has(currentTag)) return null;
  if (memory.red_flags.length > 0) return "requires_human";
  return null;
}

export type FunnelStage = "cold" | "mid" | "done";

/**
 * Count of the 5 core qualification questions answered. q6_investment is
 * a bonus signal — it does NOT count towards the "done" trigger, because
 * the agent's brief is to advance based on q1-q5.
 */
function countCoreAnswered(memory: ExtractedMemory): number {
  let n = 0;
  if (memory.q1_age !== null) n++;
  if (memory.q2_motivation !== null) n++;
  if (memory.q3_dream_change !== null) n++;
  if (memory.q4_blocker !== null) n++;
  if (memory.q5_urgency !== null) n++;
  return n;
}

function computeFunnelStage(
  memory: ExtractedMemory,
  currentTag: string | null,
): FunnelStage {
  if (currentTag && TERMINAL_TAGS.has(currentTag)) return "done";
  const answered = countCoreAnswered(memory);
  if (answered >= 5) return "done";
  if (answered >= 1) return "mid";
  return "cold";
}

/**
 * Map extracted memory + current state → funnel stage. Returns the stage
 * to write (or null to leave it alone).
 *
 * Rules:
 *   - `done` is terminal — never downgrade once reached.
 *   - Any terminal tag (zoom_scheduled / opted_out / ghosted) → `done`.
 *   - All 5 core questions answered (q1-q5) → `done` (handoff-ready).
 *   - At least 1 of q1-q5 answered → `mid` (lead is engaged).
 *   - Otherwise → `cold` (initial).
 */
export function decideFunnelStage(
  memory: ExtractedMemory,
  currentTag: string | null,
  currentStage: string | null,
): FunnelStage | null {
  if (currentStage === "done") return null;
  const desired = computeFunnelStage(memory, currentTag);
  return desired === currentStage ? null : desired;
}

// Tags that say "this lead is no longer in the auto-reply funnel" — either
// already handed off, opted out, escalated to human, or under 18.
const NON_HANDOFF_TAGS: ReadonlySet<string> = new Set([
  "zoom_scheduled",
  "opted_out",
  "ghosted",
  "underage",
  "requires_human",
]);

/**
 * True iff this turn is the moment to escalate to an advisor: the lead
 * just answered the 5th core question, has no red flags, and isn't
 * already in a terminal/blocking tag.
 *
 * Caller decides what to do with `true` — assign an advisor, pause the
 * conversation, set `current_tag = zoom_scheduled`. Kept pure so the
 * decision is unit-testable without DB stubs.
 */
export function shouldTriggerZoomHandoff(
  memory: ExtractedMemory,
  currentTag: string | null,
  currentStage: string | null,
  nextStage: FunnelStage | null,
): boolean {
  if (nextStage !== "done") return false;
  if (currentStage === "done") return false;
  if (memory.red_flags.length > 0) return false;
  if (currentTag && NON_HANDOFF_TAGS.has(currentTag)) return false;
  return true;
}

interface AnthropicContentBlock {
  type: string;
  text?: unknown;
}
interface AnthropicMessageResponse {
  content: ReadonlyArray<AnthropicContentBlock>;
}

function extractAssistantTextBlock(response: AnthropicMessageResponse): string | null {
  const block = response.content.find((b) => b.type === "text");
  if (!block || typeof block.text !== "string") return null;
  return block.text;
}

export interface RunMemoryExtractionInput {
  admin: SupabaseClient;
  anthropic: Anthropic;
  agentId: string;
  /** `agents.name` slug — emitted to the handoff webhook so the consumer
   *  can route per-agent without doing a DB lookup. */
  agentName: string;
  conversationId: string;
  /** Same array we passed to the main agent — INCLUDES the assistant reply. */
  claudeMessages: ReadonlyArray<{ role: "user" | "assistant"; content: string }>;
  /** Optional outbound webhook URL fired when a lead transitions to
   *  zoom_scheduled. Missing/empty → handoff event is not announced. */
  handoffWebhookUrl?: string | null;
  /** Optional HMAC-SHA256 shared secret for signing the handoff payload. */
  handoffWebhookSecret?: string | null;
  /** Optional base URL of the dashboard (e.g. https://richer-ai-agents-hub.vercel.app).
   *  When present, the handoff payload's `conversation.dashboard_url` will be set to
   *  `<base>/conversations/<id>` so advisors can click straight into the chat. */
  dashboardBaseUrl?: string | null;
}

/**
 * End-to-end memory extraction. Loads the prompt, calls Claude in JSON
 * mode, upserts the result, sets a conversation tag if needed. Never
 * throws — logs every failure via logError so the operator can see what
 * went wrong from the dashboard.
 */
export async function runMemoryExtraction(input: RunMemoryExtractionInput): Promise<void> {
  // 1. Load the active memory_extractor prompt for the agent.
  const { data: prompt, error: promptErr } = await input.admin
    .from("prompts")
    .select("id, content")
    .eq("agent_id", input.agentId)
    .eq("prompt_type", MEMORY_EXTRACTOR_PROMPT_TYPE)
    .eq("is_active", true)
    .order("created_at", { ascending: false })
    .limit(1)
    .maybeSingle();
  if (promptErr || !prompt || typeof prompt.content !== "string" || prompt.content.length === 0) {
    await logError({
      admin: input.admin,
      source: "memory-extractor",
      errorType: "missing_extractor_prompt",
      level: "warn",
      message: promptErr?.message ?? "no active memory_extractor prompt for agent",
      context: { agentId: input.agentId },
      agentId: input.agentId,
      conversationId: input.conversationId,
    });
    return;
  }

  // 2. Call Claude in JSON mode via assistant prefill. We append a
  //    `{` opening brace to the conversation as the assistant's
  //    pending message, then Claude continues the JSON. Most reliable
  //    way to get pure JSON out of Anthropic without OpenAI-style
  //    response_format.
  const prefillOpen = "{";
  const messagesForExtractor: Array<{ role: "user" | "assistant"; content: string }> = [
    ...input.claudeMessages,
    { role: "assistant", content: prefillOpen },
  ];

  let rawJson: string;
  try {
    const raw = await input.anthropic.messages.create({
      model: MEMORY_EXTRACTOR_MODEL,
      max_tokens: 1024,
      // No thinking — this is a fast structured extraction, not reasoning.
      system: prompt.content as string,
      messages: messagesForExtractor,
    });
    const response = raw as unknown as AnthropicMessageResponse;
    const text = extractAssistantTextBlock(response);
    if (!text) {
      await logError({
        admin: input.admin,
        source: "memory-extractor",
        errorType: "claude_empty_response",
        message: "Claude returned no text block for memory extraction",
        context: { agentId: input.agentId },
        agentId: input.agentId,
        conversationId: input.conversationId,
      });
      return;
    }
    rawJson = prefillOpen + text;
  } catch (err) {
    await logError({
      admin: input.admin,
      source: "memory-extractor",
      errorType: "claude_api_error",
      message: err instanceof Error ? err.message : String(err),
      context: { model: MEMORY_EXTRACTOR_MODEL },
      agentId: input.agentId,
      conversationId: input.conversationId,
    });
    return;
  }

  // 3. Parse + validate. Claude often adds trailing prose; clip to the
  //    last closing brace for robustness.
  const closeIdx = rawJson.lastIndexOf("}");
  const candidate = closeIdx === -1 ? rawJson : rawJson.slice(0, closeIdx + 1);
  let parsed: unknown;
  try {
    parsed = JSON.parse(candidate);
  } catch (parseErr) {
    await logError({
      admin: input.admin,
      source: "memory-extractor",
      errorType: "claude_invalid_json",
      message: parseErr instanceof Error ? parseErr.message : String(parseErr),
      context: { raw_length: rawJson.length, raw_head: rawJson.slice(0, 200) },
      agentId: input.agentId,
      conversationId: input.conversationId,
    });
    return;
  }
  const memory = coerceExtractedMemory(parsed);
  if (!memory) {
    await logError({
      admin: input.admin,
      source: "memory-extractor",
      errorType: "claude_unrecognised_shape",
      message: "Parsed JSON was not an object",
      context: { raw_head: rawJson.slice(0, 200) },
      agentId: input.agentId,
      conversationId: input.conversationId,
    });
    return;
  }

  // 4. Upsert into lead_memory.
  const { error: upsertErr } = await input.admin
    .from("lead_memory")
    .upsert(
      {
        conversation_id: input.conversationId,
        q1_age: memory.q1_age,
        q2_motivation: memory.q2_motivation,
        q3_dream_change: memory.q3_dream_change,
        q4_blocker: memory.q4_blocker,
        q5_urgency: memory.q5_urgency,
        q6_investment: memory.q6_investment,
        conversation_summary: memory.conversation_summary,
        red_flags: memory.red_flags.length > 0 ? memory.red_flags : null,
        notes_for_advisor: memory.notes_for_advisor,
        updated_at: new Date().toISOString(),
      },
      { onConflict: "conversation_id" },
    );
  if (upsertErr) {
    await logError({
      admin: input.admin,
      source: "memory-extractor",
      errorType: "lead_memory_upsert_failed",
      message: upsertErr.message,
      context: { dbCode: upsertErr.code ?? null },
      agentId: input.agentId,
      conversationId: input.conversationId,
    });
    return;
  }

  // 5. Update conversation: primary_objection + (optionally) tag + stage.
  // Also pull the fields the handoff webhook needs so we don't do a 2nd
  // SELECT after the UPDATE on handoff.
  const { data: existing, error: readErr } = await input.admin
    .from("conversations")
    .select(
      "current_tag, funnel_stage, lead_phone, lead_name, source_campaign, source_funnel, created_at",
    )
    .eq("id", input.conversationId)
    .maybeSingle();
  if (readErr) {
    await logError({
      admin: input.admin,
      source: "memory-extractor",
      errorType: "conversation_read_failed",
      message: readErr.message,
      context: {},
      agentId: input.agentId,
      conversationId: input.conversationId,
    });
    return;
  }
  const currentTag = (existing?.current_tag as string | null | undefined) ?? null;
  const currentStage = (existing?.funnel_stage as string | null | undefined) ?? null;
  const nextTag = decideConversationTag(memory, currentTag);
  const nextStage = decideFunnelStage(memory, currentTag, currentStage);
  const handoff = shouldTriggerZoomHandoff(memory, currentTag, currentStage, nextStage);

  const conversationUpdate: Record<string, unknown> = {};
  if (memory.primary_objection) {
    conversationUpdate.primary_objection = memory.primary_objection;
  }
  if (nextTag && nextTag !== currentTag) {
    conversationUpdate.current_tag = nextTag;
  }
  if (nextStage) {
    conversationUpdate.funnel_stage = nextStage;
  }
  if (handoff) {
    // Lead just qualified — pause the auto-reply loop and tag for the
    // operator. Advisor assignment stays a separate concern (manual today;
    // automated when the Calendar/Calendly integration lands).
    conversationUpdate.current_tag = "zoom_scheduled";
    conversationUpdate.status = "paused";
    conversationUpdate.zoom_scheduled_at = new Date().toISOString();
  }
  if (Object.keys(conversationUpdate).length > 0) {
    const { error: updErr } = await input.admin
      .from("conversations")
      .update(conversationUpdate)
      .eq("id", input.conversationId);
    if (updErr) {
      await logError({
        admin: input.admin,
        source: "memory-extractor",
        errorType: "conversation_update_failed",
        message: updErr.message,
        context: { fields: Object.keys(conversationUpdate) },
        agentId: input.agentId,
        conversationId: input.conversationId,
      });
      return;
    }
  }

  // 6. Handoff fan-out webhook. Fires ONCE per lead, on the same turn the
  //    funnel transitions to done. Downstream consumers (Make.com → Mooz,
  //    Fireberry, advisor notifications) all subscribe to the same payload.
  //    Best-effort: a failure here does not roll back the DB update — the
  //    lead is still tagged zoom_scheduled, the operator just gets a DLQ
  //    entry to replay manually.
  if (handoff) {
    const zoomScheduledAt = conversationUpdate.zoom_scheduled_at as string;
    if (!input.handoffWebhookUrl) {
      await logError({
        admin: input.admin,
        source: "memory-extractor",
        errorType: "handoff_webhook_url_missing",
        level: "warn",
        message:
          "lead reached zoom_scheduled but HANDOFF_WEBHOOK_URL is not configured \u2014 downstream automations will not fire",
        context: { conversationId: input.conversationId },
        agentId: input.agentId,
        conversationId: input.conversationId,
      });
    } else {
      const dashboardBase = input.dashboardBaseUrl?.replace(/\/$/, "") ?? null;
      const il = formatJerusalemTime(zoomScheduledAt);
      const handoffConv: HandoffConversation = {
        id: input.conversationId,
        lead_phone: (existing?.lead_phone as string | null | undefined) ?? "",
        lead_name: (existing?.lead_name as string | null | undefined) ?? null,
        status: "paused",
        current_tag: "zoom_scheduled",
        funnel_stage: "done",
        zoom_scheduled_at: zoomScheduledAt,
        qualified_at_il_date: il.date,
        qualified_at_il_time: il.time,
        qualified_at_il_datetime: il.datetime,
        source_campaign: (existing?.source_campaign as string | null | undefined) ?? null,
        source_funnel: (existing?.source_funnel as string | null | undefined) ?? null,
        created_at: (existing?.created_at as string | null | undefined) ?? null,
        dashboard_url: dashboardBase ? `${dashboardBase}/conversations/${input.conversationId}` : null,
      };
      const handoffMem: HandoffLeadMemory = {
        q1_age: memory.q1_age,
        q2_motivation: memory.q2_motivation,
        q3_dream_change: memory.q3_dream_change,
        q4_blocker: memory.q4_blocker,
        q5_urgency: memory.q5_urgency,
        q6_investment: memory.q6_investment,
        conversation_summary: memory.conversation_summary,
        primary_objection: memory.primary_objection,
        red_flags: memory.red_flags,
        notes_for_advisor: memory.notes_for_advisor,
      };
      const payload = buildHandoffPayload({
        agentId: input.agentId,
        agentName: input.agentName,
        conversation: handoffConv,
        leadMemory: handoffMem,
        now: zoomScheduledAt,
      });
      const fireResult = await fireHandoffWebhook({
        url: input.handoffWebhookUrl,
        secret: input.handoffWebhookSecret ?? null,
        payload,
      });
      if (!fireResult.ok) {
        await logError({
          admin: input.admin,
          source: "memory-extractor",
          errorType: "handoff_webhook_failed",
          message: `handoff webhook failed status=${fireResult.status} attempts=${fireResult.attempts} terminal=${fireResult.terminal}`,
          context: {
            status: fireResult.status,
            body: fireResult.errorBody,
            attempts: fireResult.attempts,
            terminal: fireResult.terminal,
          },
          agentId: input.agentId,
          conversationId: input.conversationId,
        });
        await enqueueFailedMessage({
          admin: input.admin,
          source: "memory-extractor",
          errorType: "handoff_webhook_failed",
          errorDetail: fireResult.errorBody,
          payload: payload as unknown as Record<string, unknown>,
          agentId: input.agentId,
          conversationId: input.conversationId,
        });
      }
    }
  }
}
