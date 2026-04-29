/**
 * Admin-side mutations on `app_users`.
 *
 * Responsibilities split:
 *   - Role updates (`updateUserRole`) hit `app_users` directly. RLS
 *     restricts UPDATE to admins (see migration 0003), so this is safe.
 *   - User invitations and hard deletes go through edge functions
 *     (`invite-user`, `delete-user`) because they need service-role
 *     access to `auth.users`.
 *
 * `supabase.functions.invoke` automatically attaches the caller's JWT,
 * which the edge functions use to verify admin role.
 */
import { supabase } from "./supabase/client";
import type { AppRole, AppUser, AppUserUpdate } from "@/types/user";

export async function updateUserRole(id: string, role: AppRole): Promise<AppUser> {
  const patch: AppUserUpdate = { role };
  const { data, error } = await supabase
    .from("app_users")
    .update(patch)
    .eq("id", id)
    .select("*")
    .single();
  if (error) {
    throw new Error(`Failed to update role: ${error.message}`);
  }
  return data;
}

export async function updateUserFullName(id: string, fullName: string | null): Promise<AppUser> {
  const patch: AppUserUpdate = { full_name: fullName };
  const { data, error } = await supabase
    .from("app_users")
    .update(patch)
    .eq("id", id)
    .select("*")
    .single();
  if (error) {
    throw new Error(`Failed to update name: ${error.message}`);
  }
  return data;
}

export interface InviteUserPayload {
  email: string;
  role: AppRole;
  full_name?: string;
}

export interface InviteUserResponse {
  user_id: string;
  email: string;
  role: AppRole;
}

export async function inviteUser(payload: InviteUserPayload): Promise<InviteUserResponse> {
  const { data, error } = await supabase.functions.invoke<InviteUserResponse | { error: string }>(
    "invite-user",
    { body: payload },
  );
  if (error) {
    throw new Error(`Failed to invite user: ${error.message}`);
  }
  if (!data || "error" in data) {
    throw new Error(`Failed to invite user: ${data && "error" in data ? data.error : "unknown"}`);
  }
  return data;
}

export async function deleteUser(userId: string): Promise<void> {
  const { data, error } = await supabase.functions.invoke<{ deleted: boolean } | { error: string }>(
    "delete-user",
    { body: { user_id: userId } },
  );
  if (error) {
    throw new Error(`Failed to delete user: ${error.message}`);
  }
  if (data && "error" in data) {
    throw new Error(`Failed to delete user: ${data.error}`);
  }
}
