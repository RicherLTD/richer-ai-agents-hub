// Grades a finished transcript with a Claude model, using a forced tool call
// so the answer is structured.

import { callWithRetry } from "../../../supabase/functions/_shared/anthropicRetry.ts";
import type { MessagesClient } from "./botTurn.ts";
import { SONNET_MODEL, type ApiUsage, type CostTracker } from "./cost.ts";
import {
  CROSS_STATUS_CRITERIA,
  GraderParseError,
  SUBMIT_GRADE_TOOL,
  parseGraderOutput,
  reconcileGrade,
  type GraderResult,
} from "./graderSchema.ts";
import type { Scenario } from "./scenarios.ts";
import { formatTranscript, type TranscriptEntry } from "./transcript.ts";

const GRADER_MAX_TOKENS = 3000;

/**
 * The spec document's section for one status: from its "- **<n> ..." bullet up
 * to the next bullet or heading. Handles combined bullets like "72 + 73".
 */
export function extractSpecSection(markdown: string, statusSub: number): string | null {
  const lines = markdown.split("\n");
  const start = lines.findIndex((line) => {
    const match = /^- \*\*([\d +]+?)\s*[—-]/.exec(line);
    return match ? match[1].split("+").map((n) => Number(n.trim())).includes(statusSub) : false;
  });
  if (start === -1) return null;
  const end = lines.findIndex((line, index) => index > start && /^(- \*\*|#{1,3} )/.test(line));
  return lines.slice(start, end === -1 ? undefined : end).join("\n").trim();
}

const GRADER_SYSTEM = [
  "You are a strict but fair QA reviewer for an Israeli WhatsApp sales bot that re-engages leads who went cold. You read one simulated conversation (the BOT is the system under test, the LEAD is an actor) and grade the BOT.",
  "Grade only what the BOT wrote. Judge against the status spec and the cross-status criteria you are given. Mark a criterion 'fail' only for a clear violation, and quote the offending Hebrew words as evidence; 'na' when it cannot apply (say why, briefly). Lines starting with TOOL or GUARD are system events, not the lead's view.",
  "Verdict: PASS when no criterion fails and the scenario's must-happen items are met; BORDERLINE for arguable wording or a partly met must-happen item; FAIL for any clear violation, a must-not-happen item that happened, or silence.",
  "Write evidence and the summary in Hebrew. Answer ONLY by calling submit_grade.",
].join("\n\n");

export interface GradeInput {
  scenario: Scenario;
  dbInstruction: string;
  specSection: string | null;
  entries: ReadonlyArray<TranscriptEntry>;
}

export function buildGraderUserMessage(input: GradeInput): string {
  const criteria = CROSS_STATUS_CRITERIA.map((c) => `- ${c.id}: ${c.rubric}`).join("\n");
  const list = (items: string[]): string => (items.length ? items.map((i) => `- ${i}`).join("\n") : "(none)");
  return [
    `## Scenario\nStatus ${input.scenario.statusSub}: ${input.scenario.title}\nLead persona: ${input.scenario.persona}`,
    `## Status spec: instruction the bot received (from the database)\n${input.dbInstruction}`,
    `## Status spec: design document section\n${input.specSection ?? "(no section found)"}`,
    `## Cross-status criteria (return one entry per id)\n${criteria}`,
    `## Must happen\n${list(input.scenario.mustHappen)}`,
    `## Must NOT happen\n${list(input.scenario.mustNotHappen)}`,
    `## Transcript\n${formatTranscript(input.entries)}`,
  ].join("\n\n");
}

interface ToolUseResponse {
  content?: Array<{ type: string; input?: unknown }>;
  usage?: ApiUsage;
}

export async function gradeTranscript(
  client: MessagesClient,
  tracker: CostTracker,
  input: GradeInput,
): Promise<GraderResult> {
  tracker.assertWithinBudget();
  const raw = await callWithRetry(
    () =>
      client.messages.create({
        model: SONNET_MODEL,
        max_tokens: GRADER_MAX_TOKENS,
        system: GRADER_SYSTEM,
        tools: [SUBMIT_GRADE_TOOL],
        tool_choice: { type: "tool", name: SUBMIT_GRADE_TOOL.name },
        messages: [{ role: "user", content: buildGraderUserMessage(input) }],
      }),
    { maxAttempts: 3, baseDelayMs: 1000 },
  );
  const response = raw as ToolUseResponse;
  tracker.record(SONNET_MODEL, response.usage);
  const toolUse = response.content?.find((b) => b.type === "tool_use");
  if (!toolUse) throw new GraderParseError("grader did not call submit_grade");
  const silenceCount = input.entries.filter((e) => e.kind === "silence").length;
  return reconcileGrade(parseGraderOutput(toolUse.input), { silenceCount });
}
