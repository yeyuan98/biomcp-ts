import { jest } from '@jest/globals';
import { withRetry, isRetryableError } from '../../connections/retry.js';
import { HttpConnectionError } from '../../connections/errors.js';

jest.useFakeTimers();

// Create error objects at module level to avoid issues with fake timers
const error429 = new HttpConnectionError('HTTP 429: Too Many Requests', 429);
const error429Short = new HttpConnectionError('HTTP 429', 429);
const error400 = new HttpConnectionError('HTTP 400: Bad Request', 400);
const error401 = new HttpConnectionError('HTTP 401: Unauthorized', 401);
const error403 = new HttpConnectionError('HTTP 403: Forbidden', 403);
const error404 = new HttpConnectionError('HTTP 404: Not Found', 404);
const error500 = new HttpConnectionError('HTTP 500: Internal Server Error', 500);
const error503 = new HttpConnectionError('HTTP 503: Service Unavailable', 503);
const error502 = new HttpConnectionError('HTTP 502: Bad Gateway', 502);
const networkError = new Error('Network error');
const timeoutError = new Error('Connection timeout');
const econnreset = new Error('ECONNRESET');
const etimedout = new Error('ETIMEDOUT');

describe('retry', () => {
  beforeEach(() => {
    jest.clearAllMocks();
  });

  describe('withRetry', () => {
    it('succeeds on first attempt', async () => {
      const fn = jest.fn<(...args: any[]) => any>().mockResolvedValue('success');
      const result = await withRetry(fn);
      expect(result).toBe('success');
      expect(fn).toHaveBeenCalledTimes(1);
    });

    it('retries on 429 error and succeeds', async () => {
      const fn = jest.fn<(...args: any[]) => any>()
        .mockRejectedValueOnce(error429)
        .mockResolvedValue('success');

      const promise = withRetry(fn);
      await jest.runAllTimersAsync(); // Run the retry timer to completion
      const result = await promise;

      expect(result).toBe('success');
      expect(fn).toHaveBeenCalledTimes(2);
    });

    it('respects maxRetries and throws after exhausting retries', async () => {
      jest.useRealTimers(); // Use real timers for this test

      const fn = jest.fn<(...args: any[]) => any>()
        .mockRejectedValueOnce(error429)
        .mockRejectedValueOnce(error429)
        .mockRejectedValueOnce(error429);

      const promise = withRetry(fn, { maxRetries: 2, baseDelayMs: 1 });

      let thrownError: unknown;
      try {
        await promise;
      } catch (e) {
        thrownError = e;
      }

      expect(thrownError).toBeInstanceOf(Error);
      expect((thrownError as Error).message).toContain('HTTP 429');
      expect(fn).toHaveBeenCalledTimes(3); // Initial + 2 retries

      jest.useFakeTimers(); // Restore fake timers
    });

    it('applies exponential backoff without jitter', async () => {
      const fn = jest.fn<(...args: any[]) => any>()
        .mockRejectedValueOnce(error429Short)
        .mockRejectedValueOnce(error429Short)
        .mockResolvedValue('success');

      const delays: number[] = [];
      const originalSetTimeout = global.setTimeout;
      global.setTimeout = jest.fn<(...args: any[]) => any>().mockImplementation((callback, delay) => {
        delays.push(delay as number);
        return originalSetTimeout(callback, 0);
      }) as unknown as typeof global.setTimeout;

      try {
        const promise = withRetry(fn, { jitter: false, maxRetries: 2 });
        await jest.runAllTimersAsync();
        await promise;

        expect(delays).toHaveLength(2);
        expect(delays[0]).toBe(1000); // baseDelayMs * 2^0
        expect(delays[1]).toBe(2000); // baseDelayMs * 2^1
      } finally {
        global.setTimeout = originalSetTimeout;
      }
    });

    it('adds jitter when enabled', async () => {
      const fn = jest.fn<(...args: any[]) => any>()
        .mockRejectedValueOnce(error429Short)
        .mockResolvedValue('success');

      const delays: number[] = [];
      const originalSetTimeout = global.setTimeout;
      global.setTimeout = jest.fn<(...args: any[]) => any>().mockImplementation((callback, delay) => {
        delays.push(delay as number);
        return originalSetTimeout(callback, 0);
      }) as unknown as typeof global.setTimeout;

      try {
        const promise = withRetry(fn, { jitter: true, baseDelayMs: 1000 });
        await jest.runAllTimersAsync();
        await promise;

        expect(delays).toHaveLength(1);
        // With jitter enabled, delay should be 1000ms ± 150ms (15%)
        expect(delays[0]).toBeGreaterThan(850);
        expect(delays[0]).toBeLessThan(1150);
      } finally {
        global.setTimeout = originalSetTimeout;
      }
    });

    it('respects maxDelayMs cap', async () => {
      const fn = jest.fn<(...args: any[]) => any>()
        .mockRejectedValueOnce(error429Short)
        .mockRejectedValueOnce(error429Short)
        .mockRejectedValueOnce(error429Short)
        .mockRejectedValueOnce(error429Short)
        .mockResolvedValue('success');

      const delays: number[] = [];
      const originalSetTimeout = global.setTimeout;
      global.setTimeout = jest.fn<(...args: any[]) => any>().mockImplementation((callback, delay) => {
        delays.push(delay as number);
        return originalSetTimeout(callback, 0);
      }) as unknown as typeof global.setTimeout;

      try {
        const promise = withRetry(fn, {
          baseDelayMs: 10000,
          maxDelayMs: 15000,
          jitter: false,
          maxRetries: 4,
        });
        await jest.runAllTimersAsync();
        await promise;

        // Exponential would be: 10000, 20000, 40000, 80000
        // But capped at maxDelayMs: 15000
        expect(delays[0]).toBe(10000);
        expect(delays[1]).toBe(15000); // Capped
        expect(delays[2]).toBe(15000); // Capped
        expect(delays[3]).toBe(15000); // Capped
      } finally {
        global.setTimeout = originalSetTimeout;
      }
    });

    it('throws non-retryable errors immediately', async () => {
      const fn = jest.fn<(...args: any[]) => any>().mockRejectedValue(error400);

      await expect(withRetry(fn)).rejects.toThrow('HTTP 400');
      expect(fn).toHaveBeenCalledTimes(1); // No retries
    });

    it('handles non-Error thrown values', async () => {
      const fn = jest.fn<(...args: any[]) => any>().mockRejectedValue('string error');

      await expect(withRetry(fn)).rejects.toBe('string error');
      expect(fn).toHaveBeenCalledTimes(1); // Not retryable (not an Error)
    });

    it('works with zero retries', async () => {
      const fn = jest.fn<(...args: any[]) => any>().mockRejectedValue(error429Short);

      await expect(withRetry(fn, { maxRetries: 0 })).rejects.toThrow('HTTP 429');
      expect(fn).toHaveBeenCalledTimes(1); // Only initial attempt
    });

    it('uses custom isRetryable function', async () => {
      const customError = new Error('Custom transient error');
      const fn = jest.fn<(...args: any[]) => any>()
        .mockRejectedValueOnce(customError)
        .mockResolvedValue('success');

      const customIsRetryable = jest.fn((err: unknown) => {
        return err instanceof Error && err.message.includes('transient');
      });

      const promise = withRetry(fn, { isRetryable: customIsRetryable });
      await jest.runAllTimersAsync();
      const result = await promise;

      expect(result).toBe('success');
      expect(customIsRetryable).toHaveBeenCalledWith(customError);
      expect(fn).toHaveBeenCalledTimes(2);
    });

    it('uses custom logger', async () => {
      const mockLogger = { warn: jest.fn() };
      const fn = jest.fn<(...args: any[]) => any>()
        .mockRejectedValueOnce(error429Short)
        .mockResolvedValue('success');

      const promise = withRetry(fn, { logger: mockLogger });
      await jest.runAllTimersAsync();
      await promise;

      expect(mockLogger.warn).toHaveBeenCalledWith(
        expect.stringContaining('[retry] Attempt 1/4 failed')
      );
    });
  });

  describe('withRetry total-time budget (maxTotalMs)', () => {
    // Fresh error instances per test: giving up appends the budget note to
    // the error's message in place, which must not leak across tests.
    const fresh429 = () => new HttpConnectionError('HTTP 429: Too Many Requests', 429);

    // Simulate a timeout-bounded attempt under fake timers: each attempt
    // consumes 15s of (fake) wall-clock time before failing retryably.
    const slowTimeoutFn = () =>
      jest.fn<(...args: any[]) => any>().mockImplementation(async () => {
        jest.advanceTimersByTime(15000);
        throw new Error('Connection timeout');
      });

    it('stops retrying when the next retry is projected to exceed maxTotalMs', async () => {
      const fn = slowTimeoutFn();
      // Legacy worst case: 4 × 15s attempts + 3.5s backoffs ≈ 63.5s.
      const promise = withRetry(fn, {
        maxRetries: 3,
        baseDelayMs: 500,
        jitter: false,
        maxTotalMs: 35000,
      });
      const expectation = expect(promise).rejects.toThrow('retry budget exhausted');
      await jest.runAllTimersAsync();
      await expectation;
      // 15s + 0.5s backoff + 15s = 30.5s fits; the retry after that is
      // projected at 46.5s > 35s, so withRetry gives up after 2 attempts.
      expect(fn).toHaveBeenCalledTimes(2);
    });

    it('always runs the first attempt, even when the budget is already blown', async () => {
      const fn = jest.fn<(...args: any[]) => any>().mockRejectedValue(fresh429());
      const promise = withRetry(fn, { maxRetries: 3, baseDelayMs: 500, maxTotalMs: 1 });
      // The first attempt is never budget-gated; every projected retry
      // exceeds a 1ms budget, so exactly one attempt runs.
      const expectation = expect(promise).rejects.toThrow('HTTP 429');
      await jest.runAllTimersAsync();
      await expectation;
      expect(fn).toHaveBeenCalledTimes(1);
    });

    it('rethrows the same error object (same type, note appended to message only)', async () => {
      const err = fresh429();
      const fn = jest.fn<(...args: any[]) => any>().mockRejectedValue(err);
      const promise = withRetry(fn, { maxRetries: 2, baseDelayMs: 1000, maxTotalMs: 1 });
      const expectation = expect(promise).rejects.toBe(err);
      await jest.runAllTimersAsync();
      await expectation;
      expect(fn).toHaveBeenCalledTimes(1);
      expect(err).toBeInstanceOf(HttpConnectionError);
      expect(err.message).toContain('HTTP 429');
      expect(err.message).toContain('retry budget exhausted');
    });

    it('does not annotate or cut retries when maxTotalMs is unset (legacy behavior)', async () => {
      const fn = slowTimeoutFn();
      const promise = withRetry(fn, { maxRetries: 2, baseDelayMs: 500, jitter: false });
      const expectation = expect(promise).rejects.toThrow('Connection timeout');
      await jest.runAllTimersAsync();
      await expectation;
      expect(fn).toHaveBeenCalledTimes(3);
      try {
        await promise;
      } catch (error) {
        expect((error as Error).message).not.toContain('retry budget exhausted');
      }
    });

    it('a budget with room for a retry does not cut a successful retry short', async () => {
      const fn = jest.fn<(...args: any[]) => any>()
        .mockRejectedValueOnce(fresh429())
        .mockResolvedValue('recovered');
      const promise = withRetry(fn, {
        maxRetries: 3,
        baseDelayMs: 500,
        jitter: false,
        maxTotalMs: 35000,
      });
      await jest.runAllTimersAsync();
      await expect(promise).resolves.toBe('recovered');
      expect(fn).toHaveBeenCalledTimes(2);
    });

    it('leaves fast-failing retry loops untouched when they fit the budget', async () => {
      // Instant failures (no attempt duration): even a tight-ish budget
      // allows all retries because elapsed stays near zero.
      const fn = jest.fn<(...args: any[]) => any>().mockRejectedValue(fresh429());
      const promise = withRetry(fn, {
        maxRetries: 2,
        baseDelayMs: 100,
        jitter: false,
        maxTotalMs: 35000,
      });
      const expectation = expect(promise).rejects.toThrow('HTTP 429');
      await jest.runAllTimersAsync();
      await expectation;
      expect(fn).toHaveBeenCalledTimes(3);
      try {
        await promise;
      } catch (error) {
        expect((error as Error).message).not.toContain('retry budget exhausted');
      }
    });
  });

  describe('isRetryableError', () => {
    it('identifies typed 429 errors as retryable', () => {
      expect(isRetryableError(new HttpConnectionError('HTTP 429: Too Many Requests', 429))).toBe(true);
    });

    it('identifies typed 5xx errors as retryable', () => {
      expect(isRetryableError(new HttpConnectionError('HTTP 500: Internal Server Error', 500))).toBe(true);
      expect(isRetryableError(new HttpConnectionError('HTTP 503: Service Unavailable', 503))).toBe(true);
      expect(isRetryableError(new HttpConnectionError('HTTP 502: Bad Gateway', 502))).toBe(true);
    });

    it('identifies typed network errors (no status) as retryable', () => {
      expect(isRetryableError(new HttpConnectionError('fetch failed'))).toBe(true);
    });

    it('identifies plain network errors from fetch as retryable', () => {
      expect(isRetryableError(new Error('fetch failed'))).toBe(true);
      expect(isRetryableError(new Error('Network error'))).toBe(true);
      expect(isRetryableError(new Error('Connection timeout'))).toBe(true);
      expect(isRetryableError(new Error('The operation was aborted due to timeout'))).toBe(true);
      expect(isRetryableError(new Error('ECONNRESET'))).toBe(true);
      expect(isRetryableError(new Error('ETIMEDOUT'))).toBe(true);
    });

    it('checks the cause code for wrapped socket errors', () => {
      const wrapped = Object.assign(new Error('fetch failed'), { cause: { code: 'ECONNRESET' } });
      expect(isRetryableError(wrapped)).toBe(true);
    });

    it('rejects typed 4xx errors (except 429) as not retryable', () => {
      expect(isRetryableError(new HttpConnectionError('HTTP 400: Bad Request', 400))).toBe(false);
      expect(isRetryableError(new HttpConnectionError('HTTP 401: Unauthorized', 401))).toBe(false);
      expect(isRetryableError(new HttpConnectionError('HTTP 403: Forbidden', 403))).toBe(false);
      expect(isRetryableError(new HttpConnectionError('HTTP 404: Not Found', 404))).toBe(false);
      expect(isRetryableError(new HttpConnectionError('HTTP 418', 418))).toBe(false);
    });

    it('does not classify digits inside plain error messages', () => {
      expect(isRetryableError(new Error('HTTP 418 id 5123'))).toBe(false);
      expect(isRetryableError(new Error('HTTP 500 happened at 14:50:30'))).toBe(false);
      expect(isRetryableError(new Error('Status: 429'))).toBe(false);
      expect(isRetryableError(new Error('record 4000 not found'))).toBe(false);
    });

    it('returns false for non-Error objects', () => {
      expect(isRetryableError('string error')).toBe(false);
      expect(isRetryableError(null)).toBe(false);
      expect(isRetryableError(undefined)).toBe(false);
      expect(isRetryableError(123)).toBe(false);
      expect(isRetryableError({ message: 'HTTP 429' })).toBe(false);
    });
  });
});
