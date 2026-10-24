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
  /** The rule is about a NUMBER (a price, an income sum). When every number
   *  around the match is one the lead wrote themself ("my pension is 2,000
   *  ש"ח", "I need another 8,000 a month"), the bot is reflecting the lead's
   *  own words back, not quoting a price or promising income. */
  excusedByLeadNumbers?: boolean;
}

const HALLUCINATION_RULES: ReadonlyArray<HallucinationRule> = [
  // AI brand names — ASCII, so \b works fine.
  {
    pattern: /\b(ChatGPT|GPT[-\s]?[345]|OpenAI|Claude|Anthropic|Gemini|LLM|GPT)\b/i,
    reason: "ai_brand_leak",
  },
  // No Hebrew "I am a bot" rule. The policy is transparency: the prompt tells
  // the bot to say it is a digital agent when asked, and blocking exactly that
  // sentence turned every "are you a bot?" into a dead end — the lead got the
  // "I hit a glitch" fallback instead (13 operator alerts, Sep–Oct 2026).
  // Currency symbols + Hebrew currency words. The prompt forbids any
  // price discussion — that has to happen on the Zoom with the advisor.
  // No \b on Hebrew tokens (see file header).
  {
    pattern: /[₪$€£]|ש["״']ח|שקלים?|דולר(?:ים)?|יורו/,
    reason: "currency_mention",
    excusedByLeadNumbers: true,
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
  //
  // The trailing number group was tightened to avoid false-positives on
  // innocent 2-digit numbers (e.g. "התוכנית בנויה מ-12 שלבים", "בני 25"):
  // either a 4+ digit bare number (likely a price amount) OR a 2+ digit
  // number that is immediately followed by an explicit currency/unit token.
  {
    pattern: /(?<![א-ת])(?:עולה|מחיר|תוכנית|השקעה|תשלום|חבילה|קורס|הכשרה|תעלה)[^.!?\n]{0,40}(?:\d{4,}|\d{2,}[\s]*(?:אלף|אלפים|K\b|k\b|₪|\$|€|שקל(?:ים)?|ש["״']ח|דולר(?:ים)?))/,
    reason: "currency_mention",
    excusedByLeadNumbers: true,
  },
  // Standalone large numbers paired with money words (אלף / K / אלפים).
  // Tightened to avoid false-positives on non-price contexts like
  // "2 אלף לידים" or "300 אלף בוגרים": we require EITHER a price-context
  // word before the number (Alt A) OR an explicit currency symbol immediately
  // after (Alt B). A bare "X אלף" with no price anchor is allowed through.
  {
    pattern: /(?:(?:עולה|מחיר|תוכנית|השקעה|תשלום|חבילה|קורס|הכשרה|תעלה)[^.!?\n]{0,60}\d{1,3}[\s,]*(?:אלף|אלפים|K\b|k\b)|\d{1,3}[\s,]*(?:אלף|אלפים|K\b|k\b)\s*(?:₪|\$|€|שקל(?:ים)?|ש["״']ח|דולר(?:ים)?))/,
    reason: "currency_mention",
    excusedByLeadNumbers: true,
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
  // Income-verb + time-window without a concrete number: only fire when an
  // income-related word (כסף / הכנסה / סכום / הרבה / טוב / גדול) appears
  // between the verb and the time-window.  This prevents false-positives on
  // conditional/motivational language like "אם תעשה את זה כמו שצריך תראה
  // שינוי בחודש-חודשיים" (no income noun → not blocked) while still catching
  // qualitative promises like "תעשה הרבה כסף בשנה" or "תרוויחי טוב בחודש".
  {
    pattern: /(?:תרוויח|תכניס|תעשה|תרוויחי|תכניסי|תעשי)[^.!?\n]{0,40}(?:כסף|הכנסה|סכום|הרבה|טוב|גדול)[^.!?\n]{0,20}(?:בחודש|בשנה|ביום|לחודש|לשנה|ליום)/,
    reason: "income_guarantee",
  },
  // Income-verb + explicit number + time-window: catches "תרוויח 5000 בחודש"
  // regardless of what words appear around the number.
  {
    pattern: /(?:תרוויח|תכניס|תעשה|תרוויחי|תכניסי|תעשי)[^.!?\n]{0,40}\d+[^.!?\n]{0,20}(?:בחודש|בשנה|ביום|לחודש|לשנה|ליום)/,
    reason: "income_guarantee",
    excusedByLeadNumbers: true,
  },
];

/** Every number in `text`, separators dropped so "2,000" and "2000" match. */
function numbersIn(text: string): string[] {
  return (text.match(/\d[\d,.]*\d|\d/g) ?? []).map((n) => n.replace(/[,.]/g, ""));
}

/** How far around a match we look for the number it is about. */
const NUMBER_CONTEXT_CHARS = 15;

/**
 * True when every match of `rule` only restates numbers the lead wrote.
 * A match with no number nearby (a bare "שקלים") is never excused.
 */
function matchesOnlyLeadNumbers(
  text: string,
  rule: HallucinationRule,
  leadNumbers: ReadonlySet<string>,
): boolean {
  const flags = rule.pattern.flags.includes("g") ? rule.pattern.flags : rule.pattern.flags + "g";
  for (const m of text.matchAll(new RegExp(rule.pattern.source, flags))) {
    const start = Math.max(0, (m.index ?? 0) - NUMBER_CONTEXT_CHARS);
    const end = (m.index ?? 0) + m[0].length + NUMBER_CONTEXT_CHARS;
    const nums = numbersIn(text.slice(start, end));
    if (nums.length === 0 || nums.some((n) => !leadNumbers.has(n))) return false;
  }
  return true;
}

export function findHallucinationReason(text: string, leadText = ""): string | null {
  const leadNumbers = new Set(numbersIn(leadText));
  for (const rule of HALLUCINATION_RULES) {
    if (!rule.pattern.test(text)) continue;
    if (
      rule.excusedByLeadNumbers && leadNumbers.size > 0 &&
      matchesOnlyLeadNumbers(text, rule, leadNumbers)
    ) {
      continue;
    }
    return rule.reason;
  }
  return null;
}

/** HH:MM time pattern. Catches "12:45", "14:30", "9:00", "09:30", and the
 *  most common forms an Israeli speaker would write. Bare time only — we
 *  do NOT block day names ("מחר", "ראשון") because the bot legitimately
 *  needs to ask "when is good?" without committing to a slot.
 *
 *  `g` flag so we can enumerate EVERY time mentioned in a reply (the bot
 *  may offer two slots in one message) and check each one against the
 *  grounded allow-list. */
const TIME_HH_MM_RE = /\b(?:[01]?\d|2[0-3]):[0-5]\d\b/g;

/** Canonicalise an "HH:MM" token so "09:30" and "9:30" compare equal.
 *  Drops a leading zero on the hour; keeps the minute 2-digit. */
function normalizeHHMM(token: string): string {
  const m = /(\d{1,2}):([0-5]\d)/.exec(token);
  if (!m) return token;
  return `${parseInt(m[1], 10)}:${m[2]}`;
}

/** Every HH:MM time stated in `text`, canonicalised ("09:30" → "9:30"). */
export function meetingTimesIn(text: string): string[] {
  return (text.match(TIME_HH_MM_RE) ?? []).map(normalizeHHMM);
}

export interface ValidateOptions {
  /** The set of meeting times (Asia/Jerusalem "HH:MM") the bot is allowed
   *  to state THIS turn — every slot that came back from
   *  list_available_slots / book_meeting this turn, plus any existing
   *  booking time from the Mooz pre-check lookup. Any HH:MM in the reply
   *  that is NOT in this set is treated as an invented meeting time and
   *  blocked. Defaults to empty, so a reply that names a time without any
   *  tool grounding is always rejected — the bot may never invent times. */
  allowedMeetingTimes?: ReadonlyArray<string>;
  /** What the lead wrote in this conversation. Numbers the lead stated
   *  themself may be echoed back (see `excusedByLeadNumbers`). */
  leadText?: string;
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
  const hallucination = findHallucinationReason(text, opts.leadText);
  if (hallucination) {
    return { ok: false, reason: `hallucination_${hallucination}` };
  }
  // Invented-meeting-time guard. Grounded in the real Mooz tool results:
  // every HH:MM the bot states must be a slot that list_available_slots /
  // book_meeting actually returned this turn (or an existing booking from
  // the pre-check). A tool merely *running* is not enough — the model can
  // call list_available_slots, get [] or a set that excludes 21:30, and
  // then state 21:30 anyway. We compare each mentioned time against the
  // allow-list and reject any that wasn't offered.
  const stated = text.match(TIME_HH_MM_RE);
  if (stated && stated.length > 0) {
    const allowed = new Set((opts.allowedMeetingTimes ?? []).map(normalizeHHMM));
    for (const t of stated) {
      if (!allowed.has(normalizeHHMM(t))) {
        return { ok: false, reason: "invented_meeting_time" };
      }
    }
  }
  return { ok: true, text };
}
