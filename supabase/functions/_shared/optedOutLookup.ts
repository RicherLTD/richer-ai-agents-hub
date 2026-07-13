import { type SupabaseClient } from "https://esm.sh/@supabase/supabase-js@2.45.4";
import { toCanonicalPhone } from "./normalizePhone.ts";

/**
 * All stored-format variants of a canonical `972XXXXXXXX(X)` phone that
 * `toCanonicalPhone` accepts: canonical, `+972…`, and Israeli local `0…`.
 * `opt_outs` is populated from multiple places (webhook auto-opt-out writes
 * canonical, but rows may also be inserted manually in another format), so the
 * lookup must match any of them — an exact-canonical `.in()` alone would
 * silently miss an opted-out lead, the one failure we must never have.
 */
export function optOutPhoneVariants(canonical: string): string[] {
  const local = `0${canonical.slice(3)}`;
  return [canonical, `+${canonical}`, local];
}

/**
 * Returns the subset of `canonicalPhones` that appear in `opt_outs`, in
 * canonical form, tolerant of the stored format. Chunked so the `.in()` list
 * stays bounded on large broadcasts. Fails open to an empty set only on a
 * thrown query — callers treat "not opted out" as sendable, so a hard DB error
 * must be surfaced by the caller, not swallowed here.
 */
export async function fetchOptedOutSet(
  admin: SupabaseClient,
  canonicalPhones: string[],
  chunkSize = 300,
): Promise<Set<string>> {
  const out = new Set<string>();
  if (canonicalPhones.length === 0) return out;
  for (let i = 0; i < canonicalPhones.length; i += chunkSize) {
    const chunk = canonicalPhones.slice(i, i + chunkSize);
    const variants = chunk.flatMap(optOutPhoneVariants);
    const { data } = await admin.from("opt_outs").select("lead_phone").in("lead_phone", variants);
    for (const row of (data ?? []) as Array<{ lead_phone: string }>) {
      const c = toCanonicalPhone(row.lead_phone);
      if (c) out.add(c);
    }
  }
  return out;
}
