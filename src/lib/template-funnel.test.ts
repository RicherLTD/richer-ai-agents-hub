import { describe, expect, it } from "vitest";
import {
  aggregateTemplateFunnel,
  normalizePhone,
  type ConversationOutcomeRow,
  type SendRow,
} from "./template-funnel";

const NOW = new Date("2026-06-08T12:00:00Z");
const HOUR = 60 * 60 * 1000;
const ago = (h: number) => new Date(NOW.getTime() - h * HOUR).toISOString();
const ahead = (h: number) => new Date(NOW.getTime() + h * HOUR).toISOString();

function send(p: Partial<SendRow> = {}): SendRow {
  return {
    template_name: "t_a",
    status: "sent",
    sent_at: ago(2),
    created_at: ago(2),
    delivered_at: null,
    read_at: null,
    lead_phone: "+9720000000001",
    ...p,
  };
}

function conv(p: Partial<ConversationOutcomeRow> = {}): ConversationOutcomeRow {
  return {
    lead_phone: "+9720000000001",
    last_inbound_at: null,
    current_tag: null,
    zoom_booked_by: null,
    ...p,
  };
}

describe("normalizePhone", () => {
  it("strips non-digits so +972… and 972… collapse", () => {
    expect(normalizePhone("+972528524113")).toBe("972528524113");
    expect(normalizePhone("972528524113")).toBe("972528524113");
    expect(normalizePhone("+972 52-852-4113")).toBe("972528524113");
  });
});

