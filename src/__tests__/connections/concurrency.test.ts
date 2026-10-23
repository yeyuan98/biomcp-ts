import { jest } from '@jest/globals';
import { BoundedSemaphore, getSourceSemaphore } from '../../connections/concurrency.js';
import { RestConnection } from '../../connections/rest.js';
import { GraphQLConnection } from '../../connections/graphql.js';
import type { ConnectionOptions } from '../../connections/base.js';
import { mockGlobalFetch } from '../helpers/mock-fetch.js';

// NOTE: unlike rest.test.ts, this file does NOT jest.mock the rate limiter —
// under this ESM setup the factory mock is a silent no-op (verified: the real
// TokenBucketRateLimiter loads). Instead, each concurrent logical request
// below uses its OWN connection instance: instances share nothing except the
// per-source semaphore (getSourceSemaphore is keyed by sourceId), so the
// real per-instance limiter never spaces the calls apart and in-flight
// counts stay deterministic. That also pins the intended semantics: the
// concurrency cap is per-source, not per-object.

/** Manual promise so tests can hold fetches/semaphore slots open. */
function deferred<T = void>() {
  let resolve!: (value: T) => void;
  let reject!: (reason?: unknown) => void;
  const promise = new Promise<T>((res, rej) => {
    resolve = res;
    reject = rej;
  });
  return { promise, resolve, reject };
}

/** Drain the microtask queue (a setImmediate tick runs after all microtasks). */
const flushMicrotasks = (): Promise<void> => new Promise(resolve => setImmediate(resolve));

/** Microtask-only drain: unlike flushMicrotasks it never schedules a
 * setImmediate, so it is safe while jest fake timers have setImmediate
 * captured (frozen until the clock advances). */
async function drainMicrotasks(ticks = 100): Promise<void> {
  for (let i = 0; i < ticks; i++) await Promise.resolve();
}

const okResponse = () => ({ ok: true, json: () => Promise.resolve({ data: 'ok' }) });
const rateLimitedResponse = () => ({
  ok: false,
  status: 429,
  statusText: 'Too Many Requests',
  text: () => Promise.resolve(''),
});
const urlTag = (url: string): string => (url.endsWith('/a') ? 'a' : 'b');

describe('BoundedSemaphore', () => {
  it('runs only `limit` tasks concurrently and admits waiters in FIFO order', async () => {
    const semaphore = new BoundedSemaphore(3);
    const gates = Array.from({ length: 12 }, () => deferred<void>());
    const startOrder: number[] = [];
    const runs = gates.map((gate, i) =>
      semaphore.run(async () => {
        startOrder.push(i);
        await gate.promise;
      })
    );

    await flushMicrotasks();
    expect(startOrder).toEqual([0, 1, 2]); // 12 launched, only 3 in flight

    gates[0].resolve();
    await flushMicrotasks();
    expect(startOrder).toEqual([0, 1, 2, 3]); // first-queued waiter admitted next

    gates.slice(1).forEach(gate => gate.resolve());
    await Promise.all(runs);
    expect(startOrder).toEqual(Array.from({ length: 12 }, (_, i) => i));
  });

  it('serializes runs at limit 1', async () => {
    const semaphore = new BoundedSemaphore(1);
    let inFlight = 0;
    let maxInFlight = 0;

    const runs = Array.from({ length: 4 }, () =>
      semaphore.run(async () => {
        inFlight++;
        maxInFlight = Math.max(maxInFlight, inFlight);
        await flushMicrotasks();
        inFlight--;
      })
    );
    await Promise.all(runs);

    expect(maxInFlight).toBe(1);
  });

  it('propagates errors and releases the slot afterwards', async () => {
    const semaphore = new BoundedSemaphore(1);
    const boom = new Error('boom');

    await expect(semaphore.run(async () => { throw boom; })).rejects.toBe(boom);

    let ranAfterFailure = false;
    await semaphore.run(async () => {
      ranAfterFailure = true;
    });
    expect(ranAfterFailure).toBe(true);
  });

  it('rejects invalid limits', () => {
    expect(() => new BoundedSemaphore(0)).toThrow();
    expect(() => new BoundedSemaphore(-1)).toThrow();
    expect(() => new BoundedSemaphore(1.5)).toThrow();
  });

  it('getSourceSemaphore shares one instance per sourceId', () => {
    expect(getSourceSemaphore('sem_identity_src', 2)).toBe(getSourceSemaphore('sem_identity_src', 5));
    expect(getSourceSemaphore('sem_identity_src', 2)).not.toBe(getSourceSemaphore('sem_identity_other_src', 2));
  });
});

