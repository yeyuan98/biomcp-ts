import { jest } from '@jest/globals';
import {
  geneEnrichment, discover, searchAll, batchGet, variantToTrials,
  geneToDrugs, geneToTrials, drugToGenes, drugToTrials,
  drugToAdverseEvents, diseaseToDrugs,
} from '../../entities/cross-entity.js';
import { connectionManager } from '../../connections/manager.js';

describe('cross-entity', () => {
  let originalFetch: typeof global.fetch;

  beforeEach(() => {
    jest.clearAllMocks();
    originalFetch = global.fetch;
    connectionManager.closeAll();
    process.env.NCBI_API_KEY = '';
  });

  afterEach(() => {
    global.fetch = originalFetch;
    delete process.env.NCBI_API_KEY;
  });

  test('geneEnrichment rejects input with fewer than 3 gene symbols', async () => {
    await expect(geneEnrichment(['BRCA1', 'TP53'])).rejects.toThrow(
      'Gene enrichment requires at least 3 genes'
    );
    await expect(geneEnrichment([])).rejects.toThrow(
      'Gene enrichment requires at least 3 genes'
    );
  });

  test('discover() calls geneSearch + drugSearch + diseaseSearch', async () => {
    global.fetch = jest.fn().mockResolvedValue({
      ok: true,
      json: () => Promise.resolve({ hits: [] }),
    }) as any;

    await discover('brca1');

    expect(global.fetch).toHaveBeenCalled();
    const urls = (global.fetch as any).mock.calls.map((c: any[]) => c[0] as string);
    const hasMygene = urls.some((u: string) => u.includes('mygene.info'));
    const hasMyvariant = urls.some((u: string) => u.includes('myvariant.info'));
    const hasMychem = urls.some((u: string) => u.includes('mychem.info'));
    const hasMydisease = urls.some((u: string) => u.includes('mydisease.info'));
    expect(hasMygene).toBe(true);
    expect(hasMyvariant).toBe(true);
    expect(hasMychem).toBe(true);
    expect(hasMydisease).toBe(true);
  });

  test('searchAll() calls all entity search functions', async () => {
    global.fetch = jest.fn().mockResolvedValue({
      ok: true,
      json: () => Promise.resolve({
        hits: [],
        studies: [],
        esearchresult: { idlist: [] },
        result: [],
      }),
    }) as any;

    await searchAll('cancer');

    expect(global.fetch).toHaveBeenCalled();
    const urls = (global.fetch as any).mock.calls.map((c: any[]) => c[0] as string);
    const hasMygene = urls.some((u: string) => u.includes('mygene.info'));
    const hasMyvariant = urls.some((u: string) => u.includes('myvariant.info'));
    const hasMychem = urls.some((u: string) => u.includes('mychem.info'));
    const hasMydisease = urls.some((u: string) => u.includes('mydisease.info'));
    const hasClinicaltrials = urls.some((u: string) => u.includes('clinicaltrials.gov'));
    const hasEutils = urls.some((u: string) => u.includes('eutils.ncbi.nlm.nih.gov'));
    expect(hasMygene).toBe(true);
    expect(hasMyvariant).toBe(true);
    expect(hasMychem).toBe(true);
    expect(hasMydisease).toBe(true);
    expect(hasClinicaltrials).toBe(true);
    expect(hasEutils).toBe(true);
  });

  test('batchGet() calls correct entity get per type', async () => {
    global.fetch = jest.fn().mockResolvedValue({
      ok: true,
      json: () => Promise.resolve({
        hits: [{ symbol: 'BRCA1', name: 'BRCA1' }],
      }),
    }) as any;

    const results = await batchGet([
      { entity: 'gene', id: 'BRCA1' },
      { entity: 'drug', id: 'Aspirin' },
    ]);

    expect(results).toHaveLength(2);
    expect(results[0].entity).toBe('gene');
    expect(results[0].id).toBe('BRCA1');
    expect(results[0].success).toBe(true);
    expect(results[1].entity).toBe('drug');
    expect(results[1].id).toBe('Aspirin');
  });

  test('batchGet() supports patent entity with invalid-id error capture', async () => {
    const results = await batchGet([{ entity: 'patent', id: 'not-a-patent' }]);
    expect(results).toHaveLength(1);
    expect(results[0].entity).toBe('patent');
    expect(results[0].success).toBe(false);
    expect(String(results[0].error)).toMatch(/Invalid patent number/i);
  });

  test('discover() falls back to OLS4 when no other results found', async () => {
    let callCount = 0;
    global.fetch = jest.fn().mockImplementation((url: string) => {
      callCount++;
      if (url.includes('mygene.info') || url.includes('myvariant.info') || url.includes('mychem.info') || url.includes('mydisease.info')) {
        return Promise.resolve({
          ok: true,
          json: () => Promise.resolve({ hits: [] }),
        });
      }
      if (url.includes('ols4')) {
        return Promise.resolve({
          ok: true,
          json: () => Promise.resolve({
            response: {
              docs: [
                { iri: 'http://example.org/BRCA1', obo_id: 'hgnc:1100', label: 'BRCA1', type: 'class', ontology_name: 'hgnc' },
              ],
              numFound: 1,
            },
          }),
        });
      }
      return Promise.resolve({
        ok: true,
        json: () => Promise.resolve({}),
      });
    }) as any;

    const results = await discover('BRCA1');

    const urls = (global.fetch as any).mock.calls.map((c: any[]) => c[0] as string);
    const hasOls4 = urls.some((u: string) => u.includes('ols4') && u.includes('/api/search'));
    expect(hasOls4).toBe(true);
    expect(results.some(r => r.name === 'BRCA1' && r.source === 'hgnc')).toBe(true);
  });
});

