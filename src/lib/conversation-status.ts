/**
 * Unified 5-status display taxonomy.
 *
 * The dashboard exposes a single conversation lifecycle that the
 * non-technical operator can reason about. Internally the DB still
 * carries the original `status` enum + 10-value `current_tag`, but
 * everything visible (filters, badges, KPI breakdowns) is derived from
 * these five buckets, computed from existing columns at read-time so we
 * never need a background job to keep them fresh.
 *
 *   1. template_sent   — agent reached out, lead has not replied yet.
 *   2. opened          — lead replied at least once; conversation alive.
 *   3. zoom_scheduled  — agent booked a zoom (current_tag).
 *   4. requires_human  — bot can't continue (requires_human / block_risk).
 *   5. closed          — explicit closure, opt-out, underage, ghosted,
 *                        or 48h elapsed since the last lead reply.
 *
 * Priority order matters when multiple flags apply: zoom > requires_human
 * > closed > opened > template_sent. See `deriveDisplayStatus()`.
 */
import type { Conversation, ConversationTag } from "@/types/conversation";

export const DISPLAY_STATUSES = [
  "template_sent",
  "opened",
  "zoom_scheduled",
  "requires_human",
  "closed",
] as const;

export type DisplayStatus = (typeof DISPLAY_STATUSES)[number];

export const DISPLAY_STATUS_LABEL: Record<DisplayStatus, string> = {
  template_sent: "טמפלייט נשלח",
  opened: "שיחה נפתחה",
  zoom_scheduled: "נקבע זום",
  requires_human: "דרוש נציג",
  closed: "שיחה סגורה",
};

/** Tone for shadcn Badge. */
export const DISPLAY_STATUS_VARIANT: Record<
  DisplayStatus,
  "default" | "secondary" | "outline" | "destructive"
> = {
  template_sent: "outline",
  opened: "default",
  zoom_scheduled: "default",
  requires_human: "destructive",
  closed: "secondary",
};

export const FORTY_EIGHT_HOURS_MS = 48 * 60 * 60 * 1000;

/** Tags that fold into "שיחה סגורה". */
const CLOSED_TAGS: ReadonlySet<ConversationTag> = new Set<ConversationTag>([
  "opted_out",
  "underage",
  "ghosted",
]);

/** Tags that fold into "דרוש נציג". */
const HUMAN_TAGS: ReadonlySet<ConversationTag> = new Set<ConversationTag>([
  "requires_human",
  "block_risk",
]);

/** Subset of Conversation needed for derivation — keep the surface narrow. */
export interface ConversationStatusInput {
  status: Conversation["status"];
  current_tag: Conversation["current_tag"];
  last_inbound_at: Conversation["last_inbound_at"];
  created_at: Conversation["created_at"];
}

/**
 * Compute the display status from a conversation row.
 *
 * @param conv  Conversation snapshot (only 4 fields needed).
 * @param now   Override the "current time" — used by tests to make the
 *              48h auto-close rule deterministic. Defaults to wall clock.
 */
export function deriveDisplayStatus(
  conv: ConversationStatusInput,
  now: Date = new Date(),
): DisplayStatus {
  const tag = conv.current_tag;

  // 1. Zoom wins outright — even if status is paused or anything else.
  if (tag === "zoom_scheduled") return "zoom_scheduled";

  // 2. Bot can't continue.
  if (tag && HUMAN_TAGS.has(tag)) return "requires_human";

  // 3. Explicit DB-level closure or tag-driven closure.
  if (
    conv.status === "completed" ||
    conv.status === "opted_out" ||
    (tag && CLOSED_TAGS.has(tag))
  ) {
    return "closed";
  }

  // 4. Time-decay closure: 48h since last reply (or since creation if
  //    the lead never replied at all).
  const nowMs = now.getTime();
  const lastInboundMs = parseTimestamp(conv.last_inbound_at);
  if (lastInboundMs !== null) {
    if (nowMs - lastInboundMs > FORTY_EIGHT_HOURS_MS) return "closed";
    return "opened";
  }

  // 5. No reply at all from the lead.
  const createdMs = parseTimestamp(conv.created_at);
  if (createdMs !== null && nowMs - createdMs > FORTY_EIGHT_HOURS_MS) {
    return "closed";
  }
  return "template_sent";
}

function parseTimestamp(value: string | null): number | null {
  if (!value) return null;
  const t = new Date(value).getTime();
  return Number.isNaN(t) ? null : t;
}

/**
 * Tally a list of conversations into a status → count breakdown.
 */
export function statusBreakdown(
  rows: ConversationStatusInput[],
  now: Date = new Date(),
): Record<DisplayStatus, number> {
  const out: Record<DisplayStatus, number> = {
    template_sent: 0,
    opened: 0,
    zoom_scheduled: 0,
    requires_human: 0,
    closed: 0,
  };
  for (const row of rows) {
    out[deriveDisplayStatus(row, now)] += 1;
  }
  return out;
}
