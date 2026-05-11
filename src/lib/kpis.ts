/**
 * Aggregated KPIs for the dashboard home.
 *
 * Strategy: one read of all conversation rows for the active agent,
 * aggregated client-side. At this scale (a few thousand rows max) it's
 * cheaper than maintaining 8 separate count queries, easier to test, and
 * the result is already cacheable via react-query.
 */
import { supabase } from "./supabase/client";
import type {
  Conversation,
  ConversationStatus,
  ConversationTag,
  FunnelStage,
} from "@/types/conversation";

export type FunnelBreakdown = Record<FunnelStage, number>;
export type TagBreakdown = Partial<Record<ConversationTag, number>>;

export interface AgentKpis {
  totalLeads: number;
  newThisWeek: number;
  activeConversations: number;
  zoomScheduled: number;
  hotlist: number;
  qualityScoreAvg: number | null;
  funnelBreakdown: FunnelBreakdown;
  tagBreakdown: TagBreakdown;
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
    tagBreakdown: {},
    recentLeads: [],
  };
}

export function aggregateKpis(rows: Conversation[]): AgentKpis {
  const out = emptyKpis();
  if (rows.length === 0) return out;

  const now = Date.now();
  const weekAgo = now - WEEK_MS;
  let scoreSum = 0;
  let scoreCount = 0;

  for (const row of rows) {
    out.totalLeads += 1;

    if (row.created_at) {
      const t = new Date(row.created_at).getTime();
      if (!Number.isNaN(t) && t >= weekAgo) out.newThisWeek += 1;
    }

    const status = row.status as ConversationStatus | null;
    if (status === "active") out.activeConversations += 1;

    const tag = row.current_tag as ConversationTag | null;
    if (tag) {
      out.tagBreakdown[tag] = (out.tagBreakdown[tag] ?? 0) + 1;
      if (tag === "zoom_scheduled") out.zoomScheduled += 1;
      if (tag === "hotlist" || tag === "hotlist_plus") out.hotlist += 1;
    }
    if (!tag && row.zoom_scheduled_at) {
      // A zoom_scheduled_at value implies a scheduled zoom even if the tag
      // hasn't been refreshed yet.
      out.zoomScheduled += 1;
    }

    const stage = row.funnel_stage as FunnelStage | null;
    if (stage) out.funnelBreakdown[stage] += 1;

    if (typeof row.quality_score === "number") {
      scoreSum += row.quality_score;
      scoreCount += 1;
    }
  }

  out.qualityScoreAvg = scoreCount === 0 ? null : Math.round((scoreSum / scoreCount) * 10) / 10;

  // Most recent 5 by last_interaction_at desc (fall back to created_at).
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
