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
┌─────────────────────────────────────────────────┐
│  WhatsApp BSP (360dialog/Wati)                  │
│       ↕ webhook                                 │
│  n8n Cloud — workflows                          │
│       ↕ DB queries / writes                     │
│  Supabase (DB + Auth + Storage)                 │
│       ↑ reads + writes                          │
│  Dashboard (this repo) — Lovable hosted         │
└─────────────────────────────────────────────────┘
```

## ההחלטות הארכיטקטוניות (10)

| # | תחום | החלטה |
|---|---|---|
| 1 | מי כותב קוד | **רק Claude Code.** Lovable נשאר מחובר ל-git אבל לא כותב. |
| 2 | אירוח Production | **Lovable** — אוטו-deploy מ-`main`. |
| 3 | זרימת קוד | **Feature branches → PR → merge ל-main.** Preview מקומי עם `bun dev`. |
| 4 | סכמת Supabase | **Migrations בריפו** (`supabase/migrations/`). אין עריכה ידנית ב-Studio. |
| 5 | Prompts | **קבצים בריפו → סנכרון אוטומטי** לטבלת `prompts` ב-Supabase. |
| 6 | n8n workflows | **חיים ב-n8n cloud, גיבוי אוטומטי יומי ל-git** ב-`workflows/`. |
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
- **AI**: Claude Sonnet 4.5 (primary), GPT-4o (fallback), Whisper (audio)
- **Orchestration**: n8n Cloud (מחוץ לריפו)
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
│   └── seed.sql            # seed data לפיתוח
├── prompts/                # Prompts שמסונכרנים לטבלת prompts ב-Supabase
│   └── affiliate_marketing/
├── workflows/              # backup של n8n workflows (גיבוי אוטומטי יומי)
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

### n8n

- ה-workflows חיים ב-n8n cloud. עורכים שם.
- גיבוי אוטומטי יומי ל-`workflows/` בריפו.
- Debugging — מצא את הגרסה האחרונה בגיבוי.

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

ראה `.env.example`. דרוש:

- `VITE_SUPABASE_URL` — URL של פרויקט Supabase
- `VITE_SUPABASE_ANON_KEY` — anon key (בטוח להיות בקוד client-side)

**אסור** לשים `service_role` key ב-client-side. הוא רק לסקריפטים שרצים בצד שרת (למשל סקריפט סנכרון Prompts).

## מצב נוכחי

### מה קיים ועובד

- שלד דשבורד מלא: Layout, Sidebar (RTL ימין), Header, Agent Selector, 6 routes
- `AgentContext` קורא סוכנים מ-Supabase (לא mock) — `src/lib/agents.ts`
- Supabase client + types שמיוצרים אוטומטית מהסכמה
- Auth מלא: login screen + AuthContext + ProtectedRoute + logout מה-sidebar
- RLS תוחם ל-`authenticated` בלבד (migration `0002_auth_rls_update.sql`)
- RTL נכון, Heebo, design tokens של ריצ'ר (#451470)
- CI: typecheck + lint + build על כל PR
- vitest setup (אבל ללא טסטים אמיתיים — רק `example.test.ts`)
- Hot Module Reload דרך Vite

### מה חסר

- כל המסכים האמיתיים (כרגע EmptyState עבור 6 הדפים)
- ניהול סוכנים ומשתמשים (Settings)
- Prompts (קיימת טבלה ב-Supabase אבל ריקה)
- n8n workflows (לא קיימים עדיין)
- WhatsApp BSP (לא מחובר)
- היסטוריית commits לא מסודרת (Lovable השאיר commits עם הודעה "Changes")

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

### שלב 4: בניית מסכים ⬅ אנחנו פה

- [ ] **PR 11** — `feat/agents-management`: ניהול סוכנים (תחת /settings)
- [ ] **PR 12** — `feat/users-management`: ניהול משתמשים (תחת /settings)
- [ ] **PR 13** — `feat/leads-screen`
- [ ] **PR 14** — `feat/conversations-list`
- [ ] **PR 15** — `feat/conversation-view`: שיחה ספציפית + סיכום AI + 5 שאלות
- [ ] **PR 16** — `feat/dashboard-kpis`: דף הבית עם מטריקות
- [ ] **PR 17** — `feat/prompts-screen`: ניהול prompts + גרסאות
- [ ] **PR 18** — `feat/analytics-screen`: A/B testing + התפלגות התנגדויות

### שלב 5: שילוב

- [ ] n8n workflows (מחוץ לריפו, ב-n8n cloud)
- [ ] סקריפט גיבוי n8n → git
- [ ] WhatsApp BSP (360dialog/Wati)
- [ ] Pilot עם 50 לידים

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

ראה את ה-Prompt המלא ב-`prompts/affiliate_marketing/v1.md` (כשייווצר).

## נקודות מסוכנות

- **לידים = אנשים אמיתיים.** באג ב-flow של WhatsApp = הודעה שגויה לליד = פגיעה במכללה. תמיד בדוק.
- **חוק הספאם הישראלי**: יש לקבל אישור מהליד לפני שליחה. אישור הוטמע בטופס.
- **Multi-tenancy**: כל קוד צריך להיות agent-aware (מסונן לפי `activeAgent.id`). אסור להניח סוכן יחיד.
- **Prompt = רגיש**. שינוי בלא בדיקה יכול לגרום לבוט לדבר באופן שגוי. תמיד PR-review.
- **RLS**: בלי policies נכונות, anon read מחזיר רשימה ריקה. בדוק policies אחרי כל שינוי סכמה.

## חומרי עזר

- **מסמך אפיון מלא v2.0** (42 עמודים, 25 פרקים) — נמצא אצל המשתמש; לא בריפו.
- **מסמך העברה** — נמצא אצל המשתמש; הסקירה בתוך מסמך זה מבוססת עליו.
- **תכנית Lovable** — `.lovable/plan.md` בריפו.
- **Repo**: https://github.com/RicherLTD/richer-ai-agents-hub
