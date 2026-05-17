/**
 * Insights — three analytics cards added in Round 2:
 *   1. Funnel drop-off: at which q1..q5 do leads stop answering?
 *   2. Campaign cohorts: which source_campaign converts better to zoom?
 *   3. Health: error rate per service over the last 24h.
 *
 * All three use admin-only queries (RLS already gates the source tables).
 */
import { supabase } from "./supabase/client";

const SAFETY_LIMIT = 2000;
const ONE_DAY_MS = 24 * 60 * 60 * 1000;

// ───────── Funnel drop-off ─────────

export interface FunnelDropoff {
  /** Total conversations observed (with lead_memory row). */
  total: number;
  /** Number of leads that answered q1, q2, q3, q4, q5 respectively. */
  answered: { q1: number; q2: number; q3: number; q4: number; q5: number };
  /** Percent of `total` for each step. */
  percent: { q1: number; q2: number; q3: number; q4: number; q5: number };
}

interface LeadMemoryRow {
  q1_age: number | null;
  q2_motivation: string | null;
  q3_dream_change: string | null;
  q4_blocker: string | null;
  q5_urgency: string | null;
}

export async function getFunnelDropoff(agentId: string): Promise<FunnelDropoff> {
  // lead_memory is keyed by conversation_id; we join via inner select to
  // restrict to conversations for the given agent.
  const { data, error } = await supabase
    .from("lead_memory")
    .select("q1_age, q2_motivation, q3_dream_change, q4_blocker, q5_urgency, conversations!inner(agent_id)")
    .eq("conversations.agent_id", agentId)
    .limit(SAFETY_LIMIT);
  if (error) throw new Error(`Failed to load funnel: ${error.message}`);
  const rows = (data ?? []) as unknown as LeadMemoryRow[];
  const total = rows.length;
  const answered = { q1: 0, q2: 0, q3: 0, q4: 0, q5: 0 };
  for (const r of rows) {
    if (r.q1_age !== null) answered.q1++;
    if (r.q2_motivation !== null) answered.q2++;
    if (r.q3_dream_change !== null) answered.q3++;
    if (r.q4_blocker !== null) answered.q4++;
    if (r.q5_urgency !== null) answered.q5++;
  }
  const pct = (n: number): number =>
    total === 0 ? 0 : Math.round((n / total) * 1000) / 10;
  return {
    total,
    answered,
    percent: {
      q1: pct(answered.q1),
      q2: pct(answered.q2),
      q3: pct(answered.q3),
      q4: pct(answered.q4),
      q5: pct(answered.q5),
    },
  };
}

// ───────── Campaign cohorts ─────────

export interface CampaignCohort {
  campaign: string;
  total: number;
  zoomScheduled: number;
  underage: number;
  opted_out: number;
  conversionPct: number;
}

interface CohortRow {
  source_campaign: string | null;
  current_tag: string | null;
}

export async function getCampaignCohorts(agentId: string): Promise<CampaignCohort[]> {
  const { data, error } = await supabase
    .from("conversations")
    .select("source_campaign, current_tag")
    .eq("agent_id", agentId)
    .limit(SAFETY_LIMIT);
  if (error) throw new Error(`Failed to load cohorts: ${error.message}`);
  const rows = (data ?? []) as CohortRow[];
  const buckets = new Map<string, { total: number; zoom: number; under: number; opted: number }>();
  for (const r of rows) {
    const key = r.source_campaign?.trim() || "(ללא קמפיין)";
    const b = buckets.get(key) ?? { total: 0, zoom: 0, under: 0, opted: 0 };
    b.total++;
    if (r.current_tag === "zoom_scheduled") b.zoom++;
    if (r.current_tag === "underage") b.under++;
    if (r.current_tag === "opted_out") b.opted++;
    buckets.set(key, b);
  }
  const out: CampaignCohort[] = [];
  for (const [campaign, b] of buckets) {
    out.push({
      campaign,
      total: b.total,
      zoomScheduled: b.zoom,
      underage: b.under,
      opted_out: b.opted,
      conversionPct: b.total === 0 ? 0 : Math.round((b.zoom / b.total) * 1000) / 10,
    });
  }
  // Largest cohorts first — usually the most important to scan.
  out.sort((a, b) => b.total - a.total);
  return out;
}

// ───────── System health ─────────

export type HealthLevel = "ok" | "warn" | "error";

export interface ServiceHealth {
  source: string;
  errorCount24h: number;
  level: HealthLevel;
  /** Most recent error message for the operator to glance at. */
  lastMessage: string | null;
  lastAt: string | null;
}

interface ErrorLogRow {
  source: string;
  level: string;
  message: string;
  created_at: string;
}

/**
 * Read the last 24h of error_logs and bucket by `source`. Returns one
 * row per known service plus a synthetic "all errors" total. Sources
 * we expect: whatsapp-webhook, agent-loop, memory-extractor,
 * brain-ingest, prompt-coach, whatsapp-send.
 */
export async function getSystemHealth(): Promise<ServiceHealth[]> {
  const since = new Date(Date.now() - ONE_DAY_MS).toISOString();
  const { data, error } = await supabase
    .from("error_logs")
    .select("source, level, message, created_at")
    .gte("created_at", since)
    .order("created_at", { ascending: false })
    .limit(2000);
  if (error) throw new Error(`Failed to load health: ${error.message}`);
  const rows = (data ?? []) as ErrorLogRow[];

  const buckets = new Map<string, { count: number; lastMsg: string | null; lastAt: string | null }>();
  for (const r of rows) {
    // Skip info-level entries — those are routine, not health signals.
    if (r.level === "info") continue;
    const b = buckets.get(r.source) ?? { count: 0, lastMsg: null, lastAt: null };
    b.count++;
    if (!b.lastMsg) {
      b.lastMsg = r.message;
      b.lastAt = r.created_at;
    }
    buckets.set(r.source, b);
  }

  // Render the canonical sources even when they have zero errors so the
  // operator sees the full picture instead of a confusingly empty card.
  const CANONICAL = [
    "whatsapp-webhook",
    "agent-loop",
    "memory-extractor",
    "brain-ingest",
    "prompt-coach",
    "whatsapp-send",
  ] as const;

  const out: ServiceHealth[] = CANONICAL.map((source) => {
    const b = buckets.get(source);
    if (!b) {
      return { source, errorCount24h: 0, level: "ok", lastMessage: null, lastAt: null };
    }
    const level: HealthLevel = b.count >= 20 ? "error" : b.count >= 5 ? "warn" : "ok";
    return { source, errorCount24h: b.count, level, lastMessage: b.lastMsg, lastAt: b.lastAt };
  });

  // Include any unexpected sources at the end.
  for (const [source, b] of buckets) {
    if (CANONICAL.includes(source as (typeof CANONICAL)[number])) continue;
    const level: HealthLevel = b.count >= 20 ? "error" : b.count >= 5 ? "warn" : "ok";
    out.push({ source, errorCount24h: b.count, level, lastMessage: b.lastMsg, lastAt: b.lastAt });
  }

  return out;
}
