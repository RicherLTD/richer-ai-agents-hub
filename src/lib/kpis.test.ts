import { describe, expect, it } from "vitest";
import type { Conversation } from "@/types/conversation";
import { aggregateKpis } from "./kpis";

const NOW = new Date("2026-05-20T12:00:00Z");
const FIVE_HOURS_AGO = new Date(NOW.getTime() - 5 * 60 * 60 * 1000).toISOString();
const TWO_HOURS_AGO = new Date(NOW.getTime() - 2 * 60 * 60 * 1000).toISOString();
const FORTY_NINE_HOURS_AGO = new Date(NOW.getTime() - 49 * 60 * 60 * 1000).toISOString();

function row(partial: Partial<Conversation>): Conversation {
  return {
    agent_id: "agent-1",
    ai_provider_used: null,
    assigned_advisor_id: null,
    consent_given_at: null,
    consent_text_version: null,
    created_at: FIVE_HOURS_AGO,
    current_tag: null,
    detected_language: null,
    estimated_age: null,
    experiment_variant: null,
    fireberry_lead_id: null,
    funnel_stage: null,
    id: "id-1",
    last_inbound_at: null,
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
    status: "active",
    tag_subtype: null,
    updated_at: null,
    watched_series_stage: null,
    zoom_scheduled_at: null,
    ...partial,
  } as Conversation;
}

describe("aggregateKpis", () => {
  it("returns zeros for an empty input", () => {
    const k = aggregateKpis([], NOW);
    expect(k.totalLeads).toBe(0);
    expect(k.newThisWeek).toBe(0);
    expect(k.activeConversations).toBe(0);
    expect(k.zoomScheduled).toBe(0);
    expect(k.hotlist).toBe(0);
    expect(k.qualityScoreAvg).toBeNull();
    expect(k.funnelBreakdown).toEqual({ cold: 0, mid: 0, done: 0 });
    expect(k.statusBreakdown).toEqual({
      template_sent: 0,
      opened: 0,
      zoom_scheduled: 0,
      requires_human: 0,
      closed: 0,
    });
    expect(k.recentLeads).toEqual([]);
  });

  it("counts new this week using created_at", () => {
    const now = NOW.getTime();
    const k = aggregateKpis(
      [
        row({ id: "a", created_at: new Date(now - 60_000).toISOString() }),
        row({ id: "b", created_at: new Date(now - 10 * 24 * 3600 * 1000).toISOString() }),
        row({ id: "c", created_at: null }),
      ],
      NOW,
    );
    expect(k.totalLeads).toBe(3);
    expect(k.newThisWeek).toBe(1);
  });

  it("activeConversations equals statusBreakdown.opened (lead replied within 48h)", () => {
    const k = aggregateKpis(
      [
        row({ id: "1", last_inbound_at: TWO_HOURS_AGO }),
        row({ id: "2", last_inbound_at: TWO_HOURS_AGO }),
        row({ id: "3", last_inbound_at: FORTY_NINE_HOURS_AGO }),
        row({ id: "4", status: "completed" }),
      ],
      NOW,
    );
    expect(k.activeConversations).toBe(2);
    expect(k.statusBreakdown.opened).toBe(2);
    expect(k.statusBreakdown.closed).toBe(2);
  });

  it("zoomScheduled is driven by the unified display status (current_tag = zoom_scheduled)", () => {
    const k = aggregateKpis(
      [
        row({ id: "1", current_tag: "zoom_scheduled" }),
        row({ id: "2", current_tag: "zoom_scheduled" }),
        row({ id: "3", current_tag: "hotlist", last_inbound_at: TWO_HOURS_AGO }),
      ],
      NOW,
    );
    expect(k.zoomScheduled).toBe(2);
    expect(k.statusBreakdown.zoom_scheduled).toBe(2);
  });

  it("counts hotlist (both flavours)", () => {
    const k = aggregateKpis(
      [
        row({ id: "1", current_tag: "hotlist" }),
        row({ id: "2", current_tag: "hotlist_plus" }),
        row({ id: "3", current_tag: "not_hotlist" }),
      ],
      NOW,
    );
    expect(k.hotlist).toBe(2);
  });

  it("breaks down funnel stages", () => {
    const k = aggregateKpis(
      [
        row({ id: "1", funnel_stage: "cold" }),
        row({ id: "2", funnel_stage: "cold" }),
        row({ id: "3", funnel_stage: "mid" }),
        row({ id: "4", funnel_stage: "done" }),
        row({ id: "5", funnel_stage: null }),
      ],
      NOW,
    );
    expect(k.funnelBreakdown).toEqual({ cold: 2, mid: 1, done: 1 });
  });

  it("statusBreakdown maps the old 10-tag world onto the new 5 buckets", () => {
    const k = aggregateKpis(
      [
        row({ id: "1", current_tag: "zoom_scheduled" }),
        row({ id: "2", current_tag: "requires_human" }),
        row({ id: "3", current_tag: "block_risk" }),
        row({ id: "4", current_tag: "ghosted" }),
        row({ id: "5", current_tag: "opted_out" }),
        row({ id: "6", current_tag: "underage" }),
        row({ id: "7", last_inbound_at: TWO_HOURS_AGO }),
        row({ id: "8", last_inbound_at: null, created_at: TWO_HOURS_AGO }),
      ],
      NOW,
    );
    expect(k.statusBreakdown).toEqual({
      zoom_scheduled: 1,
      requires_human: 2,
      closed: 3,
      opened: 1,
      template_sent: 1,
    });
  });

  it("averages quality_score, ignoring nulls, rounded to 1 decimal", () => {
    const k = aggregateKpis(
      [
        row({ id: "1", quality_score: 80 }),
        row({ id: "2", quality_score: 90 }),
        row({ id: "3", quality_score: null }),
      ],
      NOW,
    );
    expect(k.qualityScoreAvg).toBe(85);
  });

  it("returns null avg when no scores are present", () => {
    const k = aggregateKpis([row({ id: "1", quality_score: null })], NOW);
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
    const k = aggregateKpis(rows, NOW);
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
