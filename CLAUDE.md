# CLAUDE.md

> מסמך זה הוא ה-source of truth לכל שיחת Claude Code על הפרויקט. כל החלטה ארכיטקטונית, הסבר מצב, וכלל עבודה — כתובים פה. עדכן אותו כשמשתנה משהו מבני.
>
> **עודכן לאחרונה**: 2026-07-28 (migrations עד 0045; 18 edge functions; **שני סוכנים live**: `affiliate_marketing` v18 + `digital_marketing` v4; hosting עבר ל-**Vercel**; נוסף: דיוור רחב, embed שיחה ב-Fireberry, manual mode, שער זום + ייחוס Mooz, משפך טמפלייט server-side).

## סקירת הפרויקט

**מערכת WhatsApp AI למכללת ריצ'ר** — דשבורד ניהול לסוכני AI שמטפלים בלידים בוואטסאפ.

הפרויקט הוא ארכיטקטורת **Multi-Agent**: מערכת אחת תומכת במספר סוכנים נפרדים, כל אחד עם מספר WhatsApp נפרד וקונפיגורציה משלו, על תשתית טכנית משותפת.

- **סוכן 1 (live)**: שיווק שותפים — האחים סיטון (`affiliate_marketing`), ערוץ `whatsapp-webhook`
- **סוכן 2 (live)**: שיווק דיגיטלי — פרסונה "תמיר" (`digital_marketing`, `+972 55-711-3830`), ערוץ `whatsapp-webhook-dm`
- **סוכנים עתידיים**: AI, וידאו, נדל"ן

שני הסוכנים רצים על **אותו handler משותף** (`_shared/whatsappWebhookHandler.ts`); ה־entrypoints נבדלים רק ב־5 ערכי config (secrets בסיומת `_DM` + slug הסוכן). שיוך ליד לסוכן נעשה לפי `agents.whatsapp_phone_number_id` מה־payload, וה־`agentName` הוא fallback בלבד.

הריפו הזה כולל גם את **דשבורד הניהול** וגם את **ה־AI agent loop עצמו** (Supabase Edge Functions ב־`supabase/functions/`). הכל בריפו אחד — אין n8n, אין מערכת חיצונית (ראה `docs/n8n-migration-handoff.md` — **מסמך היסטורי**, המעבר ל-n8n לא בוצע).

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
   │  (x2)   │      │(Vercel)  │                  │ (Make.com)│      │ schedule)│
   └────┬────┘      └─────┬────┘                  └─────┬─────┘      └────┬────┘
        │                 │                             │                 │
        ▼                 ▼                             ▼                 ▼
 ┌──────────┐      ┌──────────────┐              ┌────────────┐    ┌──────────────┐
 │ Meta     │      │ Supabase     │              │ lead-      │    │ dispatch-    │
 │ Cloud    │      │ Auth + JWT   │              │ register   │    │ scheduled-   │
 │ → Hook   │      │ → Edge fns:  │              │ edge fn    │    │ templates    │
 │ MyApp x2 │      │   • send     │              │            │    │ brain-sweep  │
 │          │      │   • replay   │              │            │    │ re-engage    │
 │          │      │   • coach    │              │            │    │              │
 │          │      │   • brain    │              │            │    │              │
 └────┬─────┘      └──────┬───────┘              └─────┬──────┘    └──────┬───────┘
      │                   │                            │                  │
      ▼                   │                            │                  │
 ╔══════════════════════════════════════════════════════════════════════════════╗
 ║           whatsapp-webhook + -dm  (PUBLIC, HMAC-verified, no-jwt)             ║
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
│     • atomic claim דרך RPC claim_scheduled_messages v3 (SKIP LOCKED)        │
│       שמחתים claimed_at — אין race בין ticks                                 │
│     • quiet hours + re-check opt-out/tags חוסמים + דחייה אם manual mode      │
│     • שולח template ב-fetch inline → HookMyApp (לא דרך whatsappTemplateSend) │
│     • תומך ריבוי ערוצים (credentials בסיומת _DM), מצבי ?diag=1 / test_alert  │
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
│     • מחזיר conversation_view_url (embed חתום) + מפעיל conversation-opened  │
│                                                                            │
│  📆 mooz-webhook                            Mooz booking events            │
│     • booking.created → tag zoom_scheduled + ירי handoff ל-Make.com         │
│     • .cancelled → requires_human · .rescheduled → עדכון זמן בלי handoff    │
│     • אידמפוטנטי דרך X-Idempotency-Key בטבלת mooz_webhook_events            │
│     • אימות: Bearer MOOZ_WEBHOOK_SECRET + HMAC X-Mooz-Signature-256        │
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
│  📣 broadcast-enqueue                       דף "דיוור" (admin)              │
│     • בונה קהל (שיחות נבחרות / כל הלידים / CSV) + suppression               │
│     • יוצר שורת broadcasts → מזריק ל-scheduled_messages, dispatcher שולח    │
│     • אידמפוטנטי 60 שניות + rollback ידני                                    │
│                                                                            │
│  🔀 conversation-set-mode                   Toggle מהדשבורד (admin)         │
│     • מעביר שיחה AI ⇄ manual (manual_mode_since / manual_mode_by)           │
│     • דרך service_role — אין UPDATE ישיר מהקליינט                            │
│                                                                            │
│  👤 invite-user / delete-user               Admin user mgmt                │
│     • הוספה/הסרה של מנהלים/אופרטורים                                        │
├──────────────────────────────────────────────────────────────────────────┤
│   PUBLIC, NON-JWT  (HMAC-signed)                                           │
├──────────────────────────────────────────────────────────────────────────┤
│                                                                            │
│  🪟 conversation-view                       iframe בכרטיס ליד ב-Fireberry   │
│     • JSON API ציבורי: שרשור WhatsApp של הליד (עד 500 הודעות), read-only    │
│     • השער היחיד: חתימת HMAC (p/product/sig) מול EMBED_LINK_SECRET → 403    │
│     • ⚠️ URL חתום = סוד. מי שמחזיק אותו רואה תמלול מלא בלי להתחבר            │
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
| Dispatcher | `claimed_at` + `FOR UPDATE … SKIP LOCKED` ב־`claim_scheduled_messages` v3 | race בין ticks אם tick גולש מעל 60s |
| Dispatcher | `conversation_manual_mode_since` → דחיית טמפלייט (לא ביטול) | טמפלייט אוטומטי נכנס לשיחה שאופרטור השתלט עליה |
| Loop | `zoomGate.ts` — רצפת הכשרה דטרמיניסטית | חשיפת כלי ההזמנה לליד שעוד לא הוכשר |
| Loop | `fireberry.ts` — חסימת auto-book לתלמיד רשום (statuscode 2) / רשימה שחורה (11) | הזמנת זום ללקוח קיים |
| Mooz webhook | `mooz_webhook_events` UNIQUE + `X-Idempotency-Key` | עיבוד כפול של אותו booking event |
| Embed | חתימת HMAC (`sig`) מול `EMBED_LINK_SECRET` + CSP `frame-ancestors` ל-Fireberry | קריאת שיחות של לידים דרך `/embed/c` בלי הרשאה |
| Dispatcher | opt-out re-check לפני שליחה (`opt_outs`) | ליד שביקש הסרה אחרי enqueue של דיוור — מבוטל, לא נשלח |
| Broadcast | suppression ב־enqueue (opt_outs + tags חוסמים) | דיוור למי שביקש הסרה / כבר קבע זום — גם מ־CSV |
| Brain | `injectionScan` | prompt injection ב־PDF שאופרטור מעלה |
| RLS | מ־migration 0018: admin-only reads | אופרטור רגיל לא רואה נתוני לידים |

