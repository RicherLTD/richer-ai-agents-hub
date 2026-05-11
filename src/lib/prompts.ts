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
