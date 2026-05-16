# BioMCP TypeScript — Source Architecture

ESM-only MCP server exposing 25 biomedical tools to LLMs. Federates queries across 50+ upstream APIs. Node.js >=18, targets ES2022, 3 runtime dependencies (`@modelcontextprotocol/sdk`, `zod`, `fast-xml-parser`).

## Architecture

```
┌─────────────────────────────────────────────────────────────┐
│  LLM  ──stdio──▶  server/index.ts  (McpServer bootstrap)   │
│                          │                                   │
│                   server/tools/*.ts                         │
│                   (8 modules, 25 tools)                      │
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
│              registry.ts (50+ sources)                      │
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
Creates `McpServer` on `StdioServerTransport`. Imports and calls all 7 `register*Tools(server)` functions.

### `server/tools/` — Tool Registration (7 modules, 24 tools)

Each module exports a single `register*Tools(server: McpServer): void` function that calls `server.registerTool()` for each tool. Tool handlers perform try/catch and delegate to entity-layer functions. Input schemas use Zod directly.

| Module | Tools | Domain |
|--------|-------|--------|
| `gene.ts` | 7 | Gene search, get (14 sections), diseases, drugs, trials, articles, enrichment |
| `variant.ts` | 4 | Variant search, get (5 sections), OncoKB annotations, trials |
| `drug.ts` | 3 | Drug search, get (6 sections), trials |
| `disease.ts` | 4 | Disease search, get (4 sections), drugs, trials |
| `article.ts` | 2 | Article search (federated/single-source), get |
| `trial.ts` | 2 | Trial search, get (3 sections) |
| `utility.ts` | 2 | Free-text discovery, batch entity resolution |
| `pdb.ts` | 1 | PDB structure search, metadata, file download (RCSB PDB) |

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
| `gene.ts` | 728 | 14 (pathways, protein, ontology, go, interactions, clinical_evidence, expression, protein_atlas, druggability, dosage_sensitivity, constraint, disease_associations, diseases, funding) | MyGene.info, Reactome, UniProt, STRING-db, CIViC, GTEx, HPA, DGIdb, OpenTargets, gnomAD, DisGeNET, NIH Reporter |
| `variant.ts` | 678 | 5 (core, frequency, predictions, clinical, alphagenome_scores) | MyVariant.info, CIViC, OncoKB, AlphaGenome |
| `drug.ts` | 359 | 6 (us_regulatory, eu_regulatory, who_regulatory, safety, targets, indications) | MyChem.info, OpenFDA, OpenTargets |
| `disease.ts` | 314 | 4 (gene_associations, phenotypes, pathways, survival) | MyDisease.info, DisGeNET, Monarch, Reactome, SEER |
| `article.ts` | 593 | 4 (open_access, annotations, citation_graph, citation) | PubMed, Europe PMC, Semantic Scholar, PubTator, LitSense, NCBI ID Converter, PMC OA, Crossref, OpenCitations |
| `trial.ts` | 395 | 3 (eligibility, locations, outcomes) | ClinicalTrials.gov |
| `pdb.ts` | 355 | 5 (polymer_entities, ligands, assembly, experiment, citation) | RCSB PDB (Data API, Search API, File Download) |

### `entities/cross-entity.ts` (619 lines)

Cross-entity pivot functions and multi-entity operations:

- **Pivots**: `geneToDrugs`, `geneToTrials`, `geneToPathways`, `geneToArticles`, `variantToTrials`, `drugToGenes`, `drugToTrials`, `drugToAdverseEvents`, `diseaseToDrugs`, `diseaseToGenes`, `diseaseToTrials` — each queries the appropriate upstream source
- **Enrichment**: `geneEnrichment(geneSymbols[])` — Reactome pathway enrichment
- **Discovery**: `discover(query)` — multi-entity search across all domains
- **Batch**: `batchGet(inputs: BatchGetInput[])` — parallel entity resolution
- **Universal**: `searchAll(query, options?)` — fans out to all entity search functions

Functions not exposed as MCP tools: `geneToPathways`, `drugToGenes`, `drugToAdverseEvents`, `diseaseToGenes`, `diseaseToTrials`, `searchAll`.

### `entities/article.ts` — Federated Search

`articleSearch` without a `source` parameter fans out to 5 backends in parallel via `Promise.allSettled`. Results are deduplicated by PMID/DOI and ranked by citation count. With a `source` parameter, queries a single backend directly.

### Citation Module (`entities/article/citation/`)

Federated citation data from 5 sources with 10s timeout on all providers:

| Provider | Forward | Backward | Count | ID Support |
|----------|---------|----------|-------|------------|
| PubMed | ELink + EFetch enrichment | ELink + EFetch enrichment | ELink link count | PMID |
| EuropePMC | REST citations API | REST references API | Search API | PMID, DOI, PMCID |
| Semantic Scholar | Graph API citations | Graph API references | Paper API | PMID, DOI, PMCID |
| Crossref | `/works?filter=references:` | `/works/{doi}` (cached) | `/works/{doi}` (cached) | DOI |
| OpenCitations | `/v2/citations/` | `/references/` | `/citation-count/` | DOI |

The orchestrator (`citation/index.ts`) queries all providers in parallel, deduplicates by DOI/PMID/PMCID keeping the record with the most fields, and aggregates citation counts. Crossref uses a 30s work cache to avoid redundant `/works/{doi}` calls between backward references and citation count requests.

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
| In-Process Testing | `__tests__/helpers/mcp-harness.ts` | `InMemoryTransport` client connected to real `McpServer` for integration tests |
| Conditional Rate Limiting | `TokenBucketRateLimiter` | Faster throughput with API keys |
| `{ _error }` Result | Entity section fetches | Partial results on failure, never throw |

## Build and Test

```
make                # Show available targets
make install        # Install dependencies
make build          # Compile and bundle into dist/bundle.js
make typecheck      # tsc --noEmit
make test           # Unit tests (fast, mocked, parallel)
make test-integration # Integration tests (live APIs, serial, ~60s)
make test-all        # All tests combined
make clean          # Remove build artifacts
```

## Dependency Summary

| Package | Role |
|---------|------|
| `@modelcontextprotocol/sdk` | MCP protocol (server, transport, tool registration) |
| `zod` | Input validation schemas for tool parameters |
| `fast-xml-parser` | PubMed XML parsing |

All HTTP uses native `fetch()` (Node.js 18+). No axios, no undici, no express.
