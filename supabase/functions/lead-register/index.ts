// lead-register/index.ts
//
// Inbound endpoint for landing-page lead registrations (called from
// Make.com's central webhook). Flow:
//
//   1. Validate the payload (agent slug + phone + name minimum).
//   2. Resolve agent → look up first_touch_template_* config.
//   3. Upsert conversation (race-safe via UNIQUE(agent_id, lead_phone)).
//   4. Upsert lead_memory with q7_email pre-populated from the form.
//   5. Enqueue a scheduled_messages row at now() + delay_minutes.
//
// Authentication:
//   Shared-secret bearer header — `Authorization: Bearer <LEAD_REGISTER_SHARED_SECRET>`.
//   Make.com sets this in its HTTP module. JWT auth isn't an option
//   because Make doesn't carry Supabase user sessions.
//
// Idempotency:
//   If the same lead registers twice within the delay window we DO NOT
//   enqueue a second template send — the unique (agent_id, lead_phone)
//   on conversations + a SELECT for an open scheduled row absorbs the
//   duplicate. Operator sees both registrations in audit but the lead
//   receives one template, not two.
//
// Required env:
//   LEAD_REGISTER_SHARED_SECRET — bearer secret from Make.
//   Auto-injected: SUPABASE_URL, SUPABASE_SERVICE_ROLE_KEY.

import { createClient, type SupabaseClient } from "https://esm.sh/@supabase/supabase-js@2.45.4";
import { corsHeaders } from "../_shared/cors.ts";
import { logError } from "../_shared/logError.ts";
import { toCanonicalPhone } from "../_shared/normalizePhone.ts";
import { buildEmbedUrl } from "../_shared/embedLink.ts";

const SOURCE = "lead-register";

interface LeadRegisterPayload {
  agent_slug: string;
  lead_phone: string;
  lead_name: string;
  lead_email?: string | null;
  product?: string | null;
  source_campaign?: string | null;
  source_funnel?: string | null;
}

function jsonResponse(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { ...corsHeaders, "Content-Type": "application/json" },
  });
}

function asTrimmedString(v: unknown): string | null {
  if (typeof v !== "string") return null;
  const t = v.trim();
  return t.length === 0 ? null : t;
}

/** Email coercion mirrors extractMemory.asEmail. */
function coerceEmail(v: unknown): string | null {
  if (typeof v !== "string") return null;
  const t = v.trim().toLowerCase();
  if (t.length === 0 || t.length > 254) return null;
  const at = t.indexOf("@");
  if (at <= 0 || at === t.length - 1) return null;
  const domain = t.slice(at + 1);
  if (!domain.includes(".")) return null;
  return t;
}

function coercePayload(raw: unknown): LeadRegisterPayload | null {
  if (!raw || typeof raw !== "object") return null;
  const o = raw as Record<string, unknown>;
  const agent_slug = asTrimmedString(o.agent_slug);
  const lead_phone_raw = asTrimmedString(o.lead_phone);
  const lead_name = asTrimmedString(o.lead_name);
  if (!agent_slug || !lead_phone_raw || !lead_name) return null;
  const lead_phone = toCanonicalPhone(lead_phone_raw);
  if (!lead_phone) return null;
  return {
    agent_slug,
    lead_phone,
    lead_name,
    lead_email: coerceEmail(o.lead_email),
    product: asTrimmedString(o.product),
    source_campaign: asTrimmedString(o.source_campaign),
    source_funnel: asTrimmedString(o.source_funnel),
  };
}

interface AgentConfig {
  id: string;
  is_paused: boolean;
  mooz_product_code: string | null;
  first_touch_template_name: string | null;
  first_touch_template_language: string;
  first_touch_delay_minutes: number;
}

