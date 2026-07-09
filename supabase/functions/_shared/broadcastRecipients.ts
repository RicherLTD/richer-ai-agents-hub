import { toCanonicalPhone } from "./normalizePhone.ts";

export interface RawRecipient {
  phone: string;
  name?: string | null;
  variables?: string[] | null;
  /** conversation id if this recipient came from an existing lead */
  conversationId?: string | null;
}

export type SuppressionReason = "opt_out" | "blocking_tag" | "duplicate" | "invalid_phone";

export interface ResolvedRecipient {
  phone: string; // canonical (972…)
  name: string | null;
  variables: string[] | null;
  conversationId: string | null;
}

export interface RecipientSet {
  toSend: ResolvedRecipient[];
  suppressedCount: number;
  breakdown: Record<SuppressionReason, number>;
}

export interface BuildRecipientArgs {
  recipients: RawRecipient[];
  /** canonical phones present in opt_outs */
  optedOutPhones: Set<string>;
  /** canonical phones whose existing conversation carries a blocking tag/status */
  blockedPhones: Set<string>;
}

/**
 * Pure: turns raw recipients into the final send list. Order of suppression per
 * phone: invalid → duplicate → opt-out → blocking-tag. opt-out is the critical
 * gate — a phone in `optedOutPhones` is NEVER included, even from CSV.
 */
export function buildRecipientSet(args: BuildRecipientArgs): RecipientSet {
  const breakdown: Record<SuppressionReason, number> = {
    opt_out: 0,
    blocking_tag: 0,
    duplicate: 0,
    invalid_phone: 0,
  };
  const seen = new Set<string>();
  const toSend: ResolvedRecipient[] = [];

  for (const r of args.recipients) {
    const canonical = toCanonicalPhone(r.phone ?? "");
    if (!canonical) {
      breakdown.invalid_phone++;
      continue;
    }
    if (seen.has(canonical)) {
      breakdown.duplicate++;
      continue;
    }
    seen.add(canonical);
    if (args.optedOutPhones.has(canonical)) {
      breakdown.opt_out++;
      continue;
    }
    if (args.blockedPhones.has(canonical)) {
      breakdown.blocking_tag++;
      continue;
    }
    toSend.push({
      phone: canonical,
      name: (r.name ?? null) || null,
      variables: r.variables && r.variables.length > 0 ? r.variables : null,
      conversationId: r.conversationId ?? null,
    });
  }

  const suppressedCount =
    breakdown.opt_out + breakdown.blocking_tag + breakdown.duplicate + breakdown.invalid_phone;
  return { toSend, suppressedCount, breakdown };
}
