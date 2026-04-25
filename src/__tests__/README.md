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
  fixtures/
    ground-truth/         # Cached ground truth for stable identity assertions
  connections/
    fetch-utils.test.ts
    graphql.test.ts
    grpc.test.ts
    manager.test.ts
    rate-limiter.test.ts
    registry.test.ts
    rest.test.ts
  entities/
    article.test.ts
    cross-entity.test.ts
    disease.test.ts
    drug.test.ts
    gene.test.ts
    trial.test.ts
    variant.test.ts
  integration/
    tool-registration.test.ts   # Unit: verifies tool registration counts
    tools/
      gene-tools.test.ts        # Integration: real gene API calls
      drug-tools.test.ts        # Integration: real drug API calls
      variant-tools.test.ts     # Integration: real variant API calls
      disease-tools.test.ts     # Integration: real disease API calls
      article-tools.test.ts     # Integration: real article API calls
      trial-tools.test.ts       # Integration: real trial API calls
      utility-tools.test.ts     # Integration: discover + batch_get
  server/
    errors.test.ts
    validation.test.ts
  transform/
    gene.test.ts
```

## Test Counts by Module

| Module | File | Tests |
|---|---|---|
| connections | fetch-utils.test.ts | 3 |
| connections | graphql.test.ts | 2 |
| connections | grpc.test.ts | 2 |
| connections | manager.test.ts | 2 |
| connections | rate-limiter.test.ts | 9 |
| connections | registry.test.ts | 7 |
| connections | rest.test.ts | 16 |
| entities | article.test.ts | 15 |
| entities | cross-entity.test.ts | 5 |
| entities | disease.test.ts | 4 |
| entities | drug.test.ts | 4 |
| entities | gene.test.ts | 4 |
| entities | trial.test.ts | 4 |
| entities | variant.test.ts | 4 |
| integration | tool-registration.test.ts | 10 |
| integration | gene-tools.test.ts | 13 |
| integration | drug-tools.test.ts | 7 |
| integration | variant-tools.test.ts | 7 |
| integration | disease-tools.test.ts | 7 |
| integration | article-tools.test.ts | 5 |
| integration | trial-tools.test.ts | 6 |
| integration | utility-tools.test.ts | 5 |
| server | errors.test.ts | 19 |
| server | validation.test.ts | 28 |
| transform | gene.test.ts | 4 |
| **Total** | | **195** |

## Testing Approach

### Unit Tests (131 tests, `npm test`)

All unit tests use mocked `global.fetch` to avoid real network calls.

- **Connections:** Test URL construction, auth headers, rate limiting, content-type handling
- **Entities:** Test API endpoint correctness, query parameter construction, field mapping transforms
- **Server:** Test error classification, Zod validation schemas, input formatting
- **Transform:** Test pure transform functions with known inputs/outputs
- **Tool registration:** Verify `register*Tools` calls and tool name uniqueness

### Integration Tests (64 tests, `npm run test:integration`)

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
