import { ConnectionOptions } from './base.js';

export const SOURCE_REGISTRY: Record<string, ConnectionOptions> = {
  // ==========================================
  // GENOMICS - REST (4 sources)
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
  },
  gtex: {
    sourceId: 'gtex',
    baseUrl: 'https://gtexportal.org',
    protocol: 'rest',
    handling: { timeoutMs: 15000 },
    rateLimit: { intervalMs: 100 },
  },
  string: {
    sourceId: 'string',
    baseUrl: 'https://version-12-0.string-db.org/api',
    protocol: 'rest',
    handling: { timeoutMs: 15000 },
    rateLimit: { intervalMs: 100 },
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
  reactome: {
    sourceId: 'reactome',
    baseUrl: 'https://reactome.org/ContentService',
    protocol: 'rest',
    handling: { timeoutMs: 15000 },
    rateLimit: { intervalMs: 100 },
  },
  reactome_analysis: {
    sourceId: 'reactome_analysis',
    baseUrl: 'https://reactome.org/AnalysisService',
    protocol: 'rest',
    handling: { timeoutMs: 15000 },
    rateLimit: { intervalMs: 100 },
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
  // DISEASES - REST (3 sources)
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
  seer: {
    sourceId: 'seer',
    baseUrl: 'https://seer.cancer.gov/statistics-network/explorer/source/content_writers',
    protocol: 'rest',
    handling: { timeoutMs: 15000 },
    rateLimit: { intervalMs: 100 },
  },
  
  // ==========================================
  // LITERATURE - REST (8 sources)
  // ==========================================
  pubmed: {
    sourceId: 'pubmed',
    baseUrl: 'https://eutils.ncbi.nlm.nih.gov/entrez/eutils',
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
    retry: { attempts: 4, backoffMs: 500 },
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
  pmc_oa: {
    sourceId: 'pmc_oa',
    baseUrl: 'https://www.ncbi.nlm.nih.gov/pmc/utils/oa/oa.fcgi',
    protocol: 'rest',
    handling: { contentType: 'xml', timeoutMs: 15000 },
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
    rateLimit: { intervalMs: 100 },
    retry: { attempts: 3, backoffMs: 100 },
  },
  opencitations: {
    sourceId: 'opencitations',
    baseUrl: 'https://opencitations.net/index/api',
    protocol: 'rest',
    handling: { timeoutMs: 15000 },
    // v1 endpoints 301 to a dead host — fail loudly instead of returning
    // empty until the v2 migration lands.
    followRedirects: false,
    rateLimit: { intervalMs: 1000 },
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
  nih_reporter: {
    sourceId: 'nih_reporter',
    baseUrl: 'https://api.reporter.nih.gov/v2',
    protocol: 'rest',
    handling: { timeoutMs: 15000 },
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
    baseUrl: 'https://api.disgenet.com',
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
  // GRAPHQL (5 sources)
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
    handling: { timeoutMs: 15000 },
    rateLimit: { intervalMs: 500 },
  },
  
  // ==========================================
  // GRPC (1 source)
  // ==========================================
  alphagenome: {
    sourceId: 'alphagenome',
    baseUrl: 'gdmscience.googleapis.com:443',
    protocol: 'grpc',
    auth: {
      envVar: 'ALPHAGENOME_API_KEY',
      required: true,
      delivery: { type: 'grpc-metadata', name: 'x-goog-api-key' },
    },
    rateLimit: { intervalMs: 0 },
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