async function loadAgent(
  admin: SupabaseClient,
  agentSlug: string,
): Promise<AgentConfig | null> {
  const { data } = await admin
    .from("agents")
    .select(
      "id, is_paused, mooz_product_code, first_touch_template_name, first_touch_template_language, first_touch_delay_minutes",
    )
    .eq("name", agentSlug)
    .maybeSingle();
  if (!data) return null;
  return {
    id: data.id as string,
    is_paused: (data.is_paused as boolean | null) ?? false,
    mooz_product_code: (data.mooz_product_code as string | null) ?? null,
    first_touch_template_name: (data.first_touch_template_name as string | null) ?? null,
    first_touch_template_language:
      (data.first_touch_template_language as string | null) ?? "he",
    first_touch_delay_minutes:
      (data.first_touch_delay_minutes as number | null) ?? 40,
  };
}

/**
 * Deterministic, non-expiring link to this lead's conversation view.
 * Written by Make into the Fireberry field `pcfconveraiagent`.
 * Best-effort: never throws, never blocks registration. Returns null if
 * EMBED_LINK_SECRET / DASHBOARD_BASE_URL aren't configured or the agent has
 * no mooz_product_code set.
 */
async function computeConversationViewUrl(
  agent: AgentConfig,
  leadPhone: string,
): Promise<string | null> {
  const embedSecret = Deno.env.get("EMBED_LINK_SECRET");
  const dashboardBase = Deno.env.get("DASHBOARD_BASE_URL");
  if (!embedSecret || !dashboardBase || !agent.mooz_product_code) return null;
  try {
    return await buildEmbedUrl(dashboardBase, leadPhone, agent.mooz_product_code, embedSecret);
  } catch {
    return null;
  }
}

async function upsertConversation(
  admin: SupabaseClient,
  agentId: string,
  payload: LeadRegisterPayload,
): Promise<string> {
  // UPDATE-first: touch only safe fields, never overwrite status/funnel stage.
  // source_campaign / source_funnel are only set when the existing value is null
  // (coalesce semantics via .is("source_campaign", null) guard is impractical in
  // a single UPDATE — we rely on the DB defaults; if already set we skip them).
  const updateSet: Record<string, string | null> = {};
  if (payload.lead_name !== null) updateSet.lead_name = payload.lead_name;

  const { count: updateCount, error: updateError } = await admin
    .from("conversations")
    .update(updateSet)
    .eq("agent_id", agentId)
    .eq("lead_phone", payload.lead_phone)
    .select("id", { count: "exact", head: true });

  if (updateError) throw new Error(`update conversation failed: ${updateError.message}`);

  if ((updateCount ?? 0) > 0) {
    // Row already existed — fetch its id.
    const { data: existing, error: selectError } = await admin
      .from("conversations")
      .select("id")
      .eq("agent_id", agentId)
      .eq("lead_phone", payload.lead_phone)
      .single();
    if (selectError) throw new Error(`select conversation failed: ${selectError.message}`);
    return existing.id as string;
  }

  // Row did not exist — INSERT with status: "active".
  // First touch is OUTBOUND — conversation starts "active" because the
  // bot is expected to handle the reply when it lands.
  const { data: inserted, error: insertError } = await admin
    .from("conversations")
    .insert({
      agent_id: agentId,
      lead_phone: payload.lead_phone,
      lead_name: payload.lead_name,
      status: "active",
      source_campaign: payload.source_campaign,
      source_funnel: payload.source_funnel ?? payload.product,
    })
    .select("id")
    .single();

  if (insertError) {
    // Race: another request inserted the row between our UPDATE and INSERT.
    if (insertError.code === "23505") {
      const { data: raceRow, error: raceSelectError } = await admin
        .from("conversations")
        .select("id")
        .eq("agent_id", agentId)
        .eq("lead_phone", payload.lead_phone)
        .single();
      if (raceSelectError) throw new Error(`fallback select failed: ${raceSelectError.message}`);
      return raceRow.id as string;
    }
    throw new Error(`insert conversation failed: ${insertError.message}`);
  }

  return inserted.id as string;
}

async function upsertLeadMemoryEmail(
  admin: SupabaseClient,
  conversationId: string,
  email: string | null,
): Promise<void> {
  // We only touch the email field — don't blow away any extraction work
  // that may have already happened (re-registration of an existing lead).
  if (!email) return;
  const { error } = await admin
    .from("lead_memory")
    .upsert(
      {
        conversation_id: conversationId,
        q7_email: email,
        updated_at: new Date().toISOString(),
      },
      { onConflict: "conversation_id", ignoreDuplicates: false },
    );
  if (error) throw new Error(`upsert lead_memory failed: ${error.message}`);
}

