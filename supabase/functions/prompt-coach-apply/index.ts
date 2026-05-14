// prompt-coach-apply/index.ts
//
// Apply a Coach-proposed prompt edit: take the `proposed_prompt_content`
// off a coach_messages row, insert a new row into `prompts` (next version,
// is_active=true), flip the previous active main prompt to inactive in
// the same step, and stamp the coach message as applied.
//
// Admin-only. The Coach itself NEVER writes to prompts; only this path
// does, and only after a human clicked "apply" in the UI.

import { HttpError, jsonResponse, requireAdmin } from "../_shared/auth.ts";
import { corsHeaders } from "../_shared/cors.ts";
import { logError } from "../_shared/logError.ts";

const SOURCE = "prompt-coach-apply";
const MAIN_PROMPT_TYPE = "main";

interface ApplyRequest {
  coachMessageId: string;
}

function parseBody(raw: unknown): ApplyRequest {
  if (!raw || typeof raw !== "object") {
    throw new HttpError(400, "Body must be a JSON object");
  }
  const o = raw as Record<string, unknown>;
  if (typeof o.coachMessageId !== "string" || !o.coachMessageId) {
    throw new HttpError(400, "coachMessageId is required");
  }
  return { coachMessageId: o.coachMessageId };
}

/** Next version slug: vN -> v(N+1). Falls back to v2 if the current
 *  version isn't a `vN` integer string. */
function nextVersion(current: string): string {
  const m = current.match(/^v(\d+)$/i);
  if (!m) return "v2";
  const n = parseInt(m[1], 10);
  return `v${n + 1}`;
}

Deno.serve(async (req) => {
  if (req.method === "OPTIONS") {
    return new Response(null, { headers: corsHeaders });
  }
  if (req.method !== "POST") {
    return jsonResponse({ error: "Method not allowed" }, {
      status: 405,
      headers: corsHeaders,
    });
  }

  let ctx;
  try {
    ctx = await requireAdmin(req);
  } catch (err) {
    const status = err instanceof HttpError ? err.status : 500;
    const message = err instanceof Error ? err.message : "Auth failed";
    return jsonResponse({ error: message }, { status, headers: corsHeaders });
  }

  let body: ApplyRequest;
  try {
    const raw = await req.json().catch(() => null);
    body = parseBody(raw);
  } catch (err) {
    const status = err instanceof HttpError ? err.status : 400;
    const message = err instanceof Error ? err.message : "Bad request";
    return jsonResponse({ error: message }, { status, headers: corsHeaders });
  }

  // 1. Load the coach message + verify it has a proposal and isn't already applied.
  const { data: cm, error: cmErr } = await ctx.admin
    .from("coach_messages")
    .select("id, agent_id, proposed_prompt_content, applied_prompt_id")
    .eq("id", body.coachMessageId)
    .maybeSingle();
  if (cmErr) {
    return jsonResponse({ error: `Failed to load coach message: ${cmErr.message}` }, {
      status: 500,
      headers: corsHeaders,
    });
  }
  if (!cm) {
    return jsonResponse({ error: "Coach message not found" }, {
      status: 404,
      headers: corsHeaders,
    });
  }
  if (cm.applied_prompt_id) {
    return jsonResponse({ error: "Proposal already applied" }, {
      status: 409,
      headers: corsHeaders,
    });
  }
  const proposedContent = cm.proposed_prompt_content as string | null;
  if (!proposedContent || proposedContent.trim().length === 0) {
    return jsonResponse({ error: "Message has no proposed prompt content" }, {
      status: 400,
      headers: corsHeaders,
    });
  }
  const agentId = cm.agent_id as string;

  // 2. Read the current active main prompt to pick a version number and
  //    flip its is_active off.
  const { data: current, error: curErr } = await ctx.admin
    .from("prompts")
    .select("id, version")
    .eq("agent_id", agentId)
    .eq("prompt_type", MAIN_PROMPT_TYPE)
    .eq("is_active", true)
    .order("created_at", { ascending: false })
    .limit(1)
    .maybeSingle();
  if (curErr) {
    return jsonResponse({ error: `Failed to load current prompt: ${curErr.message}` }, {
      status: 500,
      headers: corsHeaders,
    });
  }
  const newVersion = current?.version ? nextVersion(current.version as string) : "v1";

  // 3. Insert the new prompt row (active).
  const { data: inserted, error: insErr } = await ctx.admin
    .from("prompts")
    .insert({
      agent_id: agentId,
      prompt_type: MAIN_PROMPT_TYPE,
      version: newVersion,
      content: proposedContent,
      is_active: true,
    })
    .select("id, version, created_at")
    .single();
  if (insErr || !inserted) {
    await logError({
      admin: ctx.admin,
      source: SOURCE,
      errorType: "prompt_insert_failed",
      message: insErr?.message ?? "no row returned",
      context: { agentId, newVersion },
      agentId,
    });
    return jsonResponse({ error: `Failed to insert new prompt: ${insErr?.message}` }, {
      status: 500,
      headers: corsHeaders,
    });
  }

  // 4. Deactivate the previous active main prompt (if any). Order matters:
  //    insert FIRST so we never have zero active mains; then flip the old.
  if (current?.id) {
    const { error: deactErr } = await ctx.admin
      .from("prompts")
      .update({ is_active: false })
      .eq("id", current.id);
    if (deactErr) {
      // Don't roll back the insert — log it. Operator can fix manually.
      await logError({
        admin: ctx.admin,
        source: SOURCE,
        errorType: "prompt_deactivate_failed",
        message: deactErr.message,
        context: { previousPromptId: current.id, newPromptId: inserted.id },
        agentId,
      });
    }
  }

  // 5. Stamp the coach message.
  const { error: stampErr } = await ctx.admin
    .from("coach_messages")
    .update({
      applied_prompt_id: inserted.id,
      applied_at: new Date().toISOString(),
      applied_by: ctx.callerId,
    })
    .eq("id", cm.id);
  if (stampErr) {
    await logError({
      admin: ctx.admin,
      source: SOURCE,
      errorType: "coach_message_stamp_failed",
      message: stampErr.message,
      context: { coachMessageId: cm.id, newPromptId: inserted.id },
      agentId,
    });
  }

  return jsonResponse(
    {
      newPromptId: inserted.id,
      newVersion: inserted.version,
      previousPromptId: current?.id ?? null,
      previousVersion: current?.version ?? null,
    },
    { status: 200, headers: corsHeaders },
  );
});
