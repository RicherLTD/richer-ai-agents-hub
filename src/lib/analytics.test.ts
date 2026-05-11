import { describe, expect, it } from "vitest";
import type { Conversation } from "@/types/conversation";
import type { Experiment } from "@/types/experiment";
import { aggregateAnalytics } from "./analytics";

function conv(partial: Partial<Conversation>): Conversation {
  return {
    agent_id: "agent-1",
    ai_provider_used: null,
    assigned_advisor_id: null,
    consent_given_at: null,
    consent_text_version: null,
    created_at: null,
    current_tag: null,
    detected_language: null,
    estimated_age: null,
    experiment_variant: null,
    fireberry_lead_id: null,
    funnel_stage: null,
    id: "id-1",
    last_interaction_at: null,
    lead_name: null,
    lead_phone: "+10000000000",
    primary_objection: null,
    prompt_version_used: null,
    qualifies_zoom_basic: null,
    qualifies_zoom_premium: null,
    quality_score: null,
    secondary_objections: null,
    source_campaign: null,
    source_funnel: null,
    status: null,
    tag_subtype: null,
    updated_at: null,
    watched_series_stage: null,
    zoom_scheduled_at: null,
    ...partial,
  };
}

function exp(partial: Partial<Experiment>): Experiment {
  return {
    agent_id: "agent-1",
    description: null,
    ended_at: null,
    id: "exp-1",
    is_active: true,
    name: "default",
    started_at: null,
    variants: null,
    ...partial,
  };
}

describe("aggregateAnalytics", () => {
  it("returns empty buckets for empty input", () => {
    const a = aggregateAnalytics([], []);
    expect(a.primaryObjections).toEqual({});
    expect(a.secondaryObjectionCounts).toEqual({});
    expect(a.aiProviders).toEqual({});
    expect(a.experiments).toEqual([]);
    expect(a.unattributedTotal).toBe(0);
  });

  it("counts primary and secondary objections separately", () => {
    const a = aggregateAnalytics(
      [
        conv({ id: "1", primary_objection: "money", secondary_objections: ["timing", "trust"] }),
        conv({ id: "2", primary_objection: "money", secondary_objections: ["timing"] }),
        conv({ id: "3", primary_objection: "trust" }),
      ],
      [],
    );
    expect(a.primaryObjections).toEqual({ money: 2, trust: 1 });
    expect(a.secondaryObjectionCounts).toEqual({ timing: 2, trust: 1 });
  });

  it("counts AI providers", () => {
    const a = aggregateAnalytics(
      [
        conv({ id: "1", ai_provider_used: "claude" }),
        conv({ id: "2", ai_provider_used: "claude" }),
        conv({ id: "3", ai_provider_used: "gpt" }),
        conv({ id: "4", ai_provider_used: null }),
      ],
      [],
    );
    expect(a.aiProviders).toEqual({ claude: 2, gpt: 1 });
  });

  it("computes per-variant conversion based on zoom_scheduled tag", () => {
    const a = aggregateAnalytics(
      [
        conv({ id: "1", experiment_variant: "A", current_tag: "zoom_scheduled" }),
        conv({ id: "2", experiment_variant: "A", current_tag: "hotlist" }),
        conv({ id: "3", experiment_variant: "B", current_tag: "ghosted" }),
        conv({ id: "4", experiment_variant: "B", zoom_scheduled_at: "2026-04-01T00:00:00Z" }),
      ],
      [exp({ id: "exp-1", variants: ["A", "B"] })],
    );
    const summary = a.experiments[0];
    expect(summary.variants).toHaveLength(2);
    const aStats = summary.variants.find((v) => v.variant === "A")!;
    const bStats = summary.variants.find((v) => v.variant === "B")!;
    expect(aStats.total).toBe(2);
    expect(aStats.zoomScheduled).toBe(1);
    expect(aStats.conversionPct).toBe(50);
    expect(bStats.total).toBe(2);
    expect(bStats.zoomScheduled).toBe(1);
    expect(bStats.conversionPct).toBe(50);
  });

  it("counts conversations without an experiment_variant as unattributed", () => {
    const a = aggregateAnalytics(
      [
        conv({ id: "1", experiment_variant: null }),
        conv({ id: "2", experiment_variant: "A" }),
        conv({ id: "3", experiment_variant: "   " }),
      ],
      [exp({ id: "exp-1", variants: ["A"] })],
    );
    expect(a.unattributedTotal).toBe(2);
    expect(a.experiments[0].variants[0].total).toBe(1);
  });

  it("surfaces drift variants when only a single experiment is active", () => {
    const a = aggregateAnalytics(
      [
        conv({ id: "1", experiment_variant: "C-typo" }),
        conv({ id: "2", experiment_variant: "A" }),
      ],
      [exp({ id: "exp-1", variants: ["A", "B"] })],
    );
    const variants = a.experiments[0].variants.map((v) => v.variant);
    expect(variants).toContain("C-typo");
  });

  it("does not surface drift variants when multiple experiments are active", () => {
    const a = aggregateAnalytics(
      [conv({ id: "1", experiment_variant: "Z" })],
      [
        exp({ id: "exp-1", name: "first", variants: ["A"] }),
        exp({ id: "exp-2", name: "second", variants: ["B"] }),
      ],
    );
    const allVariants = a.experiments.flatMap((s) => s.variants.map((v) => v.variant));
    expect(allVariants).not.toContain("Z");
    expect(a.unattributedTotal).toBe(0); // it had a variant string, just no matching exp
  });

  it("parses experiment.variants from a key/value object too", () => {
    const a = aggregateAnalytics(
      [conv({ id: "1", experiment_variant: "A" })],
      [exp({ id: "exp-1", variants: { A: { weight: 0.5 }, B: { weight: 0.5 } } })],
    );
    const names = a.experiments[0].variants.map((v) => v.variant).sort();
    expect(names).toEqual(["A", "B"]);
  });
});
