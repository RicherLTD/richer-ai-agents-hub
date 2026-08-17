// agentTurn.ts
//
// Tool-use-aware wrapper around `anthropic.messages.create`. When Mooz
// tools are wired in (caller passes a MoozDispatchCtx), Claude can call
// list_available_slots / book_meeting mid-turn; this helper executes the
// tool and re-prompts until Claude returns a final text reply.
//
// When `moozCtx` is null the helper degrades to a single plain call —
// identical behavior to the legacy whatsapp-webhook flow.
//
// Why a separate module: keeps the webhook file's main flow readable
// (the loop is ~100 lines on its own), and lets us unit-test the
// iteration cap + content-block plumbing in isolation.

import type Anthropic from "https://esm.sh/@anthropic-ai/sdk@0.88.0";
import { callWithRetry } from "./anthropicRetry.ts";
import { dispatchMoozTool, MOOZ_TOOL_DEFS, type MoozDispatchCtx } from "./moozTools.ts";

const MAX_TOOL_ITERATIONS = 5;

/** A message in Claude's API — content can be a plain string OR an
 *  array of content blocks (tool_use, tool_result, thinking, text).
 *  We start with plain strings (history loaded from DB) and morph to
 *  block-arrays once Claude starts emitting tool calls. */
export type ClaudeMessage =
  | { role: "user" | "assistant"; content: string }
  // deno-lint-ignore no-explicit-any
  | { role: "user" | "assistant"; content: any[] };

interface ContentBlock {
  type: string;
  text?: unknown;
  id?: string;
  name?: string;
  // deno-lint-ignore no-explicit-any
  input?: any;
}

export interface AnthropicTurnResponse {
  stop_reason?: string;
  content: ReadonlyArray<ContentBlock>;
  usage?: {
    input_tokens?: number;
    output_tokens?: number;
    cache_read_input_tokens?: number;
    cache_creation_input_tokens?: number;
  };
}

export interface AgentTurnUsage {
  inputTokens?: number;
  outputTokens?: number;
  cacheReadTokens?: number;
  cacheCreationTokens?: number;
}

export interface RunAgentTurnArgs {
  anthropic: Anthropic;
  model: string;
  maxTokens: number;
  systemPrompt: string;
  initialMessages: ClaudeMessage[];
  /** When non-null, tool defs are passed to Claude and tool_use blocks
   *  are dispatched via this context. Pass null to disable tools and
   *  fall back to the legacy single-call behavior. */
  moozCtx: MoozDispatchCtx | null;
  retry: {
    maxAttempts: number;
    baseDelayMs: number;
    onRetry?: (event: { attempt: number; delayMs: number; status: number | null }) => void;
  };
}

export interface AgentTurnResult {
  response: AnthropicTurnResponse;
  totalUsage: AgentTurnUsage;
  iterations: number;
  hadToolUse: boolean;
  bookingCreated: boolean;
  /** Asia/Jerusalem "HH:MM" times surfaced by Mooz tools this turn (union
   *  across all tool calls). The caller passes these to validateAgentReply
   *  as the allow-list so the model can only state times Mooz offered. */
  offeredTimesIL: string[];
  /** Final messages array (with assistant + tool_result blocks appended)
   *  — useful for Langfuse tracing the actual turn shape. */
  finalMessages: ClaudeMessage[];
}

export async function runAgentTurn(args: RunAgentTurnArgs): Promise<AgentTurnResult> {
  const messages: ClaudeMessage[] = [...args.initialMessages];
  const totalUsage: AgentTurnUsage = {
    inputTokens: 0,
    outputTokens: 0,
    cacheReadTokens: 0,
    cacheCreationTokens: 0,
  };
  let iterations = 0;
  let hadToolUse = false;
  let bookingCreated = false;
  const offeredTimesIL = new Set<string>();
  let response: AnthropicTurnResponse = { content: [] };

  while (iterations < MAX_TOOL_ITERATIONS) {
    iterations += 1;
    // deno-lint-ignore no-explicit-any
    const params: any = {
      model: args.model,
      max_tokens: args.maxTokens,
      thinking: { type: "adaptive" },
      // Cacheable system block.
      //
      // brainContext.ts:11 documents this as the caller's job — "Caller
      // adds an Anthropic cache_control breakpoint on the returned block
      // so subsequent turns within 5 min hit the cache" — and it was
      // never wired up. Cost of that omission, measured 2026-08-05:
      // affiliate averaged 107,497 input tokens per reply at full $3/M
      // ($0.328/reply) because ~34K tokens of brain were re-sent at full
      // price on every turn AND on every tool-use iteration within a
      // turn. digital_marketing, which has no brain documents, averaged
      // 17,156 tokens ($0.057/reply) doing the same job.
      //
      // The prefix is sent verbatim and in the SAME ORDER as before, so
      // the model sees exactly what it saw yesterday. This is a billing
      // change, not a behaviour change — nothing about what the bot
      // knows or says is altered.
      system: [
        {
          type: "text",
          text: args.systemPrompt,
          cache_control: { type: "ephemeral" },
        },
      ],
      messages,
    };
    if (args.moozCtx) params.tools = MOOZ_TOOL_DEFS;

    const raw = await callWithRetry(
      () => args.anthropic.messages.create(params),
      args.retry,
    );
    response = raw as unknown as AnthropicTurnResponse;
    accumulateUsage(totalUsage, response.usage);

    // No tools wired, or model finished its turn → exit.
    if (!args.moozCtx || response.stop_reason !== "tool_use") {
      break;
    }

    // Collect any tool_use blocks in this response. If for some reason
    // the model said tool_use but emitted no blocks, exit defensively.
    const toolUses = response.content.filter((b) => b.type === "tool_use") as Array<
      ContentBlock & { id: string; name: string; input: unknown }
    >;
    if (toolUses.length === 0) break;
    hadToolUse = true;

    // Per Anthropic's tool-use protocol: append the assistant's full
    // content (text + tool_use blocks) verbatim, then a single user
    // message containing all tool_result blocks for this round.
    messages.push({ role: "assistant", content: response.content as ContentBlock[] });
    // deno-lint-ignore no-explicit-any
    const toolResults: any[] = [];
    for (const tu of toolUses) {
      const out = await dispatchMoozTool(tu.name, tu.input, args.moozCtx);
      if (out.bookingCreated) bookingCreated = true;
      for (const t of out.offeredTimesIL) offeredTimesIL.add(t);
      toolResults.push({
        type: "tool_result",
        tool_use_id: tu.id,
        content: out.resultJson,
      });
    }
    messages.push({ role: "user", content: toolResults });
  }

  if (iterations >= MAX_TOOL_ITERATIONS && response.stop_reason === "tool_use") {
    throw new Error(`agentTurn: tool iteration cap (${MAX_TOOL_ITERATIONS}) reached without final reply`);
  }

  return {
    response,
    totalUsage,
    iterations,
    hadToolUse,
    bookingCreated,
    offeredTimesIL: Array.from(offeredTimesIL),
    finalMessages: messages,
  };
}

function accumulateUsage(acc: AgentTurnUsage, u: AnthropicTurnResponse["usage"]): void {
  if (!u) return;
  acc.inputTokens = (acc.inputTokens ?? 0) + (u.input_tokens ?? 0);
  acc.outputTokens = (acc.outputTokens ?? 0) + (u.output_tokens ?? 0);
  acc.cacheReadTokens = (acc.cacheReadTokens ?? 0) + (u.cache_read_input_tokens ?? 0);
  acc.cacheCreationTokens = (acc.cacheCreationTokens ?? 0) + (u.cache_creation_input_tokens ?? 0);
}
