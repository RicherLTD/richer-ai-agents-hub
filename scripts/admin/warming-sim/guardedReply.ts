// The handler's guard-retry loop (whatsappWebhookHandler.ts, `for attempt < 2`):
// generate, validateAgentReply, judgeReply, and on a rejection retry ONCE with
// the reason-aware hint appended to the system prompt. After two rejections
// the lead gets nothing.
//
// Model calls are injected so the loop is testable without Anthropic.

import { buildGuardHint } from "../../../supabase/functions/_shared/guardHint.ts";
import { validateAgentReply } from "../../../supabase/functions/_shared/validateAgentReply.ts";
import { sanitizeDashes, type TranscriptEntry } from "./transcript.ts";

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
  /** Sanitized reply, or null when both attempts were rejected (silence). */
  reply: string | null;
  silenceReason: string | null;
  attempts: number;
  events: TranscriptEntry[];
}

function toolEntries(lines: ReadonlyArray<string>): TranscriptEntry[] {
  return lines.map((text) => ({ kind: "tool", text }));
}

export async function runGuardedReply(
  deps: GuardedReplyDeps,
  systemPrompt: string,
): Promise<GuardedReplyResult> {
  const events: TranscriptEntry[] = [];
  let guardHint = "";
  let lastReason = "unknown";

  for (let attempt = 0; attempt < MAX_GUARD_ATTEMPTS; attempt++) {
    const generated = await deps.generate(systemPrompt + guardHint);
    events.push(...toolEntries(generated.toolLines));

    const validation = validateAgentReply(generated.rawReply, {
      allowedMeetingTimes: generated.offeredTimesIL,
    });
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

    return { reply: sanitizeDashes(validation.text), silenceReason: null, attempts: attempt + 1, events };
  }

  events.push({ kind: "silence", text: `SILENCE (guard: ${lastReason})` });
  return { reply: null, silenceReason: lastReason, attempts: MAX_GUARD_ATTEMPTS, events };
}
