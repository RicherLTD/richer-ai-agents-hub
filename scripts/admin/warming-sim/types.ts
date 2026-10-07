// Result shapes written to the JSON report and rendered in the HTML report.

import type { CostSnapshot } from "./cost.ts";
import type { GraderResult } from "./graderSchema.ts";
import type { TranscriptEntry } from "./transcript.ts";

export type RunStatus = "graded" | "error" | "aborted";

export interface ScenarioRun {
  id: string;
  statusSub: number;
  title: string;
  statusLabel: string;
  status: RunStatus;
  entries: TranscriptEntry[];
  grade: GraderResult | null;
  /** Failure message for status 'error', or the abort reason. */
  note: string | null;
  leadTurns: number;
  silenceCount: number;
  cost: CostSnapshot;
}

export interface RunReport {
  generatedAt: string;
  agentSlug: string;
  mainPromptVersion: string;
  models: { bot: string; lead: string; grader: string; judge: string };
  maxCostUsd: number;
  /** True when the run stopped early because the cost limit was reached. */
  budgetExceeded: boolean;
  totalCost: CostSnapshot;
  scenarios: ScenarioRun[];
}
