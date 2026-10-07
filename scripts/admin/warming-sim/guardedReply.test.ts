import { describe, expect, it } from "vitest";
import { GENERIC_GUARD_HINT } from "../../../supabase/functions/_shared/guardHint.ts";
import { runGuardedReply, type GeneratedReply } from "./guardedReply.ts";

const OK_JUDGE = async () => ({ ok: true, reason: "clean" });

function reply(rawReply: string | null, extra: Partial<GeneratedReply> = {}): GeneratedReply {
  return { rawReply, offeredTimesIL: [], toolLines: [], ...extra };
}

function sequence(replies: GeneratedReply[]) {
  const prompts: string[] = [];
  const generate = async (systemPrompt: string) => {
    prompts.push(systemPrompt);
    return replies[prompts.length - 1];
  };
  return { generate, prompts };
}

describe("runGuardedReply", () => {
  it("sends a clean reply on the first attempt, with dashes sanitized", async () => {
    const { generate } = sequence([reply("היי — מה שלומך")]);
    const result = await runGuardedReply({ generate, judge: OK_JUDGE }, "SYS");
    expect(result.reply).toBe("היי - מה שלומך");
    expect(result.attempts).toBe(1);
  });

  it("retries once with the guard hint appended when the regex guard rejects", async () => {
    const { generate, prompts } = sequence([reply("זה עולה 500 ₪"), reply("בוא נדבר על זה בזום")]);
    const result = await runGuardedReply({ generate, judge: OK_JUDGE }, "SYS");
    expect(result.reply).toBe("בוא נדבר על זה בזום");
    expect(prompts).toEqual(["SYS", "SYS" + GENERIC_GUARD_HINT]);
    expect(result.events.some((e) => e.kind === "guard" && e.text.includes("currency_mention"))).toBe(true);
  });

  it("goes silent when both attempts are rejected, and says why", async () => {
    const { generate } = sequence([reply("אני בוט"), reply("אני בוט")]);
    const result = await runGuardedReply({ generate, judge: OK_JUDGE }, "SYS");
    expect(result.reply).toBeNull();
    expect(result.silenceReason).toBe("hallucination_hebrew_ai_self_disclosure");
    expect(result.events.at(-1)).toEqual({
      kind: "silence",
      text: "SILENCE (guard: hallucination_hebrew_ai_self_disclosure)",
    });
  });

  it("retries when the judge rejects", async () => {
    const { generate } = sequence([reply("תשובה ראשונה"), reply("תשובה שנייה")]);
    let calls = 0;
    const judge = async () => (++calls === 1 ? { ok: false, reason: "income_promise" } : { ok: true, reason: "clean" });
    const result = await runGuardedReply({ generate, judge }, "SYS");
    expect(result.reply).toBe("תשובה שנייה");
  });

  it("rejects an invented meeting time and allows one the tool offered", async () => {
    const invented = sequence([reply("מתאים לך 14:00?"), reply("מתאים לך 11:00?", { offeredTimesIL: ["11:00"] })]);
    const retried = await runGuardedReply({ generate: invented.generate, judge: OK_JUDGE }, "SYS");
    expect(retried.reply).toBe("מתאים לך 11:00?");
    expect(retried.events[0]).toMatchObject({ kind: "guard" });
  });

  it("records tool calls from every attempt", async () => {
    const { generate } = sequence([reply("קיבלתי", { toolLines: ["[tool: list_available_slots lead_requested_booking=true]"] })]);
    const result = await runGuardedReply({ generate, judge: OK_JUDGE }, "SYS");
    expect(result.events[0]).toEqual({ kind: "tool", text: "[tool: list_available_slots lead_requested_booking=true]" });
  });
});
