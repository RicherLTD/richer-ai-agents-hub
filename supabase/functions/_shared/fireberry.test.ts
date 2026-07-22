import { describe, expect, it } from "vitest";
import {
  BOOKING_BLOCK_STATUSCODES,
  FireberryClient,
  parseStatuscodes,
  phoneVariantsIL,
  pickBlockingStatus,
} from "./fireberry.ts";

describe("phoneVariantsIL", () => {
  it("normalizes every IL format to the same variant set", () => {
    const expected = ["0525188599", "525188599", "972525188599", "+972525188599"];
    for (const input of [
      "0525188599",
      "525188599",
      "972525188599",
      "+972525188599",
      "+972 52-518-8599",
      "972-52-5188599",
    ]) {
      expect(phoneVariantsIL(input).sort()).toEqual([...expected].sort());
    }
  });

  it("puts the 0-prefixed form first (most likely stored format)", () => {
    expect(phoneVariantsIL("+972525188599")[0]).toBe("0525188599");
  });

  it("returns empty for junk input", () => {
    expect(phoneVariantsIL("")).toEqual([]);
    expect(phoneVariantsIL("abc")).toEqual([]);
  });
});

describe("parseStatuscodes", () => {
  it("extracts numeric statuscodes, coercing strings", () => {
    expect(parseStatuscodes({ data: [{ statuscode: 2 }, { statuscode: "11" }] })).toEqual([2, 11]);
  });
  it("tolerates missing/empty/non-array data", () => {
    expect(parseStatuscodes({ data: [] })).toEqual([]);
    expect(parseStatuscodes({})).toEqual([]);
    expect(parseStatuscodes(null)).toEqual([]);
    expect(parseStatuscodes({ data: [{}, { statuscode: null }] })).toEqual([]);
  });
});

describe("pickBlockingStatus", () => {
  it("blocks on 2 (נרשם) and 11 (רשימה שחורה)", () => {
    expect(pickBlockingStatus([2])).toEqual({ blocked: true, statuscode: 2 });
    expect(pickBlockingStatus([6, 11])).toEqual({ blocked: true, statuscode: 11 });
  });
  it("does not block on other statuses (6 חדש, 9 בטיפול, 13 מחודש)", () => {
    expect(pickBlockingStatus([6, 9, 13])).toEqual({ blocked: false, statuscode: null });
    expect(pickBlockingStatus([])).toEqual({ blocked: false, statuscode: null });
  });
  it("BOOKING_BLOCK_STATUSCODES is exactly {2, 11}", () => {
    expect([...BOOKING_BLOCK_STATUSCODES].sort((a, b) => a - b)).toEqual([2, 11]);
  });
});

// ── FireberryClient with injected fetch ──────────────────────────────

function jsonResponse(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "Content-Type": "application/json" },
  });
}

describe("FireberryClient.lookupBlockingStatus", () => {
  it("blocks when the first matching format returns a blocking status", async () => {
    const calls: string[] = [];
    const client = new FireberryClient({
      token: "t",
      fetchImpl: async (_url, init) => {
        calls.push(String((JSON.parse(String(init.body)) as { filter: unknown[] }).filter?.length));
        return jsonResponse({ success: true, data: [{ accountid: "a", statuscode: 2 }] });
      },
    });
    const r = await client.lookupBlockingStatus("+972525188599");
    expect(r).toEqual({ blocked: true, statuscode: 2 });
    // Stopped after the first (0-prefixed) hit — only one HTTP call.
    expect(calls.length).toBe(1);
  });

  it("does not block when the found lead is a normal open status", async () => {
    const client = new FireberryClient({
      token: "t",
      fetchImpl: async () => jsonResponse({ success: true, data: [{ statuscode: 6 }] }),
    });
    expect(await client.lookupBlockingStatus("0525188599")).toEqual({
      blocked: false,
      statuscode: null,
    });
  });

  it("tries the next format when a format has no match, then reports not-blocked when none match", async () => {
    let n = 0;
    const client = new FireberryClient({
      token: "t",
      fetchImpl: async () => {
        n++;
        return jsonResponse({ success: true, data: [] });
      },
    });
    const r = await client.lookupBlockingStatus("+972525188599");
    expect(r).toEqual({ blocked: false, statuscode: null });
    expect(n).toBe(4); // exhausted all four variants
  });

  it("throws on HTTP error so the caller can fail-open", async () => {
    const client = new FireberryClient({
      token: "t",
      fetchImpl: async () => jsonResponse({ message: "bad token" }, 401),
    });
    await expect(client.lookupBlockingStatus("0525188599")).rejects.toThrow(/401/);
  });
});
