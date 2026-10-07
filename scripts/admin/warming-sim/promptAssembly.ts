// Builds the system prompt and message history exactly the way
// whatsappWebhookHandler.ts does for a warming lead, reusing the production
// modules for everything that has one. Pure (no I/O) so the order is testable.

import { buildBrainSection } from "../../../supabase/functions/_shared/brainContext.ts";
import { renderWarmingContextBlock } from "../../../supabase/functions/_shared/warmingContextBlock.ts";
import {
  buildPriorProfile,
  findOpenerTemplateName,
  splitTurnHistory,
  type ChatMessage,
  type TimedMessage,
} from "../../../supabase/functions/_shared/warmingHistory.ts";
import type { Scenario } from "./scenarios.ts";
import type { SimulationContext, StatusRule } from "./loadContext.ts";

const MINUTE_MS = 60_000;
const DAY_MS = 24 * 60 * MINUTE_MS;
const EARLIER_CONVERSATION_AGE_DAYS = 60;

/**
 * Mirror of the dateHeader built inline in whatsappWebhookHandler.ts
 * (the `const dateHeader` block, ~lines 1257-1273). It is not exported there, so keep the two in step.
 */
export function buildDateHeader(now: Date): string {
  const todayIL = new Intl.DateTimeFormat("en-CA", {
    timeZone: "Asia/Jerusalem",
    year: "numeric", month: "2-digit", day: "2-digit",
    weekday: "long",
  }).formatToParts(now);
  const todayDate = `${todayIL.find((p) => p.type === "year")?.value}-${todayIL.find((p) => p.type === "month")?.value}-${todayIL.find((p) => p.type === "day")?.value}`;
  const todayWeekday = todayIL.find((p) => p.type === "weekday")?.value ?? "";
  return (
    `# Current date context\n` +
    `Today is ${todayDate} (${todayWeekday}, Asia/Jerusalem).\n` +
    `When a lead says "היום" use ${todayDate}. ` +
    `When they say "מחר" compute it as the next calendar day in YYYY-MM-DD. ` +
    `Always pass dates to list_available_slots in YYYY-MM-DD format using THIS reference, not your training cutoff.\n\n`
  );
}

export interface SystemPromptParts {
  dateHeader: string;
  /** Always empty in the simulator: a warming lead has no booking. */
  bookingStatusBlock: string;
  warmingBlock: string;
  mainPrompt: string;
  /** Already prefixed with "\n\n" when non-empty, as in the handler. */
  brainText: string;
}

/** Same concatenation, same order, as `fullSystemPrompt` in the handler. */
export function assembleSystemPrompt(parts: SystemPromptParts): string {
  return parts.dateHeader + parts.bookingStatusBlock + parts.warmingBlock + parts.mainPrompt + parts.brainText;
}

export function buildBrainText(brainRows: SimulationContext["brainRows"]): string {
  const section = buildBrainSection(brainRows);
  return section.text ? "\n\n" + section.text : "";
}

/**
 * The lead has an earlier conversation (hidden by the stage trim) and the
 * warming stage starts at the opener, followed by the chat so far.
 */
export function buildTimedHistory(
  openerTemplateName: string,
  chat: ReadonlyArray<ChatMessage>,
  stageStart: Date,
): { messages: TimedMessage[]; cutoffIso: string } {
  const earlier = new Date(stageStart.getTime() - EARLIER_CONVERSATION_AGE_DAYS * DAY_MS);
  const messages: TimedMessage[] = [
    { role: "user", content: "(earlier conversation, hidden from the model)", timestamp: earlier.toISOString() },
    { role: "assistant", content: "(earlier reply, hidden from the model)", timestamp: new Date(earlier.getTime() + MINUTE_MS).toISOString() },
    { role: "assistant", content: `[template:${openerTemplateName}]`, timestamp: stageStart.toISOString() },
  ];
  chat.forEach((message, index) => {
    messages.push({
      role: message.role,
      content: message.content,
      timestamp: new Date(stageStart.getTime() + (index + 1) * MINUTE_MS).toISOString(),
    });
  });
  return { messages, cutoffIso: stageStart.toISOString() };
}

export interface TurnPrompt {
  systemPrompt: string;
  claudeMessages: ChatMessage[];
  hiddenCount: number;
  warmingBlock: string;
}

export interface TurnPromptInput {
  context: SimulationContext;
  rule: StatusRule;
  scenario: Scenario;
  /** Messages after the opener: lead, bot, lead... ending on a lead message. */
  chat: ReadonlyArray<ChatMessage>;
  now: Date;
}

/** What the handler would send to the model for the lead's latest message. */
export function buildTurnPrompt(input: TurnPromptInput): TurnPrompt {
  const { context, rule, scenario, chat, now } = input;
  const history = buildTimedHistory(context.openerTemplateName, chat, now);
  const split = splitTurnHistory(history.messages, history.cutoffIso);
  const claudeMessages = split.forModel;
  const priorProfile = split.hiddenCount > 0 ? buildPriorProfile(scenario.priorMemory ?? null) : [];
  const openerName = findOpenerTemplateName(claudeMessages);
  const warmingBlock = renderWarmingContextBlock({
    statusSub: rule.status_sub,
    // The CRM primary status is not stored on the rule; it is context only.
    statusMain: null,
    statusLabel: rule.status_label,
    objectionKey: rule.objection_key,
    instructions: rule.warming_instructions,
    repNote: null,
    hasHistory: split.hiddenCount > 0 || claudeMessages.length > 1,
    priorProfile,
    openerText: openerName ? context.openerText : null,
  });
  const systemPrompt = assembleSystemPrompt({
    dateHeader: buildDateHeader(now),
    bookingStatusBlock: "",
    warmingBlock,
    mainPrompt: context.mainPrompt.content,
    brainText: buildBrainText(context.brainRows),
  });
  return { systemPrompt, claudeMessages, hiddenCount: split.hiddenCount, warmingBlock };
}
