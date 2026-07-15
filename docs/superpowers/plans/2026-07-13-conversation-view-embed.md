# Conversation-View Embed Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Every Fireberry lead card shows that lead's live WhatsApp conversation, read-only, embedded via `<iframe>`, for any salesperson who opens the card.

**Architecture:** A deterministic HMAC-signed URL (`/embed/c?p=&product=&sig=`) is stored in the Fireberry HTML field `pcfconveraiagent`. Opening the card loads that URL from the Vercel-hosted dashboard app (Supabase can't serve HTML). The public `/embed/c` React route reads the params, calls the `conversation-view` edge function (which verifies the HMAC and reads messages with service_role), and renders the thread read-only. New leads get the URL via `lead-register` → Make; existing leads via a one-time backfill.

**Tech Stack:** Supabase Edge Functions (Deno, `@supabase/supabase-js@2.45.4`), Vite + React 18 + react-router-dom v6, Tailwind, Vitest, Python 3 (backfill).

**Spec:** `docs/superpowers/specs/2026-07-13-conversation-view-embed-design.md`

**Conventions locked from the codebase:**
- Canonical phone: `toCanonicalPhone()` in `supabase/functions/_shared/normalizePhone.ts` → `972XXXXXXXXX` (digits, no `+`).
- Product code: `agents.mooz_product_code` = `"B"` (affiliate) / `"R"` (digital). (Not in `src/types/database.ts` — stale types; select it explicitly and cast.)
- Messages: columns `direction` (`"inbound"|"outbound"`), `content` (text), `message_type`, `timestamp` (NOT `created_at`).
- Edge fn service_role client: `createClient(Deno.env.get("SUPABASE_URL"), Deno.env.get("SUPABASE_SERVICE_ROLE_KEY"), { auth: { persistSession: false, autoRefreshToken: false } })`, pinned `https://esm.sh/@supabase/supabase-js@2.45.4`.
- Dashboard base URL env: `DASHBOARD_BASE_URL` (trailing slash stripped with `.replace(/\/$/, "")`).
- Tests: Vitest (`describe/it/expect`), run `bun run test`. Include glob already covers `supabase/functions/**/*.test.ts`.
- Front-end edge-fn call: `supabase.functions.invoke<T>(name, { body })` (sends anon apikey; fine for `--no-verify-jwt`).

**Branching:** Work on a dedicated branch `feat/conversation-view-embed`. Commit frequently. Do NOT push to `main`.

---

## File structure

| File | Responsibility | Action |
|---|---|---|
| `supabase/functions/_shared/embedLink.ts` | Sign / verify / build the embed URL (HMAC over `phone|product`) | Create |
| `supabase/functions/_shared/embedLink.test.ts` | Unit tests for the above | Create |
| `supabase/functions/conversation-view/index.ts` | Public JSON API: verify sig → read messages → JSON | Replace stub |
| `src/lib/embed.ts` | Front-end fetch wrapper for the edge function | Create |
| `src/lib/embed.test.ts` | Unit test for the wrapper | Create |
| `src/pages/EmbedConversation.tsx` | Public read-only thread page (`/embed/c`) | Create |
| `src/App.tsx` | Register the public `/embed/c` route | Modify |
| `vercel.json` | `frame-ancestors` header scoped to `/embed` | Modify |
| `supabase/functions/lead-register/index.ts` | Return `conversation_view_url` | Modify |
| `scripts/admin/backfill-conversation-view.py` | One-time backfill of existing leads | Create |

---

## Task 1: `embedLink.ts` signing utility (TDD)

**Files:**
- Create: `supabase/functions/_shared/embedLink.ts`
- Test: `supabase/functions/_shared/embedLink.test.ts`

- [ ] **Step 1: Write the failing test**

Create `supabase/functions/_shared/embedLink.test.ts`:

```ts
import { describe, expect, it } from "vitest";
import { buildEmbedUrl, signEmbedToken, verifyEmbedSig } from "./embedLink.ts";

const SECRET = "test-secret-123";

describe("signEmbedToken", () => {
  it("returns a stable hex signature for the same phone+product", async () => {
    const a = await signEmbedToken("0525188599", "B", SECRET);
    const b = await signEmbedToken("+972525188599", "B", SECRET);
    expect(a).not.toBeNull();
    expect(a).toBe(b); // phone is normalized before signing
    expect(a).toMatch(/^[0-9a-f]{64}$/);
  });

  it("returns null for an invalid phone", async () => {
    expect(await signEmbedToken("hello", "B", SECRET)).toBeNull();
  });

  it("returns null for an unknown product", async () => {
    expect(await signEmbedToken("0525188599", "X", SECRET)).toBeNull();
  });
});

describe("verifyEmbedSig", () => {
  it("accepts a signature it produced", async () => {
    const sig = await signEmbedToken("972525188599", "R", SECRET);
    expect(await verifyEmbedSig("972525188599", "R", sig!, SECRET)).toBe(true);
  });

  it("rejects a tampered signature", async () => {
    const sig = await signEmbedToken("972525188599", "R", SECRET);
    const bad = sig!.slice(0, -1) + (sig!.endsWith("0") ? "1" : "0");
    expect(await verifyEmbedSig("972525188599", "R", bad, SECRET)).toBe(false);
  });

  it("rejects when the product is swapped", async () => {
    const sig = await signEmbedToken("972525188599", "B", SECRET);
    expect(await verifyEmbedSig("972525188599", "R", sig!, SECRET)).toBe(false);
  });

  it("rejects an invalid phone outright", async () => {
    expect(await verifyEmbedSig("nope", "B", "deadbeef", SECRET)).toBe(false);
  });
});

describe("buildEmbedUrl", () => {
  it("builds a canonical URL with normalized phone", async () => {
    const url = await buildEmbedUrl("https://app.example.com/", "0525188599", "B", SECRET);
    expect(url).not.toBeNull();
    expect(url).toMatch(
      /^https:\/\/app\.example\.com\/embed\/c\?p=972525188599&product=B&sig=[0-9a-f]{64}$/,
    );
  });

  it("returns null for an invalid phone", async () => {
    expect(await buildEmbedUrl("https://x.com", "bad", "B", SECRET)).toBeNull();
  });
});
```

- [ ] **Step 2: Run the test to verify it fails**

Run: `bun run test -- embedLink`
Expected: FAIL — `Cannot find module './embedLink.ts'`.

- [ ] **Step 3: Write the implementation**

Create `supabase/functions/_shared/embedLink.ts`:

```ts
// Signs / verifies the deterministic, non-expiring embed URL used to show a
// lead's WhatsApp conversation inside the Fireberry card.
//
// The signature is HMAC-SHA256 over the canonical string `${phone}|${product}`.
// It is STABLE (no timestamp) because the URL lives permanently in a Fireberry
// field; access is governed by Fireberry record permissions, and rotating
// EMBED_LINK_SECRET revokes every link at once.
import { toCanonicalPhone } from "./normalizePhone.ts";

const VALID_PRODUCTS = new Set(["B", "R"]);

async function hmacSha256Hex(key: string, body: string): Promise<string> {
  const enc = new TextEncoder();
  const cryptoKey = await crypto.subtle.importKey(
    "raw",
    enc.encode(key),
    { name: "HMAC", hash: "SHA-256" },
    false,
    ["sign"],
  );
  const sig = await crypto.subtle.sign("HMAC", cryptoKey, enc.encode(body));
  return Array.from(new Uint8Array(sig), (b) => b.toString(16).padStart(2, "0")).join("");
}

// Constant-time compare (mirrors whatsappWebhookHandler.ts).
function timingSafeEqual(a: string, b: string): boolean {
  const len = Math.max(a.length, b.length);
  let diff = a.length ^ b.length;
  for (let i = 0; i < len; i++) {
    const ca = i < a.length ? a.charCodeAt(i) : 0xffff;
    const cb = i < b.length ? b.charCodeAt(i) : 0xffff;
    diff |= ca ^ cb;
  }
  return diff === 0;
}

// Canonical signable payload, or null if inputs are invalid.
function canonicalPayload(phone: string, product: string): string | null {
  const p = toCanonicalPhone(phone);
  if (!p) return null;
  if (!VALID_PRODUCTS.has(product)) return null;
  return `${p}|${product}`;
}

export async function signEmbedToken(
  phone: string,
  product: string,
  secret: string,
): Promise<string | null> {
  const payload = canonicalPayload(phone, product);
  if (!payload) return null;
  return await hmacSha256Hex(secret, payload);
}

export async function verifyEmbedSig(
  phone: string,
  product: string,
  sig: string,
  secret: string,
): Promise<boolean> {
  const payload = canonicalPayload(phone, product);
  if (!payload) return false;
  const expected = await hmacSha256Hex(secret, payload);
  return timingSafeEqual(sig, expected);
}

// Full embed URL: `${base}/embed/c?p=<canonical>&product=<B|R>&sig=<hex>`.
export async function buildEmbedUrl(
  baseUrl: string,
  phone: string,
  product: string,
  secret: string,
): Promise<string | null> {
  const p = toCanonicalPhone(phone);
  const sig = await signEmbedToken(phone, product, secret);
  if (!p || !sig) return null;
  const base = baseUrl.replace(/\/$/, "");
  return `${base}/embed/c?p=${p}&product=${product}&sig=${sig}`;
}
```

- [ ] **Step 4: Run the test to verify it passes**

Run: `bun run test -- embedLink`
Expected: PASS (all cases green).

- [ ] **Step 5: Commit**

```bash
git add supabase/functions/_shared/embedLink.ts supabase/functions/_shared/embedLink.test.ts
git commit -m "feat(embed): add HMAC-signed embed URL util"
```

---

## Task 2: `conversation-view` edge function — JSON API

**Files:**
- Modify (replace the temporary HTML stub): `supabase/functions/conversation-view/index.ts`

- [ ] **Step 1: Replace the stub with the JSON API**

Overwrite `supabase/functions/conversation-view/index.ts`:

```ts
// Public (--no-verify-jwt) JSON API backing the /embed/c page.
// Security gate is the HMAC signature (EMBED_LINK_SECRET), NOT a JWT.
// Returns the lead's WhatsApp conversation as JSON. Never returns HTML
// (Supabase neutralizes HTML from the functions domain).
import { createClient } from "https://esm.sh/@supabase/supabase-js@2.45.4";
import { verifyEmbedSig } from "../_shared/embedLink.ts";

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
  if (req.method === "OPTIONS") return new Response(null, { headers });
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

  const { data: conv } = await admin
    .from("conversations")
    .select("id, lead_name, lead_phone")
    .eq("agent_id", agent.id)
    .eq("lead_phone", p)
    .maybeSingle();

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
```

- [ ] **Step 2: Typecheck the project**

Run: `bun x tsc --noEmit`
Expected: PASS (no type errors introduced). Note: `mooz_product_code` is a valid DB column but absent from the stale `database.ts`; the edge function is Deno and not covered by `tsc` for the app, so no error is expected. If `tsc` complains about the edge file, it is excluded from the app tsconfig — confirm the edge `functions/` dir is not in the app `tsconfig` include globs.

- [ ] **Step 3: Commit**

```bash
git add supabase/functions/conversation-view/index.ts
git commit -m "feat(embed): conversation-view JSON API with HMAC gate"
```

> Deployment + live curl verification happens in Task 8 (needs `EMBED_LINK_SECRET` set + deploy from a working network).

---

## Task 3: `/embed/c` public page + front-end fetch wrapper (TDD)

**Files:**
- Create: `src/lib/embed.ts`
- Test: `src/lib/embed.test.ts`
- Create: `src/pages/EmbedConversation.tsx`
- Modify: `src/App.tsx`

- [ ] **Step 1: Write the failing test for the fetch wrapper**

Create `src/lib/embed.test.ts`:

```ts
import { beforeEach, describe, expect, it, vi } from "vitest";

const { invokeMock } = vi.hoisted(() => ({ invokeMock: vi.fn() }));
vi.mock("@/lib/supabase/client", () => ({
  supabase: { functions: { invoke: invokeMock } },
}));

import { fetchEmbedConversation } from "./embed";

beforeEach(() => invokeMock.mockReset());

describe("fetchEmbedConversation", () => {
  it("invokes conversation-view with the url params and returns data", async () => {
    invokeMock.mockResolvedValue({
      data: { lead: { name: "דני", phone: "972525188599" }, messages: [] },
      error: null,
    });
    const res = await fetchEmbedConversation({ p: "972525188599", product: "B", sig: "abc" });
    expect(invokeMock).toHaveBeenCalledWith("conversation-view", {
      body: { p: "972525188599", product: "B", sig: "abc" },
    });
    expect(res.lead?.name).toBe("דני");
    expect(res.messages).toEqual([]);
  });

  it("throws when the edge function errors", async () => {
    invokeMock.mockResolvedValue({ data: null, error: { message: "forbidden" } });
    await expect(
      fetchEmbedConversation({ p: "x", product: "B", sig: "bad" }),
    ).rejects.toThrow(/forbidden/);
  });
});
```

- [ ] **Step 2: Run the test to verify it fails**

Run: `bun run test -- src/lib/embed`
Expected: FAIL — `Cannot find module './embed'`.

- [ ] **Step 3: Implement the fetch wrapper**

Create `src/lib/embed.ts`:

```ts
import { supabase } from "@/lib/supabase/client";

export interface EmbedMessage {
  direction: "inbound" | "outbound";
  content: string | null;
  message_type: string | null;
  timestamp: string | null;
}

export interface EmbedConversation {
  lead: { name: string | null; phone: string } | null;
  messages: EmbedMessage[];
}

export interface EmbedParams {
  p: string;
  product: string;
  sig: string;
}

export async function fetchEmbedConversation(params: EmbedParams): Promise<EmbedConversation> {
  const { data, error } = await supabase.functions.invoke<EmbedConversation>("conversation-view", {
    body: { p: params.p, product: params.product, sig: params.sig },
  });
  if (error) throw new Error(`Failed to load conversation: ${error.message}`);
  if (!data) throw new Error("No conversation data returned");
  return data;
}
```

- [ ] **Step 4: Run the test to verify it passes**

Run: `bun run test -- src/lib/embed`
Expected: PASS.

- [ ] **Step 5: Create the page component**

Create `src/pages/EmbedConversation.tsx`:

```tsx
import { useEffect, useRef, useState } from "react";
import { useSearchParams } from "react-router-dom";
import { fetchEmbedConversation, type EmbedConversation as Conv } from "@/lib/embed";

function formatTime(ts: string | null): string {
  if (!ts) return "";
  const d = new Date(ts);
  if (Number.isNaN(d.getTime())) return "";
  return d.toLocaleTimeString("he-IL", { hour: "2-digit", minute: "2-digit" });
}

export default function EmbedConversation() {
  const [params] = useSearchParams();
  const [conv, setConv] = useState<Conv | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [loading, setLoading] = useState(true);
  const bottomRef = useRef<HTMLDivElement>(null);

  const p = params.get("p") ?? "";
  const product = params.get("product") ?? "";
  const sig = params.get("sig") ?? "";

  useEffect(() => {
    let alive = true;
    setLoading(true);
    fetchEmbedConversation({ p, product, sig })
      .then((d) => alive && (setConv(d), setError(null)))
      .catch((e) => alive && setError(e.message))
      .finally(() => alive && setLoading(false));
    return () => {
      alive = false;
    };
  }, [p, product, sig]);

  useEffect(() => {
    bottomRef.current?.scrollIntoView();
  }, [conv]);

  return (
    <div dir="rtl" className="flex h-screen w-full flex-col bg-[#e7ddd3] font-sans">
      <header className="flex items-center justify-between gap-3 bg-[#0b6b5e] px-4 py-2.5 text-[#f2fbf8]">
        <span className="truncate font-bold">{conv?.lead?.name || "שיחה עם הליד"}</span>
        <span className="rounded-full bg-white/90 px-2.5 py-1 text-xs font-semibold text-[#0b6b5e]">
          🔒 צפייה בלבד
        </span>
      </header>

      <main className="flex flex-1 flex-col gap-1 overflow-y-auto px-3 py-4">
        {loading && <p className="mt-8 text-center text-sm text-[#5f7b73]">טוען שיחה…</p>}
        {error && (
          <p className="mt-8 text-center text-sm text-[#5f7b73]">
            לא ניתן לטעון את השיחה. רענן את הכרטיס.
          </p>
        )}
        {!loading && !error && conv && conv.messages.length === 0 && (
          <p className="mt-8 text-center text-sm text-[#5f7b73]">עדיין אין שיחה עם הליד הזה.</p>
        )}
        {conv?.messages.map((m, i) => {
          const out = m.direction === "outbound";
          return (
            <div key={i} className={`flex ${out ? "justify-start" : "justify-end"}`}>
              <div
                className={`max-w-[78%] whitespace-pre-wrap break-words rounded-lg px-3 py-2 text-sm shadow-sm ${
                  out ? "rounded-tl-sm bg-[#d9fdd3]" : "rounded-tr-sm bg-white"
                }`}
              >
                <span className="text-[#10231d]">{m.content?.trim() || "(הודעה ריקה)"}</span>
                <span className="mt-0.5 block text-left text-[10px] tabular-nums text-[#5f7b73]">
                  {formatTime(m.timestamp)}
                </span>
              </div>
            </div>
          );
        })}
        <div ref={bottomRef} />
      </main>

      <footer className="bg-[#f6f1ea] px-4 py-2.5 text-center text-xs font-semibold text-[#5f7b73]">
        🔒 צפייה בלבד — לא ניתן לשלוח הודעות מכאן
      </footer>
    </div>
  );
}
```

> Message bodies render via React text interpolation (`{m.content}`), which auto-escapes — no XSS risk, no `dangerouslySetInnerHTML`.

- [ ] **Step 6: Register the public route in `src/App.tsx`**

Add the import near the other page imports:

```tsx
import EmbedConversation from "@/pages/EmbedConversation";
```

Add this route as a **sibling of `/login`** (a public route, NOT inside the `<ProtectedRoute>` parent), and it MUST stay above the catch-all `<Route path="*">`:

```tsx
{/* Public embed — no auth. Rendered inside a Fireberry lead card via iframe. */}
<Route path="/embed/c" element={<EmbedConversation />} />
```

- [ ] **Step 7: Run tests + typecheck + build**

Run: `bun run test -- src/lib/embed`
Expected: PASS.
Run: `bun x tsc --noEmit`
Expected: PASS.
Run: `bun run build`
Expected: build succeeds.

- [ ] **Step 8: Commit**

```bash
git add src/lib/embed.ts src/lib/embed.test.ts src/pages/EmbedConversation.tsx src/App.tsx
git commit -m "feat(embed): public /embed/c read-only conversation page"
```

---

## Task 4: `vercel.json` framing header

**Files:**
- Modify: `vercel.json`

- [ ] **Step 1: Add a scoped `frame-ancestors` header**

Replace `vercel.json` with:

```json
{
  "$schema": "https://openapi.vercel.sh/vercel.json",
  "rewrites": [
    { "source": "/(.*)", "destination": "/index.html" }
  ],
  "headers": [
    {
      "source": "/embed/(.*)",
      "headers": [
        {
          "key": "Content-Security-Policy",
          "value": "frame-ancestors https://app.fireberry.com https://*.fireberry.com"
        }
      ]
    }
  ]
}
```

- [ ] **Step 2: Commit**

```bash
git add vercel.json
git commit -m "chore(embed): allow Fireberry to frame /embed via CSP"
```

> Verified live after deploy (Task 8): the header must NOT be `X-Frame-Options: DENY` and must permit `app.fireberry.com`.

---

## Task 5: `lead-register` returns `conversation_view_url` (TDD-ish)

**Files:**
- Modify: `supabase/functions/lead-register/index.ts`

- [ ] **Step 1: Add `mooz_product_code` to the agent select**

Find the agent loader (`.from("agents").select("id, is_paused, first_touch_template_name, first_touch_template_language, first_touch_delay_minutes")`) and add the product column:

```ts
  const { data } = await admin
    .from("agents")
    .select(
      "id, is_paused, mooz_product_code, first_touch_template_name, first_touch_template_language, first_touch_delay_minutes",
    )
    .eq("name", agentSlug)
    .maybeSingle();
```

- [ ] **Step 2: Build the embed URL after the conversation exists**

Import at the top of the file (near the other `_shared` imports):

```ts
import { buildEmbedUrl } from "../_shared/embedLink.ts";
```

After `conversationId` is known and before the response(s), compute the URL (best-effort; never blocks registration):

```ts
  // Deterministic, non-expiring link to this lead's conversation view.
  // Written by Make into the Fireberry field `pcfconveraiagent`.
  let conversationViewUrl: string | null = null;
  const embedSecret = Deno.env.get("EMBED_LINK_SECRET");
  const dashboardBase = Deno.env.get("DASHBOARD_BASE_URL");
  const productCode = (data as { mooz_product_code?: string | null } | null)?.mooz_product_code ?? null;
  if (embedSecret && dashboardBase && productCode) {
    conversationViewUrl = await buildEmbedUrl(dashboardBase, lead_phone, productCode, embedSecret);
  }
```

(Use the actual variable names present in the file for the agent row and the canonical `lead_phone`.)

- [ ] **Step 3: Add `conversation_view_url` to each success response**

Update the three success `jsonResponse(...)` calls to include the field:

```ts
      return jsonResponse({ ok: true, paused: true, conversation_id: conversationId, conversation_view_url: conversationViewUrl });
```

```ts
      return jsonResponse({
        ok: true,
        template_not_configured: true,
        conversation_id: conversationId,
        conversation_view_url: conversationViewUrl,
      });
```

```ts
    return jsonResponse({
      ok: true,
      conversation_id: conversationId,
      conversation_view_url: conversationViewUrl,
      ...queueResult,
    });
```

- [ ] **Step 4: Typecheck**

Run: `bun x tsc --noEmit`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add supabase/functions/lead-register/index.ts
git commit -m "feat(embed): lead-register returns conversation_view_url"
```

---

## Task 6: Manual setup — secret, Fireberry field, Make mapping (procedural, no code)

- [ ] **Step 1: Set the shared secret in Supabase**

Generate a strong random secret and set it (run from the user's machine):

```bash
EMBED_LINK_SECRET=$(openssl rand -hex 32)
echo "EMBED_LINK_SECRET=$EMBED_LINK_SECRET" >> .env.functions.local
SUPABASE_ACCESS_TOKEN='<fresh token>' bunx supabase secrets set EMBED_LINK_SECRET="$EMBED_LINK_SECRET" --project-ref juoglkqtmjsziieqgmhf
```

The SAME value is needed by the backfill script (Task 8). Keep it in `.env.functions.local` (gitignored).

- [ ] **Step 2: Confirm the Fireberry field**

The HTML field already exists: label "שיחה עם הסוכן וווצאף", API name `pcfconveraiagent`, on the lead object (objectType 1). Ensure it is placed full-width on the lead form for good layout.

- [ ] **Step 3: Add the Make mapping (registration scenario)**

In the Make registration scenario, on the Fireberry "create/update lead" module, map field `pcfconveraiagent` to the value:

```
<iframe src="{{conversation_view_url from lead-register response}}" style="width:100%;height:720px;border:0;border-radius:12px;" title="שיחה עם הליד"></iframe>
```

(The `lead-register` HTTP response now includes `conversation_view_url`.)

---

## Task 7: Deploy + live verification (procedural, from the user's machine)

> The AI environment cannot deploy (network egress to Vercel/large uploads fails). These run from the user's machine.

- [ ] **Step 1: Deploy the edge function**

```bash
cd /Users/izhaksiton/Code/work/richer-ai-agents-hub
SUPABASE_ACCESS_TOKEN='<fresh token>' bunx supabase functions deploy conversation-view --no-verify-jwt --project-ref juoglkqtmjsziieqgmhf
```

- [ ] **Step 2: Deploy the Vercel app to production**

```bash
bunx vercel deploy --prod
```
(If a large upload fails, retry or use `--archive=tgz`.)

- [ ] **Step 3: Verify with a real lead**

Generate a URL for a known lead (compute with the backfill script in `--one <phone> <B|R>` mode, Task 8), open it in a browser, confirm the real conversation renders. Then confirm it renders inside a Fireberry lead card, and check the response header:

```bash
curl -sS -D - -o /dev/null "https://richer-ai-agents-hub.vercel.app/embed/c?p=...&product=B&sig=..." | grep -i "content-security-policy"
```
Expected: `content-security-policy: frame-ancestors https://app.fireberry.com https://*.fireberry.com` and NO `x-frame-options: DENY`.

---

## Task 8: One-time backfill for existing leads

**Files:**
- Create: `scripts/admin/backfill-conversation-view.py`

- [ ] **Step 1: Confirm the Fireberry record-update endpoint (ONE record, manually)**

The existing script only READS (`POST /api/v3/query`). Before bulk-writing, confirm the update endpoint on ONE test lead. Fireberry v3 update is a record upsert; verify which of these your tenant accepts (run against a throwaway test lead id, replacing `<TOKEN>`/`<ID>`):

```bash
curl -sS -X PUT "https://api.fireberry.com/api/record/1/<ID>" \
  -H "tokenid: <TOKEN>" -H "Content-Type: application/json" \
  -d '{"pcfconveraiagent":"<iframe>TEST</iframe>"}'
```
Record which endpoint/verb returns success; use it in Step 2. **Do not proceed to bulk until one record updates correctly and shows in the card.**

- [ ] **Step 2: Write the backfill script**

Create `scripts/admin/backfill-conversation-view.py`:

```python
#!/usr/bin/env python3
"""Backfill the Fireberry `pcfconveraiagent` field with a signed conversation-view
iframe for existing leads. Deterministic: URL = HMAC(phone|product).

Usage:
  # dry run — prints what it WOULD write, changes nothing:
  EMBED_LINK_SECRET=... python3 scripts/admin/backfill-conversation-view.py
  # write for real:
  EMBED_LINK_SECRET=... python3 scripts/admin/backfill-conversation-view.py --apply
  # single lead (for verification):
  EMBED_LINK_SECRET=... python3 scripts/admin/backfill-conversation-view.py --one 0525188599 B
"""
import hashlib
import hmac
import json
import os
import platform
import re
import subprocess
import sys
import urllib.request

BASE = "https://richer-ai-agents-hub.vercel.app"
API = "https://api.fireberry.com"
# Map the Fireberry product field value -> mooz product code (B/R).
# CONFIRM these against real values of pcfsystemfield122 before --apply.
PRODUCT_MAP = {"שיווק שותפים": "B", "שיווק דיגיטלי": "R"}


def get_token():
    v = os.environ.get("FIREBERRY_API_TOKEN")
    if v:
        return v
    if platform.system() == "Darwin":
        r = subprocess.run(
            ["security", "find-generic-password", "-s", "FIREBERRY_API_TOKEN",
             "-a", os.environ.get("USER", ""), "-w"],
            capture_output=True, text=True)
        if r.returncode == 0:
            return r.stdout.strip()
    return None


def canonical_phone(raw):
    t = re.sub(r"[\s\-()]", "", (raw or "").strip())
    if re.fullmatch(r"\+972\d{8,9}", t):
        return t[1:]
    if re.fullmatch(r"972\d{8,9}", t):
        return t
    if re.fullmatch(r"0\d{8,9}", t):
        return "972" + t[1:]
    return None


def sign(phone, product, secret):
    payload = f"{phone}|{product}".encode()
    return hmac.new(secret.encode(), payload, hashlib.sha256).hexdigest()


def build_url(phone, product, secret):
    p = canonical_phone(phone)
    if not p or product not in ("B", "R"):
        return None
    return f"{BASE}/embed/c?p={p}&product={product}&sig={sign(p, product, secret)}"


def iframe(url):
    return (f'<iframe src="{url}" style="width:100%;height:720px;border:0;'
            f'border-radius:12px;" title="שיחה עם הליד"></iframe>')


def query_leads(token, page):
    body = {
        "objectType": 1,
        "fields": [{"name": "accountid"}, {"name": "telephone1"},
                   {"name": "pcfsystemfield122"}],
        "pageSize": 200, "pageNumber": page,
    }
    req = urllib.request.Request(
        f"{API}/api/v3/query", data=json.dumps(body).encode(),
        headers={"tokenid": token, "Content-Type": "application/json"}, method="POST")
    with urllib.request.urlopen(req) as resp:
        return json.loads(resp.read()).get("data", [])


def update_lead(token, rec_id, value):
    # Endpoint/verb confirmed in Task 8 Step 1.
    body = {"pcfconveraiagent": value}
    req = urllib.request.Request(
        f"{API}/api/record/1/{rec_id}", data=json.dumps(body).encode(),
        headers={"tokenid": token, "Content-Type": "application/json"}, method="PUT")
    with urllib.request.urlopen(req) as resp:
        return resp.status


def main():
    secret = os.environ.get("EMBED_LINK_SECRET")
    if not secret:
        sys.exit("ERROR: EMBED_LINK_SECRET not set")
    token = get_token()
    if not token:
        sys.exit("ERROR: FIREBERRY_API_TOKEN not found (env or Keychain)")

    if len(sys.argv) >= 4 and sys.argv[1] == "--one":
        url = build_url(sys.argv[2], sys.argv[3], secret)
        print(url or "INVALID phone/product")
        return

    apply = "--apply" in sys.argv
    page, done, skipped = 1, 0, 0
    while True:
        rows = query_leads(token, page)
        if not rows:
            break
        for r in rows:
            phone = r.get("telephone1")
            product = PRODUCT_MAP.get((r.get("pcfsystemfield122") or "").strip())
            url = build_url(phone or "", product or "", secret) if product else None
            if not url:
                skipped += 1
                continue
            if apply:
                update_lead(token, r["accountid"], iframe(url))
            done += 1
            print(f"{'WROTE' if apply else 'DRY'} {r['accountid']} {phone} {product}")
        page += 1
    print(f"\n{'Applied' if apply else 'Dry-run'}: {done} leads, skipped {skipped}.")


if __name__ == "__main__":
    main()
```

- [ ] **Step 2b: Add a test for the pure signing logic**

Create `scripts/admin/backfill_conversation_view_test.py` is NOT run by Vitest. Instead, verify parity manually: the Python `sign()` must produce the SAME hex as the TS `signEmbedToken()` for a known input. Run:

```bash
EMBED_LINK_SECRET=test-secret-123 python3 scripts/admin/backfill-conversation-view.py --one 0525188599 B
```
Compare the `sig=` value to the TS test output for `("0525188599","B","test-secret-123")` (add a temporary `console.log` in an embedLink test if needed). They MUST match — same canonical phone, same `phone|product` payload, same HMAC-SHA256. If they differ, the backfill links will 403.

- [ ] **Step 3: Dry-run, then apply**

```bash
EMBED_LINK_SECRET='<value>' python3 scripts/admin/backfill-conversation-view.py           # dry-run
EMBED_LINK_SECRET='<value>' python3 scripts/admin/backfill-conversation-view.py --apply    # write
```

- [ ] **Step 4: Commit**

```bash
git add scripts/admin/backfill-conversation-view.py
git commit -m "chore(embed): one-time backfill of conversation-view links"
```

---

## Task 9: PR

- [ ] Open a PR from `feat/conversation-view-embed` to `main` with a summary + test plan. Ensure CI (typecheck + lint + build) is green. Note in the PR that Vitest tests are local-only (CI does not run them) and were run manually: `bun run test`.

---

## Out of scope (v1)
- Realtime / polling — fresh-on-load only.
- Consolidating the duplicated `hmacSha256Hex` across `whatsappWebhookHandler.ts` / `fireHandoffWebhook.ts` / `embedLink.ts` (leave as-is; a separate refactor).
- Embed layout width (Fireberry form-designer setting).
