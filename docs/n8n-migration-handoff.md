# מסמך העברה — סוכן AI ל-n8n

> Handoff למפתח שבונה את הסוכן ב-n8n. כל מה שצריך כדי להרכיב את ה-workflow בלי גישה לקוד הנוכחי.
>
> **גרסה**: 1.0 · **תאריך**: 2026-05-03 · **לקוח**: מכללת ריצ'ר — תכנית שיווק שותפים (האחים סיטון)

---

## 1. סקירה כללית

המערכת היא **בוט WhatsApp אוטונומי** שמטפל בלידים נכנסים מקמפיינים ממומנים. המטרה של הבוט: לתאם פגישת זום עם יועץ לימודים. **לא** מכירה ישירה.

**נפח צפוי**: 2,000+ לידים/חודש.

**מצב היום**: הסוכן רץ בתור Supabase Edge Function (Deno) — `whatsapp-webhook`. **המעבר ל-n8n מחליף את ה-Edge Function בלבד.** ה-DB, הדשבורד, וה-WhatsApp BSP (HookMyApp) נשארים.

### דיאגרמה — מצב יעד אחרי המעבר

```
WhatsApp user
     ↕
Meta Cloud API (sandbox: HookMyApp)
     ↕  webhook (signed HMAC-SHA256)
HookMyApp forwarder
     ↕
n8n Cloud workflow ⬅ זה מה שאנחנו בונים
     ↑↓ service_role
Supabase Postgres ← נשאר כמו שהוא
     ↑
Dashboard (Lovable hosted) — read-only על הנתונים
```

---

## 2. מה רץ עכשיו (מצב לפני המעבר)

### 2.1 רכיבים פעילים

| רכיב | טכנולוגיה | תפקיד |
|---|---|---|
| Dashboard | Vite + React + Supabase | קריאת לידים, שיחות, KPIs, Reply Box ידני |
| `whatsapp-webhook` | Supabase Edge Function (Deno) | **הסוכן עצמו** — מקבל webhook + מייצר תגובה ב-Claude + שולח חזרה |
| `whatsapp-send` | Supabase Edge Function (Deno) | שליחה ידנית מה-Reply Box (השתלטות אנושית) — **נשאר, לא מועבר** |
| `invite-user`, `delete-user` | Supabase Edge Functions | ניהול משתמשי דשבורד (admin) — **נשאר** |
| Supabase Postgres | DB מנוהל | conversations, messages, lead_memory, prompts, agents, advisors |
| HookMyApp | WhatsApp BSP | sandbox היום, production WABA בעתיד |

### 2.2 פלואו ה-AI הנוכחי (ב-Edge Function)

ה-`whatsapp-webhook` עושה את הסט הבא בכל POST נכנס:

1. **GET** = challenge — מחזיר את `VERIFY_TOKEN` כ-text
2. **POST** = הודעה נכנסת:
   1. אימות `X-HookMyApp-Signature-256` כ-`sha256=<HEX>` של `HMAC-SHA256(VERIFY_TOKEN, raw_body)` — דחיית 401 אם לא מתאים
   2. parse של ה-payload (פורמט Meta — `entry[].changes[].value.messages[]`)
   3. לכל הודעה:
      - `upsert conversation` לפי `(agent_id, lead_phone)`
      - `insert message` (direction=`inbound`)
      - `update conversations.last_interaction_at`
   4. **ברקע** (`EdgeRuntime.waitUntil`) — לכל שיחה שקיבלה הודעת **טקסט**:
      - מעמיס prompt פעיל (`prompts` where `is_active=true and agent_id=...`)
      - מעמיס 30 הודעות אחרונות (asc, מיפוי inbound→user / outbound→assistant)
      - **בלם race** — אם ההודעה האחרונה במערך היא `assistant`, מדלג (כבר ענינו)
      - קורא ל-Claude — `claude-sonnet-4-6`, `max_tokens=1024`, `thinking: { type: "adaptive" }`, `system=prompt.content`
      - `POST` ל-HookMyApp send (פורמט Meta)
      - `insert message` (direction=`outbound`) + `update conversations.last_interaction_at, prompt_version_used`
   5. מחזיר 200 ל-HookMyApp **מיד** (התגובה רצה ברקע)

