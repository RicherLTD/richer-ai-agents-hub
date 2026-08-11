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

export interface StatusRule {
  status_label: string;
  objection_key: string;
  warming_instructions: string;
  delay_hours: number;
  cooldown_days: number;
  clears_zoom_state: boolean;
}

/** Applied when a status arrives with no matching crm_status_rules row. The
 *  caller already filtered to warming-relevant statuses, so whatever reached us
 *  is worth warming — on generic instructions, until an operator tunes it. */
export const DEFAULT_RULE: StatusRule = {
  status_label: "סטטוס לא מוגדר",
  objection_key: "unknown",
  warming_instructions:
    "נציג עדכן את סטטוס הליד ב-CRM, אך אין הנחיה מוגדרת לסטטוס הזה. אין לך מידע על ההתנגדות. פתח שיחה קלילה, גלה בעצמך תוך כדי הדיאלוג מה עומד מאחורי החשש, ורק אז הובל לתיאום זום.",
  delay_hours: 0,
  cooldown_days: 7,
  clears_zoom_state: false,
};

export interface RawRuleRow {
  status_label?: string | null;
  objection_key?: string | null;
  warming_instructions?: string | null;
  delay_hours?: number | null;
  cooldown_days?: number | null;
  clears_zoom_state?: boolean | null;
  is_active?: boolean | null;
}

export interface ResolvedRule {
  rule: StatusRule;
  /** A row exists for this status, whether or not it is active. */
  matched: boolean;
  /** An operator switched this status off. Record it, message nobody. */
  disabled: boolean;
}

/**
 * Decide what a status row means. Extracted and tested because it is a safety
 * switch, and it was wrong once already.
 *
 * The bug worth remembering: the query used to filter `is_active = true`, which
 * made a switched-off rule return no row — indistinguishable from a status we
 * have never heard of, which falls through to DEFAULT_RULE and warms
 * IMMEDIATELY. So the dashboard's "active" toggle, switched OFF, caused *more*
 * messaging on generic instructions. The fix is to fetch the row regardless and
 * branch here.
 */
export function resolveStatusRule(row: RawRuleRow | null | undefined): ResolvedRule {
  if (!row) return { rule: { ...DEFAULT_RULE }, matched: false, disabled: false };
  if (row.is_active === false) {
    return { rule: { ...DEFAULT_RULE }, matched: true, disabled: true };
  }
  return {
    rule: {
      status_label: row.status_label ?? DEFAULT_RULE.status_label,
      objection_key: row.objection_key ?? DEFAULT_RULE.objection_key,
      warming_instructions: row.warming_instructions ?? DEFAULT_RULE.warming_instructions,
      delay_hours: row.delay_hours ?? 0,
      cooldown_days: row.cooldown_days ?? 7,
      clears_zoom_state: row.clears_zoom_state ?? false,
    },
    matched: true,
    disabled: false,
  };
}
