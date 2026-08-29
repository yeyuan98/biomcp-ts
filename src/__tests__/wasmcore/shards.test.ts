import { describe, it, expect } from '@jest/globals';
import { runShards, ShardBatchError, type ShardContext } from '../../wasmcore/shards.js';

function deferred<T>(): { promise: Promise<T>; resolve: (v: T) => void; reject: (e: unknown) => void } {
  let resolve!: (v: T) => void;
  let reject!: (e: unknown) => void;
  const promise = new Promise<T>((res, rej) => {
    resolve = res;
    reject = rej;
  });
  return { promise, resolve, reject };
}

/** Deterministic clock: starts at 0; the test advances it past the 5 s floor. */
function fakeClock(): { now: () => number; advance: (ms: number) => void } {
  let t = 0;
  return { now: () => t, advance: (ms) => (t += ms) };
}

describe('wasmcore runShards', () => {
  it('runs every shard with the concurrency bound and preserves result order', async () => {
    let inFlight = 0;
    let maxInFlight = 0;
    const results = await runShards(
      [1, 2, 3, 4, 5, 6],
      async (shard) => {
        inFlight += 1;
        maxInFlight = Math.max(maxInFlight, inFlight);
        await new Promise((resolve) => setTimeout(resolve, 5));
        inFlight -= 1;
        return shard * 10;
      },
      { concurrency: 2 },
    );
    expect(results).toEqual([10, 20, 30, 40, 50, 60]);
    expect(maxInFlight).toBe(2);
  });

  it('clamps concurrency below 1 to a serial worker', async () => {
    let inFlight = 0;
    let maxInFlight = 0;
    const results = await runShards(
      [1, 2, 3],
      async (shard) => {
        inFlight += 1;
        maxInFlight = Math.max(maxInFlight, inFlight);
        await new Promise((resolve) => setTimeout(resolve, 5));
        inFlight -= 1;
        return shard;
      },
      { concurrency: 0 },
    );
    expect(results).toEqual([1, 2, 3]);
    expect(maxInFlight).toBe(1);
  });

  it('reports monotonic aggregate progress and a final flush (settled finals + live latests)', async () => {
    const clock = fakeClock();
    const seen: number[] = [];
    const gate = deferred<void>();
    let firstCtx: ShardContext | null = null;
    const batch = runShards(
      ['a', 'b'],
      (shard, index, ctx) => {
        if (index === 0) {
          firstCtx = ctx;
          return gate.promise.then(() => 'a-done');
        }
        void shard;
        return Promise.resolve('b-done');
      },
      {
        concurrency: 2,
        now: clock.now,
        onProgress: (v) => seen.push(v),
      },
    );
    await new Promise((resolve) => setTimeout(resolve, 5));
    // b (index 1) settles first (no reports → contributes 0) and the initial
    // aggregate (live a = 0) is emitted — the throttle always sends the first.
    firstCtx!.onShardProgress(30); // a live: 30 — same clock tick: throttled
    clock.advance(6_000);
    firstCtx!.onShardProgress(70); // a live: 70 — interval passed: emitted
    gate.resolve();
    await expect(batch).resolves.toEqual(['a-done', 'b-done']);
    // Final values: the settled a contributes its last report (70); the
    // settle emission is throttled and the final flush sends 70.
    expect(seen).toEqual([0, 70, 70]);
  });

  it('clamps a non-monotonic caller: the aggregate never decreases', async () => {
    const seen: number[] = [];
    await runShards(
      ['x'],
      (_shard, _index, ctx) => {
        ctx.onShardProgress(100);
        ctx.onShardProgress(5); // bogus regression
        return Promise.resolve('ok');
      },
      { concurrency: 1, onProgress: (v) => seen.push(v) },
    );
    for (let i = 1; i < seen.length; i += 1) expect(seen[i]!).toBeGreaterThanOrEqual(seen[i - 1]!);
    expect(seen[seen.length - 1]).toBe(100);
  });

  it('ignores onShardProgress reported after the shard settled', async () => {
    const seen: number[] = [];
    let captured: ShardContext | null = null;
    await runShards(
      ['x'],
      (_shard, _index, ctx) => {
        captured = ctx;
        ctx.onShardProgress(11);
        return Promise.resolve('ok');
      },
      { concurrency: 1, onProgress: (v) => seen.push(v) },
    );
    expect(() => captured!.onShardProgress(99)).not.toThrow();
    expect(seen[seen.length - 1]).toBe(11);
  });

  it('fail-fast: the first error aborts pending shards and wraps in ShardBatchError', async () => {
    const started: number[] = [];
    const err = await runShards(
      [0, 1, 2, 3],
      async (shard) => {
        started.push(shard);
        if (shard === 0) throw new Error('boom');
        return shard;
      },
      { concurrency: 1 },
    ).catch((e: unknown) => e);
    expect(err).toBeInstanceOf(ShardBatchError);
    const batch = err as ShardBatchError;
    expect(batch.shardIndex).toBe(0);
    expect((batch.cause as Error).message).toBe('boom');
    expect(batch.message).toContain('shard 0');
    // Serial worker: shards after the failure never start.
    expect(started).toEqual([0]);
  });

  it('suppresses secondary errors after the batch abort: the first cause wins', async () => {
    const slowGate = deferred<void>();
    const settledOrder: string[] = [];
    const err = await runShards(
      ['fast-fail', 'slow'],
      (shard, _index, ctx) => {
        if (shard === 'fast-fail') {
          return Promise.reject(new Error('primary cause'));
        }
        return new Promise((_resolve, reject) => {
          const onAbort = () => {
            settledOrder.push('slow-aborted');
            reject(new Error('secondary cancellation'));
          };
          if (ctx.signal.aborted) onAbort();
          else ctx.signal.addEventListener('abort', onAbort, { once: true });
          slowGate.promise.then(() => {
            settledOrder.push('slow-gate');
            reject(new Error('secondary gate'));
          });
        });
      },
      { concurrency: 2 },
    ).catch((e: unknown) => e);
    expect(err).toBeInstanceOf(ShardBatchError);
    expect((err as ShardBatchError).cause).toMatchObject({ message: 'primary cause' });
    // The in-flight shard observed the abort and settled before rejection.
    expect(settledOrder).toContain('slow-aborted');
  });

  it('rejects only after in-flight shards settle (no dangling runners)', async () => {
    const finishSlow = deferred<void>();
    let slowSettled = false;
    const batch = runShards(
      [0, 1, 2],
      (shard) => {
        if (shard === 0) return Promise.reject(new Error('early'));
        if (shard === 1) {
          return new Promise<string>((resolve) => {
            void finishSlow.promise.then(() => {
              slowSettled = true;
              resolve('slow-done');
            });
          });
        }
        return Promise.reject(new Error('never started'));
      },
      { concurrency: 3 },
    ).catch((e: unknown) => e);
    await new Promise((resolve) => setTimeout(resolve, 10));
    const pending = batch.then((e) => {
      expect(slowSettled).toBe(true);
      return e;
    });
    finishSlow.resolve();
    const err = await pending;
    expect(err).toBeInstanceOf(ShardBatchError);
    expect((err as ShardBatchError).cause).toMatchObject({ message: 'early' });
  });

  it('isFatal rethrows the original error untouched', async () => {
    const fatal = new RangeError('fatal-class');
    const err = await runShards(
      ['a', 'b'],
      (shard) => (shard === 'a' ? Promise.reject(fatal) : Promise.resolve(shard)),
      { concurrency: 2, isFatal: (e) => e instanceof RangeError },
    ).catch((e: unknown) => e);
    expect(err).toBe(fatal);
  });

  it('external signal abort: queued shards never start; in-flight runners observe it', async () => {
    const controller = new AbortController();
    const started: string[] = [];
    const batch = runShards(
      ['first', 'second', 'third'],
      (shard, _index, ctx) => {
        started.push(shard);
        return new Promise((_resolve, reject) => {
          const onAbort = () => reject(new Error('runner cancelled'));
          if (ctx.signal.aborted) onAbort();
          else ctx.signal.addEventListener('abort', onAbort, { once: true });
        });
      },
      { concurrency: 1, signal: controller.signal },
    ).catch((e: unknown) => e);
    await new Promise((resolve) => setTimeout(resolve, 5));
    controller.abort();
    const err = await batch;
    expect(started).toEqual(['first']);
    expect(err).toBeInstanceOf(ShardBatchError);
    expect((err as ShardBatchError).cause).toMatchObject({ message: 'runner cancelled' });
  });

  it('external signal abort with a signal-ignoring runner rejects with the signal reason', async () => {
    const controller = new AbortController();
    const reason = new Error('client cancelled');
    const started: string[] = [];
    const batch = runShards(
      ['first', 'second'],
      (shard) => {
        started.push(shard);
        // This runner ignores ctx.signal and completes anyway.
        return new Promise<string>((resolve) => setTimeout(() => resolve(shard), 15));
      },
      { concurrency: 1, signal: controller.signal },
    ).catch((e: unknown) => e);
    setTimeout(() => controller.abort(reason), 5);
    const err = await batch;
    expect(started).toEqual(['first']); // second was skipped by the abort
    expect(err).toBe(reason);
  });

  it('empty and single-shard degenerate cases', async () => {
    await expect(runShards([], async () => 'x', { concurrency: 4 })).resolves.toEqual([]);
    await expect(runShards(['solo'], async (s) => s, { concurrency: 4 })).resolves.toEqual(['solo']);
  });

  it('a synchronously-throwing runner is treated as a shard failure', async () => {
    const err = await runShards(
      ['a'],
      () => {
        throw new TypeError('sync throw');
      },
      { concurrency: 1 },
    ).catch((e: unknown) => e);
    expect(err).toBeInstanceOf(ShardBatchError);
    expect((err as ShardBatchError).cause).toBeInstanceOf(TypeError);
  });
});
