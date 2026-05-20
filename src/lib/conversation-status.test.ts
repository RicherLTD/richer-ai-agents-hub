import { describe, expect, it } from "vitest";
import {
  deriveDisplayStatus,
  DISPLAY_STATUSES,
  statusBreakdown,
  type ConversationStatusInput,
  type DisplayStatus,
} from "./conversation-status";

const NOW = new Date("2026-05-20T12:00:00Z");
const FIVE_HOURS_AGO = new Date(NOW.getTime() - 5 * 60 * 60 * 1000).toISOString();
const FORTY_NINE_HOURS_AGO = new Date(NOW.getTime() - 49 * 60 * 60 * 1000).toISOString();
const TWO_HOURS_AGO = new Date(NOW.getTime() - 2 * 60 * 60 * 1000).toISOString();

function row(partial: Partial<ConversationStatusInput>): ConversationStatusInput {
  return {
    status: "active",
    current_tag: null,
    last_inbound_at: null,
    created_at: FIVE_HOURS_AGO,
    ...partial,
  };
}

describe("deriveDisplayStatus", () => {
  it("returns 'zoom_scheduled' when current_tag = zoom_scheduled (highest priority)", () => {
    expect(
      deriveDisplayStatus(
        row({ current_tag: "zoom_scheduled", status: "paused" }),
        NOW,
      ),
    ).toBe<DisplayStatus>("zoom_scheduled");
  });

  it("returns 'requires_human' for requires_human and block_risk tags", () => {
    expect(deriveDisplayStatus(row({ current_tag: "requires_human" }), NOW)).toBe(
      "requires_human",
    );
    expect(deriveDisplayStatus(row({ current_tag: "block_risk" }), NOW)).toBe(
      "requires_human",
    );
  });

  it("returns 'closed' for opted_out / underage / ghosted tags", () => {
    for (const tag of ["opted_out", "underage", "ghosted"] as const) {
      expect(deriveDisplayStatus(row({ current_tag: tag }), NOW)).toBe("closed");
    }
  });

  it("returns 'closed' when status is completed or opted_out", () => {
    expect(deriveDisplayStatus(row({ status: "completed" }), NOW)).toBe("closed");
    expect(deriveDisplayStatus(row({ status: "opted_out" }), NOW)).toBe("closed");
  });

  it("returns 'template_sent' when lead has not replied and conversation is fresh (<48h)", () => {
    expect(
      deriveDisplayStatus(
        row({ last_inbound_at: null, created_at: TWO_HOURS_AGO }),
        NOW,
      ),
    ).toBe("template_sent");
  });

  it("returns 'closed' when lead has not replied and conversation is older than 48h", () => {
    expect(
      deriveDisplayStatus(
        row({ last_inbound_at: null, created_at: FORTY_NINE_HOURS_AGO }),
        NOW,
      ),
    ).toBe("closed");
  });

  it("returns 'opened' when lead replied within the last 48h", () => {
    expect(
      deriveDisplayStatus(
        row({ last_inbound_at: TWO_HOURS_AGO, created_at: FORTY_NINE_HOURS_AGO }),
        NOW,
      ),
    ).toBe("opened");
  });

  it("returns 'closed' when lead's last reply is older than 48h (ghosted)", () => {
    expect(
      deriveDisplayStatus(
        row({ last_inbound_at: FORTY_NINE_HOURS_AGO }),
        NOW,
      ),
    ).toBe("closed");
  });

  it("zoom tag wins over a stale last_inbound_at", () => {
    expect(
      deriveDisplayStatus(
        row({
          current_tag: "zoom_scheduled",
          last_inbound_at: FORTY_NINE_HOURS_AGO,
        }),
        NOW,
      ),
    ).toBe("zoom_scheduled");
  });

  it("requires_human wins over a stale last_inbound_at", () => {
    expect(
      deriveDisplayStatus(
        row({
          current_tag: "requires_human",
          last_inbound_at: FORTY_NINE_HOURS_AGO,
        }),
        NOW,
      ),
    ).toBe("requires_human");
  });

  it("hotlist / not_hotlist / questionnaire tags do not change the display status", () => {
    // These are quality tags — they shouldn't influence the lifecycle bucket.
    for (const tag of ["hotlist", "hotlist_plus", "not_hotlist", "questionnaire"] as const) {
      expect(
        deriveDisplayStatus(
          row({ current_tag: tag, last_inbound_at: TWO_HOURS_AGO }),
          NOW,
        ),
      ).toBe("opened");
    }
  });
});

describe("statusBreakdown", () => {
  it("tallies a mixed batch correctly", () => {
    const rows: ConversationStatusInput[] = [
      row({ current_tag: "zoom_scheduled" }),
      row({ current_tag: "zoom_scheduled" }),
      row({ current_tag: "requires_human" }),
      row({ current_tag: "block_risk" }),
      row({ current_tag: "opted_out" }),
      row({ status: "completed" }),
      row({ last_inbound_at: TWO_HOURS_AGO }),
      row({ last_inbound_at: null, created_at: TWO_HOURS_AGO }),
      row({ last_inbound_at: null, created_at: TWO_HOURS_AGO }),
      row({ last_inbound_at: FORTY_NINE_HOURS_AGO }),
    ];
    const out = statusBreakdown(rows, NOW);
    expect(out).toEqual({
      zoom_scheduled: 2,
      requires_human: 2,
      closed: 3,
      opened: 1,
      template_sent: 2,
    });
    const total = DISPLAY_STATUSES.reduce((s, k) => s + out[k], 0);
    expect(total).toBe(rows.length);
  });

  it("returns all zeros for empty input", () => {
    expect(statusBreakdown([], NOW)).toEqual({
      template_sent: 0,
      opened: 0,
      zoom_scheduled: 0,
      requires_human: 0,
      closed: 0,
    });
  });
});
