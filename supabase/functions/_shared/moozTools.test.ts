import { describe, expect, it } from "vitest";
import {
  dispatchMoozTool,
  isMoozTool,
  MOOZ_TOOL_DEFS,
  type MoozDispatchCtx,
} from "./moozTools.ts";
import type { MoozClient, MoozCreateBookingResult, MoozAvailableSlot } from "./mooz.ts";

const VALID_UTC = "2026-05-21T11:00:00.000Z";
const VALID_END = "2026-05-21T11:30:00.000Z";

interface AdminCall {
  table: string;
  op: "update" | "upsert";
  payload: Record<string, unknown>;
  where?: { col: string; val: unknown };
}

// A lead that clears the qualification floor (goal + pain + >=3 answers).
// Default for the mock so existing happy-path tests proceed into the tool.
const QUALIFIED_MEMORY = {
  q1_age: 30,
  q2_motivation: "להגדיל הכנסה",
  q3_dream_change: "עצמאות פיננסית",
  q4_blocker: "אין זמן",
  q5_urgency: "החודש",
};

function makeAdmin(opts?: { leadMemory?: Record<string, unknown> | null }): {
  admin: MoozDispatchCtx["admin"];
  calls: AdminCall[];
} {
  const leadMemory = opts && "leadMemory" in opts ? opts.leadMemory : QUALIFIED_MEMORY;
  const calls: AdminCall[] = [];
  // deno-lint-ignore no-explicit-any
  const adminAny: any = {
    from(table: string) {
      return {
        update(payload: Record<string, unknown>) {
          const call: AdminCall = { table, op: "update", payload };
          calls.push(call);
          return {
            eq(col: string, val: unknown) {
              call.where = { col, val };
              return Promise.resolve({ error: null });
            },
          };
        },
        upsert(payload: Record<string, unknown>) {
          calls.push({ table, op: "upsert", payload });
          return Promise.resolve({ error: null });
        },
        insert() {
          return Promise.resolve({ error: null });
        },
        select(_cols: string) {
          return {
            eq(_col: string, _val: unknown) {
              return {
                maybeSingle() {
                  return Promise.resolve({ data: leadMemory, error: null });
                },
              };
            },
          };
        },
      };
    },
  };
  return { admin: adminAny, calls };
}

function makeMoozStub(opts: {
  /** Either a fixed list, or a function of the query args so a test can
   *  return different results for the requested window vs. the nearest
   *  fallback sweep (which queries `from` ≈ now). */
  slots?:
    | MoozAvailableSlot[]
    | ((args: { from: string; to: string }) => MoozAvailableSlot[]);
  slotsError?: Error;
  bookingResult?: MoozCreateBookingResult;
}): MoozClient {
  return {
    listAvailableSlots: async (args: { from: string; to: string }) => {
      if (opts.slotsError) throw opts.slotsError;
      if (typeof opts.slots === "function") return opts.slots(args);
      return opts.slots ?? [];
    },
    createBooking: async () =>
      opts.bookingResult ?? { ok: true, booking: bookingFixture() },
  } as unknown as MoozClient;
}

function bookingFixture() {
  return {
    id: "book-1",
    meeting_type_id: "mt-1",
    customer_name: "Shlomo",
    customer_email: "s@example.com",
    customer_phone: "+972500000000",
    start_time: VALID_UTC,
    end_time: VALID_END,
    timezone: "Asia/Jerusalem",
    status: "confirmed",
  };
}

function makeCtx(mooz: MoozClient, admin: MoozDispatchCtx["admin"]): MoozDispatchCtx {
  return {
    admin,
    mooz,
    meetingTypeId: "mt-1",
    conversationId: "conv-1",
    agentId: "agent-1",
    leadPhone: "+972500000000",
  };
}

