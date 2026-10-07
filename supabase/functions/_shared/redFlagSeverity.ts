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
//   3. current financial distress            → sensitive (the 2026-05-19
//      Hodaya rule: serious financial distress gets a human, never an
//      automatic Zoom)
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

const FINANCIAL_DISTRESS = [
  "vulnerable", "distress", "stress", "critical", "crisis", "debt",
  "קריטי", "משבר", "חובות", "חרדה",
];

function includesAny(text: string, needles: ReadonlyArray<string>): boolean {
  return needles.some((needle) => text.includes(needle));
}

export function isSensitiveRedFlag(flag: string): boolean {
  const text = flag.toLowerCase();
  if (includesAny(text, WELLBEING)) return true;
  if (includesAny(text, PAST_OR_ATTITUDE)) return false;
  return includesAny(text, FINANCIAL_DISTRESS);
}

export function splitRedFlags(flags: ReadonlyArray<string>): {
  sensitive: string[];
  notes: string[];
} {
  const sensitive: string[] = [];
  const notes: string[] = [];
  for (const flag of flags) (isSensitiveRedFlag(flag) ? sensitive : notes).push(flag);
  return { sensitive, notes };
}
