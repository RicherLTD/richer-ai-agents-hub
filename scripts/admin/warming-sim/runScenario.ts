// Plays one scenario end to end: lead actor, bot turn with production guards,
// then the grader. Never touches WhatsApp or the database.

import type { ChatMessage } from "../../../supabase/functions/_shared/warmingHistory.ts";
import { generateBotReply, type MessagesClient } from "./botTurn.ts";
import { BudgetExceededError, CostTracker } from "./cost.ts";
import { gradeTranscript, extractSpecSection } from "./grader.ts";
import { runGuardedReply, type JudgeVerdictLike } from "./guardedReply.ts";
import { generateLeadTurn } from "./leadActor.ts";
import type { SimulationContext, StatusRule } from "./loadContext.ts";
import { buildTurnPrompt } from "./promptAssembly.ts";
import type { Scenario } from "./scenarios.ts";
import { AGENT_FALLBACK_REPLY, type TranscriptEntry } from "./transcript.ts";
import type { ScenarioRun } from "./types.ts";

export interface RunDeps {
  client: MessagesClient;
  context: SimulationContext;
  specMarkdown: string;
  /** Production's judgeReply, wrapped so its Haiku usage lands in the tracker. */
  judge: (text: string, tracker: CostTracker) => Promise<JudgeVerdictLike>;
  now: Date;
}

interface ConversationState {
  entries: TranscriptEntry[];
  chat: ChatMessage[];
  leadTurns: number;
}

function openerEntry(context: SimulationContext): TranscriptEntry {
  const text = context.openerText ?? `[template:${context.openerTemplateName}]`;
  return { kind: "opener", text };
}

function lastBotMessage(chat: ReadonlyArray<ChatMessage>): string | undefined {
  return chat.findLast((message) => message.role === "assistant")?.content;
}

async function playTurns(
  deps: RunDeps,
  scenario: Scenario,
  rule: StatusRule,
  tracker: CostTracker,
  state: ConversationState,
): Promise<void> {
  for (let turn = 0; turn < scenario.maxTurns; turn++) {
    const lead = await generateLeadTurn({
      client: deps.client, tracker, scenario, entries: state.entries, leadMessagesSoFar: state.leadTurns,
    });
    if (lead.kind === "end") return;
    state.entries.push({ kind: "lead", text: lead.text });
    state.chat.push({ role: "user", content: lead.text });
    state.leadTurns += 1;

    const prompt = buildTurnPrompt({ context: deps.context, rule, scenario, chat: state.chat, now: deps.now });
    const guarded = await runGuardedReply(
      {
        generate: (systemPrompt) =>
          generateBotReply({ client: deps.client, tracker, now: deps.now, messages: prompt.claudeMessages }, systemPrompt),
        judge: (text) => deps.judge(text, tracker),
      },
      prompt.systemPrompt,
      { isWarming: prompt.warmingBlock !== "", alreadyApologised: lastBotMessage(state.chat) === AGENT_FALLBACK_REPLY },
    );
    state.entries.push(...guarded.events);
    if (guarded.reply === null) continue;
    state.entries.push({ kind: "bot", text: guarded.reply, attempts: guarded.attempts });
    state.chat.push({ role: "assistant", content: guarded.reply });
  }
}

function describeFailure(error: unknown): { status: "aborted" | "error"; note: string } {
  if (error instanceof BudgetExceededError) return { status: "aborted", note: error.message };
  return { status: "error", note: error instanceof Error ? error.message : String(error) };
}

export async function runScenario(
  deps: RunDeps,
  scenario: Scenario,
  rule: StatusRule,
  runTracker: CostTracker,
): Promise<ScenarioRun> {
  const tracker = runTracker.child();
  const state: ConversationState = { entries: [openerEntry(deps.context)], chat: [], leadTurns: 0 };
  const base = {
    id: scenario.id,
    statusSub: scenario.statusSub,
    title: scenario.title,
    statusLabel: rule.status_label,
  };
  const summarize = () => ({
    entries: state.entries,
    leadTurns: state.leadTurns,
    // Silence and the fallback apology are both guard failures for grading.
    silenceCount: state.entries.filter((e) => e.kind === "silence" || e.kind === "fallback").length,
    cost: tracker.total,
  });

  try {
    await playTurns(deps, scenario, rule, tracker, state);
    const grade = await gradeTranscript(deps.client, tracker, {
      scenario,
      dbInstruction: rule.warming_instructions,
      specSection: extractSpecSection(deps.specMarkdown, scenario.statusSub),
      entries: state.entries,
    });
    return { ...base, ...summarize(), status: "graded", grade, note: null };
  } catch (error) {
    const failure = describeFailure(error);
    return { ...base, ...summarize(), status: failure.status, grade: null, note: failure.note };
  }
}
