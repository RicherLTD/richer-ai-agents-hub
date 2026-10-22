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
  suppressed_breakdown: Record<string, number> | null;
  created_at: string;
}

/** Why a candidate was dropped, in the operator's words. */
export const SUPPRESSION_LABELS: Record<string, string> = {
  invalid_phone: "מספר לא תקין",
  opt_out: "ביקשו הסרה",
  blocking_tag: "תג חוסם (זום נקבע / טיפול אנושי)",
  duplicate: "כפילות",
};

/**
 * One-line Hebrew reason list, e.g. `מספר לא תקין: 7 · ביקשו הסרה: 2`.
 * Without this the operator only sees "0 recipients / 7 suppressed" and has no
 * way to tell a bad CSV apart from a correctly-filtered audience.
 */
export function describeSuppression(breakdown: Record<string, number> | null | undefined): string {
  if (!breakdown) return "";
  return Object.entries(breakdown)
    .filter(([, n]) => n > 0)
    .sort((a, b) => b[1] - a[1])
    .map(([reason, n]) => `${SUPPRESSION_LABELS[reason] ?? reason}: ${n}`)
    .join(" · ");
}

export interface EnqueuePayload {
  agent_id: string;
  template_name: string;
  template_language: string;
  template_variables?: string[];
  title: string;
  scheduled_for: string | null;
  include_existing?: boolean;
  /** Registration window for include_existing (ISO; from inclusive, before exclusive). */
  registered_from?: string | null;
  registered_before?: string | null;
  /** Fireberry status filters for include_existing; null = "no status". */
  status_mains?: Array<number | null>;
  status_subs?: Array<number | null>;
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
    .select("id, title, template_name, status, scheduled_for, total_recipients, suppressed_count, suppressed_breakdown, created_at")
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

export type AudiencePreview = Omit<EnqueueResult, "broadcast_id">;

/**
 * Size the audience exactly as a real send would — same lead query, opt-out
 * and blocking-tag suppression — without writing anything (`dry_run`).
 */
export async function previewBroadcastAudience(
  payload: Pick<
    EnqueuePayload,
    "agent_id" | "include_existing" | "registered_from" | "registered_before" | "status_mains" | "status_subs" | "csv_recipients"
  >,
): Promise<AudiencePreview> {
  const { data, error } = await supabase.functions.invoke("broadcast-enqueue", {
    body: { ...payload, dry_run: true },
  });
  if (error) throw error;
  return data as AudiencePreview;
}

/**
 * The operator picks whole days in Israel; the server filters on timestamps.
 * `to` is inclusive, so the exclusive bound is the start of the next day.
 * Uses the browser's local midnight — the dashboard is operated from Israel.
 */
export function registrationWindow(
  fromDate: string,
  toDate: string,
): { registered_from: string | null; registered_before: string | null } {
  const startOf = (day: string): Date | null => {
    const d = new Date(`${day}T00:00:00`);
    return Number.isNaN(d.getTime()) ? null : d;
  };
  const from = fromDate ? startOf(fromDate) : null;
  const to = toDate ? startOf(toDate) : null;
  if (to) to.setDate(to.getDate() + 1);
  return {
    registered_from: from ? from.toISOString() : null,
    registered_before: to ? to.toISOString() : null,
  };
}

/** One status bucket for the picker; code null = no Fireberry status. */
export interface StatusCount {
  kind: "main" | "sub";
  code: number | null;
  name: string | null;
  leads: number;
}

/** Active leads per Fireberry status, inside the registration window. */
export async function fetchStatusCounts(
  agentId: string,
  window: { registered_from: string | null; registered_before: string | null },
): Promise<StatusCount[]> {
  const { data, error } = await supabase.rpc("broadcast_status_counts", {
    p_agent_id: agentId,
    p_registered_from: window.registered_from,
    p_registered_before: window.registered_before,
  });
  if (error) throw error;
  return (data ?? []).map((r) => ({
    kind: r.kind === "main" ? "main" : "sub",
    code: r.code,
    name: r.name,
    leads: Number(r.leads),
  }));
}

export interface StatusSyncState {
  last_run_at: string | null;
  full_sync_done_at: string | null;
  last_error: string | null;
}

/** Sync health for the agent's Fireberry product, or null if it has none. */
export async function fetchStatusSyncState(agentId: string): Promise<StatusSyncState | null> {
  const { data: agent, error: agentErr } = await supabase
    .from("agents")
    .select("fireberry_product_id")
    .eq("id", agentId)
    .maybeSingle();
  if (agentErr) throw agentErr;
  if (!agent?.fireberry_product_id) return null;
  const { data, error } = await supabase
    .from("fireberry_sync_state")
    .select("last_run_at, full_sync_done_at, last_error")
    .eq("product_id", agent.fireberry_product_id)
    .maybeSingle();
  if (error) throw error;
  return data ?? { last_run_at: null, full_sync_done_at: null, last_error: null };
}

/** Kick a sync run now (it continues in the background for up to ~2 minutes). */
export async function triggerStatusSync(): Promise<void> {
  const { error } = await supabase.functions.invoke("fireberry-status-sync", { body: {} });
  if (error) throw error;
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
  /** Bot guidance for replies to this template (broadcastRewarmBlock). */
  reply_instructions: string | null;
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
  reply_instructions: string | null;
}

export async function listAllBroadcastTemplates(agentId: string): Promise<BroadcastTemplateFull[]> {
  const { data, error } = await supabase
    .from("broadcast_templates")
    .select("id, agent_id, name, language, label, variable_count, body_preview, reply_instructions, is_active, created_at")
    .eq("agent_id", agentId)
    .order("created_at", { ascending: false });
  if (error) throw error;
  return (data ?? []) as BroadcastTemplateFull[];
}

export async function createBroadcastTemplate(input: NewBroadcastTemplate): Promise<void> {
  const { error } = await supabase.from("broadcast_templates").insert(input);
  if (error) throw error;
}

/** The two free-text fields the operator can edit after creation. */
export async function updateBroadcastTemplateTexts(
  id: string,
  texts: { body_preview: string | null; reply_instructions: string | null },
): Promise<void> {
  const { error } = await supabase.from("broadcast_templates").update(texts).eq("id", id);
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