### 2.3 בלמים שכבר קיימים בקוד

חשוב לשמר אותם ב-n8n:

- **תגובה אחת לשיחה לכל webhook** — אם ליד שלח 3 הודעות באותו batch, יש תגובה אחת בלבד (`Map<conversationId, leadPhone>` ייחודי)
- **רק הודעות טקסט מפעילות תגובה** — `image`, `audio`, `sticker`, `video`, `document` נשמרים כ-`[image]` placeholder ב-content, אבל לא מעוררים את הסוכן
- **race guard** — אם history מסתיים ב-assistant (לא user), לא עונים שוב
- **Best effort על ה-AI** — אם Claude נופל / HookMyApp נופל — הודעת inbound כבר נשמרה ב-DB. ה-failure רק מונע את התגובה. אסור שכשל יחיד יפיל את כל ה-webhook
- **ANTHROPIC_API_KEY חסר = השבתה רכה** — אין תגובה אבל הודעות נכנסות נכנסות ל-DB

---

## 3. מה לא מומש עדיין (חייב להיכנס ל-n8n)

מאחורי המעבר ל-n8n עומדת גם הזדמנות לסגור את הפיצ'רים החסרים. רשימה לפי סדר עדיפות:

### 3.1 חובה לפרודקשן

- [ ] **Idempotency על `meta_message_id`** — אם Meta יעשה retry על אותה הודעה, היא תוכפל ב-DB ויגרום לתגובה כפולה. שדה `meta_message_id` UNIQUE ב-`messages` + lookup לפני insert
- [ ] **Opt-out gate** — לפני שמייצרים תגובה, לבדוק `opt_outs.lead_phone`. אם הליד opted out — לא להגיב
- [ ] **Memory extractor** — קריאת Claude שנייה ב-JSON mode אחרי כל תור שממלאת את `lead_memory` (q1..q6, conversation_summary, primary_objection, red_flags, notes_for_advisor)
- [ ] **Funnel/Tag classifier** — היום `funnel_stage` ו-`current_tag` מתעדכנים ידנית. הסוכן צריך להזיז אותם בעצמו על בסיס הזיכרון
- [ ] **Zoom handoff** — כשכל 5 השאלות נענו והליד מתאים: הודעת מסירה, `current_tag='zoom_scheduled'`, `assigned_advisor_id`, `status='paused'`

### 3.2 רצוי אבל לא חוסם

- [ ] **Debounce/coalesce** של הודעות רצופות — אם הליד שולח 3 הודעות ב-5 שניות, להמתין ולהגיב פעם אחת לכולן (ב-Edge Function זה נעשה ברמת ה-batch של webhook אחד; ב-n8n אפשר window רחב יותר)
- [ ] **Realtime updates בדשבורד** — Supabase Realtime channel על `messages` (לא n8n; שינוי בדשבורד)

### 3.3 future (לא בסקופ של ה-handoff הזה)

- Google Calendar / Calendly אינטגרציה ליצירת event
- Fireberry CRM webhook על escalation
- Production WABA ישירות מ-Meta (`hookmyapp channels connect`)
- Multi-agent — היום סוכן יחיד פעיל

---

## 4. מודל הנתונים (Supabase)

**Project ref**: `juoglkqtmjsziieqgmhf`
**URL**: `https://juoglkqtmjsziieqgmhf.supabase.co`
**גישה מ-n8n**: דרך service_role key (עוקף RLS) או PostgREST עם service_role bearer

### 4.1 הטבלאות הקריטיות לסוכן

#### `agents`
| שדה | טיפוס | הערות |
|---|---|---|
| `id` | uuid | PK |
| `name` | text | slug — `affiliate_marketing` |
| `display_name` | text | "שיווק שותפים — האחים סיטון" |
| `status` | enum | `active` / `paused` / `archived` |
| `whatsapp_number` | text | מספר ה-BSP המוצמד לסוכן |
| `primary_goal` | text | לידיעת הפרומפט |

#### `conversations`
מפתח לוגי: `(agent_id, lead_phone)` — UNIQUE בפועל בקוד.

