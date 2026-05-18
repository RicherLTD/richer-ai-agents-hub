// prompt-coach/index.ts
//
// Admin-facing AI Coach — a second Claude call that helps the operator
// improve the BOT's main prompt. The Coach is NOT the bot: it never
// talks to a lead. It only converses with admins (Kfir, Yitzhak), reads
// the current prompt and recent conversations, and proposes a full
// replacement of the prompt when the admin asks for a change.
//
// Flow per chat turn:
//   1. Admin POSTs { agent_id, user_message, referenced_conversation_id? }
//   2. We store the admin's message in coach_messages.
//   3. We load: current main prompt, last 20 coach turns (history),
//      and — if referenced — the lead conversation + lead_memory.
//   4. We call Claude Sonnet 4.6 with a Coach system prompt + tool
//      `propose_prompt_edit`. Tool use is the SIGNAL to the UI that
//      "I want to change the prompt — here is the new full text".
//   5. We store the assistant's reply (text + optional proposal) in
//      coach_messages and return it to the caller.
//
// The Coach NEVER mutates the prompts table directly. The admin must
// click "apply" in the UI, which calls `prompt-coach-apply` — that's
// the only path that touches prod prompts.
//
// Requires `ANTHROPIC_API_KEY` Supabase secret. Admin-only (requireAdmin).

import { createClient, type SupabaseClient } from "https://esm.sh/@supabase/supabase-js@2.45.4";
import Anthropic from "https://esm.sh/@anthropic-ai/sdk@0.88.0";

import { HttpError, jsonResponse, requireAdmin } from "../_shared/auth.ts";
import {
  type BrainRow,
  buildBrainSection,
  loadBrainRows,
} from "../_shared/brainContext.ts";
import { corsHeaders } from "../_shared/cors.ts";
import { logError } from "../_shared/logError.ts";
import { isUuid } from "../_shared/validation.ts";

const SOURCE = "prompt-coach";
const COACH_MODEL = "claude-sonnet-4-6";
const MAX_HISTORY_TURNS = 20;
const MAX_CONVERSATION_MESSAGES = 30;
const MAIN_PROMPT_TYPE = "main";

// ---------- request body ----------

interface CoachRequest {
  agentId: string;
  userMessage: string;
  /** Optional — when the admin is asking about a specific lead chat. */
  referencedConversationId?: string;
  /** Optional image attachment: storage path (kept on the row for replay). */
  attachmentUrl?: string;
  /** Optional image content (data URL or raw base64) sent inline to Claude. */
  attachmentBase64?: string;
  /** Optional media type if attachmentBase64 is raw base64 (no data: prefix). */
  attachmentMediaType?: string;
}

function parseRequestBody(raw: unknown): CoachRequest {
  if (!raw || typeof raw !== "object") {
    throw new HttpError(400, "Body must be a JSON object");
  }
  const o = raw as Record<string, unknown>;
  if (typeof o.agentId !== "string" || !o.agentId) {
    throw new HttpError(400, "agentId is required");
  }
  if (!isUuid(o.agentId)) {
    throw new HttpError(400, "agentId must be a UUID");
  }
  if (typeof o.userMessage !== "string" || !o.userMessage.trim()) {
    throw new HttpError(400, "userMessage is required");
  }
  if (o.userMessage.length > 4000) {
    throw new HttpError(400, "userMessage too long (max 4000 chars)");
  }
  let referencedConversationId: string | undefined;
  if (o.referencedConversationId !== undefined && o.referencedConversationId !== null) {
    if (typeof o.referencedConversationId !== "string") {
      throw new HttpError(400, "referencedConversationId must be a string or null");
    }
    referencedConversationId = o.referencedConversationId;
  }
  let attachmentUrl: string | undefined;
  if (typeof o.attachmentUrl === "string" && o.attachmentUrl.trim().length > 0) {
    attachmentUrl = o.attachmentUrl.trim();
  }
  let attachmentBase64: string | undefined;
  let attachmentMediaType: string | undefined;
  if (typeof o.attachmentBase64 === "string" && o.attachmentBase64.length > 0) {
    if (o.attachmentBase64.length > 8_000_000) {
      throw new HttpError(400, "attachment is too large (max ~6 MB)");
    }
    attachmentBase64 = o.attachmentBase64;
    if (typeof o.attachmentMediaType === "string" && o.attachmentMediaType.length > 0) {
      attachmentMediaType = o.attachmentMediaType;
    }
  }
  return {
    agentId: o.agentId,
    userMessage: o.userMessage.trim(),
    referencedConversationId,
    attachmentUrl,
    attachmentBase64,
    attachmentMediaType,
  };
}

