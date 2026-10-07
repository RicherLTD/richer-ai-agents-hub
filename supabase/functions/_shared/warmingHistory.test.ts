import { describe, expect, it } from "vitest";
import {
  buildPriorProfile,
  findOpenerTemplateName,
  trimToWarmingStage,
  type TimedMessage,
} from "./warmingHistory.ts";

const CUTOFF = "2026-10-07T09:03:44.000Z";

// The live status-22 test conversation, abridged: a slot search left open in
// May, the first test round this morning, then the re-armed opener.
const history: TimedMessage[] = [
  { role: "assistant", content: "יש מקומות ביום ראשון! מה עדיף לך?", timestamp: "2026-05-20T17:25:49.525Z" },
  { role: "user", content: "נו תגיד לי אתה מתי פנוי ודאי", timestamp: "2026-05-20T17:26:32.000Z" },
  { role: "assistant", content: "[template:warming_1]", timestamp: "2026-10-07T08:53:01.992Z" },
  { role: "user", content: "הכל טוב, מה איתך?", timestamp: "2026-10-07T08:53:48.000Z" },
  { role: "assistant", content: "מצאתי! יש לי שני זמנים ביום חמישי", timestamp: "2026-10-07T08:54:12.597Z" },
  { role: "assistant", content: "[template:warming_1]", timestamp: "2026-10-07T09:04:01.785Z" },
  { role: "user", content: "הכל טוב, מה איתך?", timestamp: "2026-10-07T09:06:00.000Z" },
];

describe("trimToWarmingStage", () => {
  it("hides everything from before the status event, including the stale slot offer", () => {
    const result = trimToWarmingStage(history, CUTOFF);
    expect(result.messages.map((m) => m.content)).toEqual([
      "[template:warming_1]",
      "הכל טוב, מה איתך?",
    ]);
    expect(result.hiddenCount).toBe(5);
  });

  it("keeps messages the lead sent after the event even before any opener went out", () => {
    const leadWroteFirst: TimedMessage[] = [
      { role: "assistant", content: "מה מתאים לך?", timestamp: "2026-05-20T17:25:49.525Z" },
      { role: "user", content: "היי", timestamp: "2026-10-07T09:05:00.000Z" },
    ];
    const result = trimToWarmingStage(leadWroteFirst, CUTOFF);
    expect(result.messages.map((m) => m.content)).toEqual(["היי"]);
    expect(result.hiddenCount).toBe(1);
  });

  it("leaves the history untouched when nothing predates the event", () => {
    const fresh = history.slice(5);
    const result = trimToWarmingStage(fresh, CUTOFF);
    expect(result.messages).toEqual(fresh);
    expect(result.hiddenCount).toBe(0);
  });

  // A future event timestamp (Fireberry clock skew) would otherwise hide the
  // very message we are replying to. Fail to today's behaviour instead.
  it("does not trim when no message is at or after the cutoff", () => {
    const result = trimToWarmingStage(history, "2026-12-01T00:00:00.000Z");
    expect(result.messages).toEqual(history);
    expect(result.hiddenCount).toBe(0);
  });

  it("does not trim when the cutoff is missing or unparseable", () => {
    expect(trimToWarmingStage(history, null).hiddenCount).toBe(0);
    expect(trimToWarmingStage(history, "not-a-date").hiddenCount).toBe(0);
  });

  it("keeps a row with no timestamp once the current stage has started", () => {
    const withUndated: TimedMessage[] = [
      ...history.slice(0, 6),
      { role: "user", content: "הכל טוב", timestamp: null },
    ];
    const result = trimToWarmingStage(withUndated, CUTOFF);
    expect(result.messages.map((m) => m.content)).toEqual(["[template:warming_1]", "הכל טוב"]);
  });
});

describe("buildPriorProfile", () => {
  it("lists only the facts the lead actually shared", () => {
    const lines = buildPriorProfile({
      q1_age: null,
      q2_motivation: "ראה את הסדרה ורצה לשמוע פרטים",
      q3_dream_change: null,
      q4_blocker: "  ",
      q5_urgency: null,
    });
    expect(lines).toEqual(["What drew them in: ראה את הסדרה ורצה לשמוע פרטים"]);
  });

  it("includes age when known", () => {
    const lines = buildPriorProfile({
      q1_age: 34,
      q2_motivation: null,
      q3_dream_change: "לצאת מהשכירות",
      q4_blocker: null,
      q5_urgency: null,
    });
    expect(lines).toEqual(["Age: 34", "What they want to change: לצאת מהשכירות"]);
  });

  it("returns an empty list when nothing is known", () => {
    expect(buildPriorProfile(null)).toEqual([]);
  });
});

describe("findOpenerTemplateName", () => {
  it("returns the most recent template the bot sent", () => {
    expect(findOpenerTemplateName(history)).toBe("warming_1");
  });

  it("reads the name when the preview carries variables after it", () => {
    const withVars = [{ role: "assistant" as const, content: "[template:series_setton1] {{1}}=דנה" }];
    expect(findOpenerTemplateName(withVars)).toBe("series_setton1");
  });

  it("ignores a lead quoting the marker and returns null when there is none", () => {
    const leadQuoted = [{ role: "user" as const, content: "[template:fake]" }];
    expect(findOpenerTemplateName(leadQuoted)).toBeNull();
    expect(findOpenerTemplateName([])).toBeNull();
  });
});
