# Conversation-View Embed — Design Spec

> **Status:** approved for implementation (2026-07-13)
> **Goal:** Every Fireberry lead card shows the lead's *live* WhatsApp conversation, read-only, embedded via iframe — so any salesperson who opens the card can read the full thread (not just the summary).

## Problem & context

Today the handoff to Fireberry sends only a **summary snapshot** (`lead_memory`). Sales wants the **full conversation**, viewable **inside** the Fireberry lead card, for **every lead**, accessible to **every salesperson** who touches that lead.

Proven during prototyping (2026-07-13):
- Fireberry renders an `<iframe src="…">` inside an **HTML-type field** ("תיבת טקסט (HTML)"). The field label is **"שיחה עם הסוכן וווצאף"**; its **API (backend) name is `pcfconveraiagent`** — this is the name used when writing via Make / the Fireberry API.
- The rich-text/notes field sanitizes iframes — not usable.
- **Supabase cannot serve renderable HTML**: both Edge Functions and Storage force `content-type: text/plain` + `content-security-policy: default-src 'none'; sandbox`. → The rendered page MUST be hosted on Vercel (the dashboard app), not Supabase.
- The Vercel app is public at `https://richer-ai-agents-hub.vercel.app` (200, no SSO on the project alias).

## Architecture

```
Registration → Make → lead-register (edge fn)
                          │  returns signed conversation_view_url
                          ▼
              Make writes URL into Fireberry field "שיחה עם הסוכן וווצאף"
                          ▼
         Fireberry lead card embeds <iframe src="{{that URL}}">
                          ▼
   /embed/c  (Vercel React route, PUBLIC)  reads p/product/sig from URL
                          │  fetch JSON
                          ▼
   conversation-view (edge fn, --no-verify-jwt)  verify HMAC → service_role read → JSON
                          ▼
   /embed/c renders the thread read-only (WhatsApp style, RTL), fresh on load
```

**URL shape (stable, no expiry):**
```
https://richer-ai-agents-hub.vercel.app/embed/c?p=<E164digits>&product=<B|R>&sig=<hmac>
```

## Components

### 1. `_shared/embedLink.ts` (new)
- `signEmbedUrl(phone: string, product: string): string` → full URL with `?p=&product=&sig=`.
- `verifyEmbedSig(phone: string, product: string, sig: string): boolean` → constant-time compare.
- HMAC-SHA256 over canonical `${normalizedPhone}|${product}`, secret `EMBED_LINK_SECRET`, base64url digest.
- **No expiry** — the URL lives permanently in the Fireberry field; access control is delegated to Fireberry record permissions. Secret rotation = global revoke.
- Phone normalization: reuse the exact normalization used at conversation upsert (strip non-digits, drop leading `0`, ensure `972` country prefix — matches the `wa.me/+972…` form seen in Fireberry).

### 2. `conversation-view` edge function (replaces the temporary stub; `--no-verify-jwt`)
- `GET ?p=&product=&sig=`.
- Steps: verify `sig` (constant-time) → map `product` → `agent_id` → look up conversation by `(agent_id, lead_phone = p)` with **service_role** (bypasses admin-only RLS; HMAC is the gate) → load messages chronological (cap ~500) → return **JSON** `{ lead, messages: [{direction, body, kind, created_at}] }`.
- `content-type: application/json` is fine on Supabase (only HTML is neutralized).
- Failure modes: bad/absent sig → 403 JSON; unknown product → 400; no conversation → 200 `{messages: []}`; DB error → 500 + `logError`.

### 3. `/embed/c` route in the Vite/React app (new, PUBLIC — no auth guard)
- Reads `p`, `product`, `sig` from query.
- Fetches JSON from `conversation-view`, renders the approved WhatsApp-style read-only thread (RTL, bubbles, timestamps, voice-transcript label, handoff event).
- **XSS**: escape all message bodies (React does this by default; no `dangerouslySetInnerHTML`).
- **v1 refresh model:** fresh on load only. No realtime / no polling (deferred — see Out of scope).
- Framing: `vercel.json` sets, scoped to `/embed`, `Content-Security-Policy: frame-ancestors https://app.fireberry.com` and no `X-Frame-Options: DENY`.

### 4. `lead-register` change
- Compute `signEmbedUrl(phone, productForAgent)` and add `conversation_view_url` to the JSON response.
- **Fireberry write stays in Make** (consistent with current architecture): in the existing registration scenario, map the returned `conversation_view_url` → Fireberry field **`pcfconveraiagent`** on the lead record Make already creates. No extra API call; one field mapping. Secret never leaves our server.

### 5. One-time backfill
- Script that, for each existing Fireberry lead, computes the deterministic signed URL from (phone, product) and **writes it to `pcfconveraiagent`** via the Fireberry REST API (`PUT /api/record/<leadObjectType>/<id>` with `tokenid` header, body `{ "pcfconveraiagent": "<url>" }`). Idempotent (safe to re-run). Uses `FIREBERRY_API_TOKEN` (same token the existing `scripts/admin/` tooling uses).

## Confirmed inputs
- **Fireberry embed domain:** `app.fireberry.com` (frame-ancestors).
- **Product → agent:** `B` → `affiliate_marketing`; `R` → `digital_marketing`.
- **Fireberry field:** label "שיחה עם הסוכן וווצאף", **API name `pcfconveraiagent`** (HTML type), holds a static `<iframe>`.
- **Embed base URL:** `https://richer-ai-agents-hub.vercel.app/embed/c`.

## Security
- HMAC gate on every request (constant-time verify).
- Record-level permissions in Fireberry govern who sees the field/iframe.
- Rendered content escaped (no raw HTML injection from message bodies).
- `frame-ancestors` restricts embedding to `app.fireberry.com`.
- `EMBED_LINK_SECRET` rotation invalidates all links (kill-switch).
- Accepted trade-off: the URL is a bearer capability (whoever holds it can view without Fireberry login) — inherent to a static-URL-in-a-field model; acceptable for v1.

## Testing (critical core only, per project rules)
- `embedLink.test.ts`: sign/verify round-trip; tampered sig → false; wrong product → false; phone-normalization equivalence (`0525…` vs `+972525…`).
- product→agent mapping.
- HTML/text escaping of rendered bodies (unit).
- No UI-styling tests.

## Rollout sequence (touches production; leads are real people)
1. Land code behind a feature branch → PR → CI green → merge.
2. Set `EMBED_LINK_SECRET` in Supabase secrets.
3. Deploy `conversation-view` (edge) — **from a working network / user's machine** (this environment's egress to Vercel/large uploads is unreliable).
4. Deploy the Vercel app (`vercel deploy --prod`) with the `/embed/c` route + `vercel.json` framing header — from user's machine.
5. Verify `/embed/c?...` renders a real conversation and frames inside a Fireberry lead.
6. Add the `conversation_view_url` mapping in Make (registration scenario).
7. Run the one-time backfill for existing leads.

## Out of scope (v1)
- Realtime / near-realtime updates (polling every ~20–30s or Supabase Realtime) — deferred; fresh-on-load only for now.
- Visual polish of the embed layout (field width in Fireberry form is a Fireberry-side setting).