---

## ההחלטות הארכיטקטוניות (10)

| # | תחום | החלטה |
|---|---|---|
| 1 | מי כותב קוד | **רק Claude Code.** Lovable נשאר מחובר ל-git אבל לא כותב. |
| 2 | אירוח Production | **Vercel** — אוטו-deploy מ-`main` (`richer-ai-agents-hub.vercel.app`). קונפיג ב-`vercel.json`: SPA rewrites + CSP `frame-ancestors` ל-Fireberry על `/embed/*`. Lovable = היסטורי, לא משמש לאירוח. |
| 3 | זרימת קוד | **Feature branches → PR → merge ל-main.** Preview מקומי עם `bun dev`. |
| 4 | סכמת Supabase | **Migrations בריפו** (`supabase/migrations/`). אין עריכה ידנית ב-Studio. |
| 5 | Prompts | **קבצים בריפו → סנכרון אוטומטי** לטבלת `prompts` ב-Supabase. |
| 6 | Orchestration / AI loop | **Supabase Edge Functions** (Deno + Anthropic SDK). הלולאה לקריאת Claude, חילוץ זיכרון, ותיוג חיים בקוד שב־`supabase/functions/`, לא ב־n8n. |
| 7 | Auth | **email/password, ניהול משתמשים מהמסך.** מ־migration 0018: ה־reads של לידים נעולים ל־admin בלבד. |
| 8 | TypeScript | **Strict mode.** אסור `any`. |
| 9 | CI | **typecheck + lint + build על כל PR** (`ci.yml`, job `verify`: `bun x tsc --noEmit` → `bun run lint` → `bun run build`). Branch protection ב-main. ⚠️ **טסטים לא רצים ב-CI** — לא vitest ולא טסטי Deno. חייבים `bun run test` ידני. |
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
- **AI** (מזהי המודלים המדויקים בקוד):
  - **`claude-sonnet-4-6`** — תשובת הסוכן (`_shared/whatsappWebhookHandler.ts`), חילוץ brain (`brain-ingest`), `prompt-replay`
  - **`claude-haiku-4-5`** — semantic judge (`judgeReply.ts`), memory extractor (`extractMemory.ts`)
  - **`claude-haiku-4-5-20251001`** — `prompt-coach` (**מוצמד לתאריך**; הועבר מ-Sonnet 4.6 ל-Haiku 4.5 ב-2026-05-20). זה המזהה היחיד עם pin
  - **OpenAI Whisper** — voice note transcription (he) ב־`transcribeVoice.ts`
- **Orchestration / AI loop**: Supabase Edge Functions (Deno) — **18 פונקציות**, ראה הסעיף הבא.
- **Observability**: Langfuse Cloud — כל קריאת Claude נשמרת כ־trace. `error_logs` + `failed_messages` ב־Postgres לכשלים ולתור שחזור.
- **WhatsApp BSP**: HookMyApp Cloud API — **שני ערוצים**:
  - `affiliate_marketing` — WABA `1001103162575975` (`+972 55-991-7038`, "מכללת ריצ׳ר ליזמות דיגיטלית")
  - `digital_marketing` — `+972 55-711-3830`, `whatsapp_phone_number_id` `1183645111502568` (secrets בסיומת `_DM`)
- **External integrations**: Make.com (handoff fan-out → Mooz, Fireberry CRM, alerts · `conversation-opened` webhook), Mooz (הזמנת זום דרך tool-use + webhook נכנס), Fireberry (קריאה ישירה מ־`_shared/fireberry.ts` לבדיקת תלמיד רשום / רשימה שחורה).
- **Hosting**: **Vercel** — auto-deploy מ־`main` (`richer-ai-agents-hub.vercel.app`)
- **Package Manager**: bun (`~/.bun/bin/bun`)
- **Testing**: vitest + @testing-library/react + Deno tests ב־`_shared/*.test.ts`

---

## Edge Functions בפרוד (18)

