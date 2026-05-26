// moozTools.ts
//
// Anthropic tool definitions + dispatcher for the WhatsApp agent loop.
// Exposes exactly two tools to Claude:
//
//   list_available_slots(preferred_date, lookahead_days)
//     → fetches real Mooz slots
//
//   book_meeting(start_time, end_time, lead_name, lead_email)
//     → creates a confirmed booking; on success the dispatcher updates
//       the conversation row (current_tag='zoom_scheduled' + status='paused'
//       + zoom_scheduled_at + meeting_consented_at).
//
// The handoff webhook (the broadcast to Make.com / advisors) is NOT
// fired from here. It's fired from `mooz-webhook` after Mooz confirms
// the booking via its own `booking.created` event — single source of
// truth, no double-fire even if the bot retries.

import type { SupabaseClient } from "https://esm.sh/@supabase/supabase-js@2.45.4";
import type Anthropic from "https://esm.sh/@anthropic-ai/sdk@0.88.0";
import { MoozClient, type MoozAvailableSlot } from "./mooz.ts";
import { logError } from "./logError.ts";

/** Anthropic tool definitions — passed verbatim to messages.create({tools}). */
export const MOOZ_TOOL_DEFS: Anthropic.Messages.Tool[] = [
  {
    name: "list_available_slots",
    description:
      "Fetches real available zoom meeting slots from Mooz, the booking system. " +
      "Use this when (a) the lead has agreed to schedule, AND (b) you need to offer specific times. " +
      "Never invent or guess times — only mention slots returned by this tool. " +
      "If the tool returns an empty array, tell the lead you couldn't find slots for that date and ask for an alternative.",
    input_schema: {
      type: "object",
      properties: {
        preferred_date: {
          type: "string",
          description:
            "Lead's preferred date in YYYY-MM-DD (Israel timezone). " +
            "Examples: '2026-05-21' for tomorrow, '2026-05-22' for the day after. " +
            "Derive from context (e.g., 'מחר', 'יום ראשון') against the current date.",
        },
        lookahead_days: {
          type: "integer",
          description:
            "How many days from preferred_date to scan. Use 1 when the lead picked a specific day, " +
            "3 when they said 'sometime this week', up to 7 maximum.",
          minimum: 1,
          maximum: 7,
        },
      },
      required: ["preferred_date"],
    },
  },
  {
    name: "book_meeting",
    description:
      "Books a confirmed zoom meeting in Mooz. ONLY call this after: " +
      "(1) the lead picked a specific slot returned by list_available_slots, AND " +
      "(2) you have their full name AND email address. " +
      "Returns the booking confirmation; the system will tag the conversation as zoom_scheduled automatically. " +
      "If the slot was taken since list_available_slots was called (409 slot_full), apologize, call list_available_slots again, and offer fresh options.",
    input_schema: {
      type: "object",
      properties: {
        start_time: {
          type: "string",
          description: "Slot start as UTC ISO 8601 — copy verbatim from list_available_slots response.",
        },
        end_time: {
          type: "string",
          description: "Slot end as UTC ISO 8601 — copy verbatim from list_available_slots response.",
        },
        lead_name: {
          type: "string",
          description: "Lead's full name as they provided it.",
        },
        lead_email: {
          type: "string",
          description: "Lead's email address.",
        },
      },
      required: ["start_time", "end_time", "lead_name", "lead_email"],
    },
  },
];

const NAMES = new Set(MOOZ_TOOL_DEFS.map((t) => t.name));

export function isMoozTool(name: string): boolean {
  return NAMES.has(name);
}

/** Context the dispatcher needs to run a tool call. */
export interface MoozDispatchCtx {
  admin: SupabaseClient;
  mooz: MoozClient;
  meetingTypeId: string;
  conversationId: string;
  agentId: string;
  leadPhone: string;
}

/** What we hand back to Claude as the tool_result content. */
export interface MoozDispatchResult {
  /** Stringified JSON the model will read. */
  resultJson: string;
  /** True only when book_meeting succeeded — caller can use this to
   *  short-circuit further loop iterations / log a milestone. */
  bookingCreated: boolean;
}

/**
 * Executes a single tool call from Claude. Pure dispatcher — no Claude
 * I/O, just tool work + DB side-effects on success. Caller wraps this
 * in the tool-use loop.
 */
export async function dispatchMoozTool(
  name: string,
  input: unknown,
  ctx: MoozDispatchCtx,
): Promise<MoozDispatchResult> {
  if (name === "list_available_slots") {
    return handleListSlots(input, ctx);
  }
  if (name === "book_meeting") {
    return handleBookMeeting(input, ctx);
  }
  return {
    resultJson: JSON.stringify({ error: `unknown tool: ${name}` }),
    bookingCreated: false,
  };
}

// ─── list_available_slots ────────────────────────────────────────────

