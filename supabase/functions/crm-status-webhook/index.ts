// crm-status-webhook/index.ts
//
// Third door into the bot. Fireberry fires a status-change event → Make →
// here. Flow:
//
//   1. Bearer shared-secret auth (Make can't carry a Supabase session).
//   2. Resolve product (B/R) → agent via agents.mooz_product_code.
//   3. Upsert the conversation on (agent_id, lead_phone), UPDATE-first so
//      status / funnel_stage are never clobbered.
//   4. ALWAYS refresh the CRM context on the row — status, label, rep note,
//      event timestamp. The bot must never reason from a stale CRM state.
//   5. Enqueue ONE generic opener template, subject to cooldown.
//
// The decision key is (product, status_sub). Lead identity is the canonical
// phone — fireberry_lead_id is stored when it arrives but is NOT an identity
// key, because nothing guarantees Make populates it.
//
// Division of responsibility with Make: Izak's scenario filters Fireberry down
// to warming-relevant statuses before calling us. There is deliberately NO
// allow-list on this side — blocking statuses (blacklist / invalid lead /
// wrong number) are simply never sent. A status that arrives without a rule
// row falls back to an immediate default.
//
// Two things this endpoint does NOT do, on purpose:
//   * It never sends a message itself. Everything goes through the existing
//     dispatcher so opt-out, quiet hours, blocking tags and manual mode are
//     enforced in exactly one place.
//   * It never talks to the agent loop. Warming is a flag plus injected
//     context on an existing conversation, never a second parallel bot.
//
// Required env:
//   CRM_STATUS_SHARED_SECRET — bearer secret from Make.
//   Auto-injected: SUPABASE_URL, SUPABASE_SERVICE_ROLE_KEY.

import { createClient, type SupabaseClient } from "https://esm.sh/@supabase/supabase-js@2.45.4";
import { corsHeaders } from "../_shared/cors.ts";
import { logError } from "../_shared/logError.ts";
import { type CrmStatusPayload, coercePayload, withinCooldown } from "./validate.ts";

const SOURCE = "crm-status-webhook";

/** Applied when a status arrives with no matching crm_status_rules row. Make
 *  already filtered, so whatever reached us is warming-relevant — warm it now
 *  and let the operator add a tuned rule later. */
const DEFAULT_RULE = {
  status_label: "סטטוס לא מוגדר",
  objection_key: "unknown",
  warming_instructions:
    "נציג עדכן את סטטוס הליד ב-CRM, אך אין הנחיה מוגדרת לסטטוס הזה. אין לך מידע על ההתנגדות. פתח שיחה קלילה, גלה בעצמך תוך כדי הדיאלוג מה עומד מאחורי החשש, ורק אז הובל לתיאום זום.",
  delay_hours: 0,
  cooldown_days: 7,
  clears_zoom_state: false,
} as const;

function jsonResponse(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { ...corsHeaders, "Content-Type": "application/json" },
  });
}

interface AgentConfig {
  id: string;
  name: string | null;
  crm_warming_enabled: boolean;
  warming_template_name: string | null;
  warming_template_language: string;
}

async function loadAgentByProduct(
  admin: SupabaseClient,
  product: string,
): Promise<AgentConfig | null> {
  const { data } = await admin
    .from("agents")
    .select(
      "id, name, crm_warming_enabled, warming_template_name, warming_template_language",
    )
    .eq("mooz_product_code", product)
    .maybeSingle();
  if (!data) return null;
  return {
    id: data.id as string,
    name: (data.name as string | null) ?? null,
    crm_warming_enabled: (data.crm_warming_enabled as boolean | null) ?? false,
    warming_template_name: (data.warming_template_name as string | null) ?? null,
    warming_template_language: (data.warming_template_language as string | null) ?? "he",
  };
}

interface StatusRule {
  status_label: string;
  objection_key: string;
  warming_instructions: string;
  delay_hours: number;
  cooldown_days: number;
  clears_zoom_state: boolean;
}

async function loadStatusRule(
  admin: SupabaseClient,
  agentId: string,
  statusSub: number,
): Promise<{ rule: StatusRule; matched: boolean }> {
  const { data } = await admin
    .from("crm_status_rules")
    .select(
      "status_label, objection_key, warming_instructions, delay_hours, cooldown_days, clears_zoom_state",
    )
    .eq("agent_id", agentId)
    .eq("status_sub", statusSub)
    .eq("is_active", true)
    .maybeSingle();
  if (!data) return { rule: { ...DEFAULT_RULE }, matched: false };
  return {
    rule: {
      status_label: data.status_label as string,
      objection_key: data.objection_key as string,
      warming_instructions: data.warming_instructions as string,
      delay_hours: (data.delay_hours as number | null) ?? 0,
      cooldown_days: (data.cooldown_days as number | null) ?? 7,
      clears_zoom_state: (data.clears_zoom_state as boolean | null) ?? false,
    },
    matched: true,
  };
}

