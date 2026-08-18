/**
 * CRM Warming — queries + pure helpers for the `/crm-warming` screen.
 *
 * THE FLOW (why this screen exists): a rep changes a lead's status in the
 * Fireberry CRM → Make → an edge function stamps the conversation with the
 * status event and (when the agent's kill switch is on) queues a generic
 * WhatsApp opener. When the lead replies, the normal bot loop takes over with
 * the matching `crm_status_rules.warming_instructions` injected into its
 * prompt. This page is where the operator watches that traffic and tunes the
 * per-objection instructions — no deploy, no Meta template approval.
 *
 * WHY WE FILTER ON `crm_status_event_at IS NOT NULL` (and not on
 * `crm_warming_status IS NOT NULL`): when the agent's `crm_warming_enabled`
 * kill switch is off, the status event is still recorded but
 * `crm_warming_status` stays NULL by design. That traffic is exactly what the
 * operator needs to see ("the CRM is firing, we're just not acting on it"), so
 * the event timestamp — not the warming state — is the row's admission ticket.
 * There is a partial index on `(agent_id, crm_status_event_at DESC) WHERE
 * crm_status_event_at IS NOT NULL`; we order by that column and cap at 500 so
 * the planner uses it.
 *
 * TYPES — migration 0046 (the `crm_status_rules` table, the `crm_*` columns on
 * `conversations`) has NOT been applied yet, so none of it exists in the
 * generated `src/types/database.ts`. Rather than hand-edit a generated file we
 * declare the row shapes here and go through a narrow untyped view of the
 * supabase client (`db` below). Once the migration is live and
 * `bun run db:types` has been re-run, drop `db` in favour of the typed
 * `supabase` client and delete the casts at the query boundaries — the
 * exported interfaces can stay as-is. Nothing outside this file sees `unknown`.
 */
import { supabase } from "./supabase/client";

/* ------------------------------------------------------------------ *
 * Untyped client view (temporary — see the TYPES note above)
 * ------------------------------------------------------------------ */

interface PostgrestLikeResult {
  data: unknown;
  error: { message: string } | null;
}

/** The subset of the PostgREST builder these queries touch. */
interface UntypedQuery extends PromiseLike<PostgrestLikeResult> {
  select(columns: string): UntypedQuery;
  eq(column: string, value: string | number | boolean): UntypedQuery;
  not(column: string, operator: string, value: null): UntypedQuery;
  gte(column: string, value: string): UntypedQuery;
  lte(column: string, value: string): UntypedQuery;
  or(filter: string): UntypedQuery;
  order(column: string, options?: { ascending?: boolean; nullsFirst?: boolean }): UntypedQuery;
  limit(count: number): UntypedQuery;
  update(values: Record<string, unknown>): UntypedQuery;
}

interface UntypedClient {
  from(table: string): UntypedQuery;
}

const db = supabase as unknown as UntypedClient;

/* ------------------------------------------------------------------ *
 * Row shapes
 * ------------------------------------------------------------------ */

/** `crm_warming_status_enum`. NULL on the row = a normal (non-warming) lead. */
export type CrmWarmingStatus = "warming" | "warming_stopped" | "warming_converted";

/** One `conversations` row that carries a CRM status event. */
export interface CrmWarmingRow {
  id: string;
  lead_name: string | null;
  lead_phone: string;
  /** NULL = the lead has never sent us an inbound message (the "no history" cohort). */
  last_inbound_at: string | null;
  crm_warming_status: CrmWarmingStatus | null;
  crm_status_sub: number | null;
  crm_status_main: number | null;
  crm_warming_reason: string | null;
  crm_rep_note: string | null;
  /** Non-null by construction — it is the query's filter column. */
  crm_status_event_at: string;
  crm_last_warmed_at: string | null;
  crm_warming_replied_at: string | null;
}

/**
 * One `crm_status_rules` row — the operator-tunable per-status behaviour.
 *
 * `status_label`, `objection_key` and `warming_instructions` are NOT NULL in
 * migration 0046, which is why the editor refuses to save them blank rather
 * than writing NULL: `objection_key` in particular is a join key for the
 * Phase-2 asset catalog and must not drift.
 */
export interface CrmStatusRuleRow {
  id: string;
  agent_id: string;
  status_sub: number;
  status_label: string;
  objection_key: string;
  warming_instructions: string;
  delay_hours: number;
  cooldown_days: number;
  clears_zoom_state: boolean;
  is_active: boolean;
  created_at: string;
  updated_at: string;
}

/** The editable subset of a rule. `status_sub` is the CRM's key — never edited. */
export type CrmStatusRulePatch = Partial<
  Pick<
    CrmStatusRuleRow,
    | "status_label"
    | "objection_key"
    | "warming_instructions"
    | "delay_hours"
    | "cooldown_days"
    | "clears_zoom_state"
    | "is_active"
  >
