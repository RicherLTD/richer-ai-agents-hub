/**
 * Read-only queries on `public.prompts`.
 *
 * Prompts are authored as files in `prompts/<agent>/<version>.md` and
 * synced to the DB by a server-side script. The dashboard surfaces them
 * but never mutates them — editing here would be overwritten on the
 * next sync (CLAUDE.md decision #5).
 *
 * RLS (`authenticated_read_prompts`, migration 0002) lets every
 * authenticated user read all rows.
 */
import { supabase } from "./supabase/client";
import type { Prompt } from "@/types/prompt";

export interface PromptsFilters {
  agentId: string;
  promptType?: string | "all";
  activeOnly?: boolean;
}

export async function getPrompts(filters: PromptsFilters): Promise<Prompt[]> {
  let query = supabase.from("prompts").select("*").eq("agent_id", filters.agentId);

  if (filters.promptType && filters.promptType !== "all") {
    query = query.eq("prompt_type", filters.promptType);
  }
  if (filters.activeOnly) {
    query = query.eq("is_active", true);
  }

  const { data, error } = await query
    .order("prompt_type")
    .order("created_at", { ascending: false });

  if (error) {
    throw new Error(`Failed to load prompts: ${error.message}`);
  }
  return data ?? [];
}

export async function getDistinctPromptTypes(agentId: string): Promise<string[]> {
  const { data, error } = await supabase
    .from("prompts")
    .select("prompt_type")
    .eq("agent_id", agentId);

  if (error) {
    throw new Error(`Failed to load prompt types: ${error.message}`);
  }
  const set = new Set<string>();
  for (const row of data ?? []) {
    if (row.prompt_type) set.add(row.prompt_type);
  }
  return [...set].sort();
}

/**
 * Flip the active prompt for one (agent, prompt_type) pair to a specific
 * version. Phase D rollback path: when an active prompt produces bad
 * replies, an admin opens the Prompts page, finds a previous version and
 * one-clicks back to it. The bot picks up the change on its very next
 * turn because the webhook always re-reads the active row from the DB.
 *
 * RLS (`admin_update_prompts`, migration 0014) lets only admins call this
 * — non-admin clients get a 401 / row-update-count-of-zero. The DB-side
 * check is the actual security boundary; the UI only hides the button
 * for non-admins to keep the surface honest.
 *
 * Implemented as two updates rather than a Postgres function because
 * each one is a single-row + indexed query, and the webhook re-reads
 * the active row at the *start* of each turn so a mid-turn flip would
 * still produce a consistent reply.
 */
export async function setActivePromptVersion(targetId: string): Promise<void> {
  const { data: target, error: fetchErr } = await supabase
    .from("prompts")
    .select("agent_id, prompt_type, is_active")
    .eq("id", targetId)
    .maybeSingle();
  if (fetchErr) {
    throw new Error(`Failed to read target prompt: ${fetchErr.message}`);
  }
  if (!target) {
    throw new Error("Prompt not found");
  }
  if (!target.agent_id || !target.prompt_type) {
    throw new Error("Target prompt is missing agent_id or prompt_type");
  }
  if (target.is_active) {
    return;
  }

  const { error: deactivateErr } = await supabase
    .from("prompts")
    .update({ is_active: false })
    .eq("agent_id", target.agent_id)
    .eq("prompt_type", target.prompt_type)
    .neq("id", targetId);
  if (deactivateErr) {
    throw new Error(`Failed to deactivate sibling versions: ${deactivateErr.message}`);
  }

  const { error: activateErr } = await supabase
    .from("prompts")
    .update({ is_active: true })
    .eq("id", targetId);
  if (activateErr) {
    throw new Error(`Failed to activate target version: ${activateErr.message}`);
  }
}