| שדה | טיפוס | הערות |
|---|---|---|
| `id` | uuid | PK |
| `agent_id` | uuid → agents | |
| `lead_phone` | text | E.164 (`+972...`) |
| `lead_name` | text | מ-`contacts.profile.name` ב-payload |
| `status` | enum | `active` / `paused` / `completed` / `opted_out` |
| `funnel_stage` | enum | `cold` / `mid` / `done` |
| `current_tag` | enum | `not_hotlist` / `hotlist` / `hotlist_plus` / `questionnaire` / `zoom_scheduled` / `ghosted` / `opted_out` / `requires_human` / `underage` / `block_risk` |
| `primary_objection` | enum | `action` / `trust` / `belonging` / `timing` / `money` / `analytical` / `negative` / `unknown` |
| `last_interaction_at` | timestamptz | חובה לעדכן אחרי כל הודעה |
| `prompt_version_used` | text | גרסת הפרומפט שנעשה בה שימוש בתגובה האחרונה |
| `assigned_advisor_id` | uuid → advisors | מתמלא בעת zoom_handoff |
| `source_funnel` | text | `whatsapp_sandbox` כברירת מחדל |
| `consent_given_at` | timestamptz | התקבל כבר בטופס לפני שיחת WhatsApp |

#### `messages`
| שדה | טיפוס | הערות |
|---|---|---|
| `id` | uuid | PK |
| `conversation_id` | uuid → conversations | |
| `direction` | enum | `inbound` / `outbound` |
| `message_type` | enum | `text` / `audio` / `image` / `sticker` / `video` / `document` |
| `content` | text | טקסט נקי או placeholder `[image]` |
| `timestamp` | timestamptz | מ-Meta payload (UTC) |
| `tokens_used` | int | אופציונלי לטלמטריה |
| `ai_processing_time_ms` | int | אופציונלי |

> **חסר**: `meta_message_id` UNIQUE — צריך להוסיף ב-migration לפני production. ב-n8n: ראשית `SELECT` לפי `meta_message_id`, אם קיים — דלג.

#### `lead_memory`
PK = `conversation_id` (1:1 עם conversation).

| שדה | טיפוס | מה הסוכן שם שם |
|---|---|---|
| `q1_age` | int | גיל הליד |
| `q2_motivation` | text | מה מניע אותם להירשם |
| `q3_dream_change` | text | מה הם רוצים לשנות בחיים |
| `q4_blocker` | text | מה עוצר אותם היום |
| `q5_urgency` | text | עד כמה זה דחוף |
| `q6_investment` | text | סדר גודל ההשקעה |
| `conversation_summary` | text | סיכום קצר של מה קרה עד עכשיו |
| `primary_objection` | enum | (כפילות עם conversations — שניהם מתעדכנים) |
| `red_flags` | text[] | אי-עקביות, סימני מצוקה |
| `notes_for_advisor` | text | הערות ליועץ הזום |
| `promises_made` | text[] | מה הסוכן הבטיח (לאודיט) |
| `last_meaningful_moment` | text | רגע שווה לציין מהשיחה |

> **חסר היום** — `lead_memory` ריקה לחלוטין. ה-extractor שייבנה ב-n8n הוא הפיצ'ר היחיד שממלא אותה.

#### `prompts`
| שדה | טיפוס |
|---|---|
| `id` | uuid |
| `agent_id` | uuid → agents |
| `version` | text (`v1`, `v2`, ...) |
| `prompt_type` | text (`main` כברירת מחדל) |
| `is_active` | bool |
| `content` | text — הפרומפט עצמו |
| `notes` | text |

**שאילתה**: `SELECT content, version FROM prompts WHERE agent_id = ? AND is_active = true ORDER BY created_at DESC LIMIT 1`

#### `opt_outs`
| שדה | טיפוס |
|---|---|
| `id` | uuid |
| `lead_phone` | text |
| `opted_out_at` | timestamptz |
| `reason` | text |

**שאילתה לפני שמייצרים תגובה**: `SELECT 1 FROM opt_outs WHERE lead_phone = ?`. אם קיים — דלג.

#### `advisors` + `agent_advisors`
לעתיד — בחירת יועץ זום אוטומטית. בשלב ראשון אפשר לקודד יועץ קבוע / לבחור random לפי `is_active=true`.

### 4.2 Enums מלאים (להעתקה)

