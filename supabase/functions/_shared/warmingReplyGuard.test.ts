import { describe, expect, it } from "vitest";
import {
  findAnnouncedTechnique,
  WARMING_TECHNIQUE_REASON,
  withWarmingReplyGuard,
} from "./warmingReplyGuard.ts";

describe("findAnnouncedTechnique", () => {
  // The exact reply sent live on status 50, despite two written rules.
  it("catches 'not here to interrogate' in the wording the bot actually used", () => {
    expect(findAnnouncedTechnique("בסדר גמור, לא חייב 😊\n\nרק אגיד - לא כאן כדי לחקור.")).toBe("not_interrogating");
    expect(findAnnouncedTechnique("אני לא פה לחקור אותך")).toBe("not_interrogating");
  });

  it("catches announced 'no pressure'", () => {
    expect(findAnnouncedTechnique("בלי לחץ, תחשוב על זה")).toBe("no_pressure");
    expect(findAnnouncedTechnique("אין שום לחץ")).toBe("no_pressure");
  });

  it("catches announced 'not trying to sell' and 'just want to help'", () => {
    expect(findAnnouncedTechnique("אני לא מנסה למכור לך כלום")).toBe("not_selling");
    expect(findAnnouncedTechnique("אני רק רוצה לעזור")).toBe("just_helping");
  });

  it("leaves ordinary warm replies alone", () => {
    expect(findAnnouncedTechnique("מבין לגמרי. מה הכי עוצר אותך עכשיו?")).toBeNull();
    expect(findAnnouncedTechnique("זה לחץ אמיתי, מבין אותך")).toBeNull();
    expect(findAnnouncedTechnique("היועץ ישמח לעזור לך לבדוק את זה")).toBeNull();
  });
});

describe("withWarmingReplyGuard", () => {
  const announced = { ok: true as const, text: "רק אגיד - לא כאן כדי לחקור." };

  it("rejects an announced technique on the first attempt of a warming turn", () => {
    expect(withWarmingReplyGuard(announced, { isWarming: true, isRetry: false })).toEqual({
      ok: false,
      reason: WARMING_TECHNIQUE_REASON,
    });
  });

  // A second miss sends the reply anyway: a slightly robotic line costs less
  // than the silence a hard block would leave the lead with.
  it("lets the retry through rather than silencing the lead", () => {
    expect(withWarmingReplyGuard(announced, { isWarming: true, isRetry: true })).toEqual(announced);
  });

  it("never touches a normal lead's reply", () => {
    expect(withWarmingReplyGuard(announced, { isWarming: false, isRetry: false })).toEqual(announced);
  });

  it("passes an earlier rejection through unchanged", () => {
    const rejected = { ok: false as const, reason: "currency_mention" };
    expect(withWarmingReplyGuard(rejected, { isWarming: true, isRetry: false })).toEqual(rejected);
  });
});
