# Manual Mode Toggle Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** כשאופרטור שולח הודעה ידנית (או לוחץ "השתלט"), השיחה עוברת ל"מצב ידני" וה-AI agent loop מפסיק לענות — עד שאופרטור לוחץ "החזר לניהול AI".

**Architecture:** עמודה ייעודית `conversations.manual_mode_since` (+`manual_mode_by`) משמשת gate נוסף ב-agent loop, במקביל לדפוס ה-`BLOCKING_TAGS` הקיים. `whatsapp-send` קובע אותה אוטומטית; edge function חדש `conversation-set-mode` משמש לכפתור הדו-כיווני. התצוגה מקבלת display-status שישי `'manual'` שנגזר ב-read-time.

**Tech Stack:** Supabase (Postgres + Edge Functions/Deno), React 18 + TypeScript + @tanstack/react-query, shadcn/ui, vitest.

**ספֵק מקור:** [docs/superpowers/specs/2026-05-27-manual-mode-toggle-design.md](../specs/2026-05-27-manual-mode-toggle-design.md)

**קונבנציות שאומתו בקוד:**
- אין `ALTER TYPE ADD VALUE` — עמודה נפרדת (convention מ-migration 0025).
- לשיחות אין RLS update מהקליינט (migration 0004) → כתיבה דרך edge function עם service_role.
- `requireAdmin(req)` מחזיר `{ admin, callerId }` (`callerId` = `auth.users.id`).
- טסטים של edge utils הם **vitest** (לא Deno test); ה-`include` ב-`vitest.config.ts` מכסה `supabase/functions/**/*.{test,spec}.ts`.
- `getConversationById`/`getActiveConversations` עושים `select("*")` → עמודות חדשות נכנסות אוטומטית אחרי regen types.

---

## File Structure

| קובץ | אחריות | חדש/שינוי |
|---|---|---|
| `supabase/migrations/0030_conversation_manual_mode.sql` | שתי עמודות + comments | חדש |
| `src/types/database.ts` | טיפוסים מחודשים (`db:types`) | regen |
| `src/lib/conversation-status.ts` | display status `'manual'` + עדיפות | שינוי |
| `src/lib/conversation-status.test.ts` | כיסוי manual | שינוי |
| `supabase/functions/whatsapp-webhook/index.ts` | guard ב-agent loop | שינוי |
| `supabase/functions/whatsapp-send/index.ts` | טריגר אוטומטי + `ai_provider='manual'` | שינוי |
| `supabase/functions/conversation-set-mode/validate.ts` | ולידציית payload (טהור) | חדש |
| `supabase/functions/conversation-set-mode/validate.test.ts` | טסט vitest לוולידטור | חדש |
| `supabase/functions/conversation-set-mode/index.ts` | endpoint לכפתור | חדש |
| `src/lib/conversations.ts` | `setConversationMode()` wrapper | שינוי |
| `src/components/conversations/ManualModeBar.tsx` | באנר + כפתור | חדש |
| `src/components/conversations/ConversationDetail.tsx` | חיווט הבאנר + mutation + invalidation | שינוי |

---

## Task 0: Feature branch

- [ ] **Step 1: צור branch מ-main**

```bash
git checkout -b feat/manual-mode-toggle
```

(spec ה-design כבר commit על main מקומי — הוא נכלל בבסיס ה-branch.)

---

## Task 1: Migration — שתי עמודות

**Files:**
- Create: `supabase/migrations/0030_conversation_manual_mode.sql`
- Modify (regen): `src/types/database.ts`

- [ ] **Step 1: כתוב את ה-migration**