// ---------- coach context: prompt, history, optional conversation ----------

interface CoachContext {
  agentName: string;
  /** Active main prompt content + id + version. Null if missing. */
  currentPrompt: { id: string; version: string; content: string } | null;
  /** Recent coach turns (oldest → newest) for chat continuity. */
  history: Array<{ role: "user" | "assistant"; content: string }>;
  /** The referenced lead conversation, if requested. */
  referencedConversation: ReferencedConversation | null;
  /** Active brain rows for this agent (own + shared). May be empty. */
  brain: BrainRow[];
}

interface ReferencedConversation {
  id: string;
  leadName: string | null;
  leadPhone: string;
  currentTag: string | null;
  funnelStage: string | null;
  messages: Array<{ role: "user" | "assistant"; content: string }>;
  leadMemory: Record<string, unknown> | null;
}

async function loadCoachContext(
  admin: SupabaseClient,
  agentId: string,
  referencedConversationId: string | undefined,
): Promise<CoachContext> {
  // The three reads below are independent — run them in parallel to
  // shave ~80-160ms off every Coach turn (network round-trip × 3).
  const [agentResult, promptResult, historyResult] = await Promise.all([
    admin.from("agents").select("name").eq("id", agentId).maybeSingle(),
    admin
      .from("prompts")
      .select("id, version, content")
      .eq("agent_id", agentId)
      .eq("prompt_type", MAIN_PROMPT_TYPE)
      .eq("is_active", true)
      .order("created_at", { ascending: false })
      .limit(1)
      .maybeSingle(),
    admin
      .from("coach_messages")
      .select("role, content, created_at")
      .eq("agent_id", agentId)
      .order("created_at", { ascending: false })
      .limit(MAX_HISTORY_TURNS),
  ]);

  if (agentResult.error || !agentResult.data) {
    throw new HttpError(
      404,
      `Agent not found: ${agentResult.error?.message ?? "no row"}`,
    );
  }
  const agentName = agentResult.data.name as string;

  if (promptResult.error) {
    throw new HttpError(500, `Failed to load prompt: ${promptResult.error.message}`);
  }
  const currentPrompt = promptResult.data
    ? {
      id: promptResult.data.id as string,
      version: promptResult.data.version as string,
      content: promptResult.data.content as string,
    }
    : null;

  if (historyResult.error) {
    throw new HttpError(500, `Failed to load coach history: ${historyResult.error.message}`);
  }
  const history = (historyResult.data ?? [])
    .slice()
    .reverse()
    .map((row) => ({
      role: row.role as "user" | "assistant",
      content: row.content as string,
    }));

  // Optionally load a referenced lead conversation + memory.
  let referencedConversation: ReferencedConversation | null = null;
  if (referencedConversationId) {
    referencedConversation = await loadReferencedConversation(
      admin,
      agentId,
      referencedConversationId,
    );
  }

  // Active brain rows for this agent — own + globally shared. A brain
  // load failure shouldn't block Coach replies, so we degrade gracefully.
  let brain: BrainRow[] = [];
  try {
    brain = await loadBrainRows(admin, agentId);
  } catch (err) {
    console.warn(`[prompt-coach] brain load failed: ${err instanceof Error ? err.message : err}`);
  }

  return { agentName, currentPrompt, history, referencedConversation, brain };
}

