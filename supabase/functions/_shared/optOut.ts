// optOut.ts
//
// Detects explicit "stop messaging me" requests from inbound text. The
// webhook calls this BEFORE the agent loop fires; on match we tag the
// conversation `opted_out` + pause it and skip Claude entirely. This is
// also the legal angle — under Israeli spam regulation, a clear removal
// request must be honored without further messages.
//
// Conservative by design — match only unambiguous signals (whole-message
// or phrase-start). Side-channel meanings like "אל תפסיק להתקדם" must
// NOT trigger an opt-out.

const EXACT_TOKENS: ReadonlySet<string> = new Set([
  // Hebrew imperatives, on their own as a single-word reply
  "הסר",
  "להסיר",
  "תסיר",
  "תסירו",
  "הסירו",
  "הסרה",
  "להסרה",
  "תוריד",
  "תורידו",
  "תורידי",
  "תפסיק",
  "תפסיקו",
  "תפסיקי",
  "מחק",
  "מחקו",
  // English
  "stop",
  "unsubscribe",
]);

// Phrases anchored at the start of the message. Punctuation/whitespace
// between the verb and target lets "הסר אותי בבקשה" / "הסר אותי!" both
// match. The /u flag is required for the Hebrew character class to work.
const ANCHORED_PHRASES: ReadonlyArray<RegExp> = [
  /^הסר[\s,.!?]+אותי/u,
  /^הסירו?[\s,.!?]+אותי/u,
  /^תסירו?[\s,.!?]+אותי/u,
  /^תוריד[\s,.!?]+אותי/u,
  /^תורידו?[\s,.!?]+אותי/u,
  /^מחקו?[\s,.!?]+אותי/u,
  // A leading "לא" + removal request: the broadcast stop button
  // "לא, הסירו אותי" and its typed variants. The punctuation after "לא" is
  // required: without it "לא תסירו אותי" means "you won't remove me" and
  // "לא מחקו אותי מהקורס?" is a question (הסירו / מחקו are also past tense).
  /^לא\s*[,.!]+\s*(?:הסר|הסירו|הורד|הורידו|מחק|מחקו|תסיר|תסירו|תוריד|תורידו|תמחק|תמחקו)[\s,.!?]+אותי/u,
  // The bare imperative is accepted only as the whole message.
  /^לא\s+(?:הסר|הסירו|הורד|הורידו|מחק|מחקו)\s+אותי[.!]*$/u,
  /^תפסיק(?:ו|י)?[\s,.!?]+(?:לשלוח|להציק|להתקשר|לפנות)/u,
  /^(?:אל|לא)\s+(?:תשלח|תתקשר|תפנו|תפנה|תשלחו|תפריעו|תפריע)/u,
  /^stop\s+(?:messages|sending|messaging|me|all)/iu,
  /^unsubscribe\b/iu,
];

/**
 * Returns true when the inbound text is an explicit opt-out signal.
 * Pure — no side effects. The webhook decides what to do with `true`
 * (set tag, skip agent loop, log).
 */
export function isOptOutMessage(text: string): boolean {
  if (!text) return false;
  // Invisible direction / zero-width marks (RTL keyboards, button labels)
  // would otherwise defeat the ^ anchors.
  const trimmed = text.replace(/[\u200B-\u200F\u202A-\u202E\u2066-\u2069\uFEFF]/g, "").trim();
  if (!trimmed) return false;
  // Lowercase only the Latin-script comparison; Hebrew tokens are
  // case-insensitive on their own.
  const lowered = trimmed.toLowerCase();
  if (EXACT_TOKENS.has(trimmed) || EXACT_TOKENS.has(lowered)) return true;
  return ANCHORED_PHRASES.some((p) => p.test(trimmed));
}
