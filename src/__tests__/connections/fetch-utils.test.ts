import { jest } from '@jest/globals';
import { fetchWithTimeout } from '../../connections/fetch-utils.js';

describe('fetchWithTimeout', () => {
  beforeEach(() => {
    jest.useFakeTimers();
  });

  afterEach(() => {
    jest.useRealTimers();
  });

  it('resolves before timeout', async () => {
    const result = await fetchWithTimeout(
      async (_signal) => 'hello',
      5000,
    );
    expect(result).toEqual({ data: 'hello' });
  });

  it('rejects on timeout with abort message', async () => {
    const promise = fetchWithTimeout(
      async (signal) => {
        await new Promise<void>((resolve, reject) => {
          signal.addEventListener('abort', () => reject(new Error('abort')), { once: true });
        });
        return 'late';
      },
      10,
    );
    await jest.advanceTimersByTimeAsync(20);
    const result = await promise;
    expect(result.error).toBeDefined();
    expect(result.error).toContain('Timeout');
    expect(result.data).toBeUndefined();
  });

  it('passes AbortSignal to the function and detects abort', async () => {
    let receivedSignal: AbortSignal | null = null;
    const promise = fetchWithTimeout(
      async (signal) => {
        receivedSignal = signal;
        expect(signal).toBeInstanceOf(AbortSignal);
        expect(signal.aborted).toBe(false);
        await new Promise<void>((resolve, reject) => {
          signal.addEventListener('abort', () => reject(new Error('abort')), { once: true });
        });
        return 'data';
      },
      10,
    );
    await jest.advanceTimersByTimeAsync(20);
    const result = await promise;
    expect(receivedSignal).not.toBeNull();
    expect(result.error).toBeDefined();
  });
});