async function handleListSlots(
  input: unknown,
  ctx: MoozDispatchCtx,
): Promise<MoozDispatchResult> {
  const parsed = parseListInput(input);
  if (!parsed.ok) {
    return {
      resultJson: JSON.stringify({ error: parsed.error }),
      bookingCreated: false,
    };
  }
  const { fromIso, toIso, lookaheadDays } = computeRange(
    parsed.preferredDate,
    parsed.lookaheadDays,
  );

  let slots: MoozAvailableSlot[] = [];
  try {
    slots = await ctx.mooz.listAvailableSlots({
      meetingTypeId: ctx.meetingTypeId,
      from: fromIso,
      to: toIso,
    });
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    await logError({
      admin: ctx.admin,
      source: "mooz-tools",
      errorType: "list_slots_failed",
      message,
      context: { meetingTypeId: ctx.meetingTypeId, fromIso, toIso },
      agentId: ctx.agentId,
      conversationId: ctx.conversationId,
    });
    return {
      resultJson: JSON.stringify({
        error: "Couldn't reach Mooz right now. Tell the lead the scheduling system is briefly down and you'll come back to them shortly.",
      }),
      bookingCreated: false,
    };
  }

  // Cap the surface area Claude sees — too many slots derail the convo.
  const trimmed = slots.slice(0, 12);
  return {
    resultJson: JSON.stringify({
      preferred_date: parsed.preferredDate,
      lookahead_days: lookaheadDays,
      slot_count: trimmed.length,
      slots: trimmed.map((s) => ({
        start_utc: s.start,
        end_utc: s.end,
        local_il: formatLocalIL(s.start),
      })),
      hint:
        trimmed.length === 0
          ? "No slots in this window. Ask the lead for a different day."
          : "Offer 2-3 of these (not all). When the lead picks one, call book_meeting with the exact start_utc/end_utc strings.",
    }),
    bookingCreated: false,
  };
}

interface ListInputOk {
  ok: true;
  preferredDate: string;
  lookaheadDays: number;
}
interface ListInputErr {
  ok: false;
  error: string;
}
function parseListInput(input: unknown): ListInputOk | ListInputErr {
  if (!input || typeof input !== "object") {
    return { ok: false, error: "missing input" };
  }
  const obj = input as Record<string, unknown>;
  const preferredDate = typeof obj.preferred_date === "string" ? obj.preferred_date : "";
  if (!/^\d{4}-\d{2}-\d{2}$/.test(preferredDate)) {
    return { ok: false, error: "preferred_date must be YYYY-MM-DD" };
  }
  const rawLookahead = obj.lookahead_days;
  let lookaheadDays = 1;
  if (typeof rawLookahead === "number" && Number.isFinite(rawLookahead)) {
    lookaheadDays = Math.max(1, Math.min(7, Math.floor(rawLookahead)));
  }
  return { ok: true, preferredDate, lookaheadDays };
}

/**
 * Builds a wide UTC range that comfortably contains the lead's day(s)
 * in Israel time without needing a DST-aware date library. Mooz already
 * filters by IL business hours + min_notice + max_days_ahead server-side,
 * so over-shooting the range is harmless.
 */
function computeRange(
  preferredDate: string,
  lookaheadDays: number,
): { fromIso: string; toIso: string; lookaheadDays: number } {
  const start = new Date(`${preferredDate}T00:00:00.000Z`);
  const end = new Date(start.getTime() + lookaheadDays * 24 * 60 * 60 * 1000);
  return {
    fromIso: start.toISOString(),
    toIso: end.toISOString(),
    lookaheadDays,
  };
}

function formatLocalIL(utcIso: string): string {
  try {
    const d = new Date(utcIso);
    return d.toLocaleString("he-IL", {
      timeZone: "Asia/Jerusalem",
      weekday: "short",
      day: "2-digit",
      month: "2-digit",
      hour: "2-digit",
      minute: "2-digit",
    });
  } catch {
    return utcIso;
  }
}

// ─── book_meeting ────────────────────────────────────────────────────

