/**
 * Template funnel — a per-WhatsApp-template cohort funnel:
 *
 *   sent → delivered → read → answered → zoom (agent-booked)
 *
 * grouped by `template_name` and date-filterable.
 *
 * PHONE-NORMALIZED JOIN — sends (`scheduled_messages`) and outcomes
 * (`conversations`) are matched by NORMALIZED phone (digits only), NOT by
 * `scheduled_messages.conversation_id`. In prod the send path stores phones as
 * `+972…` while the inbound webhook stores `972…`, so a lead ends up with two
 * conversation rows: the send links to an empty "shell" row, while the reply
 * (and any zoom) lands on a sibling row. Joining by FK would report 0 answered.
 * Matching on digits-only reunites them. (The duplicate-conversation split is a
 * separate, broader data bug worth fixing at the source — see the spec.)
 *
 * COHORT SEMANTICS — the date range bounds the cohort by `sent_at` (which
 * sends count). Outcomes are read from the lead's current state REGARDLESS of
 * when they happened. `failed` sends have no `sent_at`, so they are windowed by
 * `created_at`. All filtering happens here (not in SQL) so it is unit-testable.
 *
 * ZOOM ATTRIBUTION (conversations.zoom_booked_by, migration 0033) — only
 * `agent` (the bot booked it in-chat) is the conversion metric. `self`,
 * `consent_handoff`, and `legacy` (a pre-attribution zoom: current_tag is
 * 'zoom_scheduled' but zoom_booked_by is null) are surfaced separately and
 * NEVER folded into the conversion rate. Per person we keep the strongest
 * category: agent > self > consent_handoff > legacy.
 */
import { supabase } from "./supabase/client";
import type { DateRange } from "@/components/leads/DateRangeFilter";

/** A template send (one `scheduled_messages` row). */
export interface SendRow {
  template_name: string;
  status: "pending" | "sent" | "failed" | "cancelled";
  sent_at: string | null;
  created_at: string;
  delivered_at: string | null;
  read_at: string | null;
  lead_phone: string;
}

/** A conversation row, used only for outcome signals. */
export interface ConversationOutcomeRow {
  lead_phone: string;
  last_inbound_at: string | null;
  current_tag: string | null;
  zoom_booked_by: string | null;
}

export interface TemplateFunnelRow {
  templateName: string;
  sent: number;
  delivered: number;
  read: number;
  answered: number;
  /** Bot booked the meeting in-chat — THE conversion metric. */
  agentZoom: number;
  /** Lead booked themselves via the Mooz page (surfaced separately). */
  selfZoom: number;
  /** Consent observed + handed off, no actual bot booking (surfaced separately). */
  consentHandoff: number;
  /** Pre-attribution zoom (zoom_scheduled tag, zoom_booked_by null) — historical. */
  legacyZoom: number;
  failed: number;
  deliveredRatePct: number;
  readRatePct: number;
  answeredRatePct: number;
  /** agentZoom / answered — the "conversation → agent-booked zoom" rate. */
  agentZoomPerAnsweredPct: number;
  /** agentZoom / sent. */
  agentZoomPerSentPct: number;
}

/** Digits-only phone key so `+972…` and `972…` collapse to one person. */
export function normalizePhone(phone: string): string {
  return phone.replace(/\D/g, "");
}

function pct(n: number, d: number): number {
  return d === 0 ? 0 : Math.round((n / d) * 1000) / 10;
}

function toMs(value: string | null): number | null {
  if (!value) return null;
  const t = new Date(value).getTime();
  return Number.isNaN(t) ? null : t;
}

type ZoomCategory = "agent" | "self" | "consent_handoff" | "legacy" | null;

interface Outcome {
  answered: boolean;
  zoom: ZoomCategory;
}

/** OR-reduce one conversation into the per-phone outcome, keeping the
 *  strongest zoom category (agent > self > consent_handoff > legacy). */
function foldConversation(prev: Outcome, c: ConversationOutcomeRow): Outcome {
  const answered = prev.answered || c.last_inbound_at !== null;
  let zoom = prev.zoom;
  const incoming: ZoomCategory =
    c.zoom_booked_by === "agent"
      ? "agent"
      : c.zoom_booked_by === "self"
        ? "self"
        : c.zoom_booked_by === "consent_handoff"
          ? "consent_handoff"
          : c.current_tag === "zoom_scheduled"
            ? "legacy"
            : null;
  const rank: Record<NonNullable<ZoomCategory>, number> = {
    agent: 4,
    self: 3,
    consent_handoff: 2,
    legacy: 1,
  };
  if (incoming && (!zoom || rank[incoming] > rank[zoom])) zoom = incoming;
  return { answered, zoom };
}

interface Bucket {
  sent: Set<string>;
  delivered: Set<string>;
  read: Set<string>;
  answered: Set<string>;
  agentZoom: Set<string>;
  selfZoom: Set<string>;
  consentHandoff: Set<string>;
  legacyZoom: Set<string>;
  failed: Set<string>;
}

function emptyBucket(): Bucket {
  return {
    sent: new Set(),
    delivered: new Set(),
    read: new Set(),
    answered: new Set(),
    agentZoom: new Set(),
    selfZoom: new Set(),
    consentHandoff: new Set(),
    legacyZoom: new Set(),
    failed: new Set(),
  };
}