describe('registry concurrency plumbing (connections layer, #107)', () => {
  mockGlobalFetch();

  const restOptions = (sourceId: string, overrides: Partial<ConnectionOptions> = {}): ConnectionOptions => ({
    sourceId,
    baseUrl: 'https://example.org/api',
    protocol: 'rest',
    rateLimit: { intervalMs: 1 },
    ...overrides,
  });

  const graphqlOptions = (sourceId: string, overrides: Partial<ConnectionOptions> = {}): ConnectionOptions =>
    restOptions(sourceId, { protocol: 'graphql', ...overrides });

  it('serializes concurrent requests for a concurrency:1 source (across connection instances)', async () => {
    const firstFetch = deferred<void>();
    let fetchCalls = 0;
    global.fetch = jest.fn<(...args: any[]) => any>().mockImplementation(async () => {
      fetchCalls++;
      if (fetchCalls === 1) await firstFetch.promise;
      return okResponse();
    }) as any;

    const first = new RestConnection(restOptions('sem_serial_rest', { concurrency: 1 })).request('/a');
    const second = new RestConnection(restOptions('sem_serial_rest', { concurrency: 1 })).request('/b');
    await flushMicrotasks();
    expect(fetchCalls).toBe(1); // second request waits behind the first

    firstFetch.resolve();
    await flushMicrotasks();
    expect(fetchCalls).toBe(2); // slot released, waiter admitted

    await Promise.all([first, second]);
    expect(fetchCalls).toBe(2);
  });

  it('does not limit concurrency when the registry leaves it unset', async () => {
    const firstFetch = deferred<void>();
    let fetchCalls = 0;
    global.fetch = jest.fn<(...args: any[]) => any>().mockImplementation(async () => {
      fetchCalls++;
      if (fetchCalls === 1) await firstFetch.promise;
      return okResponse();
    }) as any;

    const first = new RestConnection(restOptions('sem_unset_rest')).request('/a');
    const second = new RestConnection(restOptions('sem_unset_rest')).request('/b');
    await flushMicrotasks();
    expect(fetchCalls).toBe(2); // both in flight immediately

    firstFetch.resolve();
    await Promise.all([first, second]);
  });

  it('acquires the semaphore per attempt: a retried request re-queues behind its rival', async () => {
    // Flake-tail conversion (#187 rule 2; two dated hits: 2026-10-19,
    // 2026-10-20). The original raced /a's REAL ~1ms retry-backoff
    // setTimeout (baseDelayMs 1, jitter on) against a setImmediate
    // flushMicrotasks to get /b dispatched first — scheduler jitter on a
    // loaded box could flip the order. Fake timers (the repo convention,
    // patent.test.ts) freeze that backoff until /b provably HOLDS the slot
    // (a deferred-held fetch), then fire it and pin that /a's retry
    // re-queues instead of fetching. Fake timers are per-test and restored
    // in finally: sibling tests rely on the real setImmediate inside
    // flushMicrotasks. The per-instance TokenBucketRateLimiter starts full
    // (see the NOTE at the top of this file) and intervalMs is 1, so the
    // single clock advance below also covers its refill — no other
    // clock-refill dependence.
    jest.useFakeTimers();
    try {
      const fetched: string[] = [];
      const bFetch = deferred<void>();
      global.fetch = jest.fn<(...args: any[]) => any>().mockImplementation(async (url: string) => {
        fetched.push(url);
        // First attempt of /a gets a retryable 429; /b parks on the
        // deferred so it visibly OWNS the semaphore slot; all else succeeds.
        if (url.endsWith('/a') && fetched.filter(u => u.endsWith('/a')).length === 1) {
          return rateLimitedResponse();
        }
        if (url.endsWith('/b')) {
          await bFetch.promise;
        }
        return okResponse();
      }) as any;

      const first = new RestConnection(restOptions('sem_retry_rerelease', {
        concurrency: 1,
        retry: { attempts: 2, backoffMs: 1 },
      })).request('/a');

      // Microtasks only — the clock has NOT moved: /a's attempt 1 fetched,
      // got the 429, released the slot, and its backoff setTimeout is
      // pending but frozen.
      await drainMicrotasks();
      expect(fetched.map(urlTag)).toEqual(['a']);

      // /b starts while the backoff is still frozen and takes the free slot.
      const second = new RestConnection(restOptions('sem_retry_rerelease', {
        concurrency: 1,
        retry: { attempts: 2, backoffMs: 1 },
      })).request('/b');
      await drainMicrotasks();
      expect(fetched.map(urlTag)).toEqual(['a', 'b']); // /b holds the slot

      // Fire /a's backoff (>= 1ms + 15% jitter, and >= the 1ms limiter
      // interval). /a's retry comes back for the slot, finds /b in it, and
      // re-queues at the back of the FIFO — it must NOT fetch yet. This is
      // the strengthened pin: actual waiter re-entry, not just dispatch
      // order (a slot held across withRetry would show the same ['a','b']
      // here, but only per-attempt acquisition lets /b in at all).
      await jest.advanceTimersByTimeAsync(2);
      await drainMicrotasks();
      expect(fetched.map(urlTag)).toEqual(['a', 'b']);

      // /b completes and releases the slot; only then does /a's retry run.
      bFetch.resolve();
      await Promise.all([first, second]);

      // Per-attempt acquisition: /b's fetch interleaves BETWEEN /a's attempts
      // (order a, b, a). If the slot were held across the whole withRetry
      // call, the order would be a, a, b.
      expect(fetched.map(urlTag)).toEqual(['a', 'b', 'a']);
    } finally {
      jest.useRealTimers();
    }
  });

  it('passes registry retryBudgetMs into the retry loop (gives up once the budget is blown)', async () => {
    let fetchCalls = 0;
    global.fetch = jest.fn<(...args: any[]) => any>().mockImplementation(async () => {
      fetchCalls++;
      return rateLimitedResponse();
    }) as any;

    const conn = new RestConnection(restOptions('sem_budget_rest', {
      retry: { attempts: 3, backoffMs: 100 },
      // Backoff alone (100ms) exceeds the 50ms budget → no retry ever starts.
      retryBudgetMs: 50,
    }));

    await expect(conn.request('/a')).rejects.toThrow('retry budget exhausted');
    expect(fetchCalls).toBe(1); // attempts: 3 would mean 3 fetches without the budget
  });

  it('runs every retry attempt when no retryBudgetMs is configured (legacy behavior)', async () => {
    let fetchCalls = 0;
    global.fetch = jest.fn<(...args: any[]) => any>().mockImplementation(async () => {
      fetchCalls++;
      return rateLimitedResponse();
    }) as any;

    const conn = new RestConnection(restOptions('sem_budget_unset_rest', {
      retry: { attempts: 3, backoffMs: 10 },
    }));

    await expect(conn.request('/a')).rejects.toThrow('HTTP 429');
    expect(fetchCalls).toBe(3);
  });

  it('serializes GraphQL requests for a concurrency:1 source', async () => {
    const firstFetch = deferred<void>();
    let fetchCalls = 0;
    global.fetch = jest.fn<(...args: any[]) => any>().mockImplementation(async () => {
      fetchCalls++;
      if (fetchCalls === 1) await firstFetch.promise;
      return okResponse();
    }) as any;

    const first = new GraphQLConnection(graphqlOptions('sem_serial_graphql', { concurrency: 1 })).request('{ viewer { id } }');
    const second = new GraphQLConnection(graphqlOptions('sem_serial_graphql', { concurrency: 1 })).request('{ viewer { name } }');
    await flushMicrotasks();
    expect(fetchCalls).toBe(1);

    firstFetch.resolve();
    await flushMicrotasks();
    expect(fetchCalls).toBe(2);

    await Promise.all([first, second]);
  });

  it('passes registry retryBudgetMs into the GraphQL retry loop', async () => {
    let fetchCalls = 0;
    global.fetch = jest.fn<(...args: any[]) => any>().mockImplementation(async () => {
      fetchCalls++;
      return rateLimitedResponse();
    }) as any;

    const conn = new GraphQLConnection(graphqlOptions('sem_budget_graphql', {
      retry: { attempts: 3, backoffMs: 100 },
      retryBudgetMs: 50,
    }));

    await expect(conn.request('{ viewer { id } }')).rejects.toThrow('retry budget exhausted');
    expect(fetchCalls).toBe(1);
  });
});
