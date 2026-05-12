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

describe("validateAgentReply — hallucination guards", () => {
  it("blocks AI brand leaks (ChatGPT, Claude, OpenAI)", () => {
    expect(validateAgentReply("היי, אני נציג של ChatGPT").ok).toBe(false);
    expect(validateAgentReply("בעזרת Claude נוכל לעזור לך").ok).toBe(false);
    expect(validateAgentReply("אני מ-OpenAI").ok).toBe(false);
  });

  it("blocks Hebrew AI self-disclosure", () => {
    expect(validateAgentReply("שלום, אני AI").ok).toBe(false);
    expect(validateAgentReply("אני בוט שמטפל בפניות").ok).toBe(false);
    expect(validateAgentReply("אני מודל שפה ולא יכול לענות").ok).toBe(false);
    expect(validateAgentReply("אני בינה מלאכותית ובאתי לעזור").ok).toBe(false);
  });

  it("blocks currency mentions (₪, $, ש\"ח, שקלים)", () => {
    expect(validateAgentReply("העלות היא 5000 ש\"ח לחודש").ok).toBe(false);
    expect(validateAgentReply("המסלול עולה 1000₪").ok).toBe(false);
    expect(validateAgentReply("רק ב-$100").ok).toBe(false);
    expect(validateAgentReply("תקבל 10,000 שקלים בחודש").ok).toBe(false);
  });

  it("blocks income guarantee language", () => {
    expect(validateAgentReply("אני מבטיח לך שתרוויח").ok).toBe(false);
    expect(validateAgentReply("יש לנו ערבות מלאה").ok).toBe(false);
    expect(validateAgentReply("התוצאה מובטחת").ok).toBe(false);
  });

  it("does not false-positive on legitimate Hebrew replies", () => {
    expect(validateAgentReply("שלום! אשמח לשמוע איך אפשר לעזור.").ok).toBe(true);
    expect(validateAgentReply("ספר לי קצת על עצמך — כמה אתה בן?").ok).toBe(true);
    expect(
      validateAgentReply(
        "התוכנית שלנו עוזרת לאנשים לבנות הכנסה נוספת. בוא נדבר בזום עם יועץ.",
      ).ok,
    ).toBe(true);
  });

  it("returns a specific hallucination reason in the error", () => {
    const r1 = validateAgentReply("אני AI");
    expect(r1.ok).toBe(false);
    if (!r1.ok) expect(r1.reason).toContain("hallucination_hebrew_ai_self_disclosure");

    const r2 = validateAgentReply("5000 ש\"ח");
    expect(r2.ok).toBe(false);
    if (!r2.ok) expect(r2.reason).toContain("hallucination_currency_mention");
  });
});
