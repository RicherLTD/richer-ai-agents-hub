import { describe, expect, it } from "vitest";
import { type SupabaseClient } from "https://esm.sh/@supabase/supabase-js@2.45.4";

import { fetchOptedOutSet, optOutPhoneVariants } from "./optedOutLookup.ts";

describe("optOutPhoneVariants", () => {
  it("produces canonical, +prefixed and local forms", () => {
    expect(optOutPhoneVariants("972528524113")).toEqual([
      "972528524113",
      "+972528524113",
      "0528524113",
    ]);
  });
});

/** Minimal stub of the supabase-js chain used by fetchOptedOutSet. */
function fakeAdmin(stored: string[]): SupabaseClient {
  return {
    from: () => ({
      select: () => ({
        in: (_col: string, vals: string[]) =>
          Promise.resolve({ data: stored.filter((s) => vals.includes(s)).map((lead_phone) => ({ lead_phone })) }),
      }),
    }),
  } as unknown as SupabaseClient;
}

describe("fetchOptedOutSet", () => {
  it("matches an opted-out phone stored in +972 format and returns canonical", async () => {
    const set = await fetchOptedOutSet(fakeAdmin(["+972528524113"]), ["972528524113"]);
    expect([...set]).toEqual(["972528524113"]);
  });

  it("matches an opted-out phone stored in local 0 format", async () => {
    const set = await fetchOptedOutSet(fakeAdmin(["0528524113"]), ["972528524113"]);
    expect(set.has("972528524113")).toBe(true);
  });

  it("returns empty when the phone is not opted out", async () => {
    const set = await fetchOptedOutSet(fakeAdmin(["972500000000"]), ["972528524113"]);
    expect(set.size).toBe(0);
  });

  it("returns empty for no candidates", async () => {
    const set = await fetchOptedOutSet(fakeAdmin(["972528524113"]), []);
    expect(set.size).toBe(0);
  });
});
