// The record of one simulated conversation, shared by the runner, the grader
// and the report.

export type TranscriptEntry =
  | { kind: "opener"; text: string }
  | { kind: "lead"; text: string }
  | { kind: "bot"; text: string; attempts: number }
  | { kind: "tool"; text: string }
  | { kind: "guard"; text: string }
  | { kind: "silence"; text: string }
  | { kind: "fallback"; text: string };

const SPEAKER_LABEL: Record<TranscriptEntry["kind"], string> = {
  opener: "BOT (opener template)",
  lead: "LEAD",
  bot: "BOT",
  tool: "TOOL",
  guard: "GUARD",
  silence: "BOT",
  fallback: "BOT",
};

/**
 * Mirror of AGENT_FALLBACK_REPLY in whatsappWebhookHandler.ts (not exported
 * there): what production sends the lead when both guard attempts fail.
 */
export const AGENT_FALLBACK_REPLY =
  "סליחה, נתקלתי בתקלה קטנה מהצד שלי 🙏 העברתי את זה לנציג שיחזור אליך ממש בקרוב.";

/** Plain-text form fed to the lead actor and the grader. */
export function formatTranscript(entries: ReadonlyArray<TranscriptEntry>): string {
  return entries.map((entry) => `${SPEAKER_LABEL[entry.kind]}: ${entry.text}`).join("\n");
}

/** The dash sanitizer production applies before sending (handler, `replyText.replace`). */
export function sanitizeDashes(text: string): string {
  return text.replace(/[—–]/g, "-");
}
