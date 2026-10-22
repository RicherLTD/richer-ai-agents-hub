// fireberrySync.ts
//
// Pure pieces of the Fireberry → conversations status mirror
// (fireberry-status-sync). No network, no Supabase — testable under vitest.
//
// Fireberry's v3 /query can filter on modifiedon and sort by it, but has no
// tie-breaker, so the cursor is (last modifiedon, ids already applied at that
// instant): the next page is read with `modifiedon ge cursor` and those ids are
// skipped.

import { toCanonicalPhone } from "./normalizePhone.ts";

export const FIREBERRY_PAGE_SIZE = 500;

/** The Account (lead) fields the sync reads. */
export const SYNC_FIELDS = [
  "accountid",
  "telephone1",
  "statuscode",
  "status",
  "pcfsystemfield103",
  "pcfsystemfield103name",
  "modifiedon",
  "createdon",
  "pcfvetekop",
] as const;

export interface FireberryLeadRecord {
  accountid?: unknown;
  telephone1?: unknown;
  statuscode?: unknown;
  status?: unknown;
  pcfsystemfield103?: unknown;
  pcfsystemfield103name?: unknown;
  modifiedon?: unknown;
  createdon?: unknown;
  pcfvetekop?: unknown;
}

/** One row for apply_fireberry_statuses. */
export interface StatusRow {
  phone: string;
  account_id: string;
  status_main: number | null;
  status_main_name: string | null;
  status_sub: number | null;
  status_sub_name: string | null;
  last_opportunity_at: string | null;
}

export interface SyncCursor {
  modifiedOn: string | null;
  ids: string[];
}

export function buildSyncQuery(args: {
  productId: string;
  cursorModifiedOn: string | null;
  pageSize?: number;
}): Record<string, unknown> {
  const conditions: Array<Record<string, string>> = [
    { fieldName: "pcfsystemfield122", operator: "eq", value: args.productId },
  ];
  if (args.cursorModifiedOn) {
    conditions.push({ fieldName: "modifiedon", operator: "ge", value: args.cursorModifiedOn });
  }
  return {
    objectType: 1,
    fields: SYNC_FIELDS.map((name) => ({ name })),
    filter: [{ type: "AND", conditions }],
    orderBy: [{ name: "modifiedon", order: "asc" }],
    pageSize: args.pageSize ?? FIREBERRY_PAGE_SIZE,
    pageNumber: 1,
  };
}

/**
 * Fireberry stores phones as typed by whoever created the lead: "0525…",
 * "052-…", "+972…", or with the leading zero lost ("525…"). Canonical `972…`
 * or null.
 */
export function fireberryPhoneToCanonical(raw: unknown): string | null {
  if (typeof raw !== "string") return null;
  const compact = raw.trim().replace(/[\s\-()]/g, "");
  const repaired = /^5\d{8}$/.test(compact) ? `0${compact}` : compact;
  return toCanonicalPhone(repaired);
}

function toInt(value: unknown): number | null {
  const n = typeof value === "number" ? value : typeof value === "string" && value.trim() !== "" ? Number(value) : NaN;
  return Number.isInteger(n) ? n : null;
}

/** Fireberry text values sometimes carry trailing spaces. */
function toText(value: unknown): string | null {
  if (typeof value !== "string") return null;
  const t = value.trim();
  return t === "" ? null : t;
}

function toIso(value: unknown): string | null {
  if (typeof value !== "string") return null;
  const ms = new Date(value).getTime();
  return Number.isNaN(ms) ? null : new Date(ms).toISOString();
}

/** A record we can apply, or null (no usable phone / id). */
export function toStatusRow(record: FireberryLeadRecord): StatusRow | null {
  const accountId = toText(record.accountid);
  const phone = fireberryPhoneToCanonical(record.telephone1);
  if (!accountId || !phone) return null;
  return {
    phone,
    account_id: accountId,
    status_main: toInt(record.statuscode),
    status_main_name: toText(record.status),
    status_sub: toInt(record.pcfsystemfield103),
    status_sub_name: toText(record.pcfsystemfield103name),
    // No last-opportunity date → the creation date is the lead's only opportunity.
    last_opportunity_at: toIso(record.pcfvetekop) ?? toIso(record.createdon),
  };
}

/**
 * One row per phone: the record with the latest last-opportunity date (Izak's
 * rule: a person belongs to their most recent opportunity). The database
 * applies the same rule against what is already stored.
 */
export function dedupeByPhone(rows: StatusRow[]): StatusRow[] {
  const best = new Map<string, StatusRow>();
  for (const row of rows) {
    const current = best.get(row.phone);
    if (!current || opportunityMs(row) >= opportunityMs(current)) best.set(row.phone, row);
  }
  return [...best.values()];
}

function opportunityMs(row: StatusRow): number {
  const ms = row.last_opportunity_at ? new Date(row.last_opportunity_at).getTime() : NaN;
  return Number.isNaN(ms) ? -Infinity : ms;
}

/** Drop records already applied at the cursor instant (re-read by `ge`). */
export function skipAlreadyApplied(records: FireberryLeadRecord[], cursor: SyncCursor): FireberryLeadRecord[] {
  if (!cursor.modifiedOn || cursor.ids.length === 0) return records;
  const seen = new Set(cursor.ids);
  return records.filter((r) => !(toIso(r.modifiedon) === cursor.modifiedOn && seen.has(String(r.accountid))));
}

/**
 * Cursor after applying a page (records in modifiedon order). The ids carried
 * forward are those at the page's last instant — plus the previous cursor's
 * ids when the instant did not move.
 */
export function advanceCursor(prev: SyncCursor, records: FireberryLeadRecord[]): SyncCursor {
  let last: string | null = null;
  for (const r of records) {
    const at = toIso(r.modifiedon);
    if (at && (!last || at > last)) last = at;
  }
  if (!last) return prev;
  const atLast = records.filter((r) => toIso(r.modifiedon) === last).map((r) => String(r.accountid));
  const ids = last === prev.modifiedOn ? [...new Set([...prev.ids, ...atLast])] : atLast;
  return { modifiedOn: last, ids };
}

/**
 * A full page whose every record is at the cursor instant and already applied
 * would be re-read forever. Step the cursor one second past it; the few
 * records beyond the first page at that exact second are picked up on their
 * next edit. Only happens on a bulk update of >500 leads within one second.
 */
export function isStuckPage(fetched: FireberryLeadRecord[], fresh: FireberryLeadRecord[], pageSize: number): boolean {
  return fetched.length >= pageSize && fresh.length === 0;
}

export function stepPastInstant(cursor: SyncCursor): SyncCursor {
  if (!cursor.modifiedOn) return cursor;
  return { modifiedOn: new Date(new Date(cursor.modifiedOn).getTime() + 1000).toISOString(), ids: [] };
}
