// deno-lint-ignore-file no-explicit-any
import { createClient, type SupabaseClient } from "https://esm.sh/@supabase/supabase-js@2.45.4";

export interface AdminContext {
  /** The signed-in user's id (auth.users.id) — verified from the request JWT. */
  callerId: string;
  /** Service-role client. Bypasses RLS — only use for admin-scope ops. */
  admin: SupabaseClient;
}

/**
 * Verify the request carries a valid Supabase session JWT and return the
 * caller id plus a service-role client. No role check — use `requireAdmin`
 * for admin-scope operations.
 */
export async function requireUser(req: Request): Promise<AdminContext> {
  const authHeader = req.headers.get("Authorization");
  if (!authHeader) {
    throw new HttpError(401, "Missing Authorization header");
  }

  const supabaseUrl = Deno.env.get("SUPABASE_URL");
  const anonKey = Deno.env.get("SUPABASE_ANON_KEY");
  const serviceRoleKey = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY");
  if (!supabaseUrl || !anonKey || !serviceRoleKey) {
    throw new HttpError(500, "Edge function is missing Supabase env vars");
  }

  const userClient = createClient(supabaseUrl, anonKey, {
    global: { headers: { Authorization: authHeader } },
    auth: { persistSession: false, autoRefreshToken: false },
  });
  const { data: userData, error: userErr } = await userClient.auth.getUser();
  if (userErr || !userData.user) {
    throw new HttpError(401, "Invalid or expired session");
  }

  const admin = createClient(supabaseUrl, serviceRoleKey, {
    auth: { persistSession: false, autoRefreshToken: false },
  });
  return { callerId: userData.user.id, admin };
}

/**
 * Verify the request comes from a signed-in user with role='admin' in
 * `public.app_users`. Throws on any failure — callers should let it
 * propagate so the function returns a 4xx.
 */
export async function requireAdmin(req: Request): Promise<AdminContext> {
  const ctx = await requireUser(req);
  const { data: appUser, error: appErr } = await ctx.admin
    .from("app_users")
    .select("role")
    .eq("id", ctx.callerId)
    .maybeSingle();
  if (appErr) {
    throw new HttpError(500, `Failed to check role: ${appErr.message}`);
  }
  if (!appUser || appUser.role !== "admin") {
    throw new HttpError(403, "Admin role required");
  }
  return ctx;
}

export class HttpError extends Error {
  status: number;
  constructor(status: number, message: string) {
    super(message);
    this.status = status;
  }
}

export function jsonResponse(body: unknown, init: ResponseInit = {}): Response {
  return new Response(JSON.stringify(body), {
    ...init,
    headers: {
      "Content-Type": "application/json",
      ...(init.headers as Record<string, string> | undefined),
    },
  });
}