async function loadReferencedConversation(
  admin: SupabaseClient,
  agentId: string,
  conversationId: string,
): Promise<ReferencedConversation | null> {
  const { data: conv, error: convErr } = await admin
    .from("conversations")
    .select("id, lead_name, lead_phone, current_tag, funnel_stage")
    .eq("id", conversationId)
    .eq("agent_id", agentId)
    .maybeSingle();
  if (convErr || !conv) {
    // Don't blow up — just skip the reference if it can't be loaded.
    return null;
  }

  const { data: msgs } = await admin
    .from("messages")
    .select("direction, content")
    .eq("conversation_id", conversationId)
    .order("timestamp", { ascending: true })
    .limit(MAX_CONVERSATION_MESSAGES);
  const messages: Array<{ role: "user" | "assistant"; content: string }> = [];
  for (const m of msgs ?? []) {
    const text = (m.content as string | null)?.trim();
    if (!text) continue;
    messages.push({
      role: (m.direction as string) === "inbound" ? "user" : "assistant",
      content: text,
    });
  }

  const { data: mem } = await admin
    .from("lead_memory")
    .select(
      "q1_age, q2_motivation, q3_dream_change, q4_blocker, q5_urgency, q6_investment, q7_email, conversation_summary, primary_objection, red_flags, notes_for_advisor",
    )
    .eq("conversation_id", conversationId)
    .maybeSingle();

  return {
    id: conv.id as string,
    leadName: (conv.lead_name as string | null) ?? null,
    leadPhone: conv.lead_phone as string,
    currentTag: (conv.current_tag as string | null) ?? null,
    funnelStage: (conv.funnel_stage as string | null) ?? null,
    messages,
    leadMemory: (mem as Record<string, unknown> | null) ?? null,
  };
}

// ---------- system prompt builder ----------

interface SystemBlock {
  type: "text";
  text: string;
  cache_control?: { type: "ephemeral" };
}

interface SystemBuild {
  blocks: SystemBlock[];
  /** brain document ids included in the prompt — written to brain_usage_log. */
  brainUsedIds: string[];
}