interface ConversationRow {
  id: string;
  inserted: boolean;
  current_tag: string | null;
  crm_last_warmed_at: string | null;
}

/**
 * UPDATE-first / INSERT-fallback / 23505-race-recovery, mirroring
 * lead-register's upsertConversation. Deliberately NOT a PostgREST .upsert():
 * an upsert would clobber status and funnel_stage, and a lead who is mid-funnel
 * must not be reset because a rep changed a CRM field.
 */
async function upsertConversation(
  admin: SupabaseClient,
  agentId: string,
  payload: CrmStatusPayload,
): Promise<ConversationRow> {
  const updateSet: Record<string, string> = {};
  if (payload.lead_name !== null) updateSet.lead_name = payload.lead_name;
  if (payload.fireberry_lead_id !== null) {
    updateSet.fireberry_lead_id = payload.fireberry_lead_id;
  }

  // An UPDATE needs at least one column. When Make sends neither name nor lead
  // id, touch updated_at so the "did a row exist?" probe still works.
  if (Object.keys(updateSet).length === 0) {
    updateSet.updated_at = new Date().toISOString();
  }

  const { count: updateCount, error: updateError } = await admin
    .from("conversations")
    .update(updateSet)
    .eq("agent_id", agentId)
    .eq("lead_phone", payload.lead_phone)
    .select("id", { count: "exact", head: true });

  if (updateError) throw new Error(`update conversation failed: ${updateError.message}`);

  if ((updateCount ?? 0) > 0) {
    const { data: existing, error: selectError } = await admin
      .from("conversations")
      .select("id, current_tag, crm_last_warmed_at")
      .eq("agent_id", agentId)
      .eq("lead_phone", payload.lead_phone)
      .single();
    if (selectError) throw new Error(`select conversation failed: ${selectError.message}`);
    return {
      id: existing.id as string,
      inserted: false,
      current_tag: (existing.current_tag as string | null) ?? null,
      crm_last_warmed_at: (existing.crm_last_warmed_at as string | null) ?? null,
    };
  }

  // No row: a lead who exists in Fireberry but has never reached WhatsApp.
  // status 'active' because the bot is expected to handle the reply.
  const { data: insertedRow, error: insertError } = await admin
    .from("conversations")
    .insert({
      agent_id: agentId,
      lead_phone: payload.lead_phone,
      lead_name: payload.lead_name,
      fireberry_lead_id: payload.fireberry_lead_id,
      status: "active",
    })
    .select("id, current_tag, crm_last_warmed_at")
    .single();

  if (insertError) {
    if (insertError.code === "23505") {
      const { data: raceRow, error: raceSelectError } = await admin
        .from("conversations")
        .select("id, current_tag, crm_last_warmed_at")
        .eq("agent_id", agentId)
        .eq("lead_phone", payload.lead_phone)
        .single();
      if (raceSelectError) throw new Error(`fallback select failed: ${raceSelectError.message}`);
      return {
        id: raceRow.id as string,
        inserted: false,
        current_tag: (raceRow.current_tag as string | null) ?? null,
        crm_last_warmed_at: (raceRow.crm_last_warmed_at as string | null) ?? null,
      };
    }
    throw new Error(`insert conversation failed: ${insertError.message}`);
  }

  return {
    id: insertedRow.id as string,
    inserted: true,
    current_tag: (insertedRow.current_tag as string | null) ?? null,
    crm_last_warmed_at: (insertedRow.crm_last_warmed_at as string | null) ?? null,
  };
}

/**
 * Write the CRM context onto the conversation.
 *
 * `enterWarming` is false when the agent's kill switch is off: the status data
 * is still recorded so the operator can see the traffic building up in the
 * dashboard, but crm_warming_status stays NULL, which is what
 * shouldRenderWarmingBlock keys on — so the prompt is untouched and the kill
 * switch actually kills.
 */
async function writeWarmingContext(
  admin: SupabaseClient,
  args: {
    conversationId: string;
    payload: CrmStatusPayload;
    rule: StatusRule;
    currentTag: string | null;
    enterWarming: boolean;
  },
): Promise<void> {
  const patch: Record<string, unknown> = {
    crm_status_sub: args.payload.status_sub,
    crm_status_main: args.payload.status_main,
    crm_warming_reason: args.rule.status_label,
    crm_rep_note: args.payload.rep_note,
    crm_status_event_at: new Date().toISOString(),
  };

  if (args.enterWarming) {
    patch.crm_warming_status = "warming";
  }

  // A lead who ghosted a booked Zoom still carries the zoom state that made
  // sense yesterday. The dispatcher's blocking tags include 'zoom_scheduled',
  // so without clearing it this send would be cancelled by the lead's own
  // stale tag. Data-driven via the rule, not a hardcoded status number.
  if (args.rule.clears_zoom_state && args.enterWarming) {
    patch.zoom_scheduled_at = null;
    patch.zoom_booked_by = null;
    if (args.currentTag === "zoom_scheduled") {
      patch.current_tag = null;
    }
  }

  const { error } = await admin
    .from("conversations")
    .update(patch)
    .eq("id", args.conversationId);
  if (error) throw new Error(`write warming context failed: ${error.message}`);
}

