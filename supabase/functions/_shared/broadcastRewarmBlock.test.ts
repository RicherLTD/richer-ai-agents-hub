import { describe, expect, it } from "vitest";
import {
  MAX_TEMPLATE_INSTRUCTIONS_CHARS,
  renderBroadcastRewarmBlock,
  shouldRenderBroadcastRewarm,
} from "./broadcastRewarmBlock.ts";

const NOW = new Date("2026-10-22T07:00:00Z");
const DAY = 24 * 60 * 60 * 1000;

describe("shouldRenderBroadcastRewarm", () => {
  it("renders for a broadcast sent inside the window", () => {
    expect(shouldRenderBroadcastRewarm({ openerSentAt: "2026-10-22T06:58:03Z", contextDays: 14 }, NOW)).toBe(true);
    expect(
      shouldRenderBroadcastRewarm({ openerSentAt: new Date(NOW.getTime() - 14 * DAY).toISOString(), contextDays: 14 }, NOW),
    ).toBe(true);
  });

  it("stops once the broadcast is older than the window", () => {
    expect(
      shouldRenderBroadcastRewarm({ openerSentAt: new Date(NOW.getTime() - 15 * DAY).toISOString(), contextDays: 14 }, NOW),
    ).toBe(false);
  });

  it("does not render without a broadcast, or with a bad window / timestamp", () => {
    expect(shouldRenderBroadcastRewarm({ openerSentAt: null, contextDays: 14 }, NOW)).toBe(false);
    expect(shouldRenderBroadcastRewarm({ openerSentAt: "2026-10-22T06:58:03Z", contextDays: 0 }, NOW)).toBe(false);
    expect(shouldRenderBroadcastRewarm({ openerSentAt: "not a date", contextDays: 14 }, NOW)).toBe(false);
  });

  it("treats a future timestamp (clock skew) as fresh", () => {
    expect(shouldRenderBroadcastRewarm({ openerSentAt: "2026-10-22T07:05:00Z", contextDays: 14 }, NOW)).toBe(true);
  });
});

describe("renderBroadcastRewarmBlock", () => {
  const base = {
    openerText: "היי, מה קורה?\nראיתי שהתעניינת בעבר",
    templateInstructions: null,
    hasHistory: true,
    priorProfile: ["Age: 35", "What they want to change: נחת בבית"],
  };

  it("ends with a blank line, like the other blocks it is concatenated with", () => {
    expect(renderBroadcastRewarmBlock(base).endsWith("\n\n")).toBe(true);
  });

  it("gives the bot the broadcast's actual text, not just the template marker", () => {
    expect(renderBroadcastRewarmBlock(base)).toContain("«היי, מה קורה?\nראיתי שהתעניינת בעבר»");
  });

  // Live 2026-10-22: the bot told the lead the system stopped it.
  it("forbids explaining the system, the warming stage, or a blocking check", () => {
    const block = renderBroadcastRewarmBlock(base);
    expect(block).toContain(`Never mention a broadcast`);
    expect(block).toContain(`"warming stage"`);
    expect(block).toContain("never explain why");
  });

  it("covers both answers to the follow-up: still relevant, and dropped it", () => {
    const block = renderBroadcastRewarmBlock(base);
    expect(block).toContain("They say it is still relevant");
    expect(block).toContain("They say they dropped it");
  });

  it("does not let old answers unlock the Zoom", () => {
    expect(renderBroadcastRewarmBlock(base)).toContain("Answers they gave in the earlier conversation do NOT count");
  });

  it("closes the old threads and lists old facts as background only when there is history", () => {
    const withHistory = renderBroadcastRewarmBlock(base);
    expect(withHistory).toContain("their open threads are CLOSED");
    expect(withHistory).toContain("- Age: 35");
    expect(withHistory).toContain("check that it still holds");

    const fresh = renderBroadcastRewarmBlock({ ...base, hasHistory: false, priorProfile: [] });
    expect(fresh).not.toContain("their open threads are CLOSED");
    expect(fresh).not.toContain("What the lead told you back then");
    expect(fresh).toContain("first WhatsApp conversation with this lead");
  });

  it("adds the operator's per-template guidance when there is some", () => {
    expect(renderBroadcastRewarmBlock(base)).not.toContain("guidance for replies to this specific message");
    const block = renderBroadcastRewarmBlock({ ...base, templateInstructions: "  תשאל מה השתנה  " });
    expect(block).toContain("guidance for replies to this specific message\nתשאל מה השתנה\n");
  });

  it("caps very long per-template guidance", () => {
    const block = renderBroadcastRewarmBlock({ ...base, templateInstructions: "א".repeat(MAX_TEMPLATE_INSTRUCTIONS_CHARS + 500) });
    expect(block).toContain("א".repeat(MAX_TEMPLATE_INSTRUCTIONS_CHARS));
    expect(block).not.toContain("א".repeat(MAX_TEMPLATE_INSTRUCTIONS_CHARS + 1));
  });

  it("says nothing CRM-specific — no rep, no call, no status", () => {
    const block = renderBroadcastRewarmBlock(base);
    expect(block).not.toMatch(/sales rep|CRM status|Current status/);
  });

  it("falls back gracefully when the template text is unknown", () => {
    expect(renderBroadcastRewarmBlock({ ...base, openerText: null })).toContain("exact text is not available");
  });
});
