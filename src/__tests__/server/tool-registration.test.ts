import { jest, describe, it, expect, beforeEach } from '@jest/globals';
import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';

// Loud module mock: proxies the factory spec so any access to an export the
// factory did not define throws immediately (instead of silently yielding
// undefined, which armed traps like z.enum(undefined) in the past).
// Interop probes jest may perform are passed through.
function mockLoudModule(moduleName: string, spec: Record<string, unknown>) {
  return new Proxy(spec, {
    get(target, prop, receiver) {
      if (typeof prop === 'symbol') return Reflect.get(target, prop, receiver);
      if (Object.prototype.hasOwnProperty.call(target, prop)) return Reflect.get(target, prop, receiver);
      if (prop === '__esModule' || prop === 'default' || prop === 'then') return undefined;
      throw new Error(
        `[tool-registration.test] entity mock for '${moduleName}' was accessed on unknown export '${String(prop)}'. ` +
        `If the source module now exports it, add it to the jest.mock factory for '${moduleName}'.`
      );
    },
  });
}

const mockRegisterTool = jest.fn();
const mockServer = { registerTool: mockRegisterTool } as unknown as McpServer;

jest.mock('@modelcontextprotocol/sdk/server/mcp.js', () => ({
  McpServer: jest.fn(),
}));

jest.mock('../../entities/gene.js', () => mockLoudModule('entities/gene', {
  geneSearch: jest.fn(),
  geneGet: jest.fn(),
  GeneSearchResult: undefined,
  GeneResult: undefined,
}));

jest.mock('../../entities/drug.js', () => mockLoudModule('entities/drug', {
  drugSearch: jest.fn(),
  drugGet: jest.fn(),
  // Mirrors DRUG_ENTITY_ALL_SECTIONS from src/entities/drug.ts (schema constant).
  DRUG_ENTITY_ALL_SECTIONS: [
    'us_regulatory', 'eu_regulatory', 'who_regulatory', 'safety', 'targets', 'indications', 'adverse_events',
  ],
  DrugSearchResult: undefined,
  DrugResult: undefined,
}));

jest.mock('../../entities/variant.js', () => mockLoudModule('entities/variant', {
  variantSearch: jest.fn(),
  variantGet: jest.fn(),
  fetchOncoKbAnnotation: jest.fn(),
  getVariantSearchFilters: jest.fn().mockReturnValue(['consequence', 'significance']),
  VariantSearchResult: undefined,
  VariantResult: undefined,
}));

jest.mock('../../entities/disease.js', () => mockLoudModule('entities/disease', {
  diseaseSearch: jest.fn(),
  diseaseGet: jest.fn(),
  DiseaseSearchResult: undefined,
  DiseaseResult: undefined,
}));

jest.mock('../../entities/trial.js', () => mockLoudModule('entities/trial', {
  trialSearch: jest.fn(),
  trialGet: jest.fn(),
  TrialSearchResult: undefined,
  TrialResult: undefined,
}));

jest.mock('../../entities/article/index.js', () => mockLoudModule('entities/article', {
  articleSearch: jest.fn(),
  articleGet: jest.fn(),
  Article: undefined,
}));

jest.mock('../../entities/patent/index.js', () => mockLoudModule('entities/patent', {
  patentSearch: jest.fn(),
  patentGet: jest.fn(),
  // Mirrors PATENT_GET_SECTIONS from src/entities/patent/detail/index.ts (schema constant).
  PATENT_GET_SECTIONS: ['core', 'abstract', 'claims', 'citations', 'family', 'classifications', 'all'],
  // Mirrors PATENT_SEARCH_TOOL_BUDGET_MS from src/entities/patent/search/index.ts.
  PATENT_SEARCH_TOOL_BUDGET_MS: 60_000,
  PatentSearchResult: undefined,
  PatentResult: undefined,
}));

jest.mock('../../entities/geo.js', () => mockLoudModule('entities/geo', {
  geoSearch: jest.fn(),
  geoGet: jest.fn(),
  geoToSraAccessions: jest.fn(),
}));

jest.mock('../../entities/sra/index.js', () => mockLoudModule('entities/sra', {
  sraSearch: jest.fn(),
  sraGet: jest.fn(),
}));

jest.mock('../../entities/genbank.js', () => mockLoudModule('entities/genbank', {
  genbankSearch: jest.fn(),
  genbankGet: jest.fn(),
  genbankToGeneIds: jest.fn(),
}));

jest.mock('../../entities/gtex.js', () => mockLoudModule('entities/gtex', {
  gtexMedianExpression: jest.fn(),
  gtexEqtl: jest.fn(),
  getGtexTissues: jest.fn(),
}));

jest.mock('../../entities/ensembl.js', () => mockLoudModule('entities/ensembl', {
  ensemblLookup: jest.fn(),
  ensemblHomology: jest.fn(),
  ensemblConsequence: jest.fn(),
  ensemblRegion: jest.fn(),
}));

