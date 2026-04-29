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

`_shared/auth.ts` and `_shared/cors.ts` contain the admin gate and CORS
headers reused by both.

## Deploy

```bash
# All functions, one shot
bun run fn:deploy invite-user --project-ref juoglkqtmjsziieqgmhf
bun run fn:deploy delete-user --project-ref juoglkqtmjsziieqgmhf

# Or individually
bunx supabase functions deploy invite-user --project-ref juoglkqtmjsziieqgmhf
```

`SUPABASE_ACCESS_TOKEN` (in `.env.local`) is required for the CLI; the
runtime env vars (`SUPABASE_URL`, `SUPABASE_ANON_KEY`,
`SUPABASE_SERVICE_ROLE_KEY`) are auto-injected by Supabase into deployed
functions — no secrets management needed.

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
