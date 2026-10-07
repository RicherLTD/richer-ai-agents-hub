// One bot reply, produced the way production's runAgentTurn does it: same
// model, adaptive thinking, max_tokens, cacheable system block, Mooz tool
// definitions and the same tool-use loop. The only difference is that tool
// calls are answered by local stubs (stubTools.ts) instead of Mooz.
//
// A separate loop rather than runAgentTurn because that function dispatches
// through dispatchMoozTool, which reads and writes the database.

import { callWithRetry } from "../../../supabase/functions/_shared/anthropicRetry.ts";
import { MOOZ_TOOL_DEFS } from "../../../supabase/functions/_shared/moozTools.ts";
import type { ChatMessage } from "../../../supabase/functions/_shared/warmingHistory.ts";
import { SONNET_MODEL, type ApiUsage, type CostTracker } from "./cost.ts";
import type { GeneratedReply } from "./guardedReply.ts";
import { runStubTool } from "./stubTools.ts";

export const BOT_MAX_TOKENS = 2048;
const MAX_TOOL_ITERATIONS = 5;
const RETRY = { maxAttempts: 3, baseDelayMs: 1000 };

/** The slice of the Anthropic SDK the simulator uses. */
export interface MessagesClient {
  messages: { create(params: Record<string, unknown>): Promise<unknown> };
}

interface ContentBlock {
  type: string;
  text?: unknown;
  id?: unknown;
  name?: unknown;
  input?: unknown;
}

interface TurnResponse {
  stop_reason?: string;
  content: ContentBlock[];
  usage?: ApiUsage;
}

function toTurnResponse(raw: unknown): TurnResponse {
  if (typeof raw !== "object" || raw === null) throw new Error("unexpected Anthropic response");
  const candidate = raw as { stop_reason?: unknown; content?: unknown; usage?: ApiUsage };
  if (!Array.isArray(candidate.content)) throw new Error("Anthropic response has no content array");
  return {
    stop_reason: typeof candidate.stop_reason === "string" ? candidate.stop_reason : undefined,
    content: candidate.content as ContentBlock[],
    usage: candidate.usage,
  };
}

function firstText(response: TurnResponse): string | null {
  const block = response.content.find((b) => b.type === "text");
  return block && typeof block.text === "string" ? block.text : null;
}

export interface BotTurnArgs {
  client: MessagesClient;
  tracker: CostTracker;
  now: Date;
  messages: ReadonlyArray<ChatMessage>;
}

type ConversationMessage = { role: "user" | "assistant"; content: string | unknown[] };

function buildParams(systemPrompt: string, messages: ConversationMessage[]): Record<string, unknown> {
  return {
    model: SONNET_MODEL,
    max_tokens: BOT_MAX_TOKENS,
    thinking: { type: "adaptive" },
    // Same cacheable block as agentTurn.ts, so repeated turns reuse the prefix.
    system: [{ type: "text", text: systemPrompt, cache_control: { type: "ephemeral" } }],
    messages,
    tools: MOOZ_TOOL_DEFS,
  };
}

export async function generateBotReply(args: BotTurnArgs, systemPrompt: string): Promise<GeneratedReply> {
  const messages: ConversationMessage[] = args.messages.map((m) => ({ ...m }));
  const toolLines: string[] = [];
  const offeredTimes = new Set<string>();

  for (let iteration = 0; iteration < MAX_TOOL_ITERATIONS; iteration++) {
    args.tracker.assertWithinBudget();
    const raw = await callWithRetry(
      () => args.client.messages.create(buildParams(systemPrompt, messages)),
      RETRY,
    );
    const response = toTurnResponse(raw);
    args.tracker.record(SONNET_MODEL, response.usage);

    const toolUses = response.content.filter((b) => b.type === "tool_use");
    if (response.stop_reason !== "tool_use" || toolUses.length === 0) {
      return { rawReply: firstText(response), offeredTimesIL: [...offeredTimes], toolLines };
    }

    messages.push({ role: "assistant", content: response.content });
    const results = toolUses.map((use) => {
      const out = runStubTool(String(use.name), use.input, args.now);
      toolLines.push(out.line);
      out.offeredTimesIL.forEach((time) => offeredTimes.add(time));
      return { type: "tool_result", tool_use_id: use.id, content: out.resultJson };
    });
    messages.push({ role: "user", content: results });
  }
  throw new Error(`tool iteration cap (${MAX_TOOL_ITERATIONS}) reached without a final reply`);
}
