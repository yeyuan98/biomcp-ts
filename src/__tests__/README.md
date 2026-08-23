# Tests

## Infrastructure

- **Runner:** Jest with `ts-jest/presets/default-esm`
- **Environment:** `node`
- **ESM:** Enabled (`useESM: true`, `.ts` treated as ESM)
- **Module resolution:** `moduleNameMapper` rewrites `.js` imports to `.ts` for source
- **Diagnostics:** Disabled (`diagnostics: false`)
- **Coverage:** Collects from `src/**/*.ts`, excludes `.d.ts` and `index.ts`

## Running Tests

```bash
npm test                # Unit tests only (fast, mocked, parallel)
npm run test:integration # Integration tests (real APIs, serial, ~60s)
npm run test:all         # All tests combined
npm run test:coverage    # Unit tests with coverage
```

## Directory Structure

```
src/__tests__/
  helpers/
    mcp-harness.ts       # In-process MCP client harness (InMemoryTransport)
    assertions.ts        # Type-guard validators (expectGeneSearchResult, ...)
    retry.ts             # retryOnRateLimit for integration tests
  connections/
    fetch-utils.test.ts
    graphql.test.ts
    manager.test.ts
    proxy.test.ts
    rate-limiter.test.ts
    registry.test.ts
    rest.test.ts
    retry.test.ts
  entities/
    article.test.ts
    citation.test.ts
    citation/
      cache.test.ts
    cross-entity.test.ts
    dedup.test.ts
    disease.test.ts
    drug.test.ts
    gene.test.ts
    id-resolution.test.ts
    patent.test.ts
    pdb.test.ts
    pubmed-transform.test.ts
    trial.test.ts
    variant.test.ts
  integration/
    tools/               # 9 files — real API calls via the MCP harness
      gene-tools.test.ts
      drug-tools.test.ts
      variant-tools.test.ts
      disease-tools.test.ts
      article-tools.test.ts
      trial-tools.test.ts
      utility-tools.test.ts
      pdb-tools.test.ts
      patent-tools.test.ts
  server/
    errors.test.ts
    tool-registration.test.ts   # Tool registration counts (mocked, unit)
    tool-utils.test.ts          # applyLimit, sliceArraysRecursive
    validation.test.ts
    version.test.ts
  transform/
    gene.test.ts
    pdb.test.ts
```

## Test Counts

- **Unit:** 29 suites / 629 tests (`npm test`)
- **Integration:** 9 files / 97 tests (`npm run test:integration`), 5 keyed skips: 4 patent OPS/ODP tests (gated on `EPO_OPS_CONSUMER_KEY`/`EPO_OPS_CONSUMER_SECRET` and `USPTO_API_KEY` describes) + 1 OncoKB annotation test (`it.skip`, requires `ONCOKB_TOKEN`)

## Testing Approach

### Unit Tests (`npm test`)

All unit tests use mocked `global.fetch` to avoid real network calls.

- **Connections:** URL construction, auth headers, rate limiting, retry logic, content-type handling, proxy dispatcher self-initialization
- **Entities:** API endpoint correctness, query parameter construction, field mapping transforms, citation orchestration, deduplication, ID resolution
- **Server:** Error classification, Zod validation schemas, input formatting, tool registration counts
- **Transform:** Pure transform functions with known inputs/outputs

**Fake-timers convention (patent.test.ts):** token-bucket rate limiters and throttle backoffs sleep on module timers, so patent tests install fake timers per describe via `installFakeTimers()` and await results with `advanceUntilSettled(promise)`, which steps `jest.advanceTimersByTimeAsync(250)` until the promise settles. Each install starts the clock later than the last (`REAL_TIME_AT_LOAD + n × 1h`) because limiters only refill when the clock moves forward and singleton clients construct theirs at import. New patent tests must use both helpers.

### Integration Tests (`npm run test:integration`)

Integration tests use `InMemoryTransport` from the MCP SDK to connect a real `Client` to a real `McpServer` in-process. All tool handlers execute against live biomedical APIs.

**Harness:** `helpers/mcp-harness.ts` creates a connected client+server pair. Server connects first (required by the MCP protocol handshake), then client. Cleanup calls `connectionManager.closeAll()` to reset the singleton between suites.

**Test strategy:**
- **Structural validation:** Each result is validated for correct shape (type guards in `assertions.ts`)
- **Stable identity assertions:** Immutable identifiers are checked (Entrez IDs, gene symbols, NCT IDs, MONDO IDs)
- **No volatile assertions:** Counts, scores, and rankings are never asserted (data sources change)
- **Error tolerance:** Transient API failures are retried via `retryOnRateLimit` (3 attempts, 3s apart — retries 429/rate-limit errors, transient network errors like `fetch failed`/ECONNRESET/ETIMEDOUT, and result arrays containing transient `_error` rows) or caught, and tests gracefully skip

**Keyed skips:** OPS/ODP patent describes and the OncoKB variant test (above). Everything else runs keyless against live APIs.

**CI strategy:** Integration tests should run as a separate workflow (nightly or on-demand), not as PR gate.