>;

/* ------------------------------------------------------------------ *
 * Labels
 * ------------------------------------------------------------------ */

export const CRM_WARMING_STATUS_LABEL: Record<CrmWarmingStatus, string> = {
  warming: "בחימום",
  warming_stopped: "חימום הופסק",
  warming_converted: "הומר",
};

export const CRM_WARMING_STATUS_VARIANT: Record<
  CrmWarmingStatus,
  "default" | "secondary" | "outline" | "destructive"
> = {
  warming: "default",
  warming_stopped: "secondary",
  warming_converted: "default",
};

/** Shown when `crm_warming_status` is NULL but a status event exists — e.g. the
 *  agent kill switch is off, or no rule matched the status. */
export const CRM_NOT_WARMING_LABEL = "לא בחימום";

/**
 * `crm_warming_reason` is NOT a slug — the crm-status-webhook writes the rule's
 * Hebrew `status_label` into it (or "סטטוס לא מוגדר" when no active rule
 * matched). So it is a point-in-time snapshot of what the status was called
 * when the event landed, which is the only human-readable name available for a
 * status that has no rule row. Rendered as-is; never translated.
 */
export function formatStatusSnapshot(reason: string | null): string {
  return reason?.trim() || "—";
}

/* ------------------------------------------------------------------ *
 * Derived flags + summary (pure)
 * ------------------------------------------------------------------ */

/**
 * "ללא היסטוריה" — the lead has never sent us a single inbound message, so the
 * warming opener lands in a thread with no prior consent signal. This is an
 * accepted risk the operator explicitly asked to be able to watch, which is why
 * it gets its own badge, its own filter chip and a headline count.
 */
export function hasNoHistory(row: Pick<CrmWarmingRow, "last_inbound_at">): boolean {
  return row.last_inbound_at === null;
}

/** "ענה" — the lead answered the warming opener. */
export function hasReplied(row: Pick<CrmWarmingRow, "crm_warming_replied_at">): boolean {
  return row.crm_warming_replied_at !== null;
}

export interface CrmWarmingSummary {
  /** Every row on the screen — i.e. every lead with a CRM status event. */
  total: number;
  warming: number;
  stopped: number;
  converted: number;
  /** Status event recorded but no warming state (kill switch off / no rule). */
  notWarming: number;
  replied: number;
  noHistory: number;
}

export function summarizeWarming(rows: CrmWarmingRow[]): CrmWarmingSummary {
  const out: CrmWarmingSummary = {
    total: rows.length,
    warming: 0,
    stopped: 0,
    converted: 0,
    notWarming: 0,
    replied: 0,
    noHistory: 0,
  };
  for (const row of rows) {
    switch (row.crm_warming_status) {
      case "warming":
        out.warming += 1;
        break;
      case "warming_stopped":
        out.stopped += 1;
        break;
      case "warming_converted":
        out.converted += 1;
        break;
      default:
        out.notWarming += 1;
        break;
    }
    if (hasReplied(row)) out.replied += 1;
    if (hasNoHistory(row)) out.noHistory += 1;
  }
  return out;
}

/* ------------------------------------------------------------------ *
 * Client-side filtering (pure)
 * ------------------------------------------------------------------ */

export const CRM_WARMING_FILTERS = [
  "all",
  "warming",
  "replied",
  "warming_converted",
  "warming_stopped",
  "not_warming",
  "no_history",
] as const;

export type CrmWarmingFilter = (typeof CRM_WARMING_FILTERS)[number];

export const CRM_WARMING_FILTER_LABEL: Record<CrmWarmingFilter, string> = {
  all: "הכל",
  warming: "בחימום",
  replied: "ענו",
  warming_converted: "הומרו",
  warming_stopped: "הופסקו",
  not_warming: CRM_NOT_WARMING_LABEL,
  no_history: "ללא היסטוריה",
};

/** Does one row belong in the given chip? Chips are views, not partitions —
 *  "ענו" and "ללא היסטוריה" deliberately overlap the state chips. */
export function matchesWarmingFilter(row: CrmWarmingRow, filter: CrmWarmingFilter): boolean {
  switch (filter) {
    case "all":
      return true;
    case "warming":
      return row.crm_warming_status === "warming";
    case "warming_stopped":
      return row.crm_warming_status === "warming_stopped";
    case "warming_converted":
      return row.crm_warming_status === "warming_converted";
    case "not_warming":
      return row.crm_warming_status === null;
    case "replied":
      return hasReplied(row);
    case "no_history":
      return hasNoHistory(row);
  }
}

