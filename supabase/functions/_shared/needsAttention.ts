// needsAttention.ts
//
// The operator queue: "a human must act on this lead".
//
// Deliberately separate from conversations.current_tag. current_tag decides
// whether the bot talks (BLOCKING_TAGS mutes the agent loop); needs_attention
// decides whether a person has to step in. Conflating them meant the only way
// to flag a lead was to silence the bot forever — useless for the two cases
// that matter most, where the lead is warm and still typing:
//
//   bot_failed       the guards rejected every attempt / the model was down,
//                    so NOTHING reached the lead. They are waiting. 64 of
//                    these in 14 days went unnoticed because the alert path
//                    was also broken.
//   calendar_closed  the lead wants to book and Mooz has no open slot
//                    anywhere in the horizon — an advisor schedules manually.
//
// Both leave the bot active. The flag drives the dashboard queue and one
// WhatsApp alert to the operators.
//
// Nothing here throws: a failure to flag must never break the agent turn
// that is trying to serve the lead.

import type { SupabaseClient } from "https://esm.sh/@supabase/supabase-js@2.45.4";

export type AttentionReason =
  | "bot_failed"
  | "calendar_closed"
  | "existing_student"
  | "red_flag";

/** Hebrew text that lands in the operator alert's reason variable ({{4}}).
 *  Single-line by contract — Meta rejects a template parameter containing a
 *  newline (see alertOperators.sanitiseTemplateVariable). */
export const ATTENTION_REASON_LABELS: Record<AttentionReason, string> = {
  bot_failed: "הבוט לא הצליח לענות — הליד ממתין לתשובה",
  calendar_closed: "אין זמינות ביומן — צריך לתאם זום ידנית",
  existing_student: "כבר תלמיד רשום או ברשימה שחורה",
  red_flag: "עלה דגל אדום בשיחה",
};

/** One alert per conversation per reason per 6h. Without this, a lead who
 *  keeps writing while the bot keeps failing generates an alert per turn and
 *  the operators start ignoring the channel — which is how a real alert gets
 *  missed. A NEW reason bypasses the window: it is new information. */
export const ATTENTION_ALERT_DEDUP_MS = 6 * 60 * 60 * 1000;

export function shouldAlertNow(args: {
  /** conversations.needs_attention_alerted_at */
  lastAlertedAt: string | null;
  /** conversations.needs_attention as it was BEFORE this flag. */
  previousReason: string | null;
  reason: AttentionReason;
  nowMs: number;
}): boolean {
  // A different reason is always worth telling the operator about.
  if (args.previousReason !== args.reason) return true;
  if (!args.lastAlertedAt) return true;
  const last = Date.parse(args.lastAlertedAt);
  // Unparseable → alert. Erring toward a duplicate alert is far cheaper than
  // erring toward a lead nobody looks at.
  if (Number.isNaN(last)) return true;
  return args.nowMs - last >= ATTENTION_ALERT_DEDUP_MS;
}

export interface FlagAttentionArgs {
  admin: SupabaseClient;
  conversationId: string;
  reason: AttentionReason;
  /** Fires the operator alert. Called only when the dedup window allows it.
   *  Receives the Hebrew reason label to put in the alert. */
  sendAlert?: (label: string) => Promise<void>;
}

export interface FlagAttentionResult {
  flagged: boolean;
  alerted: boolean;
}

/**
 * Mark the conversation as needing a human and — subject to the dedup window
 * — fire the operator alert. Safe to call on every failing turn.
 */
export async function flagNeedsAttention(
  args: FlagAttentionArgs,
): Promise<FlagAttentionResult> {
  const result: FlagAttentionResult = { flagged: false, alerted: false };
  const nowMs = Date.now();
  const nowIso = new Date(nowMs).toISOString();

  let previousReason: string | null = null;
  let lastAlertedAt: string | null = null;
  try {
    const { data } = await args.admin
      .from("conversations")
      .select("needs_attention, needs_attention_alerted_at")
      .eq("id", args.conversationId)
      .maybeSingle();
    const row = (data ?? {}) as Record<string, unknown>;
    previousReason = (row.needs_attention as string | null) ?? null;
    lastAlertedAt = (row.needs_attention_alerted_at as string | null) ?? null;
  } catch (err) {
    console.error(
      `[needsAttention] read failed: ${err instanceof Error ? err.message : String(err)}`,
    );
  }

  const alertNow = shouldAlertNow({
    lastAlertedAt,
    previousReason,
    reason: args.reason,
    nowMs,
  });

  const patch: Record<string, unknown> = {
    needs_attention: args.reason,
    needs_attention_at: nowIso,
  };
  if (alertNow) patch.needs_attention_alerted_at = nowIso;

  try {
    const { error } = await args.admin
      .from("conversations")
      .update(patch)
      .eq("id", args.conversationId);
    if (error) {
      console.error(`[needsAttention] update failed: ${error.message}`);
    } else {
      result.flagged = true;
    }
  } catch (err) {
    console.error(
      `[needsAttention] update threw: ${err instanceof Error ? err.message : String(err)}`,
    );
  }

  if (alertNow && args.sendAlert) {
    try {
      await args.sendAlert(ATTENTION_REASON_LABELS[args.reason]);
      result.alerted = true;
    } catch (err) {
      console.error(
        `[needsAttention] sendAlert threw: ${err instanceof Error ? err.message : String(err)}`,
      );
    }
  }
  return result;
}

/**
 * Clear the flag — the lead has been served. Called when an operator replies
 * manually or a Zoom gets booked. Without this the queue only ever grows and
 * stops being a queue.
 */
export async function clearNeedsAttention(args: {
  admin: SupabaseClient;
  conversationId: string;
}): Promise<void> {
  try {
    await args.admin
      .from("conversations")
      .update({
        needs_attention: null,
        needs_attention_at: null,
        // alerted_at is deliberately left in place: it is the dedup memory,
        // and wiping it would let an immediate re-failure re-alert at once.
      })
      .eq("id", args.conversationId);
  } catch (err) {
    console.error(
      `[needsAttention] clear threw: ${err instanceof Error ? err.message : String(err)}`,
    );
  }
}