| Function | טריגר | תפקיד | אימות | `--no-verify-jwt` |
|---|---|---|---|---|
| **whatsapp-webhook** | HookMyApp POST (ערוץ affiliate) | entrypoint דק (18 שורות) מעל `_shared/whatsappWebhookHandler.ts`: inbound + agent loop + memory + handoff | HMAC `X-HookMyApp-Signature-256` מול `VERIFY_TOKEN` | ✅ חובה |
| **whatsapp-webhook-dm** | HookMyApp POST (ערוץ digital_marketing) | **אותו handler בדיוק**, 19 שורות. "DM" = digital marketing, **לא** Instagram. נבדל ב-5 ערכים: 4 secrets בסיומת `_DM` + `agentName` מקובע | HMAC מול `VERIFY_TOKEN_DM` | ✅ חובה |
| **whatsapp-send** | Dashboard ReplyBox | שליחה ידנית של אופרטור — עוקפת את ה-loop; פותרת credentials לפי ערוץ הסוכן | `requireAdmin` | ❌ |
| **conversation-set-mode** | Dashboard toggle | AI ⇄ manual: כותב/מנקה `manual_mode_since` + `manual_mode_by` | `requireAdmin` | ❌ |
| **conversation-view** | דף `/embed/c` (iframe ב-Fireberry) | JSON API **ציבורי** — שרשור השיחה (עד 500 הודעות), read-only | **ללא JWT** — HMAC `sig` מול `EMBED_LINK_SECRET`, אחרת 403 | ✅ |
| **broadcast-enqueue** | דף "דיוור" (admin) | דיוור רחב: בונה קהל (שיחות נבחרות / כל הלידים / CSV) + suppression → שורת `broadcasts` + הזרקה ל-`scheduled_messages` | `requireAdmin` | ❌ |
| **lead-register** | Make.com (landing page) | קליטת ליד + enqueue first-touch template + `conversation_view_url` | Bearer `LEAD_REGISTER_SHARED_SECRET` | ✅ |
| **mooz-webhook** | Mooz booking events | `created` → tag + handoff · `cancelled` → `requires_human` · `rescheduled` → עדכון זמן. אידמפוטנטי דרך `mooz_webhook_events` | Bearer `MOOZ_WEBHOOK_SECRET` + HMAC `X-Mooz-Signature-256` | ✅ |
| **dispatch-scheduled-templates** | pg_cron כל דקה | שליחת templates מתוזמנים: claim אטומי (v3), quiet hours, re-check opt-out/tags, דחייה ב-manual mode. רב-ערוצי | Bearer `CRON_SHARED_SECRET` | ✅ |
| **re-engage-cold-leads** | pg_cron | נודניק חד-פעמי ללידים ששתקו 24h–7d (`re_engaged_at IS NULL`) | Bearer `CRON_SHARED_SECRET` | ✅ |
| **brain-sweep-stale** | pg_cron כל 10 דק׳ | מסמן `brain_documents` תקועים (>20 דק׳ pending) כ-failed | Bearer `CRON_SHARED_SECRET` | ✅ |
| **brain-ingest** | Admin upload | חילוץ טקסט מ-PDF/תמונה (Sonnet 4.6) ברקע + `injectionScan` | `requireAdmin` | ❌ |
| **prompt-coach** | Admin chat | Coach מציע החלפת prompt דרך tool `propose_prompt_edit`. **לא** כותב ל-`prompts` | `requireAdmin` | ❌ |
| **prompt-coach-apply** | Admin approve | מוסיף גרסה חדשה ל-`prompts` עם `is_active=true` ומכבה את הקודמת | `requireAdmin` | ❌ |
| **prompt-replay** | Admin A/B | מריץ prompt מועמד על שיחה היסטורית (עד 30 תורות) side-by-side + עלות | `requireAdmin` | ❌ |
| **dlq-replay** | Admin button | retry ל-`failed_messages` (יחיד לפי `id` או batch, `retry_count < 3`) | `requireAdmin` | ❌ |
| **invite-user** | Admin | הזמנת משתמש + קביעת `role`/`full_name` ב-`app_users` | `requireAdmin` | ❌ |
| **delete-user** | Admin | מחיקה מ-`auth.users` (cascade). מסרב למחוק את עצמך | `requireAdmin` | ❌ |

> אין `[functions]` block ב-`supabase/config.toml` — `--no-verify-jwt` הוא **החלטת deploy**, לא הצהרה בקוד. העמודה למעלה = מה שנדרש לוגית לפי מודל האימות שבקוד.

ראה [supabase/functions/README.md](./supabase/functions/README.md) לפירוט deploy/secrets.

---

## Shared utilities (`supabase/functions/_shared/`)

**37 מודולים + 24 קבצי `*.test.ts`.** `whatsappWebhookHandler.ts` הוא הלב (~1950 שורות) ומשותף לשני ה-entrypoints.

| קובץ | תפקיד | טסט |
|---|---|---|
| `whatsappWebhookHandler.ts` | **הלב** — קליטת webhook + לופ agent שלם. משותף ל-`whatsapp-webhook` ו-`whatsapp-webhook-dm` | — |
| `agentTurn.ts` | עוטף `anthropic.messages.create` בלופ tool-use (Mooz) עד תשובת טקסט סופית | — |
| `auth.ts` | `requireUser` / `requireAdmin` / `HttpError` / `jsonResponse` | — |
| `cors.ts` | CORS headers ל-preflight | — |
| `logError.ts` | כתיבה מובנית ל-`error_logs` (non-blocking) | — |
| `dlq.ts` | כתיבת שורה ל-`failed_messages` | — |
| `truncate.ts` | חיתוך טקסט בטוח ל-DB columns / לוגים | ✅ |
| `validation.ts` | `isUuid` וכו' — ולידציה לפני אינטרפולציה ל-PostgREST `.or()` | — |
| `whatsappSend.ts` | `sendWhatsAppText` — שליחה ב-HookMyApp + backoff/timeout | ✅ |
| `transcribeVoice.ts` | תמלול הודעות קוליות בעברית (Whisper) | — |
| `anthropicRetry.ts` | retry על 429/5xx/529 עם כיבוד `retry-after` | ✅ |
| `validateAgentReply.ts` | regex hallucination guards | ✅ |
| `judgeReply.ts` | LLM-as-judge (`claude-haiku-4-5`) לפני שליחה | — |
| `guardHint.ts` | hint reason-aware ל-system prompt בניסיון השני אחרי דחיית guard | ✅ |
| `zoomGate.ts` | רצפת הכשרה דטרמיניסטית לפני חשיפת כלי ההזמנה | ✅ |
| `extractMemory.ts` | חילוץ `lead_memory` + funnel stage + החלטת handoff | ✅ |
| `brainContext.ts` | טעינה + פירמוט של `brain_documents` ל-system prompt | ✅ |
| `injectionScan.ts` | זיהוי prompt injection ב-brain uploads | ✅ |
| `mooz.ts` | קליינט Mooz — `list_available_slots` / `book_meeting` / `lookupByPhone` + `moozClientFromEnv` | ✅ |
| `moozTools.ts` | הגדרות tools ל-Anthropic + dispatcher | ✅ |
| `moozBookingSource.ts` | סיווג מקור ההזמנה: כלי הבוט מול הזמנה עצמית בדף Mooz | ✅ |
| `bookingStatusBlock.ts` | predicate `shouldPreCheckMooz` + בניית בלוק סטטוס הזמנה ל-prompt | ✅ |
| `fireberry.ts` | קליינט Fireberry — חסימת auto-book לתלמיד רשום (statuscode 2) / רשימה שחורה (11) | ✅ |
| `quietHours.ts` | חלון שתיקה פר-סוכן (Asia/Jerusalem, wrap-midnight) | — |
| `ilTime.ts` | UTC ISO → שעון ישראל `HH:MM` (guard לשעות מומצאות) | — |
| `normalizePhone.ts` | `toCanonicalPhone` — ספרות + 972, בלי `+` | ✅ |
| `optOut.ts` | זיהוי בקשת הסרה מטקסט inbound | ✅ |
| `optOutFilter.ts` | pure — פיצול שורות dispatcher ל-safe / opted-out | ✅ |
| `optedOutLookup.ts` | שאילתת `opt_outs` סובלנית לפורמטי טלפון | ✅ |
| `broadcastRecipients.ts` | pure — בניית קהל דיוור + suppression breakdown | ✅ |
| `embedLink.ts` | חתימה/אימות HMAC של ה-embed URL (`phone\|product`) | ✅ |
| `fireConversationOpenedWebhook.ts` | POST ל-Make.com בפתיחת שיחה → כתיבת iframe ל-CRM | ✅ |
| `fireHandoffWebhook.ts` | POST חתום "ליד הוכשר" ל-Make.com | ✅ |
| `alertOperators.ts` | WhatsApp alert ל-`operator_alert_phones` על כשל קריטי | — |
| `langfuse.ts` | קליינט Langfuse (trace+generation לכל turn) + `computeSonnet46Cost` | ✅ |
| `moozCheck.ts` | ⚠️ **DEAD** — 0 imports מחוץ לטסט שלו. הוחלף ב-`mooz.ts` + `bookingStatusBlock.ts` | ✅ |
| `whatsappTemplateSend.ts` | ⚠️ **DEAD** — 0 imports. `dispatch-scheduled-templates` שולח templates ב-`fetch` inline | — |

