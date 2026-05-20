/**
 * Queries for the Leads screen.
 *
 * A "lead" in the dashboard is one row in `conversations` — each unique
 * lead_phone × agent_id pair gets one conversation. We ship date-range
 * bounds (filtering by `created_at`) to the server; the unified 5-status
 * filter (טמפלייט / שיחה נפתחה / זום / נציג / סגורה) and the funnel
 * stage filter are applied client-side because they involve time-decay
 * rules and computed values that have no stable SQL form.
 *
 * RLS (`authenticated_read_conversations`, migration 0002) lets every
 * authenticated user read all rows; agent scoping is enforced here via
 * `agent_id = activeAgent.id`.
 */
import { supabase } from "./supabase/client";
import type { Conversation } from "@/types/conversation";

export interface LeadsFilters {
  agentId: string;
  search?: string;
  /** Lower bound on `created_at`, inclusive. null = unbounded. */
  fromCreatedAt?: string | null;
  /** Upper bound on `created_at`, inclusive. null = unbounded. */
  toCreatedAt?: string | null;
  limit?: number;
}

const DEFAULT_LIMIT = 500;

export async function getLeads(filters: LeadsFilters): Promise<Conversation[]> {
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
    throw new Error(`Failed to load leads: ${error.message}`);
  }
  return data ?? [];
}
