// judgeReply.ts
//
// LLM-as-judge: a cheap Haiku 4.5 call that scores a Sonnet-generated
// reply against our hard safety rules BEFORE we send it to a lead.
//
// Why: validateAgentReply.ts is regex-based. It catches the obvious
// jailbreak phrasings (prices with ₪, "מובטח", AI self-disclosure)
// but a smart model can leak the same content semantically:
//   - "ההשקעה בסדר גודל של 5 אלף"   (numeric without ₪)
//   - "אני המערכת האוטומטית שלכם"   (AI disclosure without "אני AI")
//   - "תרוויח בערך 3-5 אלף בחודש"   (income promise without "מובטח")
//
// Haiku is fast (~500ms) and cheap (~$0.0003 per call). Per-turn cost
// of running it is < 1% of the Sonnet turn cost, so we just always run.
//
// Never throws. On Haiku failure we degrade-open (allow the reply) and
// log to error_logs — Haiku being down is a worse outcome than
// occasionally letting a borderline reply through.

import Anthropic from "https://esm.sh/@anthropic-ai/sdk@0.88.0";

const JUDGE_MODEL = "claude-haiku-4-5";
const MAX_TOKENS = 256;

const JUDGE_SYSTEM = `You are a precise safety auditor for an Israeli WhatsApp lead-handling bot at a marketing college. The bot operates under Israeli consumer-protection law — your job is to block ONLY the things that would actually create legal exposure, not to be overcautious.

BLOCK (ok=false) — these are illegal or harmful:
1. "price_leak" — concrete prices/costs of the program in any currency (₪/$/€/£) or bare numbers + "אלף/אלפים/K" tied to cost/investment.
2. "income_promise" — SPECIFIC income amounts associated with predicted earnings. Examples that BLOCK: "תרוויח 5000 שקל בחודש", "X בחודש", "מובטח להחזיר השקעה", "ערבות", "בטוח שתרוויח Y".
3. "ai_disclosure" — admits being an AI, bot, language model, or automated system.
4. "invented_fact" — fabricates advisor names, scheduled times, program durations, success-rate percentages, or specific student outcomes.
5. "off_topic" — clearly unrelated to the lead's question (rare).

ALLOW (ok=true, reason="clean") — these are LEGITIMATE and must NOT be blocked:
A. "אני לא יכול להבטיח לך סכום מדויק" — refusing to promise a specific amount IS the legal stance, this is fine.
B. "אני יכול להבטיח שאם תעשה את הצעדים אין סיבה שלא תצליח" — conditional success language without a sum is FINE. The "if you do X" framing is legally safe.
C. "כל בן אדם שונה, זה תלוי בהשקעה שלך" — abstract talk about effort and outcomes is FINE.
D. "סיכויי ההצלחה שלך גדולים" — abstract probability without a number is FINE.
E. "אני יודע שזה נשמע משוגע" — empathy / acknowledgment is FINE.
F. Deflection to the advisor on Zoom — always FINE.

THE KEY RULE: a CONCRETE NUMBER tied to predicted income is illegal. Abstract conditional/possibility/effort language is legal. The verb "להבטיח" alone is NOT a problem; it only becomes one when it attaches to a specific amount.

Output ONLY a JSON object: {"ok": boolean, "reason": "short_code"}
Reason codes when ok=false: "price_leak" | "income_promise" | "ai_disclosure" | "invented_fact" | "off_topic"
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
export async function judgeReply(
  anthropic: Anthropic,
  replyText: string,
  onError?: (msg: string) => Promise<void> | void,
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
        { role: "user", content: `Reply to audit:\n\n${replyText}` },
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
    const ok = o.ok === true;
    const reason = typeof o.reason === "string" ? o.reason : "no_reason";
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
