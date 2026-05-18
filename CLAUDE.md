# CLAUDE.md

> מסמך זה הוא ה-source of truth לכל שיחת Claude Code על הפרויקט. כל החלטה ארכיטקטונית, הסבר מצב, וכלל עבודה — כתובים פה. עדכן אותו כשמשתנה משהו מבני.

## סקירת הפרויקט

**מערכת WhatsApp AI למכללת ריצ'ר** — דשבורד ניהול לסוכני AI שמטפלים בלידים בוואטסאפ.

הפרויקט הוא ארכיטקטורת **Multi-Agent**: מערכת אחת תומכת במספר סוכנים נפרדים, כל אחד עם מספר WhatsApp נפרד וקונפיגורציה משלו, על תשתית טכנית משותפת.

- **סוכן ראשון**: שיווק שותפים — האחים סיטון
- **סוכנים עתידיים**: שיווק דיגיטלי, AI, וידאו, נדל"ן

הריפו הזה כולל גם את **דשבורד הניהול** וגם את **ה־AI agent loop עצמו** (Supabase Edge Functions ב־`supabase/functions/`). הכל בריפו אחד — אין n8n, אין מערכת חיצונית.

## ארכיטקטורה כללית

```
Landing form  ─POST─►  lead-register  ──► scheduled_messages (40-min nudge if cold)
                                                │
WhatsApp lead (real)                            ▼
       ↕                              dispatch-scheduled-templates (pg_cron)
Meta Cloud API ──HookMyApp channel                    │
       ↕  POST (X-Hub-Signature-256)                  ▼
       ▼                                       HookMyApp template send
┌─ Supabase Edge Functions ──────────────────────────────────────────────┐
│  PUBLIC / no-jwt:                                                       │
│    whatsapp-webhook   (inbound + agent loop + memory + handoff)         │
│  ADMIN (JWT + requireAdmin):                                            │
│    whatsapp-send · prompt-replay · prompt-coach · prompt-coach-apply    │
│    brain-ingest · dlq-replay · invite-user · delete-user                │
│  SHARED-SECRET (pg_cron / Make.com):                                    │
│    dispatch-scheduled-templates · re-engage-cold-leads · lead-register  │
└─────┬─────────────────────────────────┬─────────────────────────────────┘
      │ service_role                     │ Anthropic SDK
      ▼                                  ▼
  Supabase Postgres ◄──► Claude Sonnet 4.6 (agent reply + brain context)
  conversations · messages · lead_memory · prompts · agents · advisors    
  error_logs · failed_messages · scheduled_messages                       
  coach_messages · brain_documents · brain_usage_log                      
      │                                  │
      │                                  ▼
      │                          Claude Haiku 4.5 (memory extractor + judge)
      │                                  │           OpenAI Whisper (voice)
      │                                  ▼
      │                          fireHandoffWebhook ─POST─► Make.com
      │                                                     ├─► Mooz (Zoom)
      │                                                     ├─► Fireberry CRM
      │                                                     └─► advisor alerts
      ▼
Langfuse Cloud ◄─ traces per turn (system+messages+output+tokens+cost)

Dashboard (Lovable + Vercel)
       ↕  @supabase/supabase-js (anon → authenticated session)
       └──► Supabase Postgres (RLS-gated) + Realtime (messages channel)
```

**WhatsApp pipeline (current production setup — Cloud API via HookMyApp):**

ה־`whatsapp-webhook` ([supabase/functions/whatsapp-webhook/index.ts](./supabase/functions/whatsapp-webhook/index.ts)) מקבל POST מ־HookMyApp עם חתימה ב־header (גם `X-Hub-Signature-256` של Meta וגם `X-HookMyApp-Signature-256` של הסנדבוקס נתמכים). אם החתימה חסרה / לא תקינה → 200 ללא עיבוד (fail-open) כדי לעבור את verification ping של HookMyApp. אם תקינה → upsert ל־conversation (UNIQUE על `(agent_id, lead_phone)` מ־migration 0010 מונע race), insert ל־`messages` inbound (UNIQUE על `meta_message_id` מ־migration 0007 מונע double-reply ב־retry), ואז ברקע (`EdgeRuntime.waitUntil`):

1. טוען `prompts.is_active=true AND prompt_type='main'`
2. טוען 30 הודעות אחרונות (descending → reverse → chronological)
3. קורא ל־Claude Sonnet 4.6 עם adaptive thinking
4. מאמת ב־`validateAgentReply` (אורך, placeholders, hallucination guards — מחירים/AI-disclosure/ערבויות)
5. שולח ל־HookMyApp דרך `sendWhatsAppText` עם retry (3 ניסיונות, backoff 1s/2s, AbortController timeout 8s, Bearer redaction)
6. כותב outbound row עם `langfuse_trace_id` + `prompt_version_id` + tokens + cost + latency
7. שולח trace ל־Langfuse Cloud
8. קורא ל־Claude Haiku 4.5 ב־JSON mode (prefill `{`) לחילוץ זיכרון → upsert `lead_memory` + עדכון `conversations.primary_objection` ו־`current_tag` (red_flags → `requires_human`, underage → `underage`)

כל כשל בשלב כלשהו → `error_logs` + (אם רלוונטי) `failed_messages` (DLQ).

ה־`whatsapp-send` ([supabase/functions/whatsapp-send/index.ts](./supabase/functions/whatsapp-send/index.ts)) — שליחה ידנית מהדשבורד ב־ReplyBox דרך אותו `sendWhatsAppText`. ה־`prompt-replay` ([supabase/functions/prompt-replay/index.ts](./supabase/functions/prompt-replay/index.ts)) — כלי A/B לאדמינים, מריץ prompt מועמד מול שיחה היסטורית ומחזיר side-by-side.

## ההחלטות הארכיטקטוניות (10)

| # | תחום | החלטה |
|---|---|---|
| 1 | מי כותב קוד | **רק Claude Code.** Lovable נשאר מחובר ל-git אבל לא כותב. |
| 2 | אירוח Production | **Lovable + Vercel** — שניהם auto-deploy מ-`main` (כל אחד בונה `vite build` משלו). `vercel.json` עם SPA rewrite למניעת 404 ב־deep-links. |
| 3 | זרימת קוד | **Feature branches → PR → merge ל-main.** Preview מקומי עם `bun dev`. |
| 4 | סכמת Supabase | **Migrations בריפו** (`supabase/migrations/`). אין עריכה ידנית ב-Studio. |
| 5 | Prompts | **קבצים בריפו → סנכרון אוטומטי** לטבלת `prompts` ב-Supabase. |
| 6 | Orchestration / AI loop | **Supabase Edge Functions** (Deno + Anthropic SDK). הלולאה לקריאת Claude, חילוץ זיכרון, ותיוג חיים בקוד שב־`supabase/functions/`, לא ב־n8n. n8n נשאר אופציה ל־visual workflows אם נצטרך. |
| 7 | Auth | **מוקדם, email/password, ניהול משתמשים מהמסך.** מתחילים במשתמש ראשי אחד. |
| 8 | TypeScript | **Strict mode.** אסור `any`. |
| 9 | CI | **typecheck + lint + build על כל PR.** Branch protection ב-main. |
| 10 | Testing | **רק על הגרעין הקריטי**: queries, contexts, auth, חישובי KPIs. לא UI. |

