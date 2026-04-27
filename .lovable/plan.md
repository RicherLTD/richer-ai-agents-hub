# שלד מערכת ניהול WhatsApp AI — מכללת ריצ'ר

מערכת Multi-Agent בעברית RTL עם Sidebar, בחירת סוכן גלובלית, ו-6 מסכי ניווט. כל המסכים יציגו Empty State בלבד בשלב זה — ללא נתונים מזויפים.

## עיצוב ומיתוג

- **שפה וכיוון:** עברית מלאה, `dir="rtl"` על `<html>`, פונט **Heebo** מ-Google Fonts.
- **פלטת צבעים** (מוגדרת כ-HSL ב-`index.css` כ-design tokens):
  - Primary: `#451470` (סגול עמוק ריצ'ר)
  - Primary Deep: `#2D0E4A`
  - Primary Light: `#7A4FA8`
  - רקע ראשי: `#FFFFFF`, רקע משני: `#F9FAFB`
  - גבולות וטקסט מושתק בגווני אפור עדינים
- **סגנון:** מינימליסטי בסגנון Notion/Linear — `rounded-lg`, צללים עדינים, מרווחים אווריריים, מעברים חלקים.
- כל הצבעים יוגדרו כ-CSS variables ב-`index.css` ויחוברו ל-`tailwind.config.ts` — **ללא** צבעים hardcoded בקומפוננטות.

## Layout ראשי

```text
┌─────────────────────────────────────────────────────┬──────────────┐
│  Header: כותרת מסך | חיפוש | Agent Badge | 🔔     │   לוגו ריצ'ר │
│                                                     │   AI מערכת   │
├─────────────────────────────────────────────────────┤              │
│                                                     │ ▼ סוכן פעיל  │
│                                                     │ שיווק שותפים │
│              אזור התוכן הראשי                       │              │
│              (Empty States)                         │ 🏠 דף הבית   │
│                                                     │ 👥 לידים     │
│                                                     │ 💬 שיחות     │
│                                                     │ 📊 ניתוחים   │
│                                                     │ 📄 Prompts   │
│                                                     │ ⚙ הגדרות     │
│                                                     ├──────────────┤
│                                                     │ 👤 משתמש     │
└─────────────────────────────────────────────────────┴──────────────┘
                                                            ימין →
```

### Sidebar (בצד ימין, RTL)
- **ראש:** לוגו עגול בצבע primary + טקסט "מערכת ריצ'ר AI".
- **Agent Selector:** רכיב Select בולט (shadcn) שמציג את הסוכן הפעיל, עם אפשרות החלפה. כרגע יציג סוכן אחד "שיווק שותפים — האחים סיטון" + אופציה "+ הוסף סוכן חדש" (מנוטרלת/מציגה toast "בקרוב").
- **תפריט ניווט** (6 פריטים, מודגש פריט פעיל בצבע primary):
  1. דף הבית — `Home`
  2. לידים — `Users`
  3. שיחות פעילות — `MessageCircle`
  4. ניתוחים — `BarChart3`
  5. ניהול Prompts — `FileText`
  6. הגדרות — `Settings`
- **תחתית:** Avatar + שם משתמש placeholder ("מנהל מערכת").
- ניתן לקיפול (collapsible icon mode) עם trigger גלוי תמיד ב-Header.

### Header עליון
- כותרת המסך הנוכחי (h1 גדול).
- Input חיפוש (placeholder בלבד, ללא לוגיקה).
- Badge: "מטפל בסוכן: {שם הסוכן הפעיל}" — מתעדכן לפי הסוכן הנבחר.
- אייקון `Bell` להתראות (ללא לוגיקה).

## ניהול מצב — AgentContext

- `AgentContext` גלובלי שיחזיק:
  - `agents: Agent[]` — רשימת כל הסוכנים הזמינים
  - `activeAgent: Agent | null` — הסוכן הנבחר
  - `setActiveAgent(id)` — פונקציית החלפה
- בשלב זה הרשימה תאוכלס ממקור סטטי יחיד (סוכן "שיווק שותפים") עם המבנה המלא של טבלת `agents` כדי שהמעבר ל-Supabase יהיה החלפה של מקור הנתונים בלבד.
- הבחירה הפעילה תישמר ב-`localStorage` כדי לשרוד רענון.
- **כל מסך יקבל את `activeAgent` מה-Context** וישמש אותו לטעינת נתונים בעתיד.

## מסכים (6)

כל מסך יהיה דף נפרד עם:
- כותרת המסך (מועברת ל-Header).
- Empty State במרכז: אייקון רלוונטי גדול + הכיתוב **"מסך זה ייבנה בשלב הבא של הפיתוח"** + תת-טקסט: "הנתונים יוצגו עבור הסוכן: {activeAgent.display_name}".

נתיבים:
- `/` → Dashboard
- `/leads` → לידים
- `/conversations` → שיחות פעילות
- `/analytics` → ניתוחים
- `/prompts` → ניהול Prompts
- `/settings` → הגדרות

## הכנה ל-Supabase (ללא חיבור עכשיו)

- מבנה הטיפוס `Agent` ב-TypeScript יתאים 1:1 לטבלת `agents` שתיארת (id, name, display_name, description, brand_color, status, primary_goal, product_info, whatsapp_number, source_funnels).
- שכבת data-source מבודדת (`src/lib/agents.ts`) שמחזירה את הסוכנים — בעתיד תוחלף בקריאת Supabase ללא שינוי בקומפוננטות.
- **לא** מתבצע חיבור ל-Lovable Cloud / Supabase כעת — רק כשתספק credentials או תאשר הפעלה.

## מבנה קבצים

```text
src/
├── contexts/AgentContext.tsx        # Provider + hook useAgent()
├── lib/agents.ts                    # מקור נתוני סוכנים (sttic → Supabase בעתיד)
├── types/agent.ts                   # טיפוס Agent
├── components/
│   ├── layout/
│   │   ├── AppLayout.tsx            # Layout עם Sidebar + Header + Outlet
│   │   ├── AppSidebar.tsx           # Sidebar RTL עם ניווט
│   │   ├── AgentSelector.tsx        # ה-dropdown של בחירת סוכן
│   │   └── AppHeader.tsx            # Header עליון עם Badge + חיפוש
│   └── EmptyState.tsx               # Empty state גנרי לשימוש חוזר
├── pages/
│   ├── Dashboard.tsx
│   ├── Leads.tsx
│   ├── Conversations.tsx
│   ├── Analytics.tsx
│   ├── Prompts.tsx
│   └── Settings.tsx
├── App.tsx                          # Routes עטופים ב-AgentProvider + AppLayout
├── index.css                        # design tokens (HSL) + Heebo + RTL
└── tailwind.config.ts               # mapping לטוקנים
```

## פרטים טכניים

- **RTL:** `dir="rtl"` ב-`index.html`, ושימוש בכיווני logical של Tailwind (`ms-`/`me-` במידת הצורך) — Sidebar של shadcn תומך RTL ויוגדר `side="right"`.
- **Routing:** `react-router-dom` קיים. כל ה-Routes יעטפו ב-`<AppLayout>` שמשתמש ב-`<Outlet />`.
- **shadcn:** Sidebar, Select, Button, Badge, Input, Avatar — כולם כבר קיימים בפרויקט.
- **State management:** Context API מספיק לצורך הזה (אין צורך ב-Zustand בשלד הראשוני; קל להחליף בעתיד).
- **Auth:** אין כעת — לפי בקשתך login פשוט יתווסף בהמשך.

## מה לא בתכולה (לפי דרישתך)

- אין נתונים מזויפים, אין לוגיקה עסקית, אין auth, אין חיבור פעיל ל-Supabase.
- מסך הוספת סוכן יוצג כ-CTA בלבד (placeholder).
