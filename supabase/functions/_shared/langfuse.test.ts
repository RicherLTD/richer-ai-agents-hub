import { afterEach, describe, expect, it, vi } from "vitest";
import { computeSonnet46Cost, Langfuse } from "./langfuse.ts";

const CONFIG = { publicKey: "pk", secretKey: "sk", baseUrl: "https://lf.example.com/" };

/** Capture the ingestion batch a method posts, without any network. */
function stubFetch(response: { ok: boolean; status?: number; body?: string }) {
  const calls: Array<{ url: string; batch: Array<Record<string, unknown>> }> = [];
  const fake = vi.fn(async (url: string, init: { body: string }) => {
    calls.push({ url, batch: JSON.parse(init.body).batch });
    return {
      ok: response.ok,
      status: response.status ?? (response.ok ? 200 : 500),
      text: async () => response.body ?? "",
    };
  });
  vi.stubGlobal("fetch", fake);
  return { calls, fake };
}

afterEach(() => {
  vi.unstubAllGlobals();
});

describe("computeSonnet46Cost", () => {
  it("returns 0 for zero usage", () => {
    expect(computeSonnet46Cost({})).toBe(0);
  });

  it("computes a typical small turn (100 in / 50 out, no cache)", () => {
    const cost = computeSonnet46Cost({ inputTokens: 100, outputTokens: 50 });
    // 100 * $3/M + 50 * $15/M = $0.0003 + $0.00075 = $0.00105
    expect(cost).toBeCloseTo(0.00105, 6);
  });

  it("applies the 0.1× discount on cache reads", () => {
    const cost = computeSonnet46Cost({
      inputTokens: 0,
      outputTokens: 0,
      cacheReadTokens: 1000,
    });
    // 1000 * $0.30/M = $0.0003
    expect(cost).toBeCloseTo(0.0003, 6);
  });

  it("charges 1.25× for 5-minute cache writes", () => {
    const cost = computeSonnet46Cost({
      inputTokens: 0,
      outputTokens: 0,
      cacheCreationTokens: 1000,
    });
    // 1000 * $3.75/M = $0.00375
    expect(cost).toBeCloseTo(0.00375, 6);
  });

  it("sums all four buckets for a realistic cached turn", () => {
    const cost = computeSonnet46Cost({
      inputTokens: 50, // fresh input
      outputTokens: 200,
      cacheReadTokens: 2000, // history was cached
      cacheCreationTokens: 0,
    });
    // 50 * 3e-6 + 200 * 15e-6 + 2000 * 0.3e-6
    // = 0.00015 + 0.003 + 0.0006 = 0.00375
    expect(cost).toBeCloseTo(0.00375, 6);
  });

  it("ignores missing fields without errors", () => {
    // Only output_tokens is present.
    const cost = computeSonnet46Cost({ outputTokens: 100 });
    expect(cost).toBeCloseTo(0.0015, 6);
  });
});