describe('variantToTrials', () => {
  let originalFetch: typeof global.fetch;

  beforeEach(() => {
    jest.clearAllMocks();
    originalFetch = global.fetch;
    connectionManager.closeAll();
  });

  afterEach(() => {
    global.fetch = originalFetch;
  });

  test('resolves variant to gene + protein change and searches trials', async () => {
    let callCount = 0;
    global.fetch = jest.fn().mockImplementation(() => {
      callCount++;
      // First call: variantGet → MyVariant.info
      // Second call: trialSearch → ClinicalTrials.gov
      if (callCount === 1) {
        return Promise.resolve({
          ok: true,
          json: () => Promise.resolve({
            _id: 'rs113488022',
            dbsnp: { rsid: 'rs113488022' },
            snpeff: { ann: [{ genename: 'BRAF', hgvs_p: 'p.V600E' }] },
            clinvar: { rcv: [{ clinical_significance: 'Pathogenic' }] },
          }),
        });
      }
      // trialSearch call
      return Promise.resolve({
        ok: true,
        json: () => Promise.resolve({
          studies: [{
            protocolSection: {
              identificationModule: { nctId: 'NCT00000001', briefTitle: 'BRAF V600E Trial' },
              statusModule: { overallStatus: 'RECRUITING' },
              descriptionModule: {},
              armsInterventionsModule: {},
            },
          }],
        }),
      });
    }) as any;

    const results = await variantToTrials('rs113488022');

    expect(results).toHaveLength(1);
    expect(results[0].nct_id).toBe('NCT00000001');

    // Verify the trial search used gene + protein change, not raw rsID
    const urls = (global.fetch as any).mock.calls.map((c: any[]) => c[0] as string);
    const trialUrl = urls.find((u: string) => u.includes('clinicaltrials.gov'));
    expect(trialUrl).toBeDefined();
    expect(trialUrl).toContain('BRAF');
  });

  test('falls back to gene-only search when no protein change available', async () => {
    let callCount = 0;
    global.fetch = jest.fn().mockImplementation(() => {
      callCount++;
      if (callCount === 1) {
        // variantGet returns gene but no hgvs_p
        return Promise.resolve({
          ok: true,
          json: () => Promise.resolve({
            _id: 'chr7:140453136',
            snpeff: { ann: [{ genename: 'BRAF' }] },
            clinvar: {},
          }),
        });
      }
      // trialSearch
      return Promise.resolve({
        ok: true,
        json: () => Promise.resolve({
          studies: [{
            protocolSection: {
              identificationModule: { nctId: 'NCT00000002', briefTitle: 'BRAF Trial' },
              statusModule: { overallStatus: 'RECRUITING' },
              descriptionModule: {},
              armsInterventionsModule: {},
            },
          }],
        }),
      });
    }) as any;

    const results = await variantToTrials('chr7:140453136');

    expect(results).toHaveLength(1);
    const urls = (global.fetch as any).mock.calls.map((c: any[]) => c[0] as string);
    const trialUrl = urls.find((u: string) => u.includes('clinicaltrials.gov'));
    expect(trialUrl).toContain('BRAF');
  });

  test('falls back to raw variantId when resolution fails', async () => {
    global.fetch = jest.fn().mockImplementation(() => {
      return Promise.resolve({
        ok: true,
        json: () => Promise.resolve({
          studies: [],
        }),
      });
    }) as any;

    const results = await variantToTrials('unknown_variant_xyz');

    // Both variantGet and variantSearch fail, falls back to searching raw ID
    // ClinicalTrials.gov returns empty for random strings
    expect(results).toHaveLength(0);
    expect(global.fetch).toHaveBeenCalled();
  });

  test('converts HGVS three-letter to shorthand in trial search query', async () => {
    let callCount = 0;
    global.fetch = jest.fn().mockImplementation(() => {
      callCount++;
      // First call: variantGet (myvariant.info)
      if (callCount === 1) {
        return Promise.resolve({
          ok: true,
          json: () => Promise.resolve({
            _id: 'rs113488022',
            dbsnp: { rsid: 'rs113488022' },
            snpeff: { ann: [{ genename: 'BRAF', hgvs_p: 'p.Val600Glu' }] },
            clinvar: { rcv: [{ clinical_significance: 'Pathogenic' }] },
          }),
        });
      }
      // trialSearch call
      return Promise.resolve({
        ok: true,
        json: () => Promise.resolve({
          studies: [{
            protocolSection: {
              identificationModule: { nctId: 'NCT00000099', briefTitle: 'BRAF V600E Trial' },
              statusModule: { overallStatus: 'RECRUITING' },
              descriptionModule: {},
              armsInterventionsModule: {},
            },
          }],
        }),
      });
    }) as any;

    const results = await variantToTrials('rs113488022');

    expect(results).toHaveLength(1);
    const urls = (global.fetch as any).mock.calls.map((c: any[]) => c[0] as string);
    const trialUrl = urls.find((u: string) => u.includes('clinicaltrials.gov'));
    // Should use V600E shorthand, not Val600Glu
    expect(trialUrl).toContain('V600E');
    expect(trialUrl).not.toContain('Val600Glu');
  });

  test('gene-only fallback when gene+mutation returns no results', async () => {
    let callCount = 0;
    global.fetch = jest.fn().mockImplementation(() => {
      callCount++;
      // First call: variantGet
      if (callCount === 1) {
        return Promise.resolve({
          ok: true,
          json: () => Promise.resolve({
            _id: 'rs12345',
            dbsnp: { rsid: 'rs12345' },
            snpeff: { ann: [{ genename: 'EGFR', hgvs_p: 'p.Leu858Arg' }] },
            clinvar: {},
          }),
        });
      }
      // Second call: trialSearch with gene+mutation (returns empty)
      if (callCount === 2) {
        return Promise.resolve({
          ok: true,
          json: () => Promise.resolve({ studies: [] }),
        });
      }
      // Third call: trialSearch with gene-only fallback
      return Promise.resolve({
        ok: true,
        json: () => Promise.resolve({
          studies: [{
            protocolSection: {
              identificationModule: { nctId: 'NCT00000888', briefTitle: 'EGFR Trial' },
              statusModule: { overallStatus: 'RECRUITING' },
              descriptionModule: {},
              armsInterventionsModule: {},
            },
          }],
        }),
      });
    }) as any;

    const results = await variantToTrials('rs12345');

    expect(results).toHaveLength(1);
    expect(results[0].nct_id).toBe('NCT00000888');
    // Should have made at least 3 fetch calls: variantGet, trialSearch(gene+mutation), trialSearch(gene-only)
    expect(callCount).toBeGreaterThanOrEqual(3);
  });

  test('Arg123Ter (stop codon) is converted to R123*', async () => {
    let callCount = 0;
    global.fetch = jest.fn().mockImplementation(() => {
      callCount++;
      if (callCount === 1) {
        return Promise.resolve({
          ok: true,
          json: () => Promise.resolve({
            _id: 'rs99999',
            dbsnp: { rsid: 'rs99999' },
            snpeff: { ann: [{ genename: 'TP53', hgvs_p: 'p.Arg123Ter' }] },
            clinvar: {},
          }),
        });
      }
      return Promise.resolve({
        ok: true,
        json: () => Promise.resolve({
          studies: [{
            protocolSection: {
              identificationModule: { nctId: 'NCT00000777', briefTitle: 'TP53 Trial' },
              statusModule: { overallStatus: 'RECRUITING' },
              descriptionModule: {},
              armsInterventionsModule: {},
            },
          }],
        }),
      });
    }) as any;

    const results = await variantToTrials('rs99999');
    expect(results).toHaveLength(1);
    const urls = (global.fetch as any).mock.calls.map((c: any[]) => c[0] as string);
    const trialUrl = urls.find((u: string) => u.includes('clinicaltrials.gov'));
    // Arg123Ter -> R123*
    expect(trialUrl).toContain('R123*');
  });
});

