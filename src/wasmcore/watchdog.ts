export interface WatchdogOptions {
  timeoutMs: number;
  watchdogMs: number;
  cancel(): void;
  discard(): void | Promise<void>;
  isCancelError(err: unknown): boolean;
  cancelMessage: string;
  discardError: Error;
}

export async function runWithWatchdog<T>(job: () => Promise<T>, opts: WatchdogOptions): Promise<T> {
  let timedOut = false;
  let watchdogReject: ((err: Error) => void) | null = null;
  const watchdog = new Promise<never>((_, reject) => {
    watchdogReject = reject;
  });
  const timer = setTimeout(() => {
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
  }, opts.timeoutMs);
  try {
    return await Promise.race([job(), watchdog]);
  } catch (err) {
    if (err === opts.discardError) throw err;
    if (timedOut || opts.isCancelError(err)) {
      throw new Error(opts.cancelMessage);
    }
    throw err;
  } finally {
    clearTimeout(timer);
    watchdogReject = null;
  }
}
