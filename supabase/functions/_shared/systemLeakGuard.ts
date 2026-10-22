// systemLeakGuard.ts
//
// Deterministic backstop: the bot must never narrate the machinery it runs on.
// Live on 2026-10-22 the qualification gate in moozTools blocked a booking and
// the bot told the lead, verbatim: "המערכת עצרה אותי כי לא עברתי כאן את שלב
// החימום ... לא מקבעים פגישה לפני שמבינים מה הליד באמת רוצה". Neither the
// regex guards nor the judge cover this — it is not a price, a promise or an
// AI disclosure — so it went out.
//
// Applies to every turn, not only warming: the gate can fire in any
// conversation. Patterns are narrow (internal vocabulary a lead never needs
// to hear) and avoid `\b`, which does not match around Hebrew letters in JS.

import { type ValidationResult } from "./validateAgentReply.ts";

export const SYSTEM_LEAK_REASON = "system_internals_leak";

const SYSTEM_LEAK_PATTERNS: ReadonlyArray<[label: string, pattern: RegExp]> = [
  // "המערכת עצרה/חסמה אותי", "המערכת לא מאפשרת לי"
  ["system_blocked", /המערכת\s+(?:עצרה|חסמה|מנעה|לא\s+(?:נותנת|מאפשרת|מרשה|נתנה|אפשרה))/],
  // "עצרו אותי", "חסמו אותי" — something stopped the bot.
  ["stopped_me", /(?:עצר|עצרה|עצרו|חסם|חסמה|חסמו)\s+אותי/],
  // The process stage itself: "שלב החימום", "לחמם אותך".
  ["warming_stage", /שלב\s+(?:ה)?חימום|לחמם\s+אות(?:ך|ו|ה)/],
  // "the lead" — how the operator talks about the person, never to them.
  // Only the definite "הליד": a bare or "ש"-prefixed ליד also means "next to".
  ["calls_them_lead", /(?:^|[\s,.(\-–—])הליד(?:ים)?(?=$|[\s,.!?:;)…])/],
  ["prompt_or_bot_rules", /פרומפט|(?:ה)?הנחיות\s+שקיבלתי|תוכנתתי/],
];

/** Label of the first leaked internal in `text`, or null. */
export function findSystemLeak(text: string): string | null {
  for (const [label, pattern] of SYSTEM_LEAK_PATTERNS) {
    if (pattern.test(text)) return label;
  }
  return null;
}

/**
 * Turn an otherwise-valid reply that narrates the system into a guard
 * rejection, so the handler's existing single retry rewrites it.
 *
 * First attempt only: if the retry still leaks, it is sent anyway — the
 * alternative is the lead getting silence or a fallback.
 */
export function withSystemLeakGuard(
  result: ValidationResult,
  opts: { isRetry: boolean },
): ValidationResult {
  if (!result.ok || opts.isRetry) return result;
  if (findSystemLeak(result.text) === null) return result;
  return { ok: false, reason: SYSTEM_LEAK_REASON };
}
