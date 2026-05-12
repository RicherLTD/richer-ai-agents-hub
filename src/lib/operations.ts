/**
 * Operations metrics — aggregates the per-message trace fields landed in
 * Phase B (`tokens_input`, `tokens_output`, `cost_usd`, `ai_processing_time_ms`)
 * into cost / latency / volume buckets for the Analytics page.
 *
 * Only outbound messages with `cost_usd IS NOT NULL` contribute — those
 * are the ones the agent loop actually generated through Claude. Manual
 * sends from the dashboard ReplyBox don't have token/cost info because
 * they don't go through the model.
 */
import { supabase } from "./supabase/client";

export interface OperationsMetrics {
  /** Sum of outbound cost_usd over the bucket. */
  costToday: number;
  costThisWeek: number;
  costThisMonth: number;
  /** Number of agent-generated replies in the bucket. */
  repliesToday: number;
  repliesThisWeek: number;
  repliesThisMonth: number;
  /** Latency in ms, computed from ai_processing_time_ms of replies this week. */
  latencyP50Ms: number | null;
  latencyP95Ms: number | null;
  /** Average tokens out per reply this week (used for the "verbosity" hint). */
  avgTokensOutThisWeek: number | null;
}

interface MetricRow {
  cost_usd: number | null;
  ai_processing_time_ms: number | null;
  tokens_output: number | null;
  timestamp: string | null;
}

function startOfDay(d: Date): Date {
  const next = new Date(d);
  next.setHours(0, 0, 0, 0);
  return next;
}

function startOfWeek(d: Date): Date {
  const next = startOfDay(d);
  // Sunday is the start of the week in Israeli/business context.
  const day = next.getDay();
  next.setDate(next.getDate() - day);
  return next;
}

function startOfMonth(d: Date): Date {
  const next = startOfDay(d);
  next.setDate(1);
  return next;
}

function percentile(sortedAsc: number[], p: number): number | null {
  if (sortedAsc.length === 0) return null;
  if (sortedAsc.length === 1) return sortedAsc[0];
  const rank = (sortedAsc.length - 1) * p;
  const lower = Math.floor(rank);
  const upper = Math.ceil(rank);
  if (lower === upper) return sortedAsc[lower];
  const weight = rank - lower;
  return sortedAsc[lower] * (1 - weight) + sortedAsc[upper] * weight;
}

/**
 * Fetch the agent's recent outbound messages with cost/latency, then
 * aggregate client-side. We deliberately don't push the aggregation to
 * Postgres because the volumes are small (a few hundred outbound rows
 * per week at full scale) and the math is simpler to test in JS.
 */
export async function getOperationsMetrics(agentId: string): Promise<OperationsMetrics> {
  // Bound the fetch to the last 35 days — plenty for "this month" + headroom.
  const since = new Date();
  since.setDate(since.getDate() - 35);
  since.setHours(0, 0, 0, 0);

  const { data, error } = await supabase
    .from("messages")
    .select(
      "cost_usd, ai_processing_time_ms, tokens_output, timestamp, conversation_id, conversations!inner(agent_id)",
    )
    .eq("direction", "outbound")
    .not("cost_usd", "is", null)
    .gte("timestamp", since.toISOString())
    .eq("conversations.agent_id", agentId)
    .order("timestamp", { ascending: false })
    .limit(5000)
    .returns<MetricRow[]>();

  if (error) {
    throw new Error(`Failed to load operations metrics: ${error.message}`);
  }

  const rows = data ?? [];
  const now = new Date();
  const todayStart = startOfDay(now);
  const weekStart = startOfWeek(now);
  const monthStart = startOfMonth(now);

  let costToday = 0;
  let costWeek = 0;
  let costMonth = 0;
  let repliesToday = 0;
  let repliesWeek = 0;
  let repliesMonth = 0;
  const weekLatencies: number[] = [];
  const weekTokensOut: number[] = [];

  for (const row of rows) {
    if (!row.timestamp || row.cost_usd == null) continue;
    const ts = new Date(row.timestamp);
    if (Number.isNaN(ts.getTime())) continue;
    const cost = Number(row.cost_usd);

    if (ts >= monthStart) {
      costMonth += cost;
      repliesMonth += 1;
    }
    if (ts >= weekStart) {
      costWeek += cost;
      repliesWeek += 1;
      if (typeof row.ai_processing_time_ms === "number") {
        weekLatencies.push(row.ai_processing_time_ms);
      }
      if (typeof row.tokens_output === "number") {
        weekTokensOut.push(row.tokens_output);
      }
    }
    if (ts >= todayStart) {
      costToday += cost;
      repliesToday += 1;
    }
  }

  weekLatencies.sort((a, b) => a - b);
  const avgTokensOut = weekTokensOut.length === 0
    ? null
    : Math.round(weekTokensOut.reduce((a, b) => a + b, 0) / weekTokensOut.length);

  return {
    costToday,
    costThisWeek: costWeek,
    costThisMonth: costMonth,
    repliesToday,
    repliesThisWeek: repliesWeek,
    repliesThisMonth: repliesMonth,
    latencyP50Ms: percentile(weekLatencies, 0.5),
    latencyP95Ms: percentile(weekLatencies, 0.95),
    avgTokensOutThisWeek: avgTokensOut,
  };
}
