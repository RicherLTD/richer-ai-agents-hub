// autoReplyDetect.ts
//
// Recognise a WhatsApp Business away/greeting message ("תודה שיצרת קשר עם
// Pelle Project! איך אפשר לעזור?") so the agent loop can stay silent.
//
// Many leads run a business number. Our template lands, their phone answers
// itself within seconds, and the bot used to "reply" to the robot. That reply
// ("נראה שקיבלתי הודעה אוטומטית...") then tripped the safety judge, the lead's
// business got the "I hit a glitch, a rep will call you" fallback, and the
// operators got an alert about nothing: 33 alerts Sep–Oct 2026, 19 of them on
// the 22.10 broadcast alone.
//
// Two signals, BOTH required, so a real person is never ignored:
//   1. the text reads like a canned business greeting, and
//   2. it arrived within seconds of our own message. In two months of prod
//      data 206 of 213 such greetings came within 60s; a person typing
//      "תודה שפנית" after reading us takes far longer.

/** A canned greeting answers within seconds. A human reading and typing a
 *  reply takes longer than this. */
export const AUTO_REPLY_MAX_DELAY_SECONDS = 90;

/** Phrases WhatsApp Business greeting / away messages are built from. No `\b`
 *  — it does not work on Hebrew in JS regex. */
const AUTO_REPLY_PATTERNS: ReadonlyArray<RegExp> = [
  // "תודה שיצרת קשר", "תודה שפנית", "תודה שכתבתם", "תודה רבה על פנייתך"
  /תודה(?:\s+רבה)?\s*(?:ש(?:יצרת|יצרתם|פנית|פניתם|כתבת|כתבתם|הגעת|הגעתם)|על\s+(?:פנייתך|פנייתכם|הפנייה|ההתעניינות))/,
  // "איזה כיף שפנית", "טוב שכתבת לנו", "כיף שיצרת איתי קשר"
  /(?:כיף|טוב)\s+ש(?:פנית|פניתם|כתבת|כתבתם|יצרת|יצרתם)/,
  // "נחזור אליך בהקדם", "אתפנה בהקדם", "אשיב לך ברגע שנוכל"
  /(?:נחזור|אחזור|אשוב|נשוב|אתפנה|נתפנה|נשיב|אשיב|נענה)[^.!?\n]{0,30}(?:בהקדם|בקרוב|ברגע|כשאתפנה|כשנתפנה)/,
  // "שעות הפעילות שלנו", "איננו זמינים כעת"
  /שעות\s+(?:ה)?פעילות/,
  /(?:איננו|אנחנו\s+לא|אני\s+לא)\s+(?:זמינים|זמינה|זמין)\s+(?:כעת|כרגע)/,
  // "הגעתם ל...", "ברוכים הבאים ל..."
  /(?:^|\s)הגעת(?:ם)?\s+ל/,
  /ברוכים\s+הבאים/,
  /thank(?:s| you) for (?:contacting|your message|reaching out)/i,
];

export function looksLikeAutoReplyText(text: string): boolean {
  // Business greetings often open with an invisible RTL mark (U+200F).
  const clean = text.replace(/[‎‏]/g, "").trim();
  if (!clean) return false;
  return AUTO_REPLY_PATTERNS.some((p) => p.test(clean));
}

export function isBusinessAutoReply(args: {
  text: string | null | undefined;
  /** Seconds between our latest outbound message and this inbound. Null
   *  when we never wrote first — then it cannot be an auto-reply to us. */
  secondsSinceOurLastMessage: number | null;
}): boolean {
  const { text, secondsSinceOurLastMessage: secs } = args;
  if (!text || secs === null || secs < 0) return false;
  if (secs > AUTO_REPLY_MAX_DELAY_SECONDS) return false;
  return looksLikeAutoReplyText(text);
}
