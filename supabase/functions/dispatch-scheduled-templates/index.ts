import { createClient } from "https://esm.sh/@supabase/supabase-js@2.45.4";
import { isQuietHourNow } from "../_shared/quietHours.ts";
import { alertOperators } from "../_shared/alertOperators.ts";
import { toCanonicalPhone } from "../_shared/normalizePhone.ts";
import { partitionOptedOut } from "../_shared/optOutFilter.ts";
import { fetchOptedOutSet } from "../_shared/optedOutLookup.ts";
import { isRecentInbound } from "../_shared/warmingDefer.ts";
import {
  computeWarmingAllowance,
  israelDayStartIso,
  sortByReleasePriority,
} from "../_shared/warmingRelease.ts";

const BLOCKING_TAGS = new Set(["zoom_scheduled", "opted_out", "requires_human", "underage"]);

function j(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), { status, headers: { "Content-Type": "application/json" } });
}

Deno.serve(async (req) => {
  if (req.method !== "POST") return j({ error: "POST only" }, 405);
  const cronSecret = Deno.env.get("CRON_SHARED_SECRET");
  if (!cronSecret) return j({ error: "CRON_SHARED_SECRET missing" }, 500);
  const auth = req.headers.get("Authorization") ?? "";
  if (auth !== `Bearer ${cronSecret}`) return j({ error: "Unauthorized" }, 401);

  const apiUrl = Deno.env.get("WHATSAPP_API_URL") ?? "";
  const phoneId = Deno.env.get("WHATSAPP_PHONE_NUMBER_ID") ?? "";
  const token = Deno.env.get("WHATSAPP_ACCESS_TOKEN") ?? "";

  const url = new URL(req.url);

  // Diagnostic mode — returns the configured Meta endpoint and a token
  // prefix. Useful to verify the function is talking to graph.facebook.com
  // (production) vs HookMyApp sandbox. Auth-gated.
  if (url.searchParams.get("diag") === "1") {
    return j({
      diag: true,
      whatsapp_api_url: apiUrl,
      whatsapp_phone_number_id: phoneId,
      access_token_prefix: token.slice(0, 6),
      access_token_length: token.length,
      looks_like_meta_token: token.startsWith("EAA"),
      hint: apiUrl.includes("graph.facebook.com")
        ? "PRODUCTION - Meta directly"
        : apiUrl.includes("hookmyapp")
        ? "SANDBOX - HookMyApp proxy"
        : `unknown URL: ${apiUrl}`,
    });
  }

  const supabaseUrl = Deno.env.get("SUPABASE_URL");
  const serviceRoleKey = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY");
  if (!supabaseUrl || !serviceRoleKey) return j({ error: "missing supabase env" }, 500);
  if (!apiUrl || !token || !phoneId) return j({ error: "missing whatsapp env" }, 500);

  const admin = createClient(supabaseUrl, serviceRoleKey, { auth: { persistSession: false, autoRefreshToken: false } });

  // test_alert: fire the operator-alert canary to verify the alert path.
  // Body: { agent_id }. Sends a canned "this is a test" message to each
  // phone in agents.operator_alert_phones. No touching of real
  // conversations.
  if (url.searchParams.get("test_alert") === "1") {
    const dashboardBaseUrl = Deno.env.get("DASHBOARD_BASE_URL") ?? null;
    let payload: { agent_id?: string };
    try { payload = await req.json(); } catch { return j({ error: "invalid JSON" }, 400); }
    const agentId = payload.agent_id;
    if (!agentId) return j({ error: "agent_id required" }, 400);
    const { data: agent } = await admin.from("agents").select("operator_alert_phones, name").eq("id", agentId).maybeSingle();
    const rawPhones = agent?.operator_alert_phones;
    const phones: string[] = Array.isArray(rawPhones)
      ? (rawPhones as unknown[]).filter((p): p is string => typeof p === "string" && p.length > 0)
      : [];
    if (phones.length === 0) return j({ error: "no operator_alert_phones configured" }, 400);
    const link = dashboardBaseUrl ? `${dashboardBaseUrl.replace(/\/$/, "")}/conversations` : null;
    const body = [
      "🧪 בדיקת התראה",
      "",
      "זאת רק בדיקה שמוודאת שאתה מקבל התראות מהבוט",
      "כש־ליד נתקע. אם קיבלת את ההודעה הזאת — המערכת חיה.",
      "",
      `*סוכן:* ${agent?.name ?? "unknown"}`,
      `*מקבלים התראה:* ${phones.length} מספרים`,
      ...(link ? ["", `*דשבורד:* ${link}`] : []),
    ].join("\n");
    const results = { sent: 0, failed: 0 };
    for (const phone of phones) {
      const res = await fetch(`${apiUrl}/${phoneId}/messages`, {
        method: "POST",
        headers: { Authorization: `Bearer ${token}`, "Content-Type": "application/json" },
        body: JSON.stringify({ messaging_product: "whatsapp", to: phone, type: "text", text: { body } }),
      });
      if (res.ok) results.sent++; else results.failed++;
    }
    return j({ ok: true, phones_count: phones.length, ...results });
  }

  // send_text: admin-only one-shot free-text send to an existing
  // conversation. Used by Claude/operator to catch up to a stuck lead
  // without going through whatsapp-send (which requires user JWT).
  if (url.searchParams.get("send_text") === "1") {
    let payload: { conversation_id?: string; body?: string };
    try { payload = await req.json(); } catch { return j({ error: "invalid JSON" }, 400); }
    const convoId = payload.conversation_id;
    const text = (payload.body ?? "").trim();
    if (!convoId || !text) return j({ error: "conversation_id + body required" }, 400);
    if (text.length > 1500) return j({ error: "body too long" }, 400);
    const { data: convo } = await admin.from("conversations").select("id, lead_phone, agent_id").eq("id", convoId).maybeSingle();
    if (!convo) return j({ error: "conversation not found" }, 404);
    const lead_phone = convo.lead_phone as string;
    const res = await fetch(`${apiUrl}/${phoneId}/messages`, {
      method: "POST",
      headers: { Authorization: `Bearer ${token}`, "Content-Type": "application/json" },
      body: JSON.stringify({ messaging_product: "whatsapp", to: lead_phone, type: "text", text: { body: text } }),
    });
    const respText = await res.text().catch(() => "");
    if (!res.ok) return j({ error: "meta send failed", status: res.status, body: respText.slice(0, 500) }, 502);
    let wamid: string | null = null;
    try { const parsed = JSON.parse(respText); wamid = parsed?.messages?.[0]?.id ?? null; } catch { /* */ }
    const ts = new Date().toISOString();
    await admin.from("messages").insert({ conversation_id: convoId, direction: "outbound", message_type: "text", content: text, timestamp: ts, meta_message_id: wamid });
    await admin.from("conversations").update({ last_interaction_at: ts }).eq("id", convoId);
    return j({ ok: true, wamid, sent_at: ts });
  }

  // Normal mode (default, called by pg_cron): drain due scheduled_messages.
  const limitRaw = parseInt(url.searchParams.get("limit") ?? "", 10);
  const limit = Number.isFinite(limitRaw) && limitRaw > 0 && limitRaw <= 200 ? limitRaw : 50;
  const nowIso = new Date().toISOString();
  const { data: candidates, error: pickErr } = await admin
    .rpc("claim_scheduled_messages", { p_limit: limit, p_now: nowIso });
  if (pickErr) return j({ error: pickErr.message }, 500);
  type Row = {
    id: string;
    agent_id: string;
    conversation_id: string | null;
    lead_phone: string;
    lead_name: string | null;
    template_name: string;
    template_language: string;
    template_variables: unknown;
    attempts: number;
    agent_is_paused: boolean;
    agent_quiet_hours_start_il: number | null;
    agent_quiet_hours_end_il: number | null;
    conversation_status: string | null;
    conversation_current_tag: string | null;
    conversation_manual_mode_since: string | null;
  };
  const rows = (candidates ?? []) as unknown as Row[];

  // Phone-level opt-out re-check (belt-and-suspenders). A lead can opt out
  // AFTER a row was enqueued (e.g. a broadcast queued minutes ago). The
  // conversation-tag/status check inside the loop only catches opt-outs already
  // reflected as a conversation tag; this reads the opt_outs table directly and
  // cancels — never sends. Non-opted-out rows are untouched (identical path).
  const batchPhones = [
    ...new Set(rows.map((r) => toCanonicalPhone(r.lead_phone)).filter((p): p is string => !!p)),
  ];
  const optedOutSet = await fetchOptedOutSet(admin, batchPhones);
  const { keep: sendableRows, cancel: optedOutRows } = partitionOptedOut(rows, optedOutSet, toCanonicalPhone);
  const results = { picked: rows.length, sent: 0, failed: 0, deferred_quiet_hours: 0, deferred_manual_mode: 0, deferred_warming_active_chat: 0, deferred_warming_paced: 0, cancelled: 0 };
  let auth401AlertSent = false;

  // CRM-warming rows need two facts the claim RPC doesn't return: whether the
  // row IS a warming row, and when the lead last wrote to us.
  //
  // Deliberately a supplementary query rather than a v4 of
  // claim_scheduled_messages: changing that function's RETURNS TABLE needs a
  // DROP + CREATE (Postgres 42P13), which would couple this deploy to the
  // existing first-touch/broadcast path for no benefit. One extra indexed read
  // per tick is the cheaper trade.
  interface WarmingMeta {
    agentId: string;
    lastInbound: string | null;
    statusSub: number | null;
    scheduledFor: string | null;
    priority: number;
  }
  const warmingById = new Map<string, WarmingMeta>();
  if (sendableRows.length > 0) {
    const { data: kindRows } = await admin
      .from("scheduled_messages")
      .select("id, agent_id, scheduled_for, kind, conversations(last_inbound_at, crm_status_sub)")
      .in("id", sendableRows.map((r) => r.id))
      .eq("kind", "warming");
    for (const kr of kindRows ?? []) {
      // PostgREST returns a to-one embed as an object, but older/looser
      // relationship inference can hand back a single-element array.
      const embedded = (kr as { conversations?: unknown }).conversations;
      const convo = (Array.isArray(embedded) ? embedded[0] : embedded) as
        | { last_inbound_at?: string | null; crm_status_sub?: number | null }
        | null
        | undefined;
      const row = kr as { id: string; agent_id: string; scheduled_for: string | null };
      warmingById.set(row.id, {
        agentId: row.agent_id,
        lastInbound: convo?.last_inbound_at ?? null,
        statusSub: convo?.crm_status_sub ?? null,
        scheduledFor: row.scheduled_for,
        priority: 50,
      });
    }
  }

  // Release priority lives on crm_status_rules, keyed on (agent_id, status_sub).
  // Read at send time rather than stamped at enqueue, so an operator who
  // re-prioritises a status in the dashboard reorders the queue that already
  // exists — which is the entire point of having a priority.
  if (warmingById.size > 0) {
    const statusSubs = [
      ...new Set([...warmingById.values()].map((w) => w.statusSub).filter((s): s is number => s !== null)),
    ];
    const agentIds = [...new Set([...warmingById.values()].map((w) => w.agentId))];
    if (statusSubs.length > 0) {
      const { data: ruleRows } = await admin
        .from("crm_status_rules")
        .select("agent_id, status_sub, release_priority")
        .in("agent_id", agentIds)
        .in("status_sub", statusSubs);
      const priorityByKey = new Map<string, number>();
      for (const rr of ruleRows ?? []) {
        const r = rr as { agent_id: string; status_sub: number; release_priority: number | null };
        priorityByKey.set(`${r.agent_id}:${r.status_sub}`, r.release_priority ?? 50);
      }
      for (const meta of warmingById.values()) {
        if (meta.statusSub === null) continue;
        meta.priority = priorityByKey.get(`${meta.agentId}:${meta.statusSub}`) ?? 50;
      }
    }
  }

  // The bank's release gate. Per agent: how many warming messages may leave
  // right now, given the minimum gap since the last one and the daily cap.
  //
  // Without this the dispatcher claims up to 50 due rows and sends them in a
  // tight loop — fifty templates from one WhatsApp number in seconds, to leads
  // whose opt-in we cannot prove. That is the fastest way to lose the number
  // the live bot depends on.
  const warmingApprovedIds = new Set<string>();
  const dayStartIso = israelDayStartIso();
  for (const agentId of new Set([...warmingById.values()].map((w) => w.agentId))) {
    const { data: agentCfg } = await admin
      .from("agents")
      .select("warming_min_gap_seconds, warming_daily_cap")
      .eq("id", agentId)
      .maybeSingle();

    const { data: lastSentRow } = await admin
      .from("scheduled_messages")
      .select("sent_at")
      .eq("agent_id", agentId)
      .eq("kind", "warming")
      .eq("status", "sent")
      .not("sent_at", "is", null)
      .order("sent_at", { ascending: false })
      .limit(1)
      .maybeSingle();

    const { count: sentToday } = await admin
      .from("scheduled_messages")
      .select("id", { count: "exact", head: true })
      .eq("agent_id", agentId)
      .eq("kind", "warming")
      .eq("status", "sent")
      .gte("sent_at", dayStartIso);

    const allowance = computeWarmingAllowance({
      lastSentAt: (lastSentRow?.sent_at as string | null) ?? null,
      sentToday: sentToday ?? 0,
      minGapSeconds: (agentCfg?.warming_min_gap_seconds as number | null) ?? 90,
      dailyCap: (agentCfg?.warming_daily_cap as number | null) ?? 50,
    });
    if (allowance.allowed <= 0) continue;

    // Only rows that would actually survive the per-lead checks compete for a
    // slot — otherwise a lead who is mid-conversation would consume today's
    // allowance and then be deferred anyway.
    const candidates = [...warmingById.entries()]
      .filter(([, m]) => m.agentId === agentId && !isRecentInbound(m.lastInbound))
      .map(([id, m]) => ({ id, release_priority: m.priority, scheduled_for: m.scheduledFor }));

    for (const row of sortByReleasePriority(candidates).slice(0, allowance.allowed)) {
      warmingApprovedIds.add(row.id);
    }
  }

  // Per-channel WhatsApp credentials. The dispatcher serves ALL agents, so it
  // must send each agent's template FROM that agent's own channel — otherwise
  // Meta rejects the template with #132001 (the template lives on the agent's
  // WABA, not the global/affiliate one). Keyed by whatsapp_phone_number_id;
  // any agent whose channel isn't explicitly configured falls back to the
  // global (affiliate) creds — i.e. unchanged behavior for affiliate.
  const channelByPhoneId = new Map<string, { apiUrl: string; token: string }>();
  const addChannel = (pid?: string | null, u?: string | null, t?: string | null) => {
    if (pid && u && t) channelByPhoneId.set(pid, { apiUrl: u, token: t });
  };
  addChannel(phoneId, apiUrl, token); // affiliate / default (unsuffixed env)
  addChannel(
    Deno.env.get("WHATSAPP_PHONE_NUMBER_ID_DM"),
    Deno.env.get("WHATSAPP_API_URL_DM"),
    Deno.env.get("WHATSAPP_ACCESS_TOKEN_DM"),
  );
  // Map each batch agent_id -> its whatsapp_phone_number_id (from the DB).
  const agentPhoneById = new Map<string, string>();
  const batchAgentIds = [...new Set(rows.map((r) => r.agent_id))];
  if (batchAgentIds.length > 0) {
    const { data: agentRows } = await admin
      .from("agents")
      .select("id, whatsapp_phone_number_id")
      .in("id", batchAgentIds);
    for (const a of agentRows ?? []) {
      const pid = (a as { whatsapp_phone_number_id?: string | null }).whatsapp_phone_number_id;
      if (pid) agentPhoneById.set(a.id as string, pid);
    }
  }
  // Resolve the sending channel for a row's agent (falls back to global creds).
  const channelFor = (agentId: string): { apiUrl: string; token: string; phoneId: string } => {
    const pid = agentPhoneById.get(agentId);
    const ch = pid ? channelByPhoneId.get(pid) : undefined;
    return ch ? { apiUrl: ch.apiUrl, token: ch.token, phoneId: pid! } : { apiUrl, token, phoneId };
  };
  for (const row of optedOutRows) {
    await admin.from("scheduled_messages").update({ status: "cancelled", claimed_at: null, last_error: "opted_out_before_send" }).eq("id", row.id);
    results.cancelled++;
  }
  for (const row of sendableRows) {
    // Skip rows whose conversation is paused or in a terminal tag — the template
    // would land in a conversation the agent cannot reply to. Cancel rather than
    // defer so the row doesn't keep re-claiming.
    if (
      (row.conversation_status !== null && row.conversation_status !== "active") ||
      (row.conversation_current_tag !== null && BLOCKING_TAGS.has(row.conversation_current_tag))
    ) {
      await admin.from("scheduled_messages").update({ status: "cancelled", claimed_at: null }).eq("id", row.id);
      results.cancelled = (results.cancelled ?? 0) + 1;
      continue;
    }
    if (row.conversation_manual_mode_since) {
      // Operator took manual control of this conversation — don't fire a
      // queued template into an active human-handled chat. DEFER (not
      // cancel): release the claim so the row stays pending and retries
      // once the operator hands the conversation back to AI.
      await admin.from("scheduled_messages").update({ claimed_at: null }).eq("id", row.id);
      results.deferred_manual_mode++;
      continue;
    }
    // CRM warming only: don't knock on a live conversation. The opener is a
    // generic "היי, מה קורה?" — firing it while the bot is mid-exchange with
    // the lead reads as a non-sequitur, and can arrive while the agent loop is
    // still generating its reply to the lead's last message.
    //
    // DEFER, never cancel: the row stays pending and goes out on a later tick
    // once the lead has gone quiet, which is exactly when a re-engagement
    // nudge is worth sending. Meanwhile the warming context is already on the
    // conversation, so the bot handles the objection on its very next turn
    // regardless of whether this template ever fires.
    if (warmingById.has(row.id)) {
      const meta = warmingById.get(row.id)!;
      if (isRecentInbound(meta.lastInbound)) {
        await admin.from("scheduled_messages").update({ claimed_at: null }).eq("id", row.id);
        results.deferred_warming_active_chat++;
        continue;
      }
      // Not picked by the release gate this tick — either the daily cap is
      // spent, the minimum gap has not elapsed, or a higher-priority lead took
      // the slot. Defer, never cancel: it competes again on the next tick.
      if (!warmingApprovedIds.has(row.id)) {
        await admin.from("scheduled_messages").update({ claimed_at: null }).eq("id", row.id);
        results.deferred_warming_paced++;
        continue;
      }
    }
    if (isQuietHourNow({ startIl: row.agent_quiet_hours_start_il, endIl: row.agent_quiet_hours_end_il })) {
      results.deferred_quiet_hours++;
      continue;
    }
    const ch = channelFor(row.agent_id);
    const variables: string[] = Array.isArray(row.template_variables)
      ? (row.template_variables as unknown[]).filter((v) => typeof v === "string") as string[]
      : [];
    const body = {
      messaging_product: "whatsapp",
      to: row.lead_phone,
      type: "template",
      template: {
        name: row.template_name,
        language: { code: row.template_language },
        components: variables.length === 0
          ? []
          : [{ type: "body", parameters: variables.map((v) => ({ type: "text", text: v })) }],
      },
    };
    const ac = new AbortController();
    const timer = setTimeout(() => ac.abort(), 15_000);
    let res: Response;
    try {
      res = await fetch(`${ch.apiUrl}/${ch.phoneId}/messages`, {
        method: "POST",
        headers: { Authorization: `Bearer ${ch.token}`, "Content-Type": "application/json" },
        body: JSON.stringify(body),
        signal: ac.signal,
      });
    } catch (fetchErr) {
      clearTimeout(timer);
      // Timeout or network error — clear claim so next tick can retry.
      await admin.from("scheduled_messages").update({ claimed_at: null, attempts: row.attempts + 1 }).eq("id", row.id);
      results.failed++;
      continue;
    }
    clearTimeout(timer);
    const text = await res.text().catch(() => "");
    if (res.ok) {
      let wamid: string | null = null;
      try { const p = JSON.parse(text); wamid = p?.messages?.[0]?.id ?? null; } catch { /* */ }
      const ts = new Date().toISOString();
      if (row.conversation_id) {
        await admin.from("messages").insert({
          conversation_id: row.conversation_id,
          direction: "outbound",
          message_type: "text",
          content: `[template:${row.template_name}]`,
          timestamp: ts,
          meta_message_id: wamid,
        });
      }
      await admin.from("scheduled_messages").update({
        status: "sent",
        sent_at: ts,
        meta_message_id: wamid,
        attempts: row.attempts + 1,
      }).eq("id", row.id);
      results.sent++;
    } else {
      const sanitised = text.slice(0, 500);
      await admin.from("error_logs").insert({
        level: "error",
        source: "dispatch-scheduled-templates",
        error_type: "template_send_failed",
        message: `status=${res.status}`,
        context: { status: res.status, body: sanitised },
        agent_id: row.agent_id,
        conversation_id: row.conversation_id,
      });
      // 401/403 = auth failure — retrying won't help; fail immediately and alert once per tick
      if (res.status === 401 || res.status === 403) {
        if (!auth401AlertSent && row.conversation_id) {
          auth401AlertSent = true;
          alertOperators({
            admin,
            apiUrl: ch.apiUrl,
            accessToken: ch.token,
            phoneNumberId: ch.phoneId,
            agentId: row.agent_id,
            conversationId: row.conversation_id,
            leadPhone: row.lead_phone,
            failureType: `template_auth_${res.status}`,
            failureDetail: `WHATSAPP_ACCESS_TOKEN לא תקין — יש לחדש ב-Supabase Secrets`,
          }).catch(() => {});
        }
        await admin.from("scheduled_messages").update({
          status: "failed",
          claimed_at: null,
          last_error: `auth_error_${res.status}`,
        }).eq("id", row.id);
        results.failed++;
        continue;
      }
      await admin.from("scheduled_messages").update({
        status: row.attempts + 1 >= 3 ? "failed" : "pending",
        claimed_at: row.attempts + 1 >= 3 ? undefined : null,  // release claim for retry
        attempts: row.attempts + 1,
        last_error: sanitised,
      }).eq("id", row.id);
      results.failed++;
    }
  }
  return j({ ok: true, ...results });
});