// These assert the ingestion PAYLOAD SHAPE, which is the part that fails
// silently in production: a wrong field name is accepted as a 4xx we only
// see in a warn log, and the score is simply lost.
describe("Langfuse.recordScores", () => {
  it("posts one score-create event per score, attached to the trace", async () => {
    const { calls } = stubFetch({ ok: true });
    const ok = await new Langfuse(CONFIG).recordScores({ traceId: "trace-1" }, [
      { name: "guard_passed", value: 1, dataType: "BOOLEAN" },
      { name: "judge_passed", value: 0, dataType: "BOOLEAN", comment: "price_leak" },
    ]);

    expect(ok).toBe(true);
    expect(calls).toHaveLength(1);
    expect(calls[0].url).toBe("https://lf.example.com/api/public/ingestion");
    expect(calls[0].batch).toHaveLength(2);

    const first = calls[0].batch[0] as { type: string; body: Record<string, unknown> };
    expect(first.type).toBe("score-create");
    expect(first.body.traceId).toBe("trace-1");
    expect(first.body.name).toBe("guard_passed");
    expect(first.body.value).toBe(1);
    expect(first.body.dataType).toBe("BOOLEAN");
    // No comment supplied → the key must be absent, not null.
    expect(first.body).not.toHaveProperty("comment");

    const second = calls[0].batch[1] as { body: Record<string, unknown> };
    expect(second.body.comment).toBe("price_leak");
  });

  it("targets a session when given sessionId, and never sets traceId", async () => {
    const { calls } = stubFetch({ ok: true });
    await new Langfuse(CONFIG).recordScores({ sessionId: "conv-9" }, [
      { name: "bot_booked_zoom", value: 1, dataType: "BOOLEAN" },
    ]);

    const body = (calls[0].batch[0] as { body: Record<string, unknown> }).body;
    expect(body.sessionId).toBe("conv-9");
    expect(body).not.toHaveProperty("traceId");
  });

  it("attaches a score to a single observation when observationId is given", async () => {
    const { calls } = stubFetch({ ok: true });
    await new Langfuse(CONFIG).recordScores({ traceId: "t" }, [
      { name: "extraction_ok", value: 0, dataType: "BOOLEAN", observationId: "obs-3" },
    ]);

    const body = (calls[0].batch[0] as { body: Record<string, unknown> }).body;
    expect(body.observationId).toBe("obs-3");
  });

  it("truncates long comments to 500 chars", async () => {
    const { calls } = stubFetch({ ok: true });
    await new Langfuse(CONFIG).recordScores({ traceId: "t" }, [
      { name: "n", value: 1, comment: "x".repeat(900) },
    ]);

    const body = (calls[0].batch[0] as { body: { comment: string } }).body;
    expect(body.comment).toHaveLength(500);
  });

  it("makes no request for an empty score list", async () => {
    const { fake } = stubFetch({ ok: true });
    const ok = await new Langfuse(CONFIG).recordScores({ traceId: "t" }, []);
    expect(ok).toBe(true);
    expect(fake).not.toHaveBeenCalled();
  });

  it("returns false and reports the detail when ingestion is rejected", async () => {
    stubFetch({ ok: false, status: 400, body: "bad payload" });
    const failures: Array<{ status: number; body: string }> = [];
    const ok = await new Langfuse(CONFIG).recordScores(
      { traceId: "t" },
      [{ name: "n", value: 1 }],
      (d) => void failures.push(d),
    );

    expect(ok).toBe(false);
    expect(failures).toEqual([{ status: 400, body: "bad payload" }]);
  });

  it("never throws when the network itself fails", async () => {
    vi.stubGlobal("fetch", vi.fn(async () => {
      throw new Error("connection reset");
    }));
    const failures: Array<{ status: number; body: string }> = [];
    const ok = await new Langfuse(CONFIG).recordScores(
      { traceId: "t" },
      [{ name: "n", value: 1 }],
      (d) => void failures.push(d),
    );

    expect(ok).toBe(false);
    expect(failures[0].status).toBe(0);
    expect(failures[0].body).toContain("connection reset");
  });
});

