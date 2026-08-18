import { beforeEach, describe, expect, it, vi } from "vitest";

const { fromMock } = vi.hoisted(() => ({
  fromMock: vi.fn(),
}));

vi.mock("@/lib/supabase/client", () => ({
  supabase: { from: fromMock },
}));

import {
  buildStatusRuleIndex,
  draftToPatch,
  filterWarmingRows,
  formatStatusSnapshot,
  getCrmWarmingRows,
  hasNoHistory,
  hasReplied,
  listCrmStatusRules,
  matchesWarmingFilter,
  resolveStatusDisplay,
  ruleToDraft,
  summarizeWarming,
  updateCrmStatusRule,
  validateStatusRuleDraft,
  warmingFilterCounts,
  type CrmStatusRuleRow,
  type CrmWarmingRow,
  type StatusRuleDraft,
} from "./crm-warming";

/* ------------------------------------------------------------------ *
 * Fixtures
 * ------------------------------------------------------------------ */

function row(partial: Partial<CrmWarmingRow> = {}): CrmWarmingRow {
  return {
    id: "c1",
    lead_name: "דנה",
    lead_phone: "972501234567",
    last_inbound_at: "2026-08-01T10:00:00Z",
    crm_warming_status: "warming",
    crm_status_sub: 7,
    crm_status_main: 1,
    crm_warming_reason: null,
    crm_rep_note: null,
    crm_status_event_at: "2026-08-05T09:00:00Z",
    crm_last_warmed_at: null,
    crm_warming_replied_at: null,
    ...partial,
  };
}

function rule(partial: Partial<CrmStatusRuleRow> = {}): CrmStatusRuleRow {
  return {
    id: "r1",
    agent_id: "agent-1",
    status_sub: 7,
    status_label: "יקר לי",
    objection_key: "price",
    warming_instructions: "אל תדבר על מחיר.",
    delay_hours: 4,
    cooldown_days: 30,
    clears_zoom_state: false,
    is_active: true,
    created_at: "2026-08-01T00:00:00Z",
    updated_at: "2026-08-01T00:00:00Z",
    ...partial,
  };
}

/* ------------------------------------------------------------------ *
 * Supabase chain mock
 * ------------------------------------------------------------------ */

interface ChainCall {
  method: string;
  args: unknown[];
}

function makeChain(result: { data: unknown; error: unknown }) {
  const calls: ChainCall[] = [];
  const chain = {
    calls,
    select: vi.fn(),
    eq: vi.fn(),
    not: vi.fn(),
    gte: vi.fn(),
    lte: vi.fn(),
    or: vi.fn(),
    order: vi.fn(),
    limit: vi.fn(),
    update: vi.fn(),
    // The builder is thenable — `await chain` resolves to the result, which is
    // how the terminal call of a mutation (`.update().eq()`) settles.
    then: (resolve: (value: unknown) => unknown) => Promise.resolve(result).then(resolve),
  };
  for (const method of ["select", "eq", "not", "gte", "lte", "or", "update"] as const) {
    chain[method].mockImplementation((...args: unknown[]) => {
      calls.push({ method, args });
      return chain;
    });
  }
  // `order` is terminal for the rules query and mid-chain for the warming
  // query; returning the thenable chain covers both.
  chain.order.mockImplementation((...args: unknown[]) => {
    calls.push({ method: "order", args });
    return chain;
  });
  chain.limit.mockImplementation((...args: unknown[]) => {
    calls.push({ method: "limit", args });
    return Promise.resolve(result);
  });
  return chain;
}

beforeEach(() => {
  fromMock.mockReset();
});

/* ------------------------------------------------------------------ *
 * Derived flags
 * ------------------------------------------------------------------ */

describe("hasNoHistory", () => {
  it("is true only when the lead has never sent an inbound message", () => {
    expect(hasNoHistory(row({ last_inbound_at: null }))).toBe(true);
    expect(hasNoHistory(row({ last_inbound_at: "2026-08-01T10:00:00Z" }))).toBe(false);
  });
});

describe("hasReplied", () => {
  it("is true only when crm_warming_replied_at is set", () => {
    expect(hasReplied(row({ crm_warming_replied_at: "2026-08-06T08:00:00Z" }))).toBe(true);
    expect(hasReplied(row({ crm_warming_replied_at: null }))).toBe(false);
  });
});

