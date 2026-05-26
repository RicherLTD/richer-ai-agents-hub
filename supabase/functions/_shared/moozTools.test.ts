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

function makeAdmin(): {
  admin: MoozDispatchCtx["admin"];
  calls: AdminCall[];
} {
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
      };
    },
  };
  return { admin: adminAny, calls };
}

function makeMoozStub(opts: {
  slots?: MoozAvailableSlot[];
  slotsError?: Error;
  bookingResult?: MoozCreateBookingResult;
}): MoozClient {
  return {
    listAvailableSlots: async () => {
      if (opts.slotsError) throw opts.slotsError;
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
  });

  it("empty result yields 'try different day' guidance", async () => {
    const { admin } = makeAdmin();
    const ctx = makeCtx(makeMoozStub({ slots: [] }), admin);
    const r = await dispatchMoozTool(
      "list_available_slots",
      { preferred_date: "2026-05-21" },
      ctx,
    );
    const parsed = JSON.parse(r.resultJson);
    expect(parsed.slot_count).toBe(0);
    expect(parsed.hint).toContain("different day");
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
