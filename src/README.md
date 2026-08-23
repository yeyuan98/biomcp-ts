# BioMCP TypeScript — Source Architecture

ESM-only MCP server exposing 27 biomedical tools to LLMs. Federates queries across 50+ upstream APIs. Requires Node.js >= 20.18.1 (`engines` in package.json), targets ES2022. Single runtime dependency: `undici` (proxy-aware global fetch). `@modelcontextprotocol/sdk`, `zod`, and `fast-xml-parser` are devDependencies bundled into `dist/bundle.js` at build time.

## Architecture

```
┌─────────────────────────────────────────────────────────────┐
│  LLM  ──stdio──▶  server/index.ts  (McpServer bootstrap)   │
│                          │                                   │
│                   server/tools/*.ts                         │
│                   (9 modules, 27 tools)                      │
│                          │                                   │
│              ┌───────────┼───────────┐                      │
│              ▼           ▼           ▼                      │
│        entities/    entities/    entities/cross-entity.ts   │
│        gene.ts      article/     (pivot, enrichment,       │
│        variant.ts   ...          batch, discovery)          │
│              │           │                                   │
│              └───────────┼───────────┘                      │
│                          ▼                                   │
│               connections/manager.ts                         │
│               (ConnectionManager singleton)                  │
│                     │                                        │
│             ┌───────┴───────┐                                │
│             ▼               ▼                                │
│         rest.ts        graphql.ts                            │
│             │               │                                │
│             └───────┬───────┘                                │
│                     ▼                                        │
│              registry.ts (34 sources, incl. patents)         │
│                     │                                        │
│                     ▼                                        │
│            transform/*.ts                                   │
│            (response normalization)                          │
│                     │                                        │
│                     ▼                                        │
│              Upstream APIs                                  │
└─────────────────────────────────────────────────────────────┘
```

Four layers, strict downward dependency. No upward references.

## Layer 1 — `server/` MCP Protocol Layer

Entry point. Converts MCP tool calls into entity-layer invocations. All tools are read-only except `pdb` (it writes downloaded structure files to disk). For the complete tool registry, input schemas, error codes, and validation details, see [server/README.md](server/README.md).

- `server/index.ts` — creates `McpServer` on `StdioServerTransport`, imports and calls all 9 `register*Tools(server)` functions.
- `server/tools/` — 9 registration modules, one `register*Tools(server)` per domain; handlers try/catch and delegate to the entity layer; Zod input schemas.
- `server/errors.ts` — `BioMCPError` typing, `formatError` classification, `withErrorHandling`, `{ _error }` section helpers.
- `server/validation.ts` — Zod schemas for entity identifiers plus `validateInput` / `isValidEntityInput` / `getEntitySuggestions`.

## Layer 2 — `entities/` Business Logic Layer

Pure data orchestration. Each module knows which upstream sources to call and how to compose results. No MCP awareness.

### Entity Modules

Consistent dual-function pattern across all entities:

```
entitySearch(query, options?) → SearchResult[]
entityGet(id, sections?)      → { ...core, sections: Record<string, unknown> }
```

**Section-based fetching**: `entityGet` accepts an optional `sections` array. Each requested section is fetched in parallel via `Promise.allSettled`. Every section is wrapped in `fetchWithTimeout(fn, 8000)`. Failed or timed-out sections produce `{ _error: "..." }` instead of throwing — partial results are always returned.

| Module | Sections | Primary Sources |
|--------|----------|-----------------|
| `gene.ts` | 14 (pathways, protein, ontology, go, interactions, clinical_evidence, expression, protein_atlas, druggability, dosage_sensitivity, constraint, disease_associations, diseases, funding) | MyGene.info, Reactome, UniProt, STRING-db, CIViC, GTEx, HPA, DGIdb, OpenTargets, gnomAD, DisGeNET, NIH Reporter |
| `variant.ts` | 4 + stub (core, frequency, predictions, clinical; `alphagenome_scores` currently returns an error stub pending reimplementation) | MyVariant.info, CIViC, OncoKB |
| `drug.ts` | 6 (us_regulatory, eu_regulatory, who_regulatory, safety, targets, indications) | MyChem.info, OpenFDA, OpenTargets |
| `disease.ts` | 3 (gene_associations, phenotypes, pathways) | MyDisease.info, DisGeNET, Monarch, Reactome |
| `article/` | 4 (open_access, annotations, citation_graph, citation) | PubMed, Europe PMC, Semantic Scholar, PubTator, LitSense, NCBI ID Converter, PMC OA, Crossref, OpenCitations |
| `trial.ts` | 3 (eligibility, locations, outcomes) | ClinicalTrials.gov |
| `pdb.ts` | 5 (polymer_entities, ligands, assembly, experiment, citation) | RCSB PDB (Data API, Search API, File Download) |
| `patent/` | 6 (core, abstract, claims, citations, family, classifications) | EPO OPS, USPTO ODP, USPTO PPUBS, Google Patents (+ Wayback fallback) |

### `entities/cross-entity.ts`

Cross-entity pivot functions and multi-entity operations:

- **Pivots**: `geneToDrugs`, `geneToTrials`, `geneToPathways`, `geneToArticles`, `variantToTrials`, `drugToGenes`, `drugToTrials`, `drugToAdverseEvents`, `diseaseToDrugs`, `diseaseToGenes`, `diseaseToTrials` — each queries the appropriate upstream source
- **Enrichment**: `geneEnrichment(geneSymbols[])` — Reactome pathway enrichment
- **Discovery**: `discover(query)` — multi-entity search across all domains
- **Batch**: `batchGet(inputs: BatchGetInput[])` — parallel entity resolution
- **Universal**: `searchAll(query, options?)` — fans out to the supported entity search functions (gene, variant, drug, disease, article, trial)

