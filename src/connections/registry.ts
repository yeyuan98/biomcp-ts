import { ConnectionOptions } from './base.js';

export const SOURCE_REGISTRY: Record<string, ConnectionOptions> = {
  // ==========================================
  // GENOMICS - REST (6 sources)
  // ==========================================
  mygene: {
    sourceId: 'mygene',
    baseUrl: 'https://mygene.info/v3',
    protocol: 'rest',
    handling: { timeoutMs: 15000 },
    rateLimit: { intervalMs: 100 },
  },
  myvariant: {
    sourceId: 'myvariant',
    baseUrl: 'https://myvariant.info/v1',
    protocol: 'rest',
    handling: { timeoutMs: 15000 },
    rateLimit: { intervalMs: 100 },
    // variant_trials resolves ids through myvariant before the trials query;
    // a transient blip used to surface as a silent raw-identifier search
    // (#198) — one bounded retry smooths it.
    retry: { attempts: 2, backoffMs: 500 },
    // #107: budget 35s — one full 15s attempt + backoff always fits, two
    // stacked 15s timeouts do not.
    retryBudgetMs: 35000,
  },
  gtex: {
    sourceId: 'gtex',
    baseUrl: 'https://gtexportal.org',
    protocol: 'rest',
    handling: { timeoutMs: 15000 },
    rateLimit: { intervalMs: 100 },
    // gtexportal.org intermittently drops connections (observed ~1-in-3
    // transient failures from datacenter IPs); one bounded retry smooths it.
    retry: { attempts: 2, backoffMs: 500 },
  },
  // Ensembl REST (https://rest.ensembl.org): gene stable-ID lookup, Compara
  // homology, on-demand VEP consequences, region overlap. Keyless; verified
  // budget is 55,000 req/hour per IP — intervalMs 100 keeps a capacity-1
  // bucket well under it. Transient 500/503s are common upstream, hence the
  // retry entry. timeoutMs 30000: valid VEP calls have been observed taking
  // 6.6–20.7 s (on-demand computation), which the former 15 s cap aborted
  // mid-flight; attempts cut 3→2 in the same change so the worst-case retry
  // stack (2×30 s + backoff) stays near the old 3×15 s instead of tripling
  // to ~90 s. See src/entities/ensembl.ts for endpoints deliberately
  // excluded after repeated probe failures (/xrefs/*, /phenotype/*).
  ensembl: {
    sourceId: 'ensembl',
    baseUrl: 'https://rest.ensembl.org',
    protocol: 'rest',
    handling: { timeoutMs: 30000 },
    rateLimit: { intervalMs: 100 },
    retry: { attempts: 2, backoffMs: 200 },
    // #107: budget 70s so both 30s attempts + backoff fit, but never a third stack.
    retryBudgetMs: 70000,
    // #107: cap parallel queued fetches; the token bucket still sets the actual rate.
    concurrency: 4,
  },
  string: {
    sourceId: 'string',
    baseUrl: 'https://version-12-0.string-db.org/api',
    protocol: 'rest',
    handling: { timeoutMs: 15000 },
    rateLimit: { intervalMs: 100 },
  },
  // GEO SOFT viewer (acc.cgi): serves plain-text SOFT records for GEO
  // accessions (GSE/GSM/GPL). Separate from E-utilities (different host,
  // separate rate budget); may return HTML block pages to datacenter IPs,
  // which callers must sniff for.
  geo_soft: {
    sourceId: 'geo_soft',
    baseUrl: 'https://www.ncbi.nlm.nih.gov/geo/query',
    protocol: 'rest',
    handling: { timeoutMs: 15000 },
    rateLimit: { intervalMs: 300 },
  },

  // ==========================================
  // PROTEINS & PATHWAYS - REST (3 sources)
  // ==========================================
  uniprot: {
    sourceId: 'uniprot',
    baseUrl: 'https://rest.uniprot.org',
    protocol: 'rest',
    handling: { streaming: true, timeoutMs: 15000 },
    rateLimit: { intervalMs: 100 },
  },
  // #211: same measured origin latency as reactome_analysis below
  // (8–22 s live) — 25 s budget instead of the borderline 15 s. Deliberately
  // NO retry here: gene.ts fetchPathways threads an external abort signal
  // into conn.request, and withRetry does not observe external signals — a
  // client-cancelled request would keep retrying in the background.
  reactome: {
    sourceId: 'reactome',
    baseUrl: 'https://reactome.org/ContentService',
    protocol: 'rest',
    handling: { timeoutMs: 25000 },
    rateLimit: { intervalMs: 100 },
  },
  // Reactome AnalysisService is genuinely slow: measured 8–22 s per call
  // live (2026-10-24, #211), so the former 15 s timeout aborted
  // borderline-valid analysis POSTs mid-flight (gene_enrich failed 3/3,
  // stacked on the transport race #212 fixed). 25 s + one bounded retry.
  reactome_analysis: {
    sourceId: 'reactome_analysis',
    baseUrl: 'https://reactome.org/AnalysisService',
    protocol: 'rest',
    handling: { timeoutMs: 25000 },
    rateLimit: { intervalMs: 100 },
    retry: { attempts: 2, backoffMs: 1000 },
    // #211: budget 52s so both 25s attempts + 1s backoff fit (51s worst
    // case, with headroom), but never a third stack — staying under the
    // documented 60 s MCP client request cap.
    retryBudgetMs: 52000,
  },

  // ==========================================
  // DRUGS & PHARMACOLOGY - REST (2 sources)
  // ==========================================
  mychem: {
    sourceId: 'mychem',
    baseUrl: 'https://mychem.info/v1',
    protocol: 'rest',
    handling: { timeoutMs: 15000 },
    rateLimit: { intervalMs: 100 },
  },
  openfda: {
    sourceId: 'openfda',
    baseUrl: 'https://api.fda.gov',
    protocol: 'rest',
    handling: { timeoutMs: 15000 },
    auth: {
      envVar: 'OPENFDA_API_KEY',
      required: false,
      delivery: { type: 'query-param', name: 'api_key' },
    },
    rateLimit: { intervalMs: 100 },
  },

  // ==========================================
  // DISEASES - REST (2 sources)
  // ==========================================
  mydisease: {
    sourceId: 'mydisease',
    baseUrl: 'https://mydisease.info/v1',
    protocol: 'rest',
    handling: { timeoutMs: 15000 },
    rateLimit: { intervalMs: 100 },
  },
  monarch: {
    sourceId: 'monarch',
    baseUrl: 'https://api-v3.monarchinitiative.org',
    protocol: 'rest',
    handling: { timeoutMs: 15000 },
    rateLimit: { intervalMs: 100 },
  },

  // ==========================================
  // LITERATURE - REST (11 sources)
  // ==========================================
  // Shared NCBI E-utilities connection: serves PubMed (article_*), GEO
  // (db=gds), SRA (db=sra), GenBank (db=nuccore) and BioSample lookups.
  // Single entry on purpose: ConnectionManager caches one rate limiter per
  // sourceId, and NCBI enforces a shared 3 req/s budget per IP across ALL
  // E-utilities databases — a duplicate entry would double the effective
  // rate and risk an IP ban.
  eutils: {
    sourceId: 'eutils',
    baseUrl: 'https://eutils.ncbi.nlm.nih.gov/entrez/eutils',
    protocol: 'rest',
    handling: {
      timeoutMs: 15000,
      // NCBI asks E-utility clients to identify themselves (tool + email)
      // on every request; applied only when NCBI_EMAIL is configured.
      envQueryParams: [{ envVar: 'NCBI_EMAIL', params: { tool: 'biomcp-ts', email: '$NCBI_EMAIL' } }],
    },
    auth: {
      envVar: 'NCBI_API_KEY',
      required: false,
      delivery: { type: 'query-param', name: 'api_key' },
    },
    rateLimit: {
      intervalMs: 100,
      conditional: true,
      fallbackRateLimitMs: 334,
      keyedRateLimitMs: 100,
    },
    retry: { attempts: 4, backoffMs: 500 },
    // #107: budget 35s — 4 retryable 15s timeouts must not stack to ~63.5s.
    retryBudgetMs: 35000,
    // #107: cap parallel queued acquires; the token bucket still sets the actual rate.
    concurrency: 6,
  },
  pubtator: {
    sourceId: 'pubtator',
    baseUrl: 'https://www.ncbi.nlm.nih.gov/research/pubtator3-api',
    protocol: 'rest',
    handling: { timeoutMs: 15000 },
    auth: {
      envVar: 'NCBI_API_KEY',
      required: false,
      delivery: { type: 'query-param', name: 'api_key' },
    },
    rateLimit: {
      intervalMs: 100,
      conditional: true,
      fallbackRateLimitMs: 334,
      keyedRateLimitMs: 100,
    },
  },
  europepmc: {
    sourceId: 'europepmc',
    baseUrl: 'https://www.ebi.ac.uk/europepmc/webservices/rest',
    protocol: 'rest',
    handling: { timeoutMs: 15000 },
    rateLimit: { intervalMs: 100 },
    retry: { attempts: 3, backoffMs: 200 },
    // #107: budget 35s — retry-stacking source, cap at ~2× the 15s timeout.
    retryBudgetMs: 35000,
  },
  semantic_scholar: {
    sourceId: 'semantic_scholar',
    baseUrl: 'https://api.semanticscholar.org',
    protocol: 'rest',
    handling: { timeoutMs: 15000 },
    auth: {
      envVar: 'S2_API_KEY',
      required: false,
      delivery: { type: 'header', name: 'x-api-key' },
    },
    rateLimit: {
      intervalMs: 1000,
      conditional: true,
      fallbackRateLimitMs: 2000,
      keyedRateLimitMs: 1000,
    },
    // Compromise between the former per-call-site wrappers: search retried
    // once, citations up to 3 times (429-prone source).
    retry: { attempts: 3, backoffMs: 500 },
    // #107: budget 35s — retry-stacking source, cap at ~2× the 15s timeout.
    retryBudgetMs: 35000,
    // #107: parallel tool calls pile up behind the 1-slot citation queue; 3
    // in-flight fetches bound the wait without re-triggering the 429s.
    concurrency: 3,
  },
  litsense: {
    sourceId: 'litsense',
    baseUrl: 'https://www.ncbi.nlm.nih.gov/research/litsense2-api/api',
    protocol: 'rest',
    handling: { timeoutMs: 15000 },
    rateLimit: { intervalMs: 1000 },
  },
  ncbi_idconv: {
    sourceId: 'ncbi_idconv',
    baseUrl: 'https://pmc.ncbi.nlm.nih.gov/tools/idconv/api/v1/articles',
    protocol: 'rest',
    handling: { timeoutMs: 15000 },
    auth: {
      envVar: 'NCBI_API_KEY',
      required: false,
      delivery: { type: 'query-param', name: 'api_key' },
    },
    rateLimit: { intervalMs: 334 },
  },
  crossref: {
    sourceId: 'crossref',
    baseUrl: 'https://api.crossref.org',
    protocol: 'rest',
    handling: { timeoutMs: 15000 },
    // Polite pool (optional)
    auth: {
      envVar: 'CROSSREF_EMAIL',
      required: false,
      delivery: { type: 'query-param', name: 'mailto' },
    },
    rateLimit: { intervalMs: 100 },
    retry: { attempts: 3, backoffMs: 100 },
    // #107: budget 35s — retry-stacking source, cap at ~2× the 15s timeout.
    retryBudgetMs: 35000,
  },
  opencitations: {
    sourceId: 'opencitations',
    baseUrl: 'https://api.opencitations.net/index/v2',
    protocol: 'rest',
    handling: { timeoutMs: 15000 },
    // Fail loudly on unexpected redirects instead of silently following them.
    followRedirects: false,
    rateLimit: { intervalMs: 1000 },
  },
  // Official bioRxiv/medRxiv API (keyless). Serves preprint record fetching
  // (details/pubs, DOI-form); topical preprint search goes through Europe
  // PMC's PPR index instead (this API has no keyword-search endpoint).
  // All upstream errors are HTTP 200 with messages[0].status strings —
  // callers branch on the status, never the HTTP code. No published rate
  // limit, but the host is a small PHP service with highly variable
  // latency (observed 1.2–12.8 s per DOI-form call): 1 req/s politeness
  // (measured safe at 2 rps), generous timeout, one retry.
  biorxiv: {
    sourceId: 'biorxiv',
    baseUrl: 'https://api.biorxiv.org',
    protocol: 'rest',
    handling: { timeoutMs: 15000 },
    rateLimit: { intervalMs: 1000 },
    retry: { attempts: 2, backoffMs: 1000 },
    // #107: budget 35s — 15s timeout × 2 attempts + backoff must not stack past it.
    retryBudgetMs: 35000,
  },
  // arXiv Atom Query API (https://export.arxiv.org/api/query): preprint
  // literature search. Terms of Use (https://info.arxiv.org/help/api/tou.html)
  // cap clients at 1 request / 3 s on a single connection, aggregated across
  // all machines under the operator's control — intervalMs 3000 enforces the
  // spacing client-side per process (arXiv offers no API keys; a 403 is a
  // per-IP block). Legacy API: stable ~15 yrs, watch arXiv API news for
  // breaking changes.
  arxiv: {
    sourceId: 'arxiv',
    baseUrl: 'https://export.arxiv.org/api',
    protocol: 'rest',
    // arXiv always answers Atom XML — declare contentType so the Accept
    // header stops claiming application/json. timeoutMs
    // 10000: worst case = 3 s limiter spacing + 2×10 s timeouts + 3.5 s
    // retry backoff ≈ 26.5 s < the 30 s article_search tool cap, so an
    // arXiv outage surfaces as a friendly _error row instead of a tool
    // timeout.
    handling: { contentType: 'xml', timeoutMs: 10000 },
    rateLimit: { intervalMs: 3000 },
    retry: { attempts: 2, backoffMs: 3500 },
    // #107: budget 35s — safety net above the ~26.5s worst case so the
    // article_search tool cap still wins.
    retryBudgetMs: 35000,
  },
  // OpenAlex scholarly sources API (https://api.openalex.org): institutions
  // and journals for journal_metrics lookups. Keyless use shares a global
  // $0.10/day budget; a free api_key (openalex.org, Settings → API) raises
  // it to $1/day.
  openalex: {
    sourceId: 'openalex',
    baseUrl: 'https://api.openalex.org',
    protocol: 'rest',
    handling: { timeoutMs: 15000 },
    auth: {
      envVar: 'OPENALEX_API_KEY',
      required: false,
      delivery: { type: 'query-param', name: 'api_key' },
    },
    rateLimit: {
      intervalMs: 1000,
      conditional: true,
      fallbackRateLimitMs: 1000,
      keyedRateLimitMs: 200,
    },
    retry: { attempts: 3, backoffMs: 500 },
    // #107: budget 35s — retry-stacking source, cap at ~2× the 15s timeout.
    retryBudgetMs: 35000,
  },
  // ==========================================
  // CLINICAL TRIALS - REST (1 source)
  // ==========================================
  clinicaltrials: {
    sourceId: 'clinicaltrials',
    baseUrl: 'https://clinicaltrials.gov/api/v2',
    protocol: 'rest',
    handling: { timeoutMs: 15000 },
    rateLimit: { intervalMs: 100 },
    // Same rationale as myvariant above: variant_trials chains up to two
    // searches here behind a resolution step; transient blips must not
    // surface as a silent empty result (#198).
    retry: { attempts: 2, backoffMs: 500 },
    // #107: budget 35s — one full 15s attempt + backoff always fits, two
    // stacked 15s timeouts do not.
    retryBudgetMs: 35000,
  },

  // ==========================================
  // ONTOLOGIES & ANALYSIS - REST (1 source)
  // ==========================================
  ols4: {
    sourceId: 'ols4',
    baseUrl: 'https://www.ebi.ac.uk/ols4',
    protocol: 'rest',
    handling: { timeoutMs: 15000 },
    rateLimit: { intervalMs: 100 },
  },

  // ==========================================
  // FUNDING & RESEARCH - REST (1 source)
  // ==========================================
  // NIH Reporter project search routinely takes 5-10 s (issue #195); the
  // gene_get funding section sizes its deadline from this budget.
  nih_reporter: {
    sourceId: 'nih_reporter',
    baseUrl: 'https://api.reporter.nih.gov/v2',
    protocol: 'rest',
    handling: { timeoutMs: 20000 },
    rateLimit: { intervalMs: 1000 },
  },
  
  // ==========================================
  // ONCOLOGY - REST (1 source)
  // ==========================================
  oncokb: {
    sourceId: 'oncokb',
    baseUrl: 'https://www.oncokb.org/api/v1',
    protocol: 'rest',
    handling: { timeoutMs: 15000 },
    auth: {
      envVar: 'ONCOKB_TOKEN',
      required: false,
      delivery: { type: 'bearer' },
    },
    rateLimit: { intervalMs: 100 },
  },
  
  // ==========================================
  // REQUIRED KEYS - REST (1 source)
  // ==========================================
  disgenet: {
    sourceId: 'disgenet',
    baseUrl: 'https://api.disgenet.com/api/v1',
    protocol: 'rest',
    handling: { timeoutMs: 15000 },
    auth: {
      envVar: 'DISGENET_API_KEY',
      required: true,
      delivery: { type: 'authorization' },
    },
    rateLimit: { intervalMs: 100 },
  },
  
  // ==========================================
  // STRUCTURAL BIOLOGY - REST (3 sources)
  // ==========================================
  pdb_data: {
    sourceId: 'pdb_data',
    baseUrl: 'https://data.rcsb.org/rest/v1',
    protocol: 'rest',
    handling: { timeoutMs: 15000 },
    rateLimit: { intervalMs: 100 },
  },
  pdb_search: {
    sourceId: 'pdb_search',
    baseUrl: 'https://search.rcsb.org/rcsbsearch/v2',
    protocol: 'rest',
    handling: { timeoutMs: 15000 },
    rateLimit: { intervalMs: 200 },
  },
  pdb_files: {
    sourceId: 'pdb_files',
    baseUrl: 'https://files.rcsb.org',
    protocol: 'rest',
    handling: { contentType: 'text', timeoutMs: 15000 },
    rateLimit: { intervalMs: 200 },
  },

  // ==========================================
  // PATENTS - REST (2 sources)
  // Note: EPO OPS (OAuth2) and USPTO PPUBS (session token) are managed
  // inside src/entities/patent/ — they do not fit static connection auth.
  // ==========================================
  google_patents: {
    sourceId: 'google_patents',
    baseUrl: 'https://patents.google.com',
    protocol: 'rest',
    handling: {
      timeoutMs: 30000,
      headers: {
        'User-Agent': 'Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/126.0.0.0 Safari/537.36',
      },
    },
    rateLimit: { intervalMs: 2000 },
  },
  uspto_odp: {
    sourceId: 'uspto_odp',
    baseUrl: 'https://api.uspto.gov',
    protocol: 'rest',
    handling: { timeoutMs: 15000 },
    auth: {
      envVar: 'USPTO_API_KEY',
      required: false,
      delivery: { type: 'header', name: 'X-API-KEY' },
    },
    rateLimit: { intervalMs: 1000 },
  },

  // ==========================================
  // GRAPHQL (4 sources)
  // ==========================================
  gnomad: {
    sourceId: 'gnomad',
    baseUrl: 'https://gnomad.broadinstitute.org/api',
    protocol: 'graphql',
    handling: { timeoutMs: 15000 },
    rateLimit: { intervalMs: 100 },
  },
  civic: {
    sourceId: 'civic',
    baseUrl: 'https://civicdb.org/api/graphql',
    protocol: 'graphql',
    handling: { timeoutMs: 15000 },
    rateLimit: { intervalMs: 334 },
  },
  dgidb: {
    sourceId: 'dgidb',
    baseUrl: 'https://dgidb.org/api/graphql',
    protocol: 'graphql',
    handling: { timeoutMs: 15000 },
    rateLimit: { intervalMs: 100 },
  },
  opentargets: {
    sourceId: 'opentargets',
    baseUrl: 'https://api.platform.opentargets.org/api/v4/graphql',
    protocol: 'graphql',
    // Issue #195: gene_get diseases/druggability sections run sequential
    // roundtrips here; 20 s budgets them. Requires outbound HTTPS
    // reachability — proxy environments must route
    // api.platform.opentargets.org.
    handling: { timeoutMs: 20000 },
    rateLimit: { intervalMs: 500 },
  },
};

export function getSourceConfig(sourceId: string): ConnectionOptions {
  const config = SOURCE_REGISTRY[sourceId];
  if (!config) {
    throw new Error(`Unknown source: ${sourceId}`);
  }
  return config;
}

export function getSourcesByProtocol(protocol: string): ConnectionOptions[] {
  return Object.values(SOURCE_REGISTRY).filter(s => s.protocol === protocol);
}

export function getSourcesRequiringAuth(): ConnectionOptions[] {
  return Object.values(SOURCE_REGISTRY).filter(s => s.auth?.required);
}

export function getSourcesWithOptionalAuth(): ConnectionOptions[] {
  return Object.values(SOURCE_REGISTRY).filter(s => s.auth && !s.auth.required);
}