// ============================================================
// geneToDrugs
// ============================================================
describe('geneToDrugs', () => {
  let originalFetch: typeof global.fetch;

  beforeEach(() => {
    jest.clearAllMocks();
    originalFetch = global.fetch;
    connectionManager.closeAll();
  });

  afterEach(() => {
    global.fetch = originalFetch;
  });

  test('returns drugs for a known gene', async () => {
    let callCount = 0;
    global.fetch = jest.fn().mockImplementation(() => {
      callCount++;
      // All calls are GraphQL POSTs to OpenTargets
      return Promise.resolve({
        ok: true,
        json: () => {
          if (callCount === 1) {
            // Search for gene -> returns ensembl ID
            return Promise.resolve({
              data: {
                search: {
                  hits: [{ id: 'ENSG00000157764', name: 'BRAF', entity: 'target' }],
                },
              },
            });
          }
          // Drug query
          return Promise.resolve({
            data: {
              target: {
                drugAndClinicalCandidates: {
                  rows: [
                    { maxClinicalStage: 'Phase 3', drug: { id: 'CHEMBL123', name: 'Vemurafenib', drugType: 'Small molecule' } },
                    { maxClinicalStage: 'Phase 2', drug: { id: 'CHEMBL456', name: 'Dabrafenib', drugType: 'Small molecule' } },
                  ],
                },
              },
            },
          });
        },
      });
    }) as any;

    const results = await geneToDrugs('BRAF');

    expect(results).toHaveLength(2);
    expect(results[0]).toEqual({
      drug_name: 'Vemurafenib',
      source: 'opentargets',
      action_type: 'Small molecule',
    });
    expect(results[1].drug_name).toBe('Dabrafenib');
  });

  test('returns error when gene not found', async () => {
    global.fetch = jest.fn().mockResolvedValue({
      ok: true,
      json: () => Promise.resolve({
        data: { search: { hits: [] } },
      }),
    }) as any;

    const results = await geneToDrugs('NONEXISTENTGENE');

    expect(results).toHaveLength(1);
    expect((results[0] as any)._error).toContain('No OpenTargets entry found');
  });

  test('returns error on API failure', async () => {
    global.fetch = jest.fn().mockRejectedValue(new Error('Network error')) as any;

    const results = await geneToDrugs('BRAF');

    expect(results).toHaveLength(1);
    expect((results[0] as any)._error).toContain('Drug lookup for gene failed');
    expect((results[0] as any)._error).toContain('Network error');
  });
});

