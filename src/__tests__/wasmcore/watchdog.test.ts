import { describe, it, expect, jest } from '@jest/globals';
import { runWithWatchdog, type WatchdogOptions } from '../../wasmcore/watchdog.js';

const CANCEL_MESSAGE = 'job exceeded the time limit and was cancelled';

function makeOpts(over: Partial<WatchdogOptions> = {}): WatchdogOptions & { cancel: jest.Mock; discard: jest.Mock } {
  const cancel = jest.fn();
  const discard = jest.fn();
  return {
    timeoutMs: 10_000,
    watchdogMs: 60_000,
    cancel,
    discard,
    isCancelError: (err) => String(err).includes('cancel-signature'),
    cancelMessage: CANCEL_MESSAGE,
    discardError: new Error('runtime discarded'),
    ...over,
  };
}

describe('runWithWatchdog', () => {
  it('returns the job result without cancelling when it settles in time', async () => {
    const opts = makeOpts();
    await expect(runWithWatchdog(async () => 'done', opts)).resolves.toBe('done');
    expect(opts.cancel).not.toHaveBeenCalled();
    expect(opts.discard).not.toHaveBeenCalled();
  });

  it('rethrows non-cancel job errors untouched', async () => {
    const opts = makeOpts();
    const boom = new Error('ordinary failure');
    await expect(runWithWatchdog(async () => { throw boom; }, opts)).rejects.toBe(boom);
    expect(opts.cancel).not.toHaveBeenCalled();
  });

  it('fires cancel at the timeout and maps a cancel-signature rejection to cancelMessage', async () => {
    const opts = makeOpts({ timeoutMs: 20 });
    const p = runWithWatchdog(
      () => new Promise<string>((_resolve, reject) => {
        setTimeout(() => reject(new Error('a cancel-signature interrupt occurred')), 60);
      }),
      opts
    );
    await expect(p).rejects.toThrow(CANCEL_MESSAGE);
    expect(opts.cancel).toHaveBeenCalledTimes(1);
    expect(opts.discard).not.toHaveBeenCalled();
  });

  it('maps any rejection after the timeout to cancelMessage, even without the signature', async () => {
    const opts = makeOpts({ timeoutMs: 20 });
    const p = runWithWatchdog(
      () => new Promise<string>((_resolve, reject) => {
        setTimeout(() => reject(new Error('weird internal state')), 60);
      }),
      opts
    );
    await expect(p).rejects.toThrow(CANCEL_MESSAGE);
  });

  it('maps a cancel-signature rejection even when the timer never fired', async () => {
    const opts = makeOpts({ timeoutMs: 10_000 });
    await expect(
      runWithWatchdog(async () => { throw new Error('pre-existing cancel-signature error'); }, opts)
    ).rejects.toThrow(CANCEL_MESSAGE);
    expect(opts.cancel).not.toHaveBeenCalled();
  });

  it('swallows a throwing cancel hook and still maps the rejection', async () => {
    const opts = makeOpts({ timeoutMs: 20, cancel: jest.fn(() => { throw new Error('cancel failed'); }) });
    const p = runWithWatchdog(
      () => new Promise<string>((_resolve, reject) => {
        setTimeout(() => reject(new Error('late failure')), 60);
      }),
      opts
    );
    await expect(p).rejects.toThrow(CANCEL_MESSAGE);
  });

  it('discards the runtime and rejects with discardError when the job never settles', async () => {
    const opts = makeOpts({ timeoutMs: 20, watchdogMs: 40 });
    const never = runWithWatchdog(() => new Promise<string>(() => undefined), opts);
    await expect(never).rejects.toThrow('runtime discarded');
    expect(opts.cancel).toHaveBeenCalledTimes(1);
    expect(opts.discard).toHaveBeenCalledTimes(1);
  });

  it('does not discard when the job rejects with the cancel signature before the watchdog fires', async () => {
    const opts = makeOpts({ timeoutMs: 20, watchdogMs: 40 });
    const p = runWithWatchdog(
      () => new Promise<string>((_resolve, reject) => {
        setTimeout(() => reject(new Error('cancel-signature')), 25);
      }),
      opts
    );
    await expect(p).rejects.toThrow(CANCEL_MESSAGE);
    await new Promise((r) => setTimeout(r, 80));
    expect(opts.discard).not.toHaveBeenCalled();
  });

  it('disarms the watchdog after a successful run', async () => {
    const opts = makeOpts({ timeoutMs: 20, watchdogMs: 40 });
    await expect(runWithWatchdog(async () => 'ok', opts)).resolves.toBe('ok');
    await new Promise((r) => setTimeout(r, 80));
    expect(opts.cancel).not.toHaveBeenCalled();
    expect(opts.discard).not.toHaveBeenCalled();
  });
});