export function filterWarmingRows(
  rows: CrmWarmingRow[],
  filter: CrmWarmingFilter,
): CrmWarmingRow[] {
  if (filter === "all") return rows;
  return rows.filter((row) => matchesWarmingFilter(row, filter));
}

/** Per-chip counts, computed off the unfiltered list so the chips stay stable. */
export function warmingFilterCounts(
  rows: CrmWarmingRow[],
): Record<CrmWarmingFilter, number> {
  const out = {} as Record<CrmWarmingFilter, number>;
  for (const filter of CRM_WARMING_FILTERS) {
    out[filter] = filter === "all" ? rows.length : filterWarmingRows(rows, filter).length;
  }
  return out;
}

/* ------------------------------------------------------------------ *
 * Status-rule lookup (pure)
 * ------------------------------------------------------------------ */

export type StatusRuleIndex = ReadonlyMap<number, CrmStatusRuleRow>;

/** `status_sub` → rule. UNIQUE(agent_id, status_sub) makes this 1:1 per agent. */
export function buildStatusRuleIndex(rules: CrmStatusRuleRow[]): StatusRuleIndex {
  const map = new Map<number, CrmStatusRuleRow>();
  for (const rule of rules) map.set(rule.status_sub, rule);
  return map;
}

export interface StatusDisplay {
  /** Hebrew status name: the current rule's label, else the snapshot the
   *  webhook stored on the row, else the raw sub code. */
  label: string;
  /** English objection slug from the rule, if one exists. */
  objection: string | null;
  /**
   * True when no ACTIVE rule covers this `status_sub` — either no row at all,
   * or a row that is switched off. The webhook's `loadStatusRule` filters on
   * `is_active`, so both cases land the lead on the generic "discover the
   * objection yourself" default directive rather than a tuned one. The
   * operator needs to see that.
   */
  unmapped: boolean;
}

export function resolveStatusDisplay(
  row: Pick<CrmWarmingRow, "crm_status_sub" | "crm_warming_reason">,
  index: StatusRuleIndex,
): StatusDisplay {
  if (row.crm_status_sub === null) {
    return { label: formatStatusSnapshot(row.crm_warming_reason), objection: null, unmapped: false };
  }
  const fallback = row.crm_warming_reason?.trim() || `סטטוס ${row.crm_status_sub}`;
  const rule = index.get(row.crm_status_sub);
  if (!rule) {
    return { label: fallback, objection: null, unmapped: true };
  }
  return {
    label: rule.status_label.trim() || fallback,
    objection: rule.objection_key.trim() || null,
    unmapped: !rule.is_active,
  };
}

/* ------------------------------------------------------------------ *
 * Rule draft validation (pure)
 * ------------------------------------------------------------------ */

export interface StatusRuleDraft {
  status_label: string;
  objection_key: string;
  warming_instructions: string;
  delay_hours: number;
  cooldown_days: number;
  clears_zoom_state: boolean;
  is_active: boolean;
}

export const MAX_WARMING_INSTRUCTIONS = 4000;
const OBJECTION_KEY_RE = /^[a-z0-9_]+$/;

/**
 * Validate an edited rule before it hits the DB. Returns field → Hebrew error;
 * an empty object means the draft is clean.
 */
export function validateStatusRuleDraft(
  draft: StatusRuleDraft,
): Partial<Record<keyof StatusRuleDraft, string>> {
  const errors: Partial<Record<keyof StatusRuleDraft, string>> = {};

  if (!draft.status_label.trim()) {
    errors.status_label = "שדה חובה";
  }
  const key = draft.objection_key.trim();
  if (!key) {
    errors.objection_key = "שדה חובה";
  } else if (!OBJECTION_KEY_RE.test(key)) {
    errors.objection_key = "אותיות לטיניות קטנות, ספרות וקו תחתון בלבד";
  }
  if (!draft.warming_instructions.trim()) {
    // NOT NULL in the DB, and a rule with no directive gives the bot nothing —
    // the way to stop a status is to switch the rule off, not to blank it.
    errors.warming_instructions = "שדה חובה — כדי להשבית סטטוס כבה את הכלל";
  } else if (draft.warming_instructions.length > MAX_WARMING_INSTRUCTIONS) {
    errors.warming_instructions = `מקסימום ${MAX_WARMING_INSTRUCTIONS} תווים`;
  }
  if (!Number.isInteger(draft.delay_hours) || draft.delay_hours < 0 || draft.delay_hours > 720) {
    errors.delay_hours = "מספר שלם בין 0 ל-720";
  }
  if (!Number.isInteger(draft.cooldown_days) || draft.cooldown_days < 0 || draft.cooldown_days > 365) {
    errors.cooldown_days = "מספר שלם בין 0 ל-365";
  }

  return errors;
}

