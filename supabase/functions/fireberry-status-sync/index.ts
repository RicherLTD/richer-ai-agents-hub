// fireberry-status-sync
//
// Mirrors Fireberry lead statuses (primary `statuscode`, secondary
// `pcfsystemfield103`) onto conversations.fb_status_* so the broadcast page can
// target by status. Incremental by modifiedon with a resumable cursor per
// product (fireberry_sync_state); the first runs walk the whole product
// history (~120K records), later runs only what changed.
//
// Triggers:
//   - pg_cron every 10 minutes, `Authorization: Bearer <CRON_SHARED_SECRET>`
//   - the "רענן סטטוסים" button on /broadcasts (admin JWT)
// Deploy with verify_jwt = false (the cron secret is not a JWT); the admin
// path is checked here with requireAdmin.
//
// Work runs in EdgeRuntime.waitUntil, which Supabase caps at ~150s, so each
// run stops at RUN_BUDGET_MS and the next one resumes from the cursor.

import { createClient, type SupabaseClient } from "https://esm.sh/@supabase/supabase-js@2.45.4";
import { corsHeaders } from "../_shared/cors.ts";
import { HttpError, requireAdmin } from "../_shared/auth.ts";
import { logError } from "../_shared/logError.ts";
import {
  advanceCursor,
  buildSyncQuery,
  dedupeByPhone,
  FIREBERRY_PAGE_SIZE,
  type FireberryLeadRecord,
  isStuckPage,
  skipAlreadyApplied,
  stepPastInstant,
  type StatusRow,
  type SyncCursor,
  toStatusRow,
} from "../_shared/fireberrySync.ts";

const SOURCE = "fireberry-status-sync";
const FIREBERRY_QUERY_URL = "https://api.fireberry.com/api/v3/query";
const RUN_BUDGET_MS = 110_000;
const REQUEST_TIMEOUT_MS = 25_000;

interface EdgeRuntimeShape {
  waitUntil(p: Promise<unknown>): void;
}

interface ProductJob {
  agentId: string;
  productId: string;
  cursor: SyncCursor;
  fullSyncDone: boolean;
  caughtUp: boolean;
  fetched: number;
  applied: number;
}

function jsonResponse(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { ...corsHeaders, "Content-Type": "application/json" },
  });
}

async function fetchPage(token: string, query: Record<string, unknown>): Promise<FireberryLeadRecord[]> {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), REQUEST_TIMEOUT_MS);
  try {
    const res = await fetch(FIREBERRY_QUERY_URL, {
      method: "POST",
      headers: { tokenid: token, "Content-Type": "application/json" },
      body: JSON.stringify(query),
      signal: controller.signal,
    });
    const text = await res.text();
    if (!res.ok) throw new Error(`fireberry v3/query → ${res.status} ${text.slice(0, 200)}`);
    const json = text ? JSON.parse(text) : {};
    if (json?.success === false || json?.success === null) {
      throw new Error(`fireberry v3/query rejected: ${String(json?.message ?? "").slice(0, 200)}`);
    }
    return Array.isArray(json?.data) ? (json.data as FireberryLeadRecord[]) : [];
  } finally {
    clearTimeout(timer);
  }
}

async function loadJobs(admin: SupabaseClient): Promise<ProductJob[]> {
  const { data: agents, error } = await admin
    .from("agents")
    .select("id, fireberry_product_id")
    .not("fireberry_product_id", "is", null);
  if (error) throw new Error(`load agents failed: ${error.message}`);
  const productIds = (agents ?? []).map((a) => a.fireberry_product_id as string);
  const { data: states, error: stateErr } = await admin
    .from("fireberry_sync_state")
    .select("product_id, cursor_modified_on, cursor_ids, full_sync_done_at")
    .in("product_id", productIds);
  if (stateErr) throw new Error(`load sync state failed: ${stateErr.message}`);
  const byProduct = new Map((states ?? []).map((s) => [s.product_id as string, s]));
  return (agents ?? []).map((a) => {
    const state = byProduct.get(a.fireberry_product_id as string);
    return {
      agentId: a.id as string,
      productId: a.fireberry_product_id as string,
      cursor: {
        modifiedOn: state?.cursor_modified_on ? new Date(state.cursor_modified_on as string).toISOString() : null,
        ids: (state?.cursor_ids as string[] | null) ?? [],
      },
      fullSyncDone: !!state?.full_sync_done_at,
      caughtUp: false,
      fetched: 0,
      applied: 0,
    };
  });
}

async function saveState(admin: SupabaseClient, job: ProductJob, lastError: string | null): Promise<void> {
  const now = new Date().toISOString();
  const row: Record<string, unknown> = {
    product_id: job.productId,
    cursor_modified_on: job.cursor.modifiedOn,
    cursor_ids: job.cursor.ids,
    last_run_at: now,
    last_error: lastError,
    updated_at: now,
  };
  if (job.caughtUp && !job.fullSyncDone) {
    row.full_sync_done_at = now;
    job.fullSyncDone = true;
  }
  const { error } = await admin.from("fireberry_sync_state").upsert(row, { onConflict: "product_id" });
  if (error) throw new Error(`save sync state failed: ${error.message}`);
}

