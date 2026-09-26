export class HttpError extends Error {
  constructor(public service: string, public status: number, body: string) {
    super(`${service} HTTP ${status}: ${body.slice(0, 1000)}`);
  }
}

const isRetryable = (err: unknown) =>
  (err instanceof HttpError && (err.status >= 500 || err.status === 429)) ||
  (err instanceof Error && (err.name === "TimeoutError" || err.name === "AbortError"));

const isRateLimit = (err: unknown) => err instanceof HttpError && err.status === 429;
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

/**
 * Retries `retries` times on timeout or 5xx. 429 rate limits get their own budget
 * (`rateLimitRetries`) with exponential backoff (4s, 8s, 16s, ...). Anything else fails immediately.
 */
export async function withRetry<T>(label: string, retries: number, fn: () => Promise<T>, rateLimitRetries = 0): Promise<T> {
  let failures = 0;
  let limited = 0;
  for (;;) {
    try {
      return await fn();
    } catch (err) {
      if (isRateLimit(err) && limited < rateLimitRetries) {
        const wait = 4000 * 2 ** limited++;
        console.warn(`[retry] ${label} rate-limited; waiting ${wait / 1000}s`);
        await sleep(wait);
        continue;
      }
      if (failures++ >= retries || !isRetryable(err)) throw err;
      console.warn(`[retry] ${label} failed (${(err as Error).message.slice(0, 200)}); retrying`);
    }
  }
}

/** Sliding-window limiter: at most `rpm` starts per rolling 60s for each key. */
export function createRateLimiter(rpm: number) {
  const starts = new Map<string, number[]>();
  return async function acquire(key: string): Promise<void> {
    for (;;) {
      const now = Date.now();
      const recent = (starts.get(key) ?? []).filter((t) => now - t < 60_000);
      if (recent.length < rpm) {
        recent.push(now);
        starts.set(key, recent);
        return;
      }
      starts.set(key, recent);
      await sleep(60_000 - (now - recent[0]) + 50);
    }
  };
}
