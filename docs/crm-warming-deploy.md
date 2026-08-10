# CRM-Driven Lead Warming — deployment runbook

Hand this to whoever deploys. Everything below is on branch `feat/crm-lead-warming`.

**What this feature does.** A rep changes a lead's status in Fireberry → Make → a new webhook on
our side flags the conversation as *warming* and queues one generic WhatsApp opener. When the lead
replies, the **existing** agent loop handles them, with per-status instructions injected into the
system prompt.

**Blast radius on the live bot: near zero, by construction.**
- Every DB change is additive — no existing column is altered or dropped.
- `agents.crm_warming_enabled` defaults to **false**, so applying the migration changes no behaviour
  at all until someone deliberately switches an agent on.
- For any lead without a Fireberry status event the injected prompt block is the empty string, so the
  system prompt is byte-identical to today's — including the `cache_control` prefix in `agentTurn.ts`.
- The dispatcher's existing `kind='template'` path is untouched; the new rule applies only to
  `kind='warming'` rows.

---

## Order of operations

Steps 1–3 are safe on their own and change nothing the leads can see. Step 5 is the switch that makes
the feature live.

### 1. Migration

```bash
bun run db:apply supabase/migrations/0046_crm_warming.sql
```

Adds: enum `crm_warming_status_enum`; table `crm_status_rules` (+ admin-only RLS, `updated_at`
trigger, 33 seeded rows per agent); 8 nullable columns on `conversations`; 4 columns on `agents`;
`kind` on `scheduled_messages`.

Idempotent throughout (`IF NOT EXISTS` / `ON CONFLICT DO NOTHING`), so a re-run is a no-op — and
notably the seed will **never** overwrite instruction text an operator has since edited from the
dashboard.

The two `NOT NULL` columns (`agents.crm_warming_enabled`, `scheduled_messages.kind`) both take
constant defaults, so on Postgres 17 this is a metadata-only change: no table rewrite, no long lock.

> The SQL has been parsed against the real Postgres grammar (16 statements, clean) but **has not been
> executed against any database** — there was no environment available to run it in. Treat step 1 as
> the first real execution and check the output.

Then regenerate types and commit the result:

```bash
bun run db:types
```

This also picks up `agents.mooz_product_code`, which migration `0041` added but which was never
regenerated into `src/types/database.ts`.

After regenerating, the temporary casts in `src/lib/crm-warming.ts` can be dropped — they exist only
because the dashboard was written before the migration landed. They are marked with a comment.

### 2. Secret

```bash
bunx supabase secrets set CRM_STATUS_SHARED_SECRET=<generate a long random value> \
  --project-ref juoglkqtmjsziieqgmhf
```

Give the same value to Izak for the Make scenario's `Authorization` header.

### 3. Deploy functions

```bash
# New. MUST use --no-verify-jwt — Make cannot carry a Supabase JWT; the function
# authenticates via the Bearer shared secret set above.
bunx supabase functions deploy crm-status-webhook --no-verify-jwt --project-ref juoglkqtmjsziieqgmhf

# Modified.
bunx supabase functions deploy dispatch-scheduled-templates --no-verify-jwt --project-ref juoglkqtmjsziieqgmhf
bunx supabase functions deploy mooz-webhook --no-verify-jwt --project-ref juoglkqtmjsziieqgmhf
bunx supabase functions deploy whatsapp-webhook --no-verify-jwt --project-ref juoglkqtmjsziieqgmhf
bunx supabase functions deploy whatsapp-webhook-dm --no-verify-jwt --project-ref juoglkqtmjsziieqgmhf
```

Both WhatsApp entrypoints must go out because they share `_shared/whatsappWebhookHandler.ts`.

**Deploy the migration before the functions.** The handler now selects `crm_*` columns on the lock
claim; against a pre-migration database that select fails and the agent loop stops replying.

### 4. Meta template

One warming opener per agent — a generic line, the same for every lead, e.g. `היי, מה קורה?`.

