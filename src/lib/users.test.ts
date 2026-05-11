import { beforeEach, describe, expect, it, vi } from "vitest";

const { getUserMock, fromMock } = vi.hoisted(() => ({
  getUserMock: vi.fn(),
  fromMock: vi.fn(),
}));

vi.mock("@/lib/supabase/client", () => ({
  supabase: {
    auth: { getUser: getUserMock },
    from: fromMock,
  },
}));

import { getCurrentAppUser } from "./users";

beforeEach(() => {
  getUserMock.mockReset();
  fromMock.mockReset();
});

describe("getCurrentAppUser", () => {
  it("returns null when there is no signed-in user", async () => {
    getUserMock.mockResolvedValue({ data: { user: null } });

    const result = await getCurrentAppUser();

    expect(result).toBeNull();
    expect(fromMock).not.toHaveBeenCalled();
  });

  it("returns the matching app_users row for the signed-in user", async () => {
    getUserMock.mockResolvedValue({ data: { user: { id: "user-1" } } });
    const row = { id: "user-1", email: "izak@example.com", role: "admin" };
    const maybeSingle = vi.fn().mockResolvedValue({ data: row, error: null });
    const eq = vi.fn(() => ({ maybeSingle }));
    const select = vi.fn(() => ({ eq }));
    fromMock.mockReturnValue({ select });

    const result = await getCurrentAppUser();

    expect(result).toEqual(row);
    expect(fromMock).toHaveBeenCalledWith("app_users");
  });

  it("returns null when RLS hides the row (no error, no data)", async () => {
    getUserMock.mockResolvedValue({ data: { user: { id: "user-2" } } });
    const maybeSingle = vi.fn().mockResolvedValue({ data: null, error: null });
    fromMock.mockReturnValue({ select: () => ({ eq: () => ({ maybeSingle }) }) });

    const result = await getCurrentAppUser();

    expect(result).toBeNull();
  });

  it("throws a wrapped error when the query fails", async () => {
    getUserMock.mockResolvedValue({ data: { user: { id: "user-3" } } });
    const maybeSingle = vi.fn().mockResolvedValue({
      data: null,
      error: { message: "db down" },
    });
    fromMock.mockReturnValue({ select: () => ({ eq: () => ({ maybeSingle }) }) });

    await expect(getCurrentAppUser()).rejects.toThrow("Failed to load app user: db down");
  });
});
