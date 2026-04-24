# Tests

## Infrastructure

- **Runner:** Jest with `ts-jest/presets/default-esm`
- **Environment:** `node`
- **ESM:** Enabled (`useESM: true`, `.ts` treated as ESM)
- **Module resolution:** `moduleNameMapper` rewrites `.js` imports to `.ts` for source
- **Diagnostics:** Disabled (`diagnostics: false`)
- **Coverage:** Collects from `src/**/*.ts`, excludes `.d.ts` and `index.ts`
- **Pattern:** `src/__tests__/**/*.test.ts`

## Running Tests

```bash
npx jest
```

## Directory Structure

```
src/__tests__/
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
    tool-registration.test.ts
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
| server | errors.test.ts | 19 |
| server | validation.test.ts | 28 |
| transform | gene.test.ts | 4 |
| **Total** | | **142** |

## Testing Approach

### Connections (unit tests with mocks)

- **`global.fetch` is mocked** to avoid real network calls; `rest.test.ts`, `graphql.test.ts`, and `grpc.test.ts` swap `global.fetch` in `beforeEach`/`afterEach`
- **Rate limiter is mocked** (`rate-limiter.js`) in connection tests to isolate connection logic from throttling
- **`rate-limiter.test.ts`** uses `jest.useFakeTimers()` to test token bucket behavior (acquire blocking, refill timing, rate updates)
- **`fetch-utils.test.ts`** uses `jest.useFakeTimers()` + `AbortSignal` to test timeout behavior
- **`registry.test.ts`** tests pure data lookups against the source registry (no mocks)
- **`manager.test.ts`** mocks all connection constructors and the registry to test protocol-based dispatch

### Entities (unit tests with fetch mocks)

- All entity test files mock `global.fetch` and verify correct API endpoints are called (URL construction, query parameters)
- Each file tests both the search function (endpoint + URL params) and the get function (endpoint + ID in URL)
- Transform functions (`transformMyGeneResponse`, `transformMyChemResponse`, `transformMyVariantHit`, `transformTrialResponse`, `transformMyDiseaseResponse`) are tested with known inputs to verify field mapping
- `article.test.ts` includes tests for `parsePubMedXml` with structured abstracts, batch articles, invalid XML, and empty documents
- `article.test.ts` tests multi-source search (pubmed, pubtator, litsense) and all transformer functions (`transformPubTator`, `transformLitSense`, `transformEuropePMC`, `transformSemanticScholar`)
- `cross-entity.test.ts` verifies `discover()` fans out to mygene, myvariant, mychem, mydisease and falls back to OLS4

### Integration (tool registration)

- `tool-registration.test.ts` mocks all entity modules, connection manager, and fetch-utils
- Verifies each `register*Tools` function calls `server.registerTool()` the expected number of times
- Asserts 50 total tool registrations across all modules with no duplicate names

### Server (pure unit tests)

- `errors.test.ts`: Tests `createError`, `formatError` (error classification by keyword matching), and `withErrorHandling` wrapper — no mocks
- `validation.test.ts`: Tests Zod schemas (`InputValidation.*`), `formatValidationErrors`, `isValidEntityInput`, and `getEntitySuggestions` — no mocks

### Transform (pure unit tests)

- `gene.test.ts`: Tests `transformMyGeneHit`, `transformMyGeneResponse`, and `normalizeAliases` with full and sparse inputs — no mocks
