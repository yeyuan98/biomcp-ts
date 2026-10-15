import { beforeEach, afterEach } from '@jest/globals';

/**
 * Save/restore lifecycle for hand-rolled `global.fetch` mocks.
 *
 * Replaces the per-describe boilerplate:
 *
 * ```ts
 * let originalFetch: typeof global.fetch;
 * beforeEach(() => { originalFetch = global.fetch; — plus clearAllMocks/closeAll });
 * afterEach(() => { global.fetch = originalFetch; });
 * ```
 *
 * with a single `mockGlobalFetch();` at the top of the describe. Call it
 * inside a `describe` body (it registers `beforeEach`/`afterEach` hooks for
 * that scope); individual tests still assign
 * `global.fetch = jest.fn<(...args: any[]) => any>()…` themselves. Keep any
 * additional `beforeEach`/`afterEach` logic (mock clears, connection resets,
 * env save/restore) in the suite's own hooks — they run after the save and
 * before the restore, exactly like the inline boilerplate did.
 */
export function mockGlobalFetch(): void {
  let originalFetch: typeof global.fetch;
  beforeEach(() => {
    originalFetch = global.fetch;
  });
  afterEach(() => {
    global.fetch = originalFetch;
  });
}
