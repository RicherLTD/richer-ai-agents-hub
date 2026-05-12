import { describe, expect, it } from "vitest";
import { validateAgentReply } from "./validateAgentReply.ts";

describe("validateAgentReply", () => {
  it("accepts a normal Hebrew reply", () => {
    const result = validateAgentReply("שלום, מה שלומך?");
    expect(result.ok).toBe(true);
    if (result.ok) expect(result.text).toBe("שלום, מה שלומך?");
  });

  it("trims surrounding whitespace", () => {
    const result = validateAgentReply("   hello world   ");
    expect(result.ok).toBe(true);
    if (result.ok) expect(result.text).toBe("hello world");
  });

  it("rejects null", () => {
    const result = validateAgentReply(null);
    expect(result).toEqual({ ok: false, reason: "reply_is_null" });
  });

  it("rejects undefined", () => {
    const result = validateAgentReply(undefined);
    expect(result).toEqual({ ok: false, reason: "reply_is_null" });
  });

  it("rejects empty string", () => {
    const result = validateAgentReply("");
    expect(result).toEqual({ ok: false, reason: "reply_too_short" });
  });

  it("rejects all-whitespace", () => {
    const result = validateAgentReply("   \n\t   ");
    expect(result).toEqual({ ok: false, reason: "reply_too_short" });
  });

  it("rejects a single character", () => {
    const result = validateAgentReply("a");
    expect(result).toEqual({ ok: false, reason: "reply_too_short" });
  });

  it("rejects content exceeding the max length", () => {
    const result = validateAgentReply("a".repeat(1501));
    expect(result).toEqual({ ok: false, reason: "reply_too_long" });
  });

  it("rejects [MISSING] placeholder leak", () => {
    const result = validateAgentReply("שלום [MISSING] מה שלומך");
    expect(result).toEqual({ ok: false, reason: "reply_contains_placeholder" });
  });

  it("rejects lowercase [missing] placeholder leak", () => {
    const result = validateAgentReply("שלום [missing] מה שלומך");
    expect(result).toEqual({ ok: false, reason: "reply_contains_placeholder" });
  });

  it("rejects mustache-style template leak", () => {
    const result = validateAgentReply("שלום {{name}}, מה שלומך?");
    expect(result).toEqual({ ok: false, reason: "reply_contains_placeholder" });
  });

  it("rejects HTML-style placeholder leak", () => {
    const result = validateAgentReply("שלום <NAME>, מה שלומך?");
    expect(result).toEqual({ ok: false, reason: "reply_contains_placeholder" });
  });

  it("does not false-positive on legitimate brackets in content", () => {
    // Brackets without a known placeholder token should pass.
    const result = validateAgentReply("חשוב לדעת (בסוגריים) שזה תקין");
    expect(result.ok).toBe(true);
  });
});
