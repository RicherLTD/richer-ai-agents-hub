import { describe, expect, it } from "vitest";
import {
  computeWarmingAllowance,
  israelDayStartIso,
  sortByReleasePriority,
} from "./warmingRelease.ts";

const NOW = new Date("2026-08-10T12:00:00.000Z");

function secondsAgo(n: number): string {
  return new Date(NOW.getTime() - n * 1000).toISOString();
}

const BASE = { lastSentAt: null, sentToday: 0, minGapSeconds: 90, dailyCap: 50 };

describe("computeWarmingAllowance", () => {
  it("allows a send when nothing has gone out yet", () => {
    const a = computeWarmingAllowance(BASE, NOW);
    expect(a.allowed).toBe(1);
    expect(a.blockedBy).toBeNull();
  });

  describe("minimum gap", () => {
    it("blocks inside the gap and reports the wait", () => {
      const a = computeWarmingAllowance({ ...BASE, lastSentAt: secondsAgo(30) }, NOW);
      expect(a.allowed).toBe(0);
      expect(a.blockedBy).toBe("min_gap");
      expect(a.retryAfterSeconds).toBe(60);
    });

    it("allows once the gap has elapsed", () => {
      expect(computeWarmingAllowance({ ...BASE, lastSentAt: secondsAgo(91) }, NOW).allowed).toBe(1);
    });

    it("treats the exact boundary as elapsed", () => {
      expect(computeWarmingAllowance({ ...BASE, lastSentAt: secondsAgo(90) }, NOW).allowed).toBe(1);
    });

    // Spacing means one at a time by definition — releasing two together
    // would violate the gap between those two.
    it("releases at most one at a time while spacing is on", () => {
      expect(computeWarmingAllowance({ ...BASE, sentToday: 0, dailyCap: 500 }, NOW).allowed).toBe(1);
    });

    it("lets the cap be the only limit when spacing is disabled", () => {
      const a = computeWarmingAllowance(
        { ...BASE, minGapSeconds: 0, sentToday: 10, dailyCap: 50 },
        NOW,
      );
      expect(a.allowed).toBe(40);
      expect(a.blockedBy).toBeNull();
    });

    // Fail closed: a corrupt timestamp must not read as "never sent".
    it("waits a full gap on an unparseable last-sent timestamp", () => {
      const a = computeWarmingAllowance({ ...BASE, lastSentAt: "not-a-date" }, NOW);
      expect(a.allowed).toBe(0);
      expect(a.blockedBy).toBe("min_gap");
      expect(a.retryAfterSeconds).toBe(90);
    });

    it("treats a future timestamp as just-sent rather than as elapsed", () => {
      const a = computeWarmingAllowance({ ...BASE, lastSentAt: secondsAgo(-30) }, NOW);
      expect(a.allowed).toBe(0);
      expect(a.blockedBy).toBe("min_gap");
    });
  });

  describe("daily cap", () => {
    it("blocks once the cap is reached", () => {
      const a = computeWarmingAllowance({ ...BASE, sentToday: 50, dailyCap: 50 }, NOW);
      expect(a.allowed).toBe(0);
      expect(a.blockedBy).toBe("daily_cap");
    });

    it("blocks when already over the cap", () => {
      expect(
        computeWarmingAllowance({ ...BASE, sentToday: 80, dailyCap: 50 }, NOW).blockedBy,
      ).toBe("daily_cap");
    });

    // The cap outranks spacing: no point reporting a 90-second wait for
    // something that cannot go out until tomorrow.
    it("reports the cap, not the gap, when both would block", () => {
      const a = computeWarmingAllowance(
        { ...BASE, lastSentAt: secondsAgo(1), sentToday: 50, dailyCap: 50 },
        NOW,
      );
      expect(a.blockedBy).toBe("daily_cap");
    });

    // A 0 in a "daily cap" box must never mean unlimited messaging to leads
    // whose opt-in we cannot prove.
    it("treats a cap of 0 as zero sends, not unlimited", () => {
      const a = computeWarmingAllowance({ ...BASE, dailyCap: 0 }, NOW);
      expect(a.allowed).toBe(0);
      expect(a.blockedBy).toBe("daily_cap");
    });

    it("fails closed on a non-finite cap", () => {
      expect(computeWarmingAllowance({ ...BASE, dailyCap: NaN }, NOW).allowed).toBe(0);
    });
  });
});

describe("sortByReleasePriority", () => {
  it("puts the highest priority first", () => {
    const sorted = sortByReleasePriority([
      { id: "cold", release_priority: 20, scheduled_for: "2026-08-01T00:00:00.000Z" },
      { id: "ghosted", release_priority: 100, scheduled_for: "2026-08-09T00:00:00.000Z" },
      { id: "noanswer", release_priority: 40, scheduled_for: "2026-08-05T00:00:00.000Z" },
    ]);
    expect(sorted.map((r) => r.id)).toEqual(["ghosted", "noanswer", "cold"]);
  });

  // The whole point: a hot lead must not queue behind older cold ones.
  it("beats age with priority", () => {
    const sorted = sortByReleasePriority([
      { id: "old-cold", release_priority: 20, scheduled_for: "2026-01-01T00:00:00.000Z" },
      { id: "new-hot", release_priority: 100, scheduled_for: "2026-08-10T00:00:00.000Z" },
    ]);
    expect(sorted[0].id).toBe("new-hot");
  });

  it("falls back to oldest-first inside a priority band", () => {
    const sorted = sortByReleasePriority([
      { id: "newer", release_priority: 50, scheduled_for: "2026-08-09T00:00:00.000Z" },
      { id: "older", release_priority: 50, scheduled_for: "2026-08-02T00:00:00.000Z" },
    ]);
    expect(sorted.map((r) => r.id)).toEqual(["older", "newer"]);
  });

  it("treats a missing priority as the neutral middle", () => {
    const sorted = sortByReleasePriority([
      { id: "low", release_priority: 10, scheduled_for: null },
      { id: "unset", scheduled_for: null },
      { id: "high", release_priority: 90, scheduled_for: null },
    ]);
    expect(sorted.map((r) => r.id)).toEqual(["high", "unset", "low"]);
  });

  it("does not mutate the input", () => {
    const rows = [
      { id: "a", release_priority: 10 },
      { id: "b", release_priority: 90 },
    ];
    sortByReleasePriority(rows);
    expect(rows.map((r) => r.id)).toEqual(["a", "b"]);
  });

  it("survives an empty list", () => {
    expect(sortByReleasePriority([])).toEqual([]);
  });
});

describe("israelDayStartIso", () => {
  it("returns an instant at or before now", () => {
    const start = new Date(israelDayStartIso(NOW));
    expect(start.getTime()).toBeLessThanOrEqual(NOW.getTime());
  });

  it("lands within the last 24 hours", () => {
    const start = new Date(israelDayStartIso(NOW));
    expect(NOW.getTime() - start.getTime()).toBeLessThan(24 * 60 * 60 * 1000);
  });

  // Israel is UTC+3 in August, so local midnight is 21:00 UTC the previous day.
  it("resolves to local midnight, not UTC midnight", () => {
    expect(israelDayStartIso(NOW)).toBe("2026-08-09T21:00:00.000Z");
  });

  it("is stable across two moments in the same local day", () => {
    const a = israelDayStartIso(new Date("2026-08-10T08:00:00.000Z"));
    const b = israelDayStartIso(new Date("2026-08-10T18:00:00.000Z"));
    expect(a).toBe(b);
  });
});