```
agent_status_enum:        active, paused, archived
ai_provider_enum:         claude, gpt, pending, manual
conversation_status_enum: active, paused, completed, opted_out
funnel_stage_enum:        cold, mid, done
message_direction_enum:   inbound, outbound
message_type_enum:        text, audio, image, sticker, video, document
objection_enum:           action, trust, belonging, timing, money, analytical, negative, unknown
question_version_enum:    A, B, C
tag_enum:                 not_hotlist, hotlist, hotlist_plus, questionnaire,
                          zoom_scheduled, ghosted, opted_out, requires_human,
                          underage, block_risk
```

---

## 5. חוזה ה-Webhook הנכנס (HookMyApp → n8n)

### 5.1 Verify (GET)

HookMyApp רושם את ה-URL בפעם הראשונה ושולח GET. השרת חייב להחזיר `VERIFY_TOKEN` כ-`text/plain`.

**ב-n8n**: Webhook node ב-`Respond to Webhook` mode → `Set` node → `Respond to Webhook` עם body=`{{$env.VERIFY_TOKEN}}`. או — שני workflow נפרדים (GET → respond, POST → process).

### 5.2 Inbound (POST)

**Headers**:
- `X-HookMyApp-Signature-256: sha256=<HEX>` — חובה
- `Content-Type: application/json`

**אימות**:
```js
expected = "sha256=" + hmac_sha256_hex(VERIFY_TOKEN, raw_body)
timing_safe_equal(headers["X-HookMyApp-Signature-256"], expected) === true
```

ב-n8n: **Webhook node** מחזיר את ה-raw body ב-`$binary` או `$json`. ה-HMAC חייב להיעשות על ה-raw bytes לפני parse. הדרך הנקייה — Webhook עם `Response Mode: Responding to Webhook`, אחר כך **Code node** ש:

```js
const crypto = require('crypto');
const rawBody = $input.first().binary?.data?.data?.toString('utf8') 
             ?? JSON.stringify($input.first().json.body);
const sig = $input.first().json.headers['x-hookmyapp-signature-256'];
const expected = 'sha256=' + crypto.createHmac('sha256', $env.VERIFY_TOKEN)
                                    .update(rawBody).digest('hex');
const valid = sig && Buffer.from(sig).length === Buffer.from(expected).length
            && crypto.timingSafeEqual(Buffer.from(sig), Buffer.from(expected));
if (!valid) throw new Error('Invalid signature');
return [{ json: JSON.parse(rawBody) }];
```

> **חשוב**: n8n לפעמים מנרמל את ה-body. אם החתימה לא מתאמתת — לוודא שה-`Webhook Trigger` נמצא במצב **Raw Body** (יש option בהגדרות מתקדמות).

**Body — Meta-format payload**:
```json
{
  "object": "whatsapp_business_account",
  "entry": [{
    "id": "<waba-id>",
    "changes": [{
      "field": "messages",
      "value": {
        "contacts": [{ "profile": { "name": "אבי" }, "wa_id": "972501234567" }],
        "messages": [{
          "from": "972501234567",
          "id": "wamid.XXXX",
          "timestamp": "1714000000",
          "type": "text",
          "text": { "body": "שלום, ראיתי את הפרסומת" }
        }]
      }
    }]
  }]
}
```

**שדות לחילוץ פר הודעה**:
- `from` → `lead_phone`
- `id` → `meta_message_id` (לidempotency)
- `timestamp` → `Date.parse(timestamp * 1000)` ל-ISO
- `type` → `message_type` (אם לא ב-enum המוכר → fallback ל-`text`)
- `text.body` → `content` (אם type=text). אחרת → `[<type>]` כ-placeholder
- `contacts[?wa_id==from].profile.name` → `lead_name` (רק על create של conversation)

---

## 6. חוזה ה-API היוצא (n8n → HookMyApp)

```
POST {WHATSAPP_API_URL}/{WHATSAPP_PHONE_NUMBER_ID}/messages
Authorization: Bearer {WHATSAPP_ACCESS_TOKEN}
Content-Type: application/json
```

```json
{
  "messaging_product": "whatsapp",
  "to": "972501234567",
  "type": "text",
  "text": { "body": "תוכן ההודעה" }
}
```

- **Sandbox**: `WHATSAPP_API_URL = https://sandbox.hookmyapp.com/v22.0`
- **Production WABA (עתיד)**: `WHATSAPP_API_URL = https://graph.facebook.com/v22.0`

