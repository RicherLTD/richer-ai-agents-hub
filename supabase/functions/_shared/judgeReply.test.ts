import { describe, expect, it } from "vitest";
import { buildJudgeUserContent } from "./judgeReply.ts";

describe("buildJudgeUserContent", () => {
  it("audits the reply alone when there is no lead message", () => {
    expect(buildJudgeUserContent("היי 😊", null)).toBe("Reply to audit:\n\nהיי 😊");
    expect(buildJudgeUserContent("היי 😊", "   ")).toBe("Reply to audit:\n\nהיי 😊");
  });

  // The judge blocked "פער של כ-8,000 בחודש" as an income promise because it
  // could not see that the lead wrote the 8,000 themself.
  it("puts the lead's message before the reply, marked as context", () => {
    const out = buildJudgeUserContent("אז פער של כ-8,000 בחודש", "חסר לי 8,000 בחודש");
    expect(out.indexOf("חסר לי 8,000 בחודש")).toBeLessThan(out.indexOf("Reply to audit:"));
    expect(out).toContain("context only");
    expect(out.endsWith("אז פער של כ-8,000 בחודש")).toBe(true);
  });

  it("keeps only the tail of a very long lead message", () => {
    const long = "א".repeat(3000) + "סוף";
    const out = buildJudgeUserContent("תשובה", long);
    expect(out).toContain("סוף");
    expect(out.length).toBeLessThan(1700);
  });
});