Get it approved in Meta, register it in `broadcast_templates`, then set it on the agent
(`agents.warming_template_name`) from the dashboard Settings tab.

Parameter count matters. The webhook reads `broadcast_templates.variable_count` and builds exactly
that many parameters — a mismatch is Meta error #132000, which fails the whole send:
- **0 parameters** (recommended, and what the existing first-touch template does): sends with no
  params. Nothing can go wrong.
- **1 parameter**: filled with the lead's name. A lead with no name is skipped and logged as
  `warming_missing_template_variable` rather than sent malformed.
- **2+**: refused and logged — only slot 1 has a defined meaning.

### 5. Go live (the actual switch)

Per agent, in dashboard Settings, turn on `crm_warming_enabled`. **Start with
`affiliate_marketing` only** and watch the first ~20 leads end-to-end before enabling
`digital_marketing`.

To stop everything instantly, turn it back off. It is independent of `is_paused`; status events keep
being recorded for the dashboard, but nothing is queued and the prompt goes back to untouched.

---

## Make side — the contract Izak builds against

`POST https://juoglkqtmjsziieqgmhf.supabase.co/functions/v1/crm-status-webhook`
`Authorization: Bearer <CRM_STATUS_SHARED_SECRET>`

```json
{
  "product": "B",
  "lead_phone": "0501234567",
  "status_sub": 60,
  "status_main": 5,
  "lead_name": "ישראל",
  "rep_note": "אמר שהוא בתהליך גירושין וזה לא הזמן",
  "fireberry_lead_id": "abc-123"
}
```

| Field | Required | Notes |
|---|---|---|
| `product` | ✅ | `B` = affiliate_marketing, `R` = digital_marketing. Matched against `agents.mooz_product_code`. |
| `lead_phone` | ✅ | Any Israeli format; normalised our side. |
| `status_sub` | ✅ | `pcfsystemfield103`. **This is the decision key.** Accepts a number or a numeric string. |
| `status_main` | — | Context only. |
| `lead_name` | — | Also used as template parameter 1 when the opener declares one. |
| `rep_note` | — | The rep's free-text note. Optional, and worth chasing: it is the single biggest quality lever in the feature — it's the difference between the bot knowing the category of objection and knowing the specifics. Treated as untrusted input and wrapped so it can't act as an instruction. |
| `fireberry_lead_id` | — | Stored if present. **Not** an identity key — the phone is. |

**Filtering is Make's job, not ours.** There is deliberately no allow-list on our side: every event
that arrives warms the lead. Blocking statuses (blacklist / invalid lead / wrong number) must simply
never be sent. A status that arrives with no rule row falls back to an immediate warm and is logged
as `crm_status_rule_missing`.

Responses are always `200` with a JSON body describing what happened (`enqueued`, `cooldown_skipped`,
`warming_enabled: false`, `superseded`, …), except `401` on a bad secret, `400` on a malformed
payload, `404` on an unknown product.

---

## Behaviour worth knowing before you support it

**Context always refreshes; sends are rate-limited.** Every status event immediately updates what the
bot knows. Whether an opener is *sent* is governed by `crm_status_rules.cooldown_days`. So a lead
flipped through four statuses in a week gets one message, but the bot is always working the newest
objection.

**A newer status supersedes a pending older one — but only when a replacement is actually going
out.** A lead marked "price" (15-day delay) then "no time" two days later normally has the price row
cancelled (`last_error='superseded_by_newer_crm_status'`) and a fresh one queued. If the second event
falls inside the cooldown, though, the pending row is deliberately left alone rather than cancelled —
cancelling it and then declining to replace it would silently drop the lead's warming altogether.
The stale row is harmless: the opener is generic, and by the time it fires the bot is carrying the
newest status context.

**The context expires.** A status is a snapshot, not a fact about a person. The prompt block is
injected only while the last status event is inside `agents.warming_context_days` (default 14). Each
new event restarts the clock, so an actively-worked lead always has current context.

