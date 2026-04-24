# connections

API abstraction layer for biomcp-ts. Provides protocol-aware HTTP clients, a source registry, connection lifecycle management, and rate limiting for 40+ bioinformatics data sources.

## Architecture

- **Strategy pattern** — `ConnectionManager` dispatches to `RestConnection`, `GraphQLConnection`, or `GrpcConnection` based on `protocol` in `ConnectionOptions`. All implement `IConnection`.
- **Lazy initialization** — `ConnectionManager.getConnection(sourceId)` creates the connection on first access and caches it in a `Map`.
- **Module singleton** — `connectionManager` is the pre-instantiated `ConnectionManager` exported from `manager.ts`.

## File Reference

### `base.ts`

Core types and the `IConnection` interface.

```ts
type ProtocolType = 'rest' | 'graphql' | 'grpc' | 'local-file';

type AuthDeliveryMethod =
  | { type: 'header'; name: string }
  | { type: 'bearer' }
  | { type: 'authorization'; prefix?: string }
  | { type: 'query-param'; name: string }
  | { type: 'grpc-metadata'; name: string };

interface AuthConfig {
  envVar: string;
  required: boolean;
  delivery: AuthDeliveryMethod;
  fallbackRateLimitMs?: number;
  keyedRateLimitMs?: number;
}

interface RateLimitConfig {
  intervalMs: number;
  conditional?: boolean;
  fallbackRateLimitMs?: number;
  keyedRateLimitMs?: number;
}

interface ConnectionHandling {
  streaming?: boolean;
  timeoutMs?: number;
  batchable?: boolean;
  maxBatchSize?: number;
  contentType?: 'json' | 'xml' | 'text' | 'binary';
  staleHours?: number;
}

interface ConnectionOptions {
  sourceId: string;
  baseUrl: string;
  protocol: ProtocolType;
  auth?: AuthConfig;
  rateLimit: RateLimitConfig;
  handling?: ConnectionHandling;
}

interface IConnection<TRequest = string, TResponse = unknown> {
  readonly sourceId: string;
  readonly protocol: ProtocolType;
  effectiveRateLimitMs: number;
  request(req: TRequest, variables?: Record<string, unknown>): Promise<TResponse>;
  batch?(requests: TRequest[]): Promise<TResponse[]>;
  healthCheck(): Promise<boolean>;
  close(): void;
}

type AnyConnection = IConnection;
```

### `registry.ts`

Static registry of all data sources and query helpers.

```ts
const SOURCE_REGISTRY: Record<string, ConnectionOptions>;
```

```ts
function getSourceConfig(sourceId: string): ConnectionOptions;
function getSourcesByProtocol(protocol: string): ConnectionOptions[];
function getSourcesRequiringAuth(): ConnectionOptions[];
function getSourcesWithOptionalAuth(): ConnectionOptions[];
```

### `manager.ts`

Connection factory and lifecycle manager.

```ts
class ConnectionManager {
  getConnection(sourceId: string): IConnection<any, any>;
  createConnection(config: ConnectionOptions): IConnection<any, any>;
  healthCheckAll(): Promise<Record<string, boolean>>;
  closeAll(): void;
  listConnections(): string[];
}

const connectionManager: ConnectionManager;
```

`local-file` protocol throws `"Local file connection not yet implemented"`.

### `rest.ts`

```ts
class RestConnection implements IConnection<string, unknown> {
  constructor(options: ConnectionOptions);
  request(path: string): Promise<unknown>;
  batch(paths: string[]): Promise<unknown[]>;
  healthCheck(): Promise<boolean>;
  close(): void;
}
```

Issues `GET` requests. Auth credentials are read from `process.env` at construction time (`hasAuth` is snapshot). Response content type is auto-detected from the `content-type` header — JSON is parsed, everything else returned as text. Supports `timeoutMs` via `AbortSignal.timeout`.

### `graphql.ts`

```ts
class GraphQLConnection implements IConnection<string, unknown> {
  constructor(options: ConnectionOptions, auth?: AuthConfig);
  request(query: string, variables?: Record<string, unknown>): Promise<unknown>;
  batch(queries: string[]): Promise<unknown[]>;
  healthCheck(): Promise<boolean>;
  close(): void;
}
```