```sql
-- 0030_conversation_manual_mode.sql
--
-- Per-conversation manual mode. When an operator takes over a conversation
-- (manual send, or explicit "take over" button), the AI agent loop must
-- stop replying until an operator hands it back.
--
-- Why a dedicated column and NOT a new conversation_status_enum value:
-- migration 0025 documents that `ALTER TYPE ... ADD VALUE` has historical
-- transaction restrictions that make our migration tooling unreliable. A
-- nullable timestamp column is orthogonal to `status`/`current_tag`, sticks
-- across inbound messages (the inbound upsert never writes it), and gives a
-- free audit of WHEN the takeover happened.

ALTER TABLE public.conversations
  ADD COLUMN IF NOT EXISTS manual_mode_since timestamptz,
  ADD COLUMN IF NOT EXISTS manual_mode_by uuid REFERENCES auth.users(id) ON DELETE SET NULL;

COMMENT ON COLUMN public.conversations.manual_mode_since IS
  'When an operator took manual control. NULL = AI mode (agent loop replies). Non-null = manual mode (agent loop skips). Set by whatsapp-send (auto) or conversation-set-mode (explicit). Never written by the inbound upsert, so it sticks across lead replies.';
COMMENT ON COLUMN public.conversations.manual_mode_by IS
  'auth.users.id of the operator who last took manual control. NULL in AI mode.';
```

- [ ] **Step 2: החל את ה-migration על ה-DB המקושר**

> ⚠️ פעולה על ה-DB המקושר (prod ref `juoglkqtmjsziieqgmhf`). אשר לפני הרצה.

Run: `bun run db:apply`
Expected: ה-migration 0030 מופעל, ללא שגיאות.

- [ ] **Step 3: רענן טיפוסים**

Run: `bun run db:types`
Expected: `src/types/database.ts` כולל עכשיו `manual_mode_since: string | null` ו-`manual_mode_by: string | null` ב-`conversations` Row/Insert/Update.

- [ ] **Step 4: ודא typecheck/build עוברים**

Run: `bun run build`
Expected: SUCCESS (אין שינוי לוגי עדיין, רק טיפוסים חדשים).

- [ ] **Step 5: Commit**

```bash
git add supabase/migrations/0030_conversation_manual_mode.sql src/types/database.ts
git commit -m "feat(db): add conversations.manual_mode_since/by for manual mode"
```

---

## Task 2: Display status `'manual'` (TDD)

**Files:**
- Modify: `src/lib/conversation-status.ts`
- Test: `src/lib/conversation-status.test.ts`

- [ ] **Step 1: כתוב טסטים נכשלים**

ב-`src/lib/conversation-status.test.ts`, הוסף `manual_mode_since: null` ל-default של `row()`:

```ts
function row(partial: Partial<ConversationStatusInput>): ConversationStatusInput {
  return {
    status: "active",
    current_tag: null,
    last_inbound_at: null,
    created_at: FIVE_HOURS_AGO,
    manual_mode_since: null,
    ...partial,
  };
}
```

הוסף את ה-`it` הבאים בתוך `describe("deriveDisplayStatus", ...)`:

```ts
it("returns 'manual' when manual_mode_since is set", () => {
  expect(
    deriveDisplayStatus(row({ manual_mode_since: TWO_HOURS_AGO }), NOW),
  ).toBe<DisplayStatus>("manual");
});

it("manual mode wins over requires_human (operator actively took over)", () => {
  expect(
    deriveDisplayStatus(
      row({ current_tag: "requires_human", manual_mode_since: TWO_HOURS_AGO }),
      NOW,
    ),
  ).toBe("manual");
});

it("zoom_scheduled wins over manual mode", () => {
  expect(
    deriveDisplayStatus(
      row({ current_tag: "zoom_scheduled", manual_mode_since: TWO_HOURS_AGO }),
      NOW,
    ),
  ).toBe("zoom_scheduled");
});

it("manual mode wins over a stale last_inbound_at (not closed)", () => {
  expect(
    deriveDisplayStatus(
      row({ manual_mode_since: TWO_HOURS_AGO, last_inbound_at: FORTY_NINE_HOURS_AGO }),
      NOW,
    ),
  ).toBe("manual");
});
```

ב-`describe("statusBreakdown", ...)`: הוסף שורת manual ל-mixed batch ועדכן את הצפי. בתוך מערך ה-`rows` הוסף שורה:

```ts
      row({ manual_mode_since: TWO_HOURS_AGO }),
```

ועדכן את שני אובייקטי ה-`toEqual` כך שיכללו `manual` (mixed batch = 1, empty = 0):