describe("Langfuse.recordChildGeneration", () => {
  it("returns the observation id and nests the step under the given trace", async () => {
    const { calls } = stubFetch({ ok: true });
    const start = new Date("2026-07-29T10:00:00.000Z");
    const end = new Date("2026-07-29T10:00:02.000Z");

    const observationId = await new Langfuse(CONFIG).recordChildGeneration({
      traceId: "trace-7",
      name: "memory-extractor",
      model: "claude-haiku-4-5",
      startTime: start,
      endTime: end,
      input: { messages: [] },
      output: { q1_age: 30 },
      usage: { inputTokens: 120, outputTokens: 40 },
      level: "DEFAULT",
    });

    expect(observationId).toBeTruthy();
    const event = calls[0].batch[0] as { type: string; body: Record<string, unknown> };
    expect(event.type).toBe("generation-create");
    expect(event.body.id).toBe(observationId);
    expect(event.body.traceId).toBe("trace-7");
    expect(event.body.name).toBe("memory-extractor");
    expect(event.body.model).toBe("claude-haiku-4-5");
    expect(event.body.startTime).toBe(start.toISOString());
    expect(event.body.usage).toEqual({ input: 120, output: 40, total: 160, unit: "TOKENS" });
  });

  it("marks a failed step as ERROR with a status message", async () => {
    const { calls } = stubFetch({ ok: true });
    await new Langfuse(CONFIG).recordChildGeneration({
      traceId: "t",
      name: "memory-extractor",
      model: "m",
      startTime: new Date(),
      endTime: new Date(),
      input: null,
      output: "{wait_for_response}",
      level: "ERROR",
      statusMessage: "claude_invalid_json",
    });

    const body = (calls[0].batch[0] as { body: Record<string, unknown> }).body;
    expect(body.level).toBe("ERROR");
    expect(body.statusMessage).toBe("claude_invalid_json");
    // No usage passed → key omitted entirely.
    expect(body).not.toHaveProperty("usage");
  });

  it("returns null when ingestion fails, so callers can't attach a score to nothing", async () => {
    stubFetch({ ok: false, status: 500 });
    const observationId = await new Langfuse(CONFIG).recordChildGeneration({
      traceId: "t",
      name: "n",
      model: "m",
      startTime: new Date(),
      endTime: new Date(),
      input: null,
      output: null,
    });
    expect(observationId).toBeNull();
  });
});

describe("Langfuse.recordSpans", () => {
  it("batches every span into a single request", async () => {
    const { calls } = stubFetch({ ok: true });
    const now = new Date();
    const ok = await new Langfuse(CONFIG).recordSpans([
      { traceId: "t", name: "mooz.list_available_slots", startTime: now, endTime: now },
      { traceId: "t", name: "mooz.book_meeting", startTime: now, endTime: now, output: { id: 1 } },
    ]);

    expect(ok).toBe(true);
    expect(calls).toHaveLength(1);
    expect(calls[0].batch).toHaveLength(2);
    expect((calls[0].batch[0] as { type: string }).type).toBe("span-create");
    expect((calls[0].batch[1] as { body: Record<string, unknown> }).body.output).toEqual({ id: 1 });
  });

  it("makes no request for an empty span list", async () => {
    const { fake } = stubFetch({ ok: true });
    expect(await new Langfuse(CONFIG).recordSpans([])).toBe(true);
    expect(fake).not.toHaveBeenCalled();
  });
});

describe("Langfuse.traceAgentTurn", () => {
  // Regression guard: traceAgentTurn was refactored onto the shared ingest()
  // helper when scores/spans were added. Its contract must not change.
  const turnInput = {
    agentId: "a",
    conversationId: "c",
    leadPhone: "972500000000",
    promptVersion: "v19",
    promptVersionId: "pv",
    model: "claude-sonnet-4-6",
    systemPrompt: "sys",
    claudeMessages: [{ role: "user" as const, content: "היי" }],
    startTime: new Date("2026-07-29T10:00:00.000Z"),
    endTime: new Date("2026-07-29T10:00:03.000Z"),
    output: "שלום",
    usage: { inputTokens: 10, outputTokens: 5 },
  };

  it("still returns a trace id and posts trace + generation together", async () => {
    const { calls } = stubFetch({ ok: true });
    const traceId = await new Langfuse(CONFIG).traceAgentTurn(turnInput);

    expect(traceId).toBeTruthy();
    expect(calls).toHaveLength(1);
    const types = calls[0].batch.map((e) => (e as { type: string }).type);
    expect(types).toEqual(["trace-create", "generation-create"]);
    const trace = calls[0].batch[0] as { body: Record<string, unknown> };
    expect(trace.body.id).toBe(traceId);
    expect(trace.body.sessionId).toBe("c");
    expect(trace.body.tags).toEqual(["success"]);
  });

  it("still returns null when ingestion fails", async () => {
    stubFetch({ ok: false, status: 401, body: "unauthorized" });
    expect(await new Langfuse(CONFIG).traceAgentTurn(turnInput)).toBeNull();
  });
});
