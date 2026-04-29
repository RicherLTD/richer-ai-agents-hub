/**
 * Apply a SQL file to the linked Supabase project via the Management API.
 *
 * We use this instead of `supabase db push` because the latter requires Docker
 * (it spawns a local pg container to run pg_dump/pg_restore). The Management
 * API runs SQL directly against the remote project — no Docker needed.
 *
 * Usage:
 *   bun run db:apply supabase/migrations/0001_rls_policies.sql
 *
 * Required env (from .env.local — Bun loads it automatically):
 *   SUPABASE_PROJECT_REF   e.g. juoglkqtmjsziieqgmhf
 *   SUPABASE_ACCESS_TOKEN  personal access token (sbp_…)
 *
 * Note: this script is intentionally minimal. It does NOT track which
 * migrations have been applied — that's why every migration file must be
 * idempotent (DROP IF EXISTS + CREATE patterns). When the project grows,
 * we'll add a `_meta_migrations` tracking table.
 */

import { readFileSync } from "node:fs";
import { resolve } from "node:path";

const projectRef = process.env.SUPABASE_PROJECT_REF;
const accessToken = process.env.SUPABASE_ACCESS_TOKEN;

if (!projectRef) {
  console.error("✗ Missing SUPABASE_PROJECT_REF — set it in .env.local.");
  process.exit(1);
}
if (!accessToken) {
  console.error("✗ Missing SUPABASE_ACCESS_TOKEN — set it in .env.local.");
  console.error("  Generate at https://supabase.com/dashboard/account/tokens");
  process.exit(1);
}

const filePath = process.argv[2];
if (!filePath) {
  console.error("Usage: bun run db:apply <path-to-sql-file>");
  process.exit(1);
}

const absolutePath = resolve(filePath);
const sql = readFileSync(absolutePath, "utf8");

console.log(`→ Applying ${filePath} to project ${projectRef}…`);

const response = await fetch(
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

if (!response.ok) {
  const errorText = await response.text();
  console.error(`✗ Failed (HTTP ${response.status}):`);
  console.error(errorText);
  process.exit(1);
}

const result = await response.json();
console.log("✓ Applied successfully.");
if (Array.isArray(result) && result.length > 0) {
  console.log(`  Returned ${result.length} row(s):`);
  console.log(JSON.stringify(result, null, 2));
}
