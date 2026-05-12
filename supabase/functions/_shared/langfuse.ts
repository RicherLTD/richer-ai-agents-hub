// langfuse.ts
//
// Minimal Langfuse client for edge functions. Sends one trace + one
// generation per agent turn via the Langfuse public ingestion API.
//
// Why not use the official SDK?
//   The Langfuse JS SDK runs fine in Node and browsers but has rough
//   edges in Deno (auto-flush timers, lifecycle hooks, npm shims). For
//   our needs — a single fire-and-forget POST per agent turn — a 60-line
//   wrapper is simpler, has zero deps, and never blocks the agent loop.
//
// Never throws. If Langfuse is down or env is missing, we log a warn
// and return null; the message still gets sent to the lead and recorded
// in the DB, just without a trace_id.

export interface LangfuseConfig {
  publicKey: string;
  secretKey: string;
  baseUrl: string;
}

export interface AnthropicUsage {
  inputTokens?: number;
  outputTokens?: number;
  cacheReadTokens?: number;
  cacheCreationTokens?: number;
}

export interface AgentTurnTraceInput {
  agentId: string;
  conversationId: string;
  leadPhone: string;
  promptVersion: string;
  promptVersionId: string;
  model: string;
  systemPrompt: string;
  claudeMessages: ReadonlyArray<{ role: "user" | "assistant"; content: string }>;
  startTime: Date;
  endTime: Date;
  /** The reply text if generation succeeded; otherwise a short failure marker. */
  output: string;
  usage: AnthropicUsage;
  /** Tag the trace as a failure mode (validation reason, API error, etc.). */
  failureTag?: string;
}

const SONNET_46_PRICING = {
  inputFresh: 0.000003, // $3 / M tokens
  output: 0.000015, // $15 / M tokens
  cacheCreation: 0.00000375, // $3.75 / M (5-minute cache write)
  cacheRead: 0.0000003, // $0.30 / M
} as const;

/** Cost in USD for a Claude Sonnet 4.6 turn given its token usage. */
export function computeSonnet46Cost(usage: AnthropicUsage): number {
  return (
    (usage.inputTokens ?? 0) * SONNET_46_PRICING.inputFresh +
    (usage.outputTokens ?? 0) * SONNET_46_PRICING.output +
    (usage.cacheReadTokens ?? 0) * SONNET_46_PRICING.cacheRead +
    (usage.cacheCreationTokens ?? 0) * SONNET_46_PRICING.cacheCreation
  );
}

export class Langfuse {
  constructor(private config: LangfuseConfig) {}

  /**
   * Record one agent turn as a trace + generation in Langfuse Cloud.
   * Returns the trace id on success, null on any failure.
   *
   * Failure details are returned via the optional `onFailure` callback so
   * the caller can route them to error_logs (Supabase MCP get_logs only
   * exposes top-level HTTP request logs, not stderr from inside the
   * fire-and-forget background task).
   */
  async traceAgentTurn(
    input: AgentTurnTraceInput,
    onFailure?: (detail: { status: number; body: string }) => Promise<void> | void,
  ): Promise<string | null> {
    const traceId = crypto.randomUUID();
    const generationId = crypto.randomUUID();
    const lastUserMessage = input.claudeMessages[input.claudeMessages.length - 1]?.content
      ?? null;
    const tags = input.failureTag ? [input.failureTag] : ["success"];

    const events = [
      {
        id: crypto.randomUUID(),
        type: "trace-create",
        timestamp: input.endTime.toISOString(),
        body: {
          id: traceId,
          name: "agent-turn",
          userId: input.leadPhone,
          sessionId: input.conversationId,
          input: lastUserMessage,
          output: input.output,
          tags,
          metadata: {
            agentId: input.agentId,
            promptVersion: input.promptVersion,
            promptVersionId: input.promptVersionId,
          },
        },
      },
      {
        id: crypto.randomUUID(),
        type: "generation-create",
        timestamp: input.endTime.toISOString(),
        body: {
          id: generationId,
          traceId,
          name: "claude-reply",
          startTime: input.startTime.toISOString(),
          endTime: input.endTime.toISOString(),
          model: input.model,
          modelParameters: { max_tokens: 1024, thinking: "adaptive" },
          input: { system: input.systemPrompt, messages: input.claudeMessages },
          output: input.output,
          usage: {
            input: input.usage.inputTokens ?? 0,
            output: input.usage.outputTokens ?? 0,
            total: (input.usage.inputTokens ?? 0) + (input.usage.outputTokens ?? 0),
            unit: "TOKENS",
          },
          metadata: {
            cacheReadTokens: input.usage.cacheReadTokens ?? 0,
            cacheCreationTokens: input.usage.cacheCreationTokens ?? 0,
          },
        },
      },
    ];

    try {
      const auth = btoa(`${this.config.publicKey}:${this.config.secretKey}`);
      const url = `${this.config.baseUrl.replace(/\/$/, "")}/api/public/ingestion`;
      const response = await fetch(url, {
        method: "POST",
        headers: {
          Authorization: `Basic ${auth}`,
          "Content-Type": "application/json",
        },
        body: JSON.stringify({ batch: events }),
      });
      if (!response.ok) {
        const errBody = await response.text().catch(() => "");
        const detail = { status: response.status, body: errBody.slice(0, 500) };
        console.warn(`[langfuse] ingestion failed`, detail);
        if (onFailure) await onFailure(detail);
        return null;
      }
      return traceId;
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      console.warn(`[langfuse] exception during ingestion: ${msg}`);
      if (onFailure) await onFailure({ status: 0, body: msg });
      return null;
    }
  }
}

/**
 * Build a Langfuse client from edge-function env vars. Returns null if
 * any required key is missing — the caller should treat that as "tracing
 * disabled" and proceed without it.
 */
export function langfuseFromEnv(): Langfuse | null {
  const publicKey = Deno.env.get("LANGFUSE_PUBLIC_KEY");
  const secretKey = Deno.env.get("LANGFUSE_SECRET_KEY");
  const baseUrl = Deno.env.get("LANGFUSE_BASE_URL");
  if (!publicKey || !secretKey || !baseUrl) return null;
  return new Langfuse({ publicKey, secretKey, baseUrl });
}
