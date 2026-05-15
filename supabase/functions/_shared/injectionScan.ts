// injectionScan.ts
//
// First-line defense against indirect prompt injection in operator-
// uploaded brain content (PDFs, images via OCR, paste-from-elsewhere
// notes). After Claude extracts the plain text of a document we run
// this scan on the result. If it trips a pattern we reject the
// upload and surface a clear error to the operator.
//
// This is intentionally regex-based, not LLM-classifier-based:
//   1. It's deterministic — same input → same result, auditable.
//   2. It runs in <1ms, no extra API call per upload.
//   3. Bypasses are easy in theory but most attackers don't bother
//      with sophisticated obfuscation; the boilerplate phrases are
//      what 90% of public jailbreak corpora use.
//
// The system-prompt safety wrapper (<untrusted_evidence> in
// brainContext.ts) is the *real* defense — this scanner just rejects
// the most obvious garbage at the door so an operator gets immediate
// feedback rather than a silently-poisoned brain row.
//
// To extend: add new patterns to INJECTION_PATTERNS below. Keep
// patterns case-insensitive (i flag) and use the simplest expression
// that still matches the family — false positives cost the operator
// a re-upload, not a silent bot compromise.

export interface InjectionMatch {
  /** Stable code for the rule that fired — used by the UI to render
   *  a friendly error message and by tests to assert behaviour. */
  reason: string;
  /** Short text excerpt around the match (~60 chars) so the operator
   *  can see WHAT triggered the rejection. */
  excerpt: string;
}

interface InjectionRule {
  reason: string;
  pattern: RegExp;
}

const INJECTION_RULES: ReadonlyArray<InjectionRule> = [
  // "ignore previous instructions" and variants. Allow 0-3 connector
  // words between the verb and the noun ("the", "all", "prior", "your",
  // "earlier" etc) so we catch "forget the previous prompts",
  // "override your earlier rules", "disregard all prior directives", etc.
  {
    reason: "ignore_previous_instructions",
    pattern: /\b(ignore|disregard|forget|override)\s+(?:[a-z]+\s+){0,3}(instructions?|rules?|directives?|prompts?|guidelines?)\b/i,
  },
  // Hebrew equivalent. Verb + lazy gap (up to 40 chars, no sentence-
  // terminating punctuation) + target noun. The gap absorbs Hebrew
  // proclitic prefixes ("מה", "את", "כל ה־") so we catch all natural
  // phrasings without enumerating them. No \b: Hebrew letters aren't
  // word chars under JS regex semantics.
  {
    reason: "ignore_previous_instructions_he",
    pattern: /(התעלם|תתעלם|שכח|התעלמ[יו])[^.!?\n]{1,40}?(הוראות|חוקים|פרומפט|הנחיות)/,
  },
  // "you are now in X mode" — role hijack.
  {
    reason: "role_hijack_en",
    pattern: /\byou\s+are\s+(now\s+)?(in\s+)?(admin|developer|debug|jailbreak|DAN|godmode)\s+mode\b/i,
  },
  // Hebrew role hijack.
  {
    reason: "role_hijack_he",
    pattern: /אתה\s+(עכשיו\s+)?ב?מצב\s+(אדמין|מפתח|דיבאג|debug|jailbreak)/,
  },
  // Common chat-template tokens used by various models — should never
  // appear in legitimate operator content.
  {
    reason: "chat_template_token",
    pattern: /<\|im_start\|>|<\|im_end\|>|<\|system\|>|<\|assistant\|>|<\|user\|>|\[INST\]|\[\/INST\]|<<SYS>>/,
  },
  // Inline system-role injection.
  {
    reason: "fake_system_role",
    pattern: /^\s*(system|admin|root)\s*:\s*(you\s+are|act\s+as|pretend|forget|ignore)/im,
  },
  // "act as / pretend to be" + permissive identity. Catches "act as an
  // AI without restrictions" / "pretend you have no rules".
  {
    reason: "act_as_unrestricted",
    pattern: /\b(act\s+as|pretend\s+to\s+be|roleplay\s+as)\b[^.\n]{0,80}\b(no\s+(rules?|restrictions?|limits?)|unrestricted|without\s+(rules?|restrictions?|limits?)|uncensored)\b/i,
  },
  // Direct jailbreak phrases.
  {
    reason: "explicit_jailbreak",
    pattern: /\b(jailbreak|DAN\s+mode|do\s+anything\s+now)\b/i,
  },
];

const EXCERPT_RADIUS = 30;

function makeExcerpt(text: string, matchIndex: number, matchLen: number): string {
  const start = Math.max(0, matchIndex - EXCERPT_RADIUS);
  const end = Math.min(text.length, matchIndex + matchLen + EXCERPT_RADIUS);
  const prefix = start > 0 ? "…" : "";
  const suffix = end < text.length ? "…" : "";
  return prefix + text.slice(start, end).replace(/\s+/g, " ").trim() + suffix;
}

/**
 * Run the rule set against `text` and return the first matching rule,
 * or null if the text passes. Intentionally first-match-wins: showing
 * the operator one specific failure is more actionable than a list.
 */
export function detectPromptInjection(text: string | null | undefined): InjectionMatch | null {
  if (!text || text.length === 0) return null;
  for (const rule of INJECTION_RULES) {
    const m = rule.pattern.exec(text);
    if (m) {
      return {
        reason: rule.reason,
        excerpt: makeExcerpt(text, m.index, m[0].length),
      };
    }
  }
  return null;
}