// ============================================================
// geneToTrials
// ============================================================
describe('geneToTrials', () => {
  let originalFetch: typeof global.fetch;

  beforeEach(() => {
    jest.clearAllMocks();
    originalFetch = global.fetch;
    connectionManager.closeAll();
  });

  afterEach(() => {
    global.fetch = originalFetch;
  });

  test('delegates to trialSearch and maps results', async () => {
    global.fetch = jest.fn().mockResolvedValue({
      ok: true,
      json: () => Promise.resolve({
        studies: [{
          protocolSection: {
            identificationModule: { nctId: 'NCT00000001', briefTitle: 'BRCA1 Trial' },
            statusModule: { overallStatus: 'RECRUITING' },
            descriptionModule: {},
            armsInterventionsModule: {},
          },
        }],
      }),
    }) as any;

    const results = await geneToTrials('BRCA1');

    expect(results).toHaveLength(1);
    expect(results[0]).toEqual({
      nct_id: 'NCT00000001',
      title: 'BRCA1 Trial',
      status: 'RECRUITING',
    });
  });

  test('returns empty array when no trials found', async () => {
    global.fetch = jest.fn().mockResolvedValue({
      ok: true,
      json: () => Promise.resolve({ studies: [] }),
    }) as any;

    const results = await geneToTrials('NONEXISTENTGENE');

    expect(results).toHaveLength(0);
  });
});

