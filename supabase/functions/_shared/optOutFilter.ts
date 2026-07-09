/**
 * Pure: splits claimed dispatcher rows into those safe to send and those whose
 * lead has opted out (canonical phone present in `optedOutCanonical`). Rows with
 * an unparseable phone are kept (no match possible) — the send path handles them
 * as it does today.
 */
export function partitionOptedOut<T extends { lead_phone: string }>(
  rows: T[],
  optedOutCanonical: Set<string>,
  toCanonical: (p: string) => string | null,
): { keep: T[]; cancel: T[] } {
  const keep: T[] = [];
  const cancel: T[] = [];
  for (const r of rows) {
    const c = toCanonical(r.lead_phone);
    if (c && optedOutCanonical.has(c)) cancel.push(r);
    else keep.push(r);
  }
  return { keep, cancel };
}