function buildCoachSystemPrompt(ctx: CoachContext): SystemBuild {
  const parts: string[] = [];
  parts.push(
    `אתה "מאמן הפרומפט" של מערכת AI שמטפלת בלידים בוואטסאפ למכללת ריצ'ר.`,
    ``,
    `**תפקידך**: לעזור לאופרטור (אדמין אנושי) לשפר את ה־prompt של הבוט שמדבר עם הלידים.`,
    `**אתה לא מדבר עם לידים** — אתה מדבר רק עם האופרטור בעברית, ברור ועוזר.`,
    ``,
    `## עקרונות`,
    `1. תמיד תקרא את ה־prompt הנוכחי לפני שאתה מציע שינוי.`,
    `2. אם האופרטור מתאר בעיה — תזהה את החלק ב־prompt שאחראי לזה.`,
    `3. תציע שינוי **ממוקד**: שנה רק את החלק הרלוונטי, השאר את השאר.`,
    `4. תסביר בעברית למה השינוי יפתור את הבעיה.`,
    `5. כשאתה מציע שינוי — תקרא לכלי \`propose_prompt_edit\` עם ה־prompt המלא החדש (לא diff, ה־UI ידאג לדיף).`,
    `6. אם הבקשה לא ברורה — תשאל שאלת הבהרה אחת לפני שאתה מציע שינוי.`,
    ``,
    `## גבולות קשיחים (אסור לחצות)`,
    `- אסור להציע prompt שמסיר את הגבולות הקיימים: אסור לציין מחירים, אסור להבטיח הכנסה, אסור שהבוט יחשוף את עצמו כ־AI.`,
    `- אסור להציע שינוי שמסכן לידים מתחת לגיל 18 (red flag underage חייב להישאר).`,
    `- אסור להוסיף הוראות שיגרמו לבוט להמציא עובדות (שמות יועצים, זמני זום, וכו').`,
    `- אם האופרטור מבקש שינוי שעובר על אחד הגבולות — סרב בנימוס והסבר.`,
    ``,
  );

  parts.push(`## הסוכן הפעיל`, `שם הסוכן: \`${ctx.agentName}\``, ``);

  if (ctx.currentPrompt) {
    parts.push(
      `## ה־prompt הנוכחי (גרסה ${ctx.currentPrompt.version})`,
      "```markdown",
      ctx.currentPrompt.content,
      "```",
      ``,
    );
  } else {
    parts.push(
      `## ה־prompt הנוכחי`,
      `**אין prompt פעיל לסוכן הזה.** אם האופרטור מבקש שינוי, תציע prompt התחלתי.`,
      ``,
    );
  }

  if (ctx.referencedConversation) {
    const r = ctx.referencedConversation;
    parts.push(
      `## השיחה שהאופרטור מתייחס אליה`,
      `- ליד: ${r.leadName ?? "(ללא שם)"} (${r.leadPhone})`,
      `- תג נוכחי: ${r.currentTag ?? "—"} | שלב משפך: ${r.funnelStage ?? "—"}`,
      ``,
      `**ההיסטוריה המלאה של השיחה:**`,
    );
    if (r.messages.length === 0) {
      parts.push(`(אין הודעות)`);
    } else {
      for (const m of r.messages) {
        const speaker = m.role === "user" ? "ליד" : "בוט";
        parts.push(`**${speaker}**: ${m.content}`);
      }
    }
    parts.push(``);
    if (r.leadMemory) {
      parts.push(
        `**הזיכרון של הליד (q1-q6):**`,
        "```json",
        JSON.stringify(r.leadMemory, null, 2),
        "```",
        ``,
      );
    }
  }

  parts.push(
    `## פורמט תשובה`,
    `- תענה בעברית, קצר וענייני (1-4 פסקאות).`,
    `- כשאתה רוצה להציע שינוי ב־prompt — תקרא ל־tool \`propose_prompt_edit\` עם ה־prompt המלא החדש ועם הסבר קצר (\`reason\`).`,
    `- אם אתה רק עונה / מבהיר — תכתוב טקסט חופשי, בלי קריאה ל־tool.`,
  );

  const mainText = parts.join("\n");

  // Brain goes in its own block with a cache breakpoint so subsequent
  // Coach turns within 5 minutes pay the cache-read rate ($0.30/M)
  // instead of $3/M. Anthropic requires the cache-breakpoint block to
  // be at the END of the cached prefix — so brain is the last system
  // block. Anything stable that should also be cached must precede it.
  const brainSection = buildBrainSection(ctx.brain);
  const blocks: SystemBlock[] = [{ type: "text", text: mainText }];
  if (brainSection.text.length > 0) {
    blocks.push({
      type: "text",
      text: brainSection.text,
      cache_control: { type: "ephemeral" },
    });
  }
  return { blocks, brainUsedIds: brainSection.usedIds };
}

// ---------- tool definition ----------

interface ToolDef {
  name: string;
  description: string;
  input_schema: Record<string, unknown>;
}

const PROPOSE_EDIT_TOOL: ToolDef = {
  name: "propose_prompt_edit",
  description:
    "Propose a complete replacement of the bot's main system prompt. Use this whenever the admin's feedback should trigger a change. Do NOT use this for chit-chat or clarifying questions.",
  input_schema: {
    type: "object",
    properties: {
      new_prompt_content: {
        type: "string",
        description:
          "The FULL new prompt body in markdown — not a diff. Include everything the bot needs.",
      },
      reason: {
        type: "string",
        description:
          "One short sentence in Hebrew explaining what changed and why it addresses the admin's feedback.",
      },
    },
    required: ["new_prompt_content", "reason"],
  },
};

// ---------- Anthropic call + response parsing ----------

interface AnthropicTextBlock {
  type: "text";
  text: string;
}
interface AnthropicToolUseBlock {
  type: "tool_use";
  id: string;
  name: string;
  input: Record<string, unknown>;
}
type AnthropicContentBlock = AnthropicTextBlock | AnthropicToolUseBlock | { type: string };

interface AnthropicResponse {
  content: ReadonlyArray<AnthropicContentBlock>;
  stop_reason?: string;
}

