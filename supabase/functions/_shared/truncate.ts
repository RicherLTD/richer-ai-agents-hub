// truncate.ts
//
// Shared string-truncation helper for edge function loggers.
//
// JS `length` is UTF-16 code units, not bytes — multi-byte chars count as
// 1 or 2 code units depending on surrogate pairs. That's fine for our use
// case (capping rendered character count) but worth knowing if we ever
// need to enforce a Postgres TEXT byte limit.

const TRUNCATION_MARKER = "…[truncated]";

export function truncate(text: string, max: number): string {
  if (text.length <= max) return text;
  return text.slice(0, max - TRUNCATION_MARKER.length) + TRUNCATION_MARKER;
}
