const MAX_RETRIES = 3;
const RETRY_DELAY_MS = 3000;

function isRetryable(error: unknown): boolean {
  if (error instanceof Error) {
    const msg = error.message.toLowerCase();
    return (
      msg.includes('429') ||
      msg.includes('too many requests') ||
      msg.includes('rate limit') ||
      msg.includes('fetch failed') ||
      msg.includes('econnreset') ||
      msg.includes('etimedout')
    );
  }
  return false;
}

const NETWORK_ROW_RE = /fetch failed|timeout|timed out|econnreset|etimedout/i;

function hasTransientErrorRow(result: unknown): boolean {
  if (!Array.isArray(result)) return false;
  return result.some(
    (r: any) =>
      r?._error !== undefined &&
      typeof r._error === 'string' &&
      NETWORK_ROW_RE.test(r._error),
  );
}

export async function retryOnRateLimit<T>(
  fn: () => Promise<T>,
  retries = MAX_RETRIES,
  delay = RETRY_DELAY_MS,
): Promise<T> {
  for (let attempt = 0; attempt <= retries; attempt++) {
    try {
      const result = await fn();
      if (attempt < retries && hasTransientErrorRow(result)) {
        console.warn(`[retry] Result contains transient network error rows, retrying in ${delay}ms...`);
        await new Promise((r) => setTimeout(r, delay));
        continue;
      }
      return result;
    } catch (error) {
      if (attempt < retries && isRetryable(error)) {
        console.warn(
          `[retry] Attempt ${attempt + 1}/${retries} failed with retryable error, retrying in ${delay}ms...`,
        );
        await new Promise((r) => setTimeout(r, delay));
      } else {
        throw error;
      }
    }
  }
  return fn();
}
