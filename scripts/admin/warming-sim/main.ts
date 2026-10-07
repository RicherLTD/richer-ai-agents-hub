/**
 * Offline simulator for the CRM-warming feature. Plays scripted leads against
 * the real prompt, rules and guards, then grades every conversation.
 *
 * SAFETY: it never sends WhatsApp, never calls HookMyApp / Mooz / Fireberry /
 * Make, and never writes to the database. Database access is SELECT-only
 * (db.ts rejects anything else); the only network targets are the Supabase
 * Management API (reads) and Anthropic.
 *
 *   deno run --allow-net --allow-read --allow-write --allow-env \
 *     scripts/admin/warming-sim/main.ts --env-file <path> [--dry-run] [--only 22,23]
 *
 * See README.md for flags and what is and is not faithful to production.
 */

import Anthropic from "https://esm.sh/@anthropic-ai/sdk@0.88.0";
import { JUDGE_MODEL, judgeReply } from "../../../supabase/functions/_shared/judgeReply.ts";
import { CliUsageError, parseCliArgs, type CliOptions } from "./cli.ts";
import type { MessagesClient } from "./botTurn.ts";
import { CostTracker, HAIKU_MODEL, SONNET_MODEL } from "./cost.ts";
import { createReadOnlyDb } from "./db.ts";
import { findMissingKeys, parseEnvFile } from "./env.ts";
import { loadSimulationContext, type SimulationContext } from "./loadContext.ts";
import { buildTurnPrompt } from "./promptAssembly.ts";
import { renderHtml } from "./report.ts";
import { runScenario } from "./runScenario.ts";
import { selectScenarios, validateScenarios, type Scenario } from "./scenarios.ts";
import { runPool } from "./pool.ts";
import type { RunReport } from "./types.ts";

const SPEC_DOC_PATH = "docs/superpowers/plans/2026-09-01-crm-warming-objection-handling.md";
const DEFAULT_SCENARIOS_URL = new URL("./scenarios.json", import.meta.url);
/** Hebrew text costs more tokens per character than English; this is a rough planning ratio. */
const ROUGH_CHARS_PER_TOKEN = 2.5;

async function loadScenarioFile(path: string | null): Promise<Scenario[]> {
  const text = await Deno.readTextFile(path ?? DEFAULT_SCENARIOS_URL);
  return validateScenarios(JSON.parse(text));
}

function pickRule(context: SimulationContext, scenario: Scenario) {
  const rule = context.rules.find((r) => r.status_sub === scenario.statusSub);
  if (!rule) throw new Error(`no active rule for status ${scenario.statusSub}`);
  return rule;
}

async function runDry(options: CliOptions, context: SimulationContext, scenarios: Scenario[]): Promise<void> {
  const dir = `${options.outDir}/dry-run`;
  await Deno.mkdir(dir, { recursive: true });
  const summary = [];
  for (const scenario of scenarios) {
    const chat = [{ role: "user" as const, content: scenario.plan[0] }];
    const prompt = buildTurnPrompt({ context, rule: pickRule(context, scenario), scenario, chat, now: new Date() });
    await Deno.writeTextFile(`${dir}/${scenario.id}.system-prompt.md`, prompt.systemPrompt);
    await Deno.writeTextFile(`${dir}/${scenario.id}.messages.json`, JSON.stringify(prompt.claudeMessages, null, 2));
    summary.push({
      id: scenario.id,
      statusSub: scenario.statusSub,
      systemChars: prompt.systemPrompt.length,
      roughTokens: Math.round(prompt.systemPrompt.length / ROUGH_CHARS_PER_TOKEN),
      warmingBlockChars: prompt.warmingBlock.length,
      hiddenEarlierMessages: prompt.hiddenCount,
    });
  }
  await Deno.writeTextFile(`${dir}/summary.json`, JSON.stringify(summary, null, 2));
  console.log(`dry run: wrote ${scenarios.length} assembled prompts to ${dir} (no Anthropic calls)`);
  console.log(`main prompt ${context.mainPrompt.version}, opener text ${context.openerText ? "found" : "MISSING"}, brain docs ${context.brainRows.length}`);
}

