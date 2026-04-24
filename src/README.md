# BioMCP TypeScript — Source Architecture

ESM-only MCP server exposing 50 biomedical tools to LLMs. Federates queries across 40+ upstream APIs. Node.js >=18, targets ES2022, 3 runtime dependencies (`@modelcontextprotocol/sdk`, `zod`, `fast-xml-parser`).

## Architecture

```
┌─────────────────────────────────────────────────────────────┐
│  LLM  ──stdio──▶  server/index.ts  (McpServer bootstrap)   │
│                          │                                   │
│                   server/tools/*.ts                         │
│                   (8 modules, 50 tools)                     │
│                          │                                   │
│              ┌───────────┼───────────┐                      │
│              ▼           ▼           ▼                      │
│        entities/    entities/    entities/cross-entity.ts   │
│        gene.ts      article.ts   (pivot, enrichment,       │
│        variant.ts   ...          batch, discovery)          │
│              │           │                                   │
│              └───────────┼───────────┘                      │
│                          ▼                                   │
│               connections/manager.ts                         │
│               (ConnectionManager singleton)                  │
│                     │                                        │
│         ┌───────────┼───────────┐                           │
│         ▼           ▼           ▼                           │
│     rest.ts    graphql.ts    grpc.ts                        │
│         │           │           │                           │
│         └───────────┼───────────┘                           │
│                     ▼                                       │
│              registry.ts (40+ sources)                      │
│                     │                                       │
│                     ▼                                       │
│            transform/*.ts                                   │
│            (response normalization)                          │
│                     │                                       │
│                     ▼                                       │
│              Upstream APIs                                  │
└─────────────────────────────────────────────────────────────┘
```

Four layers, strict downward dependency. No upward references.

## Layer 1 — `server/` MCP Protocol Layer

Entry point. Converts MCP tool calls into entity-layer invocations. All tools declare `readOnlyHint: true`.

### `server/index.ts`
Creates `McpServer` on `StdioServerTransport`. Imports and calls all 8 `register*Tools(server)` functions.

### `server/tools/` — Tool Registration (8 modules, 50 tools)

Each module exports a single `register*Tools(server: McpServer): void` function that calls `server.registerTool()` for each tool. Tool handlers perform try/catch and delegate to entity-layer functions. Input schemas use Zod directly.

| Module | Tools | Domain |
|--------|-------|--------|
| `gene.ts` | 10 | Gene search, get (14 sections) |
| `variant.ts` | 6 | Variant search, get (5 sections), clinical significance |
| `drug.ts` | 6 | Drug search, get (6 sections), targets, indications, adverse events, regulatory |
| `disease.ts` | 6 | Disease search, get (4 sections), genes, phenotypes |
| `article.ts` | 4 | Article search (federated/single-source), get |
| `trial.ts` | 5 | Trial search, get (3 sections), eligibility, locations, outcomes |
| `pivot.ts` | 10 | Cross-entity: gene→drugs, gene→trials, gene→articles, variant→trials, drug→genes, drug→trials, enrichment, discovery, batchGet, searchAll |
| `utility.ts` | 3 | Health check, list entities/tools, version |

### `server/errors.ts`
- `BioMCPError` interface: `{ code, message, suggestion?, details? }`
- `ErrorCodes` const object: `ENTITY_NOT_FOUND`, `INVALID_INPUT`, `TIMEOUT`, `API_ERROR`, `RATE_LIMIT`, `AUTH_REQUIRED`, `NETWORK_ERROR`, `VALIDATION_ERROR`
- `formatError(error)`: classifies unknown errors by message heuristics into typed `BioMCPError`
- `withErrorHandling(fn)`: wraps async functions returning `{ data? } | { error? }`
- `sectionResult()`, `getSectionError()`, `extractSection()`: section-level error accessors for the `{ _error }` pattern

### `server/validation.ts`
- `InputValidation`: Zod schemas for all entity identifiers (gene symbol, variant ID, drug name, disease query, PMID, NCT ID, limit, offset)
- `validateInput(schema, data)`: returns `{ success, data? } | { success: false, errors[] }`
- `isValidEntityInput(entity, id)`: dispatches to the correct schema
- `getEntitySuggestions(entity)`: returns human-readable guidance per entity type

## Layer 2 — `entities/` Business Logic Layer

Pure data orchestration. Each module knows which upstream sources to call and how to compose results. No MCP awareness.

### Entity Modules

