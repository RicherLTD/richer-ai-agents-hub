/**
 * Queries for the conversations list (chat-app style sidebar).
 *
 * Same `conversations` table that Leads uses, but a different shape:
 *   - Default to active rows only (paused / completed / opted_out hidden
 *     unless the user toggles "all").
 *   - Order by last_interaction_at desc so the freshest chat is on top.
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
  /** When false (default), only `status = 'active'` rows are returned. */
  includeInactive?: boolean;
  limit?: number;
}

const DEFAULT_LIMIT = 200;

export async function getActiveConversations(
  filters: ConversationsFilters,
): Promise<Conversation[]> {
  let query = supabase
    .from("conversations")
    .select("*")
    .eq("agent_id", filters.agentId);

  if (!filters.includeInactive) {
    query = query.eq("status", "active");
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

export async function getConversationById(id: string): Promise<Conversation | null> {
  const { data, error } = await supabase
    .from("conversations")
    .select("*")
    .eq("id", id)
    .maybeSingle();
  if (error) {
    throw new Error(`Failed to load conversation: ${error.message}`);
  }
  return data;
}
