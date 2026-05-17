// validation.ts -- shared input validation for edge functions.
//
// Any string value that gets interpolated into a PostgREST .or() / .filter()
// must be validated first. Otherwise an attacker (or just a malformed
// caller) can rewrite the filter and bypass row scoping.

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

export function isUuid(value: unknown): value is string {
  return typeof value === "string" && UUID_RE.test(value);
}

export function assertUuid(value: unknown, label: string): asserts value is string {
  if (!isUuid(value)) {
    throw new Error(`Invalid ${label}: must be a UUID`);
  }
}