> מחוץ ל-`_shared`: `conversation-set-mode/validate.ts` (+ טסט) — ולידציית payload מקומית.

---

## מבנה תיקיות

```
.
├── .github/workflows/      # GitHub Actions (CI)
├── public/                 # static assets
├── src/
│   ├── components/
│   │   ├── layout/         # AppLayout, AppSidebar, AppHeader, AgentSelector
│   │   ├── ui/             # shadcn primitives (49 קבצים)
│   │   ├── dashboard/      # KpiCard · FunnelBreakdownChart · TagBreakdownList · RecentLeadsList
│   │   ├── leads/          # badges + StatusFilterChips · DateRangeFilter · CopyPhoneButton
│   │   ├── analytics/      # CostLatency · Objections · AiProviders · Experiment · InsightsCards · TemplateFunnelCard
│   │   ├── conversations/  # MessageThread · ReplyBox · LeadMemoryPanel · ManualModeBar · AddToBrainDialog
│   │   ├── prompts/        # PromptViewDialog · PromptReplayDialog
│   │   ├── coach/          # רק BrainPanel.tsx — לוגיקת הצ׳אט inline ב-pages/Coach.tsx
│   │   ├── settings/       # AgentsTab · AgentForm · UsersTab · InviteUserDialog · BroadcastTemplatesTab · DlqTab
│   │   ├── broadcasts/     # BroadcastComposer · BroadcastList
│   │   ├── auth/           # AdminOnly · ProtectedRoute
│   │   ├── effects/        # NoiseOverlay · Aurora · AnimatedNumber
│   │   ├── EmptyState.tsx · BrandLogo.tsx · NavLink.tsx
│   ├── contexts/
│   ├── hooks/
│   ├── lib/                # supabase client + queries (analytics, conversations, kpis, brain, coach,
│   │                       #   broadcasts, insights, template-funnel, embed, parseBroadcastCsv, dlq, ...)
│   ├── pages/              # 11 קבצים / 10 routes — ראה טבלת הדפים למטה
│   ├── types/              # database.ts (auto-generated)
│   └── test/               # vitest setup
├── supabase/
│   ├── migrations/         # 48 קבצים, 0001-0045 (ראה הסעיף הבא + כפילויות מספור)
│   ├── functions/          # 18 תיקיות (ראה הטבלה למעלה)
│   │   ├── _shared/        # 37 מודולים + 24 טסטים
│   │   └── README.md       # deploy + secrets פר-ערוץ
│   └── README.md
├── scripts/
│   ├── db/apply.ts         # db:apply
│   ├── prompts/sync.ts     # prompts:sync (+ sync.test.ts)
│   ├── seed/               # seed:test · seed:clear
│   ├── check-error-logs.ts # בדיקת error_logs
│   ├── wa-tunnel-proxy.mjs # wa:proxy
│   └── admin/              # provision-admin · health-check · zoom-handoff-diag
│                           #   · backfill-conversation-view.py (הפייתון היחיד בריפו)
├── prompts/
│   ├── affiliate_marketing/
│   │   ├── _active.json    # { "main": "v18", "memory_extractor": "v2" }
│   │   ├── main/           # v1,v2,v3,v6,v7,v8,v11,v13..v18 (v4/v5/v9/v10/v12 לא נוצרו)
│   │   └── memory_extractor/ # v1..v3.md
│   └── digital_marketing/
│       ├── _active.json    # { "main": "v4", "memory_extractor": "v1" }
│       ├── main/           # v1..v4.md
│       └── memory_extractor/ # v1.md
├── vercel.json             # SPA rewrites + CSP frame-ancestors ל-Fireberry על /embed/*
└── CLAUDE.md
```

---

## דפים ו-routes

11 קבצים ב-`src/pages/`, **10 mounted** ב-`App.tsx`: 7 דפי אפליקציה מוגנים + `/login` + embed ציבורי + 404.

| קובץ | Route | הגנה |
|---|---|---|
| `Index.tsx` | `/` | ProtectedRoute — טאב `advanced` (אנליטיקס) רק ל-`isAdmin` |
| `Leads.tsx` | `/leads` | ProtectedRoute |
| `Conversations.tsx` | `/conversations`, `/conversations/:id` | ProtectedRoute |
| `Prompts.tsx` | `/prompts` | ProtectedRoute (rollback/apply מותנים ב-`isAdmin`) |
| `Coach.tsx` | `/coach` | ProtectedRoute + `AdminOnly` |
| `Settings.tsx` | `/settings` | ProtectedRoute + `AdminOnly` |
| `Broadcasts.tsx` | `/broadcasts` | ProtectedRoute + `AdminOnly` |
| `Login.tsx` | `/login` | ציבורי |
| `EmbedConversation.tsx` | `/embed/c` | **ציבורי, ללא auth** — HMAC בלבד (ראה נקודות מסוכנות) |
| `NotFound.tsx` | `*` | catch-all |
| `Analytics.tsx` | — | ⚠️ **orphan** — לא mounted, אין לו import. `/analytics` → `<Navigate to="/" />`; האנליטיקס מוזגה כטאב ב-`Index.tsx` |

---

