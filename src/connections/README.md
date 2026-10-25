# connections

API abstraction layer for biomcp-ts. Provides protocol-aware HTTP clients, a source registry, connection lifecycle management, and rate limiting for 38 bioinformatics data sources.

## Architecture

- **Strategy pattern** — `ConnectionManager` dispatches to `RestConnection` or `GraphQLConnection` based on `protocol` in `ConnectionOptions`. All implement `IConnection`.
- **Lazy initialization** — `ConnectionManager.getConnection(sourceId)` creates the connection on first access and caches it in a `Map`.
- **Module singleton** — `connectionManager` is the pre-instantiated `ConnectionManager` exported from `manager.ts`.

## Clock rule (duration math)

In-process DURATION / BUDGET / TTL / elapsed comparisons use the monotonic clock via `monotonicNowMs()` (`time.ts`) — never `Date.now()`. Wall-clock stays ONLY for absolute/persisted/user-visible timestamps (filenames, trace epochs, FS mtimes, HTTP `Retry-After` date parsing). Reason: WSL2 guest-clock jumps (NTP resync, host sleep/wake) make wall-clock deadlines corrupt elapsed state both ways — forward jumps expire fresh caches / falsely exhaust retry budgets; backward jumps make `expiresAt` comparisons stale-forever. `performance.now()` never moves backward, so converted math is immune. Trade-off: monotonic time excludes host-suspend time, so TTLs stretch across suspend — acceptable for this repo's short-lived in-process caches. Deliberate exception: `rate-limiter.ts` stays on `Date.now()` (import-time-constructed limiter singletons break fake-timer tests, and its capacity-1 bucket bounds wall-clock-jump damage to one extra request forward / a delayed refill backward).

### Proxy-aware, Happy-Eyeballs-tuned fetch (`proxy.ts`)

`proxy.ts` ALWAYS installs a global undici dispatcher at module scope (imported for its side effect by `manager.ts`, so the server, tests, and CLI paths all get it before the first outbound fetch — the env is read at agent construction time):

- **Proxy env set** → an `EnvHttpProxyAgent`, making every `fetch` call honor `HTTP_PROXY`/`HTTPS_PROXY` (and lowercase forms) plus `NO_PROXY`/`no_proxy`. Node's built-in fetch ignores these env vars by itself — verified live in proxied environments where direct TCP to some hosts (patents.google.com, web.archive.org) times out while the proxy carries them. `ALL_PROXY` / socks-only proxies are out of scope (http CONNECT only); Node ≥ 22.15 offers the zero-dependency `NODE_USE_ENV_PROXY=1` alternative.
- **No proxy env** → a plain `Agent` with the same tuned connect opts (direct fetch, no proxy machinery in the path).

The always-install exists for a second, independent reason: **Node ≥ 22 defaults Happy Eyeballs (`autoSelectFamily`, RFC 8305 IPv6/IPv4 racing) ON with a 250 ms per-attempt timeout**. Networks where TCP handshakes to dual-stack Cloudflare edges take 250–450 ms+ (observed: reactome.org, www.biorxiv.org, www.medrxiv.org) get every IPv4 attempt HE-aborted at 250 ms (`ETIMEDOUT`) while the IPv6 attempt fails instantly (`ENETUNREACH`); undici normalizes the AggregateError to `ConnectTimeoutError`, so users saw spurious `UND_ERR_CONNECT_TIMEOUT` after ~0.5 s. IPv4-only hosts never race — which is why only some sources broke. The installed dispatcher raises the per-attempt budget to a realistic `autoSelectFamilyAttemptTimeout` (default 2000 ms): fast-fail is preserved, slow-but-working edges are tolerated, and the worst case stays bounded by undici's default 10 s overall connect timeout.

