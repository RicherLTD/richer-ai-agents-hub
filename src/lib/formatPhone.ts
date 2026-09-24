/**
 * Leads are stored canonically as `972XXXXXXXXX` (see `_shared/normalizePhone.ts`).
 * Operators think — and dial — in the local `05X…` form, so the dashboard shows
 * and copies that instead. Anything that isn't an Israeli canonical number is
 * returned untouched rather than guessed at.
 */
export function toLocalPhone(phone: string | null | undefined): string {
  const t = (phone ?? "").trim();
  const m = /^\+?972(\d{8,9})$/.exec(t);
  return m ? `0${m[1]}` : t;
}

/**
 * The DB holds `972…`, so a search typed as `053…` would never match. Rewrite a
 * leading local zero to the canonical prefix; names and partial digits pass through.
 */
export function toPhoneSearchTerm(term: string): string {
  return /^0\d+$/.test(term) ? `972${term.slice(1)}` : term;
}
