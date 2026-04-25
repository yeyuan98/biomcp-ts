import { jest, describe, it, expect, beforeEach } from '@jest/globals';
import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';

const mockRegisterTool = jest.fn();
const mockServer = { registerTool: mockRegisterTool } as unknown as McpServer;

jest.mock('@modelcontextprotocol/sdk/server/mcp.js', () => ({
  McpServer: jest.fn(),
}));

jest.mock('../../entities/gene.js', () => ({
  geneSearch: jest.fn(),
  geneGet: jest.fn(),
  GeneSearchResult: undefined,
  GeneResult: undefined,
}));

jest.mock('../../entities/drug.js', () => ({
  drugSearch: jest.fn(),
  drugGet: jest.fn(),
  DrugSearchResult: undefined,
  DrugResult: undefined,
}));

jest.mock('../../entities/variant.js', () => ({
  variantSearch: jest.fn(),
  variantGet: jest.fn(),
  fetchOncoKbAnnotation: jest.fn(),
  getVariantSearchFilters: jest.fn().mockReturnValue(['consequence', 'significance']),
  VariantSearchResult: undefined,
  VariantResult: undefined,
}));

jest.mock('../../entities/disease.js', () => ({
  diseaseSearch: jest.fn(),
  diseaseGet: jest.fn(),
  DiseaseSearchResult: undefined,
  DiseaseResult: undefined,
}));

jest.mock('../../entities/trial.js', () => ({
  trialSearch: jest.fn(),
  trialGet: jest.fn(),
  TrialSearchResult: undefined,
  TrialResult: undefined,
}));

jest.mock('../../entities/article.js', () => ({
  articleSearch: jest.fn(),
  articleGet: jest.fn(),
  Article: undefined,
}));

jest.mock('../../entities/cross-entity.js', () => ({
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

jest.mock('../../connections/manager.js', () => ({
  connectionManager: {
    getConnection: jest.fn().mockReturnValue({
      request: jest.fn(),
      healthCheck: jest.fn().mockResolvedValue(true),
    }),
  },
}));

jest.mock('../../connections/fetch-utils.js', () => ({
  fetchWithTimeout: jest.fn(),
}));

jest.mock('../../transform/gene.js', () => ({
  transformMyGeneHit: jest.fn(),
}));

import { registerGeneTools } from '../../server/tools/gene.js';
import { registerDrugTools } from '../../server/tools/drug.js';
import { registerVariantTools } from '../../server/tools/variant.js';
import { registerDiseaseTools } from '../../server/tools/disease.js';
import { registerTrialTools } from '../../server/tools/trial.js';
import { registerArticleTools } from '../../server/tools/article.js';
import { registerUtilityTools } from '../../server/tools/utility.js';

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

  it('total registerTool calls across all registrations = 24', () => {
    registerGeneTools(mockServer);
    registerDrugTools(mockServer);
    registerVariantTools(mockServer);
    registerDiseaseTools(mockServer);
    registerTrialTools(mockServer);
    registerArticleTools(mockServer);
    registerUtilityTools(mockServer);
    expect(mockRegisterTool).toHaveBeenCalledTimes(24);
  });

  it('no duplicate tool names across all registrations', () => {
    registerGeneTools(mockServer);
    registerDrugTools(mockServer);
    registerVariantTools(mockServer);
    registerDiseaseTools(mockServer);
    registerTrialTools(mockServer);
    registerArticleTools(mockServer);
    registerUtilityTools(mockServer);

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

    const names = mockRegisterTool.mock.calls.map((call: any[]) => call[0]);
    const expected = [
      'gene_search', 'gene_get', 'gene_diseases', 'gene_drugs', 'gene_trials', 'gene_articles', 'gene_enrich',
      'variant_search', 'variant_get', 'variant_oncokb', 'variant_trials',
      'drug_search', 'drug_get', 'drug_trials',
      'disease_search', 'disease_get', 'disease_drugs', 'disease_trials',
      'article_search', 'article_get',
      'trial_search', 'trial_get',
      'discover', 'batch_get',
    ];
    expect(names.sort()).toEqual(expected.sort());
  });
});
