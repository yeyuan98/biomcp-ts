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
    assertions.ts        # Structural validators for each entity type
  connections/
    fetch-utils.test.ts
    graphql.test.ts
    grpc.test.ts
    manager.test.ts
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
    tools/
      gene-tools.test.ts        # Integration: real gene API calls
      drug-tools.test.ts        # Integration: real drug API calls
      variant-tools.test.ts     # Integration: real variant API calls
      disease-tools.test.ts     # Integration: real disease API calls
      article-tools.test.ts     # Integration: real article API calls
      trial-tools.test.ts       # Integration: real trial API calls
      utility-tools.test.ts     # Integration: discover + batch_get
      pdb-tools.test.ts         # Integration: real PDB API calls
      patent-tools.test.ts      # Integration: patent search + get (keyed cases auto-skip)
  server/
    errors.test.ts
    tool-registration.test.ts   # Verifies tool registration counts (mocked, unit)
    tool-utils.test.ts       # Shared tool utility functions (applyLimit, sliceArraysRecursive)
    validation.test.ts
  transform/
    gene.test.ts
    pdb.test.ts
```

## Test Counts by Module

| Module | File | Tests |
|---|---|---|
| connections | fetch-utils.test.ts | 13 |
| connections | graphql.test.ts | 12 |
| connections | grpc.test.ts | 2 |
| connections | manager.test.ts | 2 |
| connections | rate-limiter.test.ts | 7 |
| connections | registry.test.ts | 7 |
| connections | rest.test.ts | 25 |
| connections | retry.test.ts | 20 |
| entities | article.test.ts | 63 |
| entities | citation.test.ts | 35 |
| entities | citation/cache.test.ts | 17 |
| entities | cross-entity.test.ts | 35 |
| entities | dedup.test.ts | 13 |
| entities | disease.test.ts | 4 |
| entities | drug.test.ts | 18 |
| entities | gene.test.ts | 44 |
| entities | id-resolution.test.ts | 22 |
| entities | patent.test.ts | 32 |
| entities | pdb.test.ts | 31 |
| entities | pubmed-transform.test.ts | 27 |
| entities | trial.test.ts | 13 |
| entities | variant.test.ts | 34 |
| integration | gene-tools.test.ts | 14 |
| integration | drug-tools.test.ts | 8 |
| integration | variant-tools.test.ts | 8 |
| integration | disease-tools.test.ts | 8 |
| integration | article-tools.test.ts | 9 |
| integration | trial-tools.test.ts | 6 |
| integration | utility-tools.test.ts | 5 |
| integration | pdb-tools.test.ts | 25 |
| integration | patent-tools.test.ts | 10 |
| server | errors.test.ts | 19 |
| server | tool-registration.test.ts | 11 |
| server | tool-utils.test.ts | 16 |
| server | validation.test.ts | 35 |
| transform | gene.test.ts | 4 |
| transform | pdb.test.ts | 3 |
| **Total (unit)** | | **597** (+93 integration) |

## Testing Approach

### Unit Tests (597 tests, `npm test`)

All unit tests use mocked `global.fetch` to avoid real network calls.

- **Connections:** Test URL construction, auth headers, rate limiting, retry logic, content-type handling
- **Entities:** Test API endpoint correctness, query parameter construction, field mapping transforms, citation orchestration, deduplication, ID resolution
- **Server:** Test error classification, Zod validation schemas, input formatting
- **Transform:** Test pure transform functions with known inputs/outputs
- **Tool registration:** Verify `register*Tools` calls and tool name uniqueness

### Integration Tests (100+ tests, `npm run test:integration`)

Integration tests use `InMemoryTransport` from the MCP SDK to connect a real `Client` to a real `McpServer` in-process. All tool handlers execute against live biomedical APIs.

**Harness:** `src/__tests__/helpers/mcp-harness.ts` creates a connected client+server pair. Server connects first (required by the MCP protocol handshake), then client. Cleanup calls `connectionManager.closeAll()` to reset the singleton between suites.

**Test strategy:**
- **Structural validation:** Each result is validated for correct shape (type guards in `assertions.ts`)
- **Stable identity assertions:** Immutable identifiers are checked (Entrez IDs, gene symbols, NCT IDs, MONDO IDs)
- **No volatile assertions:** Counts, scores, and rankings are never asserted (data sources change)
- **Error tolerance:** Transient API failures are caught and tests gracefully skip

**Tools requiring env vars** (skipped unless present):
- `variant_oncokb`: requires `ONCOKB_TOKEN`
- `gene_diseases` (DisGeNET path): requires `DISGENET_API_KEY`
- `variant_get` + `alphagenome_scores`: requires `ALPHAGENOME_API_KEY`

**CI strategy:** Integration tests should run as a separate workflow (nightly or on-demand), not as PR gate.