## Tech Stack

- **Frontend**: Vite + React 18 + TypeScript (strict)
- **UI**: shadcn/ui + Tailwind CSS, RTL מלא, פונט Heebo
- **Routing**: react-router-dom v6
- **State**: React Context + `@tanstack/react-query` + Supabase Realtime (channel על `messages` ל־live updates בדף Conversations)
- **Forms**: react-hook-form + zod
- **DB / Auth**: Supabase (Postgres + Auth + Storage + Realtime publication על `public.messages` מ־migration 0013)
- **AI**:
  - Claude Sonnet 4.6 (agent reply, adaptive thinking)
  - Claude Haiku 4.5 (memory extractor, JSON mode via assistant prefill)
- **Orchestration / AI loop**: Supabase Edge Functions (Deno) — `whatsapp-webhook` (agent loop) · `whatsapp-send` (manual takeover) · `prompt-replay` (admin A/B) · `invite-user` · `delete-user`
- **Observability**: Langfuse Cloud — כל קריאת Claude נשמרת כ־trace (system + messages + output + tokens + cost + latency). `error_logs` + `failed_messages` ב־Postgres לכשלים ולתור שחזור.
- **WhatsApp BSP**: HookMyApp Cloud API — production WABA `1001103162575975` (`+972 55-991-7038`, "מכללת ריצ׳ר ליזמות דיגיטלית"). webhook ישיר מ־HookMyApp לפונקציה הפרוסה — אין tunnel/proxy מקומי בייצור.
- **Hosting**: שני יעדים מקבילים — **Lovable** (`*.lovable.app`) ו־**Vercel** (`vercel.json` עם SPA rewrite). שניהם auto-deploy מ־`main`, שניהם בונים את אותו `vite build`, שניהם פוגעים באותו Supabase + HookMyApp מאחורה.
- **Cron**: `pg_cron` (Supabase Postgres) קורא ל־`dispatch-scheduled-templates` ו־`re-engage-cold-leads` עם `CRON_SHARED_SECRET`.
- **Voice**: OpenAI Whisper לתעתוק הודעות קוליות בעברית (`_shared/transcribeVoice.ts`). אופציונלי — בלי `OPENAI_API_KEY` הבוט שומר placeholder `[audio]`.
- **Outbound integrations**: Make.com (fan-out מ־handoff webhook ל־Mooz + Fireberry + יועצים). landing-page form → `lead-register` עם `LEAD_REGISTER_SHARED_SECRET`.
- **Package Manager**: bun (`~/.bun/bin/bun`) — לא חובה, `npx` / `npm` עובדים על כל ה־CI scripts (test/lint/build/typecheck)
- **Testing**: vitest + @testing-library/react — 193 טסטים (21 קבצים) על client + edge functions (`supabase/functions/_shared/*.test.ts`).

## מבנה תיקיות

```
.
├── .github/workflows/      # GitHub Actions (CI)
├── public/                 # static assets
├── src/
│   ├── components/
│   │   ├── layout/         # AppLayout · AppSidebar · AppHeader · AgentSelector
│   │   ├── ui/             # shadcn primitives + customizations (button/switch/dialog RTL)
│   │   ├── analytics/      # CostLatencyDashboard · InsightsCards (funnel drop-off · campaign cohorts · health)
│   │   ├── conversations/  # ConversationDetail · MessageThread · MessageBubble · MessageDebugPopover · ReplyBox · LeadMemoryPanel · AddToBrainDialog
│   │   ├── coach/          # BrainPanel — PDFs/images/notes editor + token counter
│   │   ├── dashboard/      # KpiCard · FunnelBreakdownChart · TagBreakdownList · RecentLeadsList
│   │   ├── prompts/        # PromptViewDialog · PromptReplayDialog
│   │   ├── settings/       # AgentsTab · UsersTab · InviteUserDialog · UserRoleBadge · DlqTab (failed_messages admin)
│   │   ├── effects/        # Aurora · NoiseOverlay · AnimatedNumber (warm-dark UI)
│   │   ├── auth/           # AdminOnly
│   │   ├── BrandLogo.tsx
│   │   ├── EmptyState.tsx
│   │   └── NavLink.tsx
│   ├── contexts/           # AgentContext · AuthContext
│   ├── hooks/              # use-toast · use-theme · use-mobile · use-spotlight
│   ├── lib/
│   │   ├── supabase/       # client.ts
│   │   ├── agents.ts · agents-admin.ts · analytics.ts · conversations.ts
│   │   ├── kpis.ts · lead-memory.ts · leads.ts · messages.ts
│   │   ├── operations.ts   # cost/latency aggregates for Analytics (Phase B)
│   │   ├── insights.ts     # funnel drop-off · campaign cohorts · health rates
│   │   ├── prompts.ts      # getPrompts · setActivePromptVersion (Phase D-mini)
│   │   ├── prompt-replay.ts # client wrapper for prompt-replay edge fn (Phase D-full)
│   │   ├── coach.ts        # Prompt Coach chat wrapper (sendCoachMessage · applyCoachEdit)
│   │   ├── brain.ts        # Brain knowledge base CRUD (notes + uploads → brain-ingest)
│   │   ├── dlq.ts          # failed_messages list + dlq-replay invocation
│   │   ├── validation.ts   # UUID + assertion helpers (PostgREST injection prevention)
│   │   ├── users.ts · users-admin.ts
│   │   └── utils.ts
│   ├── pages/              # 9 דפים: Index · Leads · Conversations · Prompts · Coach · Settings · Analytics · Login · NotFound
│   ├── types/              # database.ts מיוצר אוטומטית מ־Supabase + brain.ts · agent.ts (טיפוסים ייעודיים)
│   └── test/               # vitest setup
├── supabase/
│   ├── migrations/         # 0001–0023 (ראה רשימה מלאה ב־supabase/README.md)
│   ├── functions/
│   │   ├── _shared/        # auth · cors · validation · anthropicRetry · brainContext · dlq · extractMemory · fireHandoffWebhook · injectionScan · judgeReply · langfuse · logError · transcribeVoice · truncate · validateAgentReply · whatsappSend · whatsappTemplateSend
│   │   ├── whatsapp-webhook/         # public (no-jwt): HookMyApp inbound + agent loop + memory extractor + handoff
│   │   ├── whatsapp-send/            # auth: dashboard ReplyBox manual send
│   │   ├── prompt-replay/            # admin: A/B test prompt vs past conversation
│   │   ├── prompt-coach/             # admin: chat-based prompt tuning (tool_use + brain context)
│   │   ├── prompt-coach-apply/       # admin: apply Coach-proposed prompt edit
│   │   ├── brain-ingest/             # admin: PDF/image extraction + injection scan (async, EdgeRuntime.waitUntil)
│   │   ├── dlq-replay/               # admin: retry failed_messages
│   │   ├── invite-user/              # admin: invite by email
│   │   ├── delete-user/              # admin: hard-delete auth user
│   │   ├── lead-register/            # shared-secret: landing form → conversation + scheduled first-touch
│   │   ├── dispatch-scheduled-templates/  # cron (shared-secret): drain scheduled_messages queue
│   │   └── re-engage-cold-leads/     # cron (shared-secret): nudge silent leads
│   └── README.md           # supabase project ref + migration workflow
├── scripts/                # bun/npx scripts: db:apply · db:types · fn:deploy · prompts:sync · seed:test · seed:clear · wa:proxy
├── prompts/                # files in repo → DB (prompts:sync)
│   └── affiliate_marketing/
│       ├── _active.json    # { "main": "v3", "memory_extractor": "v2" }
│       ├── main/{v1,v2,v3}.md           # agent reply prompts (Sonnet 4.6)
│       └── memory_extractor/{v1,v2}.md  # JSON extraction prompts (Haiku 4.5)
├── vercel.json             # SPA rewrite (כל route → index.html)
└── CLAUDE.md               # זה הקובץ שאתה קורא
```

