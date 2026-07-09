# CLAUDE.md

> מסמך זה הוא ה-source of truth לכל שיחת Claude Code על הפרויקט. כל החלטה ארכיטקטונית, הסבר מצב, וכלל עבודה — כתובים פה. עדכן אותו כשמשתנה משהו מבני.
>
> **עודכן לאחרונה**: 2026-05-20 (migrations עד 0028, 14 edge functions בייצור).

## סקירת הפרויקט

**מערכת WhatsApp AI למכללת ריצ'ר** — דשבורד ניהול לסוכני AI שמטפלים בלידים בוואטסאפ.

הפרויקט הוא ארכיטקטורת **Multi-Agent**: מערכת אחת תומכת במספר סוכנים נפרדים, כל אחד עם מספר WhatsApp נפרד וקונפיגורציה משלו, על תשתית טכנית משותפת.

- **סוכן ראשון**: שיווק שותפים — האחים סיטון
- **סוכנים עתידיים**: שיווק דיגיטלי, AI, וידאו, נדל"ן

הריפו הזה כולל גם את **דשבורד הניהול** וגם את **ה־AI agent loop עצמו** (Supabase Edge Functions ב־`supabase/functions/`). הכל בריפו אחד — אין n8n, אין מערכת חיצונית.

---

## ארכיטקטורה כללית — תמונת על

```
                    ┌─────────────────────────────────────────────────────┐
                    │                  PEOPLE & SYSTEMS                    │
                    └─────────────────────────────────────────────────────┘
                                          │
        ┌─────────────────┬───────────────┴──────────────┬──────────────────┐
        ▼                 ▼                              ▼                  ▼
   ┌─────────┐      ┌──────────┐                  ┌───────────┐      ┌─────────┐
   │  Lead   │      │  Admin   │                  │ Landing   │      │  Cron   │
   │WhatsApp │      │Dashboard │                  │   Page    │      │(supabase│
   │         │      │(Lovable) │                  │ (Make.com)│      │ schedule)│
   └────┬────┘      └─────┬────┘                  └─────┬─────┘      └────┬────┘
        │                 │                             │                 │
        ▼                 ▼                             ▼                 ▼
 ┌──────────┐      ┌──────────────┐              ┌────────────┐    ┌──────────────┐
 │ Meta     │      │ Supabase     │              │ lead-      │    │ dispatch-    │
 │ Cloud    │      │ Auth + JWT   │              │ register   │    │ scheduled-   │
 │ → Hook   │      │ → Edge fns:  │              │ edge fn    │    │ templates    │
 │ MyApp    │      │   • send     │              │            │    │ brain-sweep  │
 │          │      │   • replay   │              │            │    │ re-engage    │
 │          │      │   • coach    │              │            │    │              │
 │          │      │   • brain    │              │            │    │              │
 └────┬─────┘      └──────┬───────┘              └─────┬──────┘    └──────┬───────┘
      │                   │                            │                  │
      ▼                   │                            │                  │
 ╔══════════════════════════════════════════════════════════════════════════════╗
 ║              whatsapp-webhook  (PUBLIC, HMAC-verified, no-jwt)                ║
 ║              ────────────────────────────────────────────────                 ║
 ║   1. אימות חתימה  →  2. upsert conversation  →  3. insert inbound             ║
 ║   4. kill-switch?  →  5. return 200 (≈100ms)  →  6. EdgeRuntime.waitUntil    ║
 ║                                                                                ║
 ║   ┌──────────────────────  background agent loop  ──────────────────────┐    ║
 ║   │ 7. agent_lock (atomic)  8. quiet_hours?                              │    ║
 ║   │ 9. load: prompt + 30 msgs + brain_documents + compression           │    ║
 ║   │ 10. Claude Sonnet 4.6 (adaptive thinking, retry, 110s cap)          │    ║
 ║   │ 11. validateAgentReply (regex)   12. judgeReply (Haiku 4.5)         │    ║
 ║   │ 13. whatsappSend (HookMyApp)     14. insert outbound + provenance   │    ║
 ║   │ 15. Langfuse trace               16. extractMemory (Haiku 4.5)      │    ║
 ║   │ 17. updateTag + funnelStage      18. fireHandoffWebhook (Make.com)  │    ║
 ║   └──────────────────────────────────────────────────────────────────────┘    ║
 ╚══════════════════════════════════════════════════════════════════════════════╝
      │                  │                  │                 │
      ▼                  ▼                  ▼                 ▼
 ┌──────────┐    ┌───────────────┐   ┌─────────────┐   ┌────────────┐
 │ Supabase │    │  Anthropic    │   │  Langfuse   │   │  Make.com  │
 │ Postgres │    │  Sonnet 4.6   │   │   Cloud     │   │  scenario  │
 │   + RLS  │    │  + Haiku 4.5  │   │  (traces)   │   │  → Mooz    │
 │ + Real-  │    │               │   │             │   │  → Firebrry│
 │   time   │    │               │   │             │   │  → Alerts  │
 └──────────┘    └───────────────┘   └─────────────┘   └────────────┘
```

---

## תרשים זרימה מלא — מהודעה נכנסת ועד handoff

