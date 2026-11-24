import { describe, expect, it } from "vitest";

import {
  matchButtonAction,
  normalizeButtonText,
  parseButtonActions,
  parseButtonReply,
} from "./quickReply.ts";

const BF_ACTIONS = {
  yes: { match: ["כן, שלחו לי"], reply: "הנה זה 👇\n\nhttps://tinyurl.com/244ysxf7" },
  stop: { match: ["לא, הסירו אותי"], reply: "בסדר גמור, הסרתי אותך ולא נשלח יותר הודעות. בהצלחה 🙏", optout: true },
};

describe("parseButtonReply", () => {
  it("parses a template quick-reply button (type=button)", () => {
    expect(
      parseButtonReply({ type: "button", button: { text: "כן, שלחו לי", payload: "כן, שלחו לי" } }),
    ).toEqual({ text: "כן, שלחו לי", payload: "כן, שלחו לי" });
  });

  it("parses an interactive button_reply", () => {
    expect(
      parseButtonReply({
        type: "interactive",
        interactive: { type: "button_reply", button_reply: { id: "bf_yes", title: "כן, שלחו לי" } },
      }),
    ).toEqual({ text: "כן, שלחו לי", payload: "bf_yes" });
  });

  it("uses the payload as the text when the label is missing", () => {
    expect(parseButtonReply({ type: "button", button: { payload: "STOP" } })).toEqual({
      text: "STOP",
      payload: "STOP",
    });
  });

  it("returns null for plain text and for empty buttons", () => {
    expect(parseButtonReply({ type: "text" })).toBeNull();
    expect(parseButtonReply({ type: "button", button: { text: " ", payload: "" } })).toBeNull();
    expect(parseButtonReply({ type: "interactive", interactive: { type: "nfm_reply" } })).toBeNull();
  });
});

describe("parseButtonActions", () => {
  it("accepts the black-friday config", () => {
    const { actions, errors } = parseButtonActions(BF_ACTIONS);
    expect(errors).toEqual([]);
    expect(actions.yes.optout).toBe(false);
    expect(actions.stop.optout).toBe(true);
  });

  it("returns empty for NULL", () => {
    expect(parseButtonActions(null)).toEqual({ actions: {}, errors: [] });
  });

  it("drops invalid entries but keeps valid ones", () => {
    const { actions, errors } = parseButtonActions({
      yes: BF_ACTIONS.yes,
      broken: { match: [], reply: "x" },
      noReply: { match: ["a"] },
      badOptout: { match: ["a"], reply: "x", optout: "yes" },
    });
    expect(Object.keys(actions)).toEqual(["yes"]);
    expect(errors).toHaveLength(3);
  });

  it("rejects non-object roots", () => {
    expect(parseButtonActions([1, 2]).errors).toHaveLength(1);
    expect(parseButtonActions("x").errors).toHaveLength(1);
  });
});

describe("normalizeButtonText / matchButtonAction", () => {
  it("ignores bidi marks, extra spaces, case and trailing punctuation", () => {
    expect(normalizeButtonText("‏כן,  שלחו לי!")).toBe("כן, שלחו לי");
    expect(normalizeButtonText(" Send ME ")).toBe("send me");
  });

  it("matches by label", () => {
    const { actions } = parseButtonActions(BF_ACTIONS);
    expect(matchButtonAction(actions, { text: "לא, הסירו אותי", payload: null })?.name).toBe("stop");
  });

  it("matches by payload even when the label differs", () => {
    const { actions } = parseButtonActions({ yes: { match: ["bf_yes"], reply: "r" } });
    expect(matchButtonAction(actions, { text: "שלחו!", payload: "bf_yes" })?.name).toBe("yes");
  });

  it("returns null for an unconfigured button", () => {
    const { actions } = parseButtonActions(BF_ACTIONS);
    expect(matchButtonAction(actions, { text: "אולי אחר כך", payload: "אולי אחר כך" })).toBeNull();
  });
});
