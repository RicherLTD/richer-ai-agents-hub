import { describe, expect, it } from "vitest";
import {
  advanceCursor,
  buildSyncQuery,
  dedupeByPhone,
  fireberryPhoneToCanonical,
  isStuckPage,
  skipAlreadyApplied,
  stepPastInstant,
  toStatusRow,
} from "./fireberrySync.ts";

// Shape copied from a live v3/query response (2026-10-22).
const live = {
  accountid: "639D4815-1816-408D-BFEA-000185FFFA9A",
  telephone1: "0527797972",
  statuscode: 13,
  status: "מחודש ",
  pcfsystemfield103: 44,
  pcfsystemfield103name: "מחודש - הזדמנות שנייה",
  modifiedon: "2026-03-16T13:40:39.000Z",
  createdon: "2025-09-04T01:25:07.000Z",
  pcfvetekop: "2025-09-04T01:25:07.000Z",
};

describe("fireberryPhoneToCanonical", () => {
  it("handles the formats Fireberry holds", () => {
    expect(fireberryPhoneToCanonical("0527797972")).toBe("972527797972");
    expect(fireberryPhoneToCanonical("052-779-7972")).toBe("972527797972");
    expect(fireberryPhoneToCanonical("+972527797972")).toBe("972527797972");
    expect(fireberryPhoneToCanonical("527797972")).toBe("972527797972");
  });

  it("rejects what is not a phone", () => {
    expect(fireberryPhoneToCanonical("")).toBeNull();
    expect(fireberryPhoneToCanonical(null)).toBeNull();
    expect(fireberryPhoneToCanonical("abc")).toBeNull();
  });
});

describe("toStatusRow", () => {
  it("maps a live record, trimming names", () => {
    expect(toStatusRow(live)).toEqual({
      phone: "972527797972",
      account_id: "639D4815-1816-408D-BFEA-000185FFFA9A",
      status_main: 13,
      status_main_name: "מחודש",
      status_sub: 44,
      status_sub_name: "מחודש - הזדמנות שנייה",
      last_opportunity_at: "2025-09-04T01:25:07.000Z",
    });
  });

  it("keeps a lead with no secondary status (nulls)", () => {
    const row = toStatusRow({ ...live, pcfsystemfield103: null, pcfsystemfield103name: null });
    expect(row?.status_sub).toBeNull();
    expect(row?.status_sub_name).toBeNull();
  });

  it("falls back to createdon when there is no last-opportunity date", () => {
    expect(toStatusRow({ ...live, pcfvetekop: null })?.last_opportunity_at).toBe("2025-09-04T01:25:07.000Z");
  });

  it("drops records without a usable phone or id", () => {
    expect(toStatusRow({ ...live, telephone1: "" })).toBeNull();
    expect(toStatusRow({ ...live, accountid: undefined })).toBeNull();
  });
});

describe("dedupeByPhone", () => {
  it("keeps the most recent opportunity per phone", () => {
    const old = { ...toStatusRow(live)!, account_id: "OLD", last_opportunity_at: "2025-01-01T00:00:00.000Z" };
    const recent = { ...toStatusRow(live)!, account_id: "NEW", last_opportunity_at: "2026-05-01T00:00:00.000Z" };
    expect(dedupeByPhone([recent, old]).map((r) => r.account_id)).toEqual(["NEW"]);
    expect(dedupeByPhone([old, recent]).map((r) => r.account_id)).toEqual(["NEW"]);
  });
});

describe("buildSyncQuery", () => {
  it("filters by product, reads from the cursor, sorts by modifiedon", () => {
    const q = buildSyncQuery({ productId: "P", cursorModifiedOn: "2026-10-21T00:00:00.000Z" });
    expect(q.filter).toEqual([
      {
        type: "AND",
        conditions: [
          { fieldName: "pcfsystemfield122", operator: "eq", value: "P" },
          { fieldName: "modifiedon", operator: "ge", value: "2026-10-21T00:00:00.000Z" },
        ],
      },
    ]);
    expect(q.orderBy).toEqual([{ name: "modifiedon", order: "asc" }]);
  });

  it("reads from the beginning when there is no cursor", () => {
    const q = buildSyncQuery({ productId: "P", cursorModifiedOn: null }) as { filter: Array<{ conditions: unknown[] }> };
    expect(q.filter[0].conditions).toHaveLength(1);
  });
});

describe("cursor", () => {
  const at = (id: string, modifiedon: string) => ({ accountid: id, modifiedon });

  it("advances to the last instant and remembers the ids applied there", () => {
    const next = advanceCursor({ modifiedOn: null, ids: [] }, [
      at("a", "2026-10-21T10:00:00Z"),
      at("b", "2026-10-21T10:00:05Z"),
      at("c", "2026-10-21T10:00:05Z"),
    ]);
    expect(next).toEqual({ modifiedOn: "2026-10-21T10:00:05.000Z", ids: ["b", "c"] });
  });

  it("accumulates ids while the instant does not move", () => {
    const prev = { modifiedOn: "2026-10-21T10:00:05.000Z", ids: ["b"] };
    expect(advanceCursor(prev, [at("c", "2026-10-21T10:00:05Z")]).ids).toEqual(["b", "c"]);
  });

  it("skips records already applied at the cursor instant, keeps the rest", () => {
    const cursor = { modifiedOn: "2026-10-21T10:00:05.000Z", ids: ["b"] };
    const fresh = skipAlreadyApplied(
      [at("b", "2026-10-21T10:00:05Z"), at("c", "2026-10-21T10:00:05Z"), at("d", "2026-10-21T10:00:09Z")],
      cursor,
    );
    expect(fresh.map((r) => r.accountid)).toEqual(["c", "d"]);
  });

  it("detects a page that would be re-read forever and steps past it", () => {
    const page = Array.from({ length: 3 }, (_, i) => at(String(i), "2026-10-21T10:00:05Z"));
    expect(isStuckPage(page, [], 3)).toBe(true);
    expect(isStuckPage(page, page.slice(0, 1), 3)).toBe(false);
    expect(stepPastInstant({ modifiedOn: "2026-10-21T10:00:05.000Z", ids: ["x"] })).toEqual({
      modifiedOn: "2026-10-21T10:00:06.000Z",
      ids: [],
    });
  });
});
