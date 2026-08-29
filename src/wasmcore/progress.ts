// Generic worker→host progress convention for wasmcore-based workers.
//
// A worker posts id-less messages (routed by WorkerHost to onNotification,
// exactly like other worker-initiated notifications):
//   { type: 'progress', runId, value, message? }
// `runId` is an opaque correlation token chosen by the engine and echoed by
// the worker; `value` is a monotonic progress measurement (e.g. bytes read);
// `message` is a short human-readable status line.

/** Discriminant of the worker progress message convention. */
export const PROGRESS_MSG_TYPE = 'progress';

/** Floor for throttled emission: at most one progress message per 5 s. */
export const PROGRESS_MIN_INTERVAL_MS = 5_000;

export interface WorkerProgressMessage {
  type: typeof PROGRESS_MSG_TYPE;
  runId: string | number;
  value: number;
  message?: string;
}

export interface ProgressThrottle {
  /**
   * Emits via `emit` only when at least `minIntervalMs` (floored at
   * PROGRESS_MIN_INTERVAL_MS) has passed since the last emission; the very
   * first call always emits.
   */
  maybeEmit(now: number, emit: () => void): void;
}

export function createProgressThrottle(minIntervalMs: number): ProgressThrottle {
  const interval = Math.max(minIntervalMs, PROGRESS_MIN_INTERVAL_MS);
  let lastEmitMs = Number.NEGATIVE_INFINITY;
  return {
    maybeEmit(now: number, emit: () => void): void {
      if (now - lastEmitMs < interval) return;
      lastEmitMs = now;
      emit();
    },
  };
}
