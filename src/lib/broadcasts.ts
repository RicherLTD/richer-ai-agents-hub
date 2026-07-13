import { supabase } from "./supabase/client";

export interface BroadcastTemplate {
  id: string;
  name: string;
  language: string;
  label: string;
  variable_count: number;
  body_preview: string | null;
}

export interface BroadcastRow {
  id: string;
  title: string;
  template_name: string;
  status: string;
  scheduled_for: string | null;
  total_recipients: number;
  suppressed_count: number;
  created_at: string;
}

export interface EnqueuePayload {
  agent_id: string;
  template_name: string;
  template_language: string;
  template_variables?: string[];
  title: string;
  scheduled_for: string | null;
  include_existing?: boolean;
  existing_lead_conversation_ids?: string[];
  csv_recipients?: Array<{ phone: string; name?: string; variables?: string[] }>;
}

export interface EnqueueResult {
  broadcast_id: string;
  total_recipients: number;
  suppressed_count: number;
  suppressed_breakdown: Record<string, number>;
}

export async function listBroadcastTemplates(agentId: string): Promise<BroadcastTemplate[]> {
  const { data, error } = await supabase
    .from("broadcast_templates")
    .select("id, name, language, label, variable_count, body_preview")
    .eq("agent_id", agentId)
    .eq("is_active", true)
    .order("label");
  if (error) throw error;
  return (data ?? []) as BroadcastTemplate[];
}

export async function listBroadcasts(agentId: string): Promise<BroadcastRow[]> {
  const { data, error } = await supabase
    .from("broadcasts")
    .select("id, title, template_name, status, scheduled_for, total_recipients, suppressed_count, created_at")
    .eq("agent_id", agentId)
    .order("created_at", { ascending: false })
    .limit(100);
  if (error) throw error;
  return (data ?? []) as BroadcastRow[];
}

export async function enqueueBroadcast(payload: EnqueuePayload): Promise<EnqueueResult> {
  const { data, error } = await supabase.functions.invoke("broadcast-enqueue", { body: payload });
  if (error) throw error;
  return data as EnqueueResult;
}

export async function cancelBroadcast(broadcastId: string): Promise<void> {
  const { error: rowsErr } = await supabase
    .from("scheduled_messages")
    .update({ status: "cancelled", claimed_at: null })
    .eq("broadcast_id", broadcastId)
    .eq("status", "pending");
  if (rowsErr) throw rowsErr;
  const { error } = await supabase.from("broadcasts").update({ status: "cancelled" }).eq("id", broadcastId);
  if (error) throw error;
}

export interface BroadcastTemplateFull {
  id: string;
  agent_id: string;
  name: string;
  language: string;
  label: string;
  variable_count: number;
  body_preview: string | null;
  is_active: boolean;
  created_at: string;
}

export interface NewBroadcastTemplate {
  agent_id: string;
  name: string;
  language: string;
  label: string;
  variable_count: number;
  body_preview: string | null;
}

export async function listAllBroadcastTemplates(agentId: string): Promise<BroadcastTemplateFull[]> {
  const { data, error } = await supabase
    .from("broadcast_templates")
    .select("id, agent_id, name, language, label, variable_count, body_preview, is_active, created_at")
    .eq("agent_id", agentId)
    .order("created_at", { ascending: false });
  if (error) throw error;
  return (data ?? []) as BroadcastTemplateFull[];
}

export async function createBroadcastTemplate(input: NewBroadcastTemplate): Promise<void> {
  const { error } = await supabase.from("broadcast_templates").insert(input);
  if (error) throw error;
}

export async function setBroadcastTemplateActive(id: string, isActive: boolean): Promise<void> {
  const { error } = await supabase.from("broadcast_templates").update({ is_active: isActive }).eq("id", id);
  if (error) throw error;
}

export async function deleteBroadcastTemplate(id: string): Promise<void> {
  const { error } = await supabase.from("broadcast_templates").delete().eq("id", id);
  if (error) throw error;
}