/** One page for one product: fetch, apply, advance the cursor. */
async function syncOnePage(admin: SupabaseClient, token: string, job: ProductJob): Promise<void> {
  const fetched = await fetchPage(token, buildSyncQuery({ productId: job.productId, cursorModifiedOn: job.cursor.modifiedOn }));
  const fresh = skipAlreadyApplied(fetched, job.cursor);
  job.fetched += fresh.length;

  const rows = dedupeByPhone(fresh.map(toStatusRow).filter((r): r is StatusRow => r !== null));
  if (rows.length > 0) {
    const { data, error } = await admin.rpc("apply_fireberry_statuses", { p_agent_id: job.agentId, p_rows: rows });
    if (error) throw new Error(`apply_fireberry_statuses failed: ${error.message}`);
    job.applied += typeof data === "number" ? data : 0;
  }

  if (isStuckPage(fetched, fresh, FIREBERRY_PAGE_SIZE)) {
    await logError({
      admin,
      source: SOURCE,
      errorType: "fireberry_sync_stuck_instant",
      level: "warn",
      message: `>${FIREBERRY_PAGE_SIZE} records at ${job.cursor.modifiedOn}; stepping past it`,
      context: { product_id: job.productId },
    });
    job.cursor = stepPastInstant(job.cursor);
  } else {
    job.cursor = advanceCursor(job.cursor, fresh);
  }
  // A short page means nothing newer is left.
  job.caughtUp = fetched.length < FIREBERRY_PAGE_SIZE;
}

async function runSync(admin: SupabaseClient, token: string): Promise<void> {
  const deadline = Date.now() + RUN_BUDGET_MS;
  const jobs = await loadJobs(admin);
  // Round-robin, one page per product per turn, so the first full walk of a
  // large product does not starve the other.
  let active = jobs.slice();
  while (active.length > 0 && Date.now() < deadline) {
    for (const job of active) {
      if (Date.now() >= deadline) break;
      try {
        await syncOnePage(admin, token, job);
        await saveState(admin, job, null);
      } catch (err) {
        const message = err instanceof Error ? err.message : String(err);
        job.caughtUp = true; // stop this product for this run; the cursor is untouched
        await saveState(admin, job, message).catch(() => {});
        await logError({
          admin,
          source: SOURCE,
          errorType: "fireberry_sync_failed",
          level: "error",
          message,
          context: { product_id: job.productId },
        });
      }
    }
    active = active.filter((j) => !j.caughtUp);
  }
  await logError({
    admin,
    source: SOURCE,
    errorType: "fireberry_sync_run",
    level: "info",
    message: jobs.map((j) => `${j.productId.slice(0, 8)}: fetched ${j.fetched}, applied ${j.applied}${j.caughtUp ? ", caught up" : ""}`).join(" | "),
    context: { jobs: jobs.map((j) => ({ product_id: j.productId, cursor: j.cursor.modifiedOn, caught_up: j.caughtUp })) },
  });
}

Deno.serve(async (req) => {
  if (req.method === "OPTIONS") return new Response("ok", { headers: corsHeaders });
  if (req.method !== "POST") return jsonResponse({ error: "POST only" }, 405);

  try {
    const cronSecret = Deno.env.get("CRON_SHARED_SECRET");
    const auth = req.headers.get("Authorization") ?? "";
    const isCron = !!cronSecret && auth === `Bearer ${cronSecret}`;
    if (!isCron) await requireAdmin(req);

    const token = Deno.env.get("FIREBERRY_API_TOKEN")?.trim();
    if (!token) return jsonResponse({ error: "FIREBERRY_API_TOKEN not configured" }, 500);
    const supabaseUrl = Deno.env.get("SUPABASE_URL");
    const serviceRoleKey = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY");
    if (!supabaseUrl || !serviceRoleKey) return jsonResponse({ error: "Supabase env not configured" }, 500);
    const admin = createClient(supabaseUrl, serviceRoleKey, {
      auth: { persistSession: false, autoRefreshToken: false },
    });

    const work = runSync(admin, token).catch(async (err) => {
      await logError({
        admin,
        source: SOURCE,
        errorType: "fireberry_sync_failed",
        level: "error",
        message: err instanceof Error ? err.message : String(err),
      });
    });
    const runtime = (globalThis as { EdgeRuntime?: EdgeRuntimeShape }).EdgeRuntime;
    if (runtime) {
      runtime.waitUntil(work);
      return jsonResponse({ started: true }, 202);
    }
    await work;
    return jsonResponse({ started: true, finished: true });
  } catch (err) {
    if (err instanceof HttpError) return jsonResponse({ error: err.message }, err.status);
    return jsonResponse({ error: "internal error" }, 500);
  }
});
