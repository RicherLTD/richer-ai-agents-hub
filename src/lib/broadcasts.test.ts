import { describe, expect, it, vi } from "vitest";

const rpcMock = vi.fn();
vi.mock("@/lib/supabase/client", () => ({ supabase: { rpc: (...args: unknown[]) => rpcMock(...args) } }));

import { describeSuppression, fetchStatusCounts, registrationWindow } from "./broadcasts";

const localMidnight = (day: string) => new Date(`${day}T00:00:00`).toISOString();

describe("registrationWindow", () => {
  it("covers whole days, with the end date included", () => {
    expect(registrationWindow("2026-10-01", "2026-10-07")).toEqual({
      registered_from: localMidnight("2026-10-01"),
      registered_before: localMidnight("2026-10-08"),
    });
  });

  it("rolls the inclusive end over a month boundary", () => {
    expect(registrationWindow("", "2026-09-30").registered_before).toBe(localMidnight("2026-10-01"));
  });

  it("leaves an empty side unbounded", () => {
    expect(registrationWindow("", "")).toEqual({ registered_from: null, registered_before: null });
    expect(registrationWindow("2026-10-01", "").registered_before).toBeNull();
  });

  it("treats a one-day window as that whole day", () => {
    const w = registrationWindow("2026-10-05", "2026-10-05");
    expect(new Date(w.registered_before!).getTime() - new Date(w.registered_from!).getTime()).toBe(24 * 60 * 60 * 1000);
  });
});

describe("describeSuppression", () => {
  it("lists non-zero reasons in Hebrew, largest first", () => {
    expect(describeSuppression({ invalid_phone: 1, opt_out: 7, blocking_tag: 0 })).toBe("ביקשו הסרה: 7 · מספר לא תקין: 1");
  });
});

describe("fetchStatusCounts", () => {
  it("passes the window and normalises the rows (bigint counts arrive as strings)", async () => {
    rpcMock.mockResolvedValueOnce({
      data: [
        { kind: "sub", code: 14, name: "ל\"מ - מחיר", leads: "312" },
        { kind: "sub", code: null, name: null, leads: 40 },
        { kind: "main", code: 13, name: "מחודש", leads: 900 },
      ],
      error: null,
    });
    const rows = await fetchStatusCounts("agent-1", { registered_from: "2026-10-01T00:00:00.000Z", registered_before: null });
    expect(rpcMock).toHaveBeenCalledWith("broadcast_status_counts", {
      p_agent_id: "agent-1",
      p_registered_from: "2026-10-01T00:00:00.000Z",
      p_registered_before: null,
    });
    expect(rows).toEqual([
      { kind: "sub", code: 14, name: "ל\"מ - מחיר", leads: 312 },
      { kind: "sub", code: null, name: null, leads: 40 },
      { kind: "main", code: 13, name: "מחודש", leads: 900 },
    ]);
  });
});
