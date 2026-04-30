# CLAUDE.md

> מסמך זה הוא ה-source of truth לכל שיחת Claude Code על הפרויקט. כל החלטה ארכיטקטונית, הסבר מצב, וכלל עבודה — כתובים פה. עדכן אותו כשמשתנה משהו מבני.

## סקירת הפרויקט

**מערכת WhatsApp AI למכללת ריצ'ר** — דשבורד ניהול לסוכני AI שמטפלים בלידים בוואטסאפ.

הפרויקט הוא ארכיטקטורת **Multi-Agent**: מערכת אחת תומכת במספר סוכנים נפרדים, כל אחד עם מספר WhatsApp נפרד וקונפיגורציה משלו, על תשתית טכנית משותפת.

- **סוכן ראשון**: שיווק שותפים — האחים סיטון
- **סוכנים עתידיים**: שיווק דיגיטלי, AI, וידאו, נדל"ן

הריפו הזה הוא **דשבורד הניהול בלבד**. הריצה בפועל של הבוט היא ב-n8n + Supabase + Claude API + WhatsApp BSP — מחוץ לריפו.

## ארכיטקטורה כללית

```
WhatsApp user
     ↕
Meta Cloud API
     ↕  webhook (signed HMAC)
HookMyApp forwarder
     ↕  sandbox: Cloudflare tunnel → localhost proxy → deployed function
     ↕  production: direct HTTPS → deployed function
Supabase Edge Functions (whatsapp-webhook + whatsapp-send)
     │  whatsapp-webhook = inbound + autonomous Claude reply loop (background)
     │  whatsapp-send    = human takeover from the dashboard ReplyBox
     ↕  service_role
Supabase Postgres
     │  conversations · messages · lead_memory · prompts · agents · advisors
     ↑  reads + outbound inserts (RLS-gated)
Dashboard (this repo) — Lovable hosted
```

**WhatsApp pipeline (current sandbox setup):** ה־`whatsapp-webhook` edge function ([supabase/functions/whatsapp-webhook/index.ts](./supabase/functions/whatsapp-webhook/index.ts)) מאמת את חתימת ה־HMAC של HookMyApp, מבצע upsert ל־conversation, רושם הודעת inbound, ואז מפעיל ברקע (`EdgeRuntime.waitUntil`) קריאה ל־Claude Sonnet 4.6 שמייצרת תגובה לפי ה־prompt הפעיל וההיסטוריה — ושולחת אותה חזרה ל־HookMyApp + רושמת ב־DB. ה־`whatsapp-send` ([supabase/functions/whatsapp-send/index.ts](./supabase/functions/whatsapp-send/index.ts)) מאפשר לאדם להשתלט מה־ReplyBox בדשבורד ולשלוח הודעה ידנית.

## ההחלטות הארכיטקטוניות (10)

| # | תחום | החלטה |
|---|---|---|
| 1 | מי כותב קוד | **רק Claude Code.** Lovable נשאר מחובר ל-git אבל לא כותב. |
| 2 | אירוח Production | **Lovable** — אוטו-deploy מ-`main`. |
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
- **State**: React Context + `@tanstack/react-query`
- **Forms**: react-hook-form + zod
- **DB / Auth**: Supabase (Postgres + Auth + Storage)
- **AI**: Claude Sonnet 4.6 (primary, adaptive thinking), GPT-4o (fallback), Whisper (audio)
- **Orchestration / AI loop**: Supabase Edge Functions (Deno) — `whatsapp-webhook` (autonomous Claude reply loop) + `whatsapp-send` (human takeover)
- **WhatsApp BSP (sandbox)**: HookMyApp — webhook נכנס דרך Cloudflare tunnel → proxy מקומי → edge function פרוסה. עובר ל־production WABA בעתיד דרך `hookmyapp channels connect`.
- **Hosting**: Lovable (`*.lovable.app`)
- **Package Manager**: bun (`~/.bun/bin/bun`)
- **Testing**: vitest + @testing-library/react

## מבנה תיקיות

