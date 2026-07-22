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
  slots?: MoozAvailableSlot[];
  slotsError?: Error;
  bookingResult?: MoozCreateBookingResult;
  /** Result of the cross-product dedup lookup. Defaults to not-booked so
   *  existing happy-path tests proceed into createBooking. */
  lookup?: Awaited<ReturnType<MoozClient["lookupByPhone"]>>;
}): MoozClient {
  return {
    listAvailableSlots: async () => {
      if (opts.slotsError) throw opts.slotsError;
      return opts.slots ?? [];
    },
    createBooking: async () =>
      opts.bookingResult ?? { ok: true, booking: bookingFixture() },
    lookupByPhone: async () => opts.lookup ?? { booked: false },
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
    // No slots → nothing the bot may state.
    expect(r.offeredTimesIL).toEqual([]);
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
  it("blocks (defense in depth) when the lead has not cleared the floor", async () => {
    // Neither a goal (q3) nor a pain (q4) surfaced → below the v3 floor
    // (zoomGate.ts: the lead must have at least one of goal / pain).
    const { admin, calls } = makeAdmin({
      leadMemory: { q1_age: 30, q5_urgency: "החודש" },
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
    // Intentionally NOT paused — the bot stays active after booking so it
    // can answer the lead's follow-up questions (the booked-status block
    // prevents re-offering slots). See updateConversationOnBooking.
    expect(update!.payload.status).toBeUndefined();
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

  it("blocks a second booking when the lead already has a future zoom (any product)", async () => {
    const { admin, calls } = makeAdmin();
    const ctx = makeCtx(
      makeMoozStub({ lookup: { booked: true, scheduledAt: VALID_UTC, meetingId: "m-1" } }),
      admin,
    );
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
    expect(parsed.reason).toBe("already_booked");
    expect(r.bookingCreated).toBe(false);
    // Guard returns before createBooking → no DB writes at all.
    expect(calls.find((c) => c.table === "conversations")).toBeUndefined();
  });

  it("allows the booking on an explicit reschedule, even if already booked", async () => {
    const { admin } = makeAdmin();
    const ctx = makeCtx(
      makeMoozStub({ lookup: { booked: true, scheduledAt: VALID_UTC, meetingId: "m-1" } }),
      admin,
    );
    const r = await dispatchMoozTool(
      "book_meeting",
      {
        start_time: VALID_UTC,
        end_time: VALID_END,
        lead_name: "Shlomo Piven",
        lead_email: "shlomo@example.com",
        lead_requested_reschedule: true,
      },
      ctx,
    );
    expect(r.bookingCreated).toBe(true);
    expect(JSON.parse(r.resultJson).success).toBe(true);
  });

  it("fails open — proceeds to book when the dedup lookup errors", async () => {
    const { admin } = makeAdmin();
    const ctx = makeCtx(
      makeMoozStub({ lookup: { booked: false, error: "MOOZ_API_TOKEN not configured" } }),
      admin,
    );
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
  });

  it("slot_full surfaces slot_unavailable WITHOUT re-offer guidance and does NOT update DB", async () => {
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
    // The re-offer loop was removed on purpose — the bot is explicitly told
    // NOT to re-list slots or offer alternatives, and to hand off to a human.
    expect(parsed.guidance).toContain("אל תקרא ל-list_available_slots");
    expect(parsed.guidance).toContain("נציג");
    const update = calls.find((c) => c.table === "conversations" && c.op === "update");
    expect(update).toBeUndefined();
  });

  it("duplicate is treated as already-booked-this-slot, not as a taken slot, and does NOT update DB", async () => {
    const { admin, calls } = makeAdmin();
    const ctx = makeCtx(
      makeMoozStub({
        bookingResult: { ok: false, kind: "duplicate", message: "Duplicate booking" },
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
    expect(parsed.error).toBe("already_booked_this_slot");
    expect(parsed.mooz_kind).toBe("duplicate");
    // Treated as already-booked: confirm the existing time, do not re-offer.
    expect(parsed.guidance).toContain("כבר קבועה");
    expect(parsed.guidance).toContain("אל תקרא ל-book_meeting או ל-list_available_slots שוב");
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

// ── Fireberry existing-customer / blacklist gate ─────────────────────

function makeFireberry(
  outcome: { blocked: boolean; statuscode: number | null } | Error,
): NonNullable<MoozDispatchCtx["fireberry"]> {
  return {
    lookupBlockingStatus: async () => {
      if (outcome instanceof Error) throw outcome;
      return outcome;
    },
  };
}

describe("dispatchMoozTool — Fireberry status gate", () => {
  it("book_meeting: blocks a registered student (statuscode 2), does not book, tags requires_human", async () => {
    const { admin, calls } = makeAdmin();
    const mooz = makeMoozStub({});
    const ctx: MoozDispatchCtx = {
      ...makeCtx(mooz, admin),
      fireberry: makeFireberry({ blocked: true, statuscode: 2 }),
    };
    const r = await dispatchMoozTool(
      "book_meeting",
      { start_time: VALID_UTC, end_time: VALID_END, lead_name: "אילנה", lead_email: "a@b.com" },
      ctx,
    );
    const parsed = JSON.parse(r.resultJson);
    expect(parsed.blocked).toBe(true);
    expect(parsed.reason).toBe("existing_customer_or_blacklist");
    expect(parsed.fireberry_statuscode).toBe(2);
    expect(r.bookingCreated).toBe(false);
    expect(r.offeredTimesIL).toEqual([]);
    // Tagged for a human; never tagged zoom_scheduled.
    const tagUpdate = calls.find(
      (c) => c.table === "conversations" && c.op === "update",
    );
    expect(tagUpdate?.payload.current_tag).toBe("requires_human");
    expect(
      calls.some((c) => c.table === "conversations" && c.payload.current_tag === "zoom_scheduled"),
    ).toBe(false);
  });

  it("list_available_slots: blocks a blacklisted lead (statuscode 11), offers nothing", async () => {
    const { admin } = makeAdmin();
    const ctx: MoozDispatchCtx = {
      ...makeCtx(makeMoozStub({ slots: [{ start: VALID_UTC, end: VALID_END }] }), admin),
      fireberry: makeFireberry({ blocked: true, statuscode: 11 }),
    };
    const r = await dispatchMoozTool("list_available_slots", { preferred_date: "2026-05-21" }, ctx);
    const parsed = JSON.parse(r.resultJson);
    expect(parsed.blocked).toBe(true);
    expect(parsed.fireberry_statuscode).toBe(11);
    expect(r.offeredTimesIL).toEqual([]);
  });

  it("proceeds normally when the lead is not in a blocking status", async () => {
    const { admin } = makeAdmin();
    const ctx: MoozDispatchCtx = {
      ...makeCtx(makeMoozStub({}), admin),
      fireberry: makeFireberry({ blocked: false, statuscode: null }),
    };
    const r = await dispatchMoozTool(
      "book_meeting",
      { start_time: VALID_UTC, end_time: VALID_END, lead_name: "דנה", lead_email: "d@b.com" },
      ctx,
    );
    expect(r.bookingCreated).toBe(true);
  });

  it("fails open (books) when the Fireberry lookup throws", async () => {
    const { admin } = makeAdmin();
    const ctx: MoozDispatchCtx = {
      ...makeCtx(makeMoozStub({}), admin),
      fireberry: makeFireberry(new Error("fireberry 500")),
    };
    const r = await dispatchMoozTool(
      "book_meeting",
      { start_time: VALID_UTC, end_time: VALID_END, lead_name: "דנה", lead_email: "d@b.com" },
      ctx,
    );
    expect(r.bookingCreated).toBe(true);
  });
});
