/**
 * Aggregations for the Analytics screen.
 *
 * Same single-fetch-then-aggregate pattern as `kpis.ts`:
 *   - Pull every conversation row for the agent (capped 2000).
 *   - Pull experiment definitions for the agent (typically a handful).
 *   - Compute breakdowns client-side.
 */
import { supabase } from "./supabase/client";
import type { Conversation, Objection } from "@/types/conversation";
import type { Experiment } from "@/types/experiment";

const SAFETY_LIMIT = 2000;

export type ObjectionBreakdown = Partial<Record<Objection, number>>;
export type AiProviderBreakdown = Partial<Record<string, number>>;

export interface VariantStats {
  variant: string;
  total: number;
  zoomScheduled: number;
  conversionPct: number;
}

export interface ExperimentSummary {
  experiment: Experiment;
  variants: VariantStats[];
}

export interface AgentAnalytics {
  primaryObjections: ObjectionBreakdown;
  secondaryObjectionCounts: Record<string, number>;
  aiProviders: AiProviderBreakdown;
  experiments: ExperimentSummary[];
  /** Conversations that are tagged but have no recorded variant (sanity check). */
  unattributedTotal: number;
}

export function aggregateAnalytics(
  conversations: Conversation[],
  experiments: Experiment[],
): AgentAnalytics {
  const primaryObjections: ObjectionBreakdown = {};
  const secondaryObjectionCounts: Record<string, number> = {};
  const aiProviders: AiProviderBreakdown = {};
  const variantToStats = new Map<string, { total: number; zoom: number }>();
  let unattributedTotal = 0;

  for (const c of conversations) {
    if (c.primary_objection) {
      primaryObjections[c.primary_objection] = (primaryObjections[c.primary_objection] ?? 0) + 1;
    }
    if (c.secondary_objections) {
      for (const obj of c.secondary_objections) {
        secondaryObjectionCounts[obj] = (secondaryObjectionCounts[obj] ?? 0) + 1;
      }
    }
    if (c.ai_provider_used) {
      aiProviders[c.ai_provider_used] = (aiProviders[c.ai_provider_used] ?? 0) + 1;
    }

    const variant = c.experiment_variant?.trim();
    if (!variant) {
      unattributedTotal += 1;
      continue;
    }
    const bucket = variantToStats.get(variant) ?? { total: 0, zoom: 0 };
    bucket.total += 1;
    const zoomReached =
      c.current_tag === "zoom_scheduled" || Boolean(c.zoom_scheduled_at);
    if (zoomReached) bucket.zoom += 1;
    variantToStats.set(variant, bucket);
  }

  // Group variants under their experiments. Variants are matched by
  // string equality against either the experiment's `variants` JSON
  // (when it's an array of strings) or any variant name listed there.
  const experimentSummaries: ExperimentSummary[] = experiments.map((exp) => {
    const definedVariants = parseVariantNames(exp.variants);
    const seen = new Set<string>();
    const variantStats: VariantStats[] = [];

    for (const name of definedVariants) {
      seen.add(name);
      const stats = variantToStats.get(name) ?? { total: 0, zoom: 0 };
      variantStats.push({
        variant: name,
        total: stats.total,
        zoomScheduled: stats.zoom,
        conversionPct: stats.total === 0 ? 0 : Math.round((stats.zoom / stats.total) * 1000) / 10,
      });
    }
    // Surface any variant strings observed in conversations but not
    // declared on the experiment (drift / typos) so they don't disappear.
    for (const [variant, stats] of variantToStats) {
      if (seen.has(variant)) continue;
      // We can't tell which experiment this variant belongs to — only
      // attach it when the experiment itself is the only active one.
      if (experiments.length === 1) {
        variantStats.push({
          variant,
          total: stats.total,
          zoomScheduled: stats.zoom,
          conversionPct: stats.total === 0 ? 0 : Math.round((stats.zoom / stats.total) * 1000) / 10,
        });
      }
    }
    return { experiment: exp, variants: variantStats };
  });

  return {
    primaryObjections,
    secondaryObjectionCounts,
    aiProviders,
    experiments: experimentSummaries,
    unattributedTotal,
  };
}

function parseVariantNames(raw: unknown): string[] {
  if (Array.isArray(raw)) {
    return raw.filter((v): v is string => typeof v === "string");
  }
  if (raw && typeof raw === "object") {
    return Object.keys(raw as Record<string, unknown>);
  }
  return [];
}

export async function getAnalytics(agentId: string): Promise<AgentAnalytics> {
  const [convResp, expResp] = await Promise.all([
    supabase.from("conversations").select("*").eq("agent_id", agentId).limit(SAFETY_LIMIT),
    supabase.from("experiments").select("*").eq("agent_id", agentId).order("started_at", {
      ascending: false,
      nullsFirst: false,
    }),
  ]);

  if (convResp.error) {
    throw new Error(`Failed to load analytics: ${convResp.error.message}`);
  }
  if (expResp.error) {
    throw new Error(`Failed to load experiments: ${expResp.error.message}`);
  }

  return aggregateAnalytics(convResp.data ?? [], expResp.data ?? []);
}