```
.
├── .github/workflows/      # GitHub Actions (CI)
├── public/                 # static assets
├── src/
│   ├── components/
│   │   ├── layout/         # AppLayout, AppSidebar, AppHeader, AgentSelector
│   │   ├── ui/             # shadcn primitives
│   │   ├── EmptyState.tsx
│   │   └── NavLink.tsx
│   ├── contexts/
│   │   └── AgentContext.tsx
│   ├── hooks/
│   ├── lib/
│   │   ├── supabase/       # client.ts, queries/* (יבנה בקרוב)
│   │   ├── agents.ts       # data source (כרגע mock; בקרוב Supabase)
│   │   └── utils.ts
│   ├── pages/              # 6 דפים (Index, Leads, Conversations, Analytics, Prompts, Settings)
│   ├── types/              # TypeScript types — יוחלף ב-types שמיוצרים מ-Supabase
│   └── test/               # vitest setup
├── supabase/
│   ├── migrations/         # SQL migrations (source of truth של הסכמה)
│   ├── functions/          # Deno edge functions
│   │   ├── _shared/        # auth.ts (requireUser/requireAdmin) + cors.ts
│   │   ├── invite-user/    # admin: invite by email
│   │   ├── delete-user/    # admin: hard-delete auth user
│   │   ├── whatsapp-webhook/  # public: HookMyApp inbound + autonomous Claude reply loop
│   │   └── whatsapp-send/  # auth: send outbound via HookMyApp (dashboard ReplyBox)
│   └── README.md           # supabase project ref + migration workflow
├── scripts/                # bun-run scripts: db:apply, prompts:sync, seed:test
├── prompts/                # Prompts שמסונכרנים לטבלת prompts ב-Supabase
│   └── affiliate_marketing/
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
- Deploy: `bun run fn:deploy <name> --project-ref juoglkqtmjsziieqgmhf`. ה־`whatsapp-webhook` חייב `--no-verify-jwt` כי HookMyApp לא שולח JWT — הוא מאמת חתימת HMAC בעצמו.
- סודות נדחפים ל־Supabase דרך `bunx supabase secrets set --env-file <path>`. ה־`SUPABASE_*` מוזרקים אוטומטית.
- ראה [supabase/functions/README.md](./supabase/functions/README.md) לפירוט הפונקציות, ה־secrets, וזרימת ה־HookMyApp sandbox.
- האגנט הראשי (Claude reply loop) רץ ב־`whatsapp-webhook` כ־background task דרך `EdgeRuntime.waitUntil` — ה־webhook מחזיר 200 מיד ל־HookMyApp ואז מייצר את התגובה ברקע. אין n8n.

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
- `VERIFY_TOKEN` — HMAC של סשן הסנדבוקס של HookMyApp
- `WHATSAPP_API_URL`, `WHATSAPP_ACCESS_TOKEN`, `WHATSAPP_PHONE_NUMBER_ID` — endpoint + auth של HookMyApp (sandbox: `https://sandbox.hookmyapp.com/v22.0`; production: `https://graph.facebook.com/v22.0`)
- `HOOKMYAPP_AGENT_NAME` — slug ב־`agents.name` שאליו ייוחסו לידים נכנסים (סנדבוקס = סוכן יחיד)
- `ANTHROPIC_API_KEY` — `sk-ant-...`. בלעדיו לולאת התגובה האוטומטית מושבתת בעדינות (הודעות נכנסות עדיין נכנסות ל־DB).

מסלול עדכון אופייני (סנדבוקס):
```bash
hookmyapp sandbox env --write .env.functions.local
echo "HOOKMYAPP_AGENT_NAME=affiliate_marketing" >> .env.functions.local
echo "ANTHROPIC_API_KEY=sk-ant-..."             >> .env.functions.local
bunx supabase secrets set --env-file .env.functions.local --project-ref juoglkqtmjsziieqgmhf
```

**אסור** לשים `service_role` key ב-client-side. הוא רק לסקריפטים שרצים בצד שרת (למשל סקריפט סנכרון Prompts).

## מצב נוכחי

### מה קיים ועובד