/**
 * A newer status supersedes an older un-sent one. Without this, a lead marked
 * "price" (15-day delay) and then "no time" two days later would receive the
 * price opener a fortnight after it stopped being true, on top of whatever the
 * newer status queued.
 */
async function supersedePendingWarming(
  admin: SupabaseClient,
  conversationId: string,
): Promise<number> {
  const { data, error } = await admin
    .from("scheduled_messages")
    .update({ status: "cancelled", last_error: "superseded_by_newer_crm_status" })
    .eq("conversation_id", conversationId)
    .eq("kind", "warming")
    .eq("status", "pending")
    .select("id");
  if (error) throw new Error(`supersede pending warming failed: ${error.message}`);
  return data?.length ?? 0;
}

/**
 * How many body parameters the configured opener declares. Meta rejects the
 * whole send with #132000 if the count doesn't match exactly, so we read it
 * from the broadcast_templates registry rather than guessing. An unregistered
 * template is treated as zero-parameter, matching the first-touch precedent in
 * lead-register.
 */
async function loadTemplateVariableCount(
  admin: SupabaseClient,
  agentId: string,
  name: string,
  language: string,
): Promise<number> {
  const { data } = await admin
    .from("broadcast_templates")
    .select("variable_count")
    .eq("agent_id", agentId)
    .eq("name", name)
    .eq("language", language)
    .maybeSingle();
  return (data?.variable_count as number | null) ?? 0;
}