interface CoachReply {
  /** The free-text reply (always present; the UI shows this as the assistant bubble). */
  text: string;
  /** When the model invoked propose_prompt_edit, this holds the proposal. */
  proposal: { newPromptContent: string; reason: string } | null;
  /** Diagnostics surfaced to callers so they can decide whether to log a warning. */
  diagnostics: {
    stopReason: string | null;
    blockCounts: { text: number; tool_use: number; thinking: number; other: number };
    wasEmpty: boolean;
  };
}

function parseCoachReply(response: AnthropicResponse): CoachReply {
  let text = "";
  let proposal: CoachReply["proposal"] = null;
  const blockCounts = { text: 0, tool_use: 0, thinking: 0, other: 0 };
  for (const block of response.content) {
    if (block.type === "text") {
      blockCounts.text += 1;
      text += (block as AnthropicTextBlock).text;
    } else if (block.type === "tool_use") {
      blockCounts.tool_use += 1;
      const tool = block as AnthropicToolUseBlock;
      if (tool.name !== PROPOSE_EDIT_TOOL.name) continue;
      const input = tool.input;
      const newPromptContent = input.new_prompt_content;
      const reason = input.reason;
      if (typeof newPromptContent !== "string" || newPromptContent.trim().length === 0) continue;
      if (typeof reason !== "string" || reason.trim().length === 0) continue;
      proposal = { newPromptContent: newPromptContent.trim(), reason: reason.trim() };
    } else if (block.type === "thinking") {
      blockCounts.thinking += 1;
    } else {
      blockCounts.other += 1;
    }
  }
  // If the model used the tool but gave no narration, synthesise one
  // so the UI always has SOMETHING to render in the assistant bubble.
  if (proposal && text.trim().length === 0) {
    text = `הצעתי שינוי ל־prompt — ${proposal.reason}`;
  }
  const wasEmpty = text.trim().length === 0;
  if (wasEmpty) {
    // Diagnose for the operator instead of the cryptic "try rephrasing".
    // The most common cause is stop_reason='max_tokens' — adaptive thinking
    // burned the entire token budget before emitting text. Surface that
    // explicitly so the operator knows it's not a content issue.
    if (response.stop_reason === "max_tokens") {
      text =
        "המאמן חרג מתקציב הטוקנים לפני שהספיק להשיב (חשב יותר מדי). נסה שאלה ממוקדת יותר, או צמצם את מספר המסמכים הפעילים ב־brain.";
    } else if (response.stop_reason === "pause_turn") {
      text =
        "המאמן הפסיק את התור באמצע (pause_turn). לחץ שוב לאותה שאלה — המודל ימשיך מהמקום שעצר.";
    } else if (response.stop_reason === "refusal") {
      text = "המאמן סירב לענות על הבקשה הזאת. נסה לנסח אחרת.";
    } else {
      text = `(תגובה ריקה — stop_reason=${response.stop_reason ?? "unknown"}. נסה לנסח מחדש.)`;
    }
  }
  return {
    text,
    proposal,
    diagnostics: {
      stopReason: response.stop_reason ?? null,
      blockCounts,
      wasEmpty,
    },
  };
}

interface ClaudeImageBlock {
  type: "image";
  source: { type: "base64"; media_type: string; data: string };
}
interface ClaudeTextBlock {
  type: "text";
  text: string;
}
type ClaudeUserContent = string | Array<ClaudeImageBlock | ClaudeTextBlock>;

interface UserTurnInput {
  text: string;
  attachmentBase64?: string;
  attachmentMediaType?: string;
}

function buildUserContent(input: UserTurnInput): ClaudeUserContent {
  if (!input.attachmentBase64) return input.text;
  // Accept data URL form ("data:image/png;base64,XXX") or raw base64.
  let mediaType = input.attachmentMediaType ?? "image/png";
  let data = input.attachmentBase64;
  const dataUrlMatch = data.match(/^data:([\w./+-]+);base64,(.+)$/);
  if (dataUrlMatch) {
    mediaType = dataUrlMatch[1];
    data = dataUrlMatch[2];
  }
  const blocks: Array<ClaudeImageBlock | ClaudeTextBlock> = [
    { type: "image", source: { type: "base64", media_type: mediaType, data } },
  ];
  if (input.text) blocks.push({ type: "text", text: input.text });
  return blocks;
}

