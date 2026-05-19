import { createClient } from "https://esm.sh/@supabase/supabase-js@2.45.4";
import { isQuietHourNow } from "../_shared/quietHours.ts";

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
    .from("scheduled_messages")
    .select("id, agent_id, conversation_id, lead_phone, template_name, template_language, template_variables, attempts, agents!inner(is_paused, quiet_hours_start_il, quiet_hours_end_il)")
    .eq("status", "pending")
    .lte("scheduled_for", nowIso)
    .eq("agents.is_paused", false)
    .order("scheduled_for", { ascending: true })
    .limit(limit);
  if (pickErr) return j({ error: pickErr.message }, 500);
  type Row = {
    id: string;
    agent_id: string;
    conversation_id: string | null;
    lead_phone: string;
    template_name: string;
    template_language: string;
    template_variables: unknown;
    attempts: number;
    agents: { is_paused: boolean; quiet_hours_start_il: number | null; quiet_hours_end_il: number | null };
  };
  const rows = (candidates ?? []) as unknown as Row[];
  const results = { picked: rows.length, sent: 0, failed: 0, deferred_quiet_hours: 0 };
  for (const row of rows) {
    if (isQuietHourNow({ startIl: row.agents.quiet_hours_start_il, endIl: row.agents.quiet_hours_end_il })) {
      results.deferred_quiet_hours++;
      continue;
    }
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
    const res = await fetch(`${apiUrl}/${phoneId}/messages`, {
      method: "POST",
      headers: { Authorization: `Bearer ${token}`, "Content-Type": "application/json" },
      body: JSON.stringify(body),
    });
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
      await admin.from("scheduled_messages").update({
        status: row.attempts + 1 >= 3 ? "failed" : "pending",
        attempts: row.attempts + 1,
        last_error: sanitised,
      }).eq("id", row.id);
      results.failed++;
    }
  }
  return j({ ok: true, ...results });
});
