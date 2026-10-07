// A Claude model that plays the lead. It follows the scenario's beats, writes
// short casual Hebrew, never picks a meeting time, and ends the chat when the
// bot has clearly said goodbye.

import { callWithRetry } from "../../../supabase/functions/_shared/anthropicRetry.ts";
import type { MessagesClient } from "./botTurn.ts";
import { SONNET_MODEL, type ApiUsage, type CostTracker } from "./cost.ts";
import type { Scenario } from "./scenarios.ts";
import { formatTranscript, type TranscriptEntry } from "./transcript.ts";

const LEAD_MAX_TOKENS = 200;
export const END_MARKER = "[[END]]";

export function buildLeadActorSystem(scenario: Scenario): string {
  const beats = scenario.plan.map((beat, index) => `${index + 1}. ${beat}`).join("\n");
  return [
    "You are role-playing a real person (the LEAD) chatting on WhatsApp with a sales representative of an Israeli marketing college. You are not the representative.",
    `Who you are: ${scenario.persona}`,
    "How you write: short, casual, spoken Hebrew, one to three short sentences, the way people actually type on WhatsApp. No emojis unless it fits the persona. Never write like an assistant, never explain yourself.",
    `Your plan, beat by beat. Play ONE beat per message, in order, but react naturally to what the representative just said; if they asked you a direct question, answer it in the spirit of the current beat:\n${beats}`,
    "Once the beats run out, keep going as this person would, consistently with the persona.",
    "HARD RULE: you never pick or accept a specific meeting day or time. If the representative offers times, deflect (you will check later, not now, send me details first).",
    `If the representative's last message is a clear goodbye or closes the conversation, and nothing is left to answer, reply with exactly ${END_MARKER} and nothing else.`,
    "Output only the lead's next message, with no quotes and no labels.",
  ].join("\n\n");
}

export function buildLeadActorUserMessage(
  entries: ReadonlyArray<TranscriptEntry>,
  leadMessagesSoFar: number,
  maxTurns: number,
): string {
  const visible = entries.filter((e) => e.kind === "opener" || e.kind === "lead" || e.kind === "bot");
  const transcript = formatTranscript(visible);
  const silenceNote = entries.at(-1)?.kind === "silence"
    ? "\n\n(The representative did not answer your last message. React as this person would.)"
    : "";
  return `Conversation so far:\n${transcript}${silenceNote}\n\nThis will be your message number ${leadMessagesSoFar + 1} of at most ${maxTurns}. Write it now.`;
}

export type LeadTurn = { kind: "message"; text: string } | { kind: "end" };

export function parseLeadReply(raw: string): LeadTurn {
  const text = raw.trim();
  if (text.length === 0 || text.includes(END_MARKER)) return { kind: "end" };
  return { kind: "message", text: text.replace(/^["'“”]|["'“”]$/g, "").trim() };
}

interface TextResponse {
  content?: Array<{ type: string; text?: unknown }>;
  usage?: ApiUsage;
}

export interface LeadActorArgs {
  client: MessagesClient;
  tracker: CostTracker;
  scenario: Scenario;
  entries: ReadonlyArray<TranscriptEntry>;
  leadMessagesSoFar: number;
}

export async function generateLeadTurn(args: LeadActorArgs): Promise<LeadTurn> {
  args.tracker.assertWithinBudget();
  const raw = await callWithRetry(
    () =>
      args.client.messages.create({
        model: SONNET_MODEL,
        max_tokens: LEAD_MAX_TOKENS,
        system: buildLeadActorSystem(args.scenario),
        messages: [{
          role: "user",
          content: buildLeadActorUserMessage(args.entries, args.leadMessagesSoFar, args.scenario.maxTurns),
        }],
      }),
    { maxAttempts: 3, baseDelayMs: 1000 },
  );
  const response = raw as TextResponse;
  args.tracker.record(SONNET_MODEL, response.usage);
  const block = response.content?.find((b) => b.type === "text");
  return parseLeadReply(typeof block?.text === "string" ? block.text : "");
}
