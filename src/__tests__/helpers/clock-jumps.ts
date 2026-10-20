import { jest } from '@jest/globals';

/**
 * Deterministic WSL2 guest-clock-jump simulation (#166).
 *
 * Models the real failure mode: the WALL clock (Date.now) jumps by ±minutes
 * (NTP resync after host sleep/wake — kernel logs "Time jumped backwards")
 * while the MONOTONIC clock (performance.now) keeps ticking smoothly. The
 * spy is therefore installed on `Date.now`, NOT on `performance.now`:
 * code converted to `monotonicNowMs()` (src/connections/time.ts) is
 * provably unaffected by these jumps, while any regression back to
 * `Date.now()` duration math sees the jumps and fails the test — the
 * mutation-sanity property that pins this harness design (a jump injected
 * into performance.now would corrupt the converted code too, and reverted
 * code would pass trivially).
 *
 * REAL timers only — never combine with jest fake timers. Deterministic:
 * every wall-clock read returns `wallStart + baseDrift + reads + offset`
 * where `reads` advances 1 ms per call and `offset` applies the next
 * cumulative jump from `jumps` every second read (each jump holds for two
 * reads so a start/expiry pair can observe the jumped clock). After the
 * list is exhausted, the final cumulative offset holds. Tests pace the
 * sequence deterministically by probing `Date.now()` directly — the spy
 * counts those probes like any other read.
 */

/** Default mix: ±(60 s..180 s) jumps; net cumulative +150 s when exhausted. */
export const DEFAULT_CLOCK_JUMPS_MS: readonly number[] = [
  120_000, -90_000, 150_000, -60_000, 180_000, -150_000,
];

/**
 * Run `fn` while the wall clock (Date.now) jumps through `jumps` around a
 * slowly-increasing base. The monotonic clock (performance.now) is left
 * real. Restores Date.now in `finally`.
 */
export async function withClockJumps<T>(
  fn: () => Promise<T>,
  jumps: number[] = [...DEFAULT_CLOCK_JUMPS_MS],
): Promise<T> {
  const realPerfStart = performance.now();
  const wallStart = Date.now(); // captured before the spy installs
  let reads = 0;
  const spy = jest.spyOn(Date, 'now').mockImplementation(() => {
    reads += 1;
    const applied = Math.min(Math.floor((reads - 1) / 2), Math.max(jumps.length - 1, 0));
    const offset = jumps.slice(0, applied + 1).reduce((a, b) => a + b, 0);
    // Slowly-increasing base: real monotonic drift + 1 deterministic ms/read.
    return wallStart + reads + offset + (performance.now() - realPerfStart);
  });
  try {
    return await fn();
  } finally {
    spy.mockRestore();
  }
}