```ts
    expect(out).toEqual({
      zoom_scheduled: 2,
      manual: 1,
      requires_human: 2,
      opted_out: 1,
      closed: 2,
      opened: 1,
      template_sent: 2,
    });
```

```ts
    expect(statusBreakdown([], NOW)).toEqual({
      template_sent: 0,
      opened: 0,
      zoom_scheduled: 0,
      manual: 0,
      requires_human: 0,
      opted_out: 0,
      closed: 0,
    });
```

- [ ] **Step 2: הרץ — ודא כישלון**

Run: `bunx vitest run src/lib/conversation-status.test.ts`
Expected: FAIL — `'manual'` לא קיים ב-`DisplayStatus`/`DISPLAY_STATUSES`, ו-`ConversationStatusInput` עדיין בלי `manual_mode_since`.

- [ ] **Step 3: מימוש ב-`conversation-status.ts`**

הוסף `"manual"` ל-`DISPLAY_STATUSES` (אחרי `zoom_scheduled`):

```ts
export const DISPLAY_STATUSES = [
  "template_sent",
  "opened",
  "zoom_scheduled",
  "manual",
  "requires_human",
  "opted_out",
  "closed",
] as const;
```

הוסף ל-`DISPLAY_STATUS_LABEL`:

```ts
  manual: "מצב ידני",
```

הוסף ל-`DISPLAY_STATUS_VARIANT` (טון מובחן מ-`requires_human` ה-destructive; ניתן לשינוי לפי טעם):

```ts
  manual: "secondary",
```

הוסף ל-`ConversationStatusInput`:

```ts
  manual_mode_since: Conversation["manual_mode_since"];
```

ב-`deriveDisplayStatus`, הוסף branch מיד אחרי בדיקת zoom:

```ts
  // 1. Zoom wins outright (קיים)
  if (tag === "zoom_scheduled") return "zoom_scheduled";

  // 1b. Manual mode — operator actively took over. Ranks above requires_human:
  // if the bot gave up and an operator then stepped in, "manual" describes the
  // live state more accurately.
  if (conv.manual_mode_since) return "manual";
```

ב-`statusBreakdown`, הוסף `manual: 0` לאתחול `out`:

```ts
  const out: Record<DisplayStatus, number> = {
    template_sent: 0,
    opened: 0,
    zoom_scheduled: 0,
    manual: 0,
    requires_human: 0,
    opted_out: 0,
    closed: 0,
  };
```

- [ ] **Step 4: הרץ — ודא הצלחה**

Run: `bunx vitest run src/lib/conversation-status.test.ts`
Expected: PASS (כל הטסטים, כולל הישנים).

- [ ] **Step 5: Commit**

```bash
git add src/lib/conversation-status.ts src/lib/conversation-status.test.ts
git commit -m "feat(status): add 'manual' display status (zoom > manual > requires_human)"
```

---

## Task 3: Agent-loop guard (whatsapp-webhook)

**Files:**
- Modify: `supabase/functions/whatsapp-webhook/index.ts` (סביב 583 ו-640)

> אין טסט unit — עקבי עם דפוס `BLOCKING_TAGS` הקיים (inline, untested). אימות: typecheck + סקירה לוגית.

- [ ] **Step 1: הרחב את ה-`.select()` של תפיסת ה-lock**

ב-`generateAndSendAgentResponse`, שנה את שורת ה-select (כיום `.select("id, current_tag, status")`):

```ts
    .select("id, current_tag, status, manual_mode_since");
```

- [ ] **Step 2: הוסף את ה-manual-mode guard**

מיד אחרי בלוק ה-`if (claimedTag && BLOCKING_TAGS.has(claimedTag)) { ... return; }` (שמסתיים ~שורה 640), ולפני `try {`:

