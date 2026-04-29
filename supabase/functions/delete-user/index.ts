// delete-user/index.ts
//
// Admin-only edge function that hard-deletes a user from Supabase Auth.
// The FK on app_users.id (ON DELETE CASCADE) takes care of the mirror row.
//
// Request:
//   POST /functions/v1/delete-user
//   Authorization: Bearer <admin user's JWT>
//   { "user_id": string }

import { corsHeaders } from "../_shared/cors.ts";
import { HttpError, jsonResponse, requireAdmin } from "../_shared/auth.ts";

interface DeletePayload {
  user_id: string;
}

function isDeletePayload(value: unknown): value is DeletePayload {
  if (!value || typeof value !== "object") return false;
  const v = value as Record<string, unknown>;
  return typeof v.user_id === "string" && v.user_id.length > 0;
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
    if (!isDeletePayload(body)) {
      throw new HttpError(400, "Body must be { user_id }");
    }
    if (body.user_id === callerId) {
      throw new HttpError(400, "Refusing to delete your own account");
    }

    const { error: deleteErr } = await admin.auth.admin.deleteUser(body.user_id);
    if (deleteErr) {
      throw new HttpError(400, `Delete failed: ${deleteErr.message}`);
    }

    return jsonResponse({ user_id: body.user_id, deleted: true }, { status: 200, headers: corsHeaders });
  } catch (err) {
    if (err instanceof HttpError) {
      return jsonResponse({ error: err.message }, { status: err.status, headers: corsHeaders });
    }
    console.error("delete-user unexpected error:", err);
    return jsonResponse(
      { error: err instanceof Error ? err.message : "Unknown error" },
      { status: 500, headers: corsHeaders },
    );
  }
});