## Migrations — 0001 עד 0045

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
| 0025_dispatcher_atomic_claim | `scheduled_messages.claimed_at` + index חלקי + פונקציית `claim_scheduled_messages()` (`SECURITY DEFINER`, `FOR UPDATE … SKIP LOCKED`). **לא** `claimed_by_cron_id` — עמודה כזו לא קיימת באף migration |

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

### Phase M2: Mooz, נירמול טלפון, manual mode (0029-0038)
| # | מה |
|---|---|
| 0029 | `conversations.last_inbound_at` + index יורד + backfill מ-`messages` — מבדיל "טמפלייט נשלח ולא ענו" מ-"ענו" |
| 0030 | data-only: `meeting_type_id` של affiliate מ-`'2'` ל-UUID (Mooz דורש UUID) |
| 0031 | טבלה `mooz_webhook_events` (idempotency log ל-webhooks מ-Mooz) + UNIQUE משולש + RLS |
| 0032 | data-only: תיקון `meeting_type_id` ל-`d637d916-…` — 0030 הצביע על סוג פגישה שגוי |
| 0033_conversation_manual_mode | `conversations.manual_mode_since` + `manual_mode_by` — השתלטות אופרטור עוצרת את הלופ |
| 0033_conversation_zoom_booked_by | `conversations.zoom_booked_by` + CHECK (`agent`/`self`/`consent_handoff`) — רק `agent` נחשב conversion |
| 0034 | `scheduled_messages.delivered_at` + `read_at` (מחזור החיים של Meta, נפרד מ-`status`) |
| 0035 | תיקון נתונים חד-פעמי: מאחד שיחות כפולות `+972` מול `972` (217 קבוצות בפרוד), מעביר child rows ל-survivor, ומנרמל כל `lead_phone` ל-digits-only. אין DDL |
| 0036 | `claim_scheduled_messages` **v2** — מוסיף quiet hours + `conversation_status`/`current_tag` ל-`RETURNS TABLE`, **ומסיר** `agent_meeting_check_url/enabled` (כאן מת ה-Mooz pre-check) |
| 0037 | re-add אידמפוטנטי של `manual_mode_*` — זהה ל-`0033_conversation_manual_mode` |
| 0038 | `claim_scheduled_messages` **v3** — מוסיף `conversation_manual_mode_since` כדי שה-dispatcher ידחה (ולא יבטל) טמפלייט בשיחה ידנית. **זו הגרסה החיה** |

### Phase M3: סוכן שני (0039-0041)
| # | מה |
|---|---|
| 0039 | data-only: INSERT מותנה של `digital_marketing` — "שיווק דיגיטלי" / תמיר, `+972557113830`, `phone_number_id=1183645111502568`, quiet 20→8, first-touch `series_marketing_1` |
| 0040 | `DROP CONSTRAINT IF EXISTS conversations_lead_phone_key` — מאפשר אותו ליד אצל שני סוכנים. `conversations_agent_phone_unique` (0010) נשאר |
| 0041 | `agents.mooz_product_code` + seed (`B`=affiliate, `R`=digital) — נשלח כ-Mooz `hidden_fields.product` |

### Phase N: Broadcast + analytics (0042-0045)
| # | מה |
|---|---|
| 0042 | `broadcasts` table + `broadcast_status_enum` + trigger `updated_at` + RLS admin-only (`is_admin()`) |
| 0043 | `broadcast_templates` registry (dropdown של templates מאושרים) + seed מ־`agents.first_touch_template_name` |
| 0044 | `scheduled_messages.broadcast_id` (nullable FK; הזרימה הקיימת נשארת NULL) |
| 0045 | פונקציית `template_funnel()` — אגרגציית משפך server-side (sent/delivered/read/answered/zoom/failed + אחוזים), dedup פר (template, phone). `SECURITY INVOKER`, GRANT ל-`authenticated`. מחליף שליפת 2000 שורות לדפדפן |

### ⚠️ כפילויות מספור — מי authoritative

שלושה מספרים מופיעים פעמיים, ואחת מהכפילויות היא אמיתית:

| מספר | קבצים | פסק דין |
|---|---|---|
| **0025** | `_conversation_agent_lock` · `_dispatcher_atomic_claim` | **שני שינויים שונים** (מנעול פר-שיחה מול claim של ה-dispatcher) — **שניהם authoritative** |
| **0027** | `_agent_quiet_hours` · `_meeting_consent` | **שני שינויים שונים**, טבלאות שונות — **שניהם authoritative** |
| **0033** | `_conversation_manual_mode` · `_conversation_zoom_booked_by` | **שני שינויים שונים**, עמודות שונות — **שניהם authoritative**. התנגשות המספר היא תאונת rebase |
| **0033 מול 0037** | `0033_conversation_manual_mode` · `0037_conversation_manual_mode` | **כפילות אמיתית — אותו DDL בדיוק.** 0037 הוא re-add אידמפוטנטי (`ADD COLUMN IF NOT EXISTS`) אחרי ש-0033 "אבד" ב-rebase. **Authoritative: 0037**; 0033 superseded. הרצת שניהם = no-op |

**אין migration tracking table.** `scripts/db/apply.ts` מחיל קובץ בודד דרך ה-Management API ולא רושם כלום — הסדר והאידמפוטנטיות הם באחריות מי שמריץ.

**דיוור רחב**: אדמין בונה דיוור דרך דף "דיוור" → `broadcast-enqueue` מזריק שורות ל־`scheduled_messages` וה־dispatcher הקיים שולח. **Suppression דו-שלבי**: ב־enqueue (opt_outs + tags חוסמים) וב־dispatcher לפני שליחה (opt_outs re-check). אפיון + תוכנית: `docs/superpowers/`.

---

## כללי עבודה

### Branches & PRs

- **`main`** = production. **Vercel** מ-deploy ממנו אוטומטית.
- **לא לעשות push ישיר ל-main.** Branch protection אוסר על זה.
- **שמות branches**: `feat/...` · `fix/...` · `chore/...`
- **PR title**: באנגלית, conventional commit style (`feat: add login screen`).
- **PR description**: summary + test plan.
- **לפני merge**: ה-CI חייב לעבור — `tsc --noEmit` + `lint` + `build`. **ה-CI לא מריץ טסטים**, לכן אם נגעת בקוד עם טסטים הרץ `bun run test` מקומית לפני ה-PR.

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