jest.mock('../../entities/cross-entity.js', () => mockLoudModule('entities/cross-entity', {
  geneToDrugs: jest.fn(),
  geneToTrials: jest.fn(),
  geneToPathways: jest.fn(),
  geneToArticles: jest.fn(),
  variantToTrials: jest.fn(),
  drugToGenes: jest.fn(),
  drugToTrials: jest.fn(),
  drugToAdverseEvents: jest.fn(),
  diseaseToDrugs: jest.fn(),
  diseaseToGenes: jest.fn(),
  diseaseToTrials: jest.fn(),
  geneEnrichment: jest.fn(),
  discover: jest.fn(),
  searchAll: jest.fn(),
  batchGet: jest.fn(),
}));

jest.mock('../../connections/manager.js', () => mockLoudModule('connections/manager', {
  connectionManager: {
    getConnection: jest.fn().mockReturnValue({
      request: jest.fn(),
      post: jest.fn(),
      healthCheck: jest.fn().mockResolvedValue(true),
    }),
  },
}));

jest.mock('../../connections/fetch-utils.js', () => mockLoudModule('connections/fetch-utils', {
  fetchWithTimeout: jest.fn(),
}));

jest.mock('../../transform/gene.js', () => mockLoudModule('transform/gene', {
  transformMyGeneHit: jest.fn(),
}));

jest.mock('../../transform/pdb.js', () => mockLoudModule('transform/pdb', {
  transformPdbEntry: jest.fn(),
}));

import { registerGeneTools } from '../../server/tools/gene.js';
import { registerDrugTools } from '../../server/tools/drug.js';
import { registerVariantTools } from '../../server/tools/variant.js';
import { registerDiseaseTools } from '../../server/tools/disease.js';
import { registerTrialTools } from '../../server/tools/trial.js';
import { registerArticleTools } from '../../server/tools/article.js';
import { registerUtilityTools } from '../../server/tools/utility.js';
import { registerPdbTools } from '../../server/tools/pdb.js';
import { registerPatentTools } from '../../server/tools/patent.js';
import { registerGeoTools } from '../../server/tools/geo.js';
import { registerSraTools } from '../../server/tools/sra.js';
import { registerGenbankTools } from '../../server/tools/genbank.js';
import { registerGtexTools } from '../../server/tools/gtex.js';
import { registerEnsemblTools } from '../../server/tools/ensembl.js';
import { registerConfigureTool } from '../../server/tools/configure.js';

beforeEach(() => {
  mockRegisterTool.mockClear();
});

