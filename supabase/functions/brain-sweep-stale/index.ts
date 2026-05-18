// brain-sweep-stale/index.ts
//
// Safety net for brain_documents rows that get stranded in
// `extraction_status='pending'`.
//
// Why this exists: `brain-ingest` does the Anthropic extraction in a
// background task (`EdgeRuntime.waitUntil`). Supabase caps that work at
// ~150s wall clock; if the task is killed (instance recycle, cold
// redeploy, slow Anthropic call without an explicit timeout), the row
// is never updated and the UI shows "מעבד..." forever.
//
// brain-ingest now sets an explicit Anthropic timeout, so the common
// case is handled there. This cron is the catch-all for the edge cases
// (network blip during the DB UPDATE itself, instance termination
// between stages, anything else we missed).
//
// Sweep policy:
//   - Status must still be `pending`.
//   - Uploaded more than STALE_MINUTES ago (default 20m — well above
//     the 150s background limit, but short enough that operators see
//     the failure on the next page reload, not hours later).
//
// Auth: shared-secret bearer (CRON_SHARED_SECRET) — same pattern as
// re-engage-cold-leads and dispatch-scheduled-templates. pg_cron can't
// carry user JWTs.
//
// Setup (one-time, via Supabase Studio → Database → Cron):
//   SELECT cron.schedule(
//     'brain-sweep-stale',
//     '*/10 * * * *',  -- every 10 minutes
//     $$
//     SELECT net.http_post(
//       url := 'https://<project-ref>.supabase.co/functions/v1/brain-sweep-stale',
//       headers := jsonb_build_object('Authorization', 'Bearer <CRON_SHARED_SECRET>'),
//       body := '{}'::jsonb
//     );
//     $$
//   );

import { createClient } from "https://esm.sh/@supabase/supabase-js@2.45.4";
import { corsHeaders } from "../_shared/cors.ts";
import { logError } from "../_shared/logError.ts";

const SOURCE = "brain-sweep-stale";
const STALE_MINUTES = 20;
const FAIL_MESSAGE =
  "החילוץ לא הסתיים בזמן (background task נהרג לפני שהושלם). העלה מחדש; אם הקובץ גדול — פצל ל־PDFים של עד ~80 עמודים.";

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

  const cronSecret = Deno.env.get("CRON_SHARED_SECRET");
  if (!cronSecret) {
    return jsonResponse({ error: "CRON_SHARED_SECRET not configured" }, 500);
  }
  const auth = req.headers.get("Authorization") ?? "";
  if (auth !== `Bearer ${cronSecret}`) {
    return jsonResponse({ error: "Unauthorized" }, 401);
  }

  const supabaseUrl = Deno.env.get("SUPABASE_URL");
  const serviceRoleKey = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY");
  if (!supabaseUrl || !serviceRoleKey) {
    return jsonResponse({ error: "Supabase env not configured" }, 500);
  }

  const admin = createClient(supabaseUrl, serviceRoleKey, {
    auth: { persistSession: false, autoRefreshToken: false },
  });

  const cutoff = new Date(Date.now() - STALE_MINUTES * 60 * 1000).toISOString();

  const { data, error } = await admin
    .from("brain_documents")
    .update({
      extraction_status: "failed",
      extraction_error: FAIL_MESSAGE,
    })
    .eq("extraction_status", "pending")
    .lt("uploaded_at", cutoff)
    .select("id, title, agent_id, uploaded_at");

  if (error) {
    await logError({
      admin,
      source: SOURCE,
      errorType: "rpc_error",
      message: `Sweep query failed: ${error.message}`,
    });
    return jsonResponse({ error: error.message }, 500);
  }

  const swept = data ?? [];
  if (swept.length > 0) {
    await logError({
      admin,
      level: "warn",
      source: SOURCE,
      errorType: "brain_extraction_stalled",
      message: `Marked ${swept.length} stale brain_document(s) as failed`,
      context: { ids: swept.map((r) => r.id), cutoff },
    });
  }

  return jsonResponse({ swept_count: swept.length, swept });
});
