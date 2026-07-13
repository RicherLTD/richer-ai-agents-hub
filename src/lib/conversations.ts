/**
 * Queries for the conversations list (chat-app style sidebar).
 *
 * Reads from the `conversations` table — same source the Leads page uses
 * but ordered by `last_interaction_at desc`. The 5-status display filter
 * (טמפלייט נשלח / שיחה נפתחה / נקבע זום / דרוש נציג / שיחה סגורה) is
 * computed client-side via `deriveDisplayStatus()` because the rules
 * include a "48 hours since last reply" time-decay clause that has no
 * stable SQL representation. We still ship the date-range bounds to the
 * server so the trip cost stays linear in matches, not total rows.
 *
 * RLS (`authenticated_read_conversations`, migration 0002) lets every
 * authenticated user read all rows; agent scoping is `agent_id =
 * activeAgent.id`.
 */
import { supabase } from "./supabase/client";
import type { Conversation } from "@/types/conversation";

export interface ConversationsFilters {
  agentId: string;
  search?: string;
  /** Lower bound on `created_at`, inclusive. null = unbounded. */
  fromCreatedAt?: string | null;
  /** Upper bound on `created_at`, inclusive. null = unbounded. */
  toCreatedAt?: string | null;
  limit?: number;
}

const DEFAULT_LIMIT = 500;

export async function getActiveConversations(
  filters: ConversationsFilters,
): Promise<Conversation[]> {
  let query = supabase
    .from("conversations")
    .select("*")
    .eq("agent_id", filters.agentId);

  if (filters.fromCreatedAt) {
    query = query.gte("created_at", filters.fromCreatedAt);
  }
  if (filters.toCreatedAt) {
    query = query.lte("created_at", filters.toCreatedAt);
  }
  if (filters.search && filters.search.trim()) {
    const term = filters.search.trim().replace(/[%_]/g, "");
    query = query.or(`lead_phone.ilike.%${term}%,lead_name.ilike.%${term}%`);
  }

  const { data, error } = await query
    .order("last_interaction_at", { ascending: false, nullsFirst: false })
    .limit(filters.limit ?? DEFAULT_LIMIT);

  if (error) {
    throw new Error(`Failed to load conversations: ${error.message}`);
  }
  return data ?? [];
}

export async function getConversationById(
  id: string,
  expectedAgentId?: string,
): Promise<Conversation | null> {
  let query = supabase.from("conversations").select("*").eq("id", id);
  if (expectedAgentId) {
    query = query.eq("agent_id", expectedAgentId);
  }
  const { data, error } = await query.maybeSingle();
  if (error) {
    throw new Error(`Failed to load conversation: ${error.message}`);
  }
  return data;
}

export interface SetConversationModeParams {
  conversationId: string;
  mode: "manual" | "ai";
}

/**
 * Toggle a conversation between AI mode and manual mode via the
 * `conversation-set-mode` edge function (admin-gated, service_role write).
 */
export async function setConversationMode({
  conversationId,
  mode,
}: SetConversationModeParams): Promise<void> {
  const { data, error } = await supabase.functions.invoke<{ error?: string }>(
    "conversation-set-mode",
    { body: { conversation_id: conversationId, mode } },
  );
  if (error) {
    throw new Error(`Failed to set conversation mode: ${error.message}`);
  }
  if (data && "error" in data && data.error) {
    throw new Error(data.error);
  }
}
