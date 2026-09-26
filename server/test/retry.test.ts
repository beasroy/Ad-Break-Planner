import { describe, expect, it, vi } from "vitest";
import { HttpError, createRateLimiter, withRetry } from "../src/lib/retry";

describe("withRetry", () => {
  it("waits and retries on 429 using the separate rate-limit budget", async () => {
    vi.useFakeTimers();
    let calls = 0;
    const p = withRetry("t", 0, async () => {
      if (++calls < 3) throw new HttpError("x", 429, "slow down");
      return "ok";
    }, 4);
    await vi.runAllTimersAsync();
    await expect(p).resolves.toBe("ok");
    expect(calls).toBe(3);
    vi.useRealTimers();
  });

  it("does not retry client errors", async () => {
    let calls = 0;
    await expect(withRetry("t", 3, async () => { calls++; throw new HttpError("x", 400, "bad"); }, 4)).rejects.toThrow(/400/);
    expect(calls).toBe(1);
  });
});

describe("createRateLimiter", () => {
  it("holds the (rpm+1)th call until the window frees up", async () => {
    vi.useFakeTimers();
    const acquire = createRateLimiter(2);
    await acquire("m");
    await acquire("m");
    let third = false;
    const p = acquire("m").then(() => (third = true));
    await vi.advanceTimersByTimeAsync(30_000);
    expect(third).toBe(false);
    await vi.advanceTimersByTimeAsync(31_000);
    await p;
    expect(third).toBe(true);
    vi.useRealTimers();
  });
});
