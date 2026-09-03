import { describe, it, expect, jest } from '@jest/globals';
import {
  createProgressThrottle,
  PROGRESS_MIN_INTERVAL_MS,
  PROGRESS_MSG_TYPE,
  type WorkerProgressMessage,
} from '../../wasmcore/progress.js';
import { runWithWatchdog, type WatchdogOptions } from '../../wasmcore/watchdog.js';

describe('createProgressThrottle', () => {
  it('emits the very first call immediately, regardless of the clock', () => {
    const throttle = createProgressThrottle(PROGRESS_MIN_INTERVAL_MS);
    const emit = jest.fn();
    throttle.maybeEmit(0, emit);
    expect(emit).toHaveBeenCalledTimes(1);
  });

  it('floors the interval at PROGRESS_MIN_INTERVAL_MS and suppresses anything closer', () => {
    const throttle = createProgressThrottle(0); // floored to PROGRESS_MIN_INTERVAL_MS internally
    const emit = jest.fn();
    throttle.maybeEmit(1_000, emit); // first → emits
    throttle.maybeEmit(1_500, emit); // +0.5 s → suppressed
    throttle.maybeEmit(5_999, emit); // +4.999 s → suppressed
    expect(emit).toHaveBeenCalledTimes(1);
    throttle.maybeEmit(1_000 + PROGRESS_MIN_INTERVAL_MS, emit); // exactly the floor → emits
    expect(emit).toHaveBeenCalledTimes(2);
  });

  it('respects a custom interval above the floor', () => {
    const throttle = createProgressThrottle(PROGRESS_MIN_INTERVAL_MS * 2);
    const emit = jest.fn();
    throttle.maybeEmit(0, emit); // first → emits
    throttle.maybeEmit(PROGRESS_MIN_INTERVAL_MS, emit); // at the floor but below the custom interval
    expect(emit).toHaveBeenCalledTimes(1);
    throttle.maybeEmit(PROGRESS_MIN_INTERVAL_MS * 2, emit);
    expect(emit).toHaveBeenCalledTimes(2);
  });

  // Intentional drift guard: pins the wire discriminant contract between the
  // worker and host; not a behavioral test.
  it('worker progress convention carries the documented discriminant', () => {
    const msg: WorkerProgressMessage = { type: PROGRESS_MSG_TYPE, runId: 3, value: 128, message: '1s, 0.1 MB read' };
    expect(msg.type).toBe('progress');
    expect(msg.runId).toBe(3);
    expect(msg.value).toBe(128);
  });
});

// ---------------------------------------------------------------------------
// Watchdog interplay with the wasmcore progress convention: activity()
// re-arms the inactivity deadline, maxRunMs is an absolute ceiling, and
// activity after settlement is a guarded no-op.
// ---------------------------------------------------------------------------

const CANCEL_MESSAGE = 'job exceeded the time limit and was cancelled';

function makeOpts(over: Partial<WatchdogOptions> = {}): WatchdogOptions & { cancel: jest.Mock; discard: jest.Mock } {
  const cancel = jest.fn();
  const discard = jest.fn();
  return {
    timeoutMs: 10_000,
    watchdogMs: 60_000,
    cancel,
    discard,
    isCancelError: () => false,
    cancelMessage: CANCEL_MESSAGE,
    discardError: new Error('runtime discarded'),
    ...over,
  };
}

describe('runWithWatchdog activity + ceiling (progress-driven deadlines)', () => {
  it('activity() re-arms the deadline so a chatty job outlives timeoutMs', async () => {
    const opts = makeOpts({ timeoutMs: 50, watchdogMs: 40 });
    const result = await runWithWatchdog(async (handle) => {
      // 8 × 20 ms = 160 ms of wall time; without activity the 50 ms deadline fires.
      for (let i = 0; i < 8; i++) {
        await new Promise((r) => setTimeout(r, 20));
        handle.activity();
      }
      return 'slow-but-alive';
    }, opts);
    expect(result).toBe('slow-but-alive');
    expect(opts.cancel).not.toHaveBeenCalled();
    expect(opts.discard).not.toHaveBeenCalled();
  });

  it('maxRunMs is an absolute ceiling that activity() cannot extend', async () => {
    const opts = makeOpts({ timeoutMs: 50, watchdogMs: 20, maxRunMs: 140 });
    const started = Date.now();
    await expect(
      runWithWatchdog(
        (handle) =>
          new Promise<string>(() => {
            // Chatty but never settles; only the ceiling can stop it.
            const iv = setInterval(() => handle.activity(), 20);
            setTimeout(() => clearInterval(iv), 1_500); // hard stop for test hygiene
          }),
        opts,
      ),
    ).rejects.toThrow('runtime discarded');
    const elapsed = Date.now() - started;
    expect(opts.cancel).toHaveBeenCalledTimes(1);
    expect(opts.discard).toHaveBeenCalledTimes(1);
    expect(elapsed).toBeGreaterThanOrEqual(130); // well past the 50 ms deadline, at the 140 ms ceiling
    expect(elapsed).toBeLessThan(1_400);
  });

  it('activity() after the job settled is a no-op (no late timer re-arm)', async () => {
    const opts = makeOpts({ timeoutMs: 30, watchdogMs: 20 });
    let saved: { activity(): void } | null = null;
    await expect(
      runWithWatchdog(async (handle) => {
        saved = handle;
        return 'done';
      }, opts),
    ).resolves.toBe('done');
    expect(saved).not.toBeNull();
    saved!.activity();
    saved!.activity();
    await new Promise((r) => setTimeout(r, 80)); // > timeoutMs past settlement
    expect(opts.cancel).not.toHaveBeenCalled();
    expect(opts.discard).not.toHaveBeenCalled();
  });
});