Deno.serve(async (req) => {
  if (req.method === "OPTIONS") return new Response(null, { headers: corsHeaders });
  if (req.method !== "POST") {
    return jsonResponse({ error: "Method not allowed" }, 405);
  }

  const sharedSecret = Deno.env.get("CRM_STATUS_SHARED_SECRET");
  if (!sharedSecret) {
    return jsonResponse({ error: "CRM_STATUS_SHARED_SECRET not configured" }, 500);
  }
  const auth = req.headers.get("Authorization") ?? "";
  if (auth !== `Bearer ${sharedSecret}`) {
    return jsonResponse({ error: "Unauthorized" }, 401);
  }

  const supabaseUrl = Deno.env.get("SUPABASE_URL");
  const serviceRoleKey = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY");
  if (!supabaseUrl || !serviceRoleKey) {
    return jsonResponse({ error: "Missing Supabase env" }, 500);
  }
  const admin = createClient(supabaseUrl, serviceRoleKey, {
    auth: { persistSession: false, autoRefreshToken: false },
  });

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
      errorType: "crm_status_validation_failed",
      level: "warn",
      message: "rejected an inbound payload — required field missing or phone format invalid",
      context: {
        raw_keys: raw && typeof raw === "object" ? Object.keys(raw as Record<string, unknown>) : [],
      },
    });
    return jsonResponse(
      {
        error:
          "Validation failed. Required: product (B|R), lead_phone (Israeli phone), status_sub (int). Optional: status_main, lead_name, rep_note, fireberry_lead_id.",
      },
      400,
    );
  }

  const agent = await loadAgentByProduct(admin, payload.product);
  if (!agent) {
    await logError({
      admin,
      source: SOURCE,
      errorType: "agent_not_found",
      message: `no agent matched product code "${payload.product}"`,
      context: { product: payload.product },
    });
    return jsonResponse({ error: `Unknown product: ${payload.product}` }, 404);
  }

  try {
    const { rule, matched } = await loadStatusRule(admin, agent.id, payload.status_sub);
    if (!matched) {
      await logError({
        admin,
        source: SOURCE,
        errorType: "crm_status_rule_missing",
        level: "warn",
        message: `no rule for status_sub ${payload.status_sub} — applied the immediate default`,
        context: { product: payload.product, status_sub: payload.status_sub },
        agentId: agent.id,
      });
    }

    const conversation = await upsertConversation(admin, agent.id, payload);
    const enterWarming = agent.crm_warming_enabled;

    await writeWarmingContext(admin, {
      conversationId: conversation.id,
      payload,
      rule,
      currentTag: conversation.current_tag,
      enterWarming,
    });

    // Kill switch. Everything above still ran — the lead and the status are
    // recorded and visible in the dashboard — but nothing is queued and the
    // prompt is untouched.
    if (!enterWarming) {
      return jsonResponse({
        ok: true,
        warming_enabled: false,
        conversation_id: conversation.id,
        recorded: true,
        enqueued: false,
      });
    }

    if (!agent.warming_template_name) {
      await logError({
        admin,
        source: SOURCE,
        errorType: "warming_template_not_configured",
        level: "warn",
        message: "agent has no warming_template_name — context recorded but no opener queued",
        context: { product: payload.product, status_sub: payload.status_sub },
        agentId: agent.id,
      });
      return jsonResponse({
        ok: true,
        conversation_id: conversation.id,
        template_not_configured: true,
        enqueued: false,
      });
    }

    // Cooldown gates the SEND only. The context above was refreshed
    // unconditionally, so a lead the reps are actively working always has
    // current context even while we stay quiet.
    //
    // Note the ordering against supersedePendingWarming below: an already-queued
    // opener is deliberately LEFT ALONE when we're inside the cooldown. Cancelling
    // it here and then declining to queue a replacement would silently drop the
    // lead's warming entirely — e.g. status 14 queues a send 15 days out, status 60
    // arrives two days later, and the lead ends up with nothing. Leaving the
    // pending row costs nothing: the opener is generic, and by the time it fires
    // the bot is carrying the newest status context anyway.
    if (withinCooldown(conversation.crm_last_warmed_at, rule.cooldown_days)) {
      return jsonResponse({
        ok: true,
        conversation_id: conversation.id,
        cooldown_skipped: true,
        cooldown_days: rule.cooldown_days,
        enqueued: false,
      });
    }

    const variableCount = await loadTemplateVariableCount(
      admin,
      agent.id,
      agent.warming_template_name,
      agent.warming_template_language,
    );
    // Meta rejects empty or missing parameters outright, so a template that
    // wants a name and a lead who has none is a skip, not a malformed send.
    if (variableCount > 0 && !payload.lead_name) {
      await logError({
        admin,
        source: SOURCE,
        errorType: "warming_missing_template_variable",
        level: "warn",
        message:
          `opener declares ${variableCount} parameter(s) but the payload carried no lead_name — skipped`,
        context: { product: payload.product, lead_phone: payload.lead_phone },
        agentId: agent.id,
      });
      return jsonResponse({
        ok: true,
        conversation_id: conversation.id,
        missing_template_variable: true,
        enqueued: false,
      });
    }
    const variables = variableCount > 0 ? [payload.lead_name as string] : [];
    if (variableCount > 1) {
      // Only slot 1 has a defined meaning (the lead's name). A template that
      // declares more is a config error we surface rather than pad blindly.
      await logError({
        admin,
        source: SOURCE,
        errorType: "warming_template_variable_mismatch",
        level: "warn",
        message: `opener declares ${variableCount} parameters; only the lead name is defined`,
        context: { template: agent.warming_template_name },
        agentId: agent.id,
      });
      return jsonResponse({
        ok: true,
        conversation_id: conversation.id,
        template_variable_mismatch: true,
        enqueued: false,
      });
    }

    // We are definitely queueing now, so it is finally safe to retire any
    // older un-sent opener. Doing this earlier would risk cancelling the only
    // queued send on a path that then declines to replace it.
    const superseded = await supersedePendingWarming(admin, conversation.id);

    const scheduledFor = new Date(Date.now() + rule.delay_hours * 3_600_000).toISOString();
    const { error: enqueueError } = await admin
      .from("scheduled_messages")
      .insert({
        agent_id: agent.id,
        conversation_id: conversation.id,
        lead_phone: payload.lead_phone,
        lead_name: payload.lead_name,
        template_name: agent.warming_template_name,
        template_language: agent.warming_template_language,
        template_variables: variables,
        scheduled_for: scheduledFor,
        status: "pending",
        kind: "warming",
      });
    if (enqueueError) {
      throw new Error(`enqueue warming message failed: ${enqueueError.message}`);
    }

    const { error: stampError } = await admin
      .from("conversations")
      .update({ crm_last_warmed_at: new Date().toISOString() })
      .eq("id", conversation.id);
    if (stampError) throw new Error(`stamp crm_last_warmed_at failed: ${stampError.message}`);

    return jsonResponse({
      ok: true,
      conversation_id: conversation.id,
      conversation_created: conversation.inserted,
      status_sub: payload.status_sub,
      objection_key: rule.objection_key,
      superseded,
      enqueued: true,
      scheduled_for: scheduledFor,
    });
  } catch (err) {
    const detail = err instanceof Error ? err.message : String(err);
    await logError({
      admin,
      source: SOURCE,
      errorType: "crm_status_webhook_failed",
      message: detail,
      context: {
        product: payload.product,
        lead_phone: payload.lead_phone,
        status_sub: payload.status_sub,
      },
      agentId: agent.id,
    });
    return jsonResponse({ error: "Internal error", detail }, 500);
  }
});