/* ------------------------------------------------------------------ *
 * Summary
 * ------------------------------------------------------------------ */

describe("summarizeWarming", () => {
  it("counts every warming state, including NULL as 'not warming'", () => {
    const summary = summarizeWarming([
      row({ crm_warming_status: "warming" }),
      row({ crm_warming_status: "warming" }),
      row({ crm_warming_status: "warming_stopped" }),
      row({ crm_warming_status: "warming_converted" }),
      // Kill switch off: status event recorded, no warming state.
      row({ crm_warming_status: null }),
    ]);

    expect(summary).toEqual({
      total: 5,
      warming: 2,
      stopped: 1,
      converted: 1,
      notWarming: 1,
      replied: 0,
      noHistory: 0,
    });
  });

  it("counts replied and no-history independently of the warming state", () => {
    const summary = summarizeWarming([
      row({ crm_warming_status: "warming", last_inbound_at: null }),
      row({
        crm_warming_status: "warming_converted",
        crm_warming_replied_at: "2026-08-06T08:00:00Z",
        last_inbound_at: null,
      }),
      row({ crm_warming_status: null, crm_warming_replied_at: "2026-08-06T09:00:00Z" }),
    ]);

    expect(summary.replied).toBe(2);
    expect(summary.noHistory).toBe(2);
    expect(summary.total).toBe(3);
  });

  it("returns all-zero counts for an empty list", () => {
    expect(summarizeWarming([])).toEqual({
      total: 0,
      warming: 0,
      stopped: 0,
      converted: 0,
      notWarming: 0,
      replied: 0,
      noHistory: 0,
    });
  });
});

/* ------------------------------------------------------------------ *
 * Filtering
 * ------------------------------------------------------------------ */

describe("matchesWarmingFilter", () => {
  it("matches each warming state chip", () => {
    expect(matchesWarmingFilter(row({ crm_warming_status: "warming" }), "warming")).toBe(true);
    expect(matchesWarmingFilter(row({ crm_warming_status: "warming" }), "warming_stopped")).toBe(
      false,
    );
    expect(
      matchesWarmingFilter(row({ crm_warming_status: "warming_converted" }), "warming_converted"),
    ).toBe(true);
    expect(matchesWarmingFilter(row({ crm_warming_status: null }), "not_warming")).toBe(true);
    expect(matchesWarmingFilter(row({ crm_warming_status: "warming" }), "not_warming")).toBe(false);
  });

  it("treats 'all' as a pass-through", () => {
    expect(matchesWarmingFilter(row({ crm_warming_status: null }), "all")).toBe(true);
  });

  it("lets the replied and no-history chips overlap the state chips", () => {
    const r = row({ crm_warming_status: "warming", last_inbound_at: null, crm_warming_replied_at: "x" });
    expect(matchesWarmingFilter(r, "warming")).toBe(true);
    expect(matchesWarmingFilter(r, "replied")).toBe(true);
    expect(matchesWarmingFilter(r, "no_history")).toBe(true);
  });
});

describe("filterWarmingRows", () => {
  const rows = [
    row({ id: "a", crm_warming_status: "warming", last_inbound_at: null }),
    row({ id: "b", crm_warming_status: "warming_stopped" }),
    row({ id: "c", crm_warming_status: null, crm_warming_replied_at: "2026-08-06T00:00:00Z" }),
  ];

  it("returns the same array reference for 'all' (no needless re-render)", () => {
    expect(filterWarmingRows(rows, "all")).toBe(rows);
  });

  it("filters by chip", () => {
    expect(filterWarmingRows(rows, "warming").map((r) => r.id)).toEqual(["a"]);
    expect(filterWarmingRows(rows, "no_history").map((r) => r.id)).toEqual(["a"]);
    expect(filterWarmingRows(rows, "replied").map((r) => r.id)).toEqual(["c"]);
    expect(filterWarmingRows(rows, "not_warming").map((r) => r.id)).toEqual(["c"]);
  });
});

describe("warmingFilterCounts", () => {
  it("counts every chip off the unfiltered list", () => {
    const counts = warmingFilterCounts([
      row({ crm_warming_status: "warming", last_inbound_at: null }),
      row({ crm_warming_status: "warming" }),
      row({ crm_warming_status: null, crm_warming_replied_at: "2026-08-06T00:00:00Z" }),
    ]);

    expect(counts.all).toBe(3);
    expect(counts.warming).toBe(2);
    expect(counts.no_history).toBe(1);
    expect(counts.replied).toBe(1);
    expect(counts.not_warming).toBe(1);
    expect(counts.warming_stopped).toBe(0);
    expect(counts.warming_converted).toBe(0);
  });
});

