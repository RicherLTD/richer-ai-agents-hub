import { describe, expect, it } from "vitest";
import type { SimulationContext, StatusRule } from "./loadContext.ts";
import { assembleSystemPrompt, buildDateHeader, buildTurnPrompt } from "./promptAssembly.ts";
import type { Scenario } from "./scenarios.ts";

const MAIN_SENTINEL = "MAIN_PROMPT_SENTINEL";
const BRAIN_SENTINEL = "BRAIN_NOTE_SENTINEL";
const RULE_SENTINEL = "RULE_INSTRUCTION_SENTINEL";
const OPENER_TEXT = "מה קורה?";
const NOW = new Date("2026-10-07T09:00:00.000Z");

const rule: StatusRule = {
  status_sub: 22,
  status_label: "פוטנציאל עתידי",
  objection_key: "future_potential",
  warming_instructions: RULE_SENTINEL,
};

const context: SimulationContext = {
  agentId: "11111111-1111-1111-1111-111111111111",
  agentSlug: "affiliate_marketing",
  mainPrompt: { content: MAIN_SENTINEL, version: "v-test" },
  openerTemplateName: "warming_1",
  openerText: OPENER_TEXT,
  rules: [rule],
  brainRows: [{
    id: "22222222-2222-2222-2222-222222222222",
    source_kind: "note",
    title: "note",
    description: null,
    ai_title: null,
    ai_description: null,
    extracted_text: BRAIN_SENTINEL,
    tags: [],
    shared_across_agents: false,
  }],
};

const scenario: Scenario = {
  id: "status-22",
  statusSub: 22,
  title: "t",
  persona: "p",
  plan: ["הכל טוב"],
  mustHappen: [],
  mustNotHappen: [],
  maxTurns: 3,
  priorMemory: {
    q1_age: 31, q2_motivation: "PRIOR_MOTIVATION", q3_dream_change: null, q4_blocker: null, q5_urgency: null,
  },
};

describe("buildTurnPrompt", () => {
  const prompt = buildTurnPrompt({
    context, rule, scenario, chat: [{ role: "user", content: "הכל טוב" }], now: NOW,
  });
  const text = prompt.systemPrompt;

  it("orders date header, warming block, main prompt, brain section", () => {
    const indexes = [
      text.indexOf("# Current date context"),
      text.indexOf("# CRM status context"),
      text.indexOf(MAIN_SENTINEL),
      text.indexOf("## Brain"),
    ];
    expect(indexes.every((i) => i >= 0)).toBe(true);
    expect([...indexes].sort((a, b) => a - b)).toEqual(indexes);
    expect(text.indexOf(BRAIN_SENTINEL)).toBeGreaterThan(indexes[3]);
  });

  it("puts the rule instructions inside the warming block, before the main prompt", () => {
    expect(prompt.warmingBlock).toContain(RULE_SENTINEL);
    expect(text.indexOf(RULE_SENTINEL)).toBeLessThan(text.indexOf(MAIN_SENTINEL));
  });

  it("quotes the opener text and the prior profile in the warming block", () => {
    expect(prompt.warmingBlock).toContain(OPENER_TEXT);
    expect(prompt.warmingBlock).toContain("PRIOR_MOTIVATION");
  });

  it("shows the model the opener marker first and hides the earlier conversation", () => {
    expect(prompt.claudeMessages).toEqual([
      { role: "assistant", content: "[template:warming_1]" },
      { role: "user", content: "הכל טוב" },
    ]);
    expect(prompt.hiddenCount).toBe(2);
  });

  it("leaves the booking status block empty", () => {
    expect(text.startsWith(buildDateHeader(NOW) + "# CRM status context")).toBe(true);
  });
});

describe("assembleSystemPrompt", () => {
  it("concatenates in the handler's order", () => {
    const parts = { dateHeader: "A", bookingStatusBlock: "B", warmingBlock: "C", mainPrompt: "D", brainText: "E" };
    expect(assembleSystemPrompt(parts)).toBe("ABCDE");
  });
});

describe("buildDateHeader", () => {
  it("uses the Israel calendar date", () => {
    expect(buildDateHeader(new Date("2026-10-07T22:30:00.000Z"))).toContain("Today is 2026-10-08 (Thursday");
  });
});