describe("aggregateTemplateFunnel", () => {
  it("returns [] for no rows", () => {
    expect(aggregateTemplateFunnel([], [])).toEqual([]);
  });

  it("counts sent with zero downstream when nobody replied", () => {
    const out = aggregateTemplateFunnel(
      [send({ lead_phone: "+1" }), send({ lead_phone: "+2" })],
      [],
    );
    expect(out).toHaveLength(1);
    expect(out[0]).toMatchObject({
      templateName: "t_a",
      sent: 2,
      delivered: 0,
      read: 0,
      answered: 0,
      agentZoom: 0,
      selfZoom: 0,
      consentHandoff: 0,
      legacyZoom: 0,
      failed: 0,
      answeredRatePct: 0,
      agentZoomPerSentPct: 0,
      agentZoomPerAnsweredPct: 0,
    });
  });

  it("groups by template_name and sorts by sent desc", () => {
    const out = aggregateTemplateFunnel(
      [
        send({ template_name: "small", lead_phone: "+1" }),
        send({ template_name: "big", lead_phone: "+2" }),
        send({ template_name: "big", lead_phone: "+3" }),
      ],
      [],
    );
    expect(out.map((r) => r.templateName)).toEqual(["big", "small"]);
    expect(out[0].sent).toBe(2);
  });

  it("matches answered via conversation, even across +972 / 972 phone formats", () => {
    const out = aggregateTemplateFunnel(
      [
        send({ lead_phone: "+972528524113" }),
        send({ lead_phone: "+972500000002" }),
      ],
      [
        // reply landed on a sibling row with a different phone format
        conv({ lead_phone: "972528524113", last_inbound_at: ago(1) }),
      ],
    );
    expect(out[0].sent).toBe(2);
    expect(out[0].answered).toBe(1);
    expect(out[0].answeredRatePct).toBe(50);
  });

  it("counts outcomes regardless of when they occurred (cohort bound by sent_at only)", () => {
    const out = aggregateTemplateFunnel(
      [send({ lead_phone: "+1", sent_at: ago(2) })],
      [conv({ lead_phone: "1", last_inbound_at: ahead(48), zoom_booked_by: "agent" })],
      { from: ago(24), to: NOW.toISOString() },
    );
    expect(out[0].answered).toBe(1);
    expect(out[0].agentZoom).toBe(1);
  });

  it("splits zoom by attribution; only agent is the conversion metric", () => {
    const out = aggregateTemplateFunnel(
      [
        send({ lead_phone: "+1" }),
        send({ lead_phone: "+2" }),
        send({ lead_phone: "+3" }),
        send({ lead_phone: "+4" }),
      ],
      [
        conv({ lead_phone: "1", last_inbound_at: ago(1), zoom_booked_by: "agent" }),
        conv({ lead_phone: "2", last_inbound_at: ago(1), zoom_booked_by: "self" }),
        conv({ lead_phone: "3", last_inbound_at: ago(1), zoom_booked_by: "consent_handoff" }),
        conv({ lead_phone: "4", last_inbound_at: ago(1) }),
      ],
    );
    const r = out[0];
    expect(r.sent).toBe(4);
    expect(r.answered).toBe(4);
    expect(r.agentZoom).toBe(1);
    expect(r.selfZoom).toBe(1);
    expect(r.consentHandoff).toBe(1);
    expect(r.agentZoomPerSentPct).toBe(25);
    expect(r.agentZoomPerAnsweredPct).toBe(25);
    expect(r.agentZoom).toBeLessThanOrEqual(r.answered);
  });

  it("classifies a pre-attribution zoom (tag set, booked_by null) as legacy", () => {
    const out = aggregateTemplateFunnel(
      [send({ lead_phone: "+1" })],
      [conv({ lead_phone: "1", current_tag: "zoom_scheduled", zoom_booked_by: null })],
    );
    expect(out[0].legacyZoom).toBe(1);
    expect(out[0].agentZoom).toBe(0);
  });

  it("keeps the strongest zoom category per person (agent > legacy)", () => {
    const out = aggregateTemplateFunnel(
      [send({ lead_phone: "+1" })],
      [
        conv({ lead_phone: "+1", current_tag: "zoom_scheduled", zoom_booked_by: null }),
        conv({ lead_phone: "1", zoom_booked_by: "agent" }),
      ],
    );
    expect(out[0].agentZoom).toBe(1);
    expect(out[0].legacyZoom).toBe(0);
  });

  it("counts delivered and read from the send row; read implies delivered", () => {
    const out = aggregateTemplateFunnel(
      [
        send({ lead_phone: "+1", delivered_at: ago(1), read_at: null }),
        send({ lead_phone: "+2", delivered_at: null, read_at: ago(1) }),
        send({ lead_phone: "+3", delivered_at: null, read_at: null }),
      ],
      [],
    );
    const r = out[0];
    expect(r.sent).toBe(3);
    expect(r.delivered).toBe(2);
    expect(r.read).toBe(1);
    expect(r.read).toBeLessThanOrEqual(r.delivered);
  });

  it("filters the cohort by sent_at with inclusive boundaries", () => {
    const from = ago(10);
    const to = ago(2);
    const out = aggregateTemplateFunnel(
      [
        send({ lead_phone: "+201", sent_at: ago(6) }),
        send({ lead_phone: "+202", sent_at: from }),
        send({ lead_phone: "+203", sent_at: to }),
        send({ lead_phone: "+204", sent_at: ago(20) }),
        send({ lead_phone: "+205", sent_at: ago(1) }),
      ],
      [],
      { from, to },
    );
    expect(out[0].sent).toBe(3);
  });

  it("counts distinct people by normalized phone", () => {
    const out = aggregateTemplateFunnel(
      [
        send({ lead_phone: "+972528524113", sent_at: ago(3) }),
        send({ lead_phone: "972528524113", sent_at: ago(2) }),
      ],
      [],
    );
    expect(out[0].sent).toBe(1);
  });

  it("counts failed by created_at; ignores pending/cancelled; omits empty buckets", () => {
    const out = aggregateTemplateFunnel(
      [
        send({ lead_phone: "+301", status: "failed", sent_at: null, created_at: ago(2) }),
        send({ lead_phone: "+302", status: "pending", sent_at: null }),
        send({ lead_phone: "+303", status: "cancelled", sent_at: null }),
        send({ lead_phone: "+304", status: "sent", sent_at: ago(2) }),
        send({ template_name: "all_pending", lead_phone: "+305", status: "pending", sent_at: null }),
      ],
      [],
    );
    expect(out).toHaveLength(1);
    expect(out[0].templateName).toBe("t_a");
    expect(out[0].failed).toBe(1);
    expect(out[0].sent).toBe(1);
  });

  it("rounds rates to one decimal and guards divide-by-zero", () => {
    const out = aggregateTemplateFunnel(
      [send({ lead_phone: "+1" }), send({ lead_phone: "+2" }), send({ lead_phone: "+3" })],
      [conv({ lead_phone: "1", last_inbound_at: ago(1) })],
    );
    expect(out[0].answeredRatePct).toBe(33.3);
    expect(out[0].agentZoomPerAnsweredPct).toBe(0);
  });
});