**Response**: 200 OK עם JSON של Meta. כל סטטוס אחר = כשל. **חובה**: רק אחרי 200 לבצע insert של ה-outbound message ב-DB. סדר הפוך = orphan rows ב-DB בלי הודעה אמיתית.

---

## 7. הסוכן עצמו — Prompt + פלואו

### 7.1 Prompt פעיל

נמצא ב-`prompts/affiliate_marketing/main/v1.md` בריפו. נשלף מ-DB דרך:
```sql
SELECT content, version FROM prompts
WHERE agent_id = ? AND is_active = true
ORDER BY created_at DESC LIMIT 1
```

תוכן הפרומפט (`content`) הוא טקסט markdown ארוך — מועבר ישירות ל-`system` של Claude.

### 7.2 קריאת Claude (כפי שעובד היום)

```
POST https://api.anthropic.com/v1/messages
x-api-key: {ANTHROPIC_API_KEY}
anthropic-version: 2023-06-01

{
  "model": "claude-sonnet-4-6",
  "max_tokens": 1024,
  "thinking": { "type": "adaptive" },
  "system": "<prompt.content>",
  "messages": [
    { "role": "user", "content": "..." },
    { "role": "assistant", "content": "..." },
    { "role": "user", "content": "..." }
  ]
}
```

**הוצאת התגובה**: `response.content.find(b => b.type === "text").text`. בלוקים מסוג `thinking` יש להתעלם.

> **שים לב**: ה-Anthropic node המובנה של n8n **לא** חושף את `thinking: adaptive` כבר. אם רוצים לשמור על אותה איכות, להשתמש ב-**HTTP Request** node ולקרוא ידנית ל-`/v1/messages`. אחרת — אפשר להתחיל עם ה-node המובנה ולמדוד אם יש regression.

### 7.3 חלון ההיסטוריה

30 הודעות אחרונות, ascending לפי `timestamp`, מיפוי:
- `direction='inbound'` → `role='user'`
- `direction='outbound'` → `role='assistant'`

**דילוג**: תוכן ריק / null / רק whitespace.

**Race guard**: אם המערך ריק או שההודעה האחרונה היא `assistant` — **אל תקרא ל-Claude**. זה מצב race שבו כבר הגבנו.

---

## 8. Credentials & Secrets

ב-n8n Cloud → **Settings → Credentials** → ליצור 3 credentials:

### 8.1 Supabase (service_role)

| ערך | מה |
|---|---|
| Type | `Supabase API` (built-in) |
| Host | `https://juoglkqtmjsziieqgmhf.supabase.co` |
| Service Role Secret | (`SUPABASE_SERVICE_ROLE_KEY`) — מ-Supabase Dashboard → Project Settings → API |

> ה-service_role עוקף RLS. **לא** להשתמש בו בקליינט. **אסור** לחשוף ב-workflow שמתחיל מ-webhook ציבורי בלי auth (ה-webhook עצמו לא חושף את ה-credential — n8n מצפין אותו).

### 8.2 HookMyApp (Header Auth)

| ערך | מה |
|---|---|
| Type | `Header Auth` (generic) |
| Name | `Authorization` |
| Value | `Bearer <WHATSAPP_ACCESS_TOKEN>` |

ה-`WHATSAPP_ACCESS_TOKEN` מתחלף עם כל סשן sandbox (`hookmyapp sandbox start`). בפרוד הוא יציב.

**ערכים נוספים שצריכים להיות זמינים ב-workflow** (כ-environment variables של n8n או דרך **Set** node קבוע):
- `VERIFY_TOKEN` — HMAC key, מתחלף בכל סשן sandbox
- `WHATSAPP_API_URL` — `https://sandbox.hookmyapp.com/v22.0` בסנדבוקס
- `WHATSAPP_PHONE_NUMBER_ID` — מסשן הסנדבוקס

### 8.3 Anthropic API

| ערך | מה |
|---|---|
| Type | `Anthropic API` (built-in) או `Header Auth` ידני |
| API Key | `ANTHROPIC_API_KEY` (מתחיל ב-`sk-ant-...`) |