- כל Prompt חי כקובץ markdown ב-`prompts/<agent_name>/<type>/<version>.md`. **שתי תיקיות סוכן**: `affiliate_marketing` ו-`digital_marketing`, כל אחת עם `_active.json` נפרד.
- שינוי Prompt = שינוי קובץ → PR → merge → סקריפט סנכרון מעלה ל-DB.
- **שלוש דרכים להחליף את ה־active prompt**:
  1. `prompts:sync` עם `_active.json` מעודכן (PR workflow).
  2. כפתור ↺ Rollback בדף Prompts (admin, מיידי).
  3. `prompt-coach-apply` (admin אחרי שיחת coach).

### Edge Functions

- כל function ב־`supabase/functions/<name>/index.ts`. דנו, לא Node.
- Deploy: `bunx supabase functions deploy <name> [--no-verify-jwt] --project-ref juoglkqtmjsziieqgmhf`.
- **שמונה** פונקציות חייבות `--no-verify-jwt`: `whatsapp-webhook`, `whatsapp-webhook-dm`, `conversation-view`, `lead-register`, `mooz-webhook`, `dispatch-scheduled-templates`, `re-engage-cold-leads`, `brain-sweep-stale` (מאומתות דרך HMAC / Bearer shared secret / חתימת webhook חיצוני).
- כל השאר admin-only דרך `requireAdmin` — deploy רגיל, בלי הדגל.
- סודות: `bunx supabase secrets set --env-file <path>`.
- האגנט הראשי רץ ב־`whatsapp-webhook` כ־background task דרך `EdgeRuntime.waitUntil`.

### Testing

- **טסטים על הגרעין הקריטי בלבד**: queries, contexts, auth, KPIs, edge fn shared utilities.
- רוב הקבצים הקריטיים ב־`_shared/` כוללים test colocate (`*.test.ts`) — 24 מתוך 37 מודולים. הלוגיקה ה-pure (`optOutFilter`, `broadcastRecipients`, `normalizePhone`, `zoomGate`) מכוסה; ה-handler הגדול לא.
- אסור לטסט UI styling.
- ⚠️ **הרצה ידנית בלבד** — `bun run test` (vitest) וטסטי Deno של `_shared/` **לא רצים ב-CI**.

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
~/.bun/bin/bun run test    # vitest — חובה ידנית, ה-CI לא מריץ
~/.bun/bin/bun run build   # production build
```

### סקריפטי אדמין (`scripts/admin/`)

```bash
# הקמת אדמין / איפוס סיסמה (דורש SUPABASE_SERVICE_ROLE_KEY ב-.env.local)
bun run scripts/admin/provision-admin.ts <email> <password> [full_name]

