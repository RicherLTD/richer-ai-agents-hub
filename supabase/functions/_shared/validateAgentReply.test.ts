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

  it("blocks the legally-binding guarantee terms (מובטח / ערבות)", () => {
    expect(validateAgentReply("יש לנו ערבות מלאה").ok).toBe(false);
    expect(validateAgentReply("התוצאה מובטחת").ok).toBe(false);
    expect(validateAgentReply("תרוויח 5000 בחודש").ok).toBe(false);
  });

  it("ALLOWS the verb 'להבטיח' when not paired with a concrete amount", () => {
    expect(validateAgentReply("אני לא יכול להבטיח לך סכום מדויק").ok).toBe(true);
    expect(
      validateAgentReply("אני יכול להבטיח שאם תעשה את הצעדים אין סיבה שלא תצליח").ok,
    ).toBe(true);
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

  // Hardening — devil-advocate review pre-pilot.
  it("blocks numeric prices without a currency symbol", () => {
    expect(validateAgentReply("התוכנית עולה 5000").ok).toBe(false);
    expect(validateAgentReply("ההשקעה היא 5 אלף").ok).toBe(false);
    expect(validateAgentReply("המחיר בערך 10K").ok).toBe(false);
    expect(validateAgentReply("חבילה של 3 אלפים").ok).toBe(false);
  });

  it("blocks 'תרוויח X בחודש' style income promises", () => {
    expect(validateAgentReply("תרוויח 5000 בחודש").ok).toBe(false);
    expect(validateAgentReply("תכניס סכומים גדולים בחודש").ok).toBe(false);
    expect(validateAgentReply("תעשה הרבה כסף בשנה").ok).toBe(false);
    expect(validateAgentReply("תרוויחי טוב בחודש").ok).toBe(false);
  });

  it("blocks broader AI self-disclosure phrasings", () => {
    expect(validateAgentReply("זה לא בנאדם, זאת מערכת").ok).toBe(false);
    expect(validateAgentReply("מערכת אוטומטית עונה לך").ok).toBe(false);
    expect(validateAgentReply("אני לא בן אדם").ok).toBe(false);
  });

  it("still passes innocent uses of similar-looking phrases", () => {
    expect(validateAgentReply("תוכל לעלות לי שאלה?").ok).toBe(true);
    expect(validateAgentReply("היועץ ידבר איתך בזום").ok).toBe(true);
  });

  it("does NOT false-positive on standalone number+אלף without a price context", () => {
    // "2 אלף לידים" — no price-word before, no currency after → allowed
    expect(validateAgentReply("יש לנו 2 אלף לידים בחודש").ok).toBe(true);
    // "300 אלף בוגרים" — same
    expect(validateAgentReply("יותר מ-300 אלף בוגרים בארץ").ok).toBe(true);
    // But "ההשקעה היא 5 אלף ₪" — price word present → blocked (regression)
    expect(validateAgentReply("ההשקעה היא 5 אלף ₪").ok).toBe(false);
  });

  it("does NOT false-positive on innocent 2-digit numbers after a price word", () => {
    // "התוכנית בנויה מ-12 שלבים" — 2-digit, no currency token → allowed
    expect(validateAgentReply("התוכנית בנויה מ-12 שלבים").ok).toBe(true);
    // "הקורס מתאים לבני 25" — 2-digit age after קורס → allowed
    expect(validateAgentReply("הקורס מתאים לבני 25").ok).toBe(true);
    // But "הקורס עולה 5000" — 4-digit → blocked (regression)
    expect(validateAgentReply("הקורס עולה 5000").ok).toBe(false);
  });

  it("does NOT false-positive on conditional motivational language without an income noun", () => {
    // No income noun between verb and time-window → not an income promise
    expect(
      validateAgentReply("אם תעשה את זה כמו שצריך תראה שינוי בחודש-חודשיים").ok,
    ).toBe(true);
    // With a concrete number → still blocked (regression)
    expect(validateAgentReply("תרוויח 3000 בחודש").ok).toBe(false);
  });

  it("does NOT confuse 'מעולה' (excellent) for 'עולה' (costs)", () => {
    // Regression for the 2026-05-24 incident — Kfir's booking-confirmation
    // reply ("מעולה, 11:30 מחר פנוי! 🙌 ... שם מלא ... כתובת מייל") got
    // DLQ'd because the prefix-attached "עולה" inside "מעולה" tripped the
    // currency-mention guard.
    const opts = { allowedMeetingTimes: ["11:30"] };
    expect(
      validateAgentReply("מעולה, 11:30 מחר פנוי! מה השם המלא והמייל?", opts).ok,
    ).toBe(true);
    expect(validateAgentReply("מעולה 13").ok).toBe(true);
    // And the original intent — "X עולה 5000" — must STILL be blocked.
    expect(validateAgentReply("התוכנית עולה 5000").ok).toBe(false);
  });
});