```ts
  const claimedManualSince =
    (claim[0] as { manual_mode_since?: string | null }).manual_mode_since ?? null;
  if (claimedManualSince) {
    // Operator took manual control — release the lock and skip the bot.
    // Mirrors the BLOCKING_TAGS release path above. Sticky across inbound
    // because the ingest upsert never writes manual_mode_since.
    await ctx.admin
      .from("conversations")
      .update({ agent_lock_taken_at: null })
      .eq("id", ctx.conversationId);
    await logError({
      admin: ctx.admin,
      source: AGENT_LOOP_SOURCE,
      errorType: "conversation_manual_mode_skip",
      level: "info",
      message: `conversation in manual mode since ${claimedManualSince} — agent loop skipped`,
      context: { manual_mode_since: claimedManualSince, lead_phone: ctx.leadPhone },
      agentId: ctx.agentId,
      conversationId: ctx.conversationId,
    });
    return;
  }
```

- [ ] **Step 3: ודא typecheck**

Run: `bun run build`
Expected: SUCCESS.

- [ ] **Step 4: Commit**

```bash
git add supabase/functions/whatsapp-webhook/index.ts
git commit -m "feat(webhook): skip agent loop when conversation in manual mode"
```

---

## Task 4: Auto-trigger ב-whatsapp-send

**Files:**
- Modify: `supabase/functions/whatsapp-send/index.ts`

- [ ] **Step 1: חשוף `callerId`**

שנה את שורת ה-`requireAdmin` (כיום `const { admin } = await requireAdmin(req);`):

```ts
    const { admin, callerId } = await requireAdmin(req);
```

- [ ] **Step 2: סמן את ההודעה היוצאת כידנית**

בתוך ה-`messages` insert (כיום מכיל `conversation_id, direction, message_type, content, timestamp, meta_message_id`), הוסף שדה:

```ts
        ai_provider: "manual",
```

- [ ] **Step 3: כניסה למצב ידני (only-if-null)**

מיד אחרי בלוק עדכון `last_interaction_at` (ה-`if (updErr) { ... }` שמסתיים ~שורה 236) ולפני `return jsonResponse(inserted, ...)`:

```ts
    // Manual intervention → switch the conversation to manual mode so the
    // agent loop stops auto-replying. Only-if-null preserves the original
    // takeover time across repeated manual sends. Best-effort: a failure
    // here does not fail the response (the lead already got the message).
    const { error: modeErr } = await admin
      .from("conversations")
      .update({ manual_mode_since: ts, manual_mode_by: callerId })
      .eq("id", conversation.id)
      .is("manual_mode_since", null);
    if (modeErr) {
      await logError({
        admin,
        source: SOURCE,
        errorType: "conversation_update_failed",
        message: modeErr.message,
        context: { dbCode: modeErr.code ?? null, field: "manual_mode_since" },
        agentId: conversation.agent_id ?? null,
        conversationId: conversation.id,
      });
    }
```

- [ ] **Step 4: ודא typecheck**

Run: `bun run build`
Expected: SUCCESS. (`ai_provider: "manual"` תקין מול `ai_provider_enum`.)

- [ ] **Step 5: Commit**

```bash
git add supabase/functions/whatsapp-send/index.ts
git commit -m "feat(send): manual operator send switches conversation to manual mode"
```

---

## Task 5: Edge function `conversation-set-mode` (TDD לוולידטור)

**Files:**
- Create: `supabase/functions/conversation-set-mode/validate.ts`
- Test: `supabase/functions/conversation-set-mode/validate.test.ts`
- Create: `supabase/functions/conversation-set-mode/index.ts`

- [ ] **Step 1: כתוב טסט נכשל לוולידטור**

`supabase/functions/conversation-set-mode/validate.test.ts`:

```ts
import { describe, it, expect } from "vitest";
import { isSetModePayload } from "./validate.ts";

describe("isSetModePayload", () => {
  it("accepts a valid manual payload", () => {
    expect(isSetModePayload({ conversation_id: "abc", mode: "manual" })).toBe(true);
  });
  it("accepts a valid ai payload", () => {
    expect(isSetModePayload({ conversation_id: "abc", mode: "ai" })).toBe(true);
  });
  it("rejects an unknown mode", () => {
    expect(isSetModePayload({ conversation_id: "abc", mode: "auto" })).toBe(false);
  });
  it("rejects a missing/empty conversation_id", () => {
    expect(isSetModePayload({ mode: "manual" })).toBe(false);
    expect(isSetModePayload({ conversation_id: "", mode: "manual" })).toBe(false);
  });
  it("rejects non-objects", () => {
    expect(isSetModePayload(null)).toBe(false);
    expect(isSetModePayload("manual")).toBe(false);
  });
});
```

- [ ] **Step 2: הרץ — ודא כישלון**

Run: `bunx vitest run supabase/functions/conversation-set-mode/validate.test.ts`
Expected: FAIL — `./validate.ts` לא קיים.

- [ ] **Step 3: מימוש הוולידטור (טהור, ללא imports)**

`supabase/functions/conversation-set-mode/validate.ts`:

```ts
export interface SetModePayload {
  conversation_id: string;
  mode: "manual" | "ai";
}

export function isSetModePayload(value: unknown): value is SetModePayload {
  if (!value || typeof value !== "object") return false;
  const v = value as Record<string, unknown>;
  return (
    typeof v.conversation_id === "string" &&
    v.conversation_id.length > 0 &&
    (v.mode === "manual" || v.mode === "ai")
  );
}
```

- [ ] **Step 4: הרץ — ודא הצלחה**

Run: `bunx vitest run supabase/functions/conversation-set-mode/validate.test.ts`
Expected: PASS.

- [ ] **Step 5: כתוב את ה-`index.ts`**

`supabase/functions/conversation-set-mode/index.ts`:

```ts
// conversation-set-mode/index.ts
//
// Admin-only endpoint that toggles a conversation between AI mode and
// manual mode. Conversations have no client-side RLS UPDATE policy
// (migration 0004) — all writes go through service_role here.
//
// Request:
//   POST /functions/v1/conversation-set-mode
//   Authorization: Bearer <user JWT>
//   { "conversation_id": string, "mode": "manual" | "ai" }

import { corsHeaders } from "../_shared/cors.ts";
import { HttpError, jsonResponse, requireAdmin } from "../_shared/auth.ts";
import { logError } from "../_shared/logError.ts";
import { isSetModePayload } from "./validate.ts";

const SOURCE = "conversation-set-mode";

Deno.serve(async (req) => {
  if (req.method === "OPTIONS") {
    return new Response(null, { headers: corsHeaders });
  }
  if (req.method !== "POST") {
    return jsonResponse({ error: "Method not allowed" }, { status: 405, headers: corsHeaders });
  }

  try {
    const { admin, callerId } = await requireAdmin(req);

    const body = await req.json().catch(() => null);
    if (!isSetModePayload(body)) {
      throw new HttpError(400, "Body must be { conversation_id, mode: 'manual'|'ai' }");
    }

    const manualSince = body.mode === "manual" ? new Date().toISOString() : null;
    const manualBy = body.mode === "manual" ? callerId : null;

    const { data: updated, error: updErr } = await admin
      .from("conversations")
      .update({ manual_mode_since: manualSince, manual_mode_by: manualBy })
      .eq("id", body.conversation_id)
      .select("id, manual_mode_since, manual_mode_by")
      .maybeSingle();

    if (updErr) {
      await logError({
        admin,
        source: SOURCE,
        errorType: "conversation_update_failed",
        message: updErr.message,
        context: { conversationId: body.conversation_id, mode: body.mode, dbCode: updErr.code ?? null },
        conversationId: body.conversation_id,
      });
      throw new HttpError(500, `Failed to set mode: ${updErr.message}`);
    }
    if (!updated) {
      throw new HttpError(404, "Conversation not found");
    }

    return jsonResponse(updated, { status: 200, headers: corsHeaders });
  } catch (err) {
    if (err instanceof HttpError) {
      return jsonResponse({ error: err.message }, { status: err.status, headers: corsHeaders });
    }
    console.error("conversation-set-mode: unexpected error", err);
    return jsonResponse({ error: "Internal server error" }, { status: 500, headers: corsHeaders });
  }
});
```

- [ ] **Step 6: Commit**

```bash
git add supabase/functions/conversation-set-mode/
git commit -m "feat(fn): add conversation-set-mode endpoint for manual/ai toggle"
```

---

## Task 6: Client wrapper `setConversationMode`

**Files:**
- Modify: `src/lib/conversations.ts`

- [ ] **Step 1: הוסף את הפונקציה בתחתית `conversations.ts`**

```ts
export interface SetConversationModeParams {
  conversationId: string;
  mode: "manual" | "ai";
}

/**
 * Toggle a conversation between AI mode and manual mode via the
 * `conversation-set-mode` edge function (admin-gated, service_role write).
 */
export async function setConversationMode({
  conversationId,
  mode,
}: SetConversationModeParams): Promise<void> {
  const { data, error } = await supabase.functions.invoke<{ error?: string }>(
    "conversation-set-mode",
    { body: { conversation_id: conversationId, mode } },
  );
  if (error) {
    throw new Error(`Failed to set conversation mode: ${error.message}`);
  }
  if (data && "error" in data && data.error) {
    throw new Error(data.error);
  }
}
```

- [ ] **Step 2: ודא typecheck**

Run: `bun run build`
Expected: SUCCESS.

- [ ] **Step 3: Commit**

```bash
git add src/lib/conversations.ts
git commit -m "feat(lib): add setConversationMode wrapper"
```

---

## Task 7: UI — ManualModeBar + חיווט ב-ConversationDetail

**Files:**
- Create: `src/components/conversations/ManualModeBar.tsx`
- Modify: `src/components/conversations/ConversationDetail.tsx`

- [ ] **Step 1: צור את `ManualModeBar.tsx`**

```tsx
import { Bot, Hand } from "lucide-react";
import { Button } from "@/components/ui/button";
import type { Conversation } from "@/types/conversation";

interface Props {
  conversation: Conversation;
  pending: boolean;
  onSetMode: (mode: "manual" | "ai") => void;
}

export function ManualModeBar({ conversation, pending, onSetMode }: Props) {
  const isManual = conversation.manual_mode_since != null;
  return (
    <div
      className={
        "flex items-center justify-between gap-2 border-t px-3 py-2 text-xs " +
        (isManual ? "bg-amber-50 text-amber-900" : "bg-muted/40 text-muted-foreground")
      }
    >
      <div className="flex items-center gap-1.5">
        {isManual ? <Hand className="h-3.5 w-3.5" /> : <Bot className="h-3.5 w-3.5" />}
        <span>{isManual ? "מצב ידני · ה-AI מושהה" : "AI פעיל · עונה אוטומטית"}</span>
      </div>
      <Button
        size="sm"
        variant={isManual ? "default" : "outline"}
        disabled={pending}
        onClick={() => onSetMode(isManual ? "ai" : "manual")}
      >
        {isManual ? "החזר לניהול AI" : "השתלט (מצב ידני)"}
      </Button>
    </div>
  );
}
```

- [ ] **Step 2: חווט ב-`ConversationDetail.tsx`**

הוסף imports:

```ts
import { getConversationById, setConversationMode } from "@/lib/conversations";
import { ManualModeBar } from "./ManualModeBar";
```

(שים לב: `getConversationById` כבר מיובא — מזג את ה-import כך שיכלול גם `setConversationMode`.)

עדכן את `sendMutation.onSuccess` כך שירענן גם את שורת השיחה (invalidate על prefix `["conversation", conversationId]` מבטל row+messages+memory):

```ts
  const sendMutation = useMutation({
    mutationFn: (content: string) => sendOutboundMessage({ conversationId, content }),
    onSuccess: () => {
      void queryClient.invalidateQueries({
        queryKey: ["conversation", conversationId],
      });
    },
  });
```

הוסף mutation לכפתור (אחרי `sendMutation`):

```ts
  const modeMutation = useMutation({
    mutationFn: (mode: "manual" | "ai") => setConversationMode({ conversationId, mode }),
    onSuccess: () => {
      void queryClient.invalidateQueries({
        queryKey: ["conversation", conversationId],
      });
    },
  });
```

הוסף את הבאנר בין ה-thread ל-`ReplyBox` (בתוך `<div className="flex flex-1 flex-col overflow-hidden">`, אחרי ה-thread `</div>` ולפני `<ReplyBox ... />`):

