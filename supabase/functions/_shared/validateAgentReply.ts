// validateAgentReply.ts
//
// Sanity check on Claude's reply before we send it to a lead. Catches:
//   - empty / absurd-length output
//   - placeholder token leaks from prompt rendering bugs
//   - hallucination tells the prompt forbids (AI self-disclosure,
//     currency mentions, income guarantees)
//
// Hebrew note: `\b` in JS regex only fires between ASCII word chars and
// non-word chars. Hebrew code points are NOT word chars under JS regex
// semantics, so `\b` is effectively useless inside Hebrew text. We
// therefore drop word boundaries on Hebrew patterns and accept the
// slight chance of a substring false-positive (rare in practice — the
// trigger words like "מובטח" / "שקלים" don't tend to appear as
// substrings of innocent Hebrew vocabulary).

export type ValidationResult =
  | { ok: true; text: string }
  | { ok: false; reason: string };

const MIN_REPLY_CHARS = 2;
const MAX_REPLY_CHARS = 1500;

const PLACEHOLDER_RE = /\[MISSING\]|\[UNKNOWN\]|\[TODO\]|\[PLACEHOLDER\]|\{\{[^}]+\}\}|<[A-Z_]+>/;

interface HallucinationRule {
  pattern: RegExp;
  reason: string;
}

const HALLUCINATION_RULES: ReadonlyArray<HallucinationRule> = [
  // AI brand names — ASCII, so \b works fine.
  {
    pattern: /\b(ChatGPT|GPT[-\s]?[345]|OpenAI|Claude|Anthropic|Gemini)\b/i,
    reason: "ai_brand_leak",
  },
  // Hebrew "I am an AI / bot / language model" self-disclosure.
  {
    pattern: /אני\s*(?:AI|בוט|רובוט|מודל|בינה|תוכנה)/,
    reason: "hebrew_ai_self_disclosure",
  },
  {
    pattern: /(?:מודל\s*שפה|בינה\s*מלאכותית)/,
    reason: "hebrew_ai_self_disclosure",
  },
  // Currency symbols + Hebrew currency words. The prompt forbids any
  // price discussion — that has to happen on the Zoom with the advisor.
  // No \b on Hebrew tokens (see file header).
  {
    pattern: /[₪$€£]|ש["״']ח|שקלים?|דולר(?:ים)?|יורו/,
    reason: "currency_mention",
  },
  // Income guarantees and "earn X" promises. Match any inflection of
  // מובטח / מבטיח plus ערבות.
  {
    pattern: /מובטח(?:ת|ים|ות)?|מבטיח(?:ה|ים|ות)?|ערבות/,
    reason: "income_guarantee",
  },
];

export function findHallucinationReason(text: string): string | null {
  for (const rule of HALLUCINATION_RULES) {
    if (rule.pattern.test(text)) return rule.reason;
  }
  return null;
}

export function validateAgentReply(raw: string | null | undefined): ValidationResult {
  if (raw == null) {
    return { ok: false, reason: "reply_is_null" };
  }
  const text = raw.trim();
  if (text.length < MIN_REPLY_CHARS) {
    return { ok: false, reason: "reply_too_short" };
  }
  if (text.length > MAX_REPLY_CHARS) {
    return { ok: false, reason: "reply_too_long" };
  }
  if (PLACEHOLDER_RE.test(text.toUpperCase())) {
    return { ok: false, reason: "reply_contains_placeholder" };
  }
  const hallucination = findHallucinationReason(text);
  if (hallucination) {
    return { ok: false, reason: `hallucination_${hallucination}` };
  }
  return { ok: true, text };
}
