// The handler's guard-retry loop (whatsappWebhookHandler.ts, `for attempt < 2`):
// generate, validateAgentReply, judgeReply, and on a rejection retry ONCE with
// the reason-aware hint appended to the system prompt. After two rejections
// the lead gets nothing.
//
// Model calls are injected so the loop is testable without Anthropic.

import { buildGuardHint } from "../../../supabase/functions/_shared/guardHint.ts";
import { validateAgentReply } from "../../../supabase/functions/_shared/validateAgentReply.ts";
import { withWarmingReplyGuard } from "../../../supabase/functions/_shared/warmingReplyGuard.ts";
import { AGENT_FALLBACK_REPLY, sanitizeDashes, type TranscriptEntry } from "./transcript.ts";

const MAX_GUARD_ATTEMPTS = 2;

export interface GeneratedReply {
  /** First text block of the model's final response, or null when it had none. */
  rawReply: string | null;
  /** Asia/Jerusalem HH:MM times the stubbed tools surfaced this attempt. */
  offeredTimesIL: string[];
  /** Visible "[tool: ...]" lines, in call order. */
  toolLines: string[];
}

export interface JudgeVerdictLike {
  ok: boolean;
  reason: string;
}

export interface GuardedReplyDeps {
  generate: (systemPrompt: string) => Promise<GeneratedReply>;
  judge: (text: string) => Promise<JudgeVerdictLike>;
}

export interface GuardedReplyResult {
  /** Sanitized reply, or null when nothing reaches the lead. */
  reply: string | null;
  /** True when `reply` is the fixed apology sent after two rejections. */
  isFallback: boolean;
  /** Why both attempts were rejected; null when a real reply went out. */
  failureReason: string | null;
  attempts: number;
  events: TranscriptEntry[];
}

function toolEntries(lines: ReadonlyArray<string>): TranscriptEntry[] {
  return lines.map((text) => ({ kind: "tool", text }));
}

export interface GuardedReplyOptions {
  /** warmingBlock !== "" in the handler. */
  isWarming: boolean;
  /** The handler skips the apology when it is already the last outbound. */
  alreadyApologised: boolean;
}

export async function runGuardedReply(
  deps: GuardedReplyDeps,
  systemPrompt: string,
  options: GuardedReplyOptions,
): Promise<GuardedReplyResult> {
  const events: TranscriptEntry[] = [];
  let guardHint = "";
  let lastReason = "unknown";

  for (let attempt = 0; attempt < MAX_GUARD_ATTEMPTS; attempt++) {
    const generated = await deps.generate(systemPrompt + guardHint);
    events.push(...toolEntries(generated.toolLines));

    // Same wrapping as the handler: warming turns also reject an announced
    // technique on the first attempt.
    const validation = withWarmingReplyGuard(
      validateAgentReply(generated.rawReply, { allowedMeetingTimes: generated.offeredTimesIL }),
      { isWarming: options.isWarming, isRetry: attempt > 0 },
    );
    if (!validation.ok) {
      lastReason = validation.reason;
      events.push({ kind: "guard", text: `validateAgentReply rejected attempt ${attempt}: ${validation.reason}` });
      guardHint = buildGuardHint(validation.reason, generated.offeredTimesIL);
      continue;
    }

    const verdict = await deps.judge(validation.text);
    if (!verdict.ok) {
      lastReason = verdict.reason;
      events.push({ kind: "guard", text: `judgeReply rejected attempt ${attempt}: ${verdict.reason}` });
      guardHint = buildGuardHint(verdict.reason, generated.offeredTimesIL);
      continue;
    }

    return { reply: sanitizeDashes(validation.text), isFallback: false, failureReason: null, attempts: attempt + 1, events };
  }

  if (options.alreadyApologised) {
    events.push({ kind: "silence", text: `SILENCE (guard: ${lastReason}; apology already sent)` });
    return { reply: null, isFallback: false, failureReason: lastReason, attempts: MAX_GUARD_ATTEMPTS, events };
  }
  events.push({ kind: "fallback", text: `FALLBACK (guard: ${lastReason})` });
  return { reply: AGENT_FALLBACK_REPLY, isFallback: true, failureReason: lastReason, attempts: MAX_GUARD_ATTEMPTS, events };
}
