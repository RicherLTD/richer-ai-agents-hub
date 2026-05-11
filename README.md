# Richer AI Agents Hub

ניהול דשבורד לסוכני AI שמטפלים בלידים בוואטסאפ עבור מכללת ריצ'ר. ארכיטקטורת multi-agent — מערכת אחת תומכת במספר סוכנים נפרדים, כל אחד עם מספר WhatsApp נפרד וקונפיגורציה משלו, על תשתית טכנית משותפת. סוכן ראשון פעיל: שיווק שותפים — האחים סיטון.

> **מסמך source-of-truth מלא:** [CLAUDE.md](./CLAUDE.md). שם הארכיטקטורה, ההחלטות, כללי העבודה, ותוכנית ה־PRs. מי שמגיע לריפו הזה — להתחיל משם.

## Stack

- **Frontend**: Vite + React 18 + TypeScript (strict), shadcn/ui + Tailwind, RTL מלא
- **DB / Auth**: Supabase (Postgres + Auth + Storage), RLS מאופשר על כל טבלת לידים
- **AI loop**: Supabase Edge Functions (Deno) + Anthropic SDK — Claude Sonnet 4.6 + adaptive thinking
- **WhatsApp**: HookMyApp (sandbox היום, production WABA דרך Meta בעתיד)
- **Hosting**: Lovable (`*.lovable.app`) — auto-deploy מ־`main`
- **Package manager**: bun

## ארכיטקטורה בקצרה

```
WhatsApp ↔ Meta ↔ HookMyApp ↔ tunnel/HTTPS ↔ Supabase Edge Functions ↔ Postgres ↔ Dashboard
```

- `whatsapp-webhook` — מקבל webhook חתום מ־HookMyApp, רושם הודעה נכנסת, ומפעיל ברקע (`EdgeRuntime.waitUntil`) קריאה ל־Claude שמייצרת תגובה אוטומטית לפי ה־prompt הפעיל וההיסטוריה.
- `whatsapp-send` — מאפשר השתלטות אנושית מה־ReplyBox בדשבורד (מצריך JWT של משתמש מחובר).
- בעבר תוכנן n8n לשכבת ה־orchestration — הוחלף ב־edge functions (החלטה ארכיטקטונית #6 ב־CLAUDE.md).

פרטי ה־edge functions, ה־secrets, וזרימת הסנדבוקס: [supabase/functions/README.md](./supabase/functions/README.md).

## הרצה מקומית

```bash
# Setup ראשון (פעם אחת)
git clone https://github.com/RicherLTD/richer-ai-agents-hub.git
cd richer-ai-agents-hub
~/.bun/bin/bun install
cp .env.example .env.local   # מלא ערכים פרטיים אם צריך
bunx supabase login          # פעם אחת למחשב
bunx supabase link --project-ref juoglkqtmjsziieqgmhf

# יומיומי
bun run dev      # http://localhost:8080
bun run lint
bun run test
bun run build
```

מבנה התיקיות, מסלולי ה־migrations, ה־prompts sync, ופקודות ה־seed: ראה [CLAUDE.md → מבנה תיקיות](./CLAUDE.md#מבנה-תיקיות).

## Branches & PRs

- `main` = production. **Branch protection אוסר push ישיר.**
- `feat/<desc>`, `fix/<desc>`, `chore/<desc>`. PR title באנגלית, conventional commits.
- כל PR מריץ CI: typecheck + lint + build. חייב להיות ירוק לפני merge.

## רישיון

ראה [LICENSE](./LICENSE).
