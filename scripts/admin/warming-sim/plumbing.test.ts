import { describe, expect, it } from "vitest";
import { CliUsageError, DEFAULT_CONCURRENCY, DEFAULT_MAX_COST_USD, parseCliArgs } from "./cli.ts";
import { ReadOnlyViolationError, assertReadOnlySql, createReadOnlyDb } from "./db.ts";
import { findMissingKeys, parseEnvFile } from "./env.ts";
import { END_MARKER, buildLeadActorSystem, parseLeadReply } from "./leadActor.ts";
import { runPool } from "./pool.ts";
import { badgeOf, escapeHtml, renderHtml, sortRuns } from "./report.ts";
import { buildFakeSlots, runStubTool } from "./stubTools.ts";
import type { RunReport, ScenarioRun } from "./types.ts";

const ZERO_COST = { inputTokens: 0, outputTokens: 0, cacheReadTokens: 0, cacheCreationTokens: 0, costUsd: 0, calls: 0 };

describe("cli", () => {
  it("applies the documented defaults", () => {
    const options = parseCliArgs(["--env-file", "x.env"]);
    expect(options).toMatchObject({ maxCostUsd: DEFAULT_MAX_COST_USD, concurrency: DEFAULT_CONCURRENCY, dryRun: false, only: [] });
  });

  it("parses flags and rejects bad input", () => {
    const options = parseCliArgs(["--env-file", "x", "--only", "22, 23", "--concurrency", "2", "--max-cost-usd", "1.5", "--dry-run"]);
    expect(options).toMatchObject({ only: ["22", "23"], concurrency: 2, maxCostUsd: 1.5, dryRun: true });
    expect(() => parseCliArgs([])).toThrow(CliUsageError);
    expect(() => parseCliArgs(["--env-file", "x", "--max-cost-usd", "-3"])).toThrow(CliUsageError);
    expect(() => parseCliArgs(["--env-file", "x", "--nope"])).toThrow(/unknown flag/);
  });
});

describe("env", () => {
  it("parses quotes, comments and export prefixes without leaking into missing-key reports", () => {
    const env = parseEnvFile('# c\nA=1\nexport B="two words"\nC=\'x\'\nbad line\n');
    expect(env).toEqual({ A: "1", B: "two words", C: "x" });
    expect(findMissingKeys(env, ["A", "Z"])).toEqual(["Z"]);
  });
});

describe("read-only database guard", () => {
  it("allows a plain select", () => {
    expect(() => assertReadOnlySql("select id, is_active from prompts where is_active = true;")).not.toThrow();
  });

  it.each([
    "update agents set is_paused = true",
    "delete from messages",
    "select 1; drop table agents",
    "with x as (delete from messages returning *) select * from x",
    "select * from agents; select 2",
  ])("rejects %s", (sql) => {
    expect(() => assertReadOnlySql(sql)).toThrow(ReadOnlyViolationError);
  });

  it("refuses a write before any request is made", async () => {
    let requests = 0;
    const db = createReadOnlyDb({ projectRef: "p", accessToken: "t" }, (() => {
      requests += 1;
      return Promise.resolve(new Response("[]"));
    }) as typeof fetch);
    await expect(db.query("delete from messages")).rejects.toThrow(ReadOnlyViolationError);
    expect(requests).toBe(0);
  });
});

describe("stub tools", () => {
  const now = new Date("2026-10-07T09:00:00.000Z");

  it("offers two slots tomorrow at 11:00 and 11:30 Israel time", () => {
    const slots = buildFakeSlots(now);
    expect(slots.map((s) => s.start_utc)).toEqual(["2026-10-08T08:00:00.000Z", "2026-10-08T08:30:00.000Z"]);
  });

  it("returns the allow-list times and a visible line with the booking flag", () => {
    const out = runStubTool("list_available_slots", { preferred_date: "2026-10-08", lead_requested_booking: true }, now);
    expect(out.offeredTimesIL).toEqual(expect.arrayContaining(["11:00", "11:30", "12:00"]));
    expect(out.line).toBe("[tool: list_available_slots preferred_date=2026-10-08 lead_requested_booking=true]");
  });

  it("confirms a booking without reaching anywhere", () => {
    const out = runStubTool("book_meeting", { start_time: "2026-10-08T08:00:00.000Z", end_time: "2026-10-08T08:30:00.000Z" }, now);
    expect(JSON.parse(out.resultJson)).toMatchObject({ success: true });
    expect(out.offeredTimesIL).toEqual(["11:00", "11:30"]);
  });
});

describe("lead actor", () => {
  it("ends on the end marker or an empty reply, strips wrapping quotes otherwise", () => {
    expect(parseLeadReply(END_MARKER)).toEqual({ kind: "end" });
    expect(parseLeadReply("  ")).toEqual({ kind: "end" });
    expect(parseLeadReply('"סבבה"')).toEqual({ kind: "message", text: "סבבה" });
  });

  it("forbids picking a meeting time in the actor prompt", () => {
    const system = buildLeadActorSystem({
      id: "a", statusSub: 1, title: "t", persona: "בן 30", plan: ["שלב א"], mustHappen: [], mustNotHappen: [], maxTurns: 6,
    });
    expect(system).toContain("never pick or accept a specific meeting day or time");
    expect(system).toContain("1. שלב א");
  });
});

describe("pool", () => {
  it("keeps result order and never exceeds the concurrency limit", async () => {
    let active = 0;
    let peak = 0;
    const results = await runPool([1, 2, 3, 4, 5], 2, async (n) => {
      active += 1;
      peak = Math.max(peak, active);
      await new Promise((resolve) => setTimeout(resolve, 5));
      active -= 1;
      return n * 10;
    });
    expect(results).toEqual([10, 20, 30, 40, 50]);
    expect(peak).toBe(2);
  });
});

describe("report", () => {
  const baseRun: ScenarioRun = {
    id: "status-1", statusSub: 1, title: "<script>", statusLabel: "x", status: "error", entries: [
      { kind: "lead", text: "<b>hi</b>" },
      { kind: "tool", text: "[tool: list_available_slots lead_requested_booking=false]" },
    ], grade: null, note: "boom", leadTurns: 1, silenceCount: 0, cost: ZERO_COST,
  };

  it("escapes html and sorts failures before passes", () => {
    expect(escapeHtml('<a href="x">&</a>')).toBe("&lt;a href=&quot;x&quot;&gt;&amp;&lt;/a&gt;");
    const aborted: ScenarioRun = { ...baseRun, id: "status-2", statusSub: 2, status: "aborted" };
    expect(sortRuns([aborted, baseRun]).map((r) => badgeOf(r))).toEqual(["ERROR", "ABORTED"]);
  });

  it("renders a self-contained RTL page with the transcript and tool lines, without raw markup", () => {
    const report: RunReport = {
      generatedAt: "2026-10-07T00:00:00Z", agentSlug: "affiliate_marketing", mainPromptVersion: "v20",
      models: { bot: "b", lead: "l", grader: "g", judge: "j" }, maxCostUsd: 25, budgetExceeded: false,
      totalCost: ZERO_COST, scenarios: [baseRun],
    };
    const html = renderHtml(report);
    expect(html).toContain('dir="rtl"');
    expect(html).toContain("&lt;b&gt;hi&lt;/b&gt;");
    expect(html).toContain("[tool: list_available_slots lead_requested_booking=false]");
    expect(html).not.toContain("<script>");
    expect(html).not.toMatch(/(src|href)="https?:/);
  });
});
