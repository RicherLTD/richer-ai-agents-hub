import { supabase } from "./supabase/client";
import type { AppUser } from "@/types/user";

/**
 * Fetch the `app_users` row for the currently authenticated user.
 *
 * RLS (`authenticated_read_own_or_admin_all` from migration 0003) lets every
 * authenticated user read their own row, so this single-row query is safe
 * to call right after sign-in.
 *
 * Returns null when the user has no matching `app_users` row yet — this
 * shouldn't happen in practice (the auth.users trigger auto-creates one),
 * but we surface it cleanly so callers can render a fallback UI.
 */
export async function getCurrentAppUser(): Promise<AppUser | null> {
  const { data: authData } = await supabase.auth.getUser();
  const userId = authData.user?.id;
  if (!userId) return null;

  const { data, error } = await supabase
    .from("app_users")
    .select("*")
    .eq("id", userId)
    .maybeSingle();

  if (error) {
    throw new Error(`Failed to load app user: ${error.message}`);
  }
  return data ?? null;
}

/**
 * Fetch every row in `app_users`. Only succeeds for admins — for non-admin
 * callers RLS will silently filter the result to their own row.
 */
export async function getAllAppUsers(): Promise<AppUser[]> {
  const { data, error } = await supabase
    .from("app_users")
    .select("*")
    .order("created_at", { ascending: true });

  if (error) {
    throw new Error(`Failed to load app users: ${error.message}`);
  }
  return data ?? [];
}