/* ------------------------------------------------------------------ *
 * Reason formatting
 * ------------------------------------------------------------------ */

describe("formatStatusSnapshot", () => {
  // crm_warming_reason holds the rule's Hebrew status_label as written by the
  // crm-status-webhook — never a slug, so it is rendered verbatim.
  it("passes the snapshot label through", () => {
    expect(formatStatusSnapshot("יקר לי")).toBe("יקר לי");
    expect(formatStatusSnapshot("סטטוס לא מוגדר")).toBe("סטטוס לא מוגדר");
  });

  it("renders an em dash for null and blank", () => {
    expect(formatStatusSnapshot(null)).toBe("—");
    expect(formatStatusSnapshot("   ")).toBe("—");
  });
});

/* ------------------------------------------------------------------ *
 * Status rule index
 * ------------------------------------------------------------------ */

describe("buildStatusRuleIndex + resolveStatusDisplay", () => {
  const index = buildStatusRuleIndex([
    rule({ status_sub: 7, status_label: "יקר לי", objection_key: "price" }),
    rule({ id: "r2", status_sub: 9, status_label: "  ", objection_key: "  " }),
  ]);

  it("keys the index by status_sub", () => {
    expect([...index.keys()].sort((a, b) => a - b)).toEqual([7, 9]);
  });

  it("resolves label and objection from the matching rule", () => {
    expect(resolveStatusDisplay(row({ crm_status_sub: 7 }), index)).toEqual({
      label: "יקר לי",
      objection: "price",
      unmapped: false,
    });
  });

  it("flags a status with no rule as unmapped, using the row's snapshot label", () => {
    expect(
      resolveStatusDisplay(
        row({ crm_status_sub: 42, crm_warming_reason: "סטטוס לא מוגדר" }),
        index,
      ),
    ).toEqual({
      label: "סטטוס לא מוגדר",
      objection: null,
      unmapped: true,
    });
  });

  it("falls back to the raw code when unmapped and there is no snapshot", () => {
    expect(
      resolveStatusDisplay(row({ crm_status_sub: 42, crm_warming_reason: null }), index).label,
    ).toBe("סטטוס 42");
  });

  it("prefers the current rule label over the stored snapshot (renames propagate)", () => {
    const display = resolveStatusDisplay(
      row({ crm_status_sub: 7, crm_warming_reason: "השם הישן" }),
      index,
    );
    expect(display.label).toBe("יקר לי");
  });

  it("treats a switched-off rule as unmapped — the webhook only matches active rules", () => {
    const offIndex = buildStatusRuleIndex([rule({ status_sub: 7, is_active: false })]);
    const display = resolveStatusDisplay(row({ crm_status_sub: 7 }), offIndex);
    expect(display.unmapped).toBe(true);
    expect(display.label).toBe("יקר לי");
  });

  it("falls back to the snapshot when the rule's label is blank", () => {
    const display = resolveStatusDisplay(
      row({ crm_status_sub: 9, crm_warming_reason: "אין לי זמן" }),
      index,
    );
    expect(display.label).toBe("אין לי זמן");
    expect(display.objection).toBeNull();
    expect(display.unmapped).toBe(false);
  });

  it("handles a row with no status_sub", () => {
    expect(
      resolveStatusDisplay(row({ crm_status_sub: null, crm_warming_reason: null }), index),
    ).toEqual({
      label: "—",
      objection: null,
      unmapped: false,
    });
  });
});

/* ------------------------------------------------------------------ *
 * Draft validation
 * ------------------------------------------------------------------ */

function draft(partial: Partial<StatusRuleDraft> = {}): StatusRuleDraft {
  return {
    status_label: "יקר לי",
    objection_key: "price",
    warming_instructions: "אל תדבר על מחיר.",
    delay_hours: 4,
    cooldown_days: 30,
    clears_zoom_state: false,
    is_active: true,
    ...partial,
  };
}