אם הולכים HTTP Request ידני (מומלץ — ראה 7.2):
- Header: `x-api-key: {ANTHROPIC_API_KEY}`
- Header: `anthropic-version: 2023-06-01`
- Header: `content-type: application/json`

### 8.4 רענון Credentials של HookMyApp בסנדבוקס

הסשן sandbox מתחלף → 3 ערכים מתחלפים: `VERIFY_TOKEN`, `WHATSAPP_ACCESS_TOKEN`, `WHATSAPP_PHONE_NUMBER_ID`. בעל הריפו מריץ:

```bash
hookmyapp sandbox env --write .env.functions.local
```

ולוקח משם את הערכים החדשים ל-n8n. **אם החתימה לא מתאמתת = הסשן התחלף, צריך לרענן.**

---

## 9. ה-Workflow ב-n8n — שלב שלב

חייב לבנות **שני workflows נפרדים** או workflow אחד עם branch לפי method.

### 9.1 Workflow A — GET verify (פשוט)

```
Webhook (GET, /whatsapp-inbound)
  ↓
Respond to Webhook
  - Status: 200
  - Content-Type: text/plain
  - Body: {{ $env.VERIFY_TOKEN }}
```

### 9.2 Workflow B — POST inbound + reply

```
[1] Webhook (POST, /whatsapp-inbound, Raw Body=true, Respond=Immediately)
       ↓
[2] Respond to Webhook (status 200, body {"status":"ok"}) ← לחזור מיד! לפני AI
       ↓
[3] Code node: HMAC verify
       - אם invalid → throw → workflow נופל בשקט (לוג only)
       ↓
[4] Code node: parse messages
       - שטיחה של entry[].changes[].value.messages[]
       - הוצאה של contacts לפי wa_id
       - יצירת array של { phone, meta_id, ts, type, content, lead_name }
       ↓
[5] Loop over items (Split In Batches → batch=1)
       ↓
[6] Supabase: SELECT 1 FROM messages WHERE meta_message_id = ?
       - אם קיים → continue (skip duplicate)
       ↓
[7] Supabase: SELECT 1 FROM opt_outs WHERE lead_phone = ?
       - אם קיים → log + insert message (inbound) + skip Claude
       ↓
[8] Supabase: upsert conversation
       - SELECT id FROM conversations WHERE agent_id=? AND lead_phone=?
       - אם אין → INSERT עם status='active', source_funnel='whatsapp_sandbox'
       ↓
[9] Supabase: INSERT message (direction=inbound, meta_message_id, content, type, ts)
       ↓
[10] Supabase: UPDATE conversations SET last_interaction_at=ts WHERE id=?
       ↓
[11] IF type='text' AND content trimmed != '' → continue, else END
       ↓
[12] Aggregate by conversation_id (לתגובה אחת לשיחה)
       ↓
[13] Supabase: SELECT content, version FROM prompts WHERE agent_id=? AND is_active=true ORDER BY created_at DESC LIMIT 1
       ↓
[14] Supabase: SELECT direction, content FROM messages WHERE conversation_id=? ORDER BY timestamp ASC LIMIT 30
       ↓
[15] Code node: build claudeMessages
       - מיפוי direction→role, סינון content ריק
       - אם array ריק או role[-1] !== 'user' → throw 'race-skip'
       ↓
[16] HTTP Request → Anthropic /v1/messages
       - model=claude-sonnet-4-6, max_tokens=1024
       - thinking={type:adaptive}
       - system=prompt.content, messages=claudeMessages
       ↓
[17] Code node: extract reply text
       - response.content.find(b => b.type==='text').text
       - אם ריק → throw 'no-reply'
       ↓
[18] HTTP Request → HookMyApp send
       - {API_URL}/{phoneId}/messages
       - body: {messaging_product, to, type:text, text:{body}}
       ↓
[19] IF send 200:
       Supabase: INSERT message (direction=outbound, content=replyText, type=text, ts=now)
       Supabase: UPDATE conversations SET last_interaction_at=now, prompt_version_used=version
     ELSE:
       Log error, do NOT insert (אחרת DB כן ו-WhatsApp לא = inconsistent)
       ↓
[20] (Optional Piece 2) Memory extractor — קריאת Claude שנייה ב-JSON mode
```

### 9.3 הערות חשובות לבנייה