bun run scripts/admin/health-check.ts        # בדיקת בריאות
bun run scripts/admin/zoom-handoff-diag.ts   # דיאגנוסטיקה של handoff זום
bun run scripts/check-error-logs.ts          # error_logs אחרונים
```

`SUPABASE_SERVICE_ROLE_KEY` עוקף RLS — רק ב-`.env.local` (gitignored), אף פעם לא עם prefix `VITE_`.

---

## משתני סביבה

### Client (build-time, public, ב־`.env`)
- `VITE_SUPABASE_URL`
- `VITE_SUPABASE_ANON_KEY`

### Server-side scripts (`.env.local`, gitignored)
- `SUPABASE_PROJECT_REF`, `SUPABASE_ACCESS_TOKEN`

### Edge function secrets (`.env.functions.local` לפיתוח, ב־Supabase secrets בפרוד)

**WhatsApp / HookMyApp — ערוץ affiliate_marketing:**
- `VERIFY_TOKEN` — Meta App Secret (HMAC)
- `WHATSAPP_API_URL`, `WHATSAPP_ACCESS_TOKEN`, `WHATSAPP_PHONE_NUMBER_ID`
- `HOOKMYAPP_AGENT_NAME` — slug ב־`agents.name` ליחוס לידים נכנסים (fallback; השיוך העיקרי לפי `whatsapp_phone_number_id`)

**WhatsApp / HookMyApp — ערוץ digital_marketing (`_DM`):**
- `VERIFY_TOKEN_DM` — HMAC של הערוץ השני
- `WHATSAPP_API_URL_DM`, `WHATSAPP_ACCESS_TOKEN_DM`, `WHATSAPP_PHONE_NUMBER_ID_DM`
- נקראים ב־`whatsapp-webhook-dm`, `whatsapp-send`, `dispatch-scheduled-templates`

**Shared secrets (Bearer) — הפונקציות הציבוריות:**
- `CRON_SHARED_SECRET` — pg_cron → `dispatch-scheduled-templates`, `re-engage-cold-leads`, `brain-sweep-stale`
- `LEAD_REGISTER_SHARED_SECRET` — Make.com → `lead-register`
- `MOOZ_WEBHOOK_SECRET` — Bearer **וגם** מפתח ה-HMAC של `X-Mooz-Signature-256` ב-`mooz-webhook`
- `EMBED_LINK_SECRET` — HMAC של ה-embed URL (`conversation-view`, `lead-register`, ה-handler)

**AI:**
- `ANTHROPIC_API_KEY` — `sk-ant-...`
- `OPENAI_API_KEY` — לתמלול voice notes (Whisper)

**Observability:**
- `LANGFUSE_PUBLIC_KEY`, `LANGFUSE_SECRET_KEY`, **`LANGFUSE_BASE_URL`**
- ⚠️ בעבר תועד כאן `LANGFUSE_HOST` — **השם הזה לא נקרא בשום מקום בקוד**. הקוד (`_shared/langfuse.ts`) קורא `LANGFUSE_BASE_URL`

**Handoff fan-out + CRM:**
- `HANDOFF_WEBHOOK_URL` — Make.com scenario URL
- `HANDOFF_WEBHOOK_SECRET` — HMAC לחתימת הקריאה
- `CONVERSATION_OPENED_WEBHOOK_URL` — Make.com בפתיחת שיחה (כתיבת iframe לכרטיס Fireberry)
- `DASHBOARD_BASE_URL` — בסיס ה-URL לקישורי דשבורד/embed
- `FIREBERRY_API_TOKEN` — `_shared/fireberry.ts`, בדיקת תלמיד רשום / רשימה שחורה

**שונות:**
- `WHATSAPP_BOT_PHONE` + `WHATSAPP_PHONE_NUMBER_DISPLAY` — טלפון הבוט ב-`alertOperators.ts` (שלא ישלח התראה לעצמו)
- `HOOKMYAPP_SANDBOX_ECHO` — דגל `"true"` למצב echo בסנדבוקס

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

## מצב נוכחי (2026-07-28)

### מה קיים ועובד

**Production WhatsApp pipeline:**
- HookMyApp Cloud API, **שני ערוצים חיים**: affiliate (WABA `1001103162575975`, `+972 55-991-7038`) ו-digital marketing (`+972 55-711-3830`).
- שיחה דו־כיוונית מאומתת end-to-end עם הטלפונים האמיתיים.
- **18 edge functions** בייצור, **45 migrations** (48 קבצים) applied.
- Prompts פעילים: `affiliate_marketing` → `main/v18` + `memory_extractor/v2`; `digital_marketing` → `main/v4` + `memory_extractor/v1`.
- Hosting: Vercel (auto-deploy מ-`main`).

**Phase A-E (תועד מראש):**
- Idempotency, DLQ, error_logs, Langfuse traces, memory extractor, funnel + handoff, prompt rollback + replay.

**Phase F — Prompt Coach:**
- צ׳אט אדמין עם `claude-haiku-4-5-20251001` (הועבר מ-Sonnet 4.6 ב-2026-05-20) שמציע שיפורים ל־prompt קיים.
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

**Phase N — Multi-agent אמיתי (סוכן `digital_marketing` / תמיר):**
- רפקטור ה-webhook ל-handler משותף (`_shared/whatsappWebhookHandler.ts`) + entrypoint דק פר-ערוץ.
- migration 0039 (שורת הסוכן), prompts `digital_marketing v1..v4`, ניתוב outbound ו-dispatch לפי ערוץ הסוכן.
- 0040 הסרת ה-unique הגלובלי על הטלפון — אותו ליד יכול להיות אצל שני סוכנים.

**Phase O — דיוור רחב (Broadcast, PR #88):**
- `broadcast-enqueue` + migrations 0042-0044 + דף `/broadcasts` (composer + list) + parser CSV + `BroadcastTemplatesTab`.
- Suppression דו-שלבי: ב-enqueue (opt-out + tags חוסמים) וב-dispatcher לפני שליחה (re-check).

**Phase P — Embed שיחה בכרטיס ליד ב-Fireberry (PR #90 + #92):**
- `embedLink.ts` לחתימת URL ב-HMAC, edge fn `conversation-view` (HMAC gate, לא JWT), דף ציבורי `/embed/c` read-only.
- CSP `frame-ancestors` ל-Fireberry ב-`vercel.json`; `lead-register` מחזיר `conversation_view_url`; backfill חד-פעמי.
- webhook `conversation-opened` (מ-inbound חדש ומ-`lead-register`, נשמר חי דרך `waitUntil`).

**Phase Q — Mooz booking, שער זום וייחוס (PR #91 + #94):**
- `zoomGate.ts` — רצפת הכשרה דטרמיניסטית + bypass לבקשה מפורשת; prompts v17→v18.
- `mooz-webhook` נכנס (created/cancelled/rescheduled) עם אידמפוטנטיות דרך `mooz_webhook_events`.
- `moozBookingSource.ts` + `zoom_booked_by` — הפרדה בין הזמנה של הבוט להזמנה עצמית (רק `agent` = conversion).
- 0041 `mooz_product_code` → `hidden_fields.product` לניתוב Fireberry; gate ללקוח קיים דרך `_shared/fireberry.ts`.
- הבוט **ממשיך לענות** גם אחרי שנקבע זום (שינוי התנהגות מ-PR #94).

**Phase R — אמינות dispatcher + manual mode + analytics (PR #96):**
- claim v2/v3 (0036/0038), delivery status (0034), dedup לפי טלפון (0035), נירמול קנוני (`normalizePhone.ts`).
- manual mode: 0033/0037 + `ManualModeBar` + edge fn `conversation-set-mode`; ה-dispatcher **דוחה** טמפלייט בשיחה ידנית.
- 401/403 מ-HookMyApp = שגיאת auth טרמינלית עם alert מיידי.
- משפך טמפלייט/דיוור מחושב server-side ב-RPC (0045) — תיקן `answered/zoom=0` בדשבורד.

### מה חסר / בעבודה

- **טבלת `advisors` מאוכלסת** — היום ריקה. אופרטור משייך ידנית; round-robin אוטומטי בעתיד.
- **Auto-scoring על prompt replay** (LLM-as-judge על golden dataset + CI block).
- **Pilot 50 לידים בתנועה אמיתית** — תשתית מוכנה, ממתינים לאישור פתיחת קמפיין.
- **טסטים ב-CI** — קיימים בריפו, לא רצים ב-workflow.
- **חוב טכני מתועד**: replay של migrations על DB נקי נשבר (ראה נקודות מסוכנות), `Analytics.tsx` orphan, שני קבצי `_shared` מתים, ועמודות `agents.meeting_check_*` (0024) נשארו אחרי שה-pre-check הוסר.

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

ראה את ה־Prompt המלא ב־[prompts/affiliate_marketing/main/v18.md](./prompts/affiliate_marketing/main/v18.md) (פעיל היום).

## הקשר ייחודי לסוכן השני

- **שם**: שיווק דיגיטלי — פרסונה **"תמיר"** (`digital_marketing`)
- **טלפון**: `+972 55-711-3830` · `whatsapp_phone_number_id` `1183645111502568`
- **Mooz**: `meeting_type_id` `d44fe2dc-…`, `mooz_product_code = R` (מול `B` של affiliate)
- **first-touch template**: `series_marketing_1`, שעות שתיקה 20→8
- Prompt פעיל: [prompts/digital_marketing/main/v4.md](./prompts/digital_marketing/main/v4.md)

---

## נקודות מסוכנות

- **לידים = אנשים אמיתיים.** באג ב-flow של WhatsApp = הודעה שגויה לליד = פגיעה במכללה. תמיד בדוק.
- **חוק הספאם הישראלי**: יש לקבל אישור מהליד לפני שליחה. אישור הוטמע בטופס landing page (lead-register).
- **Multi-tenancy**: כל קוד צריך להיות agent-aware (מסונן לפי `activeAgent.id`). **שני סוכנים חיים בפרוד** — הנחה של סוכן יחיד היא באג, לא קיצור דרך. גם ה-secrets, ה-templates וה-prompts הם פר-ערוץ.
- **Prompt = רגיש**. שינוי בלא בדיקה יכול לגרום לבוט לדבר באופן שגוי. תמיד PR-review. בנוסף: Rollback בדף Prompts (admin) מאפשר חזרה מהירה.
- **Hallucination guards** + **judgeReply**: שכבת safety-net דו־רובדית, אבל לא תחליף ל־PR-review של ה־prompt.
- **RLS**: בלי policies נכונות, anon read מחזיר רשימה ריקה. בדוק policies אחרי כל שינוי סכמה. מ־0018: לידים = admin only.
- **`VERIFY_TOKEN` rotation**: בייצור — מסונכרן עם Meta App Secret. אם דולף, כל אחד יכול להזריק הודעות חתומות.
- **Service-role ב־edge function**: `whatsapp-webhook` רץ עם service_role (עוקף RLS). לא לחשוף את ה־service_role בקוד הקליינט.
- **`--no-verify-jwt` על public functions**: 8 פונקציות (שני ה-webhooks של WhatsApp, `conversation-view`, `lead-register`, `mooz-webhook`, ושלוש ה-cron). לכל אחת שכבת הגנה משלה (HMAC / Bearer shared secret) — אם נשבר אימות באחת מהן, היא חשופה לחלוטין לאינטרנט.
- **Fail-open על POST ללא חתימה ב־webhook**: כדי לעבור verification ping של HookMyApp. הוא **לא** מעבד payload במצב הזה.
- **ה-Mooz pre-check ב-dispatcher מת** (מ-0036). מה שקיים היום הוא `bookingStatusBlock.ts` בתוך ה-prompt של הלופ, לא שער fail-closed לפני שליחת טמפלייט. העמודות `agents.meeting_check_url` / `meeting_check_enabled` (0024) נשארו בטבלה אבל אף אחד לא קורא אותן. **אל תסתמך על "לא נשלח אם Mooz לא עונה"** — זה לא המצב.
- **Langfuse keys**: 3 keys נפרדים (`PUBLIC` / `SECRET` / **`BASE_URL`**). אם מודבקים יחד → trace יכשל.
- **Hebrew regex word boundary**: ב־JS `\b` לא תופס תווי עברית. בכל regex של hallucination guard בעברית — **לא** להשתמש ב־`\b`.
- **kill switch**: `agents.is_paused=true` עוצר את ה־AI loop אבל inbound עדיין נכנס. אם אופרטור משאיר paused לזמן ארוך — היסטוריה נצברת בלי תגובות.
- **quiet hours**: שעות wrap-midnight (20→8) מטופלות נכון. אל תוסיף timezone אחר חוץ מ־Asia/Jerusalem בלי לעדכן את quietHours.ts.
- **agent_lock TTL**: 60 שניות. אם מודל מתמשך מעל 60s (Sonnet 4.6 עם thinking) — webhook מקביל יכול לקחת lock וליצור double-reply. הקאפ של 110s על Anthropic SDK (PR #65) מקטין את הסיכון אבל לא מבטל. נטר ב־Langfuse.
- **brain context size**: brain_documents נטענים לתוך system prompt. cap של 200K chars total + 40K per doc. מסמך מאוד גדול ידחק היסטוריה.
- **URL חתום של `/embed/c` = סוד.** הדף ציבורי לחלוטין (מחוץ ל-`ProtectedRoute`); השער היחיד הוא חתימת HMAC ב-query params. מי שמחזיק URL חתום רואה **תמלול שיחה מלא של ליד** בלי להתחבר (read-only). ה-CSP מגביל iframe ל-Fireberry, אבל לא חוסם פתיחה ישירה בדפדפן. אין תוקף/expiry לחתימה — רוטציה של `EMBED_LINK_SECRET` היא הדרך היחידה לבטל לינקים שדלפו.
- **replay של migrations על DB נקי נשבר.** `0036`/`0038` משתמשים ב-`CREATE OR REPLACE` בזמן שהם משנים את `RETURNS TABLE` של `claim_scheduled_messages` — Postgres מסרב (42P13 "cannot change return type"), ואין `DROP FUNCTION` באף migration. הפרוד עובד כי מישהו הפיל את הפונקציה ידנית. **הרמת סביבה חדשה מהקבצים תיפול** — צריך `DROP FUNCTION IF EXISTS public.claim_scheduled_messages(int, timestamptz, int);` לפני ה-CREATE.
- **אין migration tracking + יש מספרים כפולים.** שום דבר לא רושם מה הוחל. לפני שמוסיפים migration — בדוק את המספר הגבוה בפועל, וכתוב אידמפוטנטי (`IF NOT EXISTS`), כי אין ערובה שלא ירוץ פעמיים.
- **`mooz_webhook_events` פתוח לקריאה לכל משתמש מחובר** (`SELECT … TO authenticated USING (true)` ב-0031) — לא עקבי עם 0018 (לידים = admin only) ולא עם 0042/0043 שמשתמשות ב-`is_admin()`.
- **`0040` מפיל constraint שאף migration לא יצר** (`conversations_lead_phone_key`) — כלומר סכימת הפרוד לא נגזרת במלואה מהקבצים בריפו. יש drift; אל תניח שהריפו הוא התמונה המלאה של ה-DB.
- **0035 נרמל טלפונים אבל לא אוכף נירמול** — אין CHECK/unique על הצורה הקנונית. כותב חדש שיכתוב `+972…` יחזיר את הכפילויות. השתמש תמיד ב-`toCanonicalPhone` מ-`_shared/normalizePhone.ts`.
- **`template_funnel` הוא `SECURITY INVOKER` עם GRANT ל-`authenticated`** — משתמש לא-admin יקבל **אפסים** במקום שגיאת הרשאה. נראה כמו באג נתונים, זה בעצם RLS.
- **טסטים לא רצים ב-CI.** PR ירוק לא אומר שהטסטים עוברים.

---

## חומרי עזר

- **מסמך אפיון מלא v2.0** (42 עמודים, 25 פרקים) — נמצא אצל המשתמש; לא בריפו.
- **מסמך העברה** — נמצא אצל המשתמש.
- **תכנית Lovable** — `.lovable/plan.md` בריפו (היסטורי — Lovable כבר לא מארח ולא כותב).
- **`docs/n8n-migration-handoff.md`** — ⚠️ **מסמך היסטורי (2026-05-03)**. תיאור העברה של הלופ ל-n8n ש**לא בוצעה**. ההחלטה בתוקף היא #6: הלופ חי ב-Edge Functions. אל תתייחס אליו כתכנית פעילה.
- **אפיונים ותוכניות** ב-`docs/superpowers/` — 7 specs + 5 plans: mooz-pre-check (05-26), booking-dedup-and-handoff-attribution (05-27), manual-mode-toggle (05-27), template-funnel-analytics (06-07), digital-marketing-agent (07-02), whatsapp-broadcast (07-09), conversation-view-embed (07-13).
- **Repo**: https://github.com/RicherLTD/richer-ai-agents-hub
- **Production**: https://richer-ai-agents-hub.vercel.app