- **דשבורד**: Layout, Sidebar (RTL ימין), Header, Agent Selector, 6 routes (Index/Leads/Conversations/Analytics/Prompts/Settings) - כולם פעילים עם נתונים אמיתיים מ־Supabase, לא EmptyStates
- **Auth**: login screen + AuthContext + ProtectedRoute + logout מה־sidebar; ניהול משתמשים מ־Settings (admin בלבד)
- **Conversations**: רשימה chat-style + master/detail + MessageThread + LeadMemoryPanel + ReplyBox (מחובר ל־`whatsapp-send` edge function)
- **Leads**: טבלה עם פילטרים וחיפוש
- **Dashboard KPIs**: כרטיסי KPI + funnel/tag breakdown + lidim אחרונים
- **Prompts viewer**: read-only עם פילטרים; sync מ־`prompts/<agent>/<type>/<version>.md` ל־`prompts` table
- **Analytics**: A/B testing, התנגדויות, AI providers
- **Edge Functions** (פרוסות ב־Supabase):
  - `invite-user`, `delete-user` — admin user management
  - `whatsapp-webhook` — קבלת webhook חתום מ־HookMyApp + לולאת תגובה אוטומטית של Claude (ברקע דרך `EdgeRuntime.waitUntil`)
  - `whatsapp-send` — proxy לשליחה ידנית מה־ReplyBox
- **HookMyApp sandbox**: tunnel חי (Cloudflare → proxy מקומי `/tmp/wa-tunnel-proxy.mjs` → edge function פרוסה). זרימה דו־כיוונית מאומתת end-to-end.
- **AI**: Claude Sonnet 4.6 + adaptive thinking, system = ה־prompt הפעיל מ־`prompts` table, history = 30 הודעות אחרונות
- **RLS**: תוחם ל־`authenticated` בלבד; outbound INSERT מותר רק עם `direction='outbound'`. inbound נכתבים דרך service_role בתוך ה־edge function.
- **CI**: typecheck + lint + build על כל PR; vitest על queries/contexts/auth/KPIs (61 טסטים)
- **Migrations**: 0001-0006 ב־`supabase/migrations/`
- **Migrations + types sync**: `bun run db:apply` (Management API, ללא Docker) + `bun run db:types` (auto-gen)

### מה חסר

- **Memory extractor** — קריאת Claude שנייה אחרי כל תור שמחלצת `q1_age`...`q6_investment`, `conversation_summary`, `primary_objection` ומעדכנת `lead_memory`. (תוכנן כ־Piece 2 בשלב 5.)
- **Funnel/tag classifier אוטומטי** — היום `funnel_stage` ו־`current_tag` מתעדכנים ידנית או דרך seed; הסוכן עדיין לא מזיז אותם בעצמו.
- **Zoom handoff** — הסוכן עדיין לא מסיים שיחה עם הודעת מסירה ומעבר ל־`status='paused'`.
- **Calendar/Zoom integration** — Google Calendar API או Calendly. הסכימה כבר תומכת (`advisors.google_calendar_email`, `advisors.calendly_link`).
- **Fireberry CRM** — webhook על escalation/zoom_scheduled. הסכימה תומכת (`advisors.fireberry_user_id`).
- **Idempotency על inbound** — אין `meta_message_id UNIQUE` עדיין; אם Meta יעשה retry על אותה הודעה, היא תוכפל ב־DB.
- **Realtime updates בדשבורד** — נדרש refresh ידני; Supabase Realtime על `messages` יוסיף הופעה מיידית.
- **Production WABA** — היום בסנדבוקס בלבד (טלפון יחיד מוצמד צד־שרת). מעבר דרך `hookmyapp channels connect`.
- **Docker / supabase functions serve** — אין Docker מקומית, אז ה־edge functions רצות רק בפרודקשן + proxy מקומי משלים את ה־tunnel. ניתן להחליף אם תותקן Docker.
- **Multi-agent בפועל** — הסכימה תומכת אבל היום סוכן יחיד פעיל (`affiliate_marketing`). בסנדבוקס יש רק טלפון אחד אז אין דרך לבחון כפילות.

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

### שלב 5: שילוב WhatsApp + AI loop ⬅ אנחנו פה

