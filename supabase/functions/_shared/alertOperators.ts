// alertOperators.ts
//
// Fires a WhatsApp alert to each phone in agents.operator_alert_phones
// when the agent loop gives up on a lead (3 retries exhausted, hallucination
// guard rejection, judge rejection, Claude API outage). Operator sees the
// alert in their personal WhatsApp and jumps into the dashboard to reply
// manually.
//
// Why not group messaging? Meta Cloud API does not reliably support
// business→group sends for unverified WABAs. 1-on-1 broadcast to each
// operator is the pragmatic path.
//
// Never throws — alerts are best-effort. A failure here must not roll
// back the agent loop's main work.

import type { SupabaseClient } from "https://esm.sh/@supabase/supabase-js@2.45.4";
import { sendWhatsAppText } from "./whatsappSend.ts";

const ALERT_HEADER = "🚨 הבוט נתקע בשיחה";

export interface AlertOperatorsInput {
  admin: SupabaseClient;
  apiUrl: string;
  accessToken: string;
  phoneNumberId: string;
  agentId: string;
  conversationId: string;
  leadPhone: string;
  /** Short failure code we logged, e.g. "judge_rejected_reply". */
  failureType: string;
  /** Optional free-text detail (judge reason, error body, etc). */
  failureDetail?: string | null;
  /** Optional dashboard base URL — when present, the alert includes a deep link. */
  dashboardBaseUrl?: string | null;
}

interface AlertResult {
  attempted: number;
  succeeded: number;
  failed: number;
}

function formatHebrewPhone(e164OrRaw: string): string {
  const t = e164OrRaw.trim();
  if (t.startsWith("+972")) return "0" + t.slice(4);
  if (t.startsWith("972")) return "0" + t.slice(3);
  return t;
}

function truncate(s: string, max: number): string {
  if (s.length <= max) return s;
  return s.slice(0, max - 1) + "…";
}

interface AgentRow {
  operator_alert_phones?: unknown;
}
interface ConvRow {
  lead_name?: string | null;
}
interface MsgRow {
  content?: string | null;
}

/**
 * Pull alert phones + lead name + last inbound content. Returns null
 * pieces on lookup failure — we still try to send the alert with what we
 * have rather than blocking on the lookup.
 */
async function gatherAlertContext(
  admin: SupabaseClient,
  agentId: string,
  conversationId: string,
): Promise<{ phones: string[]; leadName: string | null; lastInbound: string | null }> {
  const [agentRes, convRes, msgRes] = await Promise.all([
    admin.from("agents").select("operator_alert_phones").eq("id", agentId).maybeSingle(),
    admin.from("conversations").select("lead_name").eq("id", conversationId).maybeSingle(),
    admin.from("messages")
      .select("content")
      .eq("conversation_id", conversationId)
      .eq("direction", "inbound")
      .order("timestamp", { ascending: false })
      .limit(1)
      .maybeSingle(),
  ]);
  const rawPhones = (agentRes.data as AgentRow | null)?.operator_alert_phones;
  const phones: string[] = Array.isArray(rawPhones)
    ? (rawPhones as unknown[]).filter((p): p is string => typeof p === "string" && p.length > 0)
    : [];
  const leadName = ((convRes.data as ConvRow | null)?.lead_name ?? null) as string | null;
  const lastInbound = ((msgRes.data as MsgRow | null)?.content ?? null) as string | null;
  return { phones, leadName, lastInbound };
}

function buildAlertBody(args: {
  leadName: string | null;
  leadPhone: string;
  lastInbound: string | null;
  failureType: string;
  failureDetail?: string | null;
  dashboardBaseUrl?: string | null;
  conversationId: string;
}): string {
  const name = args.leadName?.trim() || "(ללא שם)";
  const phone = formatHebrewPhone(args.leadPhone);
  const msg = truncate((args.lastInbound ?? "").trim() || "(ההודעה ריקה)", 280);
  const reason = args.failureDetail
    ? `${args.failureType} — ${truncate(args.failureDetail, 140)}`
    : args.failureType;
  const link = args.dashboardBaseUrl
    ? `${args.dashboardBaseUrl.replace(/\/$/, "")}/conversations/${args.conversationId}`
    : null;
  const lines = [
    ALERT_HEADER,
    "",
    `*ליד:* ${name}`,
    `*טלפון:* ${phone}`,
    "",
    `*ההודעה האחרונה ממנו:*`,
    msg,
    "",
    `*למה הבוט לא ענה:* ${reason}`,
  ];
  if (link) {
    lines.push("");
    lines.push(`*לתגובה:* ${link}`);
  }
  return lines.join("\n");
}

export async function alertOperators(input: AlertOperatorsInput): Promise<AlertResult> {
  const ctx = await gatherAlertContext(input.admin, input.agentId, input.conversationId);
  if (ctx.phones.length === 0) return { attempted: 0, succeeded: 0, failed: 0 };

  const body = buildAlertBody({
    leadName: ctx.leadName,
    leadPhone: input.leadPhone,
    lastInbound: ctx.lastInbound,
    failureType: input.failureType,
    failureDetail: input.failureDetail ?? null,
    dashboardBaseUrl: input.dashboardBaseUrl ?? null,
    conversationId: input.conversationId,
  });

  const result: AlertResult = { attempted: ctx.phones.length, succeeded: 0, failed: 0 };

  for (const phone of ctx.phones) {
    try {
      const send = await sendWhatsAppText({
        apiUrl: input.apiUrl,
        accessToken: input.accessToken,
        phoneNumberId: input.phoneNumberId,
        to: phone,
        body,
      });
      if (send.ok) result.succeeded++;
      else {
        result.failed++;
        console.error(
          `[alertOperators] failed to alert ${phone}: status=${send.status} body=${send.errorBody.slice(0, 200)}`,
        );
      }
    } catch (err) {
      result.failed++;
      console.error(
        `[alertOperators] exception alerting ${phone}: ${err instanceof Error ? err.message : String(err)}`,
      );
    }
  }
  return result;
}
