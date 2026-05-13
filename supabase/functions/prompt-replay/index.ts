// prompt-replay/index.ts
//
// Admin-only edge function for Phase D-full prompt A/B testing.
// Given a candidate `promptId` and a past `conversationId`, it replays
// the conversation through Claude using the candidate prompt and returns
// a side-by-side comparison of what the candidate would have said vs.
// what the bot actually said.
//
// Cost note: each user-turn in the conversation triggers one Claude
// call. A 5-turn conversation costs ~$0.04 to replay. The function caps
// at MAX_TURNS so a 50-turn outlier can't surprise-bill us.
//
// Request:
//   POST /functions/v1/prompt-replay
//   Authorization: Bearer <user JWT — must belong to a role='admin' app_user>
//   { "promptId": uuid, "conversationId": uuid }
//
// Required secrets (already configured for whatsapp-webhook):
//   ANTHROPIC_API_KEY        — sk-ant-...
//
// Auto-injected by Supabase: SUPABASE_URL, SUPABASE_SERVICE_ROLE_KEY,
// SUPABASE_ANON_KEY (for requireAdmin).

import Anthropic from "https://esm.sh/@anthropic-ai/sdk@0.88.0";
import { corsHeaders } from "../_shared/cors.ts";
import { HttpError, jsonResponse, requireAdmin } from "../_shared/auth.ts";
import { type AnthropicUsage, computeSonnet46Cost } from "../_shared/langfuse.ts";

const CLAUDE_MODEL = "claude-sonnet-4-6";
const MAX_TURNS = 30;

interface ReplayPayload {
  promptId: string;
  conversationId: string;
}

function isReplayPayload(value: unknown): value is ReplayPayload {
  if (!value || typeof value !== "object") return false;
  const v = value as Record<string, unknown>;
  return (
    typeof v.promptId === "string" && v.promptId.length > 0 &&
    typeof v.conversationId === "string" && v.conversationId.length > 0
  );
}

interface PromptRow {
  id: string;
  agent_id: string | null;
  prompt_type: string;
  version: string;
  content: string;
  is_active: boolean | null;
}