describe("MOOZ_TOOL_DEFS", () => {
  it("exposes exactly the two expected tool names", () => {
    expect(MOOZ_TOOL_DEFS.map((t) => t.name).sort()).toEqual([
      "book_meeting",
      "list_available_slots",
    ]);
  });

  it("isMoozTool only matches our names", () => {
    expect(isMoozTool("list_available_slots")).toBe(true);
    expect(isMoozTool("book_meeting")).toBe(true);
    expect(isMoozTool("something_else")).toBe(false);
  });
});

describe("dispatchMoozTool — list_available_slots", () => {
  it("blocks until the lead clears the qualification floor", async () => {
    const { admin } = makeAdmin({ leadMemory: null });
    const ctx = makeCtx(makeMoozStub({}), admin);
    const r = await dispatchMoozTool(
      "list_available_slots",
      { preferred_date: "2026-05-21" },
      ctx,
    );
    const parsed = JSON.parse(r.resultJson);
    expect(parsed.blocked).toBe(true);
    expect(parsed.reason).toBe("lead_not_qualified_yet");
    expect(r.bookingCreated).toBe(false);
    // Nothing legitimate to state — the allow-list must be empty.
    expect(r.offeredTimesIL).toEqual([]);
  });

  it("rejects malformed preferred_date", async () => {
    const { admin } = makeAdmin();
    const ctx = makeCtx(makeMoozStub({}), admin);
    const r = await dispatchMoozTool(
      "list_available_slots",
      { preferred_date: "tomorrow" },
      ctx,
    );
    const parsed = JSON.parse(r.resultJson);
    expect(parsed.error).toMatch(/YYYY-MM-DD/);
    expect(r.bookingCreated).toBe(false);
  });

  it("returns trimmed slots with local_il + hint", async () => {
    const slots: MoozAvailableSlot[] = Array.from({ length: 20 }, (_, i) => ({
      start: `2026-05-21T${String(8 + i).padStart(2, "0")}:00:00.000Z`,
      end: `2026-05-21T${String(8 + i).padStart(2, "0")}:30:00.000Z`,
    }));
    const { admin } = makeAdmin();
    const ctx = makeCtx(makeMoozStub({ slots }), admin);
    const r = await dispatchMoozTool(
      "list_available_slots",
      { preferred_date: "2026-05-21", lookahead_days: 1 },
      ctx,
    );
    const parsed = JSON.parse(r.resultJson);
    expect(parsed.slot_count).toBe(12);
    expect(parsed.slots).toHaveLength(12);
    expect(typeof parsed.slots[0].local_il).toBe("string");
    expect(parsed.hint).toContain("Offer 2-3");
    // The allow-list is grounded in the returned slots. 08:00Z → 11:00 IL
    // (summer, IDT +3). The bot may only state these times.
    expect(r.offeredTimesIL).toContain("11:00");
    expect(r.offeredTimesIL.length).toBeGreaterThan(0);
  });

  it("truly-empty result steers AWAY from later dates (no negotiation)", async () => {
    // Both the requested window AND the nearest fallback come back empty.
    const { admin } = makeAdmin();
    const ctx = makeCtx(makeMoozStub({ slots: [] }), admin);
    const r = await dispatchMoozTool(
      "list_available_slots",
      { preferred_date: "2026-05-21" },
      ctx,
    );
    const parsed = JSON.parse(r.resultJson);
    expect(parsed.slot_count).toBe(0);
    expect(parsed.nearest_available_fallback).toBe(false);
    // The whole point of the fix: never invite a later date.
    expect(parsed.hint).toContain("do NOT offer or negotiate a later date");
    // No slots → nothing the bot may state.
    expect(r.offeredTimesIL).toEqual([]);
  });

  it("far-future request falls back to the NEAREST real openings", async () => {
    // Requested window is far out (Mooz returns [] because it's beyond
    // max_days_ahead); the fallback sweep from ~now finds real slots.
    const nearest: MoozAvailableSlot[] = [
      { start: "2026-05-21T08:00:00.000Z", end: "2026-05-21T08:30:00.000Z" },
      { start: "2026-05-21T09:00:00.000Z", end: "2026-05-21T09:30:00.000Z" },
    ];
    const { admin } = makeAdmin();
    const stub = makeMoozStub({
      // Requested window starts on the far-future date → empty.
      // Fallback sweep starts ≈ now (not "2099-…") → returns nearest.
      slots: (args) => (args.from.startsWith("2099-") ? [] : nearest),
    });
    const ctx = makeCtx(stub, admin);
    const r = await dispatchMoozTool(
      "list_available_slots",
      { preferred_date: "2099-01-01", lookahead_days: 3 },
      ctx,
    );
    const parsed = JSON.parse(r.resultJson);
    expect(parsed.nearest_available_fallback).toBe(true);
    expect(parsed.slot_count).toBe(2);
    expect(parsed.hint).toContain("NEAREST real openings");
    // 08:00Z → 11:00 IL (summer, IDT +3). Allow-list must carry it.
    expect(r.offeredTimesIL).toContain("11:00");
  });

  it("Mooz error returns user-facing message", async () => {
    const { admin } = makeAdmin();
    const ctx = makeCtx(makeMoozStub({ slotsError: new Error("network down") }), admin);
    const r = await dispatchMoozTool(
      "list_available_slots",
      { preferred_date: "2026-05-21" },
      ctx,
    );
    const parsed = JSON.parse(r.resultJson);
    expect(parsed.error).toContain("Couldn't reach Mooz");
  });
});