// ============================================================
// drugToGenes
// ============================================================
describe('drugToGenes', () => {
  let originalFetch: typeof global.fetch;

  beforeEach(() => {
    jest.clearAllMocks();
    originalFetch = global.fetch;
    connectionManager.closeAll();
  });

  afterEach(() => {
    global.fetch = originalFetch;
  });

  test('returns gene targets for a known drug', async () => {
    let callCount = 0;
    global.fetch = jest.fn().mockImplementation(() => {
      callCount++;
      return Promise.resolve({
        ok: true,
        json: () => {
          if (callCount === 1) {
            // Drug search
            return Promise.resolve({
              data: {
                search: {
                  hits: [{ id: 'CHEMBL1224700', name: 'Aspirin', entity: 'drug' }],
                },
              },
            });
          }
          // Mechanism query
          return Promise.resolve({
            data: {
              drug: {
                id: 'CHEMBL1224700',
                name: 'Aspirin',
                mechanismsOfAction: {
                  rows: [
                    {
                      actionType: 'INHIBITOR',
                      targets: [
                        { id: 'ENSG00000091831', approvedSymbol: 'PTGS1' },
                        { id: 'ENSG00000073756', approvedSymbol: 'PTGS2' },
                      ],
                    },
                  ],
                },
              },
            },
          });
        },
      });
    }) as any;

    const results = await drugToGenes('Aspirin');

    expect(results).toHaveLength(2);
    expect(results[0].gene_symbol).toBe('PTGS1');
    expect(results[1].gene_symbol).toBe('PTGS2');
    expect(results[0].source).toBe('opentargets');
    expect(results[0].action_type).toBe('INHIBITOR');
  });

  test('returns error when drug not found', async () => {
    global.fetch = jest.fn().mockResolvedValue({
      ok: true,
      json: () => Promise.resolve({
        data: { search: { hits: [] } },
      }),
    }) as any;

    const results = await drugToGenes('UNKNOWN_DRUG');

    expect(results).toHaveLength(1);
    expect((results[0] as any)._error).toContain('No OpenTargets entry found');
  });

  test('deduplicates duplicate target gene symbols', async () => {
    let callCount = 0;
    global.fetch = jest.fn().mockImplementation(() => {
      callCount++;
      return Promise.resolve({
        ok: true,
        json: () => {
          if (callCount === 1) {
            return Promise.resolve({
              data: {
                search: {
                  hits: [{ id: 'CHEMBL123', name: 'TestDrug', entity: 'drug' }],
                },
              },
            });
          }
          return Promise.resolve({
            data: {
              drug: {
                id: 'CHEMBL123',
                name: 'TestDrug',
                mechanismsOfAction: {
                  rows: [
                    {
                      actionType: 'BLOCKER',
                      targets: [{ id: 'ENSG001', approvedSymbol: 'ABC' }],
                    },
                    {
                      actionType: 'AGONIST',
                      targets: [{ id: 'ENSG001', approvedSymbol: 'ABC' }],
                    },
                  ],
                },
              },
            },
          });
        },
      });
    }) as any;

    const results = await drugToGenes('TestDrug');

    // ABC appears twice but should be deduped
    expect(results).toHaveLength(1);
    expect(results[0].gene_symbol).toBe('ABC');
  });
});

// ============================================================
// drugToTrials
// ============================================================
describe('drugToTrials', () => {
  let originalFetch: typeof global.fetch;

  beforeEach(() => {
    jest.clearAllMocks();
    originalFetch = global.fetch;
    connectionManager.closeAll();
  });

  afterEach(() => {
    global.fetch = originalFetch;
  });

  test('passes searchType=intervention to trialSearch', async () => {
    global.fetch = jest.fn().mockResolvedValue({
      ok: true,
      json: () => Promise.resolve({
        studies: [{
          protocolSection: {
            identificationModule: { nctId: 'NCT00000333', briefTitle: 'Drug Trial' },
            statusModule: { overallStatus: 'RECRUITING' },
            descriptionModule: {},
            armsInterventionsModule: {},
          },
        }],
      }),
    }) as any;

    const results = await drugToTrials('Vemurafenib');

    expect(results).toHaveLength(1);
    expect(results[0].nct_id).toBe('NCT00000333');

    const urls = (global.fetch as any).mock.calls.map((c: any[]) => c[0] as string);
    const trialUrl = urls.find((u: string) => u.includes('clinicaltrials.gov'));
    expect(trialUrl).toBeDefined();
    // Should use query.intr (intervention) instead of query.cond (condition)
    expect(trialUrl).toContain('query.intr');
  });
});

