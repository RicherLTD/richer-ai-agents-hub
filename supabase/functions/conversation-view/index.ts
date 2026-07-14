// Public (--no-verify-jwt) JSON API backing the /embed/c page.
// Security gate is the HMAC signature (EMBED_LINK_SECRET), NOT a JWT.
// Returns the lead's WhatsApp conversation as JSON. Never returns HTML
// (Supabase neutralizes HTML from the functions domain).
import { createClient } from "https://esm.sh/@supabase/supabase-js@2.45.4";
import { verifyEmbedSig } from "../_shared/embedLink.ts";
import { toCanonicalPhone } from "../_shared/normalizePhone.ts";

const headers = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Headers": "authorization, x-client-info, apikey, content-type",
  "Access-Control-Allow-Methods": "GET, POST, OPTIONS",
  "Content-Type": "application/json",
  "Cache-Control": "no-store",
};

function json(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), { status, headers });
}

// Accept params from query string (GET) or JSON body (POST via invoke).
async function readParams(req: Request): Promise<{ p: string; product: string; sig: string }> {
  if (req.method === "POST") {
    const b = await req.json().catch(() => ({}));
    return { p: String(b.p ?? ""), product: String(b.product ?? ""), sig: String(b.sig ?? "") };
  }
  const u = new URL(req.url);
  return {
    p: u.searchParams.get("p") ?? "",
    product: u.searchParams.get("product") ?? "",
    sig: u.searchParams.get("sig") ?? "",
  };
}

Deno.serve(async (req) => {
  if (req.method === "OPTIONS") return new Response(null, { status: 204, headers });
  if (req.method !== "GET" && req.method !== "POST") return json({ error: "method" }, 405);

  const secret = Deno.env.get("EMBED_LINK_SECRET");
  const supabaseUrl = Deno.env.get("SUPABASE_URL");
  const serviceRoleKey = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY");
  if (!secret || !supabaseUrl || !serviceRoleKey) return json({ error: "server_misconfig" }, 500);

  const { p, product, sig } = await readParams(req);
  if (!p || !product || !sig) return json({ error: "bad_request" }, 400);

  if (!(await verifyEmbedSig(p, product, sig, secret))) {
    return json({ error: "forbidden" }, 403);
  }

  // Canonicalize the phone before the DB lookup. The sig already verified over
  // the canonical form, so this is non-null in practice — but guard anyway.
  const canonicalPhone = toCanonicalPhone(p);
  if (!canonicalPhone) return json({ error: "bad_request" }, 400);

  const admin = createClient(supabaseUrl, serviceRoleKey, {
    auth: { persistSession: false, autoRefreshToken: false },
  });

  // product (B/R) -> agent
  const { data: agent } = await admin
    .from("agents")
    .select("id")
    .eq("mooz_product_code", product)
    .maybeSingle();
  if (!agent) return json({ error: "unknown_product" }, 400);

  const { data: conv, error: convErr } = await admin
    .from("conversations")
    .select("id, lead_name, lead_phone")
    .eq("agent_id", agent.id)
    .eq("lead_phone", canonicalPhone)
    .maybeSingle();
  if (convErr) return json({ error: "db_error" }, 500);

  if (!conv) return json({ lead: null, messages: [] });

  const { data: messages, error: msgErr } = await admin
    .from("messages")
    .select("direction, content, message_type, timestamp")
    .eq("conversation_id", conv.id)
    .order("timestamp", { ascending: true, nullsFirst: true })
    .limit(500);
  if (msgErr) return json({ error: "db_error" }, 500);

  return json({
    lead: { name: conv.lead_name, phone: conv.lead_phone },
    messages: messages ?? [],
  });
});