describe('Tool registration', () => {
  it('registerGeneTools calls registerTool 7 times', () => {
    registerGeneTools(mockServer);
    expect(mockRegisterTool).toHaveBeenCalledTimes(7);
  });

  it('registerDrugTools calls registerTool 3 times', () => {
    registerDrugTools(mockServer);
    expect(mockRegisterTool).toHaveBeenCalledTimes(3);
  });

  it('registerVariantTools calls registerTool 4 times', () => {
    registerVariantTools(mockServer);
    expect(mockRegisterTool).toHaveBeenCalledTimes(4);
  });

  it('registerDiseaseTools calls registerTool 4 times', () => {
    registerDiseaseTools(mockServer);
    expect(mockRegisterTool).toHaveBeenCalledTimes(4);
  });

  it('registerTrialTools calls registerTool 2 times', () => {
    registerTrialTools(mockServer);
    expect(mockRegisterTool).toHaveBeenCalledTimes(2);
  });

  it('registerArticleTools calls registerTool 2 times', () => {
    registerArticleTools(mockServer);
    expect(mockRegisterTool).toHaveBeenCalledTimes(2);
  });

  it('registerUtilityTools calls registerTool 2 times', () => {
    registerUtilityTools(mockServer);
    expect(mockRegisterTool).toHaveBeenCalledTimes(2);
  });

  it('registerPdbTools calls registerTool 1 time', () => {
    registerPdbTools(mockServer);
    expect(mockRegisterTool).toHaveBeenCalledTimes(1);
  });

  it('registerGeoTools calls registerTool 2 times', () => {
    registerGeoTools(mockServer);
    expect(mockRegisterTool).toHaveBeenCalledTimes(2);
  });

  it('registerSraTools calls registerTool 2 times', () => {
    registerSraTools(mockServer);
    expect(mockRegisterTool).toHaveBeenCalledTimes(2);
  });

  it('registerGenbankTools calls registerTool 3 times', () => {
    registerGenbankTools(mockServer);
    expect(mockRegisterTool).toHaveBeenCalledTimes(3);
  });

  it('registerGtexTools calls registerTool 2 times', () => {
    registerGtexTools(mockServer);
    expect(mockRegisterTool).toHaveBeenCalledTimes(2);
  });

  it('registerEnsemblTools calls registerTool 4 times', () => {
    registerEnsemblTools(mockServer);
    expect(mockRegisterTool).toHaveBeenCalledTimes(4);
  });

  it('registerConfigureTool calls registerTool 1 time', () => {
    registerConfigureTool(mockServer);
    expect(mockRegisterTool).toHaveBeenCalledTimes(1);
    expect(mockRegisterTool.mock.calls[0][0]).toBe('biomcp_configure');
  });

  it('total registerTool calls across all registrations = 41', () => {
    registerGeneTools(mockServer);
    registerDrugTools(mockServer);
    registerVariantTools(mockServer);
    registerDiseaseTools(mockServer);
    registerTrialTools(mockServer);
    registerArticleTools(mockServer);
    registerUtilityTools(mockServer);
    registerPdbTools(mockServer);
    registerPatentTools(mockServer);
    registerGeoTools(mockServer);
    registerSraTools(mockServer);
    registerGenbankTools(mockServer);
    registerGtexTools(mockServer);
    registerEnsemblTools(mockServer);
    registerConfigureTool(mockServer);
    expect(mockRegisterTool).toHaveBeenCalledTimes(41);
  });

  it('no duplicate tool names across all registrations', () => {
    registerGeneTools(mockServer);
    registerDrugTools(mockServer);
    registerVariantTools(mockServer);
    registerDiseaseTools(mockServer);
    registerTrialTools(mockServer);
    registerArticleTools(mockServer);
    registerUtilityTools(mockServer);
    registerPdbTools(mockServer);
    registerPatentTools(mockServer);
    registerGeoTools(mockServer);
    registerSraTools(mockServer);
    registerGenbankTools(mockServer);
    registerGtexTools(mockServer);
    registerEnsemblTools(mockServer);
    registerConfigureTool(mockServer);

    const names = mockRegisterTool.mock.calls.map((call: any[]) => call[0]);
    const uniqueNames = new Set(names);
    expect(uniqueNames.size).toBe(names.length);
  });

  it('registered tool names match expected list', () => {
    registerGeneTools(mockServer);
    registerDrugTools(mockServer);
    registerVariantTools(mockServer);
    registerDiseaseTools(mockServer);
    registerTrialTools(mockServer);
    registerArticleTools(mockServer);
    registerUtilityTools(mockServer);
    registerPdbTools(mockServer);
    registerPatentTools(mockServer);
    registerGeoTools(mockServer);
    registerSraTools(mockServer);
    registerGenbankTools(mockServer);
    registerGtexTools(mockServer);
    registerEnsemblTools(mockServer);
    registerConfigureTool(mockServer);

    const names = mockRegisterTool.mock.calls.map((call: any[]) => call[0]);
    const expected = [
      'gene_search', 'gene_get', 'gene_diseases', 'gene_drugs', 'gene_trials', 'gene_articles', 'gene_enrich',
      'variant_search', 'variant_get', 'variant_oncokb', 'variant_trials',
      'drug_search', 'drug_get', 'drug_trials',
      'disease_search', 'disease_get', 'disease_drugs', 'disease_trials',
      'article_search', 'article_get',
      'trial_search', 'trial_get',
      'discover', 'batch_get',
      'pdb',
      'patent_search', 'patent_get',
      'geo_search', 'geo_get',
      'sra_search', 'sra_get',
      'genbank_search', 'genbank_get', 'genbank_genes',
      'gtex_expression', 'gtex_eqtl',
      'ensembl_lookup', 'ensembl_homology', 'ensembl_consequence', 'ensembl_region',
      'biomcp_configure',
    ];
    expect(names.sort()).toEqual(expected.sort());
  });

  it('drug_get sections enum includes adverse_events', () => {
    registerDrugTools(mockServer);
    const drugGetCall = mockRegisterTool.mock.calls.find((call: any[]) => call[0] === 'drug_get');
    expect(drugGetCall).toBeDefined();
    const sections = (drugGetCall![1] as any).inputSchema.sections;
    expect(sections).toBeDefined();
    // Implementation-agnostic enum assertions: the schema must accept the
    // new section (plus 'all') and reject unknown section names.
    expect(sections.safeParse(['adverse_events']).success).toBe(true);
    expect(sections.safeParse(['all']).success).toBe(true);
    expect(sections.safeParse(['not_a_section']).success).toBe(false);
  });

  it('patent_get sections schema is usable (entity mock provides real constants)', () => {
    registerPatentTools(mockServer);
    const patentGetCall = mockRegisterTool.mock.calls.find((call: any[]) => call[0] === 'patent_get');
    expect(patentGetCall).toBeDefined();
    const sections = (patentGetCall![1] as any).inputSchema.sections;
    // Guards against the z.enum(undefined) booby trap: the schema must build AND parse.
    expect(sections.safeParse(['claims']).success).toBe(true);
    expect(sections.safeParse(['not_a_section']).success).toBe(false);
  });

  it('loud module mocks fail loudly on unknown export access', () => {
    const mod = mockLoudModule('entities/test', { knownExport: 42 });
    expect((mod as any).knownExport).toBe(42);
    expect((mod as any).__esModule).toBeUndefined();
    expect(() => (mod as any).notExportedBySource).toThrow(/unknown export 'notExportedBySource'/);
  });
});
