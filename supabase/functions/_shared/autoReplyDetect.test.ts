import { describe, expect, it } from "vitest";
import { isBusinessAutoReply, looksLikeAutoReplyText } from "./autoReplyDetect.ts";

// Real inbound messages from production (Sep–Oct 2026), each of which the bot
// tried to answer.
const REAL_AUTO_REPLIES = [
  "‏תודה שיצרת קשר עם Pelle Project ✨ איך אפשר לעזור?",
  "היי, תודה שפנית אליי!   אני כרמית מ-*Carmit Perez – Home Decor & Art*.",
  "‏תודה שיצרתם קשר עם הבלוק סוכנות לנדל\"ן משרד התיווך המוביל בראשון לציון , מיד נתפנה",
  "PRO KIDS Football Academy ⚽ טוב שכתבת לנו! 🚀 נחזור אליך בהקדם האפשרי.",
  "‏תודה על פנייתך. איננו זמינים כעת, אך נשיב לך ברגע שנוכל.",
  "שלום רב, אשמח לעזור לך.  נא להשאיר לי הודעה ואחזור בהקדם.   עו״ד איתי לנדסמן.",
  "היי, איזה כיף שפנית 😊 סטודיו ארטיסטיק 360, רויטל מוסקוביץ.",
  "ברוכים הבאים לפילאטיס רום😄  אנו שמחים לראות שהתעניינת, קיבלנו את פנייתך ונחזור בהקדם!",
  "שלום,  הגעתם לרועי חונן - יועץ נדל״ן,  אור נכסים ראשל״צ.  במה אפשר לעזור ?",
  "היי, תודה רבה על ההתעניינות. כרגע אני באמצע טיפול ואשמח לחזור אליכם בשעות הפעילות 🕗",
];

// Real leads answering a person. None of these may be swallowed.
const REAL_LEAD_REPLIES = [
  "היי, לא רלוונטי, תודה",
  "כן, מעניין אותי. מה זה בדיוק?",
  "אני חושבת שכבר הייתי בשיחת זום",
  "מחר אפשר אחרי הצהריים",
  "תודה! אשמח לשמוע עוד",
  "אין לי כסף להשקיע כרגע",
];

describe("looksLikeAutoReplyText", () => {
  it("recognises real business greetings", () => {
    for (const text of REAL_AUTO_REPLIES) {
      expect(looksLikeAutoReplyText(text), text).toBe(true);
    }
  });

  it("does not match ordinary lead replies", () => {
    for (const text of REAL_LEAD_REPLIES) {
      expect(looksLikeAutoReplyText(text), text).toBe(false);
    }
  });
});

describe("isBusinessAutoReply", () => {
  const greeting = REAL_AUTO_REPLIES[0];

  it("is an auto-reply when the greeting arrives seconds after our message", () => {
    expect(isBusinessAutoReply({ text: greeting, secondsSinceOurLastMessage: 3 })).toBe(true);
  });

  // A person who reads us and writes "תודה שפנית" minutes later is a person.
  it("is not an auto-reply when it arrives long after our message", () => {
    expect(isBusinessAutoReply({ text: greeting, secondsSinceOurLastMessage: 600 })).toBe(false);
  });

  it("is not an auto-reply when we never wrote first", () => {
    expect(isBusinessAutoReply({ text: greeting, secondsSinceOurLastMessage: null })).toBe(false);
  });

  it("is not an auto-reply for a fast but ordinary reply", () => {
    expect(isBusinessAutoReply({ text: "כן מעניין", secondsSinceOurLastMessage: 5 })).toBe(false);
  });
});
