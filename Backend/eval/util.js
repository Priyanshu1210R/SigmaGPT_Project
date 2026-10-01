// Small helpers so a 20-question run survives Gemini's per-minute rate limits.

export const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

const RETRYABLE_STATUS = new Set([429, 500, 502, 503, 504]);

/** Is this the kind of error that's worth retrying (rate limit / transient server error)? */
export function isRetryable(err) {
  if (RETRYABLE_STATUS.has(err?.status)) return true;
  return /fetch failed|ECONNRESET|ETIMEDOUT|EAI_AGAIN|overloaded|unavailable/i.test(err?.message || "");
}

/**
 * Run fn(), retrying transient failures with exponential backoff + jitter.
 * @param {() => Promise<T>} fn
 * @param {{retries?: number, baseMs?: number, sleepFn?: (ms:number)=>Promise<void>}} [opts]
 * @returns {Promise<T>}
 */
export async function withRetry(fn, { retries = 4, baseMs = 2000, sleepFn = sleep } = {}) {
  for (let attempt = 0; ; attempt++) {
    try {
      return await fn();
    } catch (err) {
      if (attempt >= retries || !isRetryable(err)) throw err;
      await sleepFn(baseMs * 2 ** attempt + Math.random() * 500);
    }
  }
}

/** Map over items with at most `limit` in flight, preserving input order in the result. */
export async function mapPool(items, limit, fn) {
  const results = new Array(items.length);
  let next = 0;
  const worker = async () => {
    while (next < items.length) {
      const i = next++;
      results[i] = await fn(items[i], i);
    }
  };
  await Promise.all(Array.from({ length: Math.max(1, Math.min(limit, items.length)) }, worker));
  return results;
}