describe("validateAgentReply — invented meeting time guard (grounded)", () => {
  it("blocks HH:MM mentions when no slots were offered this turn", () => {
    const r = validateAgentReply("מחר בשעה 12:45 היועץ יחזור אליך");
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.reason).toBe("invented_meeting_time");
  });

  it("blocks bare digital times like 14:30 / 9:00 too", () => {
    expect(validateAgentReply("נדבר ב-14:30").ok).toBe(false);
    expect(validateAgentReply("בשעה 9:00 בערב").ok).toBe(false);
    expect(validateAgentReply("19:45 מתאים?").ok).toBe(false);
  });

  it("ALLOWS HH:MM that matches a slot returned this turn", () => {
    const opts = { allowedMeetingTimes: ["12:45", "10:30", "14:00"] };
    expect(validateAgentReply("מחר בשעה 12:45 נקבע זום", opts).ok).toBe(true);
    expect(validateAgentReply("מצאתי לך 10:30 ו-14:00 — מה עדיף?", opts).ok).toBe(true);
  });

  it("normalizes leading zeros: '09:30' matches an allowed '9:30' and vice versa", () => {
    expect(validateAgentReply("נקבע ל-09:30?", { allowedMeetingTimes: ["9:30"] }).ok).toBe(true);
    expect(validateAgentReply("נקבע ל-9:30?", { allowedMeetingTimes: ["09:30"] }).ok).toBe(true);
  });

  // THE incident: 21:30 at night. The bot called list_available_slots (so
  // the old `hasMoozToolUseThisTurn` flag was true and the guard was OFF),
  // got back daytime slots that did NOT include 21:30, and stated 21:30
  // anyway. Grounding catches it: a tool ran, real times exist, but the
  // stated time is not among them → blocked.
  it("blocks an invented time even when OTHER slots were legitimately offered", () => {
    const opts = { allowedMeetingTimes: ["10:30", "14:00"] };
    const r = validateAgentReply("מעולה, קבעתי לך מחר ב-21:30 🙌", opts);
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.reason).toBe("invented_meeting_time");
  });

  it("blocks a reply mixing one real and one invented time", () => {
    const opts = { allowedMeetingTimes: ["10:30"] };
    // 10:30 is real, 21:30 is invented — the whole reply must be rejected.
    expect(validateAgentReply("יש לי 10:30 או 21:30 — מה עדיף?", opts).ok).toBe(false);
  });

  it("still ALLOWS day-name-only replies (no concrete time committed)", () => {
    expect(validateAgentReply("מחר בערב נוח לך?").ok).toBe(true);
    expect(validateAgentReply("ביום ראשון אפשר?").ok).toBe(true);
    expect(validateAgentReply("שווה לקפוץ לזום בקרוב").ok).toBe(true);
  });

  it("does not false-positive on '24/7' / non-time digits", () => {
    expect(validateAgentReply("היועצים זמינים 24/7 לפניות").ok).toBe(true);
    expect(validateAgentReply("הקורס בנוי מ-3 מסלולים").ok).toBe(true);
  });
});
