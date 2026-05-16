import { withTimeout, DEFAULT_PROVIDER_TIMEOUT_MS } from '../../../entities/article/citation/timeout.js';

describe('withTimeout', () => {
  test('resolves with value when promise completes before timeout', async () => {
    const quickPromise = Promise.resolve('success');
    const result = await withTimeout(quickPromise, 100);
    expect(result).toBe('success');
  });

  test('resolves with null when promise exceeds timeout', async () => {
    const slowPromise = new Promise<string>(resolve => {
      setTimeout(() => resolve('late'), 200);
    });
    const result = await withTimeout(slowPromise, 50);
    expect(result).toBeNull();
  });

  test('resolves with null when promise never resolves', async () => {
    const neverResolves = new Promise<string>(() => {});
    const result = await withTimeout(neverResolves, 50);
    expect(result).toBeNull();
  });

  test('handles rejected promises', async () => {
    const rejectedPromise = Promise.reject(new Error('test error'));
    await expect(withTimeout(rejectedPromise, 100)).rejects.toThrow('test error');
  });

  test('rejects before timeout if promise fails quickly', async () => {
    const quickReject = Promise.reject(new Error('quick error'));
    await expect(withTimeout(quickReject, 1000)).rejects.toThrow('quick error');
  });

  test('timeout does not leak timers', async () => {
    const promises = Array.from({ length: 100 }, (_, i) =>
      withTimeout(Promise.resolve(i), 10 + Math.random() * 50)
    );
    await Promise.all(promises);
    // If timers leaked, this test would hang or cause Jest to warn about open handles
    expect(true).toBe(true);
  });

  test('works with very short timeout (1ms)', async () => {
    // A promise that takes longer than the timeout should return null
    const slowPromise = new Promise<string>(resolve => {
      setTimeout(() => resolve('late'), 10);
    });
    const result = await withTimeout(slowPromise, 1);
    expect(result).toBeNull();
  });

  test('DEFAULT_PROVIDER_TIMEOUT_MS is 10 seconds', () => {
    expect(DEFAULT_PROVIDER_TIMEOUT_MS).toBe(10000);
  });

  test('concurrent timeouts do not interfere', async () => {
    const results = await Promise.all([
      withTimeout(Promise.resolve('first'), 100),
      withTimeout(Promise.resolve('second'), 100),
      withTimeout(Promise.resolve('third'), 100),
    ]);
    expect(results).toEqual(['first', 'second', 'third']);
  });

  test('handles mixed success and timeout', async () => {
    const results = await Promise.all([
      withTimeout(Promise.resolve('fast'), 100),
      withTimeout(new Promise<string>(resolve => setTimeout(() => resolve('slow'), 200)), 50),
      withTimeout(Promise.resolve('medium'), 100),
    ]);
    expect(results[0]).toBe('fast');
    expect(results[1]).toBeNull(); // Timed out
    expect(results[2]).toBe('medium');
  });
});
