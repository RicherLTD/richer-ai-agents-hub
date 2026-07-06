# Edge functions

Supabase Edge Functions (Deno) used by the dashboard for operations that
need `service_role` access — i.e. anything that reads or mutates
`auth.users`. The dashboard never carries the service_role key itself; it
calls these functions with the signed-in user's JWT, and each function
verifies the caller holds `role='admin'` in `public.app_users` before
acting.

## Functions

| Function | Purpose |
|---|---|
| `invite-user` | Sends a Supabase invite to a new email; sets role on `app_users` |
| `delete-user` | Hard-deletes an `auth.users` row (cascades to `app_users`) |
| `whatsapp-webhook` | Public receiver for HookMyApp inbound webhooks (signed HMAC) + autonomous Claude reply loop (background) — **affiliate_marketing** channel. Thin entrypoint over `_shared/whatsappWebhookHandler.ts` |
| `whatsapp-webhook-dm` | Same handler as `whatsapp-webhook`, for the **digital_marketing** channel (persona תמיר). Reads `_DM`-suffixed secrets so it backs a separate HookMyApp channel / WABA |
| `whatsapp-send` | Authenticated proxy that sends an outbound text via HookMyApp (used by the dashboard ReplyBox for human takeover) |
| `conversation-set-mode` | Authenticated toggle of a conversation between AI mode and manual mode (sets/clears `conversations.manual_mode_since` / `manual_mode_by`) |

`_shared/auth.ts` exposes `requireUser` (any signed-in user) and
`requireAdmin` (admin role). `_shared/cors.ts` is the CORS preflight
shared by browser-callable functions.

## Deploy

```bash
# All functions, one shot
bun run fn:deploy invite-user --project-ref juoglkqtmjsziieqgmhf
bun run fn:deploy delete-user --project-ref juoglkqtmjsziieqgmhf
bun run fn:deploy whatsapp-webhook --no-verify-jwt --project-ref juoglkqtmjsziieqgmhf
bun run fn:deploy whatsapp-webhook-dm --no-verify-jwt --project-ref juoglkqtmjsziieqgmhf
bun run fn:deploy whatsapp-send --project-ref juoglkqtmjsziieqgmhf
bun run fn:deploy conversation-set-mode --project-ref juoglkqtmjsziieqgmhf

# Or individually
bunx supabase functions deploy invite-user --project-ref juoglkqtmjsziieqgmhf
```

`whatsapp-webhook` and `whatsapp-webhook-dm` MUST deploy with
`--no-verify-jwt` — HookMyApp posts to them without a Supabase JWT. Each
does its own auth via the `X-HookMyApp-Signature-256` HMAC.

**Multi-channel secrets.** Both webhook functions run the same shared
handler; each entrypoint supplies its own per-channel credentials. Supabase
secrets are project-wide, so the two channels use distinct names:

| Value | affiliate (`whatsapp-webhook`) | digital marketing (`whatsapp-webhook-dm`) |
|---|---|---|
| HMAC secret | `VERIFY_TOKEN` | `VERIFY_TOKEN_DM` |
| Gateway base URL | `WHATSAPP_API_URL` | `WHATSAPP_API_URL_DM` |
| Channel access token | `WHATSAPP_ACCESS_TOKEN` | `WHATSAPP_ACCESS_TOKEN_DM` |
| Meta phone_number_id | `WHATSAPP_PHONE_NUMBER_ID` | `WHATSAPP_PHONE_NUMBER_ID_DM` |
| Agent slug fallback | `HOOKMYAPP_AGENT_NAME` | (hardcoded `digital_marketing` in the entrypoint) |

Everything else (`ANTHROPIC_API_KEY`, `OPENAI_API_KEY`, `MOOZ_*`,
`HANDOFF_*`, `LANGFUSE_*`, `DASHBOARD_BASE_URL`) is shared across both
channels. Set the `_DM` secrets with `bunx supabase secrets set ...`
before deploying `whatsapp-webhook-dm`.

`SUPABASE_ACCESS_TOKEN` (in `.env.local`) is required for the CLI; the
runtime env vars (`SUPABASE_URL`, `SUPABASE_ANON_KEY`,
`SUPABASE_SERVICE_ROLE_KEY`) are auto-injected by Supabase into deployed
functions — no secrets management needed for those.

## HookMyApp sandbox (whatsapp-webhook + whatsapp-send)

Five secrets, all from the active sandbox session. Easiest path:

```bash
# In the webhook-starter-kit clone (or anywhere with the hookmyapp CLI):
hookmyapp sandbox env --write .env.functions.local
# Add the agent slug + Anthropic key manually — sandbox = single agent.
echo "HOOKMYAPP_AGENT_NAME=affiliate_marketing" >> .env.functions.local
echo "ANTHROPIC_API_KEY=sk-ant-..." >> .env.functions.local
```

Then either run locally or push as deployed secrets:

```bash
# Local serve (port 54321 by default)
bunx supabase functions serve --env-file .env.functions.local

# Deployed
bunx supabase secrets set --env-file .env.functions.local --project-ref juoglkqtmjsziieqgmhf
```

Local dev tunnel — point the sandbox listener at the local function URL:

```bash
hookmyapp sandbox listen \
  --port 54321 \
  --path /functions/v1/whatsapp-webhook \
  --phone +972525563338
```

### No Docker? Use the proxy

`bunx supabase functions serve` requires Docker. If Docker isn't installed,
the deployed function is reachable but `hookmyapp sandbox listen` only
forwards to `localhost`. Bridge the gap with [scripts/wa-tunnel-proxy.mjs](../../scripts/wa-tunnel-proxy.mjs):

```bash
# Terminal 1 — local proxy (forwards localhost:54321 → deployed function)
SUPABASE_URL=https://juoglkqtmjsziieqgmhf.supabase.co bun run wa:proxy

# Terminal 2 — sandbox tunnel pointed at the proxy
hookmyapp sandbox listen \
  --port 54321 \
  --path /functions/v1/whatsapp-webhook \
  --phone +972525563338
```

The proxy preserves the raw body and `X-HookMyApp-Signature-256` header
so the deployed function's HMAC verification still passes. Production
WABAs don't need this — register the function URL directly with
`hookmyapp webhook set <waba-id> --url ... --verify-token ...`.

## Smoke test (curl)

```bash
# Sign in to get a JWT (or grab one from a browser session)
JWT="..."

# Should return 403 if the caller isn't admin
curl -X POST "$VITE_SUPABASE_URL/functions/v1/invite-user" \
  -H "Authorization: Bearer $JWT" \
  -H "Content-Type: application/json" \
  -d '{"email":"new@example.com","role":"user"}'
```

## Why edge functions and not direct admin API calls?

`auth.users` mutations require the `service_role` key. We never want that
key in the browser bundle, so the dashboard calls these functions
instead. The functions act as a thin authorisation layer in front of the
admin API.
