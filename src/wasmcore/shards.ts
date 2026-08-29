// Generic bounded-concurrency shard scheduler for file-based compute.
//
// wasmcore consumers split a job into independent shards — regions, contigs,
// files — and dispatch them across a fixed set of executors (e.g. biowasm
// worker slots). This module owns the three cross-cutting concerns every such
// fan-out needs:
//
//   - bounded concurrency over an ordered shard list (results keep order;
//     ordering the shards for load balance is the caller's pre-sort)
//   - monotonic aggregate progress: settled shards contribute their last
//     reported value, live shards their latest; the aggregate never moves
//     backwards and is clamped against non-monotonic callers
//   - a fail-fast error taxonomy: the FIRST shard error aborts pending and
//     in-flight shards through one internal AbortController, the batch
//     rejects only after in-flight settlement, post-abort secondary errors
//     are suppressed (first cause wins), and `isFatal` selects
//     rethrow-original vs wrap-in-ShardBatchError

import { createProgressThrottle, PROGRESS_MIN_INTERVAL_MS } from './progress.js';

export interface RunShardsOptions {
  /** Max simultaneously in-flight shards (executor count); values < 1 clamp to 1. */
  concurrency: number;
  /**
   * Client cancellation, forwarded into the batch's internal AbortController:
   * queued shards never start; in-flight runners observe the abort through
   * ShardContext.signal.
   */
  signal?: AbortSignal;
  /**
   * Monotonic aggregate progress (settled finals + live latests), throttled
   * to the wasmcore floor, with one final flush at completion.
   */
  onProgress?: (value: number) => void;
  /**
   * Wrap-vs-rethrow taxonomy. BOTH branches abort pending + in-flight shards
   * and await in-flight settlement before rejecting. fatal(err) => reject
   * with the ORIGINAL error untouched; otherwise the error is wrapped in
   * ShardBatchError. Defaults to wrap-always.
   */
  isFatal?: (err: unknown) => boolean;
  /** Clock seam (default Date.now) so throttle behavior is unit-testable. */
  now?: () => number;
}

export interface ShardContext {
  /** Live progress reporter for THIS shard; ignored after the shard settles. */
  onShardProgress: (value: number) => void;
  /** The batch's internal controller signal (options.signal is forwarded into it). */
  signal: AbortSignal;
}

/** A non-fatal shard failure: the batch aborted and wrapped the first cause. */
export class ShardBatchError extends Error {
  readonly shardIndex: number;
  readonly cause: unknown;

  constructor(shardIndex: number, cause: unknown) {
    super(`shard ${shardIndex} failed: ${cause instanceof Error ? cause.message : String(cause)}`);
    this.name = 'ShardBatchError';
    this.shardIndex = shardIndex;
    this.cause = cause;
  }
}

interface ProgressState {
  settledTotal: number;
  readonly live: Map<number, number>;
  lastSent: number;
}

export async function runShards<T, R>(
  shards: readonly T[],
  run: (shard: T, index: number, ctx: ShardContext) => Promise<R>,
  opts: RunShardsOptions,
): Promise<R[]> {
  const concurrency = Math.max(1, Math.floor(opts.concurrency) || 1);
  const controller = new AbortController();
  const forwardAbort = () => controller.abort(opts.signal?.reason);
  if (opts.signal?.aborted) forwardAbort();
  else opts.signal?.addEventListener('abort', forwardAbort, { once: true });

  const progress: ProgressState | null = opts.onProgress
    ? { settledTotal: 0, live: new Map(), lastSent: Number.NEGATIVE_INFINITY }
    : null;
  const now = opts.now ?? Date.now;
  const throttle = createProgressThrottle(PROGRESS_MIN_INTERVAL_MS);

  const emitAggregate = (force = false): void => {
    if (!progress || !opts.onProgress) return;
    let aggregate = progress.settledTotal;
    for (const value of progress.live.values()) aggregate += value;
    const value = Math.max(progress.lastSent, aggregate);
    progress.lastSent = value;
    const send = () => opts.onProgress!(value);
    if (force) {
      send();
      return;
    }
    throttle.maybeEmit(now(), send);
  };

  const results = new Array<R>(shards.length);
  const settled = new Set<number>();
  let nextIndex = 0;
  let firstError: { index: number; err: unknown } | null = null;
  // Reader function: control-flow analysis cannot see the workers' writes and
  // would otherwise narrow the closure-mutated variable to `never`.
  const failureOf = (): { index: number; err: unknown } | null => firstError;

  const worker = async (): Promise<void> => {
    for (;;) {
      if (firstError || controller.signal.aborted) return;
      const index = nextIndex;
      nextIndex += 1;
      if (index >= shards.length) return;
      progress?.live.set(index, 0);
      const ctx: ShardContext = {
        signal: controller.signal,
        onShardProgress: (value) => {
          if (settled.has(index)) return;
          progress?.live.set(index, value);
          emitAggregate();
        },
      };
      try {
        const result = await run(shards[index]!, index, ctx);
        if (!firstError) results[index] = result;
      } catch (err) {
        if (!firstError) {
          firstError = { index, err };
          controller.abort();
        }
        // Secondary errors observed after the batch abort are consequences,
        // not causes — suppressed; the first cause wins.
      } finally {
        settled.add(index);
        const last = progress?.live.get(index) ?? 0;
        progress?.live.delete(index);
        if (progress) progress.settledTotal += last;
        emitAggregate();
      }
    }
  };

  const workerCount = Math.min(concurrency, shards.length);
  const workers: Array<Promise<void>> = [];
  for (let w = 0; w < workerCount; w += 1) workers.push(worker());
  await Promise.all(workers);

  // Annotated read via the reader (see failureOf).
  const failure = failureOf();
  if (failure) {
    if (opts.isFatal?.(failure.err)) throw failure.err;
    throw new ShardBatchError(failure.index, failure.err);
  }
  if (controller.signal.aborted) {
    // External abort without a surfaced runner error: shards were skipped.
    const reason = opts.signal?.reason;
    throw reason instanceof Error ? reason : new Error('shard batch aborted');
  }
  emitAggregate(true);
  return results;
}
