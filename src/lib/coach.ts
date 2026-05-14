/**
 * Client wrapper for the Prompt Coach edge functions.
 *
 * Two endpoints:
 *   - `prompt-coach`       — POST a chat turn, get back the Coach's reply
 *                            (text + optional proposed prompt content).
 *   - `prompt-coach-apply` — apply a proposed edit, creating a new active
 *                            prompt row and deactivating the old one.
 *
 * History rows live in `public.coach_messages` and are queryable directly
 * via Supabase (admin-only RLS).
 */
import { supabase } from "./supabase/client";

export interface CoachMessageRow {
  id: string;
  agent_id: string;
  role: "user" | "assistant";
  user_id: string;
  content: string;
  proposed_prompt_content: string | null;
  applied_prompt_id: string | null;
  applied_at: string | null;
  applied_by: string | null;
  referenced_conversation_id: string | null;
  created_at: string;
}

export async function getCoachHistory(
  agentId: string,
  limit = 100,
): Promise<CoachMessageRow[]> {
  const { data, error } = await supabase
    .from("coach_messages")
    .select("*")
    .eq("agent_id", agentId)
    .order("created_at", { ascending: true })
    .limit(limit);
  if (error) throw new Error(`Failed to load coach history: ${error.message}`);
  return (data ?? []) as CoachMessageRow[];
}

export interface SendCoachMessageInput {
  agentId: string;
  userMessage: string;
  referencedConversationId?: string;
}

export interface CoachReplyAssistant {
  id: string;
  content: string;
  proposedPromptContent: string | null;
  proposalReason: string | null;
  createdAt: string;
}

export interface SendCoachMessageResult {
  userMessageId: string;
  assistantMessage: CoachReplyAssistant;
}

export async function sendCoachMessage(
  input: SendCoachMessageInput,
): Promise<SendCoachMessageResult> {
  const { data, error } = await supabase.functions.invoke<SendCoachMessageResult>(
    "prompt-coach",
    { body: input },
  );
  if (error) {
    // supabase-js wraps non-2xx as FunctionsHttpError with a `context` Response
    // we need to read to surface the real message.
    const ctx = (error as unknown as { context?: Response }).context;
    if (ctx) {
      try {
        const body = await ctx.json();
        const msg = typeof body?.error === "string" ? body.error : error.message;
        throw new Error(msg);
      } catch {
        throw new Error(error.message);
      }
    }
    throw new Error(error.message);
  }
  if (!data) throw new Error("Coach returned no data");
  return data;
}

export interface ApplyCoachEditResult {
  newPromptId: string;
  newVersion: string;
  previousPromptId: string | null;
  previousVersion: string | null;
}

export async function applyCoachEdit(coachMessageId: string): Promise<ApplyCoachEditResult> {
  const { data, error } = await supabase.functions.invoke<ApplyCoachEditResult>(
    "prompt-coach-apply",
    { body: { coachMessageId } },
  );
  if (error) {
    const ctx = (error as unknown as { context?: Response }).context;
    if (ctx) {
      try {
        const body = await ctx.json();
        const msg = typeof body?.error === "string" ? body.error : error.message;
        throw new Error(msg);
      } catch {
        throw new Error(error.message);
      }
    }
    throw new Error(error.message);
  }
  if (!data) throw new Error("Apply returned no data");
  return data;
}