Consistent dual-function pattern across all entities:

```
entitySearch(query, options?) → SearchResult[]
entityGet(id, sections?)      → { ...core, sections: Record<string, unknown> }
```

**Section-based fetching**: `entityGet` accepts an optional `sections` array. Each requested section is fetched in parallel via `Promise.allSettled`. Every section is wrapped in `fetchWithTimeout(fn, 8000)`. Failed or timed-out sections produce `{ _error: "..." }` instead of throwing — partial results are always returned.

| Module | Lines | Sections | Primary Sources |
|--------|-------|----------|-----------------|
| `gene.ts` | 721 | 14 (pathways, ontology, diseases, diagnostics, protein, go, interactions, civic, expression, hpa, druggability, clingen, constraint, disgenet) | MyGene, UniProt, STRING, GTEx, ClinGen, GWAS, HPA |
| `variant.ts` | 657 | 5 (core, frequency, predictions, clinical, alphagenome) | MyVariant, ClinVar, ClinGen, gnomAD, CADD |
| `drug.ts` | 359 | 6 (us_regulatory, eu_regulatory, who_regulatory, safety, targets, indications) | MyChem, OpenTargets, ChEMBL, OpenFDA |
| `disease.ts` | 314 | 4 (gene_associations, phenotypes, pathways, survival) | DisGeNET, OpenTargets, MyDisease |
| `article.ts` | 593 | — | PubMed, Europe PMC, Semantic Scholar, PubTator, LitSense |
| `trial.ts` | 395 | 3 (eligibility, locations, outcomes) | ClinicalTrials.gov |

### `entities/cross-entity.ts` (619 lines)

Cross-entity pivot functions and multi-entity operations:

- **Pivots**: `geneToDrugs`, `geneToTrials`, `geneToArticles`, `variantToTrials`, `drugToGenes`, `drugToTrials` — each queries the appropriate upstream source (e.g., `geneToDrugs` hits OpenTargets GraphQL)
- **Enrichment**: `geneEnrichment(geneSymbols[])` — Reactome pathway enrichment
- **Discovery**: `discover(query)` — multi-entity search across all domains
- **Batch**: `batchGet(entity, ids[])` — parallel entity resolution
- **Universal**: `searchAll(query)` — fans out to all entity search functions

### `entities/article.ts` — Federated Search

`articleSearch` without a `source` parameter fans out to 5 backends in parallel via `Promise.allSettled`. Results are deduplicated by PMID/DOI and ranked by citation count. With a `source` parameter, queries a single backend directly.

## Layer 3 — `connections/` API Abstraction Layer

Hides upstream API protocol differences behind a uniform interface.

### `connections/base.ts`
- `IConnection<TReq, TRes>`: `{ sourceId, protocol, effectiveRateLimitMs, request(), batch?(), healthCheck(), close() }`
- `ConnectionOptions`: source config including `baseUrl`, `protocol`, `auth?`, `rateLimit`, `handling?` (streaming, timeout, content type)
- `AuthConfig`: env var name, delivery method (header, bearer, query-param, grpc-metadata), conditional rate limits

### `connections/registry.ts` (483 lines)
`SOURCE_REGISTRY`: `Record<string, ConnectionOptions>` with 40+ data source configurations. Organized by domain (genomics, proteins/pathways, drugs, diseases, literature, clinical trials, pathways). Each entry specifies URL, protocol (rest/graphql/grpc), auth config, and rate limit (including conditional keyed vs. fallback rates).

### `connections/manager.ts`
`ConnectionManager` — module-level singleton exported as `connectionManager`. Lazy factory: `getConnection(sourceId)` creates the connection on first access, caches in a `Map`. `createConnection()` dispatches on `protocol` to instantiate `RestConnection`, `GraphQLConnection`, or `GrpcConnection`.

### Protocol Implementations (Strategy Pattern)

| File | Class | Protocol | Notes |
|------|-------|----------|-------|
| `rest.ts` | `RestConnection` | REST/HTTP | `fetch()` with auth header injection, HTTP status → hint mapping |
| `graphql.ts` | `GraphQLConnection` | GraphQL | POST with `{ query, variables }` body |
| `grpc.ts` | `GrpcConnection` | gRPC-over-HTTP | JSON payloads with gRPC metadata headers |

All three implement `IConnection` and integrate `TokenBucketRateLimiter` on every `request()` call.