/**
 * Pure aggregation. One row per `template_name`, sorted by `sent` desc (then
 * name asc). People are de-duplicated per template by NORMALIZED phone, and
 * outcomes are looked up from the conversation set by the same key.
 *
 * NOTE: the live widgets no longer call this — they call the `template_funnel()`
 * Postgres RPC (migration 0045), which aggregates server-side so the result is
 * correct at any table size (the old client-side path silently truncated at
 * SAFETY_LIMIT rows and mis-reported answered/zoom as ~0). This function is
 * retained as the reference spec: its unit tests document the exact semantics
 * the RPC mirrors 1:1, and it's used to verify parity.
 */
export function aggregateTemplateFunnel(
  sends: SendRow[],
  conversations: ConversationOutcomeRow[],
  range: DateRange = { from: null, to: null },
): TemplateFunnelRow[] {
  const fromMs = toMs(range.from) ?? -Infinity;
  const toBound = toMs(range.to) ?? Infinity;
  const inWindow = (ts: string | null): boolean => {
    const t = toMs(ts);
    return t !== null && t >= fromMs && t <= toBound;
  };

  // Outcome map keyed by normalized phone, OR-reduced across sibling rows.
  const outcomes = new Map<string, Outcome>();
  for (const c of conversations) {
    const key = normalizePhone(c.lead_phone);
    const prev = outcomes.get(key) ?? { answered: false, zoom: null };
    outcomes.set(key, foldConversation(prev, c));
  }

  const buckets = new Map<string, Bucket>();
  for (const s of sends) {
    const key = normalizePhone(s.lead_phone);
    const b = buckets.get(s.template_name) ?? emptyBucket();

    if (s.status === "failed" && inWindow(s.created_at)) {
      b.failed.add(key);
    }
    if (s.status === "sent" && inWindow(s.sent_at)) {
      b.sent.add(key);
      if (s.delivered_at || s.read_at) b.delivered.add(key);
      if (s.read_at) b.read.add(key);
      const o = outcomes.get(key);
      if (o?.answered) b.answered.add(key);
      switch (o?.zoom) {
        case "agent":
          b.agentZoom.add(key);
          break;
        case "self":
          b.selfZoom.add(key);
          break;
        case "consent_handoff":
          b.consentHandoff.add(key);
          break;
        case "legacy":
          b.legacyZoom.add(key);
          break;
      }
    }

    buckets.set(s.template_name, b);
  }

  const out: TemplateFunnelRow[] = [];
  for (const [templateName, b] of buckets) {
    const sent = b.sent.size;
    const failed = b.failed.size;
    if (sent === 0 && failed === 0) continue; // no in-window activity
    const delivered = b.delivered.size;
    const read = b.read.size;
    const answered = b.answered.size;
    const agentZoom = b.agentZoom.size;
    out.push({
      templateName,
      sent,
      delivered,
      read,
      answered,
      agentZoom,
      selfZoom: b.selfZoom.size,
      consentHandoff: b.consentHandoff.size,
      legacyZoom: b.legacyZoom.size,
      failed,
      deliveredRatePct: pct(delivered, sent),
      readRatePct: pct(read, sent),
      answeredRatePct: pct(answered, sent),
      agentZoomPerAnsweredPct: pct(agentZoom, answered),
      agentZoomPerSentPct: pct(agentZoom, sent),
    });
  }

  out.sort((a, b) => b.sent - a.sent || a.templateName.localeCompare(b.templateName));
  return out;
}

/** Shape returned by the `template_funnel()` RPC (snake_case, numeric rates). */
interface FunnelRpcRow {
  template_name: string;
  sent: number;
  delivered: number;
  read: number;
  answered: number;
  agent_zoom: number;
  self_zoom: number;
  consent_handoff: number;
  legacy_zoom: number;
  failed: number;
  delivered_rate_pct: number | string;
  read_rate_pct: number | string;
  answered_rate_pct: number | string;
  agent_zoom_per_answered_pct: number | string;
  agent_zoom_per_sent_pct: number | string;
}

/** Map an RPC row → the camelCase `TemplateFunnelRow` the UI consumes. Rates
 *  are `numeric` in Postgres and may arrive as strings, so coerce defensively. */
function mapRpcRow(r: FunnelRpcRow): TemplateFunnelRow {
  return {
    templateName: r.template_name,
    sent: r.sent,
    delivered: r.delivered,
    read: r.read,
    answered: r.answered,
    agentZoom: r.agent_zoom,
    selfZoom: r.self_zoom,
    consentHandoff: r.consent_handoff,
    legacyZoom: r.legacy_zoom,
    failed: r.failed,
    deliveredRatePct: Number(r.delivered_rate_pct),
    readRatePct: Number(r.read_rate_pct),
    answeredRatePct: Number(r.answered_rate_pct),
    agentZoomPerAnsweredPct: Number(r.agent_zoom_per_answered_pct),
    agentZoomPerSentPct: Number(r.agent_zoom_per_sent_pct),
  };
}

export async function getTemplateFunnel(
  agentId: string,
  range: DateRange,
): Promise<TemplateFunnelRow[]> {
  const { data, error } = await supabase.rpc("template_funnel", {
    p_agent_id: agentId,
    p_from: range.from,
    p_to: range.to,
    p_broadcast_id: null,
  });
  if (error) throw new Error(`Failed to load template funnel: ${error.message}`);
  return ((data ?? []) as FunnelRpcRow[]).map(mapRpcRow);
}

export async function getBroadcastFunnel(
  agentId: string,
  broadcastId: string,
): Promise<TemplateFunnelRow[]> {
  const { data, error } = await supabase.rpc("template_funnel", {
    p_agent_id: agentId,
    p_from: null,
    p_to: null,
    p_broadcast_id: broadcastId,
  });
  if (error) throw new Error(`Failed to load broadcast funnel: ${error.message}`);
  return ((data ?? []) as FunnelRpcRow[]).map(mapRpcRow);
}
