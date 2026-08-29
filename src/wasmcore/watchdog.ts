export interface WatchdogHandle {
  /**
   * Reports activity (e.g. a worker progress message). Re-arms the
   * `timeoutMs` deadline, which then acts as an inactivity limit; the
   * optional `maxRunMs` absolute ceiling is never extended.
   */
  activity(): void;
}

export interface WatchdogOptions {
  timeoutMs: number;
  watchdogMs: number;
  cancel(): void;
  discard(): void | Promise<void>;
  isCancelError(err: unknown): boolean;
  cancelMessage: string;
  discardError: Error;
  /**
   * Optional absolute ceiling on total run time. When set, `timeoutMs`
   * becomes an inactivity deadline that `WatchdogHandle.activity()` resets;
   * without it the fixed-deadline semantics of previous versions apply.
   */
  maxRunMs?: number;
}

export async function runWithWatchdog<T>(job: (handle: WatchdogHandle) => Promise<T>, opts: WatchdogOptions): Promise<T> {
  let timedOut = false;
  let settled = false;
  let watchdogReject: ((err: Error) => void) | null = null;
  const watchdog = new Promise<never>((_, reject) => {
    watchdogReject = reject;
  });
  const fire = () => {
    if (timedOut) return;
    timedOut = true;
    try {
      opts.cancel();
    } catch {
      void 0;
    }
    setTimeout(() => {
      if (watchdogReject) {
        void opts.discard();
        watchdogReject(opts.discardError);
      }
    }, opts.watchdogMs);
  };
  let timer: NodeJS.Timeout | null = setTimeout(fire, opts.timeoutMs);
  let maxTimer: NodeJS.Timeout | null =
    opts.maxRunMs !== undefined ? setTimeout(fire, opts.maxRunMs) : null;
  const handle: WatchdogHandle = {
    activity(): void {
      if (settled || timedOut || timer === null) return;
      clearTimeout(timer);
      timer = setTimeout(fire, opts.timeoutMs);
    },
  };
  try {
    return await Promise.race([job(handle), watchdog]);
  } catch (err) {
    if (err === opts.discardError) throw err;
    if (timedOut || opts.isCancelError(err)) {
      throw new Error(opts.cancelMessage);
    }
    throw err;
  } finally {
    settled = true;
    if (timer) clearTimeout(timer);
    if (maxTimer) clearTimeout(maxTimer);
    watchdogReject = null;
  }
}
