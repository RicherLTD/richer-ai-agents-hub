import { describe, expect, it } from "vitest";

import { parseBroadcastCsv } from "./parseBroadcastCsv";

const phones = (text: string) => parseBroadcastCsv(text).rows.map((r) => r.phone);

describe("parseBroadcastCsv", () => {
  it("parses phone and name columns (header row detected) and canonicalizes phones", () => {
    const { rows, errors } = parseBroadcastCsv("phone,name\n0528524113,דנה\n0501234567,יוסי");
    expect(errors).toHaveLength(0);
    expect(rows).toEqual([
      { phone: "972528524113", name: "דנה", variables: [] },
      { phone: "972501234567", name: "יוסי", variables: [] },
    ]);
  });

  it("parses without a header (first cell looks like a phone)", () => {
    const { rows } = parseBroadcastCsv("0528524113,דנה");
    expect(rows).toEqual([{ phone: "972528524113", name: "דנה", variables: [] }]);
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

  // ─── regression: real-world spreadsheet exports that used to yield 0 recipients ───

  it("handles the real CRM export: BOM + one quoted column + a Hebrew header", () => {
    // Verbatim shape of the file that produced a 0-recipient broadcast in prod:
    // every line quoted, single column, header "טלפון ראשי", UTF-8 BOM.
    const { rows, errors } = parseBroadcastCsv(
      '\uFEFF"טלפון ראשי"\r\n"0502248868"\r\n"0528882112"\r\n"0509011113"\r\n',
    );
    expect(errors).toHaveLength(0);
    expect(rows.map((r) => r.phone)).toEqual(["972502248868", "972528882112", "972509011113"]);
  });

  it("handles a semicolon-delimited export (Excel in an Israeli locale)", () => {
    expect(phones("טלפון;שם\n0528524113;דנה\n0501234567;יוסי")).toEqual([
      "972528524113",
      "972501234567",
    ]);
  });

  it("handles a tab-delimited export", () => {
    expect(phones("phone\tname\n0528524113\tדנה")).toEqual(["972528524113"]);
  });

  it("strips quoting and keeps a comma inside a quoted name", () => {
    const { rows } = parseBroadcastCsv('"phone","name"\n"0528524113","כהן, דנה"');
    expect(rows).toEqual([{ phone: "972528524113", name: "כהן, דנה", variables: [] }]);
  });

  it("restores the leading zero Excel drops from a mobile number", () => {
    expect(phones("phone,name\n528524113,דנה\n501234567,יוסי")).toEqual([
      "972528524113",
      "972501234567",
    ]);
  });

  it("strips the apostrophe Excel writes for text-formatted cells", () => {
    expect(phones("phone,name\n'0528524113,דנה")).toEqual(["972528524113"]);
  });

  it("treats an unrecognised header wording as a header, not as a bad row", () => {
    const { rows, errors } = parseBroadcastCsv("מספר טלפון,שם מלא\n0528524113,דנה");
    expect(rows).toEqual([{ phone: "972528524113", name: "דנה", variables: [] }]);
    expect(errors).toHaveLength(0);
  });

  it("accepts E.164 with separators", () => {
    expect(phones("phone,name\n+972-52-852-4113,דנה")).toEqual(["972528524113"]);
  });

  it("tolerates a BOM and CRLF line endings", () => {
    expect(phones("﻿phone,name\r\n0528524113,דנה\r\n")).toEqual(["972528524113"]);
  });

  // ─── the failure mode itself: an unusable phone must be surfaced, never silently dropped ───

  it("rejects an unusable phone with an error naming the line and the value", () => {
    const { rows, errors } = parseBroadcastCsv("phone,name\n12345,דנה\n0501234567,יוסי");
    expect(rows).toEqual([{ phone: "972501234567", name: "יוסי", variables: [] }]);
    expect(errors).toHaveLength(1);
    expect(errors[0]).toContain("שורה 2");
    expect(errors[0]).toContain("12345");
  });

  it("reports every line when the whole file is unusable (instead of returning 0 rows silently)", () => {
    const { rows, errors } = parseBroadcastCsv("phone,name\nabc,דנה\ndef,יוסי");
    expect(rows).toHaveLength(0);
    expect(errors).toHaveLength(2);
  });

  it("restores the zero on a Google Sheets export: one bare number, no header, no newline", () => {
    expect(parseBroadcastCsv("525563338")).toEqual({
      rows: [{ phone: "972525563338", name: "", variables: [] }],
      errors: [],
    });
  });

  it("does not treat a valid first data row as a header", () => {
    expect(phones("0528524113,דנה\n0501234567,יוסי")).toEqual(["972528524113", "972501234567"]);
  });
});
