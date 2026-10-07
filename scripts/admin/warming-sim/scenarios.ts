// Scenario file schema, validation and selection. Pure so it is testable
// under vitest.

import type { PriorProfileFields } from "../../../supabase/functions/_shared/warmingHistory.ts";

export const DEFAULT_MAX_TURNS = 6;

export interface Scenario {
  id: string;
  statusSub: number;
  title: string;
  persona: string;
  /** Beats the lead plays, in order. */
  plan: string[];
  mustHappen: string[];
  mustNotHappen: string[];
  maxTurns: number;
  /** Stable facts remembered from the lead's earlier conversation. Empty by default. */
  priorMemory?: PriorProfileFields;
}

export class ScenarioValidationError extends Error {
  constructor(public readonly problems: string[]) {
    super(`scenarios.json is invalid:\n- ${problems.join("\n- ")}`);
  }
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function isNonEmptyString(value: unknown): value is string {
  return typeof value === "string" && value.trim().length > 0;
}

function isStringList(value: unknown): value is string[] {
  return Array.isArray(value) && value.every(isNonEmptyString);
}

function checkEntry(entry: unknown, index: number, seenIds: Set<string>): string[] {
  const where = `entry ${index}`;
  if (!isRecord(entry)) return [`${where}: not an object`];
  const problems: string[] = [];
  const id = entry.id;
  if (!isNonEmptyString(id)) problems.push(`${where}: id must be a non-empty string`);
  else if (seenIds.has(id)) problems.push(`${where}: duplicate id '${id}'`);
  else seenIds.add(id);
  if (!Number.isInteger(entry.statusSub)) problems.push(`${where}: statusSub must be an integer`);
  for (const key of ["title", "persona"] as const) {
    if (!isNonEmptyString(entry[key])) problems.push(`${where}: ${key} must be a non-empty string`);
  }
  if (!isStringList(entry.plan) || entry.plan.length === 0) {
    problems.push(`${where}: plan must be a non-empty list of strings`);
  }
  for (const key of ["mustHappen", "mustNotHappen"] as const) {
    if (!isStringList(entry[key])) problems.push(`${where}: ${key} must be a list of strings`);
  }
  const turns = entry.maxTurns;
  if (typeof turns !== "number" || !Number.isInteger(turns) || turns < 1) {
    problems.push(`${where}: maxTurns must be a positive integer`);
  }
  return problems;
}

/** Throws ScenarioValidationError listing every problem found. */
export function validateScenarios(raw: unknown): Scenario[] {
  if (!Array.isArray(raw) || raw.length === 0) {
    throw new ScenarioValidationError(["the file must contain a non-empty array"]);
  }
  const seenIds = new Set<string>();
  const problems = raw.flatMap((entry, index) => checkEntry(entry, index, seenIds));
  if (problems.length > 0) throw new ScenarioValidationError(problems);
  return raw as Scenario[];
}

export interface Selection {
  selected: Scenario[];
  /** Scenarios whose status is disabled in the DB, so production would never warm it. */
  skippedInactive: Scenario[];
  /** Active statuses that have no scenario at all. */
  uncoveredStatuses: number[];
}

/** `only` tokens match a scenario id exactly, or a numeric statusSub. */
export function selectScenarios(
  all: ReadonlyArray<Scenario>,
  options: { only: ReadonlyArray<string>; activeStatuses: ReadonlySet<number> },
): Selection {
  const matchesOnly = (scenario: Scenario): boolean =>
    options.only.length === 0 ||
    options.only.includes(scenario.id) ||
    options.only.includes(String(scenario.statusSub));
  const skippedInactive = all.filter((s) => !options.activeStatuses.has(s.statusSub));
  const selected = all.filter((s) => options.activeStatuses.has(s.statusSub) && matchesOnly(s));
  const covered = new Set(all.map((s) => s.statusSub));
  const uncoveredStatuses = [...options.activeStatuses].filter((status) => !covered.has(status));
  return { selected, skippedInactive, uncoveredStatuses };
}
