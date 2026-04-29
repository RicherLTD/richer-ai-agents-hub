import { describe, expect, it } from "vitest";
import type { Conversation } from "@/types/conversation";
import { aggregateKpis } from "./kpis";

function row(partial: Partial<Conversation>): Conversation {
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

describe("aggregateKpis", () => {
  it("returns zeros for an empty input", () => {
    const k = aggregateKpis([]);
    expect(k.totalLeads).toBe(0);
    expect(k.newThisWeek).toBe(0);
    expect(k.activeConversations).toBe(0);
    expect(k.zoomScheduled).toBe(0);
    expect(k.hotlist).toBe(0);
    expect(k.qualityScoreAvg).toBeNull();
    expect(k.funnelBreakdown).toEqual({ cold: 0, mid: 0, done: 0 });
    expect(k.tagBreakdown).toEqual({});
    expect(k.recentLeads).toEqual([]);
  });

  it("counts new this week using created_at", () => {
    const now = Date.now();
    const k = aggregateKpis([
      row({ id: "a", created_at: new Date(now - 60_000).toISOString() }),
      row({ id: "b", created_at: new Date(now - 10 * 24 * 3600 * 1000).toISOString() }),
      row({ id: "c", created_at: null }),
    ]);
    expect(k.totalLeads).toBe(3);
    expect(k.newThisWeek).toBe(1);
  });

  it("counts active conversations from status", () => {
    const k = aggregateKpis([
      row({ id: "1", status: "active" }),
      row({ id: "2", status: "paused" }),
      row({ id: "3", status: "active" }),
      row({ id: "4", status: "completed" }),
    ]);
    expect(k.activeConversations).toBe(2);
  });

  it("counts zoom_scheduled by tag and falls back to zoom_scheduled_at", () => {
    const k = aggregateKpis([
      row({ id: "1", current_tag: "zoom_scheduled" }),
      row({ id: "2", current_tag: null, zoom_scheduled_at: "2026-01-01T00:00:00Z" }),
      row({ id: "3", current_tag: "hotlist" }),
    ]);
    expect(k.zoomScheduled).toBe(2);
  });

  it("counts hotlist (both flavours)", () => {
    const k = aggregateKpis([
      row({ id: "1", current_tag: "hotlist" }),
      row({ id: "2", current_tag: "hotlist_plus" }),
      row({ id: "3", current_tag: "not_hotlist" }),
    ]);
    expect(k.hotlist).toBe(2);
  });

  it("breaks down funnel stages", () => {
    const k = aggregateKpis([
      row({ id: "1", funnel_stage: "cold" }),
      row({ id: "2", funnel_stage: "cold" }),
      row({ id: "3", funnel_stage: "mid" }),
      row({ id: "4", funnel_stage: "done" }),
      row({ id: "5", funnel_stage: null }),
    ]);
    expect(k.funnelBreakdown).toEqual({ cold: 2, mid: 1, done: 1 });
  });

  it("breaks down tags and skips null tags", () => {
    const k = aggregateKpis([
      row({ id: "1", current_tag: "hotlist" }),
      row({ id: "2", current_tag: "hotlist" }),
      row({ id: "3", current_tag: "ghosted" }),
      row({ id: "4", current_tag: null }),
    ]);
    expect(k.tagBreakdown).toEqual({ hotlist: 2, ghosted: 1 });
  });

  it("averages quality_score, ignoring nulls, rounded to 1 decimal", () => {
    const k = aggregateKpis([
      row({ id: "1", quality_score: 80 }),
      row({ id: "2", quality_score: 90 }),
      row({ id: "3", quality_score: null }),
    ]);
    expect(k.qualityScoreAvg).toBe(85);
  });

  it("returns null avg when no scores are present", () => {
    const k = aggregateKpis([row({ id: "1", quality_score: null })]);
    expect(k.qualityScoreAvg).toBeNull();
  });

  it("returns up to 5 most-recent leads, ordered by last_interaction_at desc", () => {
    const rows = [
      row({ id: "old", last_interaction_at: "2026-01-01T00:00:00Z" }),
      row({ id: "newer", last_interaction_at: "2026-04-01T00:00:00Z" }),
      row({ id: "newest", last_interaction_at: "2026-04-29T00:00:00Z" }),
      row({ id: "via-created", last_interaction_at: null, created_at: "2026-02-01T00:00:00Z" }),
      row({ id: "no-dates", last_interaction_at: null, created_at: null }),
      row({ id: "extra1", last_interaction_at: "2026-03-01T00:00:00Z" }),
      row({ id: "extra2", last_interaction_at: "2026-03-15T00:00:00Z" }),
    ];
    const k = aggregateKpis(rows);
    expect(k.recentLeads).toHaveLength(5);
    expect(k.recentLeads.map((r) => r.id)).toEqual([
      "newest",
      "newer",
      "extra2",
      "extra1",
      "via-created",
    ]);
  });
});
