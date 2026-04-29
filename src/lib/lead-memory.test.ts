import { beforeEach, describe, expect, it, vi } from "vitest";

const { fromMock } = vi.hoisted(() => ({
  fromMock: vi.fn(),
}));

vi.mock("@/lib/supabase/client", () => ({
  supabase: { from: fromMock },
}));

import { getLeadMemory } from "./lead-memory";

function chain(result: { data: unknown; error: unknown }) {
  const eq = { maybeSingle: vi.fn().mockResolvedValue(result) };
  return {
    select: vi.fn(() => ({ eq: vi.fn(() => eq) })),
  };
}

beforeEach(() => {
  fromMock.mockReset();
});

describe("getLeadMemory", () => {
  it("returns the row when one exists", async () => {
    const row = { conversation_id: "c1", q1_age: 32 };
    fromMock.mockReturnValue(chain({ data: row, error: null }));

    const result = await getLeadMemory("c1");

    expect(result).toEqual(row);
    expect(fromMock).toHaveBeenCalledWith("lead_memory");
  });

  it("returns null when there's no row yet", async () => {
    fromMock.mockReturnValue(chain({ data: null, error: null }));

    expect(await getLeadMemory("c1")).toBeNull();
  });

  it("throws a wrapped error", async () => {
    fromMock.mockReturnValue(chain({ data: null, error: { message: "boom" } }));

    await expect(getLeadMemory("c1")).rejects.toThrow("Failed to load lead memory: boom");
  });
});
