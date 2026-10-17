import { jest } from '@jest/globals';
import { fetchWithTimeout, withTimeout, DEFAULT_PROVIDER_TIMEOUT_MS } from '../../connections/fetch-utils.js';

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
          signal!.addEventListener('abort', () => reject(new Error('abort')), { once: true });
        });
        return 'late';
      },
      10,
    );
    await jest.advanceTimersByTimeAsync(20);
    const result = await promise;
    expect(result.error).toBeDefined();
    expect(result.error).toContain('timed out');
    expect(result.data).toBeUndefined();
  });

  it('passes AbortSignal to the function and detects abort', async () => {
    let receivedSignal: AbortSignal | null | undefined = null;
    const promise = fetchWithTimeout(
      async (signal) => {
        receivedSignal = signal;
        expect(signal).toBeInstanceOf(AbortSignal);
        expect(signal!.aborted).toBe(false);
        await new Promise<void>((resolve, reject) => {
          signal!.addEventListener('abort', () => reject(new Error('abort')), { once: true });
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

  // #107 phase 2: the deadline must settle the call even when fn IGNORES the
  // signal (legacy section fetchers, retry loops that only check between
  // attempts) — the old implementation awaited fn(...) directly and hung
  // forever in that case.
  it('settles at the deadline even when fn ignores the signal and never resolves', async () => {
    const promise = fetchWithTimeout(
      () => new Promise<string>(() => {}),
      10,
    );
    await jest.advanceTimersByTimeAsync(20);
    const result = await promise;
    expect(result.error).toContain('timed out after 10ms');
    expect(result.data).toBeUndefined();
  });
});

describe('withTimeout', () => {
  beforeEach(() => {
    jest.useFakeTimers();
  });

  afterEach(() => {
    jest.useRealTimers();
  });

  describe("onTimeout: 'null'", () => {
    it('resolves with the value when the promise settles first', async () => {
      const result = await withTimeout(Promise.resolve('success'), 100, { onTimeout: 'null' });
      expect(result).toBe('success');
    });

    it('resolves null when the promise exceeds the timeout', async () => {
      const p = withTimeout(
        new Promise<string>(resolve => setTimeout(() => resolve('late'), 200)),
        50,
        { onTimeout: 'null' }
      );
      await jest.advanceTimersByTimeAsync(50);
      await expect(p).resolves.toBeNull();
    });

    it('resolves null when the promise never settles', async () => {
      const p = withTimeout(new Promise<string>(() => {}), 50, { onTimeout: 'null' });
      await jest.advanceTimersByTimeAsync(50);
      await expect(p).resolves.toBeNull();
    });

    it('propagates a rejection that happens before the timeout', async () => {
      await expect(
        withTimeout(Promise.reject(new Error('test error')), 100, { onTimeout: 'null' })
      ).rejects.toThrow('test error');
    });
  });

  describe("onTimeout: 'throw'", () => {
    it('resolves with the value when the promise settles first', async () => {
      const result = await withTimeout(Promise.resolve('success'), 100, { onTimeout: 'throw', label: 'PubMed search' });
      expect(result).toBe('success');
    });

    it('rejects with the label message when the promise hangs', async () => {
      const p = withTimeout(new Promise<string>(() => {}), 20000, { onTimeout: 'throw', label: 'PubMed search' });
      const expectation = expect(p).rejects.toThrow('PubMed search timed out after 20000ms');
      await jest.advanceTimersByTimeAsync(20000);
      await expectation;
    });

    it('uses a default label when none is provided', async () => {
      const p = withTimeout(new Promise<string>(() => {}), 10, { onTimeout: 'throw' });
      const expectation = expect(p).rejects.toThrow('Operation timed out after 10ms');
      await jest.advanceTimersByTimeAsync(10);
      await expectation;
    });

    it('propagates a rejection that happens before the timeout', async () => {
      await expect(
        withTimeout(Promise.reject(new Error('quick error')), 100, { onTimeout: 'throw', label: 'X' })
      ).rejects.toThrow('quick error');
    });
  });

  describe('signal-bearing fn form (#107 phase 2: the loser stops consuming)', () => {
    it('aborts the work signal when the deadline wins the race', async () => {
      const sawAbort = jest.fn();
      const p = withTimeout(
        (signal: AbortSignal) =>
          new Promise<string>((_resolve, reject) => {
            signal.addEventListener('abort', () => {
              sawAbort();
              reject(new Error('work aborted late'));
            }, { once: true });
          }),
        50,
        { onTimeout: 'throw', label: 'Federated leg' },
      );
      const expectation = expect(p).rejects.toThrow('Federated leg timed out after 50ms');
      await jest.advanceTimersByTimeAsync(50);
      await expectation;
      // The losing fetch was told to stop instead of running to its own
      // connection-level timeout while holding its concurrency slot.
      expect(sawAbort).toHaveBeenCalledTimes(1);
      expect(jest.getTimerCount()).toBe(0);
    });

    it('forwards an external abort to the work signal (without settling the race)', async () => {
      const external = new AbortController();
      const sawAbort = jest.fn();
      const p = withTimeout(
        (signal: AbortSignal) =>
          new Promise<string>((_resolve, reject) => {
            signal.addEventListener('abort', () => {
              sawAbort();
              reject(new Error('work aborted'));
            }, { once: true });
          }),
        5000,
        { onTimeout: 'throw', label: 'X', signal: external.signal },
      );
      const expectation = expect(p).rejects.toThrow('work aborted');
      external.abort();
      await expectation;
      expect(sawAbort).toHaveBeenCalledTimes(1);
      expect(jest.getTimerCount()).toBe(0);
    });

    it('fn form resolves normally when work beats the deadline', async () => {
      const result = await withTimeout(async () => 'fast', 100, { onTimeout: 'null' });
      expect(result).toBe('fast');
    });
  });

  it('clears the timer once settled (no leaked timers)', async () => {
    await withTimeout(Promise.resolve('fast'), 100, { onTimeout: 'null' });
    expect(jest.getTimerCount()).toBe(0);

    const p = withTimeout(new Promise<string>(() => {}), 10, { onTimeout: 'throw', label: 'X' });
    const expectation = expect(p).rejects.toThrow('timed out');
    await jest.advanceTimersByTimeAsync(10);
    await expectation;
    expect(jest.getTimerCount()).toBe(0);
  });

  // Intentional drift guard: pins the documented default timeout; not a
  // behavioral test.
  it('DEFAULT_PROVIDER_TIMEOUT_MS is 10 seconds', () => {
    expect(DEFAULT_PROVIDER_TIMEOUT_MS).toBe(10000);
  });
});
