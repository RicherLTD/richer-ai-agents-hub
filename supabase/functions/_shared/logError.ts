// logError.ts
//
// Structured logging helper for edge functions. Writes a row to the
// `error_logs` table (created in migration 0009) so failures are queryable
// from the dashboard instead of stranded in Supabase function logs.
//
// Always also calls console.error/warn/info as a fallback — if the DB
// insert itself fails (e.g. RLS misconfig, service role lost) we still
// want the failure visible in the Supabase function log stream.
//
// This helper NEVER throws. The caller is already in an error path; the
// last thing we want is the logger blowing up the response.

import type { SupabaseClient } from "https://esm.sh/@supabase/supabase-js@2.45.4";
import { truncate } from "./truncate.ts";

export type LogLevel = "error" | "warn" | "info";

export interface LogErrorInput {
  /** Service-role Supabase client (bypasses RLS). */
  admin: SupabaseClient;
  level?: LogLevel;
  /** Free-text emitter label, e.g. "whatsapp-webhook", "agent-loop". */
  source: string;
  /** Short stable code per failure mode, e.g. "claude_empty_reply". */
  errorType: string;
  /** Human-readable message. Truncated to MAX_MESSAGE_CHARS before insert. */
  message: string;
  /** Optional structured context bag — status codes, retry counts, etc. */
  context?: Record<string, unknown>;
  agentId?: string | null;
  conversationId?: string | null;
}

// Keep messages bounded so a 100 KB stack trace doesn't bloat the table.
// 2000 chars covers normal stack traces; rare oversized payloads get
// the `[truncated]` marker so a future reader knows the original was longer.
const MAX_MESSAGE_CHARS = 2000;

export async function logError(input: LogErrorInput): Promise<void> {
  const level: LogLevel = input.level ?? "error";
  // Guard against empty/missing messages — an empty row in error_logs
  // satisfies NOT NULL but tells the on-call nothing.
  const rawMessage = input.message?.trim() ? input.message : "(no message provided)";
  const message = truncate(rawMessage, MAX_MESSAGE_CHARS);

  // Mirror to stderr so the failure is also visible in Supabase function
  // logs without an extra DB query.
  const consoleFn = level === "error"
    ? console.error
    : level === "warn"
    ? console.warn
    : console.info;
  consoleFn(`[${input.source}] ${input.errorType}: ${message}`, input.context ?? {});

  try {
    const { error } = await input.admin.from("error_logs").insert({
      level,
      source: input.source,
      error_type: input.errorType,
      message,
      context: (input.context ?? {}) as Record<string, unknown>,
      agent_id: input.agentId ?? null,
      conversation_id: input.conversationId ?? null,
    });
    if (error) {
      // Don't recurse into logError — fall back to console only.
      console.error(
        `[logError] failed to persist error_log row: ${error.message}`,
        { originalSource: input.source, originalType: input.errorType },
      );
    }
  } catch (insertErr) {
    console.error(
      `[logError] exception while inserting error_log: ${
        insertErr instanceof Error ? insertErr.message : String(insertErr)
      }`,
      { originalSource: input.source, originalType: input.errorType },
    );
  }
}
