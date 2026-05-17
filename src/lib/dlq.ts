/**
 * Client wrapper for the `failed_messages` DLQ table + dlq-replay edge fn.
 *
 * RLS gates the table to admins. The `dlq-replay` function is also
 * admin-only and runs the actual retry under service_role.
 */
import { supabase } from "./supabase/client";

export interface FailedMessageRow {
  id: string;
  source: string;
  error_type: string;
  error_detail: string | null;
  payload: Record<string, unknown>;
  retry_count: number;
  last_retry_at: string | null;
  resolved_at: string | null;
  resolution_note: string | null;
  created_at: string;
  agent_id: string | null;
  conversation_id: string | null;
}

export interface FailedMessageFilters {
  /** When true, include rows already marked resolved. Default false. */
  includeResolved?: boolean;
  /** Optional error_type filter (e.g. "hookmyapp_send_failed"). */
  errorType?: string;
  limit?: number;
}

export async function listFailedMessages(
  filters: FailedMessageFilters = {},
): Promise<FailedMessageRow[]> {
  const limit = filters.limit ?? 100;
  let q = supabase
    .from("failed_messages")
    .select("*")
    .order("created_at", { ascending: false })
    .limit(limit);
  if (!filters.includeResolved) q = q.is("resolved_at", null);
  if (filters.errorType) q = q.eq("error_type", filters.errorType);
  const { data, error } = await q;
  if (error) throw new Error(`Failed to load DLQ: ${error.message}`);
  return (data ?? []) as FailedMessageRow[];
}

export interface ReplayResult {
  attempted: number;
  succeeded: number;
  failed: number;
  results: Array<{ id: string; success: boolean; reason: string }>;
}

export async function replayFailedMessage(id: string): Promise<ReplayResult> {
  const { data, error } = await supabase.functions.invoke<ReplayResult>("dlq-replay", {
    body: { id },
  });
  if (error) {
    const ctx = (error as unknown as { context?: Response }).context;
    if (ctx) {
      const body = await ctx.json().catch(() => null);
      const msg =
        body && typeof (body as { error?: unknown }).error === "string"
          ? (body as { error: string }).error
          : error.message;
      throw new Error(msg);
    }
    throw new Error(error.message);
  }
  if (!data) throw new Error("dlq-replay returned no data");
  return data;
}

export async function replayBatch(opts: {
  errorType?: string;
  agentId?: string;
  limit?: number;
}): Promise<ReplayResult> {
  const { data, error } = await supabase.functions.invoke<ReplayResult>("dlq-replay", {
    body: { error_type: opts.errorType, agent_id: opts.agentId, limit: opts.limit ?? 25 },
  });
  if (error) {
    const ctx = (error as unknown as { context?: Response }).context;
    if (ctx) {
      const body = await ctx.json().catch(() => null);
      const msg =
        body && typeof (body as { error?: unknown }).error === "string"
          ? (body as { error: string }).error
          : error.message;
      throw new Error(msg);
    }
    throw new Error(error.message);
  }
  if (!data) throw new Error("dlq-replay returned no data");
  return data;
}