- `BIOMCP_CONNECT_ATTEMPT_TIMEOUT_MS` tunes the per-attempt budget (default `2000`, clamped to 250–10000; invalid/non-numeric values fall back to the default). It covers **direct traffic only** — with a proxy set, the origin connect is the proxy's job (undici's `ProxyAgent` ignores `connect` opts).
- Installed via `setGlobalDispatcher` (never a manual `Symbol.for('undici.globalDispatcher.1')` assignment — Node's built-in fetch needs the wrapper `setGlobalDispatcher` installs). Side effect of that wrapper: it forces `allowH2: false`, so built-in fetch is HTTP/1-only in **all** environments (previously only in proxy envs) — acceptable; no biomcp-ts upstream requires HTTP/2.
- Exports `proxyStatus { configured, detail }` (`configured` = routed through a proxy); dispatcher-setup failures are surfaced on stderr and fetch stays on undici defaults.
- Hermetic localhost pin: the proxy suite asserts that a dispatcher installed through npm-undici's `setGlobalDispatcher` really governs Node's built-in global `fetch` — the interop this module depends on.

#### Egress self-diagnosis (hosts biomcp-ts must reach)

For users behind egress filters, these are the upstream hosts the server connects to (host list from `registry.ts` baseUrls, plus the entity-managed patent/wayback clients): `mygene.info`, `myvariant.info`, `mychem.info`, `mydisease.info`, `gtexportal.org`, `rest.ensembl.org`, `version-12-0.string-db.org`, `rest.uniprot.org`, `reactome.org`, `api.fda.gov`, `api-v3.monarchinitiative.org`, `www.ncbi.nlm.nih.gov`, `eutils.ncbi.nlm.nih.gov`, `pmc.ncbi.nlm.nih.gov`, `www.ebi.ac.uk` (Europe PMC + OLS), `api.semanticscholar.org`, `api.crossref.org`, `api.opencitations.net`, `api.biorxiv.org`, `www.biorxiv.org` / `www.medrxiv.org` (preprint full text), `export.arxiv.org`, `api.openalex.org`, `clinicaltrials.gov`, `api.reporter.nih.gov`, `www.oncokb.org`, `api.disgenet.com`, `data.rcsb.org`, `search.rcsb.org`, `files.rcsb.org`, `patents.google.com`, `api.uspto.gov`, `gnomad.broadinstitute.org`, `civicdb.org`, `dgidb.org`, `api.platform.opentargets.org`, plus the patent/wayback clients' `ppubs.uspto.gov`, `ops.epo.org`, and `web.archive.org` / `archive.org`. Allow these (HTTPS/443) through the firewall or route them via `HTTPS_PROXY`.

## File Reference

### `base.ts`

Core types and the `IConnection` interface.

```ts
type ProtocolType = 'rest' | 'graphql';

type AuthDeliveryMethod =
  | { type: 'header'; name: string }
  | { type: 'bearer' }
  | { type: 'authorization'; prefix?: string }
  | { type: 'query-param'; name: string };

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
  headers?: Record<string, string>;
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

### `rest.ts`

```ts
class RestConnection implements IConnection<string, unknown> {
  constructor(options: ConnectionOptions);
  request(path: string): Promise<unknown>;
  post(path: string, body: Record<string, unknown>): Promise<unknown>;
  batch(paths: string[]): Promise<unknown[]>;
  healthCheck(): Promise<boolean>;
  close(): void;
}
```

Issues `GET` requests via `request()`. Issues `POST` requests with JSON body via `post()` (handles 204 No Content by returning null). Auth credentials are read from `process.env` at construction time (`hasAuth` is snapshot). Static extra headers from `handling.headers` (e.g. `User-Agent`) are merged into every request. Response content type is auto-detected from the `content-type` header — JSON is parsed, everything else returned as text. Supports `timeoutMs` via `AbortSignal.timeout`.

`request()`/`post()` honor the registry-level `retry` config (`{ attempts, backoffMs }`, attempts = total tries): retryable failures (network errors, 429, 5xx) are retried with exponential backoff; sources without a `retry` entry get a single attempt. Domain-specific retries (EPO OPS throttle, USPTO PPUBS session refresh) stay inside their own clients.

### Timeout layering

From innermost to outermost: connection abort (`handling.timeoutMs`, typically 15s) → provider-level `withTimeout` (citation providers resolve null after `DEFAULT_PROVIDER_TIMEOUT_MS` = 10s; federated search throws after 20s so `Promise.allSettled` records the failure) → tool-level section timeout (30s). Both `withTimeout` modes live in `fetch-utils.ts`.

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

### `time.ts`

```ts
function monotonicNowMs(): number;
```

Monotonic milliseconds (`performance.now()`) for duration/budget/TTL math — see [Clock rule](#clock-rule-duration-math).

### `fetch-utils.ts`

```ts
function fetchWithTimeout<T>(
  fn: (signal?: AbortSignal) => Promise<T>,
  timeoutMs: number
): Promise<{ data?: T; error?: string }>;

function withTimeout<T>(
  promise: Promise<T>,
  timeoutMs: number,
  opts: { onTimeout: 'null' | 'throw'; label?: string }
): Promise<T | null>;
```

`fetchWithTimeout` wraps any async function with an `AbortController`-based timeout. Returns `{ data }` on success or `{ error }` on failure/abort.

`withTimeout` races a promise against a timer: `onTimeout: 'null'` resolves null (optional lookups, e.g. citation providers via `DEFAULT_PROVIDER_TIMEOUT_MS`); `onTimeout: 'throw'` rejects with `<label> timed out after <ms>ms` (federated search).

## Registry — Sources by Protocol

> Sources that do not fit the static registry auth model are entity-managed:
> EPO OPS (OAuth2 client-credentials) and USPTO PPUBS (session-token
> handshake) live in `src/entities/patent/` as dedicated clients.

### REST (34 sources)

| Category | Source IDs |
|---|---|
| Genomics | `mygene`, `myvariant`, `gtex`, `string`, `geo_soft`, `ensembl` |
| Proteins & Pathways | `uniprot`, `reactome`, `reactome_analysis` |
| Drugs & Pharmacology | `mychem`, `openfda` |
| Diseases | `mydisease`, `monarch` |
| Literature | `eutils`, `pubtator`, `europepmc`, `semantic_scholar`, `litsense`, `ncbi_idconv`, `crossref`, `opencitations`, `biorxiv`, `arxiv`, `openalex` |
| Clinical Trials | `clinicaltrials` |
| Ontologies & Analysis | `ols4` |
| Funding & Research | `nih_reporter` |
| Patents | `google_patents`, `uspto_odp` |
| Oncology | `oncokb` |
| Structural Biology | `pdb_data`, `pdb_search`, `pdb_files` |
| Required Auth Keys | `disgenet` |

> `eutils` is the shared NCBI E-utilities connection (formerly registered as `pubmed`): one entry serves PubMed (article_*), GEO (db=gds), SRA (db=sra), and GenBank (db=nuccore) — NCBI enforces a shared per-IP budget across all E-utilities databases, so a single rate limiter is deliberate. `geo_soft` (GEO SOFT viewer, a different NCBI host) keeps its own separate rate budget.

### GraphQL (4 sources)

`gnomad`, `civic`, `dgidb`, `opentargets`

## Rate Limiting

**Token bucket** with capacity 1 and refill rate `1 / intervalMs`. `acquire()` blocks until a token is available.

**Conditional rate limiting** applies when `RateLimitConfig.conditional` is `true`. The effective interval depends on whether an API key is present:

- Key present + `keyedRateLimitMs` set → uses `keyedRateLimitMs`
- No key → uses `fallbackRateLimitMs` (falls back to `intervalMs` if unset)

Sources with conditional rate limits: `eutils`, `pubtator`, `semantic_scholar`, `openalex`.

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
