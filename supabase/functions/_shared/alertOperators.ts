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
import { sendWhatsAppTemplate } from "./whatsappTemplateSend.ts";

const ALERT_HEADER = "🚨 הבוט נתקע בשיחה";

// Meta only accepts free-form text inside the 24h customer-service window.
// Operators are not customers — they never message the bot — so every
// free-text alert we sent was rejected with error 131047 ("Re-engagement
// message"). 128/128 failed over 14 days and nobody knew the bot was
// dropping leads. The approved `bot_stuck_alert` template is the only
// route that actually reaches a phone, so it is the primary path now;
// free text stays as a fallback for the rare case the window IS open.
const DEFAULT_ALERT_TEMPLATE = "bot_stuck_alert";
const DEFAULT_ALERT_TEMPLATE_LANG = "he";

/** Max chars for the lead's message inside {{5}}. The whole rendered body
 *  must stay under Meta's 1024-char limit; 250 leaves comfortable room. */
const LAST_INBOUND_MAX = 250;
const NAME_MAX = 80;
const REASON_MAX = 160;

/**
 * Make a string safe to pass as a Meta template parameter.
 *
 * Meta rejects any parameter containing a newline, a tab, or a run of more
 * than 4 spaces. A lead's WhatsApp message contains all three routinely, so
 * this runs on EVERY variable, not just the message.
 *
 * Also guarantees a non-empty result — an empty parameter is rejected too.
 */
export function sanitiseTemplateVariable(
  raw: string | null | undefined,
  maxChars = NAME_MAX,
): string {
  const flattened = (raw ?? "")
    .replace(/[\r\n\t]+/g, " ")
    .replace(/\s{2,}/g, " ")
    .trim();
  if (flattened.length === 0) return "—";
  if (flattened.length <= maxChars) return flattened;
  return flattened.slice(0, maxChars - 1) + "…";
}

export interface AlertTemplateInput {
  leadName: string | null;
  leadPhone: string;
  /** Human-readable agent name, e.g. "שיווק דיגיטלי". */
  agentLabel: string | null;
  failureType: string;
  failureDetail?: string | null;
  lastInbound: string | null;
}

/**
 * Build the ordered body variables for `bot_stuck_alert`:
 *   {{1}} lead name   {{2}} phone   {{3}} agent
 *   {{4}} reason      {{5}} the lead's last message
 * Order is a contract with the approved template — do not reorder.
 */
export function buildAlertTemplateVariables(input: AlertTemplateInput): string[] {
  const reason = input.failureDetail
    ? `${input.failureType} — ${input.failureDetail}`
    : input.failureType;
  return [
    input.leadName?.trim()
      ? sanitiseTemplateVariable(input.leadName, NAME_MAX)
      : "(ללא שם)",
    sanitiseTemplateVariable(formatHebrewPhone(input.leadPhone), NAME_MAX),
    sanitiseTemplateVariable(input.agentLabel, NAME_MAX),
    sanitiseTemplateVariable(reason, REASON_MAX),
    sanitiseTemplateVariable(input.lastInbound, LAST_INBOUND_MAX),
  ];
}

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
  display_name?: string | null;
  name?: string | null;
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
): Promise<{
  phones: string[];
  leadName: string | null;
  lastInbound: string | null;
  agentLabel: string | null;
}> {
  const [agentRes, convRes, msgRes] = await Promise.all([
    admin.from("agents").select("operator_alert_phones, display_name, name").eq("id", agentId)
      .maybeSingle(),
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
  const agentRow = agentRes.data as AgentRow | null;
  const agentLabel = (agentRow?.display_name ?? agentRow?.name ?? null) as string | null;
  return { phones, leadName, lastInbound, agentLabel };
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

  // Loop prevention: if the operator has misconfigured the bot's own
  // WABA number into operator_alert_phones, every agent-loop failure
  // would alert the bot itself — the alert lands as inbound, fires the
  // agent loop, which may fail, which sends another alert. Filter the
  // bot's own number out before sending.
  const botSelf = Deno.env.get("WHATSAPP_BOT_PHONE") ??
    Deno.env.get("WHATSAPP_PHONE_NUMBER_DISPLAY") ?? null;
  const safePhones = botSelf
    ? ctx.phones.filter((p) => p !== botSelf)
    : ctx.phones;
  if (safePhones.length === 0) return { attempted: 0, succeeded: 0, failed: 0 };
  ctx.phones = safePhones;

  const body = buildAlertBody({
    leadName: ctx.leadName,
    leadPhone: input.leadPhone,
    lastInbound: ctx.lastInbound,
    failureType: input.failureType,
    failureDetail: input.failureDetail ?? null,
    dashboardBaseUrl: input.dashboardBaseUrl ?? null,
    conversationId: input.conversationId,
  });

  const templateName = Deno.env.get("OPERATOR_ALERT_TEMPLATE_NAME")?.trim() ||
    DEFAULT_ALERT_TEMPLATE;
  const templateLang = Deno.env.get("OPERATOR_ALERT_TEMPLATE_LANG")?.trim() ||
    DEFAULT_ALERT_TEMPLATE_LANG;
  const variables = buildAlertTemplateVariables({
    leadName: ctx.leadName,
    leadPhone: input.leadPhone,
    agentLabel: ctx.agentLabel,
    failureType: input.failureType,
    failureDetail: input.failureDetail ?? null,
    lastInbound: ctx.lastInbound,
  });

  const result: AlertResult = { attempted: ctx.phones.length, succeeded: 0, failed: 0 };
  const perPhone: Array<Record<string, unknown>> = [];

  for (const phone of ctx.phones) {
    let delivered = false;
    let via = "template";
    let status = 0;
    let errorBody = "";

    // Primary: the approved template. This is the only path that works
    // outside the 24h window, i.e. essentially always.
    try {
      const sent = await sendWhatsAppTemplate({
        apiUrl: input.apiUrl,
        accessToken: input.accessToken,
        phoneNumberId: input.phoneNumberId,
        to: phone,
        templateName,
        languageCode: templateLang,
        variables,
      });
      delivered = sent.ok;
      status = sent.status;
      if (!sent.ok) errorBody = sent.errorBody;
    } catch (err) {
      errorBody = err instanceof Error ? err.message : String(err);
    }

    // Fallback: free text. Only succeeds when the operator happens to have
    // messaged the bot in the last 24h, but costs nothing to try and covers
    // a template that got paused/renamed on Meta's side.
    if (!delivered) {
      via = "text_fallback";
      try {
        const sent = await sendWhatsAppText({
          apiUrl: input.apiUrl,
          accessToken: input.accessToken,
          phoneNumberId: input.phoneNumberId,
          to: phone,
          body,
        });
        delivered = sent.ok;
        if (!sent.ok) {
          status = sent.status;
          errorBody = `${errorBody} | text: ${sent.errorBody}`;
        }
      } catch (err) {
        errorBody = `${errorBody} | text: ${err instanceof Error ? err.message : String(err)}`;
      }
    }

    if (delivered) result.succeeded++;
    else {
      result.failed++;
      console.error(
        `[alertOperators] failed to alert ${phone}: status=${status} body=${errorBody.slice(0, 200)}`,
      );
    }
    perPhone.push({ phone, delivered, via, status, error: errorBody.slice(0, 200) || null });
  }

  // Persist the outcome. Without this the previous silent 100% failure rate
  // was invisible — an alert that fails must itself be observable.
  await input.admin.from("error_logs").insert({
    agent_id: input.agentId,
    conversation_id: input.conversationId,
    source: "alert-operators",
    error_type: result.failed === 0 ? "operator_alert_sent" : "operator_alert_failed",
    level: result.failed === 0 ? "info" : "error",
    message:
      `operator alert (${input.failureType}): ${result.succeeded}/${result.attempted} delivered ` +
      `via template "${templateName}"`,
    context: { template: templateName, lang: templateLang, results: perPhone },
  }).then(
    () => {},
    (err: unknown) =>
      console.error(
        `[alertOperators] could not log outcome: ${err instanceof Error ? err.message : String(err)}`,
      ),
  );

  return result;
}
