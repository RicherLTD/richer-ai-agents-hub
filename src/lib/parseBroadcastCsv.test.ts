import { describe, expect, it } from "vitest";

import { parseBroadcastCsv } from "./parseBroadcastCsv";

describe("parseBroadcastCsv", () => {
  it("parses phone and name columns (header row detected)", () => {
    const { rows, errors } = parseBroadcastCsv("phone,name\n0528524113,דנה\n0501234567,יוסי");
    expect(errors).toHaveLength(0);
    expect(rows).toEqual([
      { phone: "0528524113", name: "דנה", variables: [] },
      { phone: "0501234567", name: "יוסי", variables: [] },
    ]);
  });

  it("parses without a header (first cell looks like a phone)", () => {
    const { rows } = parseBroadcastCsv("0528524113,דנה");
    expect(rows).toEqual([{ phone: "0528524113", name: "דנה", variables: [] }]);
  });

  it("collects extra columns as variables", () => {
    const { rows } = parseBroadcastCsv("phone,name,var1,var2\n0528524113,דנה,A,B");
    expect(rows[0].variables).toEqual(["A", "B"]);
  });

  it("reports a row with a missing phone as an error and skips it", () => {
    const { rows, errors } = parseBroadcastCsv("phone,name\n,דנה\n0501234567,יוסי");
    expect(rows).toHaveLength(1);
    expect(errors[0]).toMatch(/שורה 2/);
  });

  it("ignores blank lines", () => {
    const { rows } = parseBroadcastCsv("0528524113,דנה\n\n\n");
    expect(rows).toHaveLength(1);
  });
});
