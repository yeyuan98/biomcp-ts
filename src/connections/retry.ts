import { HttpConnectionError } from './errors.js';

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
   * Optional total wall-clock budget (ms) for the whole `withRetry` call —
   * all attempts plus backoff delays. Checked before starting each RETRY
   * (the first attempt always runs, unconditionally, so callers can size
   * the budget as timeoutMs + one backoff). If the budget is already spent,
   * or the backoff wait plus a duration estimate of the next attempt (the
   * last attempt's observed duration) would exceed it, the last error is
   * rethrown instead of retrying — same error object and type, with a
   * `retry budget exhausted` note (source, spend, attempts, remedy)
   * replacing `message`.
   *
   * This caps retry amplification (#107): a retryable timeout must not let
   * attempts × timeoutMs stack into a minutes-long logical request.
   * Unset = no budget (legacy behavior: retries limited only by maxRetries).
   */
  maxTotalMs?: number;

  /**
   * Optional source identifier for error attribution, threaded in by the
   * connection layer (`this.sourceId`). Included in the budget-exhausted
   * note so a multi-source reply pinpoints WHICH upstream gave up (#132).
   */
  sourceId?: string;

  /**
   * Optional logger for warning messages during retries.
   * Should implement a `warn` method compatible with `console.warn`.
   * @default console
   */
  logger?: Pick<Console, 'warn'>;
}

/**
 * Network-level failure signatures produced by fetch itself (transport
 * resets, DNS, timeouts/aborts). Matched against the error message and,
 * when Node wraps a socket error, the `cause.code`. Deliberately free of
 * digit patterns so numbers inside messages never trigger retries.
 */
const NETWORK_ERROR_RE =
  /fetch failed|network|timeout|timed out|aborted|econnreset|etimedout|econnrefused|enotfound|enetunreach|eai_again|socket hang up/i;

/**
 * Determines if an error is retryable.
 *
 * `HttpConnectionError` (thrown by the connection layer) is classified by
 * its typed status: 429 and 5xx (and status-less network failures) retry;
 * other 4xx do not. Plain errors thrown by fetch fall back to a curated
 * network-signature match.
 *
 * @param error - The error to evaluate (typically an Error object)
 * @returns `true` if the error indicates a transient failure that may succeed on retry
 *
 * @example
 * ```ts
 * isRetryableError(new HttpConnectionError('HTTP 429 ...', 429)); // true
 * isRetryableError(new HttpConnectionError('HTTP 400 ...', 400)); // false
 * isRetryableError(new Error('ECONNRESET')); // true
 * isRetryableError(new Error('HTTP 418 id 5123')); // false
 * ```
 */
export function isRetryableError(error: unknown): boolean {
  if (error instanceof HttpConnectionError) {
    return error.retryable;
  }
  if (error instanceof Error) {
    const cause = (error.cause as { code?: string } | undefined)?.code ?? '';
    return NETWORK_ERROR_RE.test(error.message) || NETWORK_ERROR_RE.test(cause);
  }
  return false;
}

/**
 * Marker included in a retryable error's message when `maxTotalMs` stops
 * the retry loop. Checked before annotating so the note is never duplicated.
 */
const BUDGET_EXHAUSTED_NOTE = 'retry budget exhausted';

/**
 * Annotate a budget-exhausted error in place: same object, same type —
 * only `message` changes. `Object.defineProperty` is used instead of `+=`
 * because some thrown values expose `message` as a getter-only prototype
 * accessor: Node's `AbortSignal.timeout()` rejects fetch with a DOMException
 * whose `message` lives on `DOMException.prototype`, and a strict-mode `+=`
 * on it throws `TypeError: Cannot set property 'message' …`, REPLACING the
 * real timeout error (#132). An own `value` property cleanly shadows the
 * accessor — `instanceof` checks, `name`, and typed fields (`status`,
 * `retryable`) are untouched, and string-matching consumers of the original
 * message keep working (the original text is preserved verbatim as the
 * prefix).
 *
 * Guard is a duck-type check on `message` (not `instanceof Error`): the
 * thrown value may cross realms (undici/Node globals under Jest's vm), where
 * `instanceof` false-FAILS while the property is still present — the same
 * rationale as the name-based SyntaxError check in rest.ts. Values without a
 * string `message` (plain strings, numbers) are returned untouched.
 */
function noteBudgetExhausted(
  error: unknown,
  context: { sourceId?: string; maxTotalMs: number; elapsedMs: number; attempts: number }
): unknown {
  const message = (error as { message?: unknown } | null | undefined)?.message;
  if (typeof message !== 'string' || message.includes(BUDGET_EXHAUSTED_NOTE)) {
    return error;
  }
  const source = context.sourceId ? `${context.sourceId} ` : '';
  Object.defineProperty(error, 'message', {
    value:
      `${message} — ${source}${BUDGET_EXHAUSTED_NOTE} ` +
      `(${context.maxTotalMs} ms; spent ${context.elapsedMs} ms over ${context.attempts} attempts). ` +
      `Retry in a few minutes; if it persists, narrow the request.`,
    configurable: true,
  });
  return error;
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
    maxTotalMs,
    sourceId,
  } = options;

  const start = Date.now();
  let lastError: unknown;

  for (let attempt = 0; attempt <= maxRetries; attempt++) {
    const attemptStart = Date.now();
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

        // Total-time budget (checked before starting a RETRY only — the
        // first attempt above is never gated). Give up when the budget is
        // already spent, or when the backoff wait plus an estimate of the
        // next attempt (the last attempt's observed duration — attempts are
        // timeout-bounded, so the previous one is the best cheap estimate)
        // would exceed it. Fast-failing errors (near-zero duration) are
        // unaffected, so legitimate quick retry loops still run to
        // maxRetries.
        const elapsed = Date.now() - start;
        const lastAttemptMs = Date.now() - attemptStart;
        if (
          maxTotalMs !== undefined &&
          (elapsed >= maxTotalMs || elapsed + delay + lastAttemptMs > maxTotalMs)
        ) {
          logger.warn(
            `[retry] Attempt ${attempt + 1}/${maxRetries + 1} failed; ${BUDGET_EXHAUSTED_NOTE} (maxTotalMs ${maxTotalMs}, elapsed ${elapsed}ms, next retry projected +${Math.round(delay + lastAttemptMs)}ms)`
          );
          throw noteBudgetExhausted(error, {
            sourceId,
            maxTotalMs,
            elapsedMs: elapsed,
            attempts: attempt + 1,
          });
        }

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
