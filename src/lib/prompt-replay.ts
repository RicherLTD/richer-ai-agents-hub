/**
 * Client wrapper for the `prompt-replay` edge function (Phase D-full).
 *
 * The edge function is admin-only (server-side `requireAdmin`) — non-admin
 * users will get a 401 / 403. The UI should hide the entry point for
 * non-admins so the surface stays honest.
 */
import { supabase } from "./supabase/client";

export interface PromptReplayTurn {
  turnIndex: number;
  userMessage: string;
  originalReply: string | null;
  candidateReply: string | null;
  candidateCostUsd: number | null;
  candidateTokensInput: number | null;
  candidateTokensOutput: number | null;
  candidateLatencyMs: number | null;
  error: string | null;
}

export interface PromptReplayResult {
  promptType: string;
  promptVersion: string;
  conversationId: string;
  turnCount: number;
  /** True if the conversation had more than MAX_TURNS lead-turns and the
   *  replay stopped before the end. */
  truncated: boolean;
  totalCostUsd: number;
  turns: PromptReplayTurn[];
}

export async function runPromptReplay(args: {
  promptId: string;
  conversationId: string;
}): Promise<PromptReplayResult> {
  const { data, error } = await supabase.functions.invoke<PromptReplayResult>(
    "prompt-replay",
    {
      body: { promptId: args.promptId, conversationId: args.conversationId },
    },
  );
  if (error) {
    throw new Error(`Failed to replay prompt: ${error.message}`);
  }
  if (!data) {
    throw new Error("Replay returned no data");
  }
  return data;
}