// ============================================================
// drugToAdverseEvents
// ============================================================
describe('drugToAdverseEvents', () => {
  let originalFetch: typeof global.fetch;

  beforeEach(() => {
    jest.clearAllMocks();
    originalFetch = global.fetch;
    connectionManager.closeAll();
  });

  afterEach(() => {
    global.fetch = originalFetch;
  });

  test('returns adverse events from OpenFDA', async () => {
    global.fetch = jest.fn().mockResolvedValue({
      ok: true,
      json: () => Promise.resolve({
        results: [
          { reactions: [{ reactionmeddrapt: 'Nausea' }] },
          { reactions: [{ reactionmeddrapt: 'Headache' }] },
        ],
      }),
    }) as any;

    const results = await drugToAdverseEvents('Aspirin');

    expect(results).toHaveLength(2);
    expect(results[0].reaction).toBe('Nausea');
    expect(results[0].source).toBe('openfda');
    expect(results[1].reaction).toBe('Headache');
  });

  test('returns error on API failure', async () => {
    global.fetch = jest.fn().mockRejectedValue(new Error('Service unavailable')) as any;

    const results = await drugToAdverseEvents('Aspirin');

    expect(results).toHaveLength(1);
    expect((results[0] as any)._error).toContain('Adverse event lookup for drug failed');
    expect((results[0] as any)._error).toContain('Service unavailable');
  });
});

// ============================================================
// diseaseToDrugs
// ============================================================
describe('diseaseToDrugs', () => {
  let originalFetch: typeof global.fetch;

  beforeEach(() => {
    jest.clearAllMocks();
    originalFetch = global.fetch;
    connectionManager.closeAll();
  });

  afterEach(() => {
    global.fetch = originalFetch;
  });

  test('resolves MONDO ID via mydisease then queries OpenTargets', async () => {
    let callCount = 0;
    global.fetch = jest.fn().mockImplementation(() => {
      callCount++;
      return Promise.resolve({
        ok: true,
        json: () => {
          // First call: mydisease resolve
          if (callCount === 1) {
            return Promise.resolve({
              mondo: { label: 'Breast cancer' },
              disease_ontology: {},
            });
          }
          // Second call: OpenTargets search
          if (callCount === 2) {
            return Promise.resolve({
              data: {
                search: {
                  hits: [{ id: 'EFO_0003869', name: 'breast cancer', entity: 'disease' }],
                },
              },
            });
          }
          // Third call: OpenTargets drug query
          return Promise.resolve({
            data: {
              disease: {
                id: 'EFO_0003869',
                name: 'breast cancer',
                drugAndClinicalCandidates: {
                  rows: [
                    { maxClinicalStage: 'Phase 3', drug: { id: 'CHEMBL1', name: 'Tamoxifen' } },
                  ],
                },
              },
            },
          });
        },
      });
    }) as any;

    const results = await diseaseToDrugs('MONDO:0007254');

    expect(results).toHaveLength(1);
    expect(results[0].drug_name).toBe('Tamoxifen');
    expect(results[0].source).toBe('opentargets');
    expect(results[0].phase).toBe('Phase 3');
  });

  test('queries OpenTargets directly for plain text query', async () => {
    let callCount = 0;
    global.fetch = jest.fn().mockImplementation(() => {
      callCount++;
      return Promise.resolve({
        ok: true,
        json: () => {
          // First call: OpenTargets search (no mydisease resolve for plain text)
          if (callCount === 1) {
            return Promise.resolve({
              data: {
                search: {
                  hits: [{ id: 'EFO_0000616', name: 'melanoma', entity: 'disease' }],
                },
              },
            });
          }
          // Second call: drug query
          return Promise.resolve({
            data: {
              disease: {
                id: 'EFO_0000616',
                name: 'melanoma',
                drugAndClinicalCandidates: {
                  rows: [
                    { maxClinicalStage: 'Phase 4', drug: { id: 'CHEMBL2', name: 'Dabrafenib' } },
                  ],
                },
              },
            },
          });
        },
      });
    }) as any;

    const results = await diseaseToDrugs('melanoma');

    expect(results).toHaveLength(1);
    expect(results[0].drug_name).toBe('Dabrafenib');
  });

  test('returns error when disease not found', async () => {
    global.fetch = jest.fn().mockResolvedValue({
      ok: true,
      json: () => Promise.resolve({
        data: { search: { hits: [] } },
      }),
    }) as any;

    const results = await diseaseToDrugs('UNKNOWN_DISEASE');

    expect(results).toHaveLength(1);
    expect((results[0] as any)._error).toContain('No OpenTargets entry found');
  });

  test('falls back to MONDO EFO ID format when initial search fails', async () => {
    let callCount = 0;
    global.fetch = jest.fn().mockImplementation(() => {
      callCount++;
      return Promise.resolve({
        ok: true,
        json: () => {
          // First call: OpenTargets search (returns no hits)
          if (callCount === 1) {
            return Promise.resolve({
              data: { search: { hits: [] } },
            });
          }
          // Second call: EFO probe with MONDO_ format
          if (callCount === 2) {
            return Promise.resolve({
              data: {
                disease: { id: 'EFO_0003869', name: 'breast cancer' },
              },
            });
          }
          // Third call: drug query
          return Promise.resolve({
            data: {
              disease: {
                id: 'EFO_0003869',
                name: 'breast cancer',
                drugAndClinicalCandidates: {
                  rows: [
                    { maxClinicalStage: 'Phase 2', drug: { id: 'CHEMBL3', name: 'Test Drug' } },
                  ],
                },
              },
            },
          });
        },
      });
    }) as any;

    const results = await diseaseToDrugs('MONDO:0007254');

    expect(results).toHaveLength(1);
    expect(results[0].drug_name).toBe('Test Drug');
    // Verify the EFO probe used MONDO_ format
    const calls = (global.fetch as any).mock.calls;
    const efoCall = calls[1];
    expect(efoCall).toBeDefined();
  });
});

