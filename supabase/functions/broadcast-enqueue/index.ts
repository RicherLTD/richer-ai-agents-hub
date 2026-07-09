import { corsHeaders } from "../_shared/cors.ts";
import { HttpError, jsonResponse, requireAdmin } from "../_shared/auth.ts";
import { toCanonicalPhone } from "../_shared/normalizePhone.ts";
import { buildRecipientSet, type RawRecipient } from "../_shared/broadcastRecipients.ts";

const BLOCKING_TAGS = new Set(["zoom_scheduled", "opted_out", "requires_human", "underage"]);
const INSERT_CHUNK = 500;

interface EnqueueBody {
  agent_id?: string;
  template_name?: string;
  template_language?: string;
  template_variables?: string[];
  title?: string;
  scheduled_for?: string | null;
  /** When true, include ALL active leads of this agent (=product) as recipients. */
  include_existing?: boolean;
  existing_lead_conversation_ids?: string[];
  csv_recipients?: Array<{ phone?: string; name?: string; variables?: string[] }>;
}

function chunk<T>(arr: T[], size: number): T[][] {
  const out: T[][] = [];
  for (let i = 0; i < arr.length; i += size) out.push(arr.slice(i, i + size));
  return out;
}

Deno.serve(async (req) => {
  if (req.method === "OPTIONS") return new Response("ok", { headers: corsHeaders });
  try {
    if (req.method !== "POST") throw new HttpError(405, "POST only");
    const { callerId, admin } = await requireAdmin(req);

    let body: EnqueueBody;
    try {
      body = await req.json();
    } catch {
      throw new HttpError(400, "invalid JSON");
    }

    const agentId = body.agent_id;
    const templateName = (body.template_name ?? "").trim();
    const templateLanguage = (body.template_language ?? "he").trim();
    const title = (body.title ?? "").trim();
    if (!agentId || !templateName || !title) {
      throw new HttpError(400, "agent_id, template_name and title are required");
    }
    const defaultVariables = Array.isArray(body.template_variables)
      ? body.template_variables.filter((v) => typeof v === "string")
      : [];

    const { data: agent } = await admin
      .from("agents")
      .select("id, is_paused")
      .eq("id", agentId)
      .maybeSingle();
    if (!agent) throw new HttpError(404, "agent not found");
    if (agent.is_paused) throw new HttpError(409, "agent is paused (kill switch on)");

    const { data: tpl } = await admin
      .from("broadcast_templates")
      .select("id")
      .eq("agent_id", agentId)
      .eq("name", templateName)
      .eq("language", templateLanguage)
      .eq("is_active", true)
      .maybeSingle();
    if (!tpl) throw new HttpError(400, "template is not a registered active broadcast template for this agent");

    const cutoff = new Date(Date.now() - 60_000).toISOString();
    const { data: dup } = await admin
      .from("broadcasts")
      .select("id, total_recipients, suppressed_count, suppressed_breakdown")
      .eq("agent_id", agentId)
      .eq("title", title)
      .eq("created_by", callerId)
      .gte("created_at", cutoff)
      .order("created_at", { ascending: false })
      .limit(1)
      .maybeSingle();
    if (dup) {
      return jsonResponse(
        { broadcast_id: dup.id, total_recipients: dup.total_recipients, suppressed_count: dup.suppressed_count, suppressed_breakdown: dup.suppressed_breakdown, idempotent: true },
        { headers: corsHeaders },
      );
    }

    const raw: RawRecipient[] = [];
    const convIds = (body.existing_lead_conversation_ids ?? []).filter((s) => typeof s === "string");
    if (convIds.length > 0) {
      const { data: convs } = await admin
        .from("conversations")
        .select("id, lead_phone, lead_name")
        .eq("agent_id", agentId)
        .in("id", convIds);
      for (const c of convs ?? []) {
        raw.push({ phone: c.lead_phone as string, name: (c as { lead_name?: string }).lead_name ?? null, conversationId: c.id as string });
      }
    }
    if (body.include_existing === true) {
      const { data: convs } = await admin
        .from("conversations")
        .select("id, lead_phone, lead_name")
        .eq("agent_id", agentId)
        .eq("status", "active");
      for (const c of convs ?? []) {
        raw.push({ phone: c.lead_phone as string, name: (c as { lead_name?: string }).lead_name ?? null, conversationId: c.id as string });
      }
    }
    for (const r of body.csv_recipients ?? []) {
      if (r && typeof r.phone === "string") {
        raw.push({ phone: r.phone, name: r.name ?? null, variables: Array.isArray(r.variables) ? r.variables : null });
      }
    }
    if (raw.length === 0) throw new HttpError(400, "no recipients supplied");

    const candidatePhones = [
      ...new Set(raw.map((r) => toCanonicalPhone(r.phone)).filter((p): p is string => !!p)),
    ];

    const optedOutPhones = new Set<string>();
    for (const group of chunk(candidatePhones, INSERT_CHUNK)) {
      const { data: oo } = await admin.from("opt_outs").select("lead_phone").in("lead_phone", group);
      for (const o of oo ?? []) {
        const c = toCanonicalPhone((o as { lead_phone: string }).lead_phone);
        if (c) optedOutPhones.add(c);
      }
    }

    const convByPhone = new Map<string, string>();
    const blockedPhones = new Set<string>();
    for (const group of chunk(candidatePhones, INSERT_CHUNK)) {
      const { data: convs } = await admin
        .from("conversations")
        .select("id, lead_phone, status, current_tag")
        .eq("agent_id", agentId)
        .in("lead_phone", group);
      for (const c of convs ?? []) {
        const canon = toCanonicalPhone(c.lead_phone as string);
        if (!canon) continue;
        convByPhone.set(canon, c.id as string);
        const status = (c as { status?: string | null }).status ?? null;
        const tag = (c as { current_tag?: string | null }).current_tag ?? null;
        if ((status !== null && status !== "active") || (tag !== null && BLOCKING_TAGS.has(tag))) {
          blockedPhones.add(canon);
        }
      }
    }

    const set = buildRecipientSet({ recipients: raw, optedOutPhones, blockedPhones });

    const scheduledFor = body.scheduled_for ?? null;
    const { data: broadcast, error: bErr } = await admin
      .from("broadcasts")
      .insert({
        agent_id: agentId,
        template_name: templateName,
        template_language: templateLanguage,
        template_variables: defaultVariables,
        title,
        status: "queued",
        scheduled_for: scheduledFor,
        total_recipients: set.toSend.length,
        suppressed_count: set.suppressedCount,
        suppressed_breakdown: set.breakdown,
        created_by: callerId,
      })
      .select("id")
      .single();
    if (bErr || !broadcast) throw new HttpError(500, `failed to create broadcast: ${bErr?.message}`);

    const netNew = set.toSend.filter((r) => !convByPhone.has(r.phone));
    for (const group of chunk(netNew, INSERT_CHUNK)) {
      const payload = group.map((r) => ({ agent_id: agentId, lead_phone: r.phone, lead_name: r.name, status: "active" }));
      const { data: upserted } = await admin
        .from("conversations")
        .upsert(payload, { onConflict: "agent_id,lead_phone", ignoreDuplicates: false })
        .select("id, lead_phone");
      for (const c of upserted ?? []) {
        const canon = toCanonicalPhone(c.lead_phone as string);
        if (canon) convByPhone.set(canon, c.id as string);
      }
    }

    const nowIso = new Date().toISOString();
    const rows = set.toSend.map((r) => ({
      agent_id: agentId,
      conversation_id: convByPhone.get(r.phone) ?? null,
      lead_phone: r.phone,
      lead_name: r.name,
      template_name: templateName,
      template_language: templateLanguage,
      template_variables: r.variables ?? defaultVariables,
      scheduled_for: scheduledFor ?? nowIso,
      status: "pending",
      broadcast_id: broadcast.id,
    }));
    for (const group of chunk(rows, INSERT_CHUNK)) {
      const { error: insErr } = await admin.from("scheduled_messages").insert(group);
      if (insErr) throw new HttpError(500, `failed to enqueue rows: ${insErr.message}`);
    }

    return jsonResponse(
      {
        broadcast_id: broadcast.id,
        total_recipients: set.toSend.length,
        suppressed_count: set.suppressedCount,
        suppressed_breakdown: set.breakdown,
      },
      { headers: corsHeaders },
    );
  } catch (err) {
    if (err instanceof HttpError) {
      return jsonResponse({ error: err.message }, { status: err.status, headers: corsHeaders });
    }
    return jsonResponse({ error: "internal error" }, { status: 500, headers: corsHeaders });
  }
});
