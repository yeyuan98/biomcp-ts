import { ConnectionOptions } from './base.js';

export const SOURCE_REGISTRY: Record<string, ConnectionOptions> = {
  // ==========================================
  // GENOMICS - REST (14 sources)
  // ==========================================
  mygene: {
    sourceId: 'mygene',
    baseUrl: 'https://mygene.info/v3',
    protocol: 'rest',
    rateLimit: { intervalMs: 100 },
  },
  myvariant: {
    sourceId: 'myvariant',
    baseUrl: 'https://myvariant.info/v1',
    protocol: 'rest',
    rateLimit: { intervalMs: 100 },
  },
  clingen: {
    sourceId: 'clingen',
    baseUrl: 'https://search.clinicalgenome.org',
    protocol: 'rest',
    rateLimit: { intervalMs: 100 },
  },
  gtex: {
    sourceId: 'gtex',
    baseUrl: 'https://gtexportal.org',
    protocol: 'rest',
    rateLimit: { intervalMs: 100 },
  },
  hpa: {
    sourceId: 'hpa',
    baseUrl: 'https://www.proteinatlas.org',
    protocol: 'rest',
    handling: { contentType: 'xml' },
    rateLimit: { intervalMs: 100 },
  },
  gwas: {
    sourceId: 'gwas',
    baseUrl: 'https://www.ebi.ac.uk/gwas/rest/api',
    protocol: 'rest',
    rateLimit: { intervalMs: 100 },
  },
  string: {
    sourceId: 'string',
    baseUrl: 'https://version-12-0.string-db.org/api',
    protocol: 'rest',
    rateLimit: { intervalMs: 100 },
  },
  
  // ==========================================
  // PROTEINS & PATHWAYS - REST (6 sources)
  // ==========================================
  uniprot: {
    sourceId: 'uniprot',
    baseUrl: 'https://rest.uniprot.org',
    protocol: 'rest',
    handling: { streaming: true },
    rateLimit: { intervalMs: 100 },
  },
  interpro: {
    sourceId: 'interpro',
    baseUrl: 'https://www.ebi.ac.uk/interpro/api',
    protocol: 'rest',
    rateLimit: { intervalMs: 100 },
  },
  complexportal: {
    sourceId: 'complexportal',
    baseUrl: 'https://www.ebi.ac.uk/intact/complex-ws',
    protocol: 'rest',
    rateLimit: { intervalMs: 100 },
  },
  reactome: {
    sourceId: 'reactome',
    baseUrl: 'https://reactome.org/ContentService',
    protocol: 'rest',
    rateLimit: { intervalMs: 100 },
  },
  reactome_analysis: {
    sourceId: 'reactome_analysis',
    baseUrl: 'https://reactome.org/AnalysisService',
    protocol: 'rest',
    rateLimit: { intervalMs: 100 },
  },
  kegg: {
    sourceId: 'kegg',
    baseUrl: 'https://rest.kegg.jp',
    protocol: 'rest',
    handling: { contentType: 'text' },
    rateLimit: { intervalMs: 334 },
  },
  wikipathways: {
    sourceId: 'wikipathways',
    baseUrl: 'https://www.wikipathways.org/json',
    protocol: 'rest',
    rateLimit: { intervalMs: 100 },
  },
  
  // ==========================================
  // DRUGS & PHARMACOLOGY - REST (7 sources)
  // ==========================================
  mychem: {
    sourceId: 'mychem',
    baseUrl: 'https://mychem.info/v1',
    protocol: 'rest',
    rateLimit: { intervalMs: 100 },
  },
  chembl: {
    sourceId: 'chembl',
    baseUrl: 'https://www.ebi.ac.uk/chembl/api/data',
    protocol: 'rest',
    rateLimit: { intervalMs: 100 },
  },
  openfda: {
    sourceId: 'openfda',
    baseUrl: 'https://api.fda.gov',
    protocol: 'rest',
    auth: {
      envVar: 'OPENFDA_API_KEY',
      required: false,
      delivery: { type: 'query-param', name: 'api_key' },
    },
    rateLimit: { intervalMs: 100 },
  },
  cpic: {
    sourceId: 'cpic',
    baseUrl: 'https://api.cpicpgx.org/v1',
    protocol: 'rest',
    rateLimit: { intervalMs: 250 },
  },
  pharmgkb: {
    sourceId: 'pharmgkb',
    baseUrl: 'https://api.pharmgkb.org/v1',
    protocol: 'rest',
    rateLimit: { intervalMs: 500 },
  },
  ema: {
    sourceId: 'ema',
    baseUrl: 'https://www.ema.europa.eu/en/documents/report',
    protocol: 'local-file',
    handling: { staleHours: 72 },
    rateLimit: { intervalMs: 0 },
  },
  who_pq: {
    sourceId: 'who_pq',
    baseUrl: 'https://extranet.who.int/prequal/medicines/prequalified/',
    protocol: 'local-file',
    handling: { staleHours: 72 },
    rateLimit: { intervalMs: 0 },
  },
  
  // ==========================================
  // DISEASES - REST (5 sources)
  // ==========================================
  mydisease: {
    sourceId: 'mydisease',
    baseUrl: 'https://mydisease.info/v1',
    protocol: 'rest',
    rateLimit: { intervalMs: 100 },
  },
  monarch: {
    sourceId: 'monarch',
    baseUrl: 'https://api-v3.monarchinitiative.org',
    protocol: 'rest',
    rateLimit: { intervalMs: 100 },
  },
  seer: {
    sourceId: 'seer',
    baseUrl: 'https://seer.cancer.gov/statistics-network/explorer/source/content_writers',
    protocol: 'rest',
    rateLimit: { intervalMs: 100 },
  },
  medlineplus: {
    sourceId: 'medlineplus',
    baseUrl: 'https://wsearch.nlm.nih.gov',
    protocol: 'rest',
    handling: { contentType: 'xml' },
    rateLimit: { intervalMs: 100 },
  },
  hpo: {
    sourceId: 'hpo',
    baseUrl: 'https://ontology.jax.org/api/hp',
    protocol: 'rest',
    rateLimit: { intervalMs: 100 },
  },
  
  // ==========================================
  // LITERATURE - REST (8 sources)
  // ==========================================
  pubmed: {
    sourceId: 'pubmed',
    baseUrl: 'https://eutils.ncbi.nlm.nih.gov/entrez/eutils',
    protocol: 'rest',
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
  pubtator: {
    sourceId: 'pubtator',
    baseUrl: 'https://www.ncbi.nlm.nih.gov/research/pubtator3-api',
    protocol: 'rest',
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
    rateLimit: { intervalMs: 100 },
  },
  semantic_scholar: {
    sourceId: 'semantic_scholar',
    baseUrl: 'https://api.semanticscholar.org',
    protocol: 'rest',
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
  },
  litsense: {
    sourceId: 'litsense',
    baseUrl: 'https://www.ncbi.nlm.nih.gov/research/litsense2-api/api',
    protocol: 'rest',
    rateLimit: { intervalMs: 1000 },
  },
  ncbi_idconv: {
    sourceId: 'ncbi_idconv',
    baseUrl: 'https://pmc.ncbi.nlm.nih.gov/tools/idconv/api/v1/articles',
    protocol: 'rest',
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
    handling: { contentType: 'xml' },
    auth: {
      envVar: 'NCBI_API_KEY',
      required: false,
      delivery: { type: 'query-param', name: 'api_key' },
    },
    rateLimit: { intervalMs: 334 },
  },
  
  // ==========================================
  // CLINICAL TRIALS - REST (2 sources)
  // ==========================================
  clinicaltrials: {
    sourceId: 'clinicaltrials',
    baseUrl: 'https://clinicaltrials.gov/api/v2',
    protocol: 'rest',
    rateLimit: { intervalMs: 100 },
  },
  nci_cts: {
    sourceId: 'nci_cts',
    baseUrl: 'https://clinicaltrialsapi.cancer.gov/api/v2',
    protocol: 'rest',
    auth: {
      envVar: 'NCI_API_KEY',
      required: false,
      delivery: { type: 'header', name: 'X-API-KEY' },
    },
    rateLimit: { intervalMs: 100 },
  },
  
  // ==========================================
  // DIAGNOSTICS & REGISTRIES - REST + Local
  // ==========================================
  vaers: {
    sourceId: 'vaers',
    baseUrl: 'https://wonder.cdc.gov',
    protocol: 'rest',
    rateLimit: { intervalMs: 100 },
  },
  gtr: {
    sourceId: 'gtr',
    baseUrl: 'https://ftp.ncbi.nlm.nih.gov/pub/GTR/data/',
    protocol: 'local-file',
    handling: { staleHours: 168 },
    rateLimit: { intervalMs: 0 },
  },
  who_ivd: {
    sourceId: 'who_ivd',
    baseUrl: 'https://extranet.who.int/prequal/vitro-diagnostics/prequalified/in-vitro-diagnostics/export',
    protocol: 'local-file',
    handling: { staleHours: 72 },
    rateLimit: { intervalMs: 0 },
  },
  cvx: {
    sourceId: 'cvx',
    baseUrl: 'https://www2.cdc.gov/vaccines/iis/iisstandards/downloads/',
    protocol: 'local-file',
    handling: { staleHours: 720 },
    rateLimit: { intervalMs: 0 },
  },
  
  // ==========================================
  // ENRICHMENT & ANALYSIS - REST (4 sources)
  // ==========================================
  enrichr: {
    sourceId: 'enrichr',
    baseUrl: 'https://maayanlab.cloud/Enrichr',
    protocol: 'rest',
    rateLimit: { intervalMs: 100 },
  },
  gprofiler: {
    sourceId: 'gprofiler',
    baseUrl: 'https://biit.cs.ut.ee/gprofiler/api',
    protocol: 'rest',
    handling: { timeoutMs: 15000 },
    rateLimit: { intervalMs: 0 },
  },
  ols4: {
    sourceId: 'ols4',
    baseUrl: 'https://www.ebi.ac.uk/ols4',
    protocol: 'rest',
    rateLimit: { intervalMs: 100 },
  },
  quickgo: {
    sourceId: 'quickgo',
    baseUrl: 'https://www.ebi.ac.uk/QuickGO/services',
    protocol: 'rest',
    rateLimit: { intervalMs: 100 },
  },
  
  // ==========================================
  // FUNDING & RESEARCH - REST (1 source)
  // ==========================================
  nih_reporter: {
    sourceId: 'nih_reporter',
    baseUrl: 'https://api.reporter.nih.gov/v2',
    protocol: 'rest',
    rateLimit: { intervalMs: 1000 },
  },
  
  // ==========================================
  // CBIO PORTAL - REST (2 sources)
  // ==========================================
  cbioportal: {
    sourceId: 'cbioportal',
    baseUrl: 'https://www.cbioportal.org/api',
    protocol: 'rest',
    rateLimit: { intervalMs: 100 },
  },
  cbioportal_datahub: {
    sourceId: 'cbioportal_datahub',
    baseUrl: 'https://datahub.assets.cbioportal.org',
    protocol: 'rest',
    rateLimit: { intervalMs: 0 },
  },
  
  // ==========================================
  // ONCOLOGY - REST (1 source)
  // ==========================================
  oncokb: {
    sourceId: 'oncokb',
    baseUrl: 'https://www.oncokb.org/api/v1',
    protocol: 'rest',
    auth: {
      envVar: 'ONCOKB_TOKEN',
      required: false,
      delivery: { type: 'bearer' },
    },
    rateLimit: { intervalMs: 100 },
  },
  
  // ==========================================
  // REQUIRED KEYS - REST (2 sources)
  // ==========================================
  disgenet: {
    sourceId: 'disgenet',
    baseUrl: 'https://api.disgenet.com',
    protocol: 'rest',
    auth: {
      envVar: 'DISGENET_API_KEY',
      required: true,
      delivery: { type: 'authorization' },
    },
    rateLimit: { intervalMs: 100 },
  },
  umls: {
    sourceId: 'umls',
    baseUrl: 'https://uts-ws.nlm.nih.gov',
    protocol: 'rest',
    auth: {
      envVar: 'UMLS_API_KEY',
      required: true,
      delivery: { type: 'query-param', name: 'apiKey' },
    },
    rateLimit: { intervalMs: 100 },
  },
  
  // ==========================================
  // GRAPHQL (5 sources)
  // ==========================================
  gnomad: {
    sourceId: 'gnomad',
    baseUrl: 'https://gnomad.broadinstitute.org/api',
    protocol: 'graphql',
    rateLimit: { intervalMs: 100 },
  },
  civic: {
    sourceId: 'civic',
    baseUrl: 'https://civicdb.org/api',
    protocol: 'graphql',
    rateLimit: { intervalMs: 334 },
  },
  dgidb: {
    sourceId: 'dgidb',
    baseUrl: 'https://dgidb.org/api',
    protocol: 'graphql',
    rateLimit: { intervalMs: 100 },
  },
  opentargets: {
    sourceId: 'opentargets',
    baseUrl: 'https://api.platform.opentargets.org/api/v4/graphql',
    protocol: 'graphql',
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