```tsx
        <ManualModeBar
          conversation={conversation}
          pending={modeMutation.isPending}
          onSetMode={(mode) => modeMutation.mutate(mode)}
        />
```

- [ ] **Step 3: ודא lint + build**

Run: `bun run lint && bun run build`
Expected: SUCCESS.

- [ ] **Step 4: אימות ידני ב-UI (dev server)**

Run: `bun run dev` ופתח שיחה.
ודא:
- בראש ה-ReplyBox מופיע "AI פעיל" + כפתור "השתלט (מצב ידני)".
- לחיצה על "השתלט" → הבאנר הופך ל"מצב ידני · ה-AI מושהה" + כפתור "החזר לניהול AI".
- ברשימת השיחות/Leads מופיע באדג' "מצב ידני" ופילטר חדש.
- "החזר לניהול AI" מחזיר את החיווי ל"AI פעיל".

- [ ] **Step 5: Commit**

```bash
git add src/components/conversations/ManualModeBar.tsx src/components/conversations/ConversationDetail.tsx
git commit -m "feat(ui): manual-mode banner + take-over/return toggle in conversation"
```

---

## Task 8: Deploy + אימות end-to-end

> ⚠️ Deploy ל-edge functions בפרוד נוגע בלידים אמיתיים. אשר לפני הרצה.

- [ ] **Step 1: Deploy הפונקציות שהשתנו/נוספו**

```bash
bun run fn:deploy whatsapp-webhook --project-ref juoglkqtmjsziieqgmhf
bun run fn:deploy whatsapp-send --project-ref juoglkqtmjsziieqgmhf
bun run fn:deploy conversation-set-mode --project-ref juoglkqtmjsziieqgmhf
```

(`conversation-set-mode` נפרס **עם** אימות JWT — בלי `--no-verify-jwt` — כי הוא admin-gated.)

- [ ] **Step 2: אימות end-to-end על שיחת בדיקה**

1. אופרטור שולח הודעה ידנית בשיחה → השיחה עוברת ל"מצב ידני" (`manual_mode_since` מאוכלס; ההודעה מסומנת `ai_provider='manual'`).
2. שלח הודעת ליד נכנסת לאותה שיחה → ה-AI **לא** עונה; ב-`error_logs` מופיע `conversation_manual_mode_skip`.
3. לחץ "החזר לניהול AI" → `manual_mode_since=null`.
4. שלח הודעת ליד נוספת → ה-AI עונה כרגיל.

- [ ] **Step 3: ודא כלל הטסטים ירוקים**

Run: `bun run test`
Expected: PASS (כולל `conversation-status` ו-`conversation-set-mode/validate`).

---

## Self-Review (בוצע בזמן כתיבת התכנית)

- **כיסוי ספֵק**: schema (T1), guard (T3), auto-trigger+`ai_provider` (T4), endpoint (T5), display+priority+badge+filter (T2, נגזר אוטומטית), UI banner+toggle+refetch (T6-T7), edge cases (T8 verify). ✔
- **דביקות**: מובטחת — ה-upsert הנכנס לא נוגע ב-`manual_mode_since` (אומת ב-[index.ts:1165](../../../supabase/functions/whatsapp-webhook/index.ts)). ✔
- **עקביות טיפוסים**: `setConversationMode`, `isSetModePayload`, `manual_mode_since`/`manual_mode_by`, display `'manual'` — שמות זהים לאורך כל ה-tasks. ✔
- **סטייה מודעת מהספֵק**: §11 ביקש טסט ל-guard וטסט "set/clear" ל-endpoint. בפועל: ה-guard נשאר inline-untested (עקבי עם `BLOCKING_TAGS`), וה-endpoint נבדק ברמת הוולידטור הטהור (set/clear דורש Supabase חי — מאומת ידנית ב-T8). זו התאמה לקונבנציות הריפו (אין טסטי index.ts ל-edge fns). ✔

## מחוץ ל-scope (כפי שאושר בספֵק)

"החזר ל-AI וענה עכשיו", round-robin, הוספת `conversations` ל-realtime, הרשאות מעבר ל-admin.