Functions not exposed as MCP tools: `geneToPathways`, `drugToGenes`, `drugToAdverseEvents`, `diseaseToGenes`, `diseaseToTrials`, `searchAll`.

### `entities/article/` — Federated Search

`articleSearch` without a `source` parameter fans out to 5 backends in parallel via `Promise.allSettled`. Results are deduplicated by PMID/DOI and ranked by citation count. With a `source` parameter, queries a single backend directly. PubMed XML parsing lives in `article/transform/pubmed.ts`.

### Citation Module (`entities/article/citation/`)

Federated citation data from 5 providers with 10s timeout on all providers:

| Provider | Forward | Backward | Count | ID Support |
|----------|---------|----------|-------|------------|
| PubMed | ELink + EFetch enrichment | ELink + EFetch enrichment | ELink link count | PMID |
| EuropePMC | REST citations API | REST references API | Search API | PMID, DOI, PMCID |
| Semantic Scholar | Graph API citations | Graph API references | Paper API | PMID, DOI, PMCID |
| Crossref | — (API dropped the `references` filter) | `/works/{doi}` (cached) | `/works/{doi}` (cached) | DOI |
| OpenCitations | `/v2/citations/` | `/references/` | `/citation-count/` | DOI |

Fast mode queries EuropePMC, Semantic Scholar, Crossref, and OpenCitations in parallel (~4s); full mode adds PubMed (~15-30s). The orchestrator (`citation/index.ts`) deduplicates by DOI/PMID/PMCID keeping the record with the most fields, aggregates citation counts, and falls back to PubMed when other providers return counts but no items. Crossref uses a 30s work cache to avoid redundant `/works/{doi}` calls between backward references and citation count requests.

## Layer 3 — `connections/` API Abstraction Layer

Hides upstream API protocol differences behind a uniform interface.

### `connections/base.ts`
- `IConnection<TReq, TRes>`: `{ sourceId, protocol, effectiveRateLimitMs, request(), batch?(), healthCheck(), close() }`
- `ConnectionOptions`: source config including `baseUrl`, `protocol`, `auth?`, `rateLimit`, `handling?` (streaming, timeout, content type)
- `AuthConfig`: env var name, delivery method (header, bearer, query-param), conditional rate limits

### `connections/registry.ts`
`SOURCE_REGISTRY`: `Record<string, ConnectionOptions>` with 34 data source configurations. Organized by domain (genomics, proteins/pathways, drugs, diseases, literature, clinical trials, patents). Each entry specifies URL, protocol (rest/graphql), auth config, and rate limit (including conditional keyed vs. fallback rates).

### `connections/manager.ts`
`ConnectionManager` — module-level singleton exported as `connectionManager`. Lazy factory: `getConnection(sourceId)` creates the connection on first access, caches in a `Map`. `createConnection()` dispatches on `protocol` to instantiate `RestConnection` or `GraphQLConnection`.

### `connections/proxy.ts`
Reads `HTTPS_PROXY`/`HTTP_PROXY` (+ lowercase) and `NO_PROXY`, configures undici so the global `fetch` routes through the proxy for all tools. Proxy-init failures are surfaced, not swallowed.

### Protocol Implementations (Strategy Pattern)

| File | Class | Protocol | Notes |
|------|-------|----------|-------|
| `rest.ts` | `RestConnection` | REST/HTTP | `fetch()` with auth header injection, HTTP status → hint mapping |
| `graphql.ts` | `GraphQLConnection` | GraphQL | POST with `{ query, variables }` body |

Both implement `IConnection` and integrate `TokenBucketRateLimiter` on every `request()` call.

### `connections/rate-limiter.ts`
`TokenBucketRateLimiter`: token bucket with capacity 1, refill rate derived from configured interval. Conditional rate limiting: when `config.conditional` is set, checks for API key presence (`hasKey`) and uses `keyedRateLimitMs` (faster) or `fallbackRateLimitMs` (slower, unauthenticated). `acquire()` blocks until a token is available.

### `connections/fetch-utils.ts`
`fetchWithTimeout<T>(fn, timeoutMs)`: wraps any async function with an `AbortController`-based timeout. Returns `{ data? } | { error? }` — never throws.

## Layer 4 — `transform/` Data Transformation Layer

Normalizes upstream responses into domain types. Pure functions, no side effects. Currently `transform/gene.ts` (MyGene hit/detail → `GeneSearchResult` / `GeneResult`, alias normalization) and `transform/pdb.ts` (RCSB response normalization).

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

Error classification and codes: see [server/README.md](server/README.md#error-handling-errorsts).

## Design Patterns

| Pattern | Where | Purpose |
|---------|-------|---------|
| Strategy | `rest.ts`, `graphql.ts` | Protocol-agnostic connection interface |
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

| Package | Kind | Role |
|---------|------|------|
| `undici` | runtime | Proxy-aware global `fetch` |
| `@modelcontextprotocol/sdk` | dev (bundled) | MCP protocol (server, transport, tool registration) |
| `zod` | dev (bundled) | Input validation schemas for tool parameters |
| `fast-xml-parser` | dev (bundled) | PubMed XML parsing |

Only `undici` ships as a runtime dependency; everything else is bundled into `dist/bundle.js` at build time.