function createClients(apiKey: string): { client: MessagesClient; anthropic: Anthropic } {
  const anthropic = new Anthropic({ apiKey });
  const client: MessagesClient = { messages: { create: (params) => anthropic.messages.create(params as never) } };
  return { client, anthropic };
}

async function runFull(
  options: CliOptions,
  env: Record<string, string>,
  context: SimulationContext,
  scenarios: Scenario[],
): Promise<void> {
  const { client, anthropic } = createClients(env.ANTHROPIC_API_KEY);
  const specMarkdown = await Deno.readTextFile(SPEC_DOC_PATH);
  const total = new CostTracker(options.maxCostUsd);
  const judge = async (text: string, tracker: CostTracker) => {
    const verdict = await judgeReply(anthropic, text, (message) => console.warn(message));
    tracker.record(HAIKU_MODEL, { input_tokens: verdict.tokensInput, output_tokens: verdict.tokensOutput });
    return verdict;
  };
  const deps = { client, context, specMarkdown, judge, now: new Date() };
  const runs = await runPool(scenarios, options.concurrency, async (scenario) => {
    const run = await runScenario(deps, scenario, pickRule(context, scenario), total);
    console.log(`[${scenario.id}] ${run.status} ${run.grade?.verdict ?? ""} $${run.cost.costUsd.toFixed(3)}`);
    return run;
  });
  const report: RunReport = {
    generatedAt: new Date().toISOString(),
    agentSlug: context.agentSlug,
    mainPromptVersion: context.mainPrompt.version,
    models: { bot: SONNET_MODEL, lead: SONNET_MODEL, grader: SONNET_MODEL, judge: JUDGE_MODEL },
    maxCostUsd: options.maxCostUsd,
    budgetExceeded: runs.some((r) => r.status === "aborted"),
    totalCost: total.total,
    scenarios: runs,
  };
  await Deno.mkdir(options.outDir, { recursive: true });
  await Deno.writeTextFile(`${options.outDir}/report.json`, JSON.stringify(report, null, 2));
  await Deno.writeTextFile(`${options.outDir}/report.html`, renderHtml(report));
  console.log(`done: $${total.total.costUsd.toFixed(2)} spent. Report: ${options.outDir}/report.html`);
}

async function main(): Promise<void> {
  const options = parseCliArgs(Deno.args);
  const env = parseEnvFile(await Deno.readTextFile(options.envFile));
  const required = ["SUPABASE_PROJECT_REF", "SUPABASE_ACCESS_TOKEN", ...(options.dryRun ? [] : ["ANTHROPIC_API_KEY"])];
  const missing = findMissingKeys(env, required);
  if (missing.length > 0) throw new CliUsageError(`missing in the env file: ${missing.join(", ")}`);

  const db = createReadOnlyDb({ projectRef: env.SUPABASE_PROJECT_REF, accessToken: env.SUPABASE_ACCESS_TOKEN });
  const context = await loadSimulationContext(db);
  const all = await loadScenarioFile(options.scenariosFile);
  const selection = selectScenarios(all, {
    only: options.only,
    activeStatuses: new Set(context.rules.map((r) => r.status_sub)),
  });
  selection.skippedInactive.forEach((s) => console.log(`skipping ${s.id}: status ${s.statusSub} is disabled in the DB`));
  if (selection.uncoveredStatuses.length > 0) {
    console.warn(`active statuses without a scenario: ${selection.uncoveredStatuses.join(", ")}`);
  }
  if (selection.selected.length === 0) throw new CliUsageError("no scenarios selected");

  if (options.dryRun) await runDry(options, context, selection.selected);
  else await runFull(options, env, context, selection.selected);
}

try {
  await main();
} catch (error) {
  console.error(error instanceof Error ? error.message : String(error));
  Deno.exit(error instanceof CliUsageError ? 2 : 1);
}