## כללי עבודה

### Branches & PRs

- **`main`** = production. Lovable מ-deploy ממנו אוטומטית.
- **לא לעשות push ישיר ל-main.** Branch protection אוסר על זה.
- **שמות branches**:
  - `feat/<description>` — פיצ'ר חדש
  - `fix/<description>` — תיקון באג
  - `chore/<description>` — תחזוקה / refactoring / docs
- **PR title**: באנגלית, conventional commit style (`feat: add login screen`).
- **PR description**: summary + test plan.
- **לפני merge**: ה-CI חייב לעבור (typecheck + lint + build).

### TypeScript

- **Strict mode מופעל.** אל תכבה אותו.
- אסור `any` — אם צריך טיפוס לא ידוע, השתמש ב-`unknown` ועשה narrowing.
- Null checks חובה — אל תניח ש-value מוגדר אם הטיפוס מציין `null | undefined`.

### Supabase

- **רק migrations.** אסור לערוך את הסכמה ידנית ב-Supabase Studio. כל שינוי = migration חדש.
- שמות migrations: `<NNNN>_<description>.sql` (4 ספרות, snake_case). דוגמה: `0001_initial_schema.sql`, `0002_rls_policies.sql`.
- אחרי יצירת migration: `supabase db push` כדי להחיל על ה-DB, ואז `supabase gen types typescript` כדי לעדכן types.
- **RLS חובה** על כל טבלה עם נתוני משתמש או לידים.

### Prompts

- כל Prompt חי כקובץ markdown ב-`prompts/<agent_name>/<version>.md`.
- שינוי Prompt = שינוי קובץ → PR → merge → סקריפט סנכרון מעלה ל-DB.
- **אסור** לערוך Prompts ישירות ב-DB; זה יידרס בסנכרון הבא.

### Edge Functions

- כל function ב־`supabase/functions/<name>/index.ts`. דנו, לא Node.
- Deploy: `bunx supabase functions deploy <name> [--no-verify-jwt] --project-ref juoglkqtmjsziieqgmhf`. ה־`whatsapp-webhook` חייב `--no-verify-jwt` כי HookMyApp/Meta לא שולחים JWT — אימות נעשה דרך חתימת HMAC.
- סודות נדחפים ל־Supabase דרך `bunx supabase secrets set --env-file <path>`. ה־`SUPABASE_*` מוזרקים אוטומטית.
- ראה [supabase/functions/README.md](./supabase/functions/README.md) לפירוט הפונקציות, ה־secrets, וזרימת ה־HookMyApp Cloud API.
- האגנט הראשי (Claude reply loop) רץ ב־`whatsapp-webhook` כ־background task דרך `EdgeRuntime.waitUntil` — ה־webhook מחזיר 200 מיד ל־HookMyApp ואז מייצר את התגובה ברקע. אין n8n.
- הפונקציות הפעילות בפרוד (12):
  - **public / no-jwt**: `whatsapp-webhook` (HMAC verified)
  - **admin (JWT + requireAdmin)**: `whatsapp-send`, `prompt-replay`, `prompt-coach`, `prompt-coach-apply`, `brain-ingest`, `dlq-replay`, `invite-user`, `delete-user`
  - **shared-secret (cron / Make.com)**: `lead-register` (`LEAD_REGISTER_SHARED_SECRET`), `dispatch-scheduled-templates` (`CRON_SHARED_SECRET`), `re-engage-cold-leads` (`CRON_SHARED_SECRET`)

### Testing

- **טסטים על הגרעין הקריטי בלבד**: queries, contexts, auth, חישובי KPIs.
- אסור לטסט UI styling או רכיבי עיצוב.
- כל פיצ'ר חדש שכולל לוגיקה לא-טריוויאלית → טסט.

### Auth

- כל page (חוץ מ-login) דורש user מחובר.
- Redirect ל-`/login` אם user לא מחובר.
- ניהול משתמשים: רק admin יכול להוסיף/להסיר משתמשים.

## Local Development

### Setup ראשון (פעם אחת)

```bash
# התקן Bun (אם אין)
curl -fsSL https://bun.sh/install | bash

# Clone & install
git clone https://github.com/RicherLTD/richer-ai-agents-hub.git
cd richer-ai-agents-hub
~/.bun/bin/bun install

# העתק env example
cp .env.example .env.local
# ערוך .env.local עם ה-credentials של Supabase
```

### פקודות יומיות

