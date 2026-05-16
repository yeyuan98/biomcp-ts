import { jest } from '@jest/globals';
import { withRetry, isRetryableError } from '../../connections/retry.js';

jest.useFakeTimers();

// Create error objects at module level to avoid issues with fake timers
const error429 = new Error('HTTP 429 Too Many Requests');
const error429Short = new Error('HTTP 429');
const error400 = new Error('HTTP 400 Bad Request');
const error401 = new Error('HTTP 401 Unauthorized');
const error403 = new Error('HTTP 403 Forbidden');
const error404 = new Error('HTTP 404 Not Found');
const error500 = new Error('HTTP 500 Internal Server Error');
const error503 = new Error('HTTP 503 Service Unavailable');
const error502 = new Error('HTTP 502 Bad Gateway');
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
      const fn = jest.fn().mockResolvedValue('success');
      const result = await withRetry(fn);
      expect(result).toBe('success');
      expect(fn).toHaveBeenCalledTimes(1);
    });

    it('retries on 429 error and succeeds', async () => {
      const fn = jest.fn()
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

      const fn = jest.fn()
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
      const fn = jest.fn()
        .mockRejectedValueOnce(error429Short)
        .mockRejectedValueOnce(error429Short)
        .mockResolvedValue('success');

      const delays: number[] = [];
      const originalSetTimeout = global.setTimeout;
      global.setTimeout = jest.fn().mockImplementation((callback, delay) => {
        delays.push(delay as number);
        return originalSetTimeout(callback, 0);
      });

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
      const fn = jest.fn()
        .mockRejectedValueOnce(error429Short)
        .mockResolvedValue('success');

      const delays: number[] = [];
      const originalSetTimeout = global.setTimeout;
      global.setTimeout = jest.fn().mockImplementation((callback, delay) => {
        delays.push(delay as number);
        return originalSetTimeout(callback, 0);
      });

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
      const fn = jest.fn()
        .mockRejectedValueOnce(error429Short)
        .mockRejectedValueOnce(error429Short)
        .mockRejectedValueOnce(error429Short)
        .mockRejectedValueOnce(error429Short)
        .mockResolvedValue('success');

      const delays: number[] = [];
      const originalSetTimeout = global.setTimeout;
      global.setTimeout = jest.fn().mockImplementation((callback, delay) => {
        delays.push(delay as number);
        return originalSetTimeout(callback, 0);
      });

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
      const fn = jest.fn().mockRejectedValue(error400);

      await expect(withRetry(fn)).rejects.toThrow('HTTP 400 Bad Request');
      expect(fn).toHaveBeenCalledTimes(1); // No retries
    });

    it('handles non-Error thrown values', async () => {
      const fn = jest.fn().mockRejectedValue('string error');

      await expect(withRetry(fn)).rejects.toBe('string error');
      expect(fn).toHaveBeenCalledTimes(1); // Not retryable (not an Error)
    });

    it('works with zero retries', async () => {
      const fn = jest.fn().mockRejectedValue(error429Short);

      await expect(withRetry(fn, { maxRetries: 0 })).rejects.toThrow('HTTP 429');
      expect(fn).toHaveBeenCalledTimes(1); // Only initial attempt
    });

    it('uses custom isRetryable function', async () => {
      const customError = new Error('Custom transient error');
      const fn = jest.fn()
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
      const fn = jest.fn()
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

  describe('isRetryableError', () => {
    it('identifies 429 errors as retryable', () => {
      expect(isRetryableError(new Error('HTTP 429 Too Many Requests'))).toBe(true);
      expect(isRetryableError(new Error('Status: 429'))).toBe(true);
    });

    it('identifies rate limit errors as retryable', () => {
      expect(isRetryableError(new Error('Too many requests'))).toBe(true);
      expect(isRetryableError(new Error('Rate limit exceeded'))).toBe(true);
    });

    it('identifies 5xx HTTP errors as retryable', () => {
      expect(isRetryableError(new Error('HTTP 500 Internal Server Error'))).toBe(true);
      expect(isRetryableError(new Error('HTTP 503 Service Unavailable'))).toBe(true);
      expect(isRetryableError(new Error('HTTP 502 Bad Gateway'))).toBe(true);
    });

    it('identifies network errors as retryable', () => {
      expect(isRetryableError(new Error('Network error'))).toBe(true);
      expect(isRetryableError(new Error('Connection timeout'))).toBe(true);
      expect(isRetryableError(new Error('ECONNRESET'))).toBe(true);
      expect(isRetryableError(new Error('ETIMEDOUT'))).toBe(true);
    });

    it('rejects 400 errors as not retryable', () => {
      expect(isRetryableError(new Error('HTTP 400 Bad Request'))).toBe(false);
      expect(isRetryableError(new Error('Status 400'))).toBe(false);
    });

    it('rejects 401 errors as not retryable', () => {
      expect(isRetryableError(new Error('HTTP 401 Unauthorized'))).toBe(false);
      expect(isRetryableError(new Error('Authentication failed'))).toBe(false);
    });

    it('rejects 403 errors as not retryable', () => {
      expect(isRetryableError(new Error('HTTP 403 Forbidden'))).toBe(false);
    });

    it('rejects 404 errors as not retryable', () => {
      expect(isRetryableError(new Error('HTTP 404 Not Found'))).toBe(false);
      expect(isRetryableError(new Error('Resource not found'))).toBe(false);
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
