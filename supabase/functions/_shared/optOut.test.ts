import { describe, it, expect } from "vitest";
import { isOptOutMessage } from "./optOut.ts";

describe("isOptOutMessage", () => {
  it("matches bare Hebrew imperatives", () => {
    expect(isOptOutMessage("הסר")).toBe(true);
    expect(isOptOutMessage("להסיר")).toBe(true);
    expect(isOptOutMessage("תסיר")).toBe(true);
    expect(isOptOutMessage("תוריד")).toBe(true);
    expect(isOptOutMessage("תפסיק")).toBe(true);
    expect(isOptOutMessage("מחקו")).toBe(true);
  });

  it("matches English stop/unsubscribe in any case", () => {
    expect(isOptOutMessage("stop")).toBe(true);
    expect(isOptOutMessage("STOP")).toBe(true);
    expect(isOptOutMessage("Stop")).toBe(true);
    expect(isOptOutMessage("unsubscribe")).toBe(true);
    expect(isOptOutMessage("Unsubscribe")).toBe(true);
  });

  it("matches anchored Hebrew opt-out phrases", () => {
    expect(isOptOutMessage("הסר אותי")).toBe(true);
    expect(isOptOutMessage("הסר אותי בבקשה")).toBe(true);
    expect(isOptOutMessage("הסר אותי!")).toBe(true);
    expect(isOptOutMessage("הסירו אותי מהדיוור")).toBe(true);
    expect(isOptOutMessage("תוריד אותי")).toBe(true);
    expect(isOptOutMessage("מחקו אותי")).toBe(true);
    expect(isOptOutMessage("תפסיק לשלוח")).toBe(true);
    expect(isOptOutMessage("תפסיקו להציק")).toBe(true);
    expect(isOptOutMessage("אל תשלח")).toBe(true);
    expect(isOptOutMessage("לא תפנו אליי")).toBe(true);
  });

  it("matches anchored English phrases", () => {
    expect(isOptOutMessage("stop messaging me")).toBe(true);
    expect(isOptOutMessage("stop sending")).toBe(true);
    expect(isOptOutMessage("stop me")).toBe(true);
    expect(isOptOutMessage("unsubscribe please")).toBe(true);
  });

  it("ignores empty / whitespace input", () => {
    expect(isOptOutMessage("")).toBe(false);
    expect(isOptOutMessage("   ")).toBe(false);
    expect(isOptOutMessage("\n")).toBe(false);
  });

  it("does NOT trigger on side-channel meanings", () => {
    // The lead saying "don't stop progressing" — common phrase, not an opt-out.
    expect(isOptOutMessage("אל תפסיק להתקדם")).toBe(false);
    // Asking the bot to remove a hat (silly but illustrates the trap).
    expect(isOptOutMessage("הסר את הכובע מהפנים")).toBe(false);
    // "stop" embedded in a longer non-opt-out sentence.
    expect(isOptOutMessage("can I stop by the office?")).toBe(false);
    // Question that contains "תוריד".
    expect(isOptOutMessage("איך תוריד לי את האפליקציה?")).toBe(false);
  });

  it("trims whitespace before matching", () => {
    expect(isOptOutMessage("  הסר  ")).toBe(true);
    expect(isOptOutMessage("\nSTOP\n")).toBe(true);
  });
});
