// dlq.ts
//
// Dead-letter queue helper. Writes a row to `failed_messages` (migration
// 0008) when an outbound message could not be delivered or recorded.
//
// Pair every DLQ write with a `logError` call so the operational view
// (error_logs) and the recovery queue (failed_messages) stay in sync.
//
// Like logError, this helper NEVER throws. The caller is already in an
// error path; we don't want the recovery code to blow up.

import type { SupabaseClient } from "https://esm.sh/@supabase/supabase-js@2.45.4";
import { truncate } from "./truncate.ts";

export interface DlqEntry {
  /** Service-role Supabase client. */
  admin: SupabaseClient;
  /** Emitter label — matches the error_logs `source` for cross-reference. */
  source: string;
  /** Stable failure code, matches error_logs `error_type`. */
  errorType: string;
  /** Optional raw error string (provider response, exception message). */
  errorDetail?: string | null;
  /** The thing we were trying to send. Used for manual replay. */
  payload: Record<string, unknown>;
  agentId?: string | null;
  conversationId?: string | null;
}

// Free-text error_detail can be very long (HookMyApp HTML error page,
// full Claude API response). Cap so the DLQ row stays readable.
const MAX_DETAIL_CHARS = 5000;

/**
 * Insert a row into `failed_messages`. Returns the inserted row's id, or
 * null if the insert itself failed (in which case the caller still has
 * the logError trail in error_logs).
 */
export async function enqueueFailedMessage(entry: DlqEntry): Promise<string | null> {
  try {
    const { data, error } = await entry.admin
      .from("failed_messages")
      .insert({
        source: entry.source,
        error_type: entry.errorType,
        error_detail: entry.errorDetail
          ? truncate(entry.errorDetail, MAX_DETAIL_CHARS)
          : null,
        payload: entry.payload,
        agent_id: entry.agentId ?? null,
        conversation_id: entry.conversationId ?? null,
      })
      .select("id")
      .single();
    if (error) {
      console.error(
        `[dlq] failed to enqueue failed_message: ${error.message}`,
        { source: entry.source, errorType: entry.errorType },
      );
      return null;
    }
    // Runtime narrow — don't trust the inferred shape blindly.
    if (data && typeof (data as { id?: unknown }).id === "string") {
      return (data as { id: string }).id;
    }
    return null;
  } catch (insertErr) {
    console.error(
      `[dlq] exception while enqueueing failed_message: ${
        insertErr instanceof Error ? insertErr.message : String(insertErr)
      }`,
      { source: entry.source, errorType: entry.errorType },
    );
    return null;
  }
}
