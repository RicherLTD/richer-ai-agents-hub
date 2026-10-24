// judgeReply.ts
//
// LLM-as-judge: a cheap Haiku 4.5 call that scores a Sonnet-generated
// reply against our hard safety rules BEFORE we send it to a lead.
//
// Why: validateAgentReply.ts is regex-based. It catches the obvious
// jailbreak phrasings (prices with ₪, "מובטח") but a smart model can
// leak the same content semantically:
//   - "ההשקעה בסדר גודל של 5 אלף"   (numeric without ₪)
//   - "תרוויח בערך 3-5 אלף בחודש"   (income promise without "מובטח")
//
// Saying it is a bot is NOT a violation (policy since 2026-10-25: transparent
// when asked). Blocking it made 45 alerts in two months, most of them the bot
// noticing a business auto-reply or a lead asking "are you a bot?".
//
// Haiku is fast (~500ms) and cheap (~$0.0003 per call). Per-turn cost
// of running it is < 1% of the Sonnet turn cost, so we just always run.
//
// Never throws. On Haiku failure we degrade-open (allow the reply) and
// log to error_logs — Haiku being down is a worse outcome than
// occasionally letting a borderline reply through.

import Anthropic from "https://esm.sh/@anthropic-ai/sdk@0.88.0";

/** Exported so callers can record the judge step in Langfuse under the
 *  exact model id used here, without duplicating the string. */
export const JUDGE_MODEL = "claude-haiku-4-5";
const MAX_TOKENS = 256;

const JUDGE_SYSTEM = `You are a precise safety auditor for an Israeli WhatsApp lead-handling bot at a marketing college. The bot operates under Israeli consumer-protection law — your job is to block ONLY the things that would actually create legal exposure, not to be overcautious.

BLOCK (ok=false) — these are illegal or harmful:
1. "price_leak" — concrete prices/costs of the program in any currency (₪/$/€/£) or bare numbers + "אלף/אלפים/K" tied to cost/investment.
2. "income_promise" — SPECIFIC income amounts associated with predicted earnings. Examples that BLOCK: "תרוויח 5000 שקל בחודש", "X בחודש", "מובטח להחזיר השקעה", "ערבות", "בטוח שתרוויח Y".
3. "invented_fact" — fabricates advisor names, program durations, success-rate percentages, or specific student outcomes.
   DO NOT judge meeting dates/times. You cannot see the booking system, so you have no way to know
   whether a stated time is real — and a deterministic guard upstream has ALREADY verified every
   HH:MM in this reply against the actual slots the booking system returned. A reply that reaches
   you has passed that check. Flagging a time here only blocks a legitimate, grounded offer.
4. "off_topic" — clearly unrelated to the lead's question (rare).

ALLOW (ok=true, reason="clean") — these are LEGITIMATE and must NOT be blocked:
A. "אני לא יכול להבטיח לך סכום מדויק" — refusing to promise a specific amount IS the legal stance, this is fine.
B. "אני יכול להבטיח שאם תעשה את הצעדים אין סיבה שלא תצליח" — conditional success language without a sum is FINE. The "if you do X" framing is legally safe.
C. "כל בן אדם שונה, זה תלוי בהשקעה שלך" — abstract talk about effort and outcomes is FINE.
D. "סיכויי ההצלחה שלך גדולים" — abstract probability without a number is FINE.
E. "אני יודע שזה נשמע משוגע" — empathy / acknowledgment is FINE.
F. Deflection to the advisor on Zoom — always FINE.
G. Stating specific meeting dates/times ("יום א׳ 30.08 בשעה 11:00"), confirming a booking, or
   saying the calendar has no availability and an advisor will make contact — ALWAYS FINE. These
   are grounded in the booking system and verified upstream. Never block them.
H. Saying it is a digital agent / a bot / not a human. The college's policy is TRANSPARENCY:
   when a lead asks, the bot says so openly. This is never a violation.
I. Noticing that the lead's message looks like an automatic reply ("נראה שקיבלתי הודעה
   אוטומטית"). That describes the LEAD's phone, not the bot.
J. Talking about AI as a subject — the courses teach AI tools, so "להשתמש ב-AI כדי..." is the
   product, not a disclosure.
K. Repeating a number THE LEAD wrote (their salary, pension, debt, the gap they want to close,
   their own income goal — see "Lead's message" below). Reflecting the lead's own words back is
   empathy, not a price and not a promise. Block only a NEW number the bot introduces as a price
   or as what the lead WILL earn.

THE KEY RULE: a CONCRETE NUMBER tied to predicted income is illegal. Abstract conditional/possibility/effort language is legal. The verb "להבטיח" alone is NOT a problem; it only becomes one when it attaches to a specific amount.

Output ONLY a JSON object: {"ok": boolean, "reason": "short_code"}
Reason codes when ok=false: "price_leak" | "income_promise" | "invented_fact" | "off_topic"
When ok=true: reason must be exactly "clean".

Be precise. Over-blocking legitimate nuanced replies costs leads. Under-blocking concrete promises costs the company in court.`;