describe("validateStatusRuleDraft", () => {
  it("accepts a clean draft", () => {
    expect(validateStatusRuleDraft(draft())).toEqual({});
  });

  it("requires a status label", () => {
    expect(validateStatusRuleDraft(draft({ status_label: "   " })).status_label).toBeDefined();
  });

  it("requires an objection key and rejects a non-slug one (NOT NULL join key)", () => {
    expect(validateStatusRuleDraft(draft({ objection_key: "" })).objection_key).toBeDefined();
    expect(validateStatusRuleDraft(draft({ objection_key: "Price Objection" })).objection_key)
      .toBeDefined();
    expect(validateStatusRuleDraft(draft({ objection_key: "no_time_2" })).objection_key)
      .toBeUndefined();
  });

  it("requires instructions — blanking a rule is not how you disable it", () => {
    expect(validateStatusRuleDraft(draft({ warming_instructions: "   " })).warming_instructions)
      .toBeDefined();
  });

  it("rejects out-of-range and non-integer delays", () => {
    expect(validateStatusRuleDraft(draft({ delay_hours: -1 })).delay_hours).toBeDefined();
    expect(validateStatusRuleDraft(draft({ delay_hours: 721 })).delay_hours).toBeDefined();
    expect(validateStatusRuleDraft(draft({ delay_hours: 1.5 })).delay_hours).toBeDefined();
    expect(validateStatusRuleDraft(draft({ delay_hours: 0 })).delay_hours).toBeUndefined();
  });

  it("rejects out-of-range cooldowns", () => {
    expect(validateStatusRuleDraft(draft({ cooldown_days: -1 })).cooldown_days).toBeDefined();
    expect(validateStatusRuleDraft(draft({ cooldown_days: 366 })).cooldown_days).toBeDefined();
    expect(validateStatusRuleDraft(draft({ cooldown_days: 0 })).cooldown_days).toBeUndefined();
  });

  it("rejects over-long instructions", () => {
    const long = "א".repeat(4001);
    expect(validateStatusRuleDraft(draft({ warming_instructions: long })).warming_instructions)
      .toBeDefined();
  });
});

describe("draftToPatch / ruleToDraft", () => {
  it("trims text without ever nulling the NOT NULL columns", () => {
    expect(
      draftToPatch(draft({ status_label: " יקר לי ", objection_key: " price ", warming_instructions: " שמור על מחיר. " })),
    ).toEqual({
      status_label: "יקר לי",
      objection_key: "price",
      warming_instructions: "שמור על מחיר.",
      delay_hours: 4,
      cooldown_days: 30,
      clears_zoom_state: false,
      is_active: true,
    });
  });

  it("round-trips a rule through the draft shape", () => {
    const r = rule();
    expect(draftToPatch(ruleToDraft(r))).toEqual({
      status_label: r.status_label,
      objection_key: r.objection_key,
      warming_instructions: r.warming_instructions,
      delay_hours: r.delay_hours,
      cooldown_days: r.cooldown_days,
      clears_zoom_state: r.clears_zoom_state,
      is_active: r.is_active,
    });
  });

  it("carries every editable field into the form draft", () => {
    const d = ruleToDraft(rule({ delay_hours: 360, cooldown_days: 15, clears_zoom_state: true, is_active: false }));
    expect(d).toEqual({
      status_label: "יקר לי",
      objection_key: "price",
      warming_instructions: "אל תדבר על מחיר.",
      delay_hours: 360,
      cooldown_days: 15,
      clears_zoom_state: true,
      is_active: false,
    });
  });
});

/* ------------------------------------------------------------------ *
 * Queries
 * ------------------------------------------------------------------ */