```bash
~/.bun/bin/bun run dev     # dev server על http://localhost:8080
~/.bun/bin/bun run lint    # eslint
~/.bun/bin/bun run test    # vitest
~/.bun/bin/bun run build   # production build
```

## משתני סביבה

ראה `.env.example`. שלוש משפחות:

**Client (build-time, public, ב־`.env`):**
- `VITE_SUPABASE_URL` — URL של פרויקט Supabase
- `VITE_SUPABASE_ANON_KEY` — anon key (בטוח להיות בקוד client-side)

**Server-side scripts (`.env.local`, gitignored):**
- `SUPABASE_PROJECT_REF`, `SUPABASE_ACCESS_TOKEN` — נצרכים על ידי `bun run db:apply`, `prompts:sync`, `seed:test`, וגם פקודות ה־`bunx supabase functions deploy` / `secrets set`.

**Edge function secrets (Supabase secrets, גם ב־`.env.functions.local` לפיתוח):**
- `VERIFY_TOKEN` — סיסמת ה־HMAC של ה־webhook (Meta App Secret בפרוד, או טוקן סשן בסנדבוקס). משמשת גם לאימות challenge ב־GET.
- `WHATSAPP_API_URL`, `WHATSAPP_ACCESS_TOKEN`, `WHATSAPP_PHONE_NUMBER_ID` — endpoint + auth של HookMyApp (production: `https://graph.facebook.com/v22.0`; sandbox legacy: `https://sandbox.hookmyapp.com/v22.0`).
- `HOOKMYAPP_AGENT_NAME` — slug ב־`agents.name` שאליו ייוחסו לידים נכנסים (פעיל: `affiliate_marketing`).
- `ANTHROPIC_API_KEY` — `sk-ant-...`. בלעדיו לולאת התגובה האוטומטית מושבתת בעדינות (הודעות נכנסות עדיין נכנסות ל־DB).
- `LANGFUSE_PUBLIC_KEY`, `LANGFUSE_SECRET_KEY`, `LANGFUSE_HOST` — observability per-turn. בלעדיהם הבוט עובד אבל ללא trace (אזהרה ב־error_logs).
- `HANDOFF_WEBHOOK_URL` — Make.com scenario URL לפיזור ל־Mooz / Fireberry / יועצים. בלעדיו ה־handoff נכשל ונכנס ל־DLQ.
- `HANDOFF_WEBHOOK_SECRET` — אופציונלי. אם מוגדר, ה־payload נחתם ב־`X-Handoff-Signature-256: sha256=HEX`.
- `LEAD_REGISTER_SHARED_SECRET` — Bearer לאימות `lead-register` (POST מ־Make.com).
- `CRON_SHARED_SECRET` — Bearer לאימות `dispatch-scheduled-templates` ו־`re-engage-cold-leads` (קריאות מ־`pg_cron`).
- `OPENAI_API_KEY` — אופציונלי. בלעדיו הודעות קוליות נכנסות כ־`[audio]` placeholder; עם — תעתוק Whisper לעברית.

מסלול עדכון אופייני:
```bash
# ערוך .env.functions.local — חמש משפחות הסודות (HookMyApp, Anthropic, Langfuse, handoff/cron secrets, OpenAI)
bunx supabase secrets set --env-file .env.functions.local --project-ref juoglkqtmjsziieqgmhf
```

**אסור** לשים `service_role` key ב-client-side. הוא רק לסקריפטים שרצים בצד שרת (למשל סקריפט סנכרון Prompts).

## מצב נוכחי

### מה קיים ועובד (Phases A → E + Coach/Brain + UI overhaul + hardening rounds 2/3)

**Production WhatsApp pipeline:**
- HookMyApp Cloud API → WABA `1001103162575975` (`+972 55-991-7038`, "מכללת ריצ׳ר ליזמות דיגיטלית") → webhook ישיר ל־edge function. אין tunnel/proxy בייצור.
- אימות חתימה דו־כיווני (Meta `X-Hub-Signature-256` + HookMyApp `X-HookMyApp-Signature-256`), fail-open ב־POST ללא חתימה כדי לעבור verification ping של HookMyApp.
- GET challenge: תומך גם בדפוס Meta (`hub.mode/hub.verify_token/hub.challenge`) וגם בדפוס echo של ה־VERIFY_TOKEN.
- שיחה דו־כיוונית מאומתת end-to-end עם הטלפון האמיתי.

**Phase A — Reliability (Stop the bleeding):**
- **Idempotency**: migration `0007` הוסיף `meta_message_id UNIQUE`. retry של Meta לא מייצר תגובה כפולה.
- **DLQ**: migration `0008` הוסיף `failed_messages`. כל validation fail / send fail / Claude empty / RPC error נכנס שם, עם payload + error_type + retry_count.
- **Structured error logs**: migration `0009` הוסיף `error_logs` עם enum `error_type`. כל `console.error` הוחלף ב־`logError({ source, error_type, message, context })`.
- **Send retry**: 3 ניסיונות עם backoff (1s/2s), `AbortController` timeout 8s, Bearer redaction בלוגים.
- **Race-safe upsert**: migration `0010` הוסיף UNIQUE על `(agent_id, lead_phone)` ב־conversations.

**Phase B — Observability (Langfuse):**
- **Custom Langfuse HTTP client** ב־`_shared/langfuse.ts` (לא SDK — Deno compat). pricing של Sonnet 4.6: `$3/M input`, `$15/M output`, `$3.75/M cache write`, `$0.30/M cache read`.
- **Trace per turn**: כל קריאת Claude → trace ב־Langfuse Cloud עם system+messages+output+tokens+cost+latency. כשל ב־ingestion → `error_logs` (לא חוסם).
- **Provenance ב־`messages`**: migration `0012` הוסיף `langfuse_trace_id`, `prompt_version_id`, `tokens_input`, `tokens_output`, `cost_usd`, `latency_ms`, `model`.
- **`MessageDebugPopover`** — אייקון Info על בועת outbound → cost / latency / tokens / trace_id (Copy button) / prompt_version_id.
- **`CostLatencyDashboard`** ב־Analytics — 6 כרטיסים: עלות היום / השבוע / החודש, P50 / P95 latency, מספר תגובות. דרך `getOperationsMetrics()` ב־`src/lib/operations.ts`.
- **Realtime**: migration `0013` הוסיף `public.messages` ל־`supabase_realtime` publication. דף Conversations משתמש ב־channel `messages:agent=<id>` ומרענן `react-query` אוטומטית — אין צורך ב־refresh ידני.

