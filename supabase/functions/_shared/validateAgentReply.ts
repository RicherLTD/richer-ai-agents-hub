// validateAgentReply.ts
//
// Lightweight sanity check on Claude's reply before we send it to a lead.
// Phase A scope: catch the obvious junk (empty, absurd length, placeholder
// tokens). Phase C will add hallucination guards (forbidden words like
// prices, AI self-disclosure, etc.) once the memory extractor is in.
//
// Hebrew note: `.toUpperCase()` only transforms ASCII characters — Hebrew
// glyphs have no casing, so the upper-casing before regex match cannot
// false-positive on legitimate Hebrew lead replies. The placeholder
// regex matches ASCII-only token shapes that should never appear inside
// production agent output (square-bracket, double-brace, and HTML-style
// template leaks from prompt rendering bugs).

export type ValidationResult =
  | { ok: true; text: string }
  | { ok: false; reason: string };

const MIN_REPLY_CHARS = 2;
// WhatsApp's hard limit on a single text message body is 4096 characters.
// We cap at 1500 because our prompt explicitly asks for 1-3 short sentences;
// anything past 1500 means the model broke the instruction and the reply is
// almost certainly off-policy, not a useful long answer.
const MAX_REPLY_CHARS = 1500;

const PLACEHOLDER_RE = /\[MISSING\]|\[UNKNOWN\]|\[TODO\]|\[PLACEHOLDER\]|\{\{[^}]+\}\}|<[A-Z_]+>/;

export function validateAgentReply(raw: string | null | undefined): ValidationResult {
  if (raw == null) {
    return { ok: false, reason: "reply_is_null" };
  }
  const text = raw.trim();
  if (text.length < MIN_REPLY_CHARS) {
    return { ok: false, reason: "reply_too_short" };
  }
  if (text.length > MAX_REPLY_CHARS) {
    return { ok: false, reason: "reply_too_long" };
  }
  if (PLACEHOLDER_RE.test(text.toUpperCase())) {
    return { ok: false, reason: "reply_contains_placeholder" };
  }
  return { ok: true, text };
}