describe("getCrmWarmingRows", () => {
  it("filters on crm_status_event_at IS NOT NULL, not on crm_warming_status", async () => {
    const chain = makeChain({ data: [], error: null });
    fromMock.mockReturnValue(chain);

    await getCrmWarmingRows({ agentId: "agent-1" });

    expect(fromMock).toHaveBeenCalledWith("conversations");
    const notCall = chain.calls.find((c) => c.method === "not");
    expect(notCall?.args).toEqual(["crm_status_event_at", "is", null]);
    expect(
      chain.calls.some((c) => c.method === "not" && c.args[0] === "crm_warming_status"),
    ).toBe(false);
  });

  it("scopes to the agent and orders by crm_status_event_at desc with a 500 cap (partial index)", async () => {
    const chain = makeChain({ data: [], error: null });
    fromMock.mockReturnValue(chain);

    await getCrmWarmingRows({ agentId: "agent-1" });

    const eqCall = chain.calls.find((c) => c.method === "eq");
    expect(eqCall?.args).toEqual(["agent_id", "agent-1"]);
    const orderCall = chain.calls.find((c) => c.method === "order");
    expect(orderCall?.args).toEqual(["crm_status_event_at", { ascending: false }]);
    const limitCall = chain.calls.find((c) => c.method === "limit");
    expect(limitCall?.args).toEqual([500]);
  });

  it("applies event-time bounds when provided and skips them otherwise", async () => {
    const bounded = makeChain({ data: [], error: null });
    fromMock.mockReturnValue(bounded);
    await getCrmWarmingRows({
      agentId: "agent-1",
      fromEventAt: "2026-08-01T00:00:00Z",
      toEventAt: "2026-08-31T23:59:59Z",
    });
    expect(bounded.calls.find((c) => c.method === "gte")?.args).toEqual([
      "crm_status_event_at",
      "2026-08-01T00:00:00Z",
    ]);
    expect(bounded.calls.find((c) => c.method === "lte")?.args).toEqual([
      "crm_status_event_at",
      "2026-08-31T23:59:59Z",
    ]);

    const plain = makeChain({ data: [], error: null });
    fromMock.mockReturnValue(plain);
    await getCrmWarmingRows({ agentId: "agent-1" });
    expect(plain.calls.find((c) => c.method === "gte")).toBeUndefined();
    expect(plain.calls.find((c) => c.method === "lte")).toBeUndefined();
  });

  it("strips wildcards from the search term", async () => {
    const chain = makeChain({ data: [], error: null });
    fromMock.mockReturnValue(chain);

    await getCrmWarmingRows({ agentId: "agent-1", search: " a%b_c " });

    expect(chain.calls.find((c) => c.method === "or")?.args[0]).toBe(
      "lead_phone.ilike.%abc%,lead_name.ilike.%abc%",
    );
  });

  it("throws a wrapped error and returns rows on success", async () => {
    const failing = makeChain({ data: null, error: { message: "db down" } });
    fromMock.mockReturnValue(failing);
    await expect(getCrmWarmingRows({ agentId: "agent-1" })).rejects.toThrow(
      "Failed to load CRM warming leads: db down",
    );

    const rows = [row()];
    const ok = makeChain({ data: rows, error: null });
    fromMock.mockReturnValue(ok);
    await expect(getCrmWarmingRows({ agentId: "agent-1" })).resolves.toEqual(rows);
  });
});

describe("listCrmStatusRules", () => {
  it("scopes to the agent and sorts by status_sub ascending", async () => {
    const chain = makeChain({ data: [], error: null });
    fromMock.mockReturnValue(chain);

    await listCrmStatusRules("agent-1");

    expect(fromMock).toHaveBeenCalledWith("crm_status_rules");
    expect(chain.calls.find((c) => c.method === "eq")?.args).toEqual(["agent_id", "agent-1"]);
    expect(chain.calls.find((c) => c.method === "order")?.args).toEqual([
      "status_sub",
      { ascending: true },
    ]);
  });

  it("wraps query errors", async () => {
    const chain = makeChain({ data: null, error: { message: "nope" } });
    fromMock.mockReturnValue(chain);

    await expect(listCrmStatusRules("agent-1")).rejects.toThrow(
      "Failed to load CRM status rules: nope",
    );
  });
});

describe("updateCrmStatusRule", () => {
  it("updates the row by id", async () => {
    const chain = makeChain({ data: null, error: null });
    fromMock.mockReturnValue(chain);

    await updateCrmStatusRule("rule-1", { is_active: false });

    expect(fromMock).toHaveBeenCalledWith("crm_status_rules");
    expect(chain.calls.find((c) => c.method === "update")?.args[0]).toEqual({ is_active: false });
    expect(chain.calls.find((c) => c.method === "eq")?.args).toEqual(["id", "rule-1"]);
  });

  it("wraps mutation errors", async () => {
    const chain = makeChain({ data: null, error: { message: "denied" } });
    fromMock.mockReturnValue(chain);

    await expect(updateCrmStatusRule("rule-1", { is_active: false })).rejects.toThrow(
      "Failed to update CRM status rule: denied",
    );
  });
});