ה־ארכיטקטורה של n8n הוחלפה ב־Supabase Edge Functions (החלטה #6). כל ה־AI loop גר בקוד.

- [x] **PR 20** — `feat/whatsapp-hookmyapp-sandbox` (לא ממוזג עדיין):
  - `whatsapp-webhook` edge function: HMAC verify + upsert conversation + insert inbound + autonomous Claude reply loop ברקע (Sonnet 4.6 + adaptive thinking)
  - `whatsapp-send` edge function: שליחה ידנית מה־ReplyBox דרך HookMyApp (החלפת ה־insert הישיר)
  - `_shared/auth.ts`: `requireUser` נוסף ל־`requireAdmin`
  - HookMyApp sandbox מאומת end-to-end (ראה `supabase/functions/README.md`)
- [ ] **Piece 2** — Memory extractor: קריאת Claude שנייה (JSON mode) שממלאת `lead_memory.q1..q6 + summary + tags + funnel_stage` אחרי כל תור
- [ ] **Piece 3** — Zoom handoff placeholder: כשכל 5 השאלות נענו והליד מתאים → הודעת מסירה + `current_tag='zoom_scheduled'` + `assigned_advisor_id` + `status='paused'`
- [ ] **Idempotency**: migration להוספת `meta_message_id UNIQUE` ל־`messages`
- [ ] **Realtime**: Supabase channel על `messages` בדשבורד ConversationDetail
- [ ] **Production WABA**: `hookmyapp channels connect`, החלפת ערכי `WHATSAPP_*`, רישום webhook ישיר על URL הפונקציה הפרוסה (בלי Cloudflare tunnel/proxy)
- [ ] **Google Calendar / Calendly**: יצירת event אוטומטית כשהליד מגיע ל־`zoom_scheduled`
- [ ] **Fireberry CRM**: webhook על escalation/zoom_scheduled
- [ ] **Pilot עם 50 לידים** + הרחבה הדרגתית

### עזרי פיתוח

- `bun run seed:test` / `seed:clear` — מאכלס/ננקה ~8 שיחות דמו תחת prefix `+97255500…` כדי שהדשבורד לא יהיה ריק לפני זרם ייצור אמיתי.
- `bunx supabase functions deploy <name> [--no-verify-jwt] --project-ref juoglkqtmjsziieqgmhf` — deploy של edge function ספציפית.
- `/tmp/wa-tunnel-proxy.mjs` — proxy מקומי קטן (Bun) שמעביר מ־`localhost:54321` ל־URL הפונקציה הפרוסה. דרוש בסנדבוקס כי `hookmyapp sandbox listen` תמיד מ־tunnel ל־localhost. כשתותקן Docker או נעבור לפרוד — לא נחוץ.

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
- **Prompt = רגיש**. שינוי בלא בדיקה יכול לגרום לבוט לדבר באופן שגוי. תמיד PR-review.
- **RLS**: בלי policies נכונות, anon read מחזיר רשימה ריקה. בדוק policies אחרי כל שינוי סכמה.
- **Sandbox session rotation**: ה־`VERIFY_TOKEN` של HookMyApp sandbox מתחלף כשסשן מתחדש. אחרי `hookmyapp sandbox start` חדש — `bunx supabase secrets set --env-file .env.functions.local` מחדש, אחרת חתימות יידחו עם 401.
- **Idempotency חסר**: אם Meta יעשה retry על אותה הודעה לפני שנוסיף `meta_message_id UNIQUE`, היא תוכפל ב־DB ויגרום לתגובה כפולה של הבוט. לא קריטי בנפח סנדבוקס; חובה לפני production.
- **Service-role באלה־פונקציה**: `whatsapp-webhook` רץ עם service_role (עוקף RLS). שורות inbound נכתבות ישירות. לא לחשוף את ה־service_role בקוד הקליינט בשום צורה.
- **`--no-verify-jwt` על `whatsapp-webhook`**: הפונקציה ציבורית. ההגנה היחידה היא חתימת HMAC. אם ה־`VERIFY_TOKEN` דולף, כל אחד יכול להזריק הודעות. ל־rotation: `hookmyapp sandbox start` חדש או `hookmyapp webhook set <waba-id> --verify-token <new>` בפרוד.

## חומרי עזר

- **מסמך אפיון מלא v2.0** (42 עמודים, 25 פרקים) — נמצא אצל המשתמש; לא בריפו.
- **מסמך העברה** — נמצא אצל המשתמש; הסקירה בתוך מסמך זה מבוססת עליו.
- **תכנית Lovable** — `.lovable/plan.md` בריפו.
- **Repo**: https://github.com/RicherLTD/richer-ai-agents-hub
