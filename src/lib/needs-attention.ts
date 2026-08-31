/**
 * The operator queue — leads a human has to act on.
 *
 * `conversations.needs_attention` (migration 0046) is deliberately separate
 * from `current_tag`: a tag decides whether the bot keeps talking, this
 * decides whether a person has to step in. The two most common reasons leave
 * the bot fully active, so they could never have been expressed as a tag:
 *
 *   bot_failed       the guards rejected every attempt, so nothing reached
 *                    the lead and they are sitting in silence
 *   calendar_closed  the lead wants to book but Mooz has no open slot at
 *                    all — an advisor has to schedule it by hand
 *
 * The queue is cleared automatically when an operator replies from the
 * dashboard or a Zoom gets booked, so what is listed here is genuinely
 * still waiting.
 */
import { supabase } from "./supabase/client";
import type { Conversation } from "@/types/conversation";

export const ATTENTION_REASONS = [
  "bot_failed",
  "calendar_closed",
  "existing_student",
  "red_flag",
] as const;

export type AttentionReason = (typeof ATTENTION_REASONS)[number];

export const ATTENTION_LABEL: Record<AttentionReason, string> = {
  bot_failed: "הבוט לא ענה",
  calendar_closed: "לתאם זום ידנית",
  existing_student: "תלמיד קיים",
  red_flag: "דגל אדום",
};

/** Longer text for a tooltip / detail panel. */
export const ATTENTION_DESCRIPTION: Record<AttentionReason, string> = {
  bot_failed: "הבוט נכשל בניסוח תשובה והליד קיבל הודעת גיבוי בלבד — צריך לענות לו.",
  calendar_closed: "הליד רצה לקבוע זום ואין זמינות ביומן — צריך לתאם איתו פרטנית.",
  existing_student: "הליד כבר רשום כתלמיד או נמצא ברשימה שחורה.",
  red_flag: "עלה דגל אדום בשיחה שדורש בדיקה של נציג.",
};

export function isAttentionReason(value: string | null): value is AttentionReason {
  return value !== null && (ATTENTION_REASONS as readonly string[]).includes(value);
}

/**
 * Every lead currently waiting on a human, newest first.
 *
 * Intentionally NOT bounded by the page's date filter: a lead the bot
 * dropped last week is still waiting today, and hiding it behind a date
 * range is how it gets forgotten.
 */
export async function getNeedsAttentionQueue(
  agentId: string,
): Promise<Conversation[]> {
  const { data, error } = await supabase
    .from("conversations")
    .select("*")
    .eq("agent_id", agentId)
    .not("needs_attention", "is", null)
    .order("needs_attention_at", { ascending: false })
    .limit(200);

  if (error) {
    throw new Error(`Failed to load attention queue: ${error.message}`);
  }
  return data ?? [];
}