// ============================================================
// geneEnrichment (additional tests)
// ============================================================
describe('geneEnrichment additional tests', () => {
  let originalFetch: typeof global.fetch;

  beforeEach(() => {
    jest.clearAllMocks();
    originalFetch = global.fetch;
    connectionManager.closeAll();
  });

  afterEach(() => {
    global.fetch = originalFetch;
  });

  test('returns pathway enrichment results', async () => {
    global.fetch = jest.fn().mockResolvedValue({
      ok: true,
      json: () => Promise.resolve({
        pathways: [
          {
            stId: 'R-HSA-1640170',
            name: 'Cell Cycle',
            entities: { pValue: 0.001, found: 5, total: 100 },
          },
          {
            stId: 'R-HSA-73894',
            name: 'DNA Repair',
            entities: { pValue: 0.005, found: 3, total: 80 },
          },
        ],
      }),
    }) as any;

    const results = await geneEnrichment(['BRCA1', 'TP53', 'RB1', 'CHEK2', 'ATM']);

    expect(results).toHaveLength(2);
    expect(results[0]).toEqual({
      pathway_id: 'R-HSA-1640170',
      name: 'Cell Cycle',
      p_value: 0.001,
      genes_overlap: 5,
      genes_total: 100,
      source: 'reactome',
    });
    expect(results[1].pathway_id).toBe('R-HSA-73894');
  });

  test('handles timeout with AbortError', async () => {
    const abortError = new DOMException('The operation was aborted', 'AbortError');
    global.fetch = jest.fn().mockRejectedValue(abortError) as any;

    const results = await geneEnrichment(['BRCA1', 'TP53', 'ATM']);

    expect(results).toHaveLength(1);
    expect((results[0] as any)._error).toContain('Request timed out');
  });

  test('handles HTTP error response', async () => {
    global.fetch = jest.fn().mockResolvedValue({
      ok: false,
      status: 500,
      statusText: 'Internal Server Error',
    }) as any;

    const results = await geneEnrichment(['BRCA1', 'TP53', 'ATM']);

    expect(results).toHaveLength(1);
    expect((results[0] as any)._error).toContain('HTTP 500');
    expect((results[0] as any)._error).toContain('Internal Server Error');
  });
});