```
                              ┌────────────────────────┐
                              │  Lead שולח הודעה ב־WA  │
                              └───────────┬────────────┘
                                          ▼
                              ┌────────────────────────┐
                              │   HookMyApp Cloud API   │
                              │   POST → webhook URL    │
                              └───────────┬────────────┘
                                          ▼
        ╔═════════════════════════════════════════════════════════════╗
        ║   whatsapp-webhook/index.ts  (FOREGROUND ≈ 100ms)            ║
        ╠═════════════════════════════════════════════════════════════╣
        ║                                                               ║
        ║   ① HMAC-SHA256 (constant-time, X-Hub-Signature-256)         ║
        ║      └─ חתימה לא תקינה → log + 200 (fail-open ל־handshake)   ║
        ║                                                               ║
        ║   ② Upsert conversation (UPDATE-first, INSERT-fallback)      ║
        ║      └─ UNIQUE(agent_id, lead_phone)  /  לא דורס status      ║
        ║                                                               ║
        ║   ③ Insert inbound message                                    ║
        ║      └─ UNIQUE על meta_message_id (אידמפוטנטי)               ║
        ║      └─ audio?  →  transcribeVoice (OpenAI Whisper, he)      ║
        ║                                                               ║
        ║   ④ agents.is_paused?  →  Kill-switch (יוצא ב־200, אין AI)   ║
        ║                                                               ║
        ║   ⑤ ✅ return 200 ל־HookMyApp                                 ║
        ║                                                               ║
        ║   ⑥ EdgeRuntime.waitUntil(...)  ←  הכל מכאן ברקע            ║
        ╚═════════════════════════════════════════════════════════════╝
                                          │
                                  (ברקע — הליד כבר קיבל 200)
                                          ▼
        ╔═════════════════════════════════════════════════════════════╗
        ║   AGENT LOOP  (generateAndSendAgentResponse)                  ║
        ╠═════════════════════════════════════════════════════════════╣
        ║                                                               ║
        ║   ⑦ Atomic per-conversation lock                              ║
        ║      └─ UPDATE conversations SET agent_lock_taken_at=now()    ║
        ║         WHERE status='active' AND (lock is null OR <60s ago)  ║
        ║      └─ rowCount=0  →  webhook מקביל לקח, יוצאים בשקט        ║
        ║                                                               ║
        ║   ⑧ isQuietHourNow(agent, Asia/Jerusalem)?  →  לא שולחים      ║
        ║                                                               ║
        ║   ⑨ loadAgentTurnContext:                                     ║
        ║      • prompts WHERE is_active AND type='main'                ║
        ║      • 30 הודעות אחרונות (chronological)                       ║
        ║      • brain_documents (PDFs/images שאופרטור העלה)             ║
        ║      • compression: >20 תורות  →  summary + 10 אחרונות         ║
        ║      • guard: last message חייב להיות inbound                  ║
        ║                                                               ║
        ║   ⑩ Anthropic.messages.create()                                ║
        ║      model=claude-sonnet-4-6                                  ║
        ║      thinking={ type: "adaptive" }                            ║
        ║      max_tokens=2048                                          ║
        ║      └─ anthropicRetry: 3 ניסיונות, exp backoff + jitter       ║
        ║      └─ SDK timeout cap 110s (PR #65, נמוך מ־150s edge fn)    ║
        ║                                                               ║
        ║   ⑪ validateAgentReply (regex, דטרמיניסטי):                   ║
        ║      ❌ אורך >1500 / null / placeholders                       ║
        ║      ❌ מטבעות (₪/$/€/שקלים/דולר)                              ║
        ║      ❌ AI brand leak (Claude/ChatGPT/OpenAI/Gemini/LLM)       ║
        ║      ❌ Hebrew self-disclosure (אני AI/בוט/מודל)               ║
        ║      ❌ הבטחות הכנסה (מובטח/ערבות/תרוויח X בחודש)              ║
        ║      └─ נכשל → DLQ + error_log + alertOperators                ║
        ║                                                               ║
        ║   ⑫ judgeReply (Claude Haiku 4.5, JSON prefill `{`):           ║
        ║      ✓ price_leak ✓ income_promise ✓ ai_disclosure             ║
        ║      ✓ invented_fact ✓ off_topic                               ║
        ║      └─ Haiku down → degrade-open (מאפשרים, מתעדים warn)       ║
        ║                                                               ║
        ║   ⑬ whatsappSend → HookMyApp                                  ║
        ║      └─ 3 retries (1s/2s), 8s timeout, Bearer redaction       ║
        ║      └─ כשל סופי → DLQ + alertOperators                        ║
        ║                                                               ║
        ║   ⑭ Insert outbound message + עדכון conversation              ║
        ║      • langfuse_trace_id, prompt_version_id, model            ║
        ║      • tokens_input/output, cost_usd, latency_ms              ║
        ║      • conversations.last_interaction_at = now()              ║
        ║                                                               ║
        ║   ⑮ Langfuse trace (fire-and-forget, never blocks)            ║
        ╚═════════════════════════════════════════════════════════════╝
                                          │
                              (התגובה כבר אצל הליד)
                                          ▼
        ╔═════════════════════════════════════════════════════════════╗
        ║   MEMORY + FUNNEL + HANDOFF  (extractMemory.ts)               ║
        ╠═════════════════════════════════════════════════════════════╣
        ║                                                               ║
        ║   ⑯ Claude Haiku 4.5 (JSON mode, prefill `{`):                ║
        ║      מחלץ: q1_age, q2_motivation, q3_dream_change,            ║
        ║      q4_blocker, q5_urgency, q6_investment, q7_email,         ║
        ║      meeting_consented_at, summary, primary_objection,        ║
        ║      red_flags[], notes_for_advisor                           ║
        ║                                                               ║
        ║   ⑰ Upsert lead_memory                                        ║
        ║                                                               ║
        ║   ⑱ decideConversationTag:                                    ║
        ║      • underage in red_flags  →  current_tag='underage'       ║
        ║      • אחר red_flag  →  'requires_human'                       ║
        ║      • תגיות סופיות (zoom/opted_out/ghosted) דביקות            ║
        ║                                                               ║
        ║   ⑲ decideFunnelStage  (sticky 'done'):                       ║
        ║      • 5/5 שאלות (q1-q5)  →  'done'                            ║
        ║      • 1-4 שאלות  →  'mid'                                     ║
        ║      • 0 שאלות   →  'cold'                                     ║
        ║                                                               ║
        ║   ⑳ shouldTriggerZoomHandoff?  (כל התנאים ביחד):              ║
        ║      ✓ next_stage = 'done'                                    ║
        ║      ✓ current_stage ≠ 'done' (אל תירה שוב)                   ║
        ║      ✓ אין red_flags                                           ║
        ║      ✓ אין תג חוסם                                             ║
        ║      ✓ meeting_consented_at ≠ null                            ║
        ║      ✓ q7_email ≠ null                                        ║
        ║      └─ כן  →  tag='zoom_scheduled', status='paused'           ║
        ║                                                               ║
        ║   ㉑ fireHandoffWebhook → HANDOFF_WEBHOOK_URL (Make.com):     ║
        ║      • HMAC-SHA256 signed (HANDOFF_WEBHOOK_SECRET)            ║
        ║      • payload: agent, conversation, lead_memory snapshot     ║
        ║      • 3 retries, retry על 5xx/429, non-retry על 4xx          ║
        ║      • כשל סופי → DLQ + error_log                              ║
        ╚═════════════════════════════════════════════════════════════╝
                                          │
                                          ▼
        ┌──────────────────────────────────────────────────────────────┐
        │  Make.com scenario מפזר:                                       │
        │    • Mooz  — קביעת זום עם יועץ                                 │
        │    • Fireberry CRM  — יצירת/עדכון רשומה                        │
        │    • התראת WhatsApp ליועץ הרלוונטי                              │
        └──────────────────────────────────────────────────────────────┘
```

---

## תהליכים שרצים ברקע (מחוץ ל־loop הראשי)

```
┌──────────────────────────────────────────────────────────────────────────┐
│   CRON & ASYNC  (Supabase scheduled functions)                             │
├──────────────────────────────────────────────────────────────────────────┤
│                                                                            │
│  📅 dispatch-scheduled-templates           pg_cron כל דקה                 │
│     • שולף scheduled_messages פנדינג שזמנם הגיע                            │
│     • atomic claim (claimed_by_cron_id) — אין race בין ticks                │
│     • quiet hours check + Mooz check (fail-closed)                         │
│     • שולח template דרך whatsappTemplateSend → HookMyApp                   │
│     • mark sent_at, על כשל → DLQ                                            │
│                                                                            │
│  🧊 re-engage-cold-leads                   pg_cron (לפי configuration)     │
│     • שולף conversations עם funnel_stage='cold' שלא ענו N ימים             │
│     • שולח template re-engagement, סופר re-engaged_at                       │
│                                                                            │
│  🧹 brain-sweep-stale                       pg_cron כל 10 דקות             │
│     • brain_documents שתקועים ב־extraction_status='pending' > 20 דק׳        │
│     • מסמן כ־'failed' עם error message                                      │
│                                                                            │
├──────────────────────────────────────────────────────────────────────────┤
│   ADMIN-TRIGGERED  (HTTP POST + JWT)                                       │
├──────────────────────────────────────────────────────────────────────────┤
│                                                                            │
│  🧠 brain-ingest                            POST מהדשבורד                  │
│     • PDF/תמונה → Storage → Insert row pending → return 200                │
│     • EdgeRuntime.waitUntil: Sonnet 4.6 מחלץ טקסט                          │
│     • injectionScan → חוסם prompt-injection (ignore instructions וכו׳)     │
│     • update extraction_status='ready' + extracted_text                    │
│                                                                            │
│  🆕 lead-register                           Make.com webhook               │
│     • Landing-page lead → upsert conversation + lead_memory                │
│     • q7_email נשמר מההרשמה                                                 │
│     • enqueue scheduled_messages (first-touch template, +40 דק׳ default)   │
│                                                                            │
│  🎓 prompt-coach                            Admin chat                     │
│     • Sonnet 4.6 + tool-use (propose_prompt_edit)                          │
│     • קורא: active prompt + שיחות אחרונות + brain                          │
│     • שיחה נשמרת ב־coach_messages (Realtime → UI חי)                       │
│                                                                            │
│  ✅ prompt-coach-apply                      Admin approve                  │
│     • הדרך היחידה (חוץ מ־rollback) לעדכן is_active ב־prompts                │
│     • אטומי: ישן → false, חדש → true                                        │
│                                                                            │
│  🔁 dlq-replay                              Admin button                   │
│     • retry של failed_messages                                              │
│     • סוגים: hookmyapp_send / handoff_webhook                               │
│     • max 3 retries לכל שורה                                                │
│                                                                            │
│  ⚡ whatsapp-send                            ReplyBox מהדשבורד              │
│     • שליחה ידנית של אופרטור — עוקפת agent loop                            │
│     • RLS מבטיח שרק admin יכול                                              │
│                                                                            │
│  ⚖️ prompt-replay                           Admin A/B                      │
│     • טוען prompt מועמד + שיחה היסטורית                                     │
│     • מריץ את ה־prompt תור אחר תור, מציג side-by-side                       │
│                                                                            │
│  👤 invite-user / delete-user               Admin user mgmt                │
│     • הוספה/הסרה של מנהלים/אופרטורים                                        │
└──────────────────────────────────────────────────────────────────────────┘
```

---

## שכבות הגנה — מי תופס מה

| איפה | מנגנון | מה זה תופס |
|---|---|---|
| כניסה | HMAC-SHA256 חתימה | זריקות זדוניות, replay attacks |
| DB | UNIQUE על `meta_message_id` | תגובות כפולות מ־retry של Meta |
| DB | UNIQUE על `(agent_id, lead_phone)` | race ב־upsert של שיחה |
| Loop | `agent_lock_taken_at` (60s TTL) | webhooks מקבילים → double reply |
| Loop | `agents.is_paused` (kill switch) | סוכן שמתקלקל → עוצרים הכל ב־קליק |
| Loop | `agents.quiet_hours_start/end_il` | שליחה ב־00:00 |
| תגובה | `validateAgentReply` (regex) | מחירים / AI leak / placeholders / הבטחות |
| תגובה | `judgeReply` (Haiku 4.5) | סטיות סמנטיות שרגקס פספס |
| שליחה | retry + timeout + DLQ | רעש רשת / HookMyApp 5xx |
| Handoff | `meeting_consented_at` + `q7_email` חובה | handoff מוקדם לפני שהליד הסכים |
| Dispatcher | Mooz pre-check (fail-closed) | קביעת זום כפולה / מספר לא ישראלי |
| Dispatcher | `claimed_by_cron_id` atomic claim | race בין ticks אם tick גולש מעל 60s |
| Dispatcher | opt-out re-check לפני שליחה (`opt_outs`) | ליד שביקש הסרה אחרי enqueue של דיוור — מבוטל, לא נשלח |
| Broadcast | suppression ב־enqueue (opt_outs + tags חוסמים) | דיוור למי שביקש הסרה / כבר קבע זום — גם מ־CSV |
| Brain | `injectionScan` | prompt injection ב־PDF שאופרטור מעלה |
| RLS | מ־migration 0018: admin-only reads | אופרטור רגיל לא רואה נתוני לידים |

---

## ההחלטות הארכיטקטוניות (10)

| # | תחום | החלטה |
|---|---|---|
| 1 | מי כותב קוד | **רק Claude Code.** Lovable נשאר מחובר ל-git אבל לא כותב. |
| 2 | אירוח Production | **Lovable** — אוטו-deploy מ-`main`. |
| 3 | זרימת קוד | **Feature branches → PR → merge ל-main.** Preview מקומי עם `bun dev`. |
| 4 | סכמת Supabase | **Migrations בריפו** (`supabase/migrations/`). אין עריכה ידנית ב-Studio. |
| 5 | Prompts | **קבצים בריפו → סנכרון אוטומטי** לטבלת `prompts` ב-Supabase. |
| 6 | Orchestration / AI loop | **Supabase Edge Functions** (Deno + Anthropic SDK). הלולאה לקריאת Claude, חילוץ זיכרון, ותיוג חיים בקוד שב־`supabase/functions/`, לא ב־n8n. |
| 7 | Auth | **email/password, ניהול משתמשים מהמסך.** מ־migration 0018: ה־reads של לידים נעולים ל־admin בלבד. |
| 8 | TypeScript | **Strict mode.** אסור `any`. |
| 9 | CI | **typecheck + lint + build על כל PR.** Branch protection ב-main. |
| 10 | Testing | **רק על הגרעין הקריטי**: queries, contexts, auth, חישובי KPIs, edge fn shared utils. |

---

## Tech Stack

- **Frontend**: Vite + React 18 + TypeScript (strict)
- **UI**: shadcn/ui + Tailwind CSS, RTL מלא, פונט Heebo
- **Routing**: react-router-dom v6
- **State**: React Context + `@tanstack/react-query` + Supabase Realtime
  - Realtime channels פעילים: `public.messages` (migration 0013), `public.coach_messages` (migration 0028)
- **Forms**: react-hook-form + zod
- **DB / Auth / Storage**: Supabase (Postgres + Auth + Storage + Realtime)
- **AI**:
  - **Claude Sonnet 4.6** — agent reply (`claude-sonnet-4-6` ב־`whatsapp-webhook`), prompt-coach, brain extraction
  - **Claude Haiku 4.5** — memory extractor (`extractMemory.ts`), semantic judge (`judgeReply.ts`)
  - **OpenAI Whisper** — voice note transcription (he) ב־`transcribeVoice.ts`
- **Orchestration / AI loop**: Supabase Edge Functions (Deno) — 14 פונקציות, ראה הסעיף הבא.
- **Observability**: Langfuse Cloud — כל קריאת Claude נשמרת כ־trace. `error_logs` + `failed_messages` ב־Postgres לכשלים ולתור שחזור.
- **WhatsApp BSP**: HookMyApp Cloud API — production WABA `1001103162575975` (`+972 55-991-7038`, "מכללת ריצ׳ר ליזמות דיגיטלית").
- **External integrations**: Make.com (handoff fan-out → Mooz, Fireberry CRM, alerts), Mooz (booking pre-check).
- **Hosting**: Lovable (`*.lovable.app`) — auto-deploy מ־`main`
- **Package Manager**: bun (`~/.bun/bin/bun`)
- **Testing**: vitest + @testing-library/react + Deno tests ב־`_shared/*.test.ts`

---

## Edge Functions בפרוד (14)

| Function | טריגר | תפקיד |
|---|---|---|
| **whatsapp-webhook** | HookMyApp POST | inbound + agent loop + memory + handoff (no-jwt, HMAC) |
| **whatsapp-send** | Dashboard ReplyBox | שליחה ידנית של אופרטור (admin) |
| **broadcast-enqueue** | Dashboard "דיוור" (admin) | דיוור רחב: בונה קהל (לידים קיימים ± CSV) + suppression (opt-out/tags חוסמים) → מזריק ל־scheduled_messages |
| **lead-register** | Make.com (landing page) | קליטת ליד + enqueue first-touch template |
| **dispatch-scheduled-templates** | pg_cron כל דקה | שליחת templates מתוזמנים (quiet hours + opt-out re-check לפני שליחה) |
| **re-engage-cold-leads** | pg_cron | התראה ללידים cold ששתקו |
| **brain-ingest** | Admin upload | חילוץ טקסט מ־PDF/תמונה (Sonnet) + injection scan |
| **brain-sweep-stale** | pg_cron כל 10 דק׳ | מסמן brain documents תקועים כ־failed |
| **prompt-coach** | Admin chat | Claude מציע שיפורי prompt (tool-use) |
| **prompt-coach-apply** | Admin approve | מחיל הצעה — מעדכן is_active ב־prompts |
| **prompt-replay** | Admin A/B | בודק prompt מועמד מול שיחה היסטורית |
| **dlq-replay** | Admin button | retry של failed_messages |
| **invite-user** | Admin | הזמנת משתמש חדש |
| **delete-user** | Admin | מחיקת משתמש |

ראה [supabase/functions/README.md](./supabase/functions/README.md) לפירוט deploy/secrets.

---

## Shared utilities (`supabase/functions/_shared/`)

| קובץ | תפקיד |
|---|---|
| `auth.ts` | `requireUser` / `requireAdmin` (JWT verify) |
| `cors.ts` | CORS headers |
| `logError.ts` | insert ל־error_logs (non-blocking) |
| `dlq.ts` | insert ל־failed_messages |
| `truncate.ts` | חיתוך טקסט בטוח ל־DB columns |
| `validation.ts` | schema validation helpers |
| `whatsappSend.ts` | שליחת טקסט ב־HookMyApp + retry/timeout |
| `whatsappTemplateSend.ts` | שליחת template message (לקליטה ולא־engagement) |
| `transcribeVoice.ts` | OpenAI Whisper, hebrew hint |
| `anthropicRetry.ts` | wrap לקריאות Anthropic — retry על 429/5xx, exp backoff |
| `validateAgentReply.ts` | regex hallucination guards |
| `judgeReply.ts` | Haiku 4.5 semantic judge |
| `extractMemory.ts` | חילוץ זיכרון + funnel stage + handoff decision |
| `brainContext.ts` | טעינה + פירמוט של brain_documents לתוך system prompt |
| `injectionScan.ts` | זיהוי prompt injection ב־brain uploads |
| `mooz.ts` | Mooz API client — `list_available_slots` / `book_meeting` (tool-use) + `lookupByPhone` (pre-check) |
| `moozTools.ts` | Anthropic tool definitions + dispatcher for Mooz tools |
| `agentTurn.ts` | Tool-use loop wrapper around `anthropic.messages.create` |
| `bookingStatusBlock.ts` | Conditional pre-check predicate + system-prompt block renderer (booked / not-booked / degraded) |
| `moozCheck.ts` | ⚠️ legacy/dead — old single-purpose phone checker, kept for tests only. Live code uses `mooz.ts` |
| `quietHours.ts` | חישוב חלון שתיקה פר־סוכן (Asia/Jerusalem, wrap-midnight) |
| `alertOperators.ts` | WhatsApp alert לטלפוני אופרטור על כשל קריטי |
| `fireHandoffWebhook.ts` | POST חתום ל־Make.com handoff |
| `langfuse.ts` | HTTP client + pricing + cost compute |

---

## מבנה תיקיות

```
.
├── .github/workflows/      # GitHub Actions (CI)
├── public/                 # static assets
├── src/
│   ├── components/
│   │   ├── layout/         # AppLayout, AppSidebar, AppHeader, AgentSelector
│   │   ├── ui/             # shadcn primitives
│   │   ├── dashboard/      # KPI cards + funnel/tag breakdown
│   │   ├── leads/          # Leads table + filters + CopyPhoneButton (shared: leads + conversations)
│   │   ├── analytics/      # CostLatency + Objections + AiProviders + ExperimentCard
│   │   ├── conversations/  # MessageThread · ReplyBox · LeadMemoryPanel · MessageDebugPopover
│   │   ├── prompts/        # PromptViewDialog · PromptReplayDialog
│   │   ├── coach/          # CoachChat · CoachMessage · ProposedPromptDiff (Phase F)
│   │   ├── settings/       # AgentsTab · UsersTab · BrainTab · KillSwitch · QuietHours
│   │   ├── auth/           # AdminOnly · ProtectedRoute
│   │   ├── effects/
│   │   └── EmptyState.tsx
│   ├── contexts/
│   ├── hooks/
│   ├── lib/                # supabase client + queries (analytics, conversations, kpis, brain, coach, ...)
│   ├── pages/              # 8 דפים: Index/Leads/Conversations/Analytics/Prompts/Coach/Settings/Login
│   ├── types/              # database.ts (auto-generated)
│   └── test/               # vitest setup
├── supabase/
│   ├── migrations/         # 0001-0028 (ראה הסעיף הבא)
│   ├── functions/
│   │   ├── _shared/        # 20+ utilities
│   │   ├── whatsapp-webhook/
│   │   ├── whatsapp-send/
│   │   ├── lead-register/
│   │   ├── dispatch-scheduled-templates/
│   │   ├── re-engage-cold-leads/
│   │   ├── brain-ingest/
│   │   ├── brain-sweep-stale/
│   │   ├── prompt-coach/
│   │   ├── prompt-coach-apply/
│   │   ├── prompt-replay/
│   │   ├── dlq-replay/
│   │   ├── invite-user/
│   │   └── delete-user/
│   └── README.md
├── scripts/                # db:apply · prompts:sync · seed:test · wa-tunnel-proxy
├── prompts/
│   └── affiliate_marketing/
│       ├── _active.json    # { "main": "v8", "memory_extractor": "v2" }
│       ├── main/           # v1..v8.md
│       └── memory_extractor/ # v1..v3.md
└── CLAUDE.md
```

---

## Migrations — 0001 עד 0028

### Phase 0-1: יסודות (0001-0006)
| # | מה |
|---|---|
| 0001 | RLS policies בסיסיות |
| 0002 | מ־`anon, authenticated` ל־`authenticated` בלבד |
| 0003 | `app_users` + `role` enum + `is_admin()` function |
| 0004 | admin-only mutations |
| 0005 | messages outbound INSERT policy |
| 0006 | UNIQUE על `prompts` (agent_id, type, version) |

### Phase A: Reliability (0007-0011)
| # | מה |
|---|---|
| 0007 | UNIQUE על `messages.meta_message_id` (idempotency) |
| 0008 | `failed_messages` table (DLQ) |
| 0009 | `error_logs` table + `error_type` enum |
| 0010 | UNIQUE על `conversations(agent_id, lead_phone)` |
| 0011 | drop SECURITY DEFINER views (security) |

### Phase B: Observability (0012-0013)
| # | מה |
|---|---|
| 0012 | `messages` provenance columns: langfuse_trace_id, prompt_version_id, tokens, cost, latency, model |
| 0013 | `public.messages` ב־`supabase_realtime` publication |

### Phase D-mini: Prompt Rollback (0014)
| # | מה |
|---|---|
| 0014 | UPDATE policy על `prompts` ל־admin בלבד |

### Phase F: Coach (0015-0016)
| # | מה |
|---|---|
| 0015 | `coach_messages` table (id, agent_id, role, content, proposed_prompt_diff, ...) |
| 0016 | `coach_attachments` (תמונות/קבצים שאופרטור מצרף לקואץ׳) |

### Phase G: Brain (0017, 0021)
| # | מה |
|---|---|
| 0017 | `brain_documents` table — מסמכי הקשר שאופרטור מעלה |
| 0021 | `extraction_status` enum + `extraction_error` text |

### Phase H: Lockdown + Performance (0018-0019)
| # | מה |
|---|---|
| 0018 | RLS admin-only reads על `conversations` / `messages` / `lead_memory` |
| 0019 | composite indexes + phone routing |

### Phase I: Kill Switch + Re-Engagement (0020)
| # | מה |
|---|---|
| 0020 | `agents.is_paused` (kill switch) + `conversations.re_engaged_at` + re-engagement config |

### Phase J: Lead Onboarding (0022-0024)
| # | מה |
|---|---|
| 0022 | `lead_memory.q7_email` + `agents.meeting_type_id` + `agents.meeting_duration_minutes` (Mooz booking config) |
| 0023 | `scheduled_messages` table + `agents.first_touch_template_*` + lead-register endpoint |
| 0024 | `agents.meeting_check_url` + `agents.meeting_check_enabled` (pre-check infra; currently unused by live code) |

### Phase K: Concurrency Safety (0025)
| # | מה |
|---|---|
| 0025_conversation_agent_lock | `conversations.agent_lock_taken_at` (atomic per-conversation lock) |
| 0025_dispatcher_atomic_claim | `scheduled_messages.claimed_by_cron_id` (atomic claim ב־dispatcher) |

### Phase L: Operator Alerts + Quiet Hours + Consent (0026-0027)
| # | מה |
|---|---|
| 0026 | `agents.operator_alert_phones` (jsonb) — מי לקבל התראת כשל |
| 0027_agent_quiet_hours | `agents.quiet_hours_start_il` / `quiet_hours_end_il` (0-23, IL) |
| 0027_meeting_consent | `lead_memory.meeting_consented_at` — gate ל־handoff |

### Phase M: Coach Realtime (0028)
| # | מה |
|---|---|
| 0028 | `coach_messages` ל־supabase_realtime publication |

> הערה: migrations 0029–0041 (delivery status, mooz uuid/webhook, dedup, claim v2/v3, manual mode, digital-marketing agent, drop global phone unique, mooz product code) הוחלו בפרוד אך טרם תועדו כאן פרטנית.

### Phase N: Broadcast (0042-0044)
| # | מה |
|---|---|
| 0042 | `broadcasts` table + `broadcast_status_enum` (additive; דיוור כיחידה) |
| 0043 | `broadcast_templates` registry (dropdown של templates מאושרים) + seed מ־`agents.first_touch_template_name` |
| 0044 | `scheduled_messages.broadcast_id` (nullable FK; הזרימה הקיימת נשארת NULL) |

**דיוור רחב**: אדמין בונה דיוור דרך דף "דיוור" → `broadcast-enqueue` מזריק שורות ל־`scheduled_messages` וה־dispatcher הקיים שולח. **Suppression דו-שלבי**: ב־enqueue (opt_outs + tags חוסמים) וב־dispatcher לפני שליחה (opt_outs re-check). אפיון + תוכנית: `docs/superpowers/`.

---

## כללי עבודה

### Branches & PRs

- **`main`** = production. Lovable מ-deploy ממנו אוטומטית.
- **לא לעשות push ישיר ל-main.** Branch protection אוסר על זה.
- **שמות branches**: `feat/...` · `fix/...` · `chore/...`
- **PR title**: באנגלית, conventional commit style (`feat: add login screen`).
- **PR description**: summary + test plan.
- **לפני merge**: ה-CI חייב לעבור (typecheck + lint + build + tests).

### TypeScript

- **Strict mode מופעל.** אל תכבה אותו.
- אסור `any` — אם צריך טיפוס לא ידוע, השתמש ב-`unknown` ועשה narrowing.
- Null checks חובה.

### Supabase

- **רק migrations.** אסור לערוך את הסכמה ידנית ב-Supabase Studio.
- שמות migrations: `<NNNN>_<description>.sql` (4 ספרות, snake_case).
- אחרי יצירת migration: `supabase db push` ואז `supabase gen types typescript`.
- **RLS חובה** על כל טבלה עם נתוני משתמש או לידים. מ־migration 0018: reads של נתוני לידים = admin בלבד.

### Prompts

- כל Prompt חי כקובץ markdown ב-`prompts/<agent_name>/<type>/<version>.md`.
- שינוי Prompt = שינוי קובץ → PR → merge → סקריפט סנכרון מעלה ל-DB.
- **שלוש דרכים להחליף את ה־active prompt**:
  1. `prompts:sync` עם `_active.json` מעודכן (PR workflow).
  2. כפתור ↺ Rollback בדף Prompts (admin, מיידי).
  3. `prompt-coach-apply` (admin אחרי שיחת coach).

### Edge Functions

- כל function ב־`supabase/functions/<name>/index.ts`. דנו, לא Node.
- Deploy: `bunx supabase functions deploy <name> [--no-verify-jwt] --project-ref juoglkqtmjsziieqgmhf`.
- ה־`whatsapp-webhook`, `lead-register`, ו־`brain-sweep-stale`/`re-engage-cold-leads`/`dispatch-scheduled-templates` חייבים `--no-verify-jwt` (מאומתים דרך HMAC/cron secret/external webhook).
- סודות: `bunx supabase secrets set --env-file <path>`.
- האגנט הראשי רץ ב־`whatsapp-webhook` כ־background task דרך `EdgeRuntime.waitUntil`.

### Testing

- **טסטים על הגרעין הקריטי בלבד**: queries, contexts, auth, KPIs, edge fn shared utilities.
- כל קובץ קריטי ב־`_shared/` כולל test colocate (`*.test.ts`).
- אסור לטסט UI styling.

### Auth

- כל page (חוץ מ-login) דורש user מחובר.
- Redirect ל-`/login` אם user לא מחובר.
- ניהול משתמשים + פעולות mutation על נתוני לידים = admin בלבד.

---

## Local Development

### Setup ראשון

```bash
curl -fsSL https://bun.sh/install | bash
git clone https://github.com/RicherLTD/richer-ai-agents-hub.git
cd richer-ai-agents-hub
~/.bun/bin/bun install
cp .env.example .env.local
# ערוך .env.local עם credentials של Supabase
```

### פקודות יומיות

```bash
~/.bun/bin/bun run dev     # dev server על http://localhost:8080
~/.bun/bin/bun run lint    # eslint
~/.bun/bin/bun run test    # vitest
~/.bun/bin/bun run build   # production build
```

---

## משתני סביבה

### Client (build-time, public, ב־`.env`)
- `VITE_SUPABASE_URL`
- `VITE_SUPABASE_ANON_KEY`

### Server-side scripts (`.env.local`, gitignored)
- `SUPABASE_PROJECT_REF`, `SUPABASE_ACCESS_TOKEN`

### Edge function secrets (`.env.functions.local` לפיתוח, ב־Supabase secrets בפרוד)

**WhatsApp / HookMyApp:**
- `VERIFY_TOKEN` — Meta App Secret (HMAC)
- `WHATSAPP_API_URL`, `WHATSAPP_ACCESS_TOKEN`, `WHATSAPP_PHONE_NUMBER_ID`
- `HOOKMYAPP_AGENT_NAME` — slug ב־`agents.name` ליחוס לידים נכנסים

**AI:**
- `ANTHROPIC_API_KEY` — `sk-ant-...`
- `OPENAI_API_KEY` — לתמלול voice notes (Whisper)

**Observability:**
- `LANGFUSE_PUBLIC_KEY`, `LANGFUSE_SECRET_KEY`, `LANGFUSE_HOST`

**Handoff fan-out:**
- `HANDOFF_WEBHOOK_URL` — Make.com scenario URL
- `HANDOFF_WEBHOOK_SECRET` — HMAC לחתימת הקריאה

**Mooz integration (booking system):**
- `MOOZ_ORG_API_KEY` — per-org bearer for `list_available_slots` + `book_meeting` tools (api-gateway calls). Without it, `moozClientFromEnv` returns null and the bot can't see real slots or book.
- `MOOZ_API_TOKEN` — global bearer for `lookupByPhone` (pre-check). Without it, every triggered pre-check returns `{booked:false, error:"MOOZ_API_TOKEN not configured"}` and the degraded prompt block is injected. Watch `error_logs.error_type='mooz_lookup_failed'` if you suspect this is missing.
- Base URL is hardcoded in `_shared/mooz.ts` (`MOOZ_BASE_URL`); no separate env var.

```bash
# עדכון סודות בפרוד:
bunx supabase secrets set --env-file .env.functions.local --project-ref juoglkqtmjsziieqgmhf
```

**אסור** לשים `service_role` key ב-client-side.

---

## מצב נוכחי (2026-05-20)

### מה קיים ועובד

**Production WhatsApp pipeline:**
- HookMyApp Cloud API → WABA `1001103162575975` (`+972 55-991-7038`).
- שיחה דו־כיוונית מאומתת end-to-end עם הטלפון האמיתי.
- 14 edge functions בייצור, 28 migrations applied.
- Prompt פעיל: `main/v8`, `memory_extractor/v2`.

**Phase A-E (תועד מראש):**
- Idempotency, DLQ, error_logs, Langfuse traces, memory extractor, funnel + handoff, prompt rollback + replay.

**Phase F — Prompt Coach:**
- צ׳אט אדמין עם Sonnet 4.6 שמציע שיפורים ל־prompt קיים.
- tool-use: `propose_prompt_edit` מחזיר diff מובנה.
- coach רואה: prompt פעיל, שיחות אחרונות, brain documents.
- Realtime על coach_messages → UI חי.
- `prompt-coach-apply` מבצע את ההחלפה אטומית.

**Phase G — Brain:**
- אופרטור מעלה PDF/תמונה דרך BrainTab.
- `brain-ingest` מחלץ טקסט (Sonnet) ברקע, `injectionScan` חוסם הזרקות.
- `brain-sweep-stale` מטפל בתקועים.
- ה־agent loop טוען את ה־brain כחלק מה־system context.

**Phase H — Lockdown + Performance:**
- migration 0018: reads של נתוני לידים = admin בלבד.
- composite indexes על messages + phone routing לריבוי סוכנים.

**Phase I — Kill Switch:**
- `agents.is_paused` — האופרטור עוצר סוכן ב־1 קליק; ה־webhook לא מפעיל AI כל עוד paused.
- מצב inbound עדיין נכנס ל־DB כדי לא לאבד היסטוריה.

**Phase J — Lead Onboarding (Landing → WhatsApp):**
- `lead-register` מקבל ליד מ־Make.com (טופס landing page).
- upsert conversation + lead_memory עם q7_email.
- enqueue `scheduled_messages` עם first-touch template אחרי X דקות.
- `dispatch-scheduled-templates` שולח בזמן הנכון, עם Mooz pre-check + quiet hours.

**Phase K — Concurrency Safety:**
- atomic per-conversation lock על agent loop (migration 0025_conversation_agent_lock).
- atomic claim על dispatcher כדי שלא ישלח אותו message פעמיים גם אם tick גולש (0025_dispatcher_atomic_claim).

**Phase L — Operator Care:**
- `operator_alert_phones` — התראת WhatsApp לאופרטור על כשל קריטי.
- `quiet_hours_start_il/end_il` — חלון שתיקה פר־סוכן.
- `meeting_consented_at` — gate חובה ל־handoff (לא מספיק לזהות תשובות חיוביות, צריך הסכמה מפורשת).

**Phase M — Coach Realtime (PR אחרון):**
- coach_messages ב־publication → UI מתעדכן ברגע ש־background task מסיים לדבר.

**Voice + Judge:**
- voice notes  →  Whisper (he)  →  טקסט שנכנס ל־history.
- שכבת בטיחות שנייה: `judgeReply` עם Haiku 4.5 שמסנן סטיות סמנטיות (מעבר ל־regex).

### מה חסר / בעבודה

- **טבלת `advisors` מאוכלסת** — היום ריקה. אופרטור משייך ידנית; round-robin אוטומטי בעתיד.
- **Multi-agent בפועל** — הסכימה תומכת, אבל היום סוכן יחיד פעיל (`affiliate_marketing`).
- **Auto-scoring על prompt replay** (LLM-as-judge על golden dataset + CI block).
- **Pilot 50 לידים בתנועה אמיתית** — תשתית מוכנה, ממתינים לאישור פתיחת קמפיין.

---

## הקשר עסקי

- **לקוח**: מכללת ריצ'ר, תוכנית שיווק שותפים בניהול האחים סיטון
- **נפח לידים**: 2,000+ בחודש מפרסום ממומן
- **מערכת קיימת**: Virtual Spirit (תוחלף בהדרגה)
- **CRM**: Fireberry (מקבל webhook במקרי escalation דרך Make.com)
- **Booking**: Mooz (קביעת זום אמיתית)
- **לוח זמנים**: Pilot עם 50 לידים → הרחבה הדרגתית עד 2,000+/חודש

## הקשר ייחודי לסוכן הראשון

- **שם**: שיווק שותפים — האחים סיטון
- **מטרה**: תיאום זום עם יועץ לימודים + ליקוט מ-5 שאלות (q1-q5). **לא** מכירה ישירה.
- **טון**: עברית מדוברת, חברית, לא רשמית. הודעות קצרות (1-3 משפטים).
- **זהות**: נציג קשר אנונימי, לא AI ולא בשם נציג ספציפי.
- **גבולות קשיחים**: אסור לציין מחירים, אסור להבטיח הכנסות, אסור להמציא פרטים, אסור לשלוח לינקים שלא אושרו.

ראה את ה־Prompt המלא ב־[prompts/affiliate_marketing/main/v8.md](./prompts/affiliate_marketing/main/v8.md) (פעיל היום).

---

## נקודות מסוכנות

- **לידים = אנשים אמיתיים.** באג ב-flow של WhatsApp = הודעה שגויה לליד = פגיעה במכללה. תמיד בדוק.
- **חוק הספאם הישראלי**: יש לקבל אישור מהליד לפני שליחה. אישור הוטמע בטופס landing page (lead-register).
- **Multi-tenancy**: כל קוד צריך להיות agent-aware (מסונן לפי `activeAgent.id`). אסור להניח סוכן יחיד.
- **Prompt = רגיש**. שינוי בלא בדיקה יכול לגרום לבוט לדבר באופן שגוי. תמיד PR-review. בנוסף: Rollback בדף Prompts (admin) מאפשר חזרה מהירה.
- **Hallucination guards** + **judgeReply**: שכבת safety-net דו־רובדית, אבל לא תחליף ל־PR-review של ה־prompt.
- **RLS**: בלי policies נכונות, anon read מחזיר רשימה ריקה. בדוק policies אחרי כל שינוי סכמה. מ־0018: לידים = admin only.
- **`VERIFY_TOKEN` rotation**: בייצור — מסונכרן עם Meta App Secret. אם דולף, כל אחד יכול להזריק הודעות חתומות.
- **Service-role ב־edge function**: `whatsapp-webhook` רץ עם service_role (עוקף RLS). לא לחשוף את ה־service_role בקוד הקליינט.
- **`--no-verify-jwt` על public functions**: `whatsapp-webhook`, `lead-register`, ה־cron functions. יש שכבת הגנה משלהן (HMAC / cron secret).
- **Fail-open על POST ללא חתימה ב־webhook**: כדי לעבור verification ping של HookMyApp. הוא **לא** מעבד payload במצב הזה.
- **Fail-closed על Mooz check**: אם Mooz לא עונה — לא שולחים. עדיף לא לשלוח מאשר לקבוע פעמיים.
- **Langfuse keys**: 3 keys נפרדים (`PUBLIC` / `SECRET` / `HOST`). אם מודבקים יחד → trace יכשל.
- **Hebrew regex word boundary**: ב־JS `\b` לא תופס תווי עברית. בכל regex של hallucination guard בעברית — **לא** להשתמש ב־`\b`.
- **kill switch**: `agents.is_paused=true` עוצר את ה־AI loop אבל inbound עדיין נכנס. אם אופרטור משאיר paused לזמן ארוך — היסטוריה נצברת בלי תגובות.
- **quiet hours**: שעות wrap-midnight (20→8) מטופלות נכון. אל תוסיף timezone אחר חוץ מ־Asia/Jerusalem בלי לעדכן את quietHours.ts.
- **agent_lock TTL**: 60 שניות. אם מודל מתמשך מעל 60s (Sonnet 4.6 עם thinking) — webhook מקביל יכול לקחת lock וליצור double-reply. הקאפ של 110s על Anthropic SDK (PR #65) מקטין את הסיכון אבל לא מבטל. נטר ב־Langfuse.
- **brain context size**: brain_documents נטענים לתוך system prompt. cap של 200K chars total + 40K per doc. מסמך מאוד גדול ידחק היסטוריה.

---

## חומרי עזר

- **מסמך אפיון מלא v2.0** (42 עמודים, 25 פרקים) — נמצא אצל המשתמש; לא בריפו.
- **מסמך העברה** — נמצא אצל המשתמש.
- **תכנית Lovable** — `.lovable/plan.md` בריפו.
- **Repo**: https://github.com/RicherLTD/richer-ai-agents-hub