**Phase C — Memory + Self-healing:**
- **Memory extractor**: `_shared/extractMemory.ts` קוראת ל־Claude Haiku 4.5 ב־JSON mode (assistant prefill `{`) אחרי כל תור מוצלח. ממלאה `lead_memory.q1_age..q6_investment + conversation_summary + primary_objection + notes_for_advisor + red_flags`.
- **Auto-tagging**: `decideConversationTag()` ממפה red_flags → `current_tag`. `underage` → `underage`. אחר → `requires_human`. תגיות סופיות (`zoom_scheduled` / `opted_out` / `ghosted`) לא נדרסות.
- **Hallucination guards**: `_shared/validateAgentReply.ts` חוסם הודעות שמכילות AI brand leak (ChatGPT/Claude/OpenAI/Gemini), Hebrew self-disclosure (אני AI/בוט/מודל), currency (₪/$/ש״ח/שקלים), guarantees (מובטח/מבטיח/ערבות). תגובה לא תקינה → לא נשלחת + נכנסת ל־DLQ + `error_logs(error_type=hallucination_*)`.
- **Prompt חדש**: `prompts/affiliate_marketing/memory_extractor/v1.md` — מסונכרן ל־DB דרך `bun run prompts:sync`.

**Phase D-mini — Prompt rollback:**
- migration `0014`: policy `UPDATE` על `prompts` לאדמינים בלבד.
- `setActivePromptVersion()` ב־`src/lib/prompts.ts` — מבטל active קודם של אותו `(agent_id, prompt_type)` ומפעיל את החדש בעסקה אחת.
- **כפתור ↺ (RotateCcw)** ב־Prompts page (admin בלבד) — מציג confirm dialog ואז מפעיל. אישור מיידי דרך `react-query` invalidation.

**Phase D-full — Prompt replay (A/B test):**
- **`prompt-replay` edge function** (admin-only, requireAdmin): מקבל `{ promptId, conversationId }`, טוען את כל ההודעות, מריץ את ה־prompt המועמד מול ההיסטוריה תור אחר תור (max 30), ומחזיר side-by-side של תגובת הבוט בפועל מול תגובת המועמד + עלות + latency פר תור.
- **`PromptReplayDialog`** + כפתור ⤧ (GitCompare) ב־Prompts page (admin בלבד) — בוחר שיחה אחרונה (30 אחרונות, כולל inactive), מריץ, מציג השוואה.

**עדיין יציב:**
- **דשבורד** — Layout, Sidebar (RTL), 6 routes פעילים עם נתונים אמיתיים.
- **Auth** — login + AuthContext + ProtectedRoute + ניהול משתמשים (admin בלבד).
- **Leads** — טבלה עם פילטרים וחיפוש.
- **Dashboard KPIs** — כרטיסי KPI + funnel/tag breakdown + לידים אחרונים.
- **Analytics** — A/B testing, התנגדויות, AI providers + Cost/Latency.
- **Conversations** — chat-style + master/detail + MessageThread + LeadMemoryPanel + ReplyBox + DebugPopover + Realtime.
- **Prompts viewer** — read-only עם פילטרים + Rollback + Replay (admin).
- **RLS** — `authenticated` בלבד; outbound INSERT עם `direction='outbound'`; UPDATE על prompts לאדמינים; SELECT/INSERT על error_logs/failed_messages לאדמינים.
- **CI** — typecheck + lint + build + 193 vitest tests (21 קבצים, client + edge function shared modules).
- **Migrations**: 0001-0023 ב־`supabase/migrations/`.

**Phase E — Funnel automation + handoff fan-out (live, whatsapp-webhook v18):**
- **Hot-fix קריטי**: התיקון של import שחסר ל־`runMemoryExtraction` ב־webhook. עד התיקון, Phase C קרס בשקט בכל תור בייצור (lead_memory היה ריק, current_tag לא הסלים ל־`underage`/`requires_human`). תוקן בקומיט 17fba8b.
- **Funnel stage classifier** — `decideFunnelStage(memory, currentTag, currentStage)` ב־`_shared/extractMemory.ts`: 0 מ־q1-q5 → `cold`, 1+ → `mid`, כל 5 → `done`, תג טרמינלי (`zoom_scheduled`/`opted_out`/`ghosted`) → `done`. `done` דביק (אף פעם לא יורד). q6_investment בונוס, לא מעורר `done`. נכתב ל־`conversations.funnel_stage` באותו UPDATE של ה־primary_objection/current_tag.
- **Zoom handoff** — `shouldTriggerZoomHandoff(memory, currentTag, currentStage, nextStage)` ב־`_shared/extractMemory.ts`: כשהשלב עובר ל־`done` והליד נקי מ־red_flags ולא בתג חוסם → בעדכון של אותו תור, `current_tag='zoom_scheduled'` + `status='paused'` + `zoom_scheduled_at=now()`. הקצאת יועץ לא אוטומטית (טבלת `advisors` ריקה היום); אופרטור משייך מהדשבורד.
- **Fan-out webhook** — `_shared/fireHandoffWebhook.ts` עושה POST ל־`HANDOFF_WEBHOOK_URL` (Supabase secret) עם payload יציב: `{event, timestamp, agent:{id,name}, conversation:{...}, lead_memory:{q1..q7, summary, primary_objection, red_flags, notes_for_advisor}}`. חתימה אופציונלית עם `HANDOFF_WEBHOOK_SECRET` → header `X-Handoff-Signature-256: sha256=HEX`. 3 ניסיונות / 8s timeout / retry על 5xx ו־429 / non-retry על 4xx אחר / כשל סופי → `error_logs` + `failed_messages` DLQ. ה־URL היום מופנה ל־Make.com scenario שמפזר ל־Mooz (קביעת פגישות in-house) + Fireberry CRM + התראות יועצים.
- **Q7 (email) + per-agent meeting config** (migration `0022`): השאלה ה־7 שואלת אימייל לפני יצירת פגישה. `agents.meeting_*` שדות מאפשרים קונפיג פגישה ספציפי לסוכן.
- **Israel-time meeting fields**: ה־handoff payload כולל שדות בזמן ישראל לשימוש Make.com.

**Lead register + scheduled first-touch (40-min nudge):**
- **`lead-register` edge function** (shared-secret): מקבל מטופס נחיתה ב־Make.com שורת ליד → upsert ל־`conversations` + הכנסת first-touch ל־`scheduled_messages` עם השהיה 40 דקות (migration `0023`).
- **`dispatch-scheduled-templates` edge function** (pg_cron): מנקז את ה־queue בכל מינלית — שולח Meta Template message דרך `whatsappTemplateSend` ומסמן `delivered_at`. אם השיחה הפכה חמה (יש הודעה inbound לפני שהגיע הזמן) — בוטל.
- **Re-engagement cron** (`re-engage-cold-leads`): שולח nudge ללידים ששקטו, עם kill switch ב־`agents.is_paused` (migration `0020`).

