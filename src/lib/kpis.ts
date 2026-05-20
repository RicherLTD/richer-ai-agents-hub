/**
 * Aggregated KPIs for the dashboard home.
 *
 * Strategy: one read of all conversation rows for the active agent,
 * aggregated client-side. At this scale (a few thousand rows max) it's
 * cheaper than maintaining N separate count queries, easier to test, and
 * the result is already cacheable via react-query.
 *
 * Display status breakdown (טמפלייט / שיחה נפתחה / זום / נציג / סגורה)
 * is computed via the shared `deriveDisplayStatus()` helper so the
 * dashboard and the lists always agree.
 */
import { supabase } from "./supabase/client";
import {
  deriveDisplayStatus,
  statusBreakdown,
  type DisplayStatus,
} from "./conversation-status";
import type {
  Conversation,
  ConversationTag,
  FunnelStage,
} from "@/types/conversation";

export type FunnelBreakdown = Record<FunnelStage, number>;
export type DisplayStatusBreakdown = Record<DisplayStatus, number>;

export interface AgentKpis {
  totalLeads: number;
  newThisWeek: number;
  /** Conversations whose computed display status is `opened`. */
  activeConversations: number;
  /** Conversations whose computed display status is `zoom_scheduled`. */
  zoomScheduled: number;
  hotlist: number;
  qualityScoreAvg: number | null;
  funnelBreakdown: FunnelBreakdown;
  statusBreakdown: DisplayStatusBreakdown;
  /** Up to 5 most-recently-interacted-with conversations. */
  recentLeads: Conversation[];
}

const SAFETY_LIMIT = 2000;
const WEEK_MS = 7 * 24 * 60 * 60 * 1000;

const ZERO_FUNNEL: FunnelBreakdown = { cold: 0, mid: 0, done: 0 };

function emptyKpis(): AgentKpis {
  return {
    totalLeads: 0,
    newThisWeek: 0,
    activeConversations: 0,
    zoomScheduled: 0,
    hotlist: 0,
    qualityScoreAvg: null,
    funnelBreakdown: { ...ZERO_FUNNEL },
    statusBreakdown: {
      template_sent: 0,
      opened: 0,
      zoom_scheduled: 0,
      requires_human: 0,
      closed: 0,
    },
    recentLeads: [],
  };
}

export function aggregateKpis(rows: Conversation[], now: Date = new Date()): AgentKpis {
  const out = emptyKpis();
  if (rows.length === 0) return out;

  const nowMs = now.getTime();
  const weekAgo = nowMs - WEEK_MS;
  let scoreSum = 0;
  let scoreCount = 0;

  out.statusBreakdown = statusBreakdown(rows, now);
  out.activeConversations = out.statusBreakdown.opened;
  out.zoomScheduled = out.statusBreakdown.zoom_scheduled;

  for (const row of rows) {
    out.totalLeads += 1;

    if (row.created_at) {
      const t = new Date(row.created_at).getTime();
      if (!Number.isNaN(t) && t >= weekAgo) out.newThisWeek += 1;
    }

    const tag = row.current_tag as ConversationTag | null;
    if (tag === "hotlist" || tag === "hotlist_plus") out.hotlist += 1;

    const stage = row.funnel_stage as FunnelStage | null;
    if (stage) out.funnelBreakdown[stage] += 1;

    if (typeof row.quality_score === "number") {
      scoreSum += row.quality_score;
      scoreCount += 1;
    }
  }

  out.qualityScoreAvg = scoreCount === 0 ? null : Math.round((scoreSum / scoreCount) * 10) / 10;

  out.recentLeads = [...rows]
    .sort((a, b) => {
      const tA = new Date(a.last_interaction_at ?? a.created_at ?? 0).getTime();
      const tB = new Date(b.last_interaction_at ?? b.created_at ?? 0).getTime();
      return tB - tA;
    })
    .slice(0, 5);

  return out;
}

export async function getKpis(agentId: string): Promise<AgentKpis> {
  const { data, error } = await supabase
    .from("conversations")
    .select("*")
    .eq("agent_id", agentId)
    .limit(SAFETY_LIMIT);

  if (error) {
    throw new Error(`Failed to load KPIs: ${error.message}`);
  }
  return aggregateKpis(data ?? []);
}

// Re-export for callers that just want the display status helper.
export { deriveDisplayStatus };
