import { describe, expect, it } from "vitest";

import { toCanonicalPhone } from "./normalizePhone.ts";

describe("toCanonicalPhone", () => {
  it("strips the + from E.164 (+972…)", () => {
    expect(toCanonicalPhone("+972528524113")).toBe("972528524113");
  });

  it("keeps a 972… number as-is", () => {
    expect(toCanonicalPhone("972528524113")).toBe("972528524113");
  });

  it("converts Israeli local 0… to 972…", () => {
    expect(toCanonicalPhone("0528524113")).toBe("972528524113");
  });

  it("ignores spaces, dashes and parens", () => {
    expect(toCanonicalPhone(" +972 52-852-4113 ")).toBe("972528524113");
    expect(toCanonicalPhone("(052) 852-4113")).toBe("972528524113");
  });

  it("collapses +972 and 972 to the SAME value (the dedup contract)", () => {
    expect(toCanonicalPhone("+972528524113")).toBe(toCanonicalPhone("972528524113"));
  });

  it("returns null for empty or non-Israeli numbers", () => {
    expect(toCanonicalPhone("")).toBeNull();
    expect(toCanonicalPhone("12345")).toBeNull();
    expect(toCanonicalPhone("+12025550123")).toBeNull();
  });
});