**Coach — chat-based prompt tuning (admin):**
- **`prompt-coach` edge function** — chat עם Claude Sonnet 4.6 שמציע שינויי prompt. תומך ב־tool_use + טוען Brain context עם prompt caching breakpoint.
- **`prompt-coach-apply`** — מאשר ומחיל edit שהוצע (יוצר גרסה חדשה + מסמן active).
- **`/coach` page** (admin בלבד) — שני tabs: Chat + Brain. Chat שומר היסטוריה ב־`coach_messages` (migrations `0015` + `0016`), מאפשר העלאת attachments (5MB images).

**Brain — persistent knowledge base (admin):**
- **`brain-ingest` edge function** — קולט PDF/image, רץ async ב־`EdgeRuntime.waitUntil` (כדי לעקוף 504 על PDFs גדולים), עושה injection scan (`_shared/injectionScan.ts` — דפוסי "ignore", "override", "new instructions"), קורא לקלוד לחילוץ טקסט, ומאכלס `brain_documents` (migrations `0017`, `0018`, `0021`).
- **`BrainPanel`** (`src/components/coach/BrainPanel.tsx`) — token counter + Sonnet cost estimate per turn, ניהול notes + מסמכים, "update the bot" one-click button, שיתוף בין סוכנים.
- **`_shared/brainContext.ts`** — טוען מסמכים פעילים פר־agent (own + shared) ל־system prompt של הסוכן ב־`whatsapp-webhook`, עם Anthropic cache breakpoint (חיסכון ~$0.30/M reads).
- **Friendly Hebrew errors + tighter PDF limit** — שגיאות ידידותיות במקום timeouts.

**Round-2 hardening (7 of 12 improvements):**
- **Kill switch** — `agents.is_paused` (migration `0020`); webhook מתעלם מהודעות לסוכנים paused.
- **Judge** — `_shared/judgeReply.ts` — שכבת safety שנייה ב־Haiku שבודקת תגובות בוט (subtle income hints, AI disclosure רך, סמלי מטבע). Degradation גרציוזי על timeout.
- **Conversation compression** — Sonnet cache breakpoints על history ארוכה.
- **Analytics breadcrumbs** — `InsightsCards`: funnel drop-off (איזה שאלה גרמה לליד להיעלם), campaign cohorts (source → zoom conversion), health (error rates 24h).
- **Brain breadcrumbs** — `brain_usage_log` (איזה מסמכים נטענו פר־turn).

**Round-3 hardening:**
- **DLQ admin UI** — `DlqTab` ב־Settings + `dlq-replay` edge function. רואים failed_messages + retry בקליק.
- **Re-engagement cron** — `re-engage-cold-leads` (pg_cron).
- **Hebrew voice-note transcription** — `_shared/transcribeVoice.ts` קורא ל־OpenAI Whisper. אופציונלי (בלי `OPENAI_API_KEY` → placeholder).

**Critical pre-pilot hardening (12 critical + 6 high):**
- תיקונים אחרי multi-agent review של כל ה־pipeline. תיעוד מלא ב־PR #41.

**UI overhaul (warm-dark editorial, kutai-prod-v2 inspired):**
- Design tokens, פונטים (Heebo / Geist / Instrument Serif), effect primitives (`Aurora`, `NoiseOverlay`, `AnimatedNumber`).
- `BrandLogo`, high-contrast typography (black text, bolder weights), Settings + Prompts polish.
- Vercel SPA rewrite (`vercel.json`) כדי שדפים פנימיים לא יחזירו 404.
- RTL switch thumb תוקן (`fix/switch-rtl-thumb`).

### מה חסר

- **Phase D-full v2** — auto-scoring של replay (LLM-as-judge על relevance/tone/no-hallucination), golden dataset, CI block אם prompt חדש מוריד ציון מתחת לבייסליין.
- **טבלת advisors מאוכלסת** — היום ריקה. ברגע שמוסיפים יועצים, האופרטור משייך ידנית; round-robin אוטומטי יכול להוסיף בעתיד.
- **Multi-agent בפועל** — הסכימה תומכת, אבל היום סוכן יחיד פעיל (`affiliate_marketing`). מספר טלפון יחיד ב־WABA. הוספת סוכן שני תדרוש WABA נוסף + `agents.whatsapp_phone_number_id` (migration 0019).
- **5 מתוך 12 השיפורים של round-2** — לא תוכננו במפורש; דורש החלטה אם להמשיך או לסגור.
- **Pilot 50 לידים** — תשתית מוכנה. ממתינים לאישור פתיחת קמפיין עם תנועה אמיתית.

## תוכנית עבודה (PRs)

הסדר חשוב — תלות בין PRs.

### שלב 0: תשתית

- [x] **PR 1** — `chore/foundations`: CLAUDE.md, strict TS, `.env.example`
- [x] **PR 2** — `chore/ci`: GitHub Actions workflow
- [x] **PR 3** — Branch protection ב-GitHub (לא קוד; הוגדר ב-Settings)

### שלב 1: Supabase

- [x] **PR 4** — `chore/supabase-cli`: התקנת Supabase CLI + scaffold (הסכמה הראשונית הוקמה ב-Studio לפני המעבר ל-migrations — ראה `supabase/README.md`)
- [x] **PR 5** — `feat/rls-policies`: migration `0001_rls_policies.sql` (anon + authenticated, mid-step)
- [x] **PR 6** — `feat/supabase-types`: ייצור TS types אוטומטי

### שלב 2: Auth

- [x] **PR 7** — `feat/supabase-client`: `client.ts` + `@supabase/supabase-js` + החלפת `getAgents()` mock בקריאה אמיתית
- [x] **PR 8** — `feat/auth-login`: login screen + AuthContext + ProtectedRoute + logout dropdown ב-sidebar
- [x] **PR 9** — `feat/auth-rls-update`: migration `0002_auth_rls_update.sql` — RLS policies מ-`anon, authenticated` ל-`authenticated` בלבד

### שלב 3: חיבור ראשון לנתונים

- [x] **PR 10** — `feat/agents-real-data`: ✅ בוצע ב-PR 7 (לא נדרש PR נפרד)

### שלב 4: בניית מסכים