- **שלב 2 (Respond) לפני שלב 3-19**: HookMyApp נופל אם לא מקבל 200 תוך ~10 שניות. ה-AI loop צריך להיות בענף נפרד (n8n: "Respond Immediately" mode + branches שרצים אחרי).
- **שלב 12 (aggregate)**: המקבילה ל-`Map<conversationId, leadPhone>` בקוד — שיחה אחת = תגובה אחת גם אם הגיעו 3 הודעות באותו batch
- **Idempotency (שלב 6)**: דורש migration ב-DB להוסיף `meta_message_id text UNIQUE` ב-`messages`. **חוסם פרודקשן.**
- **Memory extractor (שלב 20)**: קריאה שנייה ל-Claude עם system נפרד שמבקש JSON. תוכן הפרומפט ל-extractor — לא קיים עדיין, צריך לכתוב

---

## 10. Edge cases לבדיקה (acceptance)

לפני handoff לפרוד — לעבור על הרשימה:

| # | תרחיש | התנהגות צפויה |
|---|---|---|
| 1 | GET / | מחזיר VERIFY_TOKEN בתור text |
| 2 | POST עם חתימה לא תקינה | 401, אין כתיבה ל-DB |
| 3 | POST תקין עם 1 הודעה טקסט | 200 → conversation+message ב-DB → תגובה ב-WhatsApp תוך ~30s |
| 4 | POST תקין עם 3 הודעות מאותו ליד | 200 → 3 inbound rows → **תגובה אחת** ב-WhatsApp |
| 5 | POST תקין עם הודעת image | inbound row עם content=`[image]`, **לא** מפעיל Claude |
| 6 | POST שמופיע פעמיים (אותו meta_message_id) | inbound נכתב פעם אחת בלבד, תגובה אחת |
| 7 | ליד ב-`opt_outs` שולח הודעה | inbound נשמר, **אין** תגובה |
| 8 | Anthropic מחזיר 429 / 500 | inbound כבר ב-DB, יש לוג, אין הודעה כפולה ב-WhatsApp |
| 9 | HookMyApp send מחזיר 401 | אין outbound row ב-DB (אחרת inconsistency) |
| 10 | ליד ענה ל-bot, ה-bot ענה, ואז webhook חוזר ב-replay | race guard מזהה את ההודעה האחרונה כ-assistant ו**לא** עונה שוב |
| 11 | סשן sandbox התחלף | 401 על אימות → להחליף 3 ערכים ב-n8n env |

---

## 11. החלטות שנשארו פתוחות (לסכם עם בעל הפרויקט)

1. **Anthropic native node או HTTP Request?** — `thinking: adaptive` קיים רק ב-HTTP Request. המלצה: HTTP Request
2. **Memory extractor — איזה schema?** — q1..q6 + summary + objection + flags. צריך לכתוב prompt נפרד
3. **`whatsapp-send` נשאר Edge Function?** — כן (השתלטות אנושית מהדשבורד; לא קשור לסוכן)
4. **Migrations** — מי רץ את ה-`alter table messages add column meta_message_id text unique`? בעל הריפו (Claude Code), לא המתכנת של n8n
5. **Production WABA migration** — תיכנון נפרד אחרי שה-n8n יציב. דורש `hookmyapp channels connect` + Business Verification

---

## 12. נספחים

### 12.1 קישורים שימושיים

- Repo: `https://github.com/RicherLTD/richer-ai-agents-hub`
- Supabase Dashboard: `https://supabase.com/dashboard/project/juoglkqtmjsziieqgmhf`
- Lovable hosting: deploy אוטומטי מ-`main`
- n8n docs: `https://docs.n8n.io`
- Anthropic API docs: `https://docs.anthropic.com/en/api/messages`
- HookMyApp: `https://hookmyapp.com`

### 12.2 קבצים בריפו ששווה לקרוא

- `CLAUDE.md` — מסמך אב של הפרויקט
- `supabase/functions/whatsapp-webhook/index.ts` — המימוש הנוכחי שצריך לחקות
- `supabase/functions/README.md` — איך הפונקציות נפרסות וה-secrets מוגדרים
- `prompts/affiliate_marketing/main/v1.md` — הפרומפט הפעיל
- `src/types/database.ts` — schema מלא של DB (auto-generated)
