import { describe, expect, it, vi } from "vitest";

import { callWithRetry } from "./anthropicRetry.ts";

describe("callWithRetry", () => {
  it("returns the result when fn succeeds on first try", async () => {
    const fn = vi.fn(async () => "ok");
    const result = await callWithRetry(fn);
    expect(result).toBe("ok");
    expect(fn).toHaveBeenCalledTimes(1);
  });

  it("retries on 429 then succeeds", async () => {
    let attempts = 0;
    const fn = vi.fn(async () => {
      attempts++;
      if (attempts === 1) {
        const err = new Error("rate limited") as Error & { status: number };
        err.status = 429;
        throw err;
      }
      return "ok-after-retry";
    });
    const result = await callWithRetry(fn, { maxAttempts: 3, baseDelayMs: 1 });
    expect(result).toBe("ok-after-retry");
    expect(fn).toHaveBeenCalledTimes(2);
  });

  it("retries on 503 / overloaded", async () => {
    let attempts = 0;
    const fn = vi.fn(async () => {
      attempts++;
      if (attempts <= 2) {
        const err = new Error("overloaded") as Error & { status: number };
        err.status = 503;
        throw err;
      }
      return "ok";
    });
    const result = await callWithRetry(fn, { maxAttempts: 3, baseDelayMs: 1 });
    expect(result).toBe("ok");
    expect(fn).toHaveBeenCalledTimes(3);
  });

  it("does NOT retry on 401 / 403 / 400 (non-retryable)", async () => {
    const fn = vi.fn(async () => {
      const err = new Error("unauthorized") as Error & { status: number };
      err.status = 401;
      throw err;
    });
    await expect(callWithRetry(fn, { maxAttempts: 3, baseDelayMs: 1 })).rejects.toThrow(
      "unauthorized",
    );
    expect(fn).toHaveBeenCalledTimes(1);
  });

  it("retries on network errors (no status field)", async () => {
    let attempts = 0;
    const fn = vi.fn(async () => {
      attempts++;
      if (attempts === 1) throw new Error("network drop");
      return "ok";
    });
    const result = await callWithRetry(fn, { maxAttempts: 3, baseDelayMs: 1 });
    expect(result).toBe("ok");
    expect(fn).toHaveBeenCalledTimes(2);
  });

  it("rethrows the last error after max attempts", async () => {
    const fn = vi.fn(async () => {
      const err = new Error("still 429") as Error & { status: number };
      err.status = 429;
      throw err;
    });
    await expect(callWithRetry(fn, { maxAttempts: 2, baseDelayMs: 1 })).rejects.toThrow(
      "still 429",
    );
    expect(fn).toHaveBeenCalledTimes(2);
  });

  it("invokes onRetry callback on each retry", async () => {
    let attempts = 0;
    const onRetry = vi.fn();
    const fn = vi.fn(async () => {
      attempts++;
      if (attempts === 1) {
        const err = new Error("transient") as Error & { status: number };
        err.status = 500;
        throw err;
      }
      return "ok";
    });
    await callWithRetry(fn, { maxAttempts: 3, baseDelayMs: 1, onRetry });
    expect(onRetry).toHaveBeenCalledTimes(1);
    expect(onRetry).toHaveBeenCalledWith(
      expect.objectContaining({ attempt: 1, status: 500 }),
    );
  });

  it("honors retry-after header when present", async () => {
    let attempts = 0;
    const fn = vi.fn(async () => {
      attempts++;
      if (attempts === 1) {
        const err = new Error("rate limited") as Error & {
          status: number;
          headers: Record<string, string>;
        };
        err.status = 429;
        err.headers = { "retry-after": "1" };
        throw err;
      }
      return "ok";
    });
    const start = Date.now();
    await callWithRetry(fn, { maxAttempts: 3, baseDelayMs: 1 });
    const elapsed = Date.now() - start;
    // Should have waited ~1s (1000ms) because of retry-after.
    expect(elapsed).toBeGreaterThanOrEqual(900);
    expect(fn).toHaveBeenCalledTimes(2);
  });
});
