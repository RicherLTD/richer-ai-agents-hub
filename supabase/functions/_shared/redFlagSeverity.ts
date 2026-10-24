// redFlagSeverity.ts
//
// Which memory-extractor red flags should silence the bot, and which are just
// notes for the advisor.
//
// Until 2026-10-07 ANY red flag tagged the lead `requires_human`, which mutes
// the agent loop, and nothing alerted an operator. 165 live conversations sat
// in that state, about 110 with the lead's last message unanswered, many over
// flags like "procrastination" or "no_computer". In CRM warming it also
// killed the strategy for statuses whose whole point is handling distrust: a
// lead saying "I got burned by a course" was flagged and went unanswered.
//
// The extractor writes free-form flags (snake_case English or Hebrew), so
// this classifies by keyword. Order of checks:
//   1. wellbeing / health / minors          → sensitive, always
//   2. past experiences and attitudes        → note
//   3. current financial distress            → sensitive ONLY when it is
//      serious (the 2026-05-19 Hodaya rule: serious financial distress gets a
//      human, never an automatic Zoom). "Serious" = the flag itself names
//      debt / crisis, or the lead actually wrote about debts, foreclosure,
//      loans, a blocked card, or living on a disability allowance.
//      A plain "I have no money to invest" is the money OBJECTION the bot is
//      built to handle. Until 2026-10-25 the extractor labelled it
//      "financial_distress", which muted the bot — 19 of 25 red-flag alerts
//      in October were leads left with no reply at all, most of them over
//      exactly that sentence.
//   4. anything else                         → note
// Underage keeps its own tag in decideConversationTag; it is listed here too
// so a split never files it as a note.

// "mental" only with a separator after it: "get-rich-quick mentality" is an
// attitude, not a wellbeing signal.
const WELLBEING = [
  "underage", "minor", "mental_", "mental ", "mental-", "suicid", "self-harm", "self_harm", "harm",
  "health", "medical", "abuse", "violence", "threat", "panic", "hopeless", "desperat",
  "קטין", "צבא", "נפש", "רגש", "דיכאון", "אובדנ", "בריאות", "מחלה", "אלימות", "איום",
  "פגיעה", "מצוקה", "ייאוש", "פאניקה",
];

const PAST_OR_ATTITUDE = [
  "past", "scam", "returns", "already invested", "skeptic", "get-rich", "get_rich",
  "procrastinat", "boundar", "religious", "computer",
  "נכווה", "עקיצה", "בעבר", "סקפט", "דתי",
];

/** Serious on the flag's own words. */
const SERIOUS_FINANCIAL = [
  "critical", "crisis", "debt", "foreclos", "bankrupt", "eviction",
  "קריטי", "משבר", "חוב", "עיקול", "הוצאה לפועל", "פשיטת רגל", "חרדה",
];

/** Generic distress labels — the extractor puts these on a money objection
 *  too, so they need evidence in what the lead wrote. */
const GENERIC_FINANCIAL = ["vulnerable", "distress", "stress"];

/** What a lead in real financial trouble writes. No `\b` (Hebrew); the
 *  lookbehind keeps "חוב" from matching inside "רחוב". */
const SERIOUS_FINANCIAL_EVIDENCE =
  /(?<![א-ת])[ובלמשה]?חובות|(?<![א-ת])[ובלמשה]?חוב(?![א-ת])|עיקול|הוצאה לפועל|פשיטת רגל|הלוואה|הלוואות|במינוס|חסמו לי|לא (?:מצליח|מצליחה) לשלם|אין לי מה לאכול|ביטוח לאומי|קצבת|נכות/;

/** True when the lead's own words show serious financial trouble. */
export function hasSeriousFinancialEvidence(leadText: string): boolean {
  return SERIOUS_FINANCIAL_EVIDENCE.test(leadText);
}

function includesAny(text: string, needles: ReadonlyArray<string>): boolean {
  return needles.some((needle) => text.includes(needle));
}

/**
 * @param leadText what the lead wrote in the conversation. Decides whether a
 *   generic financial flag is serious; omit it and generic flags are notes.
 */
export function isSensitiveRedFlag(flag: string, leadText = ""): boolean {
  const text = flag.toLowerCase();
  if (includesAny(text, WELLBEING)) return true;
  if (includesAny(text, PAST_OR_ATTITUDE)) return false;
  if (includesAny(text, SERIOUS_FINANCIAL)) return true;
  return includesAny(text, GENERIC_FINANCIAL) && hasSeriousFinancialEvidence(leadText);
}

export function splitRedFlags(flags: ReadonlyArray<string>, leadText = ""): {
  sensitive: string[];
  notes: string[];
} {
  const sensitive: string[] = [];
  const notes: string[] = [];
  for (const flag of flags) (isSensitiveRedFlag(flag, leadText) ? sensitive : notes).push(flag);
  return { sensitive, notes };
}
