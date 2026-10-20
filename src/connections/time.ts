/**
 * Clock seam for in-process duration math.
 *
 * RULE: every DURATION / BUDGET / TTL / elapsed comparison computed and
 * consumed within one process uses the monotonic clock
 * (`monotonicNowMs()`), never `Date.now()`. Wall-clock (`Date.now()`) is
 * ONLY for absolute, persisted, or user-visible timestamps (filenames,
 * trace epochs, FS mtimes, HTTP `Retry-After` date parsing, uptime shown
 * to humans).
 *
 * Why: on WSL2 the guest clock repeatedly jumps by minutes (NTP resync
 * after host sleep/wake — kernel logs "Time jumped backwards"). Against a
 * wall-clock deadline those jumps corrupt elapsed state both ways: a
 * forward jump expires fresh caches and falsely exhausts retry budgets; a
 * backward jump makes `expiresAt` comparisons stale-forever (the entry
 * never expires). `performance.now()` is monotonic (never moves backward)
 * and advances on its own, so such comparisons are immune.
 *
 * Trade-off: monotonic time excludes suspend time, so TTLs stretch across
 * host suspend. Acceptable here — this repo's caches/budgets are
 * short-lived (seconds to minutes) in-process state, and a stretched TTL
 * degrades gently compared to the corruption above.
 */

/** Monotonic milliseconds for DURATION/BUDGET/TTL math — see module docs. */
export function monotonicNowMs(): number {
  return performance.now();
}
