/**
 * Admin-side queries for the `agents` table.
 *
 * RLS on `agents` (migrations 0002 + 0004):
 *   - SELECT: any authenticated user reads `status = 'active'` rows;
 *     admins also see inactive/draft rows.
 *   - INSERT / UPDATE / DELETE: admin only (`is_admin()`).
 *
 * These functions assume the caller is signed in. UI guards (RoleGuard /
 * page-level checks) gate access — RLS is the safety net.
 */
import { supabase } from "./supabase/client";
import type { Agent, AgentInsert, AgentUpdate } from "@/types/agent";

/**
 * Fetch every agent visible to the caller. Admins receive inactive rows
 * too; regular users get only the active ones (RLS handles this).
 */
export async function getAllAgentsForAdmin(): Promise<Agent[]> {
  const { data, error } = await supabase
    .from("agents")
    .select("*")
    .order("display_name");

  if (error) {
    throw new Error(`Failed to load agents: ${error.message}`);
  }
  return data ?? [];
}

export async function createAgent(input: AgentInsert): Promise<Agent> {
  const { data, error } = await supabase
    .from("agents")
    .insert(input)
    .select("*")
    .single();

  if (error) {
    throw new Error(`Failed to create agent: ${error.message}`);
  }
  return data;
}

export async function updateAgent(id: string, patch: AgentUpdate): Promise<Agent> {
  const { data, error } = await supabase
    .from("agents")
    .update(patch)
    .eq("id", id)
    .select("*")
    .single();

  if (error) {
    throw new Error(`Failed to update agent: ${error.message}`);
  }
  return data;
}
