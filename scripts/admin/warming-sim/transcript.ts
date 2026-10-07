// The record of one simulated conversation, shared by the runner, the grader
// and the report.

export type TranscriptEntry =
  | { kind: "opener"; text: string }
  | { kind: "lead"; text: string }
  | { kind: "bot"; text: string; attempts: number }
  | { kind: "tool"; text: string }
  | { kind: "guard"; text: string }
  | { kind: "silence"; text: string };

const SPEAKER_LABEL: Record<TranscriptEntry["kind"], string> = {
  opener: "BOT (opener template)",
  lead: "LEAD",
  bot: "BOT",
  tool: "TOOL",
  guard: "GUARD",
  silence: "BOT",
};

/** Plain-text form fed to the lead actor and the grader. */
export function formatTranscript(entries: ReadonlyArray<TranscriptEntry>): string {
  return entries.map((entry) => `${SPEAKER_LABEL[entry.kind]}: ${entry.text}`).join("\n");
}

/** The dash sanitizer production applies before sending (handler, `replyText.replace`). */
export function sanitizeDashes(text: string): string {
  return text.replace(/[—–]/g, "-");
}