### `connections/rate-limiter.ts`
`TokenBucketRateLimiter`: token bucket with capacity 1, refill rate derived from configured interval. Conditional rate limiting: when `config.conditional` is set, checks for API key presence (`hasKey`) and uses `keyedRateLimitMs` (faster) or `fallbackRateLimitMs` (slower, unauthenticated). `acquire()` blocks until a token is available.

### `connections/fetch-utils.ts`
`fetchWithTimeout<T>(fn, timeoutMs)`: wraps any async function with an `AbortController`-based timeout. Returns `{ data? } | { error? }` — never throws.

## Layer 4 — `transform/` Data Transformation Layer

Normalizes upstream responses into domain types. Pure functions, no side effects.

### `transform/gene.ts` (46 lines)
- `transformMyGeneHit(hit)`: MyGene search hit → `GeneSearchResult` (extracts symbol, name, entrez_id, genomic_coordinates, uniprot_id, omim_id)
- `transformMyGeneResponse(data)`: MyGene detail record → `GeneResult` (symbol, name, summary)
- `normalizeAliases(aliases?)`: filters empty strings

### `transform/pubmed.ts` (214 lines)
- `parsePubMedXml(xmlString)`: parses PubMed e-utilities XML via `fast-xml-parser`. The `isArray` callback enforces array semantics for elements that may appear once or many times (PubmedArticle, Author, MeshHeading, etc.). Returns `Article[]`.

## Data Flow

```
1. LLM calls tool (e.g., gene_get with symbol="BRAF", sections=["pathways","protein"])
2. server/tools/gene.ts handler receives typed params
3. → entities/gene.ts geneGet("BRAF", ["pathways","protein"])
4. → connections/manager.ts getConnection("mygene")  →  RestConnection (cached)
5. → connections/rest.ts request("/gene/BRAF")  →  fetch upstream
6. → transform/gene.ts transformMyGeneResponse(raw)
7. → Parallel section fetches via Promise.allSettled + fetchWithTimeout(fn, 8000)
   Each section: getConnection(source) → request() → transform
8. Assemble: { symbol, name, summary, sections: { pathways: {...}, protein: {...} } }
9. Handler returns MCP text content to LLM
```

## Error Handling Strategy

Three-tier resilience:

1. **Tool level** (`server/tools/*.ts`): try/catch around every handler. Returns `{ content, isError: true }` on failure.
2. **Entity level** (`entities/*.ts`): try/catch around each section fetch. Failed sections produce `{ _error: "description" }` — never throw, always return partial results.
3. **Connection level** (`connections/*.ts`): HTTP status codes mapped to descriptive hints in `RestConnection`. Rate limiter blocks before requests. `fetchWithTimeout` enforces per-section timeouts via `AbortController`.

Error classification (`server/errors.ts`): `formatError()` inspects `Error.message` for keywords (timeout, 401/403, 429, not found, network) and produces a structured `BioMCPError` with an actionable `suggestion` field.

## Design Patterns

| Pattern | Where | Purpose |
|---------|-------|---------|
| Strategy | `rest.ts`, `graphql.ts`, `grpc.ts` | Protocol-agnostic connection interface |
| Singleton | `connectionManager` instance | Single connection cache per source |
| Lazy Factory | `ConnectionManager.getConnection()` | Create connections on first use |
| Section-based | `entityGet()` across all entities | LLMs request only needed data, 8s timeout per section |
| Federated Aggregation | `articleSearch()`, `searchAll()` | Parallel multi-backend queries with dedup |
| Conditional Rate Limiting | `TokenBucketRateLimiter` | Faster throughput with API keys |
| `{ _error }` Result | Entity section fetches | Partial results on failure, never throw |

## Build and Test

```
npm run build       # tsc → dist/
npm run start       # node dist/server/index.js (stdio transport)
npm run dev         # tsx watch src/server/index.ts
npm run test        # jest via ts-jest (experimental-vm-modules)
npm run test:coverage
npm run typecheck   # tsc --noEmit
```

Test directory mirrors source: `src/__tests__/{connections,entities,integration,server,transform}/`.

## Dependency Summary

| Package | Role |
|---------|------|
| `@modelcontextprotocol/sdk` | MCP protocol (server, transport, tool registration) |
| `zod` | Input validation schemas for tool parameters |
| `fast-xml-parser` | PubMed XML parsing |

All HTTP uses native `fetch()` (Node.js 18+). No axios, no undici, no express.
