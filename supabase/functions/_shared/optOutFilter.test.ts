import { describe, expect, it } from "vitest";

import { partitionOptedOut } from "./optOutFilter.ts";
import { toCanonicalPhone } from "./normalizePhone.ts";

describe("partitionOptedOut", () => {
  it("cancels rows whose phone is in the opted-out set, keeps the rest", () => {
    const rows = [
      { id: "a", lead_phone: "0528524113" },   // opted out (canonical 972528524113)
      { id: "b", lead_phone: "+972500000000" }, // not opted out
    ];
    const set = new Set(["972528524113"]);
    const { keep, cancel } = partitionOptedOut(rows, set, toCanonicalPhone);
    expect(cancel.map((r) => r.id)).toEqual(["a"]);
    expect(keep.map((r) => r.id)).toEqual(["b"]);
  });

  it("keeps a row with an unparseable phone (nothing to match against)", () => {
    const rows = [{ id: "a", lead_phone: "garbage" }];
    const { keep, cancel } = partitionOptedOut(rows, new Set(["972528524113"]), toCanonicalPhone);
    expect(cancel).toHaveLength(0);
    expect(keep).toHaveLength(1);
  });
});
