# WhatsApp Broadcast Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Let an admin send a WhatsApp template broadcast — immediate or scheduled — to existing leads and/or an uploaded CSV, chosen by product (=agent), while unconditionally suppressing anyone who opted out.

**Architecture:** Additive-only on top of the live `scheduled_messages` + `dispatch-scheduled-templates` pipeline. New tables (`broadcasts`, `broadcast_templates`) and a nullable `scheduled_messages.broadcast_id` column. A new admin edge function `broadcast-enqueue` builds the recipient set (normalize → dedupe → suppress) and inserts rows into the existing queue; the existing dispatcher sends them unchanged except for one additive opt-out re-check. A new admin UI page composes and lists broadcasts.

**Tech Stack:** Supabase Postgres + migrations, Deno edge functions, `@supabase/supabase-js`, React 18 + TypeScript (strict) + react-query + shadcn/ui, vitest.

**PROD-SAFETY MANDATE:** Nothing here may change the behavior of anything running today. Guarantees:
- All schema changes are additive (new tables, one nullable column). No existing column semantics change.
- The `claim_scheduled_messages` RPC (dispatcher hot path) is **NOT** modified — the opt-out re-check lives in the dispatcher's TypeScript, so non-opted-out rows follow the identical code path they do today.
- `lead-register` / `re-engage-cold-leads` insert `broadcast_id = NULL` implicitly (they don't set it) — zero behavior change.
- Per-agent channel routing already keys off `agent_id`, so broadcast rows route to the correct WhatsApp channel with no dispatcher change.

---

## File Structure

**Migrations (additive):**
- `supabase/migrations/0042_broadcasts.sql` — `broadcast_status_enum` + `broadcasts` table + RLS + updated_at trigger.
- `supabase/migrations/0043_broadcast_templates.sql` — `broadcast_templates` registry + RLS + seed from `agents.first_touch_template_name`.
- `supabase/migrations/0044_scheduled_messages_broadcast_id.sql` — nullable FK column + partial index.

**Edge / shared:**
- `supabase/functions/_shared/broadcastRecipients.ts` — pure recipient builder (normalize + dedupe + suppress). **New, unit-tested.**
- `supabase/functions/_shared/broadcastRecipients.test.ts` — tests.
- `supabase/functions/_shared/optOutFilter.ts` — pure `partitionOptedOut` helper. **New, unit-tested.**
- `supabase/functions/_shared/optOutFilter.test.ts` — tests.
- `supabase/functions/broadcast-enqueue/index.ts` — the admin enqueue endpoint. **New.**
- `supabase/functions/dispatch-scheduled-templates/index.ts` — **modify:** add opt-out re-check before the send loop.

**Frontend:**
- `src/lib/parseBroadcastCsv.ts` — pure CSV parser. **New, unit-tested.**
- `src/lib/parseBroadcastCsv.test.ts` — tests.
- `src/lib/broadcasts.ts` — queries (templates, list, enqueue, cancel). **New.**
- `src/pages/Broadcasts.tsx` — page shell. **New.**
- `src/components/broadcasts/BroadcastComposer.tsx` — compose form. **New.**
- `src/components/broadcasts/BroadcastList.tsx` — history list. **New.**
- `src/App.tsx` — **modify:** add `/broadcasts` route.
- `src/components/layout/AppSidebar.tsx` — **modify:** add admin-only nav item.

---

## PHASE 1 — Data model (additive migrations)

### Task 1: `broadcasts` table + status enum

**Files:**
- Create: `supabase/migrations/0042_broadcasts.sql`

- [ ] **Step 1: Write the migration**

```sql
-- 0042_broadcasts.sql
-- New: broadcasts table (one row per bulk WhatsApp template send) + status enum.
-- Purely additive. Does not touch scheduled_messages or the dispatcher hot path.

CREATE TYPE public.broadcast_status_enum AS ENUM (
  'draft', 'queued', 'sending', 'completed', 'cancelled'
);

CREATE TABLE public.broadcasts (
  id                    uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  agent_id              uuid NOT NULL REFERENCES public.agents(id) ON DELETE CASCADE,
  template_name         text NOT NULL,
  template_language     text NOT NULL DEFAULT 'he',
  template_variables    jsonb NOT NULL DEFAULT '[]'::jsonb,
  title                 text NOT NULL,
  status                public.broadcast_status_enum NOT NULL DEFAULT 'queued',
  scheduled_for         timestamptz,
  total_recipients      int NOT NULL DEFAULT 0,
  suppressed_count      int NOT NULL DEFAULT 0,
  suppressed_breakdown  jsonb NOT NULL DEFAULT '{}'::jsonb,
  created_by            uuid REFERENCES public.app_users(id) ON DELETE SET NULL,
  created_at            timestamptz NOT NULL DEFAULT now(),
  updated_at            timestamptz NOT NULL DEFAULT now()
);

CREATE INDEX broadcasts_agent_created_idx ON public.broadcasts (agent_id, created_at DESC);

CREATE OR REPLACE FUNCTION public.broadcasts_set_updated_at()
RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  NEW.updated_at := now();
  RETURN NEW;
END;
$$;

CREATE TRIGGER broadcasts_set_updated_at
  BEFORE UPDATE ON public.broadcasts
  FOR EACH ROW EXECUTE FUNCTION public.broadcasts_set_updated_at();

ALTER TABLE public.broadcasts ENABLE ROW LEVEL SECURITY;

-- Admin-only, consistent with migration 0018. The edge function uses the
-- service_role key and bypasses RLS.
CREATE POLICY "admin_all_broadcasts" ON public.broadcasts
  FOR ALL TO authenticated
  USING (public.is_admin())
  WITH CHECK (public.is_admin());
```

- [ ] **Step 2: Commit**

```bash
git add supabase/migrations/0042_broadcasts.sql
git commit -m "feat(broadcast): add broadcasts table + status enum (migration 0042)"
```

---

### Task 2: `broadcast_templates` registry + seed

**Files:**
- Create: `supabase/migrations/0043_broadcast_templates.sql`

- [ ] **Step 1: Write the migration**

```sql
-- 0043_broadcast_templates.sql
-- New: registry of Meta-approved templates selectable in the broadcast UI.
-- A typo in template_name makes Meta reject the WHOLE broadcast silently, so
-- the UI picks from this table instead of free text. Seeds each agent's
-- existing first-touch template as an initial option.

CREATE TABLE public.broadcast_templates (
  id              uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  agent_id        uuid NOT NULL REFERENCES public.agents(id) ON DELETE CASCADE,
  name            text NOT NULL,
  language        text NOT NULL DEFAULT 'he',
  label           text NOT NULL,
  variable_count  int NOT NULL DEFAULT 0,
  body_preview    text,
  is_active       boolean NOT NULL DEFAULT true,
  created_at      timestamptz NOT NULL DEFAULT now(),
  UNIQUE (agent_id, name, language)
);

CREATE INDEX broadcast_templates_agent_idx ON public.broadcast_templates (agent_id, is_active);

ALTER TABLE public.broadcast_templates ENABLE ROW LEVEL SECURITY;

CREATE POLICY "admin_all_broadcast_templates" ON public.broadcast_templates
  FOR ALL TO authenticated
  USING (public.is_admin())
  WITH CHECK (public.is_admin());

-- Seed: register each agent's configured first-touch template as a broadcast
-- option so the dropdown is non-empty on day one.
INSERT INTO public.broadcast_templates (agent_id, name, language, label, variable_count)
SELECT id,
       first_touch_template_name,
       COALESCE(first_touch_template_language, 'he'),
       'הודעת פתיחה (first-touch)',
       0
FROM public.agents
WHERE first_touch_template_name IS NOT NULL
ON CONFLICT (agent_id, name, language) DO NOTHING;
```

- [ ] **Step 2: Commit**

```bash
git add supabase/migrations/0043_broadcast_templates.sql
git commit -m "feat(broadcast): add broadcast_templates registry + seed (migration 0043)"
```

---

### Task 3: `scheduled_messages.broadcast_id` column

**Files:**
- Create: `supabase/migrations/0044_scheduled_messages_broadcast_id.sql`

- [ ] **Step 1: Write the migration**

```sql
-- 0044_scheduled_messages_broadcast_id.sql
-- Additive: link scheduled_messages rows to their broadcast (nullable).
-- Existing inserts (lead-register, re-engage) leave it NULL => no behavior
-- change. The claim RPC and dispatcher do not read this column.

ALTER TABLE public.scheduled_messages
  ADD COLUMN broadcast_id uuid REFERENCES public.broadcasts(id) ON DELETE SET NULL;

CREATE INDEX scheduled_messages_broadcast_idx
  ON public.scheduled_messages (broadcast_id)
  WHERE broadcast_id IS NOT NULL;
```

- [ ] **Step 2: Commit**

```bash
git add supabase/migrations/0044_scheduled_messages_broadcast_id.sql
git commit -m "feat(broadcast): add scheduled_messages.broadcast_id (migration 0044)"
```

---

### Task 4: Apply migrations + regenerate types

**Files:**
- Modify: `src/types/database.ts` (auto-generated output)

- [ ] **Step 1: Apply the three additive migrations to the linked project**

Run: `bunx supabase db push --project-ref juoglkqtmjsziieqgmhf`
Expected: `0042`, `0043`, `0044` reported as applied, no errors. (These are additive; safe on prod.)

- [ ] **Step 2: Regenerate TypeScript types**

Run: `bunx supabase gen types typescript --project-id juoglkqtmjsziieqgmhf > src/types/database.ts`
Expected: `src/types/database.ts` now contains `broadcasts`, `broadcast_templates`, `broadcast_status_enum`, and `scheduled_messages.broadcast_id`.

- [ ] **Step 3: Typecheck**

Run: `~/.bun/bin/bun run build`
Expected: build succeeds (types compile).

- [ ] **Step 4: Commit**

```bash
git add src/types/database.ts
git commit -m "chore(broadcast): regenerate DB types after migrations 0042-0044"
```

---

## PHASE 2 — Pure recipient builder (unit-tested core)

### Task 5: `buildRecipientSet` — normalize + dedupe + suppress

**Files:**
- Create: `supabase/functions/_shared/broadcastRecipients.ts`
- Test: `supabase/functions/_shared/broadcastRecipients.test.ts`

- [ ] **Step 1: Write the failing test**

```ts
import { describe, expect, it } from "vitest";

import { buildRecipientSet } from "./broadcastRecipients.ts";

describe("buildRecipientSet", () => {
  const base = { optedOutPhones: new Set<string>(), blockedPhones: new Set<string>() };

  it("keeps a valid recipient and canonicalizes its phone", () => {
    const r = buildRecipientSet({ ...base, recipients: [{ phone: "0528524113", name: "דנה" }] });
    expect(r.toSend).toEqual([
      { phone: "972528524113", name: "דנה", variables: null, conversationId: null },
    ]);
    expect(r.suppressedCount).toBe(0);
  });

  it("suppresses an opted-out phone", () => {
    const r = buildRecipientSet({
      ...base,
      optedOutPhones: new Set(["972528524113"]),
      recipients: [{ phone: "+972528524113" }],
    });
    expect(r.toSend).toHaveLength(0);
    expect(r.breakdown.opt_out).toBe(1);
    expect(r.suppressedCount).toBe(1);
  });

  it("suppresses a phone whose conversation carries a blocking tag", () => {
    const r = buildRecipientSet({
      ...base,
      blockedPhones: new Set(["972528524113"]),
      recipients: [{ phone: "972528524113" }],
    });
    expect(r.toSend).toHaveLength(0);
    expect(r.breakdown.blocking_tag).toBe(1);
  });

  it("suppresses a duplicate phone (keeps the first only)", () => {
    const r = buildRecipientSet({
      ...base,
      recipients: [{ phone: "0528524113" }, { phone: "+972528524113" }],
    });
    expect(r.toSend).toHaveLength(1);
    expect(r.breakdown.duplicate).toBe(1);
  });

  it("suppresses an invalid phone", () => {
    const r = buildRecipientSet({ ...base, recipients: [{ phone: "hello" }] });
    expect(r.toSend).toHaveLength(0);
    expect(r.breakdown.invalid_phone).toBe(1);
  });

  it("passes per-recipient variables through when non-empty", () => {
    const r = buildRecipientSet({ ...base, recipients: [{ phone: "0528524113", variables: ["X"] }] });
    expect(r.toSend[0].variables).toEqual(["X"]);
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `~/.bun/bin/bun run test -- broadcastRecipients`
Expected: FAIL — cannot find module `./broadcastRecipients.ts`.

- [ ] **Step 3: Write the implementation**

```ts
import { toCanonicalPhone } from "./normalizePhone.ts";

export interface RawRecipient {
  phone: string;
  name?: string | null;
  variables?: string[] | null;
  /** conversation id if this recipient came from an existing lead */
  conversationId?: string | null;
}

export type SuppressionReason = "opt_out" | "blocking_tag" | "duplicate" | "invalid_phone";

export interface ResolvedRecipient {
  phone: string; // canonical (972…)
  name: string | null;
  variables: string[] | null;
  conversationId: string | null;
}

export interface RecipientSet {
  toSend: ResolvedRecipient[];
  suppressedCount: number;
  breakdown: Record<SuppressionReason, number>;
}

export interface BuildRecipientArgs {
  recipients: RawRecipient[];
  /** canonical phones present in opt_outs */
  optedOutPhones: Set<string>;
  /** canonical phones whose existing conversation carries a blocking tag/status */
  blockedPhones: Set<string>;
}

/**
 * Pure: turns raw recipients into the final send list. Order of suppression per
 * phone: invalid → duplicate → opt-out → blocking-tag. opt-out is the critical
 * gate — a phone in `optedOutPhones` is NEVER included, even from CSV.
 */
export function buildRecipientSet(args: BuildRecipientArgs): RecipientSet {
  const breakdown: Record<SuppressionReason, number> = {
    opt_out: 0,
    blocking_tag: 0,
    duplicate: 0,
    invalid_phone: 0,
  };
  const seen = new Set<string>();
  const toSend: ResolvedRecipient[] = [];

  for (const r of args.recipients) {
    const canonical = toCanonicalPhone(r.phone ?? "");
    if (!canonical) {
      breakdown.invalid_phone++;
      continue;
    }
    if (seen.has(canonical)) {
      breakdown.duplicate++;
      continue;
    }
    seen.add(canonical);
    if (args.optedOutPhones.has(canonical)) {
      breakdown.opt_out++;
      continue;
    }
    if (args.blockedPhones.has(canonical)) {
      breakdown.blocking_tag++;
      continue;
    }
    toSend.push({
      phone: canonical,
      name: (r.name ?? null) || null,
      variables: r.variables && r.variables.length > 0 ? r.variables : null,
      conversationId: r.conversationId ?? null,
    });
  }

  const suppressedCount =
    breakdown.opt_out + breakdown.blocking_tag + breakdown.duplicate + breakdown.invalid_phone;
  return { toSend, suppressedCount, breakdown };
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `~/.bun/bin/bun run test -- broadcastRecipients`
Expected: PASS (6 tests).

- [ ] **Step 5: Commit**

```bash
git add supabase/functions/_shared/broadcastRecipients.ts supabase/functions/_shared/broadcastRecipients.test.ts
git commit -m "feat(broadcast): pure recipient builder with suppression"
```

---

## PHASE 3 — Enqueue endpoint

### Task 6: `broadcast-enqueue` edge function

**Files:**
- Create: `supabase/functions/broadcast-enqueue/index.ts`

Depends on Task 5. This function is a thin orchestrator around the tested `buildRecipientSet`; correctness of the suppression logic is covered by Task 5's unit tests. Verification here is a deployed smoke test (Step 3).

- [ ] **Step 1: Write the function**

```ts
import { createClient } from "https://esm.sh/@supabase/supabase-js@2.45.4";
import { corsHeaders } from "../_shared/cors.ts";
import { HttpError, jsonResponse, requireAdmin } from "../_shared/auth.ts";
import { toCanonicalPhone } from "../_shared/normalizePhone.ts";
import { buildRecipientSet, type RawRecipient } from "../_shared/broadcastRecipients.ts";

const BLOCKING_TAGS = new Set(["zoom_scheduled", "opted_out", "requires_human", "underage"]);
const INSERT_CHUNK = 500;

interface EnqueueBody {
  agent_id?: string;
  template_name?: string;
  template_language?: string;
  template_variables?: string[];
  title?: string;
  scheduled_for?: string | null;
  /** When true, include ALL active leads of this agent (=product) as recipients. */
  include_existing?: boolean;
  existing_lead_conversation_ids?: string[];
  csv_recipients?: Array<{ phone?: string; name?: string; variables?: string[] }>;
}

function chunk<T>(arr: T[], size: number): T[][] {
  const out: T[][] = [];
  for (let i = 0; i < arr.length; i += size) out.push(arr.slice(i, i + size));
  return out;
}

Deno.serve(async (req) => {
  if (req.method === "OPTIONS") return new Response("ok", { headers: corsHeaders });
  try {
    if (req.method !== "POST") throw new HttpError(405, "POST only");
    const { callerId, admin } = await requireAdmin(req);

    let body: EnqueueBody;
    try {
      body = await req.json();
    } catch {
      throw new HttpError(400, "invalid JSON");
    }

    const agentId = body.agent_id;
    const templateName = (body.template_name ?? "").trim();
    const templateLanguage = (body.template_language ?? "he").trim();
    const title = (body.title ?? "").trim();
    if (!agentId || !templateName || !title) {
      throw new HttpError(400, "agent_id, template_name and title are required");
    }
    const defaultVariables = Array.isArray(body.template_variables)
      ? body.template_variables.filter((v) => typeof v === "string")
      : [];

    // Agent must exist and not be paused.
    const { data: agent } = await admin
      .from("agents")
      .select("id, is_paused")
      .eq("id", agentId)
      .maybeSingle();
    if (!agent) throw new HttpError(404, "agent not found");
    if (agent.is_paused) throw new HttpError(409, "agent is paused (kill switch on)");

    // Template must be a registered, active broadcast template for this agent.
    const { data: tpl } = await admin
      .from("broadcast_templates")
      .select("id")
      .eq("agent_id", agentId)
      .eq("name", templateName)
      .eq("language", templateLanguage)
      .eq("is_active", true)
      .maybeSingle();
    if (!tpl) throw new HttpError(400, "template is not a registered active broadcast template for this agent");

    // Idempotency: return an existing broadcast created in the last 60s with the
    // same (agent, title, creator) instead of duplicating on double-submit.
    const cutoff = new Date(Date.now() - 60_000).toISOString();
    const { data: dup } = await admin
      .from("broadcasts")
      .select("id, total_recipients, suppressed_count, suppressed_breakdown")
      .eq("agent_id", agentId)
      .eq("title", title)
      .eq("created_by", callerId)
      .gte("created_at", cutoff)
      .order("created_at", { ascending: false })
      .limit(1)
      .maybeSingle();
    if (dup) {
      return jsonResponse(
        { broadcast_id: dup.id, total_recipients: dup.total_recipients, suppressed_count: dup.suppressed_count, suppressed_breakdown: dup.suppressed_breakdown, idempotent: true },
        { headers: corsHeaders },
      );
    }

    // 1. Gather recipients from both sources.
    const raw: RawRecipient[] = [];
    const convIds = (body.existing_lead_conversation_ids ?? []).filter((s) => typeof s === "string");
    if (convIds.length > 0) {
      const { data: convs } = await admin
        .from("conversations")
        .select("id, lead_phone, lead_name")
        .eq("agent_id", agentId)
        .in("id", convIds);
      for (const c of convs ?? []) {
        raw.push({ phone: c.lead_phone as string, name: (c as { lead_name?: string }).lead_name ?? null, conversationId: c.id as string });
      }
    }
    if (body.include_existing === true) {
      // Requirement #1: send to everyone already registered under this product
      // (=agent). Suppression (opt-out / blocking tags) is applied uniformly
      // in step 5, so this pulls all ACTIVE conversations and lets the builder
      // filter. Dedupe against explicit IDs / CSV is by canonical phone.
      const { data: convs } = await admin
        .from("conversations")
        .select("id, lead_phone, lead_name")
        .eq("agent_id", agentId)
        .eq("status", "active");
      for (const c of convs ?? []) {
        raw.push({ phone: c.lead_phone as string, name: (c as { lead_name?: string }).lead_name ?? null, conversationId: c.id as string });
      }
    }
    for (const r of body.csv_recipients ?? []) {
      if (r && typeof r.phone === "string") {
        raw.push({ phone: r.phone, name: r.name ?? null, variables: Array.isArray(r.variables) ? r.variables : null });
      }
    }
    if (raw.length === 0) throw new HttpError(400, "no recipients supplied");

    // 2. Canonical candidate phones for the suppression lookups.
    const candidatePhones = [
      ...new Set(raw.map((r) => toCanonicalPhone(r.phone)).filter((p): p is string => !!p)),
    ];

    // 3. opt_outs (phone-level, global) — the critical CSV cross-check.
    const optedOutPhones = new Set<string>();
    for (const group of chunk(candidatePhones, INSERT_CHUNK)) {
      const { data: oo } = await admin.from("opt_outs").select("lead_phone").in("lead_phone", group);
      for (const o of oo ?? []) {
        const c = toCanonicalPhone((o as { lead_phone: string }).lead_phone);
        if (c) optedOutPhones.add(c);
      }
    }

    // 4. Existing conversations of THIS agent for the candidate phones — used to
    //    resolve conversation_id and to find blocking tags/statuses.
    const convByPhone = new Map<string, string>();
    const blockedPhones = new Set<string>();
    for (const group of chunk(candidatePhones, INSERT_CHUNK)) {
      const { data: convs } = await admin
        .from("conversations")
        .select("id, lead_phone, status, current_tag")
        .eq("agent_id", agentId)
        .in("lead_phone", group);
      for (const c of convs ?? []) {
        const canon = toCanonicalPhone(c.lead_phone as string);
        if (!canon) continue;
        convByPhone.set(canon, c.id as string);
        const status = (c as { status?: string | null }).status ?? null;
        const tag = (c as { current_tag?: string | null }).current_tag ?? null;
        if ((status !== null && status !== "active") || (tag !== null && BLOCKING_TAGS.has(tag))) {
          blockedPhones.add(canon);
        }
      }
    }

    // 5. Build the final send list.
    const set = buildRecipientSet({ recipients: raw, optedOutPhones, blockedPhones });

    // 6. Create the broadcast row.
    const scheduledFor = body.scheduled_for ?? null;
    const { data: broadcast, error: bErr } = await admin
      .from("broadcasts")
      .insert({
        agent_id: agentId,
        template_name: templateName,
        template_language: templateLanguage,
        template_variables: defaultVariables,
        title,
        status: "queued",
        scheduled_for: scheduledFor,
        total_recipients: set.toSend.length,
        suppressed_count: set.suppressedCount,
        suppressed_breakdown: set.breakdown,
        created_by: callerId,
      })
      .select("id")
      .single();
    if (bErr || !broadcast) throw new HttpError(500, `failed to create broadcast: ${bErr?.message}`);

    // 7. Upsert conversations for net-new CSV phones (so replies route correctly
    //    and there is a conversation_id for tracking). Does not overwrite an
    //    existing conversation's status.
    const netNew = set.toSend.filter((r) => !convByPhone.has(r.phone));
    for (const group of chunk(netNew, INSERT_CHUNK)) {
      const payload = group.map((r) => ({ agent_id: agentId, lead_phone: r.phone, lead_name: r.name, status: "active" }));
      const { data: upserted } = await admin
        .from("conversations")
        .upsert(payload, { onConflict: "agent_id,lead_phone", ignoreDuplicates: false })
        .select("id, lead_phone");
      for (const c of upserted ?? []) {
        const canon = toCanonicalPhone(c.lead_phone as string);
        if (canon) convByPhone.set(canon, c.id as string);
      }
    }

    // 8. Insert scheduled_messages rows.
    const nowIso = new Date().toISOString();
    const rows = set.toSend.map((r) => ({
      agent_id: agentId,
      conversation_id: convByPhone.get(r.phone) ?? null,
      lead_phone: r.phone,
      lead_name: r.name,
      template_name: templateName,
      template_language: templateLanguage,
      template_variables: r.variables ?? defaultVariables,
      scheduled_for: scheduledFor ?? nowIso,
      status: "pending",
      broadcast_id: broadcast.id,
    }));
    for (const group of chunk(rows, INSERT_CHUNK)) {
      const { error: insErr } = await admin.from("scheduled_messages").insert(group);
      if (insErr) throw new HttpError(500, `failed to enqueue rows: ${insErr.message}`);
    }

    return jsonResponse(
      {
        broadcast_id: broadcast.id,
        total_recipients: set.toSend.length,
        suppressed_count: set.suppressedCount,
        suppressed_breakdown: set.breakdown,
      },
      { headers: corsHeaders },
    );
  } catch (err) {
    if (err instanceof HttpError) {
      return jsonResponse({ error: err.message }, { status: err.status, headers: corsHeaders });
    }
    return jsonResponse({ error: "internal error" }, { status: 500, headers: corsHeaders });
  }
});
```

- [ ] **Step 2: Deploy the function (requires JWT — admin only)**

Run: `bunx supabase functions deploy broadcast-enqueue --project-ref juoglkqtmjsziieqgmhf`
Expected: deploy succeeds. (JWT verification stays ON — this is admin-only.)

- [ ] **Step 3: Smoke test with a single test phone**

Get an admin JWT from the dashboard session (browser devtools → local storage → supabase auth token), then:

```bash
curl -sS -X POST "https://juoglkqtmjsziieqgmhf.supabase.co/functions/v1/broadcast-enqueue" \
  -H "Authorization: Bearer <ADMIN_JWT>" \
  -H "Content-Type: application/json" \
  -d '{"agent_id":"<AGENT_UUID>","template_name":"<SEEDED_TEMPLATE>","template_language":"he","title":"smoke test","scheduled_for":null,"csv_recipients":[{"phone":"<YOUR_OWN_PHONE>","name":"בדיקה"}]}'
```

Expected: JSON `{ broadcast_id, total_recipients: 1, suppressed_count: 0, ... }`, and within ~1 minute the dispatcher sends the template to your phone. Then insert your phone into `opt_outs` and repeat — expect `total_recipients: 0, suppressed_breakdown.opt_out: 1` and NO message.

- [ ] **Step 4: Commit**

```bash
git add supabase/functions/broadcast-enqueue/index.ts
git commit -m "feat(broadcast): admin broadcast-enqueue edge function"
```

---

## PHASE 4 — Dispatcher opt-out re-check (prod-safety guard)

### Task 7: `partitionOptedOut` helper + dispatcher integration

**Files:**
- Create: `supabase/functions/_shared/optOutFilter.ts`
- Test: `supabase/functions/_shared/optOutFilter.test.ts`
- Modify: `supabase/functions/dispatch-scheduled-templates/index.ts`

- [ ] **Step 1: Write the failing test**

```ts
import { describe, expect, it } from "vitest";

import { partitionOptedOut } from "./optOutFilter.ts";
import { toCanonicalPhone } from "./normalizePhone.ts";

describe("partitionOptedOut", () => {
  it("cancels rows whose phone is in the opted-out set, keeps the rest", () => {
    const rows = [
      { id: "a", lead_phone: "0528524113" },   // opted out (canonical 972528524113)
      { id: "b", lead_phone: "+972500000000" }, // not opted out
    ];
    const set = new Set(["972528524113"]);
    const { keep, cancel } = partitionOptedOut(rows, set, toCanonicalPhone);
    expect(cancel.map((r) => r.id)).toEqual(["a"]);
    expect(keep.map((r) => r.id)).toEqual(["b"]);
  });

  it("keeps a row with an unparseable phone (nothing to match against)", () => {
    const rows = [{ id: "a", lead_phone: "garbage" }];
    const { keep, cancel } = partitionOptedOut(rows, new Set(["972528524113"]), toCanonicalPhone);
    expect(cancel).toHaveLength(0);
    expect(keep).toHaveLength(1);
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `~/.bun/bin/bun run test -- optOutFilter`
Expected: FAIL — cannot find module `./optOutFilter.ts`.

- [ ] **Step 3: Write the helper**

```ts
/**
 * Pure: splits claimed dispatcher rows into those safe to send and those whose
 * lead has opted out (canonical phone present in `optedOutCanonical`). Rows with
 * an unparseable phone are kept (no match possible) — the send path handles them
 * as it does today.
 */
export function partitionOptedOut<T extends { lead_phone: string }>(
  rows: T[],
  optedOutCanonical: Set<string>,
  toCanonical: (p: string) => string | null,
): { keep: T[]; cancel: T[] } {
  const keep: T[] = [];
  const cancel: T[] = [];
  for (const r of rows) {
    const c = toCanonical(r.lead_phone);
    if (c && optedOutCanonical.has(c)) cancel.push(r);
    else keep.push(r);
  }
  return { keep, cancel };
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `~/.bun/bin/bun run test -- optOutFilter`
Expected: PASS (2 tests).

- [ ] **Step 5: Wire it into the dispatcher — add imports**

In `supabase/functions/dispatch-scheduled-templates/index.ts`, after the existing imports (lines 1-3), add:

```ts
import { toCanonicalPhone } from "../_shared/normalizePhone.ts";
import { partitionOptedOut } from "../_shared/optOutFilter.ts";
```

- [ ] **Step 6: Wire it into the dispatcher — add the re-check**

In the same file, immediately AFTER the line `const rows = (candidates ?? []) as unknown as Row[];` (currently line 141) and BEFORE the line `const results = { picked: rows.length, ... };`, insert:

```ts
  // Phone-level opt-out re-check (belt-and-suspenders). A lead can opt out
  // AFTER a row was enqueued (e.g. a broadcast queued minutes ago). The
  // conversation-tag/status check inside the loop only catches opt-outs already
  // reflected as a conversation tag; this reads the opt_outs table directly and
  // cancels — never sends. Non-opted-out rows are untouched (identical path).
  const optedOutSet = new Set<string>();
  const batchPhones = [
    ...new Set(rows.map((r) => toCanonicalPhone(r.lead_phone)).filter((p): p is string => !!p)),
  ];
  if (batchPhones.length > 0) {
    const { data: oo } = await admin.from("opt_outs").select("lead_phone").in("lead_phone", batchPhones);
    for (const o of oo ?? []) {
      const c = toCanonicalPhone((o as { lead_phone: string }).lead_phone);
      if (c) optedOutSet.add(c);
    }
  }
  const { keep: sendableRows, cancel: optedOutRows } = partitionOptedOut(rows, optedOutSet, toCanonicalPhone);
```

- [ ] **Step 7: Wire it into the dispatcher — cancel opted-out rows and iterate the filtered list**

In the same file, change the loop header from:

```ts
  for (const row of rows) {
```

to:

```ts
  for (const row of optedOutRows) {
    await admin.from("scheduled_messages").update({ status: "cancelled", claimed_at: null, last_error: "opted_out_before_send" }).eq("id", row.id);
    results.cancelled++;
  }
  for (const row of sendableRows) {
```

Leave the rest of the loop body unchanged.

- [ ] **Step 8: Typecheck the edge function locally**

Run: `~/.bun/bin/bun run build`
Expected: build succeeds (the app build does not compile Deno files, but this confirms no accidental breakage; the Deno files are validated at deploy).

- [ ] **Step 9: Deploy the dispatcher**

Run: `bunx supabase functions deploy dispatch-scheduled-templates --no-verify-jwt --project-ref juoglkqtmjsziieqgmhf`
Expected: deploy succeeds. Confirm the next cron tick still drains normally via the function logs (no new errors).

- [ ] **Step 10: Commit**

```bash
git add supabase/functions/_shared/optOutFilter.ts supabase/functions/_shared/optOutFilter.test.ts supabase/functions/dispatch-scheduled-templates/index.ts
git commit -m "feat(broadcast): dispatcher opt-out re-check before send"
```

---

## PHASE 5 — Frontend

### Task 8: CSV parser + broadcast queries

**Files:**
- Create: `src/lib/parseBroadcastCsv.ts`
- Test: `src/lib/parseBroadcastCsv.test.ts`
- Create: `src/lib/broadcasts.ts`

- [ ] **Step 1: Write the failing CSV-parser test**

```ts
import { describe, expect, it } from "vitest";

import { parseBroadcastCsv } from "./parseBroadcastCsv";

describe("parseBroadcastCsv", () => {
  it("parses phone and name columns (header row detected)", () => {
    const { rows, errors } = parseBroadcastCsv("phone,name\n0528524113,דנה\n0501234567,יוסי");
    expect(errors).toHaveLength(0);
    expect(rows).toEqual([
      { phone: "0528524113", name: "דנה", variables: [] },
      { phone: "0501234567", name: "יוסי", variables: [] },
    ]);
  });

  it("parses without a header (first cell looks like a phone)", () => {
    const { rows } = parseBroadcastCsv("0528524113,דנה");
    expect(rows).toEqual([{ phone: "0528524113", name: "דנה", variables: [] }]);
  });

  it("collects extra columns as variables", () => {
    const { rows } = parseBroadcastCsv("phone,name,var1,var2\n0528524113,דנה,A,B");
    expect(rows[0].variables).toEqual(["A", "B"]);
  });

  it("reports a row with a missing phone as an error and skips it", () => {
    const { rows, errors } = parseBroadcastCsv("phone,name\n,דנה\n0501234567,יוסי");
    expect(rows).toHaveLength(1);
    expect(errors[0]).toMatch(/שורה 2/);
  });

  it("ignores blank lines", () => {
    const { rows } = parseBroadcastCsv("0528524113,דנה\n\n\n");
    expect(rows).toHaveLength(1);
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `~/.bun/bin/bun run test -- parseBroadcastCsv`
Expected: FAIL — cannot find module `./parseBroadcastCsv`.

- [ ] **Step 3: Write the CSV parser**

```ts
export interface ParsedCsvRecipient {
  phone: string;
  name: string;
  variables: string[];
}

export interface ParseCsvResult {
  rows: ParsedCsvRecipient[];
  errors: string[];
}

const HEADER_TOKENS = new Set(["phone", "טלפון", "tel", "mobile", "נייד"]);

function splitLine(line: string): string[] {
  return line.split(",").map((c) => c.trim());
}

/**
 * Pure client-side CSV parse. Columns: phone, name, then any number of variable
 * columns. Header row is auto-detected (first cell is a known header token).
 * A row with an empty first cell is reported as an error and skipped. This does
 * NOT validate phone format — the server canonicalizes and reports invalids.
 */
export function parseBroadcastCsv(text: string): ParseCsvResult {
  const lines = text.split(/\r?\n/).map((l) => l.trim()).filter((l) => l.length > 0);
  const rows: ParsedCsvRecipient[] = [];
  const errors: string[] = [];
  if (lines.length === 0) return { rows, errors };

  let start = 0;
  const firstCells = splitLine(lines[0]);
  if (firstCells.length > 0 && HEADER_TOKENS.has(firstCells[0].toLowerCase())) {
    start = 1;
  }

  for (let i = start; i < lines.length; i++) {
    const cells = splitLine(lines[i]);
    const phone = cells[0] ?? "";
    if (!phone) {
      errors.push(`שורה ${i + 1}: חסר מספר טלפון`);
      continue;
    }
    rows.push({ phone, name: cells[1] ?? "", variables: cells.slice(2) });
  }
  return { rows, errors };
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `~/.bun/bin/bun run test -- parseBroadcastCsv`
Expected: PASS (5 tests).

- [ ] **Step 5: Write the broadcast queries**

```ts
// src/lib/broadcasts.ts
import { supabase } from "./supabase/client";

export interface BroadcastTemplate {
  id: string;
  name: string;
  language: string;
  label: string;
  variable_count: number;
  body_preview: string | null;
}

export interface BroadcastRow {
  id: string;
  title: string;
  template_name: string;
  status: string;
  scheduled_for: string | null;
  total_recipients: number;
  suppressed_count: number;
  created_at: string;
}

export interface EnqueuePayload {
  agent_id: string;
  template_name: string;
  template_language: string;
  template_variables?: string[];
  title: string;
  scheduled_for: string | null;
  existing_lead_conversation_ids?: string[];
  csv_recipients?: Array<{ phone: string; name?: string; variables?: string[] }>;
}

export interface EnqueueResult {
  broadcast_id: string;
  total_recipients: number;
  suppressed_count: number;
  suppressed_breakdown: Record<string, number>;
}

export async function listBroadcastTemplates(agentId: string): Promise<BroadcastTemplate[]> {
  const { data, error } = await supabase
    .from("broadcast_templates")
    .select("id, name, language, label, variable_count, body_preview")
    .eq("agent_id", agentId)
    .eq("is_active", true)
    .order("label");
  if (error) throw error;
  return (data ?? []) as BroadcastTemplate[];
}

export async function listBroadcasts(agentId: string): Promise<BroadcastRow[]> {
  const { data, error } = await supabase
    .from("broadcasts")
    .select("id, title, template_name, status, scheduled_for, total_recipients, suppressed_count, created_at")
    .eq("agent_id", agentId)
    .order("created_at", { ascending: false })
    .limit(100);
  if (error) throw error;
  return (data ?? []) as BroadcastRow[];
}

export async function enqueueBroadcast(payload: EnqueuePayload): Promise<EnqueueResult> {
  const { data, error } = await supabase.functions.invoke("broadcast-enqueue", { body: payload });
  if (error) throw error;
  return data as EnqueueResult;
}

export async function cancelBroadcast(broadcastId: string): Promise<void> {
  // Cancel still-pending rows, then mark the broadcast cancelled. Rows already
  // sent are untouched. RLS restricts this to admins.
  const { error: rowsErr } = await supabase
    .from("scheduled_messages")
    .update({ status: "cancelled", claimed_at: null })
    .eq("broadcast_id", broadcastId)
    .eq("status", "pending");
  if (rowsErr) throw rowsErr;
  const { error } = await supabase.from("broadcasts").update({ status: "cancelled" }).eq("id", broadcastId);
  if (error) throw error;
}
```

- [ ] **Step 6: Commit**

```bash
git add src/lib/parseBroadcastCsv.ts src/lib/parseBroadcastCsv.test.ts src/lib/broadcasts.ts
git commit -m "feat(broadcast): CSV parser + broadcast queries"
```

---

### Task 9: Broadcasts page, composer, list, route, sidebar

**Files:**
- Create: `src/pages/Broadcasts.tsx`
- Create: `src/components/broadcasts/BroadcastComposer.tsx`
- Create: `src/components/broadcasts/BroadcastList.tsx`
- Modify: `src/App.tsx`
- Modify: `src/components/layout/AppSidebar.tsx`

- [ ] **Step 1: Write the composer**

```tsx
// src/components/broadcasts/BroadcastComposer.tsx
import { useMemo, useState } from "react";
import { useAgent } from "@/contexts/AgentContext";
import { useQuery } from "@tanstack/react-query";
import { listBroadcastTemplates, enqueueBroadcast, type EnqueueResult } from "@/lib/broadcasts";
import { parseBroadcastCsv, type ParsedCsvRecipient } from "@/lib/parseBroadcastCsv";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";

export function BroadcastComposer({ onDone }: { onDone: () => void }) {
  const { activeAgent } = useAgent();
  const agentId = activeAgent?.id ?? "";
  const [templateName, setTemplateName] = useState("");
  const [title, setTitle] = useState("");
  const [timing, setTiming] = useState<"now" | "scheduled">("now");
  const [scheduledFor, setScheduledFor] = useState("");
  const [includeExisting, setIncludeExisting] = useState(false);
  const [csv, setCsv] = useState<{ rows: ParsedCsvRecipient[]; errors: string[] }>({ rows: [], errors: [] });
  const [result, setResult] = useState<EnqueueResult | null>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const templates = useQuery({
    queryKey: ["broadcast-templates", agentId],
    queryFn: () => listBroadcastTemplates(agentId),
    enabled: !!agentId,
  });

  const selectedTpl = useMemo(
    () => templates.data?.find((t) => t.name === templateName) ?? null,
    [templates.data, templateName],
  );

  function onCsvFile(file: File) {
    const reader = new FileReader();
    reader.onload = () => setCsv(parseBroadcastCsv(String(reader.result ?? "")));
    reader.readAsText(file);
  }

  async function submit() {
    setError(null);
    setBusy(true);
    try {
      const res = await enqueueBroadcast({
        agent_id: agentId,
        template_name: templateName,
        template_language: selectedTpl?.language ?? "he",
        title,
        scheduled_for: timing === "scheduled" && scheduledFor ? new Date(scheduledFor).toISOString() : null,
        include_existing: includeExisting,
        csv_recipients: csv.rows.map((r) => ({ phone: r.phone, name: r.name, variables: r.variables })),
      });
      setResult(res);
      onDone();
    } catch (e) {
      setError(e instanceof Error ? e.message : "שגיאה בשליחת הדיוור");
    } finally {
      setBusy(false);
    }
  }

  const canSubmit = !!agentId && !!templateName && !!title && (csv.rows.length > 0 || includeExisting) && !busy;

  return (
    <div className="space-y-4" dir="rtl">
      <div>
        <label className="mb-1 block text-sm font-medium">שם הדיוור</label>
        <Input value={title} onChange={(e) => setTitle(e.target.value)} placeholder="למשל: דיוור מחזור יולי" />
      </div>

      <div>
        <label className="mb-1 block text-sm font-medium">תבנית (template מאושר)</label>
        <select
          className="w-full rounded-md border p-2"
          value={templateName}
          onChange={(e) => setTemplateName(e.target.value)}
        >
          <option value="">בחר תבנית…</option>
          {(templates.data ?? []).map((t) => (
            <option key={t.id} value={t.name}>{t.label} ({t.name})</option>
          ))}
        </select>
        {selectedTpl?.body_preview && (
          <p className="mt-1 text-xs text-muted-foreground whitespace-pre-wrap">{selectedTpl.body_preview}</p>
        )}
      </div>

      <div className="rounded-md border p-3">
        <label className="flex items-center gap-2 text-sm font-medium">
          <input type="checkbox" checked={includeExisting} onChange={(e) => setIncludeExisting(e.target.checked)} />
          שלח לכל הלידים הרשומים של המוצר (הסוכן הפעיל)
        </label>
        <p className="mt-1 text-xs text-muted-foreground">
          מי שביקש הסרה או שכבר קבע זום יסונן אוטומטית. ניתן לשלב עם קובץ CSV למטה.
        </p>
      </div>

      <div>
        <label className="mb-1 block text-sm font-medium">קובץ נמענים (CSV: טלפון, שם) — אופציונלי</label>
        <input type="file" accept=".csv,text/csv" onChange={(e) => e.target.files?.[0] && onCsvFile(e.target.files[0])} />
        <p className="mt-1 text-sm">{csv.rows.length} נמענים נטענו מהקובץ</p>
        {csv.errors.length > 0 && (
          <ul className="mt-1 text-xs text-destructive">
            {csv.errors.slice(0, 5).map((er, i) => <li key={i}>{er}</li>)}
          </ul>
        )}
      </div>

      <div>
        <label className="mb-1 block text-sm font-medium">תזמון</label>
        <div className="flex items-center gap-4">
          <label className="flex items-center gap-1">
            <input type="radio" checked={timing === "now"} onChange={() => setTiming("now")} /> עכשיו
          </label>
          <label className="flex items-center gap-1">
            <input type="radio" checked={timing === "scheduled"} onChange={() => setTiming("scheduled")} /> בזמן מסוים
          </label>
          {timing === "scheduled" && (
            <Input type="datetime-local" value={scheduledFor} onChange={(e) => setScheduledFor(e.target.value)} className="w-auto" />
          )}
        </div>
      </div>

      {error && <p className="text-sm text-destructive">{error}</p>}
      {result && (
        <p className="text-sm text-green-700">
          נכנסו לתור: {result.total_recipients} · סוננו: {result.suppressed_count}
        </p>
      )}

      <Button onClick={submit} disabled={!canSubmit}>{busy ? "שולח…" : "שלח דיוור"}</Button>
    </div>
  );
}
```

- [ ] **Step 2: Write the list**

```tsx
// src/components/broadcasts/BroadcastList.tsx
import { useAgent } from "@/contexts/AgentContext";
import { useQuery, useMutation, useQueryClient } from "@tanstack/react-query";
import { listBroadcasts, cancelBroadcast } from "@/lib/broadcasts";
import { Button } from "@/components/ui/button";

export function BroadcastList() {
  const { activeAgent } = useAgent();
  const agentId = activeAgent?.id ?? "";
  const qc = useQueryClient();
  const q = useQuery({
    queryKey: ["broadcasts", agentId],
    queryFn: () => listBroadcasts(agentId),
    enabled: !!agentId,
  });
  const cancel = useMutation({
    mutationFn: (id: string) => cancelBroadcast(id),
    onSuccess: () => qc.invalidateQueries({ queryKey: ["broadcasts", agentId] }),
  });

  if (q.isLoading) return <p>טוען…</p>;
  const rows = q.data ?? [];
  if (rows.length === 0) return <p className="text-muted-foreground">אין דיוורים עדיין.</p>;

  return (
    <table className="w-full text-sm" dir="rtl">
      <thead>
        <tr className="text-right">
          <th className="p-2">שם</th><th className="p-2">תבנית</th><th className="p-2">נמענים</th>
          <th className="p-2">סוננו</th><th className="p-2">סטטוס</th><th className="p-2"></th>
        </tr>
      </thead>
      <tbody>
        {rows.map((b) => (
          <tr key={b.id} className="border-t">
            <td className="p-2">{b.title}</td>
            <td className="p-2">{b.template_name}</td>
            <td className="p-2">{b.total_recipients}</td>
            <td className="p-2">{b.suppressed_count}</td>
            <td className="p-2">{b.status}</td>
            <td className="p-2">
              {b.status !== "cancelled" && b.status !== "completed" && (
                <Button variant="ghost" size="sm" onClick={() => cancel.mutate(b.id)} disabled={cancel.isPending}>בטל</Button>
              )}
            </td>
          </tr>
        ))}
      </tbody>
    </table>
  );
}
```

- [ ] **Step 3: Write the page**

```tsx
// src/pages/Broadcasts.tsx
import { useState } from "react";
import { AdminOnly } from "@/components/auth/AdminOnly";
import { BroadcastComposer } from "@/components/broadcasts/BroadcastComposer";
import { BroadcastList } from "@/components/broadcasts/BroadcastList";

export default function Broadcasts() {
  const [refreshKey, setRefreshKey] = useState(0);
  return (
    <AdminOnly>
      <div className="space-y-8 p-6" dir="rtl">
        <div>
          <h1 className="text-2xl font-bold">דיוור</h1>
          <p className="text-muted-foreground">שליחת הודעת template בתפוצה רחבה — מיידית או מתוזמנת.</p>
        </div>
        <section className="rounded-lg border p-4">
          <h2 className="mb-3 text-lg font-semibold">דיוור חדש</h2>
          <BroadcastComposer onDone={() => setRefreshKey((k) => k + 1)} />
        </section>
        <section className="rounded-lg border p-4">
          <h2 className="mb-3 text-lg font-semibold">דיוורים אחרונים</h2>
          <BroadcastList key={refreshKey} />
        </section>
      </div>
    </AdminOnly>
  );
}
```

- [ ] **Step 4: Add the route in `src/App.tsx`**

Add the import near the other page imports:

```tsx
import Broadcasts from "@/pages/Broadcasts";
```

Add the route inside the protected `<Route>` group, next to `/settings`:

```tsx
<Route path="/broadcasts" element={<Broadcasts />} />
```

- [ ] **Step 5: Add the sidebar item in `src/components/layout/AppSidebar.tsx`**

In the nav-items array (the one containing `{ title: "הגדרות", url: "/settings", ... }`), add an admin-only entry. First ensure a `Send` icon is imported from `lucide-react` (add it to the existing lucide import), then add:

```tsx
{ title: "דיוור", url: "/broadcasts", icon: Send, end: false, adminOnly: true },
```

- [ ] **Step 6: Typecheck + build + run all tests**

Run: `~/.bun/bin/bun run build && ~/.bun/bin/bun run test`
Expected: build succeeds; all tests pass (including the new `broadcastRecipients`, `optOutFilter`, `parseBroadcastCsv`).

- [ ] **Step 7: Verify in the browser (preview)**

Start the dev server, log in as an admin, open `/broadcasts`. Confirm: the template dropdown is populated (seeded first-touch template), uploading a small CSV shows the recipient count, and submitting shows the "נכנסו לתור / סוננו" summary. Verify the sidebar item is hidden for a non-admin user.

- [ ] **Step 8: Commit**

```bash
git add src/pages/Broadcasts.tsx src/components/broadcasts/ src/App.tsx src/components/layout/AppSidebar.tsx
git commit -m "feat(broadcast): admin Broadcasts page (composer + list)"
```

---

## PHASE 6 — Wrap-up

### Task 10: Update docs

**Files:**
- Modify: `CLAUDE.md` (edge functions table + migrations list + current-state section)
- Modify: `supabase/functions/README.md` (if it lists functions)

- [ ] **Step 1: Add `broadcast-enqueue` to the edge-functions table and migrations 0042-0044 to the migrations section in `CLAUDE.md`.** Mention the new `broadcasts` / `broadcast_templates` tables and the dispatcher opt-out re-check in the defense-layers table.

- [ ] **Step 2: Commit**

```bash
git add CLAUDE.md supabase/functions/README.md
git commit -m "docs(broadcast): document broadcast feature (functions, migrations, defenses)"
```

---

## Verification checklist (before opening the PR)

- [ ] `~/.bun/bin/bun run build` passes.
- [ ] `~/.bun/bin/bun run test` passes (new suites: broadcastRecipients, optOutFilter, parseBroadcastCsv).
- [ ] `~/.bun/bin/bun run lint` passes.
- [ ] Smoke test (Task 6 Step 3): normal phone receives the template; opted-out phone does NOT and shows in `suppressed_breakdown.opt_out`.
- [ ] Dispatcher still drains normally after deploy (function logs clean, existing lead-register first-touch templates still fire).
- [ ] Non-admin cannot see `/broadcasts` nor call `broadcast-enqueue` (403).

## Prod-safety recap

- Schema: only new tables + one nullable column + new indexes. No existing column changed. Rollback = drop the new objects.
- `claim_scheduled_messages` RPC unchanged — dispatcher hot path identical for non-opted-out rows.
- `lead-register` / `re-engage-cold-leads` untouched; they enqueue with `broadcast_id = NULL`.
- The only behavioral change to a live function is the dispatcher's additive opt-out re-check, which can only *cancel* a send (never send something that wouldn't have been sent), backed by a unit test.
