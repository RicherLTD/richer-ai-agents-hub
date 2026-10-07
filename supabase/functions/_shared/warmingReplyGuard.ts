// warmingReplyGuard.ts
//
// Deterministic backstop for one tone rule of CRM warming: never announce
// the technique ("I'm not here to interrogate you", "no pressure"). It is
// written in the warming block and in several per-status instructions, and
// still went out live on status 50 ("רק אגיד - לא כאן כדי לחקור"). Naming
// the forbidden phrase in the prompt may even prime it, so a check on the
// output is the reliable layer.
//
// Scoped to warming turns only: normal traffic is untouched. Patterns avoid
// `\b`, which does not match around Hebrew letters in JS.

import { type ValidationResult } from "./validateAgentReply.ts";

export const WARMING_TECHNIQUE_REASON = "warming_announced_technique";

const ANNOUNCED_TECHNIQUE_PATTERNS: ReadonlyArray<[label: string, pattern: RegExp]> = [
  ["not_interrogating", /(?:לא|אינני)\s*(?:פה|כאן)\s*(?:כדי\s*)?(?:ל)?חקור/],
  ["no_pressure", /(?:בלי|אין)\s+(?:שום\s+)?לחץ/],
  ["not_selling", /לא\s+(?:מנסה|בא|באתי|פה)\s+(?:כדי\s+)?(?:למכור|לדחוף|ללחוץ)/],
  ["just_helping", /(?:אני\s+)?רק\s+רוצה\s+לעזור/],
];

/** Label of the first announced technique in `text`, or null. */
export function findAnnouncedTechnique(text: string): string | null {
  for (const [label, pattern] of ANNOUNCED_TECHNIQUE_PATTERNS) {
    if (pattern.test(text)) return label;
  }
  return null;
}

/**
 * Turn an otherwise-valid warming reply that announces its technique into a
 * guard rejection, so the handler's existing single retry rewrites it.
 *
 * Only on the first attempt: if the retry still announces, it is sent anyway,
 * because the alternative is the lead getting silence or a fallback.
 */
export function withWarmingReplyGuard(
  result: ValidationResult,
  opts: { isWarming: boolean; isRetry: boolean },
): ValidationResult {
  if (!result.ok || !opts.isWarming || opts.isRetry) return result;
  if (findAnnouncedTechnique(result.text) === null) return result;
  return { ok: false, reason: WARMING_TECHNIQUE_REASON };
}
