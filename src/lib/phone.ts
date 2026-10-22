/**
 * Client-side mirror of `supabase/functions/_shared/normalizePhone.ts`.
 *
 * Kept as a deliberate duplicate: the edge function runs on Deno and can't be
 * imported by the Vite bundle. The two MUST stay semantically identical — the
 * server is the authority, this copy exists only so the dashboard can tell the
 * operator *before* they hit send which rows the server would reject.
 *
 * Accepts `+972XXXXXXXX(X)`, `972XXXXXXXX(X)`, `0XXXXXXXX(X)`. Returns null for
 * anything else.
 */
export function toCanonicalPhone(raw: string): string | null {
  const t = (raw ?? "").trim().replace(/[\s\-()]/g, "");
  if (/^\+972\d{8,9}$/.test(t)) return t.slice(1);
  if (/^972\d{8,9}$/.test(t)) return t;
  if (/^0\d{8,9}$/.test(t)) return `972${t.slice(1)}`;
  return null;
}

/**
 * Undo the damage Excel does to phone columns before canonicalizing.
 *
 * Excel treats `0528524113` as a number, drops the leading zero, and hands back
 * `528524113` — nine digits that no branch of `toCanonicalPhone` accepts. Since
 * every Israeli mobile is `05X…`, a bare 9-digit string starting with `5` is
 * unambiguously a mobile missing its zero, so we put it back. We deliberately
 * do NOT guess for other prefixes (landlines aren't WhatsApp numbers anyway).
 *
 * Also strips the leading apostrophe Excel writes when a cell is force-formatted
 * as text (`'0528524113`).
 */
export function repairSpreadsheetPhone(raw: string): string {
  let t = (raw ?? "").trim();
  if (t.startsWith("'")) t = t.slice(1).trim();
  const digits = t.replace(/[\s\-()]/g, "");
  if (/^5\d{8}$/.test(digits)) return `0${digits}`;
  return t;
}
