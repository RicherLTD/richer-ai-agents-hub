/**
 * Queries for the Leads screen.
 *
 * A "lead" in the dashboard is one row in the `conversations` table —
 * each unique lead_phone × agent_id pair gets one conversation. We expose
 * a single `getLeads()` query with optional filters; pagination/limits
 * will arrive once the dataset grows past a few hundred rows.
 *
 * RLS (`authenticated_read_conversations`, migration 0002) lets every
 * authenticated user read all rows; agent scoping is enforced client-side
 * here via `agent_id = activeAgent.id`.
 */
import { supabase } from "./supabase/client";
import type {
  Conversation,
  ConversationStatus,
  FunnelStage,
} from "@/types/conversation";

export interface LeadsFilters {
  agentId: string;
  search?: string;
  funnelStage?: FunnelStage | "all";
  status?: ConversationStatus | "all";
  limit?: number;
}

const DEFAULT_LIMIT = 200;

export async function getLeads(filters: LeadsFilters): Promise<Conversation[]> {
  let query = supabase
    .from("conversations")
    .select("*")
    .eq("agent_id", filters.agentId);

  if (filters.funnelStage && filters.funnelStage !== "all") {
    query = query.eq("funnel_stage", filters.funnelStage);
  }
  if (filters.status && filters.status !== "all") {
    query = query.eq("status", filters.status);
  }
  if (filters.search && filters.search.trim()) {
    const term = filters.search.trim().replace(/[%_]/g, "");
    // Match either the phone number or the (case-insensitive) lead name.
    query = query.or(`lead_phone.ilike.%${term}%,lead_name.ilike.%${term}%`);
  }

  const { data, error } = await query
    .order("last_interaction_at", { ascending: false, nullsFirst: false })
    .limit(filters.limit ?? DEFAULT_LIMIT);

  if (error) {
    throw new Error(`Failed to load leads: ${error.message}`);
  }
  return data ?? [];
}