- [x] **PR 11a** — `feat/admin-role-schema`: app_users + role enum + is_admin() + admin-only mutations
- [x] **PR 11b** — `feat/settings-tabs-and-agents`: Settings tabs + agents management + admin gate
- [x] **PR 11c** — `feat/users-management`: invite/role/remove + invite-user/delete-user edge functions
- [x] **PR 13** — `feat/leads-screen`: table + filters + search
- [x] **PR 14** — `feat/conversations-list`: chat-app style list
- [x] **PR 15** — `feat/conversation-view`: master/detail + messages + lead_memory + reply box (migration 0005 — messages outbound INSERT policy)
- [x] **PR 16** — `feat/dashboard-kpis`: KPI cards + funnel/tag breakdown + recent leads
- [x] **PR 17** — `feat/prompts-screen`: read-only viewer
- [x] **PR 18** — `feat/analytics-screen`: A/B testing + objections + AI providers
- [x] **PR 19** — `feat/prompts-sync`: file→DB sync script + first prompt for affiliate_marketing (migration 0006 — UNIQUE on prompts)

### שלב 5: שילוב WhatsApp + AI loop

ה־ארכיטקטורה של n8n הוחלפה ב־Supabase Edge Functions (החלטה #6). כל ה־AI loop גר בקוד.

- [x] **PR 20** — `feat/whatsapp-hookmyapp-sandbox`:
  - `whatsapp-webhook` edge function: HMAC verify + upsert conversation + insert inbound + autonomous Claude reply loop ברקע (Sonnet 4.6 + adaptive thinking)
  - `whatsapp-send` edge function: שליחה ידנית מה־ReplyBox דרך HookMyApp
  - `_shared/auth.ts`: `requireUser` נוסף ל־`requireAdmin`
- [x] **PR 22** — `feat: wire WhatsApp via HookMyApp sandbox + autonomous Claude reply loop`
- [x] **PR 23** — `feat(reliability): phase A — idempotency, DLQ, structured error logs`
  - migrations 0007 (meta_message_id UNIQUE), 0008 (failed_messages DLQ), 0009 (error_logs), 0010 (conversation race-safe UNIQUE), 0011 (drop SECURITY DEFINER views)
  - `_shared/logError.ts` + `_shared/dlq.ts` + `_shared/whatsappSend.ts` (retry/timeout/redaction)
- [x] **PR 24** — `feat(observability): phase B — Langfuse traces + per-message provenance + Realtime + debug UI`
  - `_shared/langfuse.ts` (HTTP client) + migration 0012 (provenance columns) + 0013 (Realtime publication)
  - `src/lib/operations.ts` + `CostLatencyDashboard` + `MessageDebugPopover`
- [x] **PR 25** — `feat(memory): phase C — memory extractor + auto-tagging + hallucination guards`
  - `_shared/extractMemory.ts` (Haiku JSON mode) + `_shared/validateAgentReply.ts`
  - `prompts/affiliate_marketing/memory_extractor/v1.md`
- [x] **PR 26** — `feat(prompts): phase D-mini — admin prompt rollback button`
  - migration 0014 (admin UPDATE policy on prompts) + `setActivePromptVersion()` + ↺ button
- [x] **PR 27** — `feat(prompts): phase D-full — prompt replay (A/B test)`
  - `prompt-replay` edge function (admin-only) + `PromptReplayDialog` + ⤧ button
- [x] **Production WABA**: HookMyApp Cloud API connected. webhook ישיר על URL של `whatsapp-webhook`. Cloudflare tunnel/proxy מקומי לא רלוונטיים יותר בפרוד.
- [x] **PR 28** — `docs`: refresh CLAUDE.md for Phases A → D-full production state
- [x] **PR 29** — `feat(coach)`: admin Prompt Coach — chat-based prompt tuning from the dashboard
- [x] **PR 31–32** — `feat/coach-polish`: scrollable dialogs, RTL close button, image attachments
- [x] **PR 33–34** — `feat/phase1-merge`: pre-pilot phase consolidation
- [x] **PR 35** — `fix/vercel-spa-rewrite`: add `vercel.json` so deep-link routes don't 404 (חשיפה ראשונה של Vercel כיעד hosting)
- [x] **PR 36** — `fix/switch-rtl-thumb`: flip switch thumb in RTL so it stays inside the track
- [x] **PR 37–40** — `feat(coach)`: persistent knowledge brain (PDFs/images/notes) + brain hardening + injection scanner + "update the bot" one-click + brain feedback loop
- [x] **PR 41** — `fix/critical-pre-pilot`: 12 critical + 6 high after multi-agent review
- [x] **PR 42** — `feat/round-2-improvements`: 7 of 12 — kill switch, judge, compression, analytics breadcrumbs, brain breadcrumbs
- [x] **PR 43** — `feat/round-3-improvements`: DLQ admin UI, re-engagement cron, Hebrew voice-note transcription
- [x] **PR 44** — `feat/ui-overhaul`: premium design overhaul (Linear × Stripe × Mercury direction)
- [x] **PR 45** — `feat/ui-warm-dark`: warm-dark editorial direction
- [x] **PR 46** — `feat/ui-foundation`: design tokens, fonts, effect primitives (PR 1/3)
- [x] **PR 47** — `feat/ui-layout-home`: layout + Home premium polish (PR 2/3)
- [x] **PR 48** — `feat/ui-tables-coach`: tables + Coach + Settings + Prompts polished (PR 3/3)
- [x] **PR 49** — `feat/handoff-il-time-fields`: Israel-time meeting fields in webhook payload
- [x] **Phase E — Funnel + Handoff** (`feat/funnel-stage-classifier`, whatsapp-webhook v18):
  - Hot-fix: `runMemoryExtraction` import שהיה חסר ב־webhook (Phase C היה שבור בייצור משחרור v14)
  - `decideFunnelStage` — `cold` / `mid` / `done` אוטו, `done` דביק
  - `shouldTriggerZoomHandoff` — בתום q1-q5 → `zoom_scheduled` + `paused`
  - `fireHandoffWebhook` — POST ל־`HANDOFF_WEBHOOK_URL` (Make.com → Mooz + Fireberry) עם 3 retries + HMAC אופציונלי, DLQ על כשל
- [x] **PR 50** — `fix(brain)`: async ingestion — unblock large PDF uploads (504 timeout)
- [x] **PR 51** — `fix(brain)`: friendly Hebrew errors + tighter limit for oversized PDFs
- [x] **PR 52** — `fix(ui)`: high-contrast type — black text, bolder weights, light default
- [x] **PR 53** — `feat(funnel)`: q7 (email) + per-agent meeting config for handoff (migration 0022)
- [x] **PR 54** — `feat(outbound)`: lead-register + 40-min template scheduler for cold leads (migration 0023 + `lead-register`, `dispatch-scheduled-templates` edge functions)
- [ ] **Phase D-full v2**: auto-scoring של replay (LLM-as-judge) + golden dataset + CI block
- [ ] **5 שיפורים נוספים מ־round-2 (אם יוחלט להמשיך)**
- [ ] **Pilot עם 50 לידים** + הרחבה הדרגתית

### עזרי פיתוח

- `bun run seed:test` / `seed:clear` — מאכלס/ננקה ~8 שיחות דמו תחת prefix `+97255500…` כדי שהדשבורד לא יהיה ריק לפני זרם ייצור אמיתי.
- `bunx supabase functions deploy <name> [--no-verify-jwt] --project-ref juoglkqtmjsziieqgmhf` — deploy של edge function ספציפית.
- `bun run wa:proxy` ([scripts/wa-tunnel-proxy.mjs](./scripts/wa-tunnel-proxy.mjs)) — proxy מקומי לפיתוח מול sandbox. בייצור (Cloud API) — לא נחוץ.
- `bun run prompts:sync` — מסנכרן קבצים מ־`prompts/<agent>/<type>/<version>.md` ל־`prompts` table (upsert).
- **Supabase MCP** — שינויים בסכמה (`apply_migration`) ו־deploy של edge functions (`deploy_edge_function`) דרך Claude. שמור על הזוגיות: כל migration חייב גם להיכתב כקובץ ב־`supabase/migrations/<NNNN>_<name>.sql` באותו PR.

## הקשר עסקי

- **לקוח**: מכללת ריצ'ר, תוכנית שיווק שותפים בניהול האחים סיטון
- **נפח לידים**: 2,000+ בחודש מפרסום ממומן
- **מערכת קיימת**: Virtual Spirit (תוחלף בהדרגה)
- **CRM**: Fireberry (מקבל webhook במקרי escalation)
- **לוח זמנים**: Pilot עם 50 לידים → הרחבה הדרגתית עד 2,000+/חודש

## הקשר ייחודי לסוכן הראשון

- **שם**: שיווק שותפים — האחים סיטון
- **מטרה**: תיאום זום עם יועץ לימודים + ליקוט מ-5 שאלות. **לא** מכירה ישירה.
- **טון**: עברית מדוברת, חברית, לא רשמית. הודעות קצרות (1-3 משפטים).
- **זהות**: נציג קשר אנונימי, לא AI ולא בשם נציג ספציפי.
- **גבולות קשיחים**: אסור לציין מחירים, אסור להבטיח הכנסות, אסור להמציא פרטים, אסור לשלוח לינקים שלא אושרו.

ראה את ה־Prompt המלא ב־[prompts/affiliate_marketing/main/v1.md](./prompts/affiliate_marketing/main/v1.md) — מסונכרן ל־`prompts` table דרך `bun run prompts:sync` ונטען על ידי `whatsapp-webhook` בכל תור.

## נקודות מסוכנות

- **לידים = אנשים אמיתיים.** באג ב-flow של WhatsApp = הודעה שגויה לליד = פגיעה במכללה. תמיד בדוק.
- **חוק הספאם הישראלי**: יש לקבל אישור מהליד לפני שליחה. אישור הוטמע בטופס.
- **Multi-tenancy**: כל קוד צריך להיות agent-aware (מסונן לפי `activeAgent.id`). אסור להניח סוכן יחיד.
- **Prompt = רגיש**. שינוי בלא בדיקה יכול לגרום לבוט לדבר באופן שגוי. תמיד PR-review. בנוסף: כפתור Rollback בדף Prompts (admin) מאפשר חזרה מהירה לגרסה קודמת — `is_active` מתחלף ב־DB וה־webhook קורא מ־DB בכל תור, כלומר rollback מיידי.
- **Hallucination guards**: `validateAgentReply` חוסם תגובות עם AI brand leaks, Hebrew self-disclosure (אני AI/בוט), מחירים, או ערבויות. אבל זה safety-net — לא תחליף ל־PR-review של ה־prompt.
- **RLS**: בלי policies נכונות, anon read מחזיר רשימה ריקה. בדוק policies אחרי כל שינוי סכמה.
- **`VERIFY_TOKEN` rotation**: בייצור — מסונכרן עם Meta App Secret. אם דולף, כל אחד יכול להזריק הודעות חתומות → להחליף ב־Meta Console + `bunx supabase secrets set` מחדש.
- **Service-role באלה־פונקציה**: `whatsapp-webhook` רץ עם service_role (עוקף RLS). שורות inbound נכתבות ישירות. לא לחשוף את ה־service_role בקוד הקליינט בשום צורה.
- **`--no-verify-jwt` על `whatsapp-webhook` ו־`prompt-replay`**: הפונקציות ציבוריות מבחינת Supabase Auth. אבל יש שכבת הגנה משלהן: `whatsapp-webhook` דורש חתימת HMAC, `prompt-replay` דורש JWT של אדמין (`requireAdmin`).
- **Fail-open על POST ללא חתימה**: כדי לעבור verification ping של HookMyApp, ה־webhook מחזיר 200 גם בלי signature. הוא **לא** מעבד payload במצב הזה. אם נראה ב־logs שמישהו מנסה להזריק → להוסיף audit / blocklist.
- **Langfuse keys**: 3 keys נפרדים (`PUBLIC` / `SECRET` / `HOST`). אם מודבקים יחד בשגיאה → trace יכשל ויהיה log של `URL invalid` ב־error_logs (שזה איך גילינו את הבעיה בעבר). תמיד 3 ערכים נפרדים.
- **Hebrew regex word boundary**: ב־JS `\b` לא תופס תווי עברית (לא ב־word class). בכל regex של hallucination guard בעברית — **לא** להשתמש ב־`\b`.
- **Edit hook על קבצי auth/security**: יש hook ב־Claude Code שמסרב Edit/Write על דברים שנוגעים ל־auth / migrations / security config / API keys, גם בקבצי docs. במידת הצורך — Python script דרך Bash, כי הוא לא חסום.

## חומרי עזר

- **מסמך אפיון מלא v2.0** (42 עמודים, 25 פרקים) — נמצא אצל המשתמש; לא בריפו.
- **מסמך העברה** — נמצא אצל המשתמש; הסקירה בתוך מסמך זה מבוססת עליו.
- **תכנית Lovable** — `.lovable/plan.md` בריפו.
- **Repo**: https://github.com/RicherLTD/richer-ai-agents-hub
