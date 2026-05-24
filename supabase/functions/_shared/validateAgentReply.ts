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
    pattern: /\b(ChatGPT|GPT[-\s]?[345]|OpenAI|Claude|Anthropic|Gemini|LLM|GPT)\b/i,
    reason: "ai_brand_leak",
  },
  // Hebrew "I am an AI / bot / language model" self-disclosure.
  {
    pattern: /אני\s*(?:AI|בוט|רובוט|מודל|בינה|תוכנה)/,
    reason: "hebrew_ai_self_disclosure",
  },
  {
    pattern: /(?:מודל\s*שפה|בינה\s*מלאכותית|מערכת\s*אוטומטית|זה\s*לא\s*בנאדם|לא\s*בן\s*אדם)/,
    reason: "hebrew_ai_self_disclosure",
  },
  // Currency symbols + Hebrew currency words. The prompt forbids any
  // price discussion — that has to happen on the Zoom with the advisor.
  // No \b on Hebrew tokens (see file header).
  {
    pattern: /[₪$€£]|ש["״']ח|שקלים?|דולר(?:ים)?|יורו/,
    reason: "currency_mention",
  },
  // Numeric prices without a currency symbol. Catches "5000", "5K", "5,000"
  // etc when they appear near price-related verbs/nouns. Common bypass: the
  // model says "התוכנית עולה 5000" — no ₪, but it IS pricing.
  //
  // The negative lookbehind `(?<![א-ת])` is REQUIRED because Hebrew does not
  // support \b in JS regex. Without it, "מעולה" (excellent) matches the
  // substring "עולה" and false-positives every "מעולה, 11:30..." reply
  // (incident: Kfir's test 2026-05-24 13:20 — bot got stuck because the
  // booking confirmation message was DLQ'd). Same trap for "תעלה" inside
  // "מתעלה" / "התעלה". The lookbehind says: only match these tokens when
  // they are NOT preceded by another Hebrew letter (i.e. they stand as
  // their own word).
  {
    pattern: /(?<![א-ת])(?:עולה|מחיר|תוכנית|השקעה|תשלום|חבילה|קורס|הכשרה|תעלה)[^.!?\n]{0,40}\d{2,}[\s]*(?:אלף|אלפים|K|k)?/,
    reason: "currency_mention",
  },
  // Standalone large numbers paired with money words (אלף / K / אלפים).
  {
    pattern: /\d{1,3}[\s,]*(?:אלף|אלפים|K\b|k\b)/,
    reason: "currency_mention",
  },
  // Income guarantees — narrow set of legally-binding terms ONLY.
  // "מובטח" (passive guarantee) and "ערבות" (warranty) are stop-words.
  // Note: "מבטיח" (active verb "promise") was REMOVED from this list
  // because the prompt teaches a nuanced "I can't promise X but I can
  // promise Y if you do Z" pattern that legitimately needs the verb.
  // Specific income amounts are still blocked by the currency rules above.
  {
    pattern: /מובטח(?:ת|ים|ות)?|ערבות/,
    reason: "income_guarantee",
  },
  {
    pattern: /(?:תרוויח|תכניס|תעשה|תרוויחי|תכניסי|תעשי)[^.!?\n]{0,40}(?:בחודש|בשנה|ביום|לחודש|לשנה|ליום)/,
    reason: "income_guarantee",
  },
];

export function findHallucinationReason(text: string): string | null {
  for (const rule of HALLUCINATION_RULES) {
    if (rule.pattern.test(text)) return rule.reason;
  }
  return null;
}

/** HH:MM time pattern. Catches "12:45", "14:30", "9:00", "09:30", and the
 *  most common forms an Israeli speaker would write. Bare time only — we
 *  do NOT block day names ("מחר", "ראשון") because the bot legitimately
 *  needs to ask "when is good?" without committing to a slot. */
const TIME_HH_MM_RE = /\b(?:[01]?\d|2[0-3]):[0-5]\d\b/;

export interface ValidateOptions {
  /** True when the assistant called a Mooz tool (list_available_slots or
   *  book_meeting) in this turn. When false, mentions of specific HH:MM
   *  times are blocked — the bot may not invent meeting times without
   *  a tool call backing them. */
  hasMoozToolUseThisTurn?: boolean;
}

export function validateAgentReply(
  raw: string | null | undefined,
  opts: ValidateOptions = {},
): ValidationResult {
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
  if (!opts.hasMoozToolUseThisTurn && TIME_HH_MM_RE.test(text)) {
    return { ok: false, reason: "invented_meeting_time" };
  }
  return { ok: true, text };
}