**The opener waits for a quiet moment.** A warming row whose lead wrote within the last 60 minutes is
*deferred*, not cancelled — it goes out on a later tick once they go quiet. Counted as
`deferred_warming_active_chat` in the dispatcher response.

**Ghosted-Zoom leads (status 91)** clear `zoom_scheduled_at`, `zoom_booked_by` and the
`zoom_scheduled` tag before queueing — otherwise the lead's own stale tag would cancel the send.
This is driven by `crm_status_rules.clears_zoom_state`, not a hardcoded status number.

**Langfuse.** Warming turns carry the tags `warming`, `status:<n>`, `objection:<key>` — so
"every conversation triggered by status 60, and what the bot actually said" is a filter in the UI.
Two session scores are now emitted: `lead_replied` and `bot_booked_zoom`. Normal (non-warming)
traces are unchanged.

### Accepted risk, decided deliberately

Leads with **no WhatsApp history** are warmed too — a lead that exists in Fireberry but has never
messaged the bot gets a conversation row created and the opener sent. Those sends go to numbers whose
WhatsApp opt-in we cannot prove, and Meta counts them toward the quality rating of the number the live
bot depends on. The dashboard flags this cohort ("ללא היסטוריה") specifically so a downward trend gets
noticed early. Watch it during the canary.

### Where to look when something is wrong

`error_logs`, filtered by `source='crm-status-webhook'`. The error types are stable:
`crm_status_validation_failed`, `agent_not_found`, `crm_status_rule_missing`,
`warming_template_not_configured`, `warming_missing_template_variable`,
`warming_template_variable_mismatch`, `crm_status_webhook_failed`. From the agent loop:
`warming_context_load_failed` (degrades to no block — never costs a lead a reply).

---

## Post-deploy verification

Run these against production after step 3, **before** step 5. With `crm_warming_enabled` still false,
steps 1–2 exercise the recording path without sending anything.

1. `curl` with `product=B, status_sub=60` → `200`, `warming_enabled:false`, `recorded:true`, a
   conversation row with `crm_status_sub=60` and `crm_warming_status` still NULL, and **no**
   `scheduled_messages` row. This is the kill switch working.
2. Confirm 33 seed rows exist per agent: `select agent_id, count(*) from crm_status_rules group by 1`.
3. Enable warming for `affiliate_marketing`, then repeat the curl → now `enqueued:true`,
   `scheduled_for` ≈ now. With `status_sub=14` → `scheduled_for` ≈ now + 15 days.
4. POST twice inside the cooldown → context updated both times, exactly one queued row
   (`cooldown_skipped:true` on the second).
5. Set a test conversation's `last_inbound_at` to 5 minutes ago → dispatcher leaves the row pending
   and reports `deferred_warming_active_chat`. Set it to 2 hours ago → it sends. Confirm
   `kind='template'` rows in the same tick are unaffected.
6. Send a message as a warming lead → the block appears in the system prompt in Langfuse and the trace
   carries `warming` + `status:60`. Send as a normal lead → the block is absent.

## What was run locally

- `bun run test` — 462 tests pass, including 20 new ones for `warmingContextBlock`.
- `bun x tsc --noEmit` — clean.
- `deno check` on every modified edge function — no new errors. (Two pre-existing errors remain, in
  `lead-register` and `mooz-webhook`; both are present on `main` and are esm.sh type-definition gaps,
  not runtime bugs.)
- The migration parsed against the Postgres grammar. **Not executed** — see step 1.

## Still open

- The Meta-approved opener template (step 4).
- `rep_note` in the Make payload — optional, but the highest-value thing still outstanding.
- Review of the 33 seeded `warming_instructions` texts. They are a first draft written against the
  tone of the live prompts, and are meant to be edited from the dashboard once real replies are
  visible — no deploy, no Meta approval.
