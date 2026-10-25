/**
 * Deadline-slicing budget table for patent_get (issue #209).
 *
 * The pre-#209 code raced each chain step against a magic multiplier of a
 * base timeout (`×3`/`×2`) with a `Promise.race` that never aborted the
 * loser, while the inner request budgets beneath one step summed HIGHER
 * than the step race itself (PPUBS session 15s + search 30s + doc 30s
 * under a 24s step; Wayback probe 15s + playback 60s inside gpDetail's
 * 24s step — playback could never finish under its own step timer), and
 * worst-case chains exceeded the 120s tool budget. Abandoned steps also
 * kept holding the shared 1 req/s PPUBS token bucket, poisoning later
 * calls in-process.
 *
 * This table is the single source of truth for the layered model:
 *
 *   tool 120s = core slice 45s + sections slice 72s + 3s margin
 *
 * Each phase runs under a slice deadline; each chain source under a
 * per-source failover step budget; each network request under an inner
 * budget from its source's `inner` map. Inner budgets are also wired into
 * the call sites that consume them (PPUBS client, OPS client, Wayback
 * defaults, the `google_patents` registry `timeoutMs` mirrors
 * `steps.google_patents.inner.live`), so the arithmetic invariants below
 * describe the budgets that actually run.
 *
 * Invariants (asserted in `src/__tests__/entities/patent.test.ts`, pure
 * arithmetic — no timers):
 *   (i) every step budget ≥ the sum of that source's inner budgets;
 *   (ii) core slice + sections slice + margin ≤ tool deadline;
 *   (iii) every inner budget > 0 and ≤ its step budget.
 *
 * Inner-budget rationale (latencies measured live 2026-10-24 against
 * PPUBS: session ~3s, guid search ~1s, document ~13s):
 *   - google_patents: live page 20s (block pages return fast; only a
 *     hang deserves the full budget) + Wayback probe 6s + playback 18s
 *     = 44s under a 45s step.
 *   - ppubs: session 8s (warm-cold handshake) + guid search 10s + document
 *     22s (13s measured → ~1.7× headroom for big claims payloads) = 40s
 *     under a 45s step — the 5s slack absorbs the shared 1 req/s token
 *     bucket queueing concurrent section chains.
 *     (patent_search keeps its own legacy 30s search-side budget — its 60s
 *     tool budget and the seminal phase's adaptive deadline govern there;
 *     only the patent_get detail chain consumes the table values.)
 *   - ops: OAuth token 8s + one REST get 15s = 23s. Multi-request steps
 *     (e.g. citations = biblio + `ct=` forward search) are NOT covered by
 *     this arithmetic alone — the step signal caps the whole sequence at
 *     the 25s step budget.
 *   - uspto_odp: up to 3 sequential search POSTs (15s each, mirroring
 *     the `uspto_odp` registry `handling.timeoutMs`), the whole sequence
 *     capped at the 20s step budget via signal composition.
 */
export const PATENT_GET_BUDGETS_MS = {
  /** Tool-level deadline (GET_TIMEOUT_MS in src/server/tools/patent.ts). */
  tool: 120_000,
  /** Core phase slice: one identity record must land inside 45s. */
  coreSlice: 45_000,
  /** Sections phase slice: all requested section chains share 72s. */
  sectionsSlice: 72_000,
  /**
   * Margin for result assembly (warnings merge, limit application) and
   * JSON serialization after the sections slice, so the slices can never
   * overrun the tool deadline.
   */
  serializationMargin: 3_000,
  steps: {
    google_patents: {
      step: 45_000,
      inner: { live: 20_000, waybackProbe: 6_000, waybackPlayback: 18_000 },
    },
    ppubs: {
      step: 45_000,
      inner: { session: 8_000, search: 10_000, document: 22_000 },
    },
    ops: {
      step: 25_000,
      inner: { token: 8_000, request: 15_000 },
    },
    uspto_odp: {
      step: 20_000,
      inner: { search: 15_000 },
    },
  },
} as const;

export type PatentGetBudgetTable = typeof PATENT_GET_BUDGETS_MS;
export type PatentGetStepBudgets = PatentGetBudgetTable['steps'];