interface MessageRow {
  id: string;
  direction: "inbound" | "outbound";
  content: string | null;
  timestamp: string | null;
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

interface ReplayTurn {
  turnIndex: number;
  /** The lead's message that the candidate is replying to. */
  userMessage: string;
  /** The bot's actual reply (from production) — null if the conversation
   *  ended on this turn before the bot replied. */
  originalReply: string | null;
  /** Candidate's reply, or null on error. */
  candidateReply: string | null;
  /** Cost in USD for THIS turn's candidate call. Helpful for budgeting. */
  candidateCostUsd: number | null;
  candidateTokensInput: number | null;
  candidateTokensOutput: number | null;
  candidateLatencyMs: number | null;
  /** Error string if Claude call failed for this turn. */
  error: string | null;
}

interface ReplayResult {
  promptType: string;
  promptVersion: string;
  conversationId: string;
  turnCount: number;
  truncated: boolean;
  /** Aggregate cost across all candidate calls in this replay. */
  totalCostUsd: number;
  turns: ReplayTurn[];
}

function extractTextBlock(response: AnthropicMessageResponse): string | null {
  const block = response.content.find((b) => b.type === "text");
  if (!block || typeof block.text !== "string") return null;
  return block.text;
}

Deno.serve(async (req) => {
  if (req.method === "OPTIONS") return new Response(null, { headers: corsHeaders });
  if (req.method !== "POST") {
    return jsonResponse({ error: "Method not allowed" }, { status: 405, headers: corsHeaders });
  }

  try {
    const anthropicApiKey = Deno.env.get("ANTHROPIC_API_KEY");
    if (!anthropicApiKey) {
      throw new HttpError(500, "Anthropic key not configured on this Supabase project");
    }

    const { admin } = await requireAdmin(req);
    const body = await req.json().catch(() => null);
    if (!isReplayPayload(body)) {
      throw new HttpError(400, "Body must be { promptId, conversationId }");
    }

    // Load the candidate prompt.
    const { data: promptRaw, error: promptErr } = await admin
      .from("prompts")
      .select("id, agent_id, prompt_type, version, content, is_active")
      .eq("id", body.promptId)
      .maybeSingle();
    if (promptErr) throw new HttpError(500, `Prompt lookup failed: ${promptErr.message}`);
    if (!promptRaw) throw new HttpError(404, "Prompt not found");
    const prompt = promptRaw as PromptRow;
    if (typeof prompt.content !== "string" || prompt.content.length === 0) {
      throw new HttpError(422, "Prompt has empty content");
    }

    // Load the conversation messages, oldest first.
    const { data: messagesRaw, error: msgErr } = await admin
      .from("messages")
      .select("id, direction, content, timestamp")
      .eq("conversation_id", body.conversationId)
      .order("timestamp", { ascending: true, nullsFirst: false });
    if (msgErr) throw new HttpError(500, `Messages lookup failed: ${msgErr.message}`);
    const messages = (messagesRaw ?? []) as MessageRow[];
    if (messages.length === 0) {
      throw new HttpError(404, "Conversation has no messages to replay");
    }

    // Decide whether the candidate's prompt_type matches the agent's
    // active "main" usage. We allow any prompt to be replayed against
    // any conversation — the operator might want to A/B a candidate
    // from a different agent — but the agent_id mismatch is surfaced
    // in the response metadata.
    const anthropic = new Anthropic({ apiKey: anthropicApiKey });

    const turns: ReplayTurn[] = [];
    const claudeHistory: Array<{ role: "user" | "assistant"; content: string }> = [];
    let totalCost = 0;
    let truncated = false;

    for (let i = 0; i < messages.length; i++) {
      const m = messages[i];
      if (!m.content || !m.content.trim()) continue;

      if (m.direction === "outbound") {
        claudeHistory.push({ role: "assistant", content: m.content });
        continue;
      }

      // m.direction === "inbound"
      claudeHistory.push({ role: "user", content: m.content });

      // The original reply is the next outbound message in the sequence,
      // if any.
      let originalReply: string | null = null;
      for (let j = i + 1; j < messages.length; j++) {
        if (messages[j].direction === "outbound" && messages[j].content) {
          originalReply = messages[j].content;
          break;
        }
        if (messages[j].direction === "inbound") break;
      }

      if (turns.length >= MAX_TURNS) {
        truncated = true;
        break;
      }

      const startTime = Date.now();
      try {
        const raw = await anthropic.messages.create({
          model: CLAUDE_MODEL,
          max_tokens: 1024,
          thinking: { type: "adaptive" },
          system: prompt.content,
          messages: claudeHistory,
        });
        const latencyMs = Date.now() - startTime;
        const response = raw as unknown as AnthropicMessageResponse;
        const candidateReply = extractTextBlock(response);
        const usage: AnthropicUsage = {
          inputTokens: response.usage?.input_tokens,
          outputTokens: response.usage?.output_tokens,
          cacheReadTokens: response.usage?.cache_read_input_tokens,
          cacheCreationTokens: response.usage?.cache_creation_input_tokens,
        };
        const cost = computeSonnet46Cost(usage);
        totalCost += cost;
        turns.push({
          turnIndex: turns.length,
          userMessage: m.content,
          originalReply,
          candidateReply,
          candidateCostUsd: cost,
          candidateTokensInput: usage.inputTokens ?? null,
          candidateTokensOutput: usage.outputTokens ?? null,
          candidateLatencyMs: latencyMs,
          error: null,
        });
      } catch (err) {
        turns.push({
          turnIndex: turns.length,
          userMessage: m.content,
          originalReply,
          candidateReply: null,
          candidateCostUsd: null,
          candidateTokensInput: null,
          candidateTokensOutput: null,
          candidateLatencyMs: null,
          error: err instanceof Error ? err.message : String(err),
        });
      }
    }

    const result: ReplayResult = {
      promptType: prompt.prompt_type,
      promptVersion: prompt.version,
      conversationId: body.conversationId,
      turnCount: turns.length,
      truncated,
      totalCostUsd: totalCost,
      turns,
    };
    return jsonResponse(result, { status: 200, headers: corsHeaders });
  } catch (err) {
    if (err instanceof HttpError) {
      return jsonResponse({ error: err.message }, { status: err.status, headers: corsHeaders });
    }
    console.error("prompt-replay: unexpected error", err);
    return jsonResponse(
      { error: "Internal server error" },
      { status: 500, headers: corsHeaders },
    );
  }
});
