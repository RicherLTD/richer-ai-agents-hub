// anthropicRetry.ts
//
// Wraps an Anthropic SDK call with retry on 429 / 5xx / 529 (overloaded).
// Honors the retry-after header when the SDK surfaces it. After N
// attempts the original error is rethrown so the caller can DLQ.
//
// Why: Anthropic\'s tier-2 Sonnet limit is ~50 RPM. During ad-campaign
// spikes we will see 429s. Without retry the lead\'s turn drops to the
// DLQ on the first failure — they get silence and nobody notices.

interface RetryableError {
  status?: unknown;
  headers?: unknown;
  message?: unknown;
}

function getStatus(err: unknown): number | null {
  if (!err || typeof err !== "object") return null;
  const s = (err as RetryableError).status;
  return typeof s === "number" ? s : null;
}

function getRetryAfterMs(err: unknown): number | null {
  if (!err || typeof err !== "object") return null;
  const h = (err as RetryableError).headers;
  if (!h || typeof h !== "object") return null;
  // Headers may be a Headers instance or a plain record.
  const raw = (h as Record<string, unknown>)["retry-after"]
    ?? (h as Record<string, unknown>)["Retry-After"];
  if (typeof raw === "string") {
    const n = parseInt(raw, 10);
    if (Number.isFinite(n) && n > 0 && n < 120) return n * 1000;
  }
  return null;
}

function isRetryable(err: unknown): boolean {
  const status = getStatus(err);
  if (status === null) {
    // Network-level errors (DNS, TLS, fetch reject) typically come as
    // generic errors with no status — treat as retryable.
    return true;
  }
  return status === 429 || status === 408 || (status >= 500 && status <= 599);
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

export interface RetryConfig {
  maxAttempts: number;
  /** Base delay in ms; actual delay = base * 2^(attempt-1) + jitter. */
  baseDelayMs: number;
  /** Optional callback invoked on each retry attempt (for telemetry). */
  onRetry?: (info: { attempt: number; delayMs: number; status: number | null }) => void;
}

const DEFAULT_CONFIG: RetryConfig = {
  maxAttempts: 3,
  baseDelayMs: 1000,
};

/**
 * Run `fn` with retry on 429/5xx/network errors. Returns fn\'s value on
 * success; rethrows the last error if all attempts fail. Never swallows
 * non-retryable errors (4xx other than 429) — those rethrow immediately.
 */
export async function callWithRetry<T>(
  fn: () => Promise<T>,
  config: Partial<RetryConfig> = {},
): Promise<T> {
  const cfg = { ...DEFAULT_CONFIG, ...config };
  let lastErr: unknown;
  for (let attempt = 1; attempt <= cfg.maxAttempts; attempt++) {
    try {
      return await fn();
    } catch (err) {
      lastErr = err;
      if (attempt >= cfg.maxAttempts) break;
      if (!isRetryable(err)) break;
      const retryAfter = getRetryAfterMs(err);
      const backoff = cfg.baseDelayMs * Math.pow(2, attempt - 1);
      const jitter = Math.random() * (cfg.baseDelayMs * 0.5);
      const delayMs = retryAfter ?? Math.floor(backoff + jitter);
      cfg.onRetry?.({ attempt, delayMs, status: getStatus(err) });
      await sleep(delayMs);
    }
  }
  throw lastErr;
}
