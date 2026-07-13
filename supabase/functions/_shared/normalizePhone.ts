/**
 * Canonical phone format for this system: digits only, no '+', including the
 * 972 country code — exactly what Meta delivers inbound as `message.from`
 * (see whatsapp-webhook). Every phone written to `conversations.lead_phone`
 * and `scheduled_messages.lead_phone` MUST go through here so a lead keeps a
 * SINGLE conversation row under UNIQUE(agent_id, lead_phone), instead of being
 * split across `+972…` (landing-page / lead-register) and `972…` (inbound
 * webhook) duplicates.
 *
 * Accepts the formats we actually receive: `+972XXXXXXXX(X)` (E.164),
 * `972XXXXXXXX(X)` (no plus), `0XXXXXXXX(X)` (Israeli local). Returns null for
 * anything else — the caller decides how to reject.
 */
export function toCanonicalPhone(raw: string): string | null {
  const t = (raw ?? "").trim().replace(/[\s\-()]/g, "");
  if (/^\+972\d{8,9}$/.test(t)) return t.slice(1);
  if (/^972\d{8,9}$/.test(t)) return t;
  if (/^0\d{8,9}$/.test(t)) return `972${t.slice(1)}`;
  return null;
}
