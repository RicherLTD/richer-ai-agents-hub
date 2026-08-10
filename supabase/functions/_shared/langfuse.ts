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
  /** Extra trace tags appended after the success/failure tag. Used by CRM
   *  warming to stamp `warming`, `status:<n>` and `objection:<key>` so an
   *  operator can filter Langfuse to "every conversation triggered by status
   *  60" and read what the bot actually said. Empty for a normal lead. */
  extraTags?: ReadonlyArray<string>;
}

/** A verdict attached after the fact to a trace, an observation, or a
 *  whole session. `dataType` is inferred by Langfuse when omitted, but we
 *  pass it explicitly so a boolean 0/1 never renders as a numeric average
 *  of something meaningless. */
export interface LangfuseScore {
  name: string;
  value: number | string;
  dataType?: "NUMERIC" | "CATEGORICAL" | "BOOLEAN" | "TEXT";
  comment?: string;
  /** Attach to a single step rather than the whole turn. */
  observationId?: string;
}

/** A model call that is NOT the main agent reply — the judge, the memory
 *  extractor — recorded as a step inside an existing turn trace. */
export interface ChildGenerationInput {
  traceId: string;
  name: string;
  model: string;
  startTime: Date;
  endTime: Date;
  input: unknown;
  output: unknown;
  usage?: AnthropicUsage;
  metadata?: Record<string, unknown>;
  level?: "DEFAULT" | "WARNING" | "ERROR";
  statusMessage?: string;
}

/** A non-model step inside a turn — a Mooz tool call, a guard check. */
export interface ChildSpanInput {
  traceId: string;
  name: string;
  startTime: Date;
  endTime: Date;
  input?: unknown;
  output?: unknown;
  metadata?: Record<string, unknown>;
  level?: "DEFAULT" | "WARNING" | "ERROR";
  statusMessage?: string;
}

export type IngestionFailureHandler = (
  detail: { status: number; body: string },
) => Promise<void> | void;

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
    const tags = [
      input.failureTag ? input.failureTag : "success",
      ...(input.extraTags ?? []),
    ];

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

    const ok = await this.ingest(events, onFailure);
    return ok ? traceId : null;
  }

  /**
   * Attach scores to an existing trace, observation, or session. This is
   * the "good answer / bad answer" ledger — the thing that makes replies
   * comparable after the fact.
   *
   * `sessionId` scores a whole Conversation (used for outcomes that only
   * become known days later, e.g. a Bot-Booked Zoom); `traceId` scores one
   * turn. Pass exactly one of them.
   */
  async recordScores(
    target: { traceId: string } | { sessionId: string },
    scores: ReadonlyArray<LangfuseScore>,
    onFailure?: IngestionFailureHandler,
  ): Promise<boolean> {
    if (scores.length === 0) return true;
    const now = new Date().toISOString();
    const events = scores.map((s) => ({
      id: crypto.randomUUID(),
      type: "score-create",
      timestamp: now,
      body: {
        id: crypto.randomUUID(),
        ...("traceId" in target ? { traceId: target.traceId } : { sessionId: target.sessionId }),
        ...(s.observationId ? { observationId: s.observationId } : {}),
        name: s.name,
        value: s.value,
        ...(s.dataType ? { dataType: s.dataType } : {}),
        ...(s.comment ? { comment: s.comment.slice(0, 500) } : {}),
      },
    }));
    return await this.ingest(events, onFailure);
  }

  /**
   * Record a model call that happened inside an existing turn — the judge
   * or the memory extractor. Returns the observation id so a score can be
   * attached to that specific step.
   */
  async recordChildGeneration(
    input: ChildGenerationInput,
    onFailure?: IngestionFailureHandler,
  ): Promise<string | null> {
    const observationId = crypto.randomUUID();
    const events = [{
      id: crypto.randomUUID(),
      type: "generation-create",
      timestamp: input.endTime.toISOString(),
      body: {
        id: observationId,
        traceId: input.traceId,
        name: input.name,
        startTime: input.startTime.toISOString(),
        endTime: input.endTime.toISOString(),
        model: input.model,
        input: input.input,
        output: input.output,
        ...(input.usage
          ? {
            usage: {
              input: input.usage.inputTokens ?? 0,
              output: input.usage.outputTokens ?? 0,
              total: (input.usage.inputTokens ?? 0) + (input.usage.outputTokens ?? 0),
              unit: "TOKENS",
            },
          }
          : {}),
        ...(input.metadata ? { metadata: input.metadata } : {}),
        ...(input.level ? { level: input.level } : {}),
        ...(input.statusMessage ? { statusMessage: input.statusMessage.slice(0, 500) } : {}),
      },
    }];
    const ok = await this.ingest(events, onFailure);
    return ok ? observationId : null;
  }

  /**
   * Record non-model steps inside a turn — Mooz tool calls, for instance.
   * Batched into a single request because a turn can make several.
   */
  async recordSpans(
    spans: ReadonlyArray<ChildSpanInput>,
    onFailure?: IngestionFailureHandler,
  ): Promise<boolean> {
    if (spans.length === 0) return true;
    const events = spans.map((s) => ({
      id: crypto.randomUUID(),
      type: "span-create",
      timestamp: s.endTime.toISOString(),
      body: {
        id: crypto.randomUUID(),
        traceId: s.traceId,
        name: s.name,
        startTime: s.startTime.toISOString(),
        endTime: s.endTime.toISOString(),
        ...(s.input !== undefined ? { input: s.input } : {}),
        ...(s.output !== undefined ? { output: s.output } : {}),
        ...(s.metadata ? { metadata: s.metadata } : {}),
        ...(s.level ? { level: s.level } : {}),
        ...(s.statusMessage ? { statusMessage: s.statusMessage.slice(0, 500) } : {}),
      },
    }));
    return await this.ingest(events, onFailure);
  }

  /** POST a batch of ingestion events. Never throws — tracing must never
   *  break the agent loop or delay a reply to a lead. */
  private async ingest(
    events: ReadonlyArray<unknown>,
    onFailure?: IngestionFailureHandler,
  ): Promise<boolean> {
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
        return false;
      }
      return true;
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      console.warn(`[langfuse] exception during ingestion: ${msg}`);
      if (onFailure) await onFailure({ status: 0, body: msg });
      return false;
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
