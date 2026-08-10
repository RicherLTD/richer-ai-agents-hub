// crm-status-webhook/validate.ts
//
// Pure payload coercion + the cooldown predicate, split out of index.ts so
// they can be tested without a Deno.serve side effect (same shape as
// conversation-set-mode/validate.ts).
//
// These are the parts most likely to break silently: Make hand-builds this
// payload, so a field arriving as "60" instead of 60, or a phone in a format
// we don't canonicalise, is a realistic Tuesday — and the failure mode is a
// lead who is quietly never warmed.

import { toCanonicalPhone } from "../_shared/normalizePhone.ts";

export interface CrmStatusPayload {
  product: string;
  lead_phone: string;
  status_sub: number;
  status_main: number | null;
  lead_name: string | null;
  rep_note: string | null;
  fireberry_lead_id: string | null;
}

export function asTrimmedString(v: unknown): string | null {
  if (typeof v !== "string") return null;
  const t = v.trim();
  return t.length === 0 ? null : t;
}

/** Make sends numbers as strings often enough that accepting both is worth the
 *  four lines. Rejects anything that isn't a whole, finite number. */
export function asInt(v: unknown): number | null {
  if (typeof v === "number") return Number.isInteger(v) ? v : null;
  if (typeof v === "string") {
    const t = v.trim();
    if (!/^-?\d+$/.test(t)) return null;
    return Number.parseInt(t, 10);
  }
  return null;
}

export function coercePayload(raw: unknown): CrmStatusPayload | null {
  if (!raw || typeof raw !== "object") return null;
  const o = raw as Record<string, unknown>;
  const product = asTrimmedString(o.product);
  const leadPhoneRaw = asTrimmedString(o.lead_phone);
  const statusSub = asInt(o.status_sub);
  if (!product || !leadPhoneRaw || statusSub === null) return null;
  // Canonical form everywhere — migration 0035 normalised history but nothing
  // enforces it at the DB level, so every writer must do this itself.
  const leadPhone = toCanonicalPhone(leadPhoneRaw);
  if (!leadPhone) return null;
  return {
    product,
    lead_phone: leadPhone,
    status_sub: statusSub,
    status_main: asInt(o.status_main),
    lead_name: asTrimmedString(o.lead_name),
    rep_note: asTrimmedString(o.rep_note),
    fireberry_lead_id: asTrimmedString(o.fireberry_lead_id),
  };
}

/**
 * True while a new opener must not be queued for this lead.
 *
 * Reads crm_last_warmed_at, which is stamped at QUEUE time — so a burst of
 * status changes can't stack several openers before any of them has gone out.
 */
export function withinCooldown(
  lastWarmedAt: string | null,
  cooldownDays: number,
  now: number = Date.now(),
): boolean {
  if (!lastWarmedAt || cooldownDays <= 0) return false;
  const last = new Date(lastWarmedAt);
  if (Number.isNaN(last.getTime())) return false;
  return now - last.getTime() < cooldownDays * 24 * 60 * 60 * 1000;
}
