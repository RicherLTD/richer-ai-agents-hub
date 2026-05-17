// re-engage-cold-leads/index.ts
//
// Cron-fired endpoint that nudges conversations that have gone silent.
//
// What counts as "cold":
//   - status = 'active' (not paused / completed / opted_out)
//   - current_tag NOT IN ('zoom_scheduled','opted_out','ghosted',
//     'underage','requires_human')  → don't nudge leads that the
//     operator already routed elsewhere.
//   - last_interaction_at between 24h and 7d ago — old enough to be
//     dormant, fresh enough that re-engagement is still relevant.
//   - re_engaged_at IS NULL — we only nudge ONCE per lead. After that
//     we accept they\\'re not coming back.
//   - agents.is_paused = false — respect the kill switch.
//
// Flow per match:
//   1. Send one canned Hebrew follow-up via HookMyApp.
//   2. Insert an outbound message row.
//   3. Stamp conversations.re_engaged_at = now() so the cron doesn\\'t
//      pick this row again.
//
// Auth model: this is an internal cron-triggered endpoint. It accepts
// requests only when the caller presents the CRON_SHARED_SECRET in the
// `Authorization: Bearer <secret>` header. We do NOT use requireAdmin
// because pg_cron / external schedulers can\\'t carry user JWTs.
//
// Required env:
//   CRON_SHARED_SECRET, WHATSAPP_API_URL, WHATSAPP_ACCESS_TOKEN,
//   WHATSAPP_PHONE_NUMBER_ID. Auto-injected: SUPABASE_URL,
//   SUPABASE_SERVICE_ROLE_KEY.

import { createClient } from "https://esm.sh/@supabase/supabase-js@2.45.4";
import { corsHeaders } from "../_shared/cors.ts";
import { logError } from "../_shared/logError.ts";
import { sendWhatsAppText } from "../_shared/whatsappSend.ts";

const SOURCE = "re-engage-cold-leads";
const DEFAULT_BATCH = 50;
const MIN_AGE_MS = 24 * 60 * 60 * 1000;
const MAX_AGE_MS = 7 * 24 * 60 * 60 * 1000;

const FOLLOWUP_TEXT =
  "היי 👋 רק רציתי לבדוק מה איתך — אתמול דיברנו וקצת נעלמת. אם זה לא הזמן מתאים, תעדכן ואחזור אליך בעוד שבוע. אם כן — אשמח להמשיך מאיפה שעצרנו.";

// Tags we will NOT nudge — operator already routed these leads.
const SKIP_TAGS: ReadonlySet<string> = new Set([
  "zoom_scheduled",
  "opted_out",
  "ghosted",
  "underage",
  "requires_human",
]);

interface ColdConversation {
  id: string;
  agent_id: string | null;
  lead_phone: string;
  last_interaction_at: string | null;
  current_tag: string | null;
}

function jsonResponse(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { ...corsHeaders, "Content-Type": "application/json" },
  });
}

Deno.serve(async (req) => {
  if (req.method === "OPTIONS") return new Response(null, { headers: corsHeaders });
  if (req.method !== "POST") {
    return jsonResponse({ error: "Method not allowed" }, 405);
  }

  // Auth: shared-secret bearer. pg_cron / external schedulers send this.
  const cronSecret = Deno.env.get("CRON_SHARED_SECRET");
  if (!cronSecret) return jsonResponse({ error: "CRON_SHARED_SECRET not configured" }, 500);
  const auth = req.headers.get("Authorization") ?? "";
  if (auth !== `Bearer ${cronSecret}`) return jsonResponse({ error: "Unauthorized" }, 401);

  const supabaseUrl = Deno.env.get("SUPABASE_URL");
  const serviceRoleKey = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY");
  const apiUrl = Deno.env.get("WHATSAPP_API_URL");
  const accessToken = Deno.env.get("WHATSAPP_ACCESS_TOKEN");
  const phoneId = Deno.env.get("WHATSAPP_PHONE_NUMBER_ID");
  if (!supabaseUrl || !serviceRoleKey) {
    return jsonResponse({ error: "Missing Supabase env" }, 500);
  }
  if (!apiUrl || !accessToken || !phoneId) {
    return jsonResponse({ error: "HookMyApp env not configured" }, 500);
  }

  const admin = createClient(supabaseUrl, serviceRoleKey, {
    auth: { persistSession: false, autoRefreshToken: false },
  });

  // Optional batch-size override from query string.
  const url = new URL(req.url);
  const limitRaw = parseInt(url.searchParams.get("limit") ?? "", 10);
  const limit = Number.isFinite(limitRaw) && limitRaw > 0 && limitRaw <= 200
    ? limitRaw
    : DEFAULT_BATCH;

  const now = Date.now();
  const lt = new Date(now - MIN_AGE_MS).toISOString();
  const gt = new Date(now - MAX_AGE_MS).toISOString();

  // Pull candidates. We filter SKIP_TAGS client-side because Postgres
  // .in() with NULL tags is awkward — easier to over-fetch and trim.
  const { data, error } = await admin
    .from("conversations")
    .select("id, agent_id, lead_phone, last_interaction_at, current_tag, status, re_engaged_at, agents!inner(is_paused)")
    .is("re_engaged_at", null)
    .eq("status", "active")
    .lt("last_interaction_at", lt)
    .gt("last_interaction_at", gt)
    .eq("agents.is_paused", false)
    .limit(limit);
  if (error) {
    await logError({
      admin,
      source: SOURCE,
      errorType: "candidate_query_failed",
      message: error.message,
      context: { lt, gt, limit },
    });
    return jsonResponse({ error: `query failed: ${error.message}` }, 500);
  }
  const candidates = (data ?? []) as unknown as Array<
    ColdConversation & { agents: { is_paused: boolean } }
  >;
  const eligible: ColdConversation[] = candidates.filter(
    (c) => !c.current_tag || !SKIP_TAGS.has(c.current_tag),
  );

  const results = { eligible: eligible.length, sent: 0, failed: 0 };

  for (const conv of eligible) {
    const send = await sendWhatsAppText({
      apiUrl,
      accessToken,
      phoneNumberId: phoneId,
      to: conv.lead_phone,
      body: FOLLOWUP_TEXT,
    });
    if (!send.ok) {
      results.failed++;
      await logError({
        admin,
        source: SOURCE,
        errorType: "re_engage_send_failed",
        level: "warn",
        message: `send failed status=${send.status}`,
        context: { status: send.status, attempts: send.attempts },
        agentId: conv.agent_id,
        conversationId: conv.id,
      });
      continue;
    }
    const ts = new Date().toISOString();
    // Insert outbound row so the operator sees it in the dashboard.
    await admin.from("messages").insert({
      conversation_id: conv.id,
      direction: "outbound",
      message_type: "text",
      content: FOLLOWUP_TEXT,
      timestamp: ts,
      meta_message_id: send.metaMessageId,
    });
    // Mark this conversation as re-engaged so the next cron run skips it.
    await admin
      .from("conversations")
      .update({ re_engaged_at: ts, last_interaction_at: ts })
      .eq("id", conv.id);
    results.sent++;
  }

  return jsonResponse({ ok: true, ...results });
});
