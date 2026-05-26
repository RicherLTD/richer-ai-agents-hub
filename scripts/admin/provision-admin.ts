/**
 * Provision an admin user in Supabase Auth + app_users.
 *
 * Usage:
 *   bun run scripts/admin/provision-admin.ts <email> <password> [full_name]
 *
 * Behavior:
 *   - If the user does not exist in auth.users → create + email-confirm.
 *   - If the user exists → update their password.
 *   - In both cases, upsert public.app_users with role='admin'.
 *
 * Required env (from .env.local):
 *   VITE_SUPABASE_URL           e.g. https://juoglkqtmjsziieqgmhf.supabase.co
 *   SUPABASE_SERVICE_ROLE_KEY   service_role secret from Supabase Studio
 *                               (Settings → API → service_role)
 */

import { createClient } from "@supabase/supabase-js";

const url = process.env.VITE_SUPABASE_URL;
const serviceKey = process.env.SUPABASE_SERVICE_ROLE_KEY;

if (!url) {
  console.error("✗ Missing VITE_SUPABASE_URL in .env.local");
  process.exit(1);
}
if (!serviceKey) {
  console.error("✗ Missing SUPABASE_SERVICE_ROLE_KEY in .env.local");
  console.error("  Get it from Supabase Studio → Settings → API → service_role");
  process.exit(1);
}

const email = process.argv[2];
const password = process.argv[3];
const fullName = process.argv[4];

if (!email || !password) {
  console.error("Usage: bun run scripts/admin/provision-admin.ts <email> <password> [full_name]");
  process.exit(1);
}

const admin = createClient(url, serviceKey, {
  auth: { autoRefreshToken: false, persistSession: false },
});

console.log(`→ Looking up ${email}…`);

const { data: list, error: listErr } = await admin.auth.admin.listUsers({
  page: 1,
  perPage: 200,
});
if (listErr) {
  console.error(`✗ listUsers failed: ${listErr.message}`);
  process.exit(1);
}
const existing = list.users.find((u) => u.email?.toLowerCase() === email.toLowerCase());

let userId: string;

if (existing) {
  console.log(`→ User exists (id=${existing.id}); updating password…`);
  const { error: updErr } = await admin.auth.admin.updateUserById(existing.id, {
    password,
    email_confirm: true,
    user_metadata: fullName ? { full_name: fullName } : undefined,
  });
  if (updErr) {
    console.error(`✗ updateUserById failed: ${updErr.message}`);
    process.exit(1);
  }
  userId = existing.id;
} else {
  console.log(`→ User does not exist; creating…`);
  const { data: created, error: createErr } = await admin.auth.admin.createUser({
    email,
    password,
    email_confirm: true,
    user_metadata: fullName ? { full_name: fullName } : undefined,
  });
  if (createErr || !created.user) {
    console.error(`✗ createUser failed: ${createErr?.message ?? "no user returned"}`);
    process.exit(1);
  }
  userId = created.user.id;
}

console.log(`→ Ensuring app_users.role = 'admin' for ${userId}…`);

const patch: Record<string, unknown> = { id: userId, role: "admin" };
if (fullName) patch.full_name = fullName;

const { error: upsertErr } = await admin.from("app_users").upsert(patch, { onConflict: "id" });
if (upsertErr) {
  console.error(`✗ app_users upsert failed: ${upsertErr.message}`);
  process.exit(1);
}

console.log(`✓ Done. ${email} can sign in with the provided password as admin.`);
