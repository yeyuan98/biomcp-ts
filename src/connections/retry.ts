/**
 * Retry infrastructure for handling transient failures in external API calls.
 *
 * This module provides utilities for wrapping async functions with retry logic,
 * exponential backoff, and jitter to handle rate limits (HTTP 429) and other
 * transient network errors gracefully.
 */

/**
 * Configuration options for retry behavior.
 */
export interface RetryOptions {
  /**
   * Maximum number of retry attempts (excluding the initial attempt).
   * @default 3
   */
  maxRetries?: number;

  /**
   * Base delay in milliseconds before the first retry.
   * Subsequent delays follow exponential backoff: baseDelayMs * 2^attempt
   * @default 1000
   */
  baseDelayMs?: number;

  /**
   * Maximum delay cap in milliseconds to prevent excessively long waits.
   * @default 30000
   */
  maxDelayMs?: number;

  /**
   * Whether to add random jitter to delays to prevent thundering herd.
   * When enabled, adds ±15% random variation to the exponential delay.
   * @default true
   */
  jitter?: boolean;

  /**
   * Custom function to determine if an error is retryable.
   * If not provided, uses the default `isRetryableError` function.
   */
  isRetryable?: (error: unknown) => boolean;

  /**
   * Optional logger for warning messages during retries.
   * Should implement a `warn` method compatible with `console.warn`.
   * @default console
   */
  logger?: Pick<Console, 'warn'>;
}

/**
 * Client (4xx) HTTP error codes that should NOT be retried.
 * These indicate client errors (bad request, unauthorized, not found, etc.)
 * and retrying won't help.
 *
 * Note: 429 (Too Many Requests) is intentionally excluded from this list as it
 * is retryable - it represents rate limiting which should be retried with backoff.
 */
const NON_RETRYABLE_4XX_PATTERNS = [
  '400',
  '401',
  '402',
  '403',
  '404',
  '405',
  '406',
  '407',
  '408',
  '409',
  '410',
  '411',
  '412',
  '413',
  '414',
  '415',
  '416',
  '417',
  '418',
  '421',
  '422',
  '423',
  '424',
  '425',
  '426',
  '428',
];

/**
 * Retryable error patterns.
 * 429 is explicitly retryable (rate limiting).
 * 5xx server errors are retryable (server-side issues).
 * Network errors are retryable (transient connectivity issues).
 */
const RETRYABLE_PATTERNS = [
  '429',
  'too many requests',
  'rate limit',
  '5', // 5xx server errors
  'network',
  'timeout',
  'econnreset',
  'etimedout',
  'econnrefused',
  'enotfound',
  'socket hang up',
];

/**
 * Determines if an error is retryable based on its message content.
 *
 * @param error - The error to evaluate (typically an Error object)
 * @returns `true` if the error indicates a transient failure that may succeed on retry
 *
 * @example
 * ```ts
 * isRetryableError(new Error('HTTP 429 Too Many Requests')); // true
 * isRetryableError(new Error('HTTP 500 Internal Server Error')); // true
 * isRetryableError(new Error('HTTP 400 Bad Request')); // false
 * isRetryableError(new Error('ECONNRESET')); // true
 * ```
 */
export function isRetryableError(error: unknown): boolean {
  if (error instanceof Error) {
    const msg = error.message.toLowerCase();

    // First check for non-retryable 4xx errors (except 429)
    // Must check before retryable patterns since 429 starts with '4'
    for (const pattern of NON_RETRYABLE_4XX_PATTERNS) {
      if (msg.includes(pattern)) {
        return false;
      }
    }

    // Then check for retryable patterns
    return RETRYABLE_PATTERNS.some(pattern => msg.includes(pattern));
  }
  return false;
}

/**
 * Wraps an async function with retry logic using exponential backoff with jitter.
 *
 * The function will attempt to execute `fn` up to `maxRetries + 1` times total
 * (initial attempt + retries). Only retryable errors trigger retries; non-retryable
 * errors are thrown immediately.
 *
 * @param fn - The async function to execute. Called on each attempt.
 * @param options - Retry configuration options
 * @returns A promise that resolves with the result of `fn` or throws the last error
 *
 * @example
 * ```ts
 * // Basic usage with defaults
 * const data = await withRetry(() => fetch('https://api.example.com/data'));
 *
 * // Custom retry configuration
 * const data = await withRetry(
 *   () => fetchData(),
 *   {
 *     maxRetries: 5,
 *     baseDelayMs: 2000,
 *     maxDelayMs: 60000,
 *     jitter: false,
 *     logger: customLogger,
 *   }
 * );
 *
 * // Custom retryable predicate
 * const data = await withRetry(
 *   () => apiCall(),
 *   {
 *     isRetryable: (err) => err instanceof NetworkError,
 *   }
 * );
 * ```
 */
export async function withRetry<T>(
  fn: () => Promise<T>,
  options: RetryOptions = {}
): Promise<T> {
  const {
    maxRetries = 3,
    baseDelayMs = 1000,
    maxDelayMs = 30000,
    jitter = true,
    isRetryable = isRetryableError,
    logger = console,
  } = options;

  let lastError: unknown;

  for (let attempt = 0; attempt <= maxRetries; attempt++) {
    try {
      return await fn();
    } catch (error) {
      lastError = error;

      // Check if we should retry this error
      if (attempt < maxRetries && isRetryable(error)) {
        // Calculate exponential delay: baseDelayMs * 2^attempt
        const exponentialDelay = baseDelayMs * Math.pow(2, attempt);

        // Add jitter: ±15% random variation when enabled
        const jitterMs = jitter ? exponentialDelay * 0.15 * (Math.random() * 2 - 1) : 0;

        // Apply max delay cap
        const delay = Math.min(exponentialDelay + jitterMs, maxDelayMs);

        logger.warn(
          `[retry] Attempt ${attempt + 1}/${maxRetries + 1} failed, retrying in ${Math.round(delay)}ms`
        );

        await new Promise(resolve => setTimeout(resolve, delay));
      } else {
        // Either no retries left or error is not retryable
        throw error;
      }
    }
  }

  // This should never be reached due to the throw above,
  // but TypeScript needs it for type safety
  throw lastError;
}