Issues `POST` requests with `{ query, variables? }` JSON body.

### `grpc.ts`

```ts
class GrpcConnection implements IConnection<GrpcRequest, unknown> {
  constructor(options: ConnectionOptions);
  request(req: GrpcRequest): Promise<unknown>;
  batch(requests: GrpcRequest[]): Promise<unknown[]>;
  healthCheck(): Promise<boolean>;
  close(): void;
}

interface GrpcRequest {
  variant: string;
  scorer?: string;
}
```

Proxies gRPC calls through Google's HTTP/JSON gateway at `https://{host}/v1/scoreVariant:scoreVariant`. Defaults `scorer` to `'GeneMaskLFCScorer'`.

### `rate-limiter.ts`

```ts
class TokenBucketRateLimiter {
  constructor(config: RateLimitConfig, hasKey?: boolean);
  acquire(): Promise<void>;
  updateRateLimit(newConfig: RateLimitConfig, hasKey: boolean): void;
}

class RateLimiterFactory {
  static create(config: RateLimitConfig, hasKey?: boolean): TokenBucketRateLimiter;
  static getEffectiveRate(baseRate: number, config: RateLimitConfig, hasKey: boolean): number;
}
```

### `fetch-utils.ts`

```ts
function fetchWithTimeout<T>(
  fn: (signal?: AbortSignal) => Promise<T>,
  timeoutMs: number
): Promise<{ data?: T; error?: string }>;
```

Wraps any async function with an `AbortController`-based timeout. Returns `{ data }` on success or `{ error }` on failure/abort.

## Registry — Sources by Protocol

### REST (44 sources)

| Category | Source IDs |
|---|---|
| Genomics | `mygene`, `myvariant`, `clingen`, `gtex`, `hpa`, `gwas`, `string` |
| Proteins & Pathways | `uniprot`, `interpro`, `complexportal`, `reactome`, `reactome_analysis`, `kegg`, `wikipathways` |
| Drugs & Pharmacology | `mychem`, `chembl`, `openfda`, `cpic`, `pharmgkb` |
| Diseases | `mydisease`, `monarch`, `seer`, `medlineplus`, `hpo` |
| Literature | `pubmed`, `pubtator`, `europepmc`, `semantic_scholar`, `litsense`, `ncbi_idconv`, `pmc_oa` |
| Clinical Trials | `clinicaltrials`, `nci_cts` |
| Diagnostics & Registries | `vaers` |
| Enrichment & Analysis | `enrichr`, `gprofiler`, `ols4`, `quickgo` |
| Funding & Research | `nih_reporter` |
| cBio Portal | `cbioportal`, `cbioportal_datahub` |
| Oncology | `oncokb` |
| Required Auth Keys | `disgenet`, `umls` |

### GraphQL (4 sources)

`gnomad`, `civic`, `dgidb`, `opentargets`

### gRPC (1 source)

`alphagenome`

### Local File (5 sources)

`ema`, `who_pq`, `gtr`, `who_ivd`, `cvx`

## Rate Limiting

**Token bucket** with capacity 1 and refill rate `1 / intervalMs`. `acquire()` blocks until a token is available.

**Conditional rate limiting** applies when `RateLimitConfig.conditional` is `true`. The effective interval depends on whether an API key is present:

- Key present + `keyedRateLimitMs` set → uses `keyedRateLimitMs`
- No key → uses `fallbackRateLimitMs` (falls back to `intervalMs` if unset)

Sources with conditional rate limits: `pubmed`, `pubtator`, `semantic_scholar`.

## Error Enrichment

`RestConnection` enriches HTTP error messages via `getHttpStatusHint`:

| Status | Hint |
|---|---|
| 400 | Suggests the record may not exist or isn't indexed |
| 404 | Suggests verifying the ID |
| 429 | Suggests waiting and setting the API key for higher limits |
| 401/403 | Suggests setting the required API key in environment |
| 500+ | Suggests the service is temporarily unavailable |

Error messages include the URL and `sourceId` for debuggability.
