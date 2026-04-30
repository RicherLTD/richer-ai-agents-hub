// scripts/wa-tunnel-proxy.mjs
//
// Local Bun HTTP server that bridges `hookmyapp sandbox listen` to a
// deployed Supabase Edge Function while we don't run the function locally.
//
// Why this exists:
//   `hookmyapp sandbox listen` always tunnels through Cloudflare to a
//   localhost port — there's no way to point the sandbox webhook at a
//   public URL directly. `bunx supabase functions serve` would let us
//   run the function locally, but it requires Docker. On a machine
//   without Docker, this proxy is the missing link: HookMyApp's sandbox
//   forwarder hits localhost:54321, which forwards bytes-for-bytes to
//   the deployed function URL. The HMAC signature is on the body, so
//   pass-through preserves it.
//
// Production WABA does NOT need this — the deployed function URL is
// public and `hookmyapp webhook set <waba-id> --url ...` registers it
// directly with Meta.
//
// Usage:
//   SUPABASE_URL=https://<ref>.supabase.co bun run wa:proxy
//
// Or with the default port / path:
//   SUPABASE_URL=https://juoglkqtmjsziieqgmhf.supabase.co \
//   bun scripts/wa-tunnel-proxy.mjs
//
// Then in another terminal:
//   hookmyapp sandbox listen \
//     --port 54321 \
//     --path /functions/v1/whatsapp-webhook \
//     --phone +<E164>

const PORT = Number(process.env.WA_PROXY_PORT ?? 54321);
const FUNCTION_PATH = process.env.WA_FUNCTION_PATH ?? "/functions/v1/whatsapp-webhook";
const supabaseUrl = process.env.SUPABASE_URL;

if (!supabaseUrl) {
  console.error("✗ Set SUPABASE_URL (e.g. https://<ref>.supabase.co) before running this script.");
  process.exit(1);
}

const TARGET = `${supabaseUrl.replace(/\/$/, "")}${FUNCTION_PATH}`;

Bun.serve({
  port: PORT,
  async fetch(req) {
    const url = new URL(req.url);
    if (url.pathname !== FUNCTION_PATH) {
      return new Response("Not found", { status: 404 });
    }
    const body = req.method === "GET" || req.method === "HEAD" ? undefined : await req.arrayBuffer();
    const headers = new Headers(req.headers);
    // Strip hop-by-hop headers; host gets rewritten by fetch, content-length
    // by the body re-serialization.
    headers.delete("host");
    headers.delete("content-length");

    const upstream = await fetch(TARGET, { method: req.method, headers, body });
    const respBody = await upstream.arrayBuffer();
    console.log(
      `[${new Date().toISOString()}] ${req.method} ${url.pathname} -> ${upstream.status} (${respBody.byteLength}b)`,
    );
    return new Response(respBody, { status: upstream.status, headers: upstream.headers });
  },
});
console.log(`wa-tunnel-proxy listening on localhost:${PORT} -> ${TARGET}`);
