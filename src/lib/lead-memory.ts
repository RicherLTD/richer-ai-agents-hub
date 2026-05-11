/**
 * Read-only access to `public.lead_memory` — the AI's accumulated
 * understanding of a lead (summary, the 6 questionnaire answers,
 * advisor notes, red flags, …). Populated by n8n; the dashboard
 * surfaces it but doesn't mutate it.
 */
import { supabase } from "./supabase/client";
import type { LeadMemory } from "@/types/message";

export async function getLeadMemory(conversationId: string): Promise<LeadMemory | null> {
  const { data, error } = await supabase
    .from("lead_memory")
    .select("*")
    .eq("conversation_id", conversationId)
    .maybeSingle();
  if (error) {
    throw new Error(`Failed to load lead memory: ${error.message}`);
  }
  return data;
}
