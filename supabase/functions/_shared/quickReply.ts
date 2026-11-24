// quickReply.ts
//
// Quick-reply buttons on broadcast templates ("pre-message" flow: the template
// asks "לשלוח לכם את הלינק?" with two buttons, and the tap decides what
// happens next).
//
// Meta delivers a tap in one of two shapes, neither of which has `text.body`:
//   - template quick-reply button → { type: "button", button: { text, payload } }
//   - interactive reply button    → { type: "interactive", interactive:
//       { type: "button_reply", button_reply: { id, title } } }
// Before this module both landed as an EMPTY text message: no agent reply, no
// opt-out, the lead who tapped "send me the link" heard nothing back.
//
// Pure — no Supabase / Deno imports — so it runs under vitest. The handler
// owns the DB lookups and sends (broadcastButtonAction.ts).

/** What a button tap carries once normalised. */
export interface InboundButtonReply {
  /** The label the lead tapped — also stored as the inbound message content. */
  text: string;
  /** Developer payload (template button) or reply id (interactive). Meta
   *  defaults a template button's payload to its label when none was set. */
  payload: string | null;
}

/** The slice of a Meta inbound message this module reads. */
export interface MetaButtonFields {
  type?: string;
  button?: { text?: string; payload?: string };
  interactive?: {
    type?: string;
    button_reply?: { id?: string; title?: string };
    list_reply?: { id?: string; title?: string; description?: string };
  };
}

/**
 * The tap carried by a Meta message, or null when it is not a button reply
 * (or carries no usable label/payload).
 */
export function parseButtonReply(message: MetaButtonFields): InboundButtonReply | null {
  if (message.type === "button" && message.button) {
    const text = (message.button.text ?? "").trim();
    const payload = (message.button.payload ?? "").trim() || null;
    if (!text && !payload) return null;
    return { text: text || payload || "", payload };
  }
  if (message.type === "interactive" && message.interactive) {
    const reply = message.interactive.button_reply ?? message.interactive.list_reply;
    if (!reply) return null;
    const text = (reply.title ?? "").trim();
    const payload = (reply.id ?? "").trim() || null;
    if (!text && !payload) return null;
    return { text: text || payload || "", payload };
  }
  return null;
}

/** One configured button on a template. */
export interface ButtonActionConfig {
  /** Labels and/or payloads that select this action (compared normalised). */
  match: string[];
  /** Fixed free-text reply sent to the lead. Never model output. */
  reply: string;
  /** True → this button is a removal request: opt the lead out. */
  optout: boolean;
}

/** broadcast_templates.button_actions, validated. Keyed by action name
 *  ("yes", "stop", ...); the name is only a label for logs. */
export type ButtonActions = Record<string, ButtonActionConfig>;

/** Cap so a pasted essay can't become a WhatsApp message. Meta's text limit is
 *  4096; stay well under it. */
export const MAX_BUTTON_REPLY_CHARS = 2_000;

/**
 * Validate the raw jsonb column. Invalid entries are dropped (not thrown) so
 * one bad button never disables the others; `errors` says what was dropped so
 * the admin UI and the logs can surface it.
 */
export function parseButtonActions(raw: unknown): { actions: ButtonActions; errors: string[] } {
  const actions: ButtonActions = {};
  const errors: string[] = [];
  if (raw === null || raw === undefined) return { actions, errors };
  if (typeof raw !== "object" || Array.isArray(raw)) {
    return { actions, errors: ["button_actions must be a JSON object"] };
  }
  for (const [key, value] of Object.entries(raw as Record<string, unknown>)) {
    if (!value || typeof value !== "object" || Array.isArray(value)) {
      errors.push(`${key}: must be an object`);
      continue;
    }
    const v = value as Record<string, unknown>;
    const matchRaw = typeof v.match === "string" ? [v.match] : v.match;
    const match = Array.isArray(matchRaw)
      ? matchRaw.filter((m): m is string => typeof m === "string" && normalizeButtonText(m) !== "")
      : [];
    if (match.length === 0) {
      errors.push(`${key}: "match" needs at least one non-empty string`);
      continue;
    }
    const reply = typeof v.reply === "string" ? v.reply.trim() : "";
    if (!reply) {
      errors.push(`${key}: "reply" must be a non-empty string`);
      continue;
    }
    if (reply.length > MAX_BUTTON_REPLY_CHARS) {
      errors.push(`${key}: "reply" is longer than ${MAX_BUTTON_REPLY_CHARS} chars`);
      continue;
    }
    if (v.optout !== undefined && typeof v.optout !== "boolean") {
      errors.push(`${key}: "optout" must be true/false`);
      continue;
    }
    actions[key] = { match, reply, optout: v.optout === true };
  }
  return { actions, errors };
}

/**
 * Comparison form of a label/payload: Unicode NFC, invisible direction marks
 * and zero-width characters removed, whitespace collapsed, Latin lowercased,
 * trailing punctuation dropped. A Hebrew label typed in the admin UI and the
 * same label echoed back by WhatsApp must compare equal.
 */
export function normalizeButtonText(s: string): string {
  return s
    .normalize("NFC")
    .replace(/[​-‏‪-‮⁦-⁩﻿]/g, "")
    .replace(/\s+/g, " ")
    .trim()
    .toLowerCase()
    .replace(/[.!?…]+$/u, "")
    .trim();
}

/** The action a tap selects: payload first (stable even if the label is
 *  reworded), then the label. Null → not configured; the caller falls back to
 *  the agent. */
export function matchButtonAction(
  actions: ButtonActions,
  reply: InboundButtonReply,
): { name: string; action: ButtonActionConfig } | null {
  const candidates = [reply.payload, reply.text]
    .filter((c): c is string => !!c)
    .map(normalizeButtonText)
    .filter((c) => c !== "");
  for (const candidate of candidates) {
    for (const [name, action] of Object.entries(actions)) {
      if (action.match.some((m) => normalizeButtonText(m) === candidate)) {
        return { name, action };
      }
    }
  }
  return null;
}
