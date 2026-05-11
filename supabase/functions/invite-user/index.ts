// invite-user/index.ts
//
// Admin-only edge function that invites a new user via Supabase Auth and
// sets their role + full_name in `public.app_users`. The auth.users INSERT
// fires our trigger which creates an app_users row with role='user', then
// we UPDATE that row to apply the requested role and metadata.
//
// Request:
//   POST /functions/v1/invite-user
//   Authorization: Bearer <admin user's JWT>
//   { "email": string, "role": "admin" | "user", "full_name"?: string }

import { corsHeaders } from "../_shared/cors.ts";
import { HttpError, jsonResponse, requireAdmin } from "../_shared/auth.ts";

interface InvitePayload {
  email: string;
  role: "admin" | "user";
  full_name?: string;
}

function isInvitePayload(value: unknown): value is InvitePayload {
  if (!value || typeof value !== "object") return false;
  const v = value as Record<string, unknown>;
  return (
    typeof v.email === "string" &&
    v.email.includes("@") &&
    (v.role === "admin" || v.role === "user") &&
    (v.full_name === undefined || typeof v.full_name === "string")
  );
}

Deno.serve(async (req) => {
  if (req.method === "OPTIONS") {
    return new Response(null, { headers: corsHeaders });
  }
  if (req.method !== "POST") {
    return jsonResponse({ error: "Method not allowed" }, { status: 405, headers: corsHeaders });
  }

  try {
    const { callerId, admin } = await requireAdmin(req);

    const body = await req.json().catch(() => null);
    if (!isInvitePayload(body)) {
      throw new HttpError(400, "Body must be { email, role, full_name? }");
    }

    // Send invite — Supabase emails the user a magic link to set their password.
    const { data: invite, error: inviteErr } = await admin.auth.admin.inviteUserByEmail(body.email, {
      data: body.full_name ? { full_name: body.full_name } : undefined,
    });
    if (inviteErr) {
      throw new HttpError(400, `Invite failed: ${inviteErr.message}`);
    }
    const newUserId = invite.user?.id;
    if (!newUserId) {
      throw new HttpError(500, "Invite returned no user id");
    }

    // Trigger has already inserted an app_users row with role='user'. Update
    // it with the requested role + metadata.
    const patch: Record<string, unknown> = {
      role: body.role,
      created_by: callerId,
    };
    if (body.full_name) patch.full_name = body.full_name;

    const { error: updateErr } = await admin.from("app_users").update(patch).eq("id", newUserId);
    if (updateErr) {
      // Best effort; the user exists and can still log in, but the role is
      // wrong. Surface the error so the admin can retry / fix manually.
      throw new HttpError(500, `Invite succeeded but role update failed: ${updateErr.message}`);
    }

    return jsonResponse(
      { user_id: newUserId, email: body.email, role: body.role },
      { status: 200, headers: corsHeaders },
    );
  } catch (err) {
    if (err instanceof HttpError) {
      return jsonResponse({ error: err.message }, { status: err.status, headers: corsHeaders });
    }
    console.error("invite-user unexpected error:", err);
    return jsonResponse(
      { error: err instanceof Error ? err.message : "Unknown error" },
      { status: 500, headers: corsHeaders },
    );
  }
});
