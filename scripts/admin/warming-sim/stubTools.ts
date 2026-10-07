// Local stand-ins for the Mooz tools. The simulator never reaches Mooz: slots
// are invented (tomorrow 11:00 and 11:30 Israel time) and a booking always
// "succeeds". Result shapes follow moozTools.ts so the model reads the same
// kind of payload it does in production.

import { formatIlHHMM } from "../../../supabase/functions/_shared/ilTime.ts";

const SLOT_MINUTES = 30;
const SLOT_START_HOURS_IL = [{ hour: 11, minute: 0 }, { hour: 11, minute: 30 }];
const DAY_MS = 24 * 60 * 60_000;

export interface StubToolResult {
  resultJson: string;
  offeredTimesIL: string[];
  /** Visible line for the transcript. */
  line: string;
}

function ilOffsetMs(instantMs: number): number {
  const parts = new Intl.DateTimeFormat("en-US", {
    timeZone: "Asia/Jerusalem",
    hourCycle: "h23",
    year: "numeric", month: "2-digit", day: "2-digit",
    hour: "2-digit", minute: "2-digit", second: "2-digit",
  }).formatToParts(new Date(instantMs));
  const get = (type: string): number => Number(parts.find((p) => p.type === type)?.value);
  const wallAsUtc = Date.UTC(get("year"), get("month") - 1, get("day"), get("hour"), get("minute"), get("second"));
  return wallAsUtc - Math.floor(instantMs / 1000) * 1000;
}

/** The UTC instant at which the Israel wall clock reads the given date and time. */
export function ilWallTimeToUtc(ymd: string, hour: number, minute: number): Date {
  const [year, month, day] = ymd.split("-").map(Number);
  const wallAsUtc = Date.UTC(year, month - 1, day, hour, minute);
  // Two passes settle the offset when the guess lands on a DST edge.
  const first = wallAsUtc - ilOffsetMs(wallAsUtc);
  return new Date(wallAsUtc - ilOffsetMs(first));
}

function ilDateString(instant: Date): string {
  return new Intl.DateTimeFormat("en-CA", {
    timeZone: "Asia/Jerusalem", year: "numeric", month: "2-digit", day: "2-digit",
  }).format(instant);
}

function formatLocalIL(utcIso: string): string {
  return new Date(utcIso).toLocaleString("he-IL", {
    timeZone: "Asia/Jerusalem",
    weekday: "short", day: "2-digit", month: "2-digit", hour: "2-digit", minute: "2-digit",
  });
}

export function buildFakeSlots(now: Date): Array<{ start_utc: string; end_utc: string; local_il: string }> {
  const tomorrow = ilDateString(new Date(now.getTime() + DAY_MS));
  return SLOT_START_HOURS_IL.map(({ hour, minute }) => {
    const start = ilWallTimeToUtc(tomorrow, hour, minute);
    const end = new Date(start.getTime() + SLOT_MINUTES * 60_000);
    return { start_utc: start.toISOString(), end_utc: end.toISOString(), local_il: formatLocalIL(start.toISOString()) };
  });
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null;
}

function describeCall(name: string, input: unknown): string {
  const fields = isRecord(input) ? input : {};
  const flag = fields.lead_requested_booking === true;
  const date = typeof fields.preferred_date === "string" ? ` preferred_date=${fields.preferred_date}` : "";
  return `[tool: ${name}${date} lead_requested_booking=${flag}]`;
}

function stubListSlots(now: Date): Pick<StubToolResult, "resultJson" | "offeredTimesIL"> {
  const slots = buildFakeSlots(now);
  return {
    resultJson: JSON.stringify({
      outcome: "slots_found",
      slot_count: slots.length,
      slots,
      hint: "Offer 2-3 of these (not all). When the lead picks one, call book_meeting with the exact start_utc/end_utc strings.",
    }),
    offeredTimesIL: slots.flatMap((slot) => [formatIlHHMM(slot.start_utc), formatIlHHMM(slot.end_utc)]),
  };
}

function stubBookMeeting(input: unknown): Pick<StubToolResult, "resultJson" | "offeredTimesIL"> {
  const fields = isRecord(input) ? input : {};
  const start = typeof fields.start_time === "string" ? fields.start_time : "";
  const end = typeof fields.end_time === "string" ? fields.end_time : "";
  return {
    resultJson: JSON.stringify({
      success: true,
      booking_id: "simulated-booking",
      start_utc: start,
      end_utc: end,
      local_il: start ? formatLocalIL(start) : "",
      next_step:
        "Confirm the booking to the lead in one short message. Include the time in Israel timezone in natural Hebrew. ALWAYS include the line verbatim: \"הקישור יישלח אליך בוואטסאפ 5 דקות לפני הפגישה\". A short closing word ('בהצלחה!' or a single emoji) is fine after the line, but nothing more.",
    }),
    offeredTimesIL: [formatIlHHMM(start), formatIlHHMM(end)].filter((time) => time.length > 0),
  };
}

export function runStubTool(name: string, input: unknown, now: Date): StubToolResult {
  const line = describeCall(name, input);
  if (name === "list_available_slots") return { ...stubListSlots(now), line };
  if (name === "book_meeting") return { ...stubBookMeeting(input), line };
  return { resultJson: JSON.stringify({ error: `unknown tool: ${name}` }), offeredTimesIL: [], line };
}