// ============================================================
// batchGet (additional tests)
// ============================================================
describe('batchGet additional tests', () => {
  let originalFetch: typeof global.fetch;

  beforeEach(() => {
    jest.clearAllMocks();
    originalFetch = global.fetch;
    connectionManager.closeAll();
  });

  afterEach(() => {
    global.fetch = originalFetch;
  });

  test('returns error for unknown entity type', async () => {
    global.fetch = jest.fn().mockResolvedValue({
      ok: true,
      json: () => Promise.resolve({}),
    }) as any;

    const results = await batchGet([{ entity: 'unknown', id: 'test' }]);

    expect(results).toHaveLength(1);
    expect(results[0].success).toBe(false);
    expect(results[0].error).toContain('Unknown entity');
  });

  test('handles mixed success and failure', async () => {
    let callCount = 0;
    global.fetch = jest.fn().mockImplementation(() => {
      callCount++;
      if (callCount === 1) {
        // geneGet succeeds
        return Promise.resolve({
          ok: true,
          json: () => Promise.resolve({ hits: [{ symbol: 'BRCA1', name: 'BRCA1' }] }),
        });
      }
      // drugGet fails
      return Promise.resolve({
        ok: false,
        status: 404,
        statusText: 'Not Found',
      });
    }) as any;

    const results = await batchGet([
      { entity: 'gene', id: 'BRCA1' },
      { entity: 'drug', id: 'NonexistentDrug' },
    ]);

    expect(results).toHaveLength(2);
    expect(results[0].success).toBe(true);
    expect(results[0].entity).toBe('gene');
    expect(results[1].success).toBe(false);
    expect(results[1].entity).toBe('drug');
  });

  test('handles all entity types in a single batch', async () => {
    global.fetch = jest.fn().mockImplementation(() => {
      return Promise.resolve({
        ok: true,
        json: () => Promise.resolve({ hits: [{ symbol: 'test' }], studies: [] }),
      });
    }) as any;

    const results = await batchGet([
      { entity: 'gene', id: 'BRCA1' },
      { entity: 'variant', id: 'rs123' },
      { entity: 'drug', id: 'Aspirin' },
      { entity: 'disease', id: 'MONDO:1' },
      { entity: 'trial', id: 'NCT00000001' },
      { entity: 'article', id: 'PMID:12345' },
    ]);

    expect(results).toHaveLength(6);
    const entities = results.map(r => r.entity);
    expect(entities).toEqual(['gene', 'variant', 'drug', 'disease', 'trial', 'article']);
  });
});

// ============================================================
// searchAll (additional tests)
// ============================================================
describe('searchAll additional tests', () => {
  let originalFetch: typeof global.fetch;

  beforeEach(() => {
    jest.clearAllMocks();
    originalFetch = global.fetch;
    connectionManager.closeAll();
  });

  afterEach(() => {
    global.fetch = originalFetch;
  });

  test('with entity filter searches only specified entities', async () => {
    global.fetch = jest.fn().mockResolvedValue({
      ok: true,
      json: () => Promise.resolve({
        hits: [{ symbol: 'BRCA1', name: 'BRCA1' }],
      }),
    }) as any;

    const results = await searchAll('BRCA1', { entities: ['gene', 'drug'] });

    expect(results).toHaveLength(2);
    const entityTypes = results.map(r => r.entity_type);
    expect(entityTypes).toContain('gene');
    expect(entityTypes).toContain('drug');
    expect(entityTypes).not.toContain('variant');
    expect(entityTypes).not.toContain('disease');
    expect(entityTypes).not.toContain('trial');
    expect(entityTypes).not.toContain('article');
  });

  test('returns partial results with _error when one search fails', async () => {
    global.fetch = jest.fn().mockImplementation((url: string) => {
      // gene search (mygene) fails
      if (url.includes('mygene.info')) {
        return Promise.reject(new Error('mygene down'));
      }
      // drug search (mychem) succeeds
      if (url.includes('mychem.info')) {
        return Promise.resolve({
          ok: true,
          json: () => Promise.resolve({
            hits: [{ name: 'TestDrug' }],
          }),
        });
      }
      // variant search (myvariant) succeeds
      if (url.includes('myvariant.info')) {
        return Promise.resolve({
          ok: true,
          json: () => Promise.resolve({ hits: [] }),
        });
      }
      // disease search (mydisease) succeeds
      if (url.includes('mydisease.info')) {
        return Promise.resolve({
          ok: true,
          json: () => Promise.resolve({ hits: [] }),
        });
      }
      // ClinicalTrials.gov
      if (url.includes('clinicaltrials.gov')) {
        return Promise.resolve({
          ok: true,
          json: () => Promise.resolve({ studies: [] }),
        });
      }
      // NCBI eutils
      if (url.includes('eutils.ncbi.nlm.nih.gov')) {
        return Promise.resolve({
          ok: true,
          json: () => Promise.resolve({
            esearchresult: { idlist: [] },
          }),
        });
      }
      return Promise.resolve({
        ok: true,
        json: () => Promise.resolve({}),
      });
    }) as any;

    const results = await searchAll('test');

    // Should still return all 6 results
    expect(results).toHaveLength(6);
    // Gene result should have _error
    const geneResult = results.find(r => r.entity_type === 'gene');
    expect(geneResult).toBeDefined();
    const geneResults = geneResult!.results as any[];
    expect(geneResults[0]._error).toContain('gene search failed');
    // Drug result should be ok
    const drugResult = results.find(r => r.entity_type === 'drug');
    expect(drugResult).toBeDefined();
  });
});