interface JudgeVerdict {
  ok: boolean;
  reason: string;
  /** Token usage so the caller can record cost. */
  tokensInput: number;
  tokensOutput: number;
}

interface AnthropicTextBlock {
  type: "text";
  text: string;
}
interface AnthropicResponseShape {
  content: ReadonlyArray<AnthropicTextBlock | { type: string }>;
  usage?: { input_tokens?: number; output_tokens?: number };
}

function firstTextBlock(r: AnthropicResponseShape): string {
  const b = r.content.find((x) => x.type === "text");
  if (!b || !("text" in b) || typeof b.text !== "string") return "";
  return b.text;
}

/**
 * Call Haiku to judge the reply. Returns ok=true on any failure (degrade
 * open) — Haiku being down should not block legitimate outbound traffic.
 * The caller's `onError` is the place to log degraded operation.
 */
/** Reason codes the policy no longer blocks. Haiku can still emit one from
 *  habit; treating it as clean keeps a stale verdict from silencing a lead. */
const RETIRED_REASONS: ReadonlySet<string> = new Set(["ai_disclosure"]);

/** Max chars of the lead's message given to the judge as context. */
const LEAD_CONTEXT_MAX = 1500;

/**
 * The judge's user turn. The lead's message is context only — without it the
 * judge cannot tell "the 8,000 you said you need" (the lead's number) from
 * "you will make 8,000" (a promise), and blocked the former.
 */
export function buildJudgeUserContent(replyText: string, leadMessage?: string | null): string {
  const lead = (leadMessage ?? "").trim();
  if (!lead) return `Reply to audit:\n\n${replyText}`;
  return (
    `Lead's message (context only — do NOT audit it):\n\n${lead.slice(-LEAD_CONTEXT_MAX)}\n\n` +
    `Reply to audit:\n\n${replyText}`
  );
}

export async function judgeReply(
  anthropic: Anthropic,
  replyText: string,
  onError?: (msg: string) => Promise<void> | void,
  leadMessage?: string | null,
): Promise<JudgeVerdict> {
  const fallback: JudgeVerdict = { ok: true, reason: "judge_unavailable", tokensInput: 0, tokensOutput: 0 };
  try {
    // JSON-mode via assistant prefill: feed "{" so Haiku continues a JSON
    // object. Most reliable shape on Anthropic without OpenAI-style
    // response_format.
    // deno-lint-ignore no-explicit-any
    const raw = await anthropic.messages.create({
      model: JUDGE_MODEL,
      max_tokens: MAX_TOKENS,
      system: JUDGE_SYSTEM,
      messages: [
        { role: "user", content: buildJudgeUserContent(replyText, leadMessage) },
        { role: "assistant", content: "{" },
      ],
    } as any);
    const response = raw as unknown as AnthropicResponseShape;
    const raw_text = "{" + firstTextBlock(response);
    // Clip to the last brace for robustness.
    const close = raw_text.lastIndexOf("}");
    const candidate = close === -1 ? raw_text : raw_text.slice(0, close + 1);
    let parsed: unknown;
    try {
      parsed = JSON.parse(candidate);
    } catch {
      if (onError) await onError(`judge: invalid JSON (${candidate.slice(0, 100)})`);
      return fallback;
    }
    if (!parsed || typeof parsed !== "object") return fallback;
    const o = parsed as Record<string, unknown>;
    const reason = typeof o.reason === "string" ? o.reason : "no_reason";
    const ok = o.ok === true || RETIRED_REASONS.has(reason);
    return {
      ok,
      reason,
      tokensInput: response.usage?.input_tokens ?? 0,
      tokensOutput: response.usage?.output_tokens ?? 0,
    };
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    if (onError) await onError(`judge: api error — ${msg}`);
    return fallback;
  }
}
