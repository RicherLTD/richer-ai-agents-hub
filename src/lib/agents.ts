import { supabase } from "./supabase/client";
import type { Agent } from "@/types/agent";

/**
 * Fetch all active agents from Supabase.
 *
 * RLS (see `supabase/migrations/0002_auth_rls_update.sql`) already restricts
 * this to `status = 'active'` rows for authenticated users, but we keep the
 * explicit `.eq` here so the intent is local to this query — if RLS ever
 * loosens, behaviour stays predictable.
 */
export async function getAgents(): Promise<Agent[]> {
  const { data, error } = await supabase
    .from("agents")
    .select("*")
    .eq("status", "active")
    .order("display_name");

  if (error) {
    throw new Error(`Failed to load agents: ${error.message}`);
  }
  return data ?? [];
}
