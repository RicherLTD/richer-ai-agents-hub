import { describe, expect, it } from "vitest";
import { findSystemLeak, SYSTEM_LEAK_REASON, withSystemLeakGuard } from "./systemLeakGuard.ts";

describe("findSystemLeak", () => {
  // The exact reply sent live on 2026-10-22.
  it("catches the live leak", () => {
    const live =
      "ובכן - המערכת עצרה אותי כי לא עברתי כאן את שלב החימום 😄\n\nזה בעצם עובד בדיוק כמו שצריך - לא מקבעים פגישה לפני שמבינים מה הליד באמת רוצה.";
    expect(findSystemLeak(live)).toBe("system_blocked");
  });

  it("catches each piece of internal vocabulary on its own", () => {
    expect(findSystemLeak("המערכת לא מאפשרת לי לקבוע עכשיו")).toBe("system_blocked");
    expect(findSystemLeak("משהו חסם אותי רגע")).toBe("stopped_me");
    expect(findSystemLeak("אנחנו עדיין בשלב החימום")).toBe("warming_stage");
    expect(findSystemLeak("רציתי לחמם אותך קצת קודם")).toBe("warming_stage");
    expect(findSystemLeak("לפני שמבינים מה הליד רוצה")).toBe("calls_them_lead");
    expect(findSystemLeak("ככה כתוב בפרומפט")).toBe("prompt_or_bot_rules");
  });

  it("leaves normal replies alone, including 'ליד' meaning 'next to'", () => {
    expect(findSystemLeak("כיף לשמוע 😊 מה השתנה אצלך מאז?")).toBeNull();
    expect(findSystemLeak("אני גר ליד תל אביב")).toBeNull();
    expect(findSystemLeak("ממש ליד הבית שלי")).toBeNull();
    expect(findSystemLeak("המשרד שליד הבית")).toBeNull();
    expect(findSystemLeak("זה עדיין רלוונטי לך היום?")).toBeNull();
  });
});

describe("withSystemLeakGuard", () => {
  const leaking = { ok: true as const, text: "המערכת עצרה אותי" };

  it("rejects a leaking first attempt so the handler retries", () => {
    expect(withSystemLeakGuard(leaking, { isRetry: false })).toEqual({ ok: false, reason: SYSTEM_LEAK_REASON });
  });

  it("lets the retry through rather than leave the lead with silence", () => {
    expect(withSystemLeakGuard(leaking, { isRetry: true })).toBe(leaking);
  });

  it("passes clean replies and earlier rejections through untouched", () => {
    const clean = { ok: true as const, text: "מה השתנה מאז?" };
    expect(withSystemLeakGuard(clean, { isRetry: false })).toBe(clean);
    const rejected = { ok: false as const, reason: "currency_mention" };
    expect(withSystemLeakGuard(rejected, { isRetry: false })).toBe(rejected);
  });
});
