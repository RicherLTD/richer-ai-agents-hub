import { describe, expect, it, vi } from "vitest";
import { runAgentTurn } from "./agentTurn.ts";
import { MOOZ_TOOL_DEFS } from "./moozTools.ts";

/** Minimal Anthropic stand-in that records the params it was called with. */
function fakeAnthropic(responses: Array<Record<string, unknown>>) {
  const calls: Array<Record<string, unknown>> = [];
  let i = 0;
  const create = vi.fn(async (params: Record<string, unknown>) => {
    calls.push(params);
    return responses[Math.min(i++, responses.length - 1)];
  });
  // deno-lint-ignore no-explicit-any
  return { client: { messages: { create } } as any, calls, create };
}

const textReply = (text: string, usage?: Record<string, number>) => ({
  stop_reason: "end_turn",
  content: [{ type: "text", text }],
  usage: usage ?? { input_tokens: 1000, output_tokens: 50 },
});

const baseArgs = {
  model: "claude-sonnet-4-6",
  maxTokens: 2048,
  systemPrompt: "SYSTEM PROMPT WITH BRAIN",
  initialMessages: [{ role: "user" as const, content: "היי" }],
  retry: { maxAttempts: 1, baseDelayMs: 0 },
};

describe("runAgentTurn — prompt caching", () => {
  // This is a BILLING test. A missing cache_control raises no error and
  // changes no output — you simply pay ~10x for the repeated prefix. On
  // 2026-08-05 the affiliate agent was measured at 107,497 input tokens
  // per reply ($0.328) for exactly this reason.
  it("sends the system prompt as a single cacheable text block", async () => {
    const { client, calls } = fakeAnthropic([textReply("שלום")]);

    await runAgentTurn({ ...baseArgs, anthropic: client, moozCtx: null });

    expect(calls).toHaveLength(1);
    const system = calls[0].system as Array<Record<string, unknown>>;
    expect(Array.isArray(system)).toBe(true);
    expect(system).toHaveLength(1);
    expect(system[0].type).toBe("text");
    expect(system[0].text).toBe("SYSTEM PROMPT WITH BRAIN");
    expect(system[0].cache_control).toEqual({ type: "ephemeral" });
  });

  it("passes the prompt through verbatim — caching must not alter content", async () => {
    const prompt = "line one\n\nline two\tעברית\n";
    const { client, calls } = fakeAnthropic([textReply("ok")]);

    await runAgentTurn({
      ...baseArgs,
      systemPrompt: prompt,
      anthropic: client,
      moozCtx: null,
    });

    const system = calls[0].system as Array<{ text: string }>;
    expect(system[0].text).toBe(prompt);
  });
});

describe("runAgentTurn — tool wiring", () => {
  it("omits tools entirely when no Mooz context is given", async () => {
    const { client, calls } = fakeAnthropic([textReply("ok")]);

    await runAgentTurn({ ...baseArgs, anthropic: client, moozCtx: null });

    expect(calls[0].tools).toBeUndefined();
  });

  it("attaches the Mooz tool definitions when a context is given", async () => {
    const { client, calls } = fakeAnthropic([textReply("ok")]);

    // deno-lint-ignore no-explicit-any
    await runAgentTurn({ ...baseArgs, anthropic: client, moozCtx: {} as any });

    expect(calls[0].tools).toEqual(MOOZ_TOOL_DEFS);
  });
});

describe("runAgentTurn — loop control", () => {
  it("stops after one call when the model finishes its turn", async () => {
    const { client, create } = fakeAnthropic([textReply("שלום")]);

    const result = await runAgentTurn({ ...baseArgs, anthropic: client, moozCtx: null });

    expect(create).toHaveBeenCalledTimes(1);
    expect(result.iterations).toBe(1);
    expect(result.hadToolUse).toBe(false);
    expect(result.bookingCreated).toBe(false);
    expect(result.offeredTimesIL).toEqual([]);
  });

  it("exits defensively when stop_reason says tool_use but no blocks are present", async () => {
    const { client, create } = fakeAnthropic([
      { stop_reason: "tool_use", content: [{ type: "text", text: "" }], usage: {} },
    ]);

    // deno-lint-ignore no-explicit-any
    const result = await runAgentTurn({ ...baseArgs, anthropic: client, moozCtx: {} as any });

    // One call, no infinite loop, no throw.
    expect(create).toHaveBeenCalledTimes(1);
    expect(result.hadToolUse).toBe(false);
  });

  it("accumulates token usage, including cache buckets", async () => {
    const { client } = fakeAnthropic([
      textReply("ok", {
        input_tokens: 1200,
        output_tokens: 80,
        cache_read_input_tokens: 34000,
        cache_creation_input_tokens: 0,
      }),
    ]);

    const result = await runAgentTurn({ ...baseArgs, anthropic: client, moozCtx: null });

    expect(result.totalUsage.inputTokens).toBe(1200);
    expect(result.totalUsage.outputTokens).toBe(80);
    // Cache reads must survive to the caller — they are what proves the
    // cache is working and what makes cost_usd correct.
    expect(result.totalUsage.cacheReadTokens).toBe(34000);
    expect(result.totalUsage.cacheCreationTokens).toBe(0);
  });
});