/** Draft → the patch we send. Text is trimmed; the three NOT NULL text columns
 *  are never nulled (validation blocks a blank draft from getting this far). */
export function draftToPatch(draft: StatusRuleDraft): CrmStatusRulePatch {
  return {
    status_label: draft.status_label.trim(),
    objection_key: draft.objection_key.trim(),
    warming_instructions: draft.warming_instructions.trim(),
    delay_hours: draft.delay_hours,
    cooldown_days: draft.cooldown_days,
    clears_zoom_state: draft.clears_zoom_state,
    is_active: draft.is_active,
  };
}

export function ruleToDraft(rule: CrmStatusRuleRow): StatusRuleDraft {
  return {
    status_label: rule.status_label,
    objection_key: rule.objection_key,
    warming_instructions: rule.warming_instructions,
    delay_hours: rule.delay_hours,
    cooldown_days: rule.cooldown_days,
    clears_zoom_state: rule.clears_zoom_state,
    is_active: rule.is_active,
  };
}

/* ------------------------------------------------------------------ *
 * Queries
 * ------------------------------------------------------------------ */

const WARMING_COLUMNS = [
  "id",
  "lead_name",
  "lead_phone",
  "last_inbound_at",
  "crm_warming_status",
  "crm_status_sub",
  "crm_status_main",
  "crm_warming_reason",
  "crm_rep_note",
  "crm_status_event_at",
  "crm_last_warmed_at",
  "crm_warming_replied_at",
].join(", ");

const DEFAULT_LIMIT = 500;

export interface CrmWarmingFilters {
  agentId: string;
  search?: string;
  /** Inclusive lower bound on `crm_status_event_at`. */
  fromEventAt?: string | null;
  /** Inclusive upper bound on `crm_status_event_at`. */
  toEventAt?: string | null;
  limit?: number;
}

/**
 * Every conversation for the agent that carries a CRM status event, newest
 * event first. See the module header for why the filter is on
 * `crm_status_event_at` rather than `crm_warming_status`.
 */
export async function getCrmWarmingRows(
  filters: CrmWarmingFilters,
): Promise<CrmWarmingRow[]> {
  let query = db
    .from("conversations")
    .select(WARMING_COLUMNS)
    .eq("agent_id", filters.agentId)
    .not("crm_status_event_at", "is", null);

  if (filters.fromEventAt) {
    query = query.gte("crm_status_event_at", filters.fromEventAt);
  }
  if (filters.toEventAt) {
    query = query.lte("crm_status_event_at", filters.toEventAt);
  }
  if (filters.search && filters.search.trim()) {
    const term = filters.search.trim().replace(/[%_]/g, "");
    query = query.or(`lead_phone.ilike.%${term}%,lead_name.ilike.%${term}%`);
  }

  const { data, error } = await query
    .order("crm_status_event_at", { ascending: false })
    .limit(filters.limit ?? DEFAULT_LIMIT);

  if (error) {
    throw new Error(`Failed to load CRM warming leads: ${error.message}`);
  }
  // Cast is removable once migration 0046 is applied and `bun run db:types`
  // has regenerated src/types/database.ts.
  return (data as CrmWarmingRow[] | null) ?? [];
}

const RULE_COLUMNS = [
  "id",
  "agent_id",
  "status_sub",
  "status_label",
  "objection_key",
  "warming_instructions",
  "delay_hours",
  "cooldown_days",
  "clears_zoom_state",
  "is_active",
  "created_at",
  "updated_at",
].join(", ");

/** All rules for one agent (~33 rows), sorted by the CRM's status code. */
export async function listCrmStatusRules(agentId: string): Promise<CrmStatusRuleRow[]> {
  const { data, error } = await db
    .from("crm_status_rules")
    .select(RULE_COLUMNS)
    .eq("agent_id", agentId)
    .order("status_sub", { ascending: true });

  if (error) {
    throw new Error(`Failed to load CRM status rules: ${error.message}`);
  }
  // Cast is removable once migration 0046 is applied and `bun run db:types`
  // has regenerated src/types/database.ts.
  return (data as CrmStatusRuleRow[] | null) ?? [];
}

/** RLS on `crm_status_rules` is admin-only, so this goes straight through the
 *  client — no edge function needed. */
export async function updateCrmStatusRule(
  id: string,
  patch: CrmStatusRulePatch,
): Promise<void> {
  const { error } = await db
    .from("crm_status_rules")
    .update(patch as Record<string, unknown>)
    .eq("id", id);

  if (error) {
    throw new Error(`Failed to update CRM status rule: ${error.message}`);
  }
}