async function enqueueScheduledTemplate(
  admin: SupabaseClient,
  args: {
    agentId: string;
    conversationId: string;
    payload: LeadRegisterPayload;
    templateName: string;
    templateLanguage: string;
    delayMinutes: number;
  },
): Promise<{ enqueued: boolean; scheduledFor: string }> {
  // Idempotency: skip enqueue if a pending template exists, OR if a template
  // was already sent within the last 24 hours (re-registration guard).
  const cutoff24h = new Date(Date.now() - 24 * 60 * 60 * 1000).toISOString();
  const { data: existing } = await admin
    .from("scheduled_messages")
    .select("id, scheduled_for, status")
    .eq("conversation_id", args.conversationId)
    .or(
      `status.eq.pending,and(status.eq.sent,scheduled_for.gte.${cutoff24h})`,
    )
    .order("scheduled_for", { ascending: false })
    .limit(1)
    .maybeSingle();
  if (existing) {
    return { enqueued: false, scheduledFor: existing.scheduled_for as string };
  }

  const scheduledFor = new Date(Date.now() + args.delayMinutes * 60_000).toISOString();
  // The first-touch template (as approved in Meta) has NO body placeholders,
  // so we MUST send zero parameters — any param triggers Meta error #132000
  // ("number of params does not match the expected number"). Name/product
  // personalization belongs in the Make→Fireberry flow, NOT the WhatsApp
  // template. (If a future template adds {{1}}/{{2}}, source them from
  // agents.first_touch_template_variables_template — never hardcode here.)
  const variables: string[] = [];
  const { error } = await admin
    .from("scheduled_messages")
    .insert({
      agent_id: args.agentId,
      conversation_id: args.conversationId,
      lead_phone: args.payload.lead_phone,
      lead_name: args.payload.lead_name,
      template_name: args.templateName,
      template_language: args.templateLanguage,
      template_variables: variables,
      source_campaign: args.payload.source_campaign,
      source_funnel: args.payload.source_funnel ?? args.payload.product,
      scheduled_for: scheduledFor,
      status: "pending",
    });
  if (error) throw new Error(`enqueue scheduled_message failed: ${error.message}`);
  return { enqueued: true, scheduledFor };
}

