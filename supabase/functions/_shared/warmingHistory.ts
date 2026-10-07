// warmingHistory.ts
//
// What a CRM-warmed lead's earlier conversation is allowed to contribute to
// the model's context. Pure, so it is testable under vitest like
// warmingContextBlock.ts.
//
// Why hide the old messages instead of instructing around them: history
// reaches the model without dates, so a slot search left open months ago reads
// as if it happened a minute ago. Live on status 22, the bot answered "all
// good, you?" by resuming exactly that thread — first with the stale times,
// then (after a guard rejected them) with "just before that — what drew you
// in?". A prompt rule telling it the old thread was closed did not hold. What
// the bot cannot see, it cannot resume.
//
// The stable facts the lead shared (age, motivation, goal...) are kept as a
// short background list so the bot does not re-ask what it already knows —
// process state (offered times, "awaiting an answer") deliberately is not.

export interface TimedMessage {
  role: "user" | "assistant";
  content: string;
  /** messages.timestamp, ISO. Null only for legacy rows. */
  timestamp: string | null;
}

export interface WarmingTrimResult {
  messages: TimedMessage[];
  /** How many earlier messages were withheld from the model. */
  hiddenCount: number;
}

/**
 * Keep only the messages from the current warming stage: everything at or
 * after the status event that started it (the opener and anything the lead
 * wrote since).
 *
 * Fails open to the untouched history when the cutoff is missing or invalid,
 * or when no message reaches it (e.g. a future-skewed CRM timestamp) — hiding
 * the very message we are replying to would be worse than today's behaviour.
 */
export function trimToWarmingStage(
  messages: TimedMessage[],
  cutoffIso: string | null,
): WarmingTrimResult {
  const untouched = { messages, hiddenCount: 0 };
  if (!cutoffIso) return untouched;
  const cutoff = new Date(cutoffIso).getTime();
  if (Number.isNaN(cutoff)) return untouched;

  const firstCurrent = messages.findIndex((message) => {
    if (!message.timestamp) return false;
    const at = new Date(message.timestamp).getTime();
    return !Number.isNaN(at) && at >= cutoff;
  });
  if (firstCurrent <= 0) return untouched;

  return { messages: messages.slice(firstCurrent), hiddenCount: firstCurrent };
}

/** The lead_memory columns that describe the person, not the process. */
export interface PriorProfileFields {
  q1_age: number | null;
  q2_motivation: string | null;
  q3_dream_change: string | null;
  q4_blocker: string | null;
  q5_urgency: string | null;
}

/**
 * Background lines for the warming block. Investment (q6) is left out on
 * purpose: it is money talk, and the guards silence any reply that drifts
 * into prices.
 */
export function buildPriorProfile(memory: PriorProfileFields | null): string[] {
  if (!memory) return [];
  const lines: string[] = [];
  if (typeof memory.q1_age === "number") lines.push(`Age: ${memory.q1_age}`);
  const textFields: Array<[string, string | null]> = [
    ["What drew them in", memory.q2_motivation],
    ["What they want to change", memory.q3_dream_change],
    ["What holds them back", memory.q4_blocker],
    ["How urgent it felt", memory.q5_urgency],
  ];
  for (const [label, value] of textFields) {
    const trimmed = value?.trim();
    if (trimmed) lines.push(`${label}: ${trimmed}`);
  }
  return lines;
}