describe("dispatchMoozTool — book_meeting", () => {
  it("blocks (defense in depth) when the lead has neither goal nor pain", async () => {
    // No q3 (goal) and no q4 (pain) → below the floor.
    const { admin, calls } = makeAdmin({
      leadMemory: { q1_age: 30, q2_motivation: "רוצה יותר כסף" },
    });
    const ctx = makeCtx(makeMoozStub({}), admin);
    const r = await dispatchMoozTool(
      "book_meeting",
      {
        start_time: VALID_UTC,
        end_time: VALID_END,
        lead_name: "Shlomo Piven",
        lead_email: "shlomo@example.com",
      },
      ctx,
    );
    const parsed = JSON.parse(r.resultJson);
    expect(parsed.blocked).toBe(true);
    expect(r.bookingCreated).toBe(false);
    // must NOT have touched the DB
    expect(calls.find((c) => c.table === "conversations")).toBeUndefined();
  });

  it("bypasses the floor when lead_requested_booking is true (explicit request / exit-risk)", async () => {
    // Cold lead (no goal, no pain) but explicitly asked to book → must proceed.
    const { admin } = makeAdmin({ leadMemory: { q1_age: 30 } });
    const ctx = makeCtx(makeMoozStub({}), admin);
    const r = await dispatchMoozTool(
      "book_meeting",
      {
        start_time: VALID_UTC,
        end_time: VALID_END,
        lead_name: "Shlomo Piven",
        lead_email: "shlomo@example.com",
        lead_requested_booking: true,
      },
      ctx,
    );
    const parsed = JSON.parse(r.resultJson);
    expect(parsed.blocked).toBeUndefined();
    expect(r.bookingCreated).toBe(true);
  });

  it("happy path updates conversation + lead_memory + returns booking_id", async () => {
    const { admin, calls } = makeAdmin();
    const ctx = makeCtx(makeMoozStub({}), admin);
    const r = await dispatchMoozTool(
      "book_meeting",
      {
        start_time: VALID_UTC,
        end_time: VALID_END,
        lead_name: "Shlomo Piven",
        lead_email: "shlomo@example.com",
      },
      ctx,
    );
    expect(r.bookingCreated).toBe(true);
    const parsed = JSON.parse(r.resultJson);
    expect(parsed.success).toBe(true);
    expect(parsed.booking_id).toBe("book-1");
    // 11:00Z → 14:00 IL, 11:30Z → 14:30 IL (summer). The confirmation may
    // state exactly these.
    expect(r.offeredTimesIL).toEqual(["14:00", "14:30"]);

    const update = calls.find((c) => c.table === "conversations" && c.op === "update");
    expect(update).toBeDefined();
    expect(update!.payload.current_tag).toBe("zoom_scheduled");
    expect(update!.payload.funnel_stage).toBe("done");
    expect(update!.payload.status).toBe("paused");
    expect(update!.payload.lead_name).toBe("Shlomo Piven");

    const memoryUpsert = calls.find((c) => c.table === "lead_memory" && c.op === "upsert");
    expect(memoryUpsert).toBeDefined();
    expect(memoryUpsert!.payload.q7_email).toBe("shlomo@example.com");

    // book_meeting's next_step hint must include the proactive link line
    // so Claude verbalises it in the confirmation message (v14 behavior).
    expect(parsed.next_step).toContain(
      "הקישור יישלח אליך בוואטסאפ 5 דקות לפני הפגישה",
    );
  });

  it("slot_full surfaces slot_unavailable with retry guidance and does NOT update DB", async () => {
    const { admin, calls } = makeAdmin();
    const ctx = makeCtx(
      makeMoozStub({
        bookingResult: { ok: false, kind: "slot_full", message: "taken" },
      }),
      admin,
    );
    const r = await dispatchMoozTool(
      "book_meeting",
      {
        start_time: VALID_UTC,
        end_time: VALID_END,
        lead_name: "Shlomo",
        lead_email: "s@example.com",
      },
      ctx,
    );
    expect(r.bookingCreated).toBe(false);
    const parsed = JSON.parse(r.resultJson);
    expect(parsed.error).toBe("slot_unavailable");
    expect(parsed.mooz_kind).toBe("slot_full");
    expect(parsed.guidance).toContain("Apologize");
    const update = calls.find((c) => c.table === "conversations" && c.op === "update");
    expect(update).toBeUndefined();
  });

  it("invalid_input from Mooz asks the lead to confirm email", async () => {
    const { admin } = makeAdmin();
    const ctx = makeCtx(
      makeMoozStub({
        bookingResult: { ok: false, kind: "invalid_input", message: "invalid email format" },
      }),
      admin,
    );
    const r = await dispatchMoozTool(
      "book_meeting",
      {
        start_time: VALID_UTC,
        end_time: VALID_END,
        lead_name: "Shlomo",
        lead_email: "shlomo@example.test",
      },
      ctx,
    );
    const parsed = JSON.parse(r.resultJson);
    expect(parsed.error).toBe("invalid_input");
    expect(parsed.guidance).toContain("confirm the address");
  });

  it("locally rejects malformed emails before hitting Mooz", async () => {
    const { admin } = makeAdmin();
    const ctx = makeCtx(makeMoozStub({}), admin);
    const r = await dispatchMoozTool(
      "book_meeting",
      {
        start_time: VALID_UTC,
        end_time: VALID_END,
        lead_name: "Shlomo",
        lead_email: "not-an-email",
      },
      ctx,
    );
    const parsed = JSON.parse(r.resultJson);
    expect(parsed.error).toMatch(/lead_email/);
    expect(r.bookingCreated).toBe(false);
  });

  it("refuses malformed start_time before hitting Mooz", async () => {
    const { admin } = makeAdmin();
    const ctx = makeCtx(makeMoozStub({}), admin);
    const r = await dispatchMoozTool(
      "book_meeting",
      {
        start_time: "tomorrow",
        end_time: VALID_END,
        lead_name: "Shlomo",
        lead_email: "s@example.com",
      },
      ctx,
    );
    const parsed = JSON.parse(r.resultJson);
    expect(parsed.error).toMatch(/UTC ISO/);
    expect(r.bookingCreated).toBe(false);
  });

  it("unknown tool name returns structured error", async () => {
    const { admin } = makeAdmin();
    const ctx = makeCtx(makeMoozStub({}), admin);
    const r = await dispatchMoozTool("hax0r", {}, ctx);
    const parsed = JSON.parse(r.resultJson);
    expect(parsed.error).toContain("unknown tool");
  });
});
