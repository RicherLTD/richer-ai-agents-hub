/**
 * Meta "payment issue" refusals (error 131042) — the one refusal that is about
 * the WhatsApp Business account, not the lead.
 *
 * When the account's billing breaks, Meta accepts every template send and then
 * refuses it a second later through the status webhook. Nothing reaches anyone
 * until someone fixes the payment method in Meta Business Manager, and on the
 * dashboard it only looks like "sent, not delivered". Past outages on this
 * project stopped deliveries to zero for days and recovered the moment billing
 * was fixed — so "a delivery after the last refusal" is the recovery signal.
 *
 * The refusal is stored on the send row by the webhook handler
 * (scheduled_messages.meta_failed_at / meta_error_code, migration 0053).
 * scheduled_messages is admin-read only, so callers should only query this
 * for admins — a non-admin gets zero rows, never a false alarm.
 */
import { supabase } from "./supabase/client";

export const META_PAYMENT_ISSUE_CODE = 131042;

/** How far back to look for payment refusals. */
export const BILLING_LOOKBACK_HOURS = 48;

/**
 * Refusals needed before the banner shows. One or two stray 131042s have
 * happened without an outage (Jul 2026: 2, nothing followed); a real outage
 * refuses 40–70 sends a day, so 3 still fires within minutes of it starting.
 */
export const BILLING_MIN_REFUSALS = 3;

export interface BillingSignal {
  /** Payment-issue refusals in the lookback window. */
  refusals: number;
  /** Most recent payment-issue refusal in the window (ISO), or null. */
  lastRefusalAt: string | null;
  /** Most recent delivered template send for the agent (ISO), or null. */
  lastDeliveredAt: string | null;
}

/**
 *   none       nothing to show
 *   active     Meta is (still) refusing sends for billing — fix it now
 *   recovered  there were refusals, but a send was delivered after the last
 *              one, so billing was most likely fixed
 */
export type BillingWarning = "none" | "active" | "recovered";

export function billingWarningState(signal: BillingSignal): BillingWarning {
  if (signal.refusals < BILLING_MIN_REFUSALS || !signal.lastRefusalAt) return "none";
  const refusedAt = Date.parse(signal.lastRefusalAt);
  const deliveredAt = signal.lastDeliveredAt ? Date.parse(signal.lastDeliveredAt) : Number.NaN;
  // NaN compares false, so a missing or unparsable delivery keeps it "active".
  return deliveredAt > refusedAt ? "recovered" : "active";
}

export async function getBillingSignal(
  agentId: string,
  now: Date = new Date(),
): Promise<BillingSignal> {
  const since = new Date(now.getTime() - BILLING_LOOKBACK_HOURS * 3_600_000).toISOString();

  const [refusals, delivered] = await Promise.all([
    supabase
      .from("scheduled_messages")
      .select("meta_failed_at", { count: "exact" })
      .eq("agent_id", agentId)
      .eq("meta_error_code", META_PAYMENT_ISSUE_CODE)
      .gte("meta_failed_at", since)
      .order("meta_failed_at", { ascending: false })
      .limit(1),
    supabase
      .from("scheduled_messages")
      .select("delivered_at")
      .eq("agent_id", agentId)
      .not("delivered_at", "is", null)
      .order("delivered_at", { ascending: false })
      .limit(1),
  ]);

  if (refusals.error) {
    throw new Error(`Failed to load payment refusals: ${refusals.error.message}`);
  }
  if (delivered.error) {
    throw new Error(`Failed to load last delivery: ${delivered.error.message}`);
  }

  return {
    refusals: refusals.count ?? 0,
    lastRefusalAt: refusals.data?.[0]?.meta_failed_at ?? null,
    lastDeliveredAt: delivered.data?.[0]?.delivered_at ?? null,
  };
}