async function callCoach(
  anthropic: Anthropic,
  systemBlocks: SystemBlock[],
  history: Array<{ role: "user" | "assistant"; content: string }>,
  userTurn: UserTurnInput,
): Promise<CoachReply> {
  const messages = [
    ...history.map((m) => ({ role: m.role, content: m.content })),
    { role: "user" as const, content: buildUserContent(userTurn) },
  ];
  // deno-lint-ignore no-explicit-any
  const raw = await anthropic.messages.create({
    model: COACH_MODEL,
    // 16384 = generous enough that adaptive thinking can finish its
    // reasoning AND still emit several paragraphs of text + an optional
    // tool_use proposal. 4096 was too tight: complex turns spent the
    // whole budget on `thinking` and returned 0 text blocks, surfacing
    // as "(תגובה ריקה — נסה לנסח מחדש)" with no diagnostic.
    max_tokens: 16384,
    thinking: { type: "adaptive" } as any,
    system: systemBlocks as any,
    tools: [PROPOSE_EDIT_TOOL] as any,
    messages: messages as any,
  } as any);
  return parseCoachReply(raw as unknown as AnthropicResponse);
}

// ---------- entrypoint ----------

Deno.serve(async (req) => {
  if (req.method === "OPTIONS") {
    return new Response(null, { headers: corsHeaders });
  }
  if (req.method !== "POST") {
    return jsonResponse({ error: "Method not allowed" }, {
      status: 405,
      headers: corsHeaders,
    });
  }

  let ctx;
  try {
    ctx = await requireAdmin(req);
  } catch (err) {
    const status = err instanceof HttpError ? err.status : 500;
    const message = err instanceof Error ? err.message : "Auth failed";
    return jsonResponse({ error: message }, { status, headers: corsHeaders });
  }

  let body: CoachRequest;
  try {
    const raw = await req.json().catch(() => null);
    body = parseRequestBody(raw);
  } catch (err) {
    const status = err instanceof HttpError ? err.status : 400;
    const message = err instanceof Error ? err.message : "Bad request";
    return jsonResponse({ error: message }, { status, headers: corsHeaders });
  }

  const anthropicApiKey = Deno.env.get("ANTHROPIC_API_KEY");
  if (!anthropicApiKey) {
    return jsonResponse(
      { error: "Coach is unavailable (missing ANTHROPIC_API_KEY)" },
      { status: 503, headers: corsHeaders },
    );
  }

  // 1. Persist the admin's message FIRST so the conversation survives
  //    even if Claude blows up.
  const { data: userRow, error: insErr } = await ctx.admin
    .from("coach_messages")
    .insert({
      agent_id: body.agentId,
      role: "user",
      user_id: ctx.callerId,
      content: body.userMessage,
      referenced_conversation_id: body.referencedConversationId ?? null,
      attachment_url: body.attachmentUrl ?? null,
    })
    .select("id, created_at")
    .single();
  if (insErr || !userRow) {
    await logError({
      admin: ctx.admin,
      source: SOURCE,
      errorType: "user_message_insert_failed",
      message: insErr?.message ?? "no row returned",
      context: { agentId: body.agentId },
      agentId: body.agentId,
    });
    return jsonResponse({ error: "Failed to record your message" }, {
      status: 500,
      headers: corsHeaders,
    });
  }

  // 2. Build context.
  let coachCtx: CoachContext;
  try {
    coachCtx = await loadCoachContext(ctx.admin, body.agentId, body.referencedConversationId);
  } catch (err) {
    const status = err instanceof HttpError ? err.status : 500;
    const message = err instanceof Error ? err.message : "Context load failed";
    await logError({
      admin: ctx.admin,
      source: SOURCE,
      errorType: "context_load_failed",
      message,
      context: { agentId: body.agentId },
      agentId: body.agentId,
    });
    return jsonResponse({ error: message }, { status, headers: corsHeaders });
  }

  // Drop the LATEST user row from history (it's `body.userMessage` we'll
  // pass separately) so Claude doesn't see the same message twice.
  const historyForClaude = coachCtx.history.slice(0, -1);

  const { blocks: systemBlocks, brainUsedIds } = buildCoachSystemPrompt(coachCtx);
  const anthropic = new Anthropic({ apiKey: anthropicApiKey });

  // 3. Call Claude.
  let reply: CoachReply;
  try {
    reply = await callCoach(anthropic, systemBlocks, historyForClaude, {
      text: body.userMessage,
      attachmentBase64: body.attachmentBase64,
      attachmentMediaType: body.attachmentMediaType,
    });
  } catch (err) {
    await logError({
      admin: ctx.admin,
      source: SOURCE,
      errorType: "claude_api_error",
      message: err instanceof Error ? err.message : String(err),
      context: { model: COACH_MODEL, agentId: body.agentId },
      agentId: body.agentId,
    });
    return jsonResponse({ error: "Claude error — try again in a moment" }, {
      status: 502,
      headers: corsHeaders,
    });
  }

  // If Claude returned no text we want a structured trace so future
  // empty-replies are debuggable from the dashboard, not just "the
  // operator says it broke". The user-facing fallback is already in
  // reply.text (parseCoachReply formats it per stop_reason).
  if (reply.diagnostics.wasEmpty) {
    await logError({
      admin: ctx.admin,
      level: "warn",
      source: SOURCE,
      errorType: "coach_empty_reply",
      message:
        `Claude returned no text. stop_reason=${reply.diagnostics.stopReason ?? "unknown"}, ` +
        `blocks=${JSON.stringify(reply.diagnostics.blockCounts)}`,
      context: {
        model: COACH_MODEL,
        agentId: body.agentId,
        stopReason: reply.diagnostics.stopReason,
        blockCounts: reply.diagnostics.blockCounts,
        userMessageLen: body.userMessage.length,
        brainDocCount: coachCtx.brain.length,
        historyTurnCount: historyForClaude.length,
      },
      agentId: body.agentId,
    });
  }

  // 4. Persist the assistant message.
  const { data: assistantRow, error: assistantErr } = await ctx.admin
    .from("coach_messages")
    .insert({
      agent_id: body.agentId,
      role: "assistant",
      user_id: ctx.callerId,
      content: reply.text,
      proposed_prompt_content: reply.proposal?.newPromptContent ?? null,
      referenced_conversation_id: body.referencedConversationId ?? null,
    })
    .select("id, created_at, content, proposed_prompt_content")
    .single();
  if (assistantErr || !assistantRow) {
    await logError({
      admin: ctx.admin,
      source: SOURCE,
      errorType: "assistant_message_insert_failed",
      message: assistantErr?.message ?? "no row returned",
      context: { agentId: body.agentId },
      agentId: body.agentId,
    });
    return jsonResponse({ error: "Failed to record Coach reply" }, {
      status: 500,
      headers: corsHeaders,
    });
  }

  // 5. Log which brain rows were in context for transparency. Best-effort:
  //    a logging failure here must NOT degrade the operator experience.
  if (brainUsedIds.length > 0) {
    const { error: logErr } = await ctx.admin.from("brain_usage_log").insert({
      coach_message_id: assistantRow.id,
      brain_document_ids: brainUsedIds,
    });
    if (logErr) {
      console.warn(`[prompt-coach] brain_usage_log insert failed: ${logErr.message}`);
    }
  }

  // Lightweight titles for the "I saw: ..." transparency line in the UI.
  const brainDocsUsed = coachCtx.brain
    .filter((b) => brainUsedIds.includes(b.id))
    .map((b) => ({ id: b.id, title: b.title, source_kind: b.source_kind }));

  return jsonResponse(
    {
      userMessageId: userRow.id,
      assistantMessage: {
        id: assistantRow.id,
        content: assistantRow.content,
        proposedPromptContent: assistantRow.proposed_prompt_content,
        proposalReason: reply.proposal?.reason ?? null,
        createdAt: assistantRow.created_at,
      },
      brainDocsUsed,
    },
    { status: 200, headers: corsHeaders },
  );
});
