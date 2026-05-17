/**
 * Defensive input validation helpers.
 *
 * In particular: every place we pass a user-supplied string into a
 * PostgREST `.or()` filter must validate it first. Comma / paren chars
 * in the value can escape the or-group and rewrite the filter, exposing
 * rows the caller shouldn't see.
 */

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

export function isUuid(value: unknown): value is string {
  return typeof value === "string" && UUID_RE.test(value);
}

/**
 * Throw if `value` isn\'t a UUID. Use at the boundary of any function that
 * will interpolate the value into a PostgREST query.
 */
export function assertUuid(value: unknown, label: string): asserts value is string {
  if (!isUuid(value)) {
    throw new Error(`Invalid ${label}: must be a UUID`);
  }
}
