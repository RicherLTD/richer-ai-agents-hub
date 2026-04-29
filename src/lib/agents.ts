import { supabase } from "./supabase/client";
import type { Agent } from "@/types/agent";

/**
 * Fetch all active agents from Supabase.
 *
 * RLS only exposes `status = 'active'` rows to the anon key (see
 * `0001_rls_policies.sql`), but we keep the explicit `.eq` here so the intent
 * is local to this query — if RLS ever loosens, behaviour stays predictable.
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
