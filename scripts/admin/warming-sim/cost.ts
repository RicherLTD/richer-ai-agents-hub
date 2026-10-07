// Token and cost bookkeeping with a hard budget. Sonnet pricing is reused from
// the production module; Haiku (the judge) is priced here.

import { computeSonnet46Cost } from "../../../supabase/functions/_shared/langfuse.ts";

export const SONNET_MODEL = "claude-sonnet-4-6";
export const HAIKU_MODEL = "claude-haiku-4-5";

/** Haiku 4.5 list prices, USD per token ($1 / $5 per million, cache read 10%, 5-minute write 125%). */
const HAIKU_PRICING = {
  input: 0.000001,
  output: 0.000005,
  cacheRead: 0.0000001,
  cacheCreation: 0.00000125,
} as const;

export interface UsageTokens {
  inputTokens: number;
  outputTokens: number;
  cacheReadTokens: number;
  cacheCreationTokens: number;
}

/** The usage object shape returned by the Anthropic API. */
export interface ApiUsage {
  input_tokens?: number;
  output_tokens?: number;
  cache_read_input_tokens?: number;
  cache_creation_input_tokens?: number;
}

export class BudgetExceededError extends Error {
  constructor(public readonly spentUsd: number, public readonly limitUsd: number) {
    super(`cost limit reached: $${spentUsd.toFixed(2)} spent of $${limitUsd.toFixed(2)}`);
  }
}

export function toUsageTokens(usage: ApiUsage | undefined): UsageTokens {
  return {
    inputTokens: usage?.input_tokens ?? 0,
    outputTokens: usage?.output_tokens ?? 0,
    cacheReadTokens: usage?.cache_read_input_tokens ?? 0,
    cacheCreationTokens: usage?.cache_creation_input_tokens ?? 0,
  };
}

export function costOf(model: string, usage: UsageTokens): number {
  if (model !== HAIKU_MODEL) return computeSonnet46Cost(usage);
  return (
    usage.inputTokens * HAIKU_PRICING.input +
    usage.outputTokens * HAIKU_PRICING.output +
    usage.cacheReadTokens * HAIKU_PRICING.cacheRead +
    usage.cacheCreationTokens * HAIKU_PRICING.cacheCreation
  );
}

export interface CostSnapshot extends UsageTokens {
  costUsd: number;
  calls: number;
}

/** Accumulates spend. A child tracker also feeds its parent, so each scenario
 *  has its own total while the run enforces one shared limit. */
export class CostTracker {
  private snapshot: CostSnapshot = {
    inputTokens: 0, outputTokens: 0, cacheReadTokens: 0, cacheCreationTokens: 0, costUsd: 0, calls: 0,
  };

  constructor(
    private readonly limitUsd: number,
    private readonly parent: CostTracker | null = null,
  ) {}

  child(): CostTracker {
    return new CostTracker(this.limitUsd, this);
  }

  get total(): CostSnapshot {
    return { ...this.snapshot };
  }

  /** Call before every model request, so a run stops cleanly past the limit. */
  assertWithinBudget(): void {
    const root = this.root();
    if (root.snapshot.costUsd >= this.limitUsd) {
      throw new BudgetExceededError(root.snapshot.costUsd, this.limitUsd);
    }
  }

  record(model: string, usage: ApiUsage | undefined): void {
    const tokens = toUsageTokens(usage);
    this.snapshot.inputTokens += tokens.inputTokens;
    this.snapshot.outputTokens += tokens.outputTokens;
    this.snapshot.cacheReadTokens += tokens.cacheReadTokens;
    this.snapshot.cacheCreationTokens += tokens.cacheCreationTokens;
    this.snapshot.costUsd += costOf(model, tokens);
    this.snapshot.calls += 1;
    this.parent?.record(model, usage);
  }

  private root(): CostTracker {
    return this.parent ? this.parent.root() : this;
  }
}