Deno.serve(async (req) => {
  if (req.method === "OPTIONS") return new Response(null, { headers: corsHeaders });
  if (req.method !== "POST") {
    return jsonResponse({ error: "Method not allowed" }, 405);
  }

  // Auth — shared secret.
  const sharedSecret = Deno.env.get("LEAD_REGISTER_SHARED_SECRET");
  if (!sharedSecret) {
    return jsonResponse({ error: "LEAD_REGISTER_SHARED_SECRET not configured" }, 500);
  }
  const auth = req.headers.get("Authorization") ?? "";
  if (auth !== `Bearer ${sharedSecret}`) {
    return jsonResponse({ error: "Unauthorized" }, 401);
  }

  // Supabase admin client.
  const supabaseUrl = Deno.env.get("SUPABASE_URL");
  const serviceRoleKey = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY");
  if (!supabaseUrl || !serviceRoleKey) {
    return jsonResponse({ error: "Missing Supabase env" }, 500);
  }
  const admin = createClient(supabaseUrl, serviceRoleKey, {
    auth: { persistSession: false, autoRefreshToken: false },
  });

  // Parse + validate.
  let raw: unknown;
  try {
    raw = await req.json();
  } catch {
    return jsonResponse({ error: "Invalid JSON" }, 400);
  }
  const payload = coercePayload(raw);
  if (!payload) {
    await logError({
      admin,
      source: SOURCE,
      errorType: "lead_register_validation_failed",
      level: "warn",
      message: "rejected an inbound payload — required field missing or phone format invalid",
      context: {
        raw_keys: raw && typeof raw === "object"
          ? Object.keys(raw as Record<string, unknown>)
          : [],
      },
    });
    return jsonResponse(
      {
        error:
          "Validation failed. Required fields: agent_slug (string), lead_phone (Israeli phone), lead_name (string). Optional: lead_email, product, source_campaign, source_funnel.",
      },
      400,
    );
  }

  // Resolve agent.
  const agent = await loadAgent(admin, payload.agent_slug);
  if (!agent) {
    await logError({
      admin,
      source: SOURCE,
      errorType: "agent_not_found",
      message: `no agent matched slug "${payload.agent_slug}"`,
      context: { agent_slug: payload.agent_slug },
    });
    return jsonResponse({ error: `Unknown agent_slug: ${payload.agent_slug}` }, 404);
  }
  if (agent.is_paused) {
    await logError({
      admin,
      source: SOURCE,
      errorType: "agent_paused_skip",
      level: "warn",
      message: "agent is paused — lead registered but no template scheduled",
      context: { agent_slug: payload.agent_slug, lead_phone: payload.lead_phone },
      agentId: agent.id,
    });
    // Still create the conversation row so the lead is visible in the
    // dashboard — just skip the scheduled send.
    try {
      const conversationId = await upsertConversation(admin, agent.id, payload);
      await upsertLeadMemoryEmail(admin, conversationId, payload.lead_email ?? null);
      const conversationViewUrl = await computeConversationViewUrl(agent, payload.lead_phone);
      return jsonResponse({
        ok: true,
        paused: true,
        conversation_id: conversationId,
        conversation_view_url: conversationViewUrl,
      });
    } catch (err) {
      await logError({
        admin,
        source: SOURCE,
        errorType: "paused_path_db_failed",
        message: err instanceof Error ? err.message : String(err),
        context: {},
        agentId: agent.id,
      });
      return jsonResponse({ error: "Internal error" }, 500);
    }
  }
  if (!agent.first_touch_template_name) {
    await logError({
      admin,
      source: SOURCE,
      errorType: "template_not_configured",
      level: "warn",
      message:
        "agent has no first_touch_template_name — lead registered but no template scheduled",
      context: { agent_slug: payload.agent_slug },
      agentId: agent.id,
    });
    try {
      const conversationId = await upsertConversation(admin, agent.id, payload);
      await upsertLeadMemoryEmail(admin, conversationId, payload.lead_email ?? null);
      const conversationViewUrl = await computeConversationViewUrl(agent, payload.lead_phone);
      return jsonResponse({
        ok: true,
        template_not_configured: true,
        conversation_id: conversationId,
        conversation_view_url: conversationViewUrl,
      });
    } catch (err) {
      await logError({
        admin,
        source: SOURCE,
        errorType: "no_template_path_db_failed",
        message: err instanceof Error ? err.message : String(err),
        context: {},
        agentId: agent.id,
      });
      return jsonResponse({ error: "Internal error" }, 500);
    }
  }

  // Happy path.
  try {
    const conversationId = await upsertConversation(admin, agent.id, payload);
    await upsertLeadMemoryEmail(admin, conversationId, payload.lead_email ?? null);
    const queueResult = await enqueueScheduledTemplate(admin, {
      agentId: agent.id,
      conversationId,
      payload,
      templateName: agent.first_touch_template_name,
      templateLanguage: agent.first_touch_template_language,
      delayMinutes: agent.first_touch_delay_minutes,
    });
    const conversationViewUrl = await computeConversationViewUrl(agent, payload.lead_phone);
    return jsonResponse({
      ok: true,
      conversation_id: conversationId,
      conversation_view_url: conversationViewUrl,
      ...queueResult,
    });
  } catch (err) {
    const detail = err instanceof Error ? err.message : String(err);
    await logError({
      admin,
      source: SOURCE,
      errorType: "lead_register_failed",
      message: detail,
      context: { agent_slug: payload.agent_slug, lead_phone: payload.lead_phone },
      agentId: agent.id,
    });
    return jsonResponse({ error: "Internal error", detail }, 500);
  }
});