async function handleBookMeeting(
  input: unknown,
  ctx: MoozDispatchCtx,
): Promise<MoozDispatchResult> {
  const parsed = parseBookInput(input);
  if (!parsed.ok) {
    return {
      resultJson: JSON.stringify({ error: parsed.error }),
      bookingCreated: false,
    };
  }

  const result = await ctx.mooz.createBooking({
    meetingTypeId: ctx.meetingTypeId,
    customerName: parsed.leadName,
    customerEmail: parsed.leadEmail,
    customerPhone: ctx.leadPhone,
    startTime: parsed.startTime,
    endTime: parsed.endTime,
    notes: `WhatsApp lead — conversation ${ctx.conversationId}`,
  });

  if (!result.ok) {
    if (result.kind === "slot_full" || result.kind === "duplicate") {
      return {
        resultJson: JSON.stringify({
          error: "slot_unavailable",
          mooz_kind: result.kind,
          mooz_message: result.message,
          guidance:
            "Slot was taken since you last looked. Apologize briefly, call list_available_slots again with the same preferred_date, and offer fresh options.",
        }),
        bookingCreated: false,
      };
    }
    if (result.kind === "invalid_input") {
      return {
        resultJson: JSON.stringify({
          error: "invalid_input",
          mooz_message: result.message,
          guidance:
            "Likely an invalid email. Ask the lead to confirm the address (אימייל) and try again.",
        }),
        bookingCreated: false,
      };
    }
    await logError({
      admin: ctx.admin,
      source: "mooz-tools",
      errorType: "create_booking_failed",
      message: result.message,
      context: { meetingTypeId: ctx.meetingTypeId, kind: result.kind, startTime: parsed.startTime },
      agentId: ctx.agentId,
      conversationId: ctx.conversationId,
    });
    return {
      resultJson: JSON.stringify({
        error: "mooz_unavailable",
        guidance:
          "Mooz couldn't complete the booking. Tell the lead the system is briefly down and a human will reach out shortly. Do not retry book_meeting in this turn.",
      }),
      bookingCreated: false,
    };
  }

  // Success path: tag the conversation so the dashboard reflects reality
  // immediately. The handoff webhook is fired separately by `mooz-webhook`
  // when Mooz's own `booking.created` event arrives — that prevents a
  // double-fire if the bot retries.
  await updateConversationOnBooking({
    admin: ctx.admin,
    conversationId: ctx.conversationId,
    leadName: parsed.leadName,
    leadEmail: parsed.leadEmail,
    scheduledAt: result.booking.start_time,
    agentId: ctx.agentId,
  });

  return {
    resultJson: JSON.stringify({
      success: true,
      booking_id: result.booking.id,
      start_utc: result.booking.start_time,
      end_utc: result.booking.end_time,
      local_il: formatLocalIL(result.booking.start_time),
      next_step:
        "Confirm the booking to the lead in one short message. Include the time in Israel timezone in natural Hebrew. ALWAYS include the line verbatim: \"הקישור יישלח אליך בוואטסאפ 5 דקות לפני הפגישה\". A short closing word ('בהצלחה!' or a single emoji) is fine after the line, but nothing more.",
    }),
    bookingCreated: true,
  };
}

interface BookInputOk {
  ok: true;
  startTime: string;
  endTime: string;
  leadName: string;
  leadEmail: string;
}
interface BookInputErr {
  ok: false;
  error: string;
}
function parseBookInput(input: unknown): BookInputOk | BookInputErr {
  if (!input || typeof input !== "object") {
    return { ok: false, error: "missing input" };
  }
  const obj = input as Record<string, unknown>;
  const startTime = typeof obj.start_time === "string" ? obj.start_time : "";
  const endTime = typeof obj.end_time === "string" ? obj.end_time : "";
  const leadName = typeof obj.lead_name === "string" ? obj.lead_name.trim() : "";
  const leadEmail = typeof obj.lead_email === "string" ? obj.lead_email.trim() : "";
  if (!/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d+)?Z$/.test(startTime)) {
    return { ok: false, error: "start_time must be UTC ISO 8601" };
  }
  if (!/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d+)?Z$/.test(endTime)) {
    return { ok: false, error: "end_time must be UTC ISO 8601" };
  }
  if (leadName.length < 2) {
    return { ok: false, error: "lead_name too short" };
  }
  if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(leadEmail)) {
    return { ok: false, error: "lead_email looks malformed" };
  }
  return { ok: true, startTime, endTime, leadName, leadEmail };
}

async function updateConversationOnBooking(args: {
  admin: SupabaseClient;
  conversationId: string;
  leadName: string;
  leadEmail: string;
  scheduledAt: string;
  agentId: string;
}): Promise<void> {
  const { error } = await args.admin
    .from("conversations")
    .update({
      current_tag: "zoom_scheduled",
      funnel_stage: "done",
      status: "paused",
      zoom_scheduled_at: args.scheduledAt,
      lead_name: args.leadName,
    })
    .eq("id", args.conversationId);
  if (error) {
    await logError({
      admin: args.admin,
      source: "mooz-tools",
      errorType: "conversation_update_failed_post_booking",
      message: error.message,
      context: { conversationId: args.conversationId },
      agentId: args.agentId,
      conversationId: args.conversationId,
    });
  }
  // Persist email + explicit consent signal in lead_memory. meeting_consented_at
  // lives on lead_memory per migration 0027, not on conversations. Handoff
  // pipeline reads from here. Best-effort upsert.
  await args.admin
    .from("lead_memory")
    .upsert(
      {
        conversation_id: args.conversationId,
        q7_email: args.leadEmail,
        meeting_consented_at: new Date().toISOString(),
      },
      { onConflict: "conversation_id" },
    );
}
