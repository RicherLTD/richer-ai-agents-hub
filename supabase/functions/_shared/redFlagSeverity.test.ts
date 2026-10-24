import { describe, expect, it } from "vitest";
import { isSensitiveRedFlag, splitRedFlags } from "./redFlagSeverity.ts";

// Every flag below is a real value from production lead_memory (2026-10-07).
describe("isSensitiveRedFlag", () => {
  it("treats wellbeing, health and minors as sensitive", () => {
    for (const flag of [
      "mental_distress_signals",
      "mental_distress",
      "health_issues",
      "health_condition",
      "אות של דיסטרס רגשי - מדבר על עצמו ככלוא וברטט",
      "תסמיני מצוקה נפשית ובריאותית",
      "צעיר_לפני_צבא",
    ]) {
      expect(isSensitiveRedFlag(flag), flag).toBe(true);
    }
  });

  // The 2026-05-19 Hodaya rule: a lead in serious financial distress gets a
  // human, never an automatic Zoom. Must survive this change.
  it("keeps serious financial distress sensitive on the flag alone", () => {
    for (const flag of [
      "מצב כלכלי קריטי",
      "חרדה משמעותית בנושא כסף — משתקת אותה",
      "heavy_debt",
      "financial_crisis",
    ]) {
      expect(isSensitiveRedFlag(flag), flag).toBe(true);
    }
  });

  // Real October 2026 cases: the extractor wrote "financial_distress" for a
  // plain money objection and the bot went silent on a warm lead.
  it("treats a generic financial flag as a note when the lead only objected on money", () => {
    const objections = [
      "אין כסף להשקיע ונפשית כרגע",
      "אין לי זמן וכסף לשלם על זה",
      "תשמע בכנות אגיד לך... כסף להשקיע שוב אין לי",
    ];
    for (const flag of ["financial_distress", "financial_stress", "vulnerable_financial"]) {
      for (const leadText of objections) {
        expect(isSensitiveRedFlag(flag, leadText), `${flag} / ${leadText}`).toBe(false);
      }
      expect(isSensitiveRedFlag(flag), flag).toBe(false);
    }
  });

  it("keeps a generic financial flag sensitive when the lead wrote about real trouble", () => {
    for (const leadText of [
      "התראות לפני עיקול",
      "החודש חסמו לי את הכרטיס ואין לי איך להתמודד, חשבתי לקחת הלוואה",
      "אני מקבל ביטוח לאומי ויש לי נכות 100",
      "מהתחלה לסגור את כל החובות",
    ]) {
      expect(isSensitiveRedFlag("financial_distress", leadText), leadText).toBe(true);
    }
  });

  it("does not read 'חוב' inside another word", () => {
    expect(isSensitiveRedFlag("financial_stress", "אני גר ברחוב הרצל, זה חובה בשבילי")).toBe(false);
  });

  // Notes for the advisor. Silencing the bot over these left warm leads
  // unanswered, and on statuses 52/55/58/59 they are the objection itself.
  it("treats past experiences, attitudes and logistics as notes", () => {
    for (const flag of [
      "past_financial_trauma",
      "past_scam_victim",
      "already invested money and not seeing returns",
      "skeptical_of_financial_courses",
      "get_rich_quick",
      "get-rich-quick mindset",
      "חשוד ב-get-rich-quick mentality (עשרות אלפים פוטנציאל)",
      "procrastination",
      "no_computer",
      "religious_restrictions_on_internet",
      "testing_boundaries",
    ]) {
      expect(isSensitiveRedFlag(flag), flag).toBe(false);
    }
  });

  it("still treats a past experience as sensitive when it carries a wellbeing signal", () => {
    expect(isSensitiveRedFlag("past scam left him in mental distress")).toBe(true);
  });
});

describe("splitRedFlags", () => {
  it("separates sensitive flags from advisor notes", () => {
    expect(splitRedFlags(["procrastination", "mental_distress", "no_computer"])).toEqual({
      sensitive: ["mental_distress"],
      notes: ["procrastination", "no_computer"],
    });
  });

  it("handles an empty list", () => {
    expect(splitRedFlags([])).toEqual({ sensitive: [], notes: [] });
  });
});
