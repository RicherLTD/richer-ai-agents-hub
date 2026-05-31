/**
 * Read-only health check of recent `error_logs` via the Supabase Management API.
 * Handy right after a deploy to confirm the agent loop is healthy.
 *
 * Usage:
 *   bun run scripts/check-error-logs.ts [minutes]   # default 60
 *
 * Env (from .env.local — Bun loads it automatically):
 *   SUPABASE_PROJECT_REF, SUPABASE_ACCESS_TOKEN
 */

const projectRef = process.env.SUPABASE_PROJECT_REF;
const accessToken = process.env.SUPABASE_ACCESS_TOKEN;
if (!projectRef || !accessToken) {
  console.error("✗ Missing SUPABASE_PROJECT_REF / SUPABASE_ACCESS_TOKEN in .env.local");
  process.exit(1);
}

const arg = Number(process.argv[2] ?? 60);
const windowMin = Number.isFinite(arg) && arg > 0 ? Math.floor(arg) : 60;

// Skip info-level rows (e.g. whatsapp-status-callback delivery pings) —
// a post-deploy health check only cares about warn/error.
const sql = `
  SELECT created_at, level, source, error_type, left(message, 160) AS message,
         conversation_id
  FROM public.error_logs
  WHERE created_at > now() - interval '${windowMin} minutes'
    AND level <> 'info'
  ORDER BY created_at DESC
  LIMIT 100;
`;

const res = await fetch(
  `https://api.supabase.com/v1/projects/${projectRef}/database/query`,
  {
    method: "POST",
    headers: {
      Authorization: `Bearer ${accessToken}`,
      "Content-Type": "application/json",
    },
    body: JSON.stringify({ query: sql }),
  },
);

if (!res.ok) {
  console.error(`✗ Query failed (HTTP ${res.status}):`);
  console.error(await res.text());
  process.exit(1);
}

const rows = (await res.json()) as Array<Record<string, unknown>>;
const count = Array.isArray(rows) ? rows.length : 0;
console.log(`→ error_logs in the last ${windowMin} min: ${count} row(s)`);

if (count === 0) {
  console.log("✓ clean — no errors logged in this window.");
} else {
  const byType: Record<string, number> = {};
  for (const r of rows) {
    const t = String(r.error_type ?? "unknown");
    byType[t] = (byType[t] ?? 0) + 1;
  }
  console.log("  by type:", byType);
  console.log(JSON.stringify(rows, null, 2));
}
