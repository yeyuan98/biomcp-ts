import { jest } from '@jest/globals';
import {
  geneEnrichment, discover, searchAll, batchGet, variantToTrials,
  geneToDrugs, geneToTrials, drugToGenes, drugToTrials,
  drugToAdverseEvents, diseaseToDrugs, diseaseToGenes,
} from '../../entities/cross-entity.js';
import type { GeneEnrichmentResult } from '../../entities/cross-entity.js';
import { connectionManager } from '../../connections/manager.js';
import { HttpConnectionError } from '../../connections/errors.js';
import { errorMessageWithCause, networkCauseCode } from '../../entities/errors.js';
import { parseMockUrl, mockFetchRouter } from '../helpers/mock-url.js';
import { createMcpTestHarness, type McpTestHarness } from '../helpers/mcp-harness.js';
import { existsSync, mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

/** Extract the `_error` message from a geneEnrichment error-row result. */
function enrichError(result: GeneEnrichmentResult | Array<{ _error: string }>): string {
  expect(Array.isArray(result)).toBe(true);
  if (!Array.isArray(result)) throw new Error('unreachable');
  expect(result).toHaveLength(1);
  return result[0]._error;
}

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

  test('geneEnrichment applies the 3-gene minimum to the UNIQUE symbol set (issue #85)', async () => {
    // Reactome counts submitted identifier lines — duplicates and case
    // variants collapse before submission, so 3 raw entries that reduce to
    // 2 unique genes must fail the minimum up front, not after a wasted call.
    global.fetch = jest.fn<(...args: any[]) => any>().mockResolvedValue({
      ok: true,
      json: () => Promise.resolve({ pathways: [] }),
    }) as any;

    await expect(geneEnrichment(['TP53', 'tp53', ' BRCA1 '])).rejects.toThrow(
      'Gene enrichment requires at least 3 genes'
    );
    await expect(geneEnrichment(['TP53', 'TP53', 'TP53', ''])).rejects.toThrow(
      'Gene enrichment requires at least 3 genes'
    );
    expect(global.fetch).not.toHaveBeenCalled();
  });

  test('discover() calls geneSearch + drugSearch + diseaseSearch', async () => {
    global.fetch = jest.fn<(...args: any[]) => any>().mockResolvedValue({
      ok: true,
      json: () => Promise.resolve({ hits: [] }),
    }) as any;

    await discover('brca1');

    expect(global.fetch).toHaveBeenCalled();
    const urls = (global.fetch as any).mock.calls.map((c: any[]) => c[0] as string);
    const hasMygene = urls.some((u: string) => parseMockUrl(u).hostname === 'mygene.info');
    const hasMyvariant = urls.some((u: string) => parseMockUrl(u).hostname === 'myvariant.info');
    const hasMychem = urls.some((u: string) => parseMockUrl(u).hostname === 'mychem.info');
    const hasMydisease = urls.some((u: string) => parseMockUrl(u).hostname === 'mydisease.info');
    expect(hasMygene).toBe(true);
    expect(hasMyvariant).toBe(true);
    expect(hasMychem).toBe(true);
    expect(hasMydisease).toBe(true);
  });

  test('searchAll() calls all entity search functions', async () => {
    global.fetch = jest.fn<(...args: any[]) => any>().mockResolvedValue({
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
    const hasMygene = urls.some((u: string) => parseMockUrl(u).hostname === 'mygene.info');
    const hasMyvariant = urls.some((u: string) => parseMockUrl(u).hostname === 'myvariant.info');
    const hasMychem = urls.some((u: string) => parseMockUrl(u).hostname === 'mychem.info');
    const hasMydisease = urls.some((u: string) => parseMockUrl(u).hostname === 'mydisease.info');
    const hasClinicaltrials = urls.some((u: string) => parseMockUrl(u).hostname === 'clinicaltrials.gov');
    const hasEutils = urls.some((u: string) => parseMockUrl(u).hostname === 'eutils.ncbi.nlm.nih.gov');
    expect(hasMygene).toBe(true);
    expect(hasMyvariant).toBe(true);
    expect(hasMychem).toBe(true);
    expect(hasMydisease).toBe(true);
    expect(hasClinicaltrials).toBe(true);
    expect(hasEutils).toBe(true);
  });

  test('batchGet() calls correct entity get per type', async () => {
    global.fetch = jest.fn<(...args: any[]) => any>().mockResolvedValue({
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

  test('batchGet() article fulltext is file-only: handles, never body text', async () => {
    // Route mocks for articleGet(12345, ['fulltext']): PubMed efetch XML
    // (carries the PMCID), one Europe PMC core search (oa), and the
    // fullTextXML body. Sections run in parallel — route by hostname/path.
    global.fetch = jest.fn((url: unknown) => {
      const { hostname, pathname } = parseMockUrl(url);
      if (hostname === 'eutils.ncbi.nlm.nih.gov' && pathname.endsWith('/efetch.fcgi')) {
        return Promise.resolve({
          ok: true,
          headers: new Headers({ 'content-type': 'text/xml' }),
          text: () => Promise.resolve(`<?xml version="1.0"?>
<PubmedArticleSet><PubmedArticle>
<MedlineCitation Status="MEDLINE" Owner="NLM"><PMID Version="1">12345</PMID>
<Article PubModel="Electronic"><Journal><Title>T</Title><ISOAbbreviation>T</ISOAbbreviation></Journal>
<ArticleTitle>Batched article</ArticleTitle></Article></MedlineCitation>
<PubmedData><ArticleIdList><ArticleId IdType="pubmed">12345</ArticleId>
<ArticleId IdType="doi">10.1234/test.2018</ArticleId><ArticleId IdType="pmc">PMC9999999</ArticleId></ArticleIdList>
</PubmedData></PubmedArticle></PubmedArticleSet>`),
        });
      }
      if (hostname === 'www.ebi.ac.uk' && pathname.endsWith('/search')) {
        return Promise.resolve({
          ok: true,
          headers: new Headers({ 'content-type': 'application/json' }),
          json: () => Promise.resolve({ hitCount: 1, resultList: { result: [{
            pmcid: 'PMC9999999', doi: '10.1234/test.2018', isOpenAccess: 'Y', inPMC: 'Y', inEPMC: 'Y', license: 'cc by',
            fullTextUrlList: { fullTextUrl: [] },
          }] } }),
        });
      }
      if (hostname === 'www.ebi.ac.uk' && pathname.endsWith('/fullTextXML')) {
        return Promise.resolve({
          ok: true,
          headers: new Headers({ 'content-type': 'text/xml' }),
          text: () => Promise.resolve('<?xml version="1.0"?><article><body><sec><title>Intro</title><p>The body must not appear in the batch reply.</p></sec></body><back><ref-list/></back></article>'),
        });
      }
      return Promise.reject(new Error(`unexpected url ${url}`));
    }) as any;

    // File-mode writes must stay out of the real cache dir
    const savedCache = process.env.BIOMCP_CACHE_DIR;
    const cacheRoot = mkdtempSync(join(tmpdir(), 'biomcp-batch-'));
    process.env.BIOMCP_CACHE_DIR = cacheRoot;
    try {
      const results = await batchGet([{ entity: 'article', id: '12345', sections: ['fulltext'] }]);

      expect(results).toHaveLength(1);
      expect(results[0].success).toBe(true);
      const ft = (results[0].data as any)?.sections?.fulltext;
      expect(ft.mode).toBe('file');
      expect(ft.status).toBe('available');
      expect(ft.sections).toBeUndefined(); // never body text in batch replies
      expect(ft.outline.length).toBeGreaterThan(0);
      expect(existsSync(ft.file_path)).toBe(true);
      expect(readFileSync(ft.file_path, 'utf8')).toContain('The body must not appear in the batch reply.');
    } finally {
      if (savedCache === undefined) delete process.env.BIOMCP_CACHE_DIR;
      else process.env.BIOMCP_CACHE_DIR = savedCache;
      rmSync(cacheRoot, { recursive: true, force: true });
    }
  });

  test('batchGet() supports patent entity with invalid-id error capture', async () => {
    const results = await batchGet([{ entity: 'patent', id: 'not-a-patent' }]);
    expect(results).toHaveLength(1);
    expect(results[0].entity).toBe('patent');
    expect(results[0].success).toBe(false);
    expect(String(results[0].error)).toMatch(/Invalid patent number/i);
  });

  test('discover() falls back to OLS4 when no other results found', async () => {
    global.fetch = mockFetchRouter([
      {
        host: ['mygene.info', 'myvariant.info', 'mychem.info', 'mydisease.info'],
        reply: () => Promise.resolve({
          ok: true,
          json: () => Promise.resolve({ hits: [] }),
        }),
      },
      {
        host: 'www.ebi.ac.uk',
        path: '/ols4',
        reply: () => Promise.resolve({
          ok: true,
          json: () => Promise.resolve({
            response: {
              docs: [
                { iri: 'http://example.org/BRCA1', obo_id: 'hgnc:1100', label: 'BRCA1', type: 'class', ontology_name: 'hgnc' },
              ],
              numFound: 1,
            },
          }),
        }),
      },
    ], () => Promise.resolve({
      ok: true,
      json: () => Promise.resolve({}),
    })) as any;

    const results = await discover('BRCA1');

    const urls = (global.fetch as any).mock.calls.map((c: any[]) => c[0] as string);
    const hasOls4 = urls.some((u: string) => {
      const { hostname, pathname } = parseMockUrl(u);
      return hostname === 'www.ebi.ac.uk' && pathname.startsWith('/ols4/api/search');
    });
    expect(hasOls4).toBe(true);
    expect(results.some(r => r.name === 'BRCA1' && r.source === 'hgnc')).toBe(true);
  });

  test('discover() prefers an exact symbol match over an earlier substring hit', async () => {
    // mygene ranks a substring name match first (issue #65 symptom);
    // the exact-symbol hit appears later in the candidate list.
    global.fetch = mockFetchRouter([
      {
        host: 'mygene.info',
        reply: () => Promise.resolve({
          ok: true,
          json: () => Promise.resolve({
            hits: [
              { symbol: 'BAGE', name: 'B melanoma antigen' },
              { symbol: 'BRAF', name: 'B-Raf proto-oncogene, serine/threonine kinase' },
            ],
          }),
        }),
      },
      {
        host: ['myvariant.info', 'mychem.info', 'mydisease.info'],
        reply: () => Promise.resolve({
          ok: true,
          json: () => Promise.resolve({ hits: [] }),
        }),
      },
    ]) as any;

    const results = await discover('BRAF');

    expect(results).toHaveLength(1);
    expect(results[0].entity_type).toBe('gene');
    expect(results[0].identifier).toBe('BRAF');
    expect(results[0].name).toBe('B-Raf proto-oncogene, serine/threonine kinase');
    expect(results[0].matched_on).toBe('exact');
  });

  test('discover() falls back to the first non-empty candidate when no exact match exists', async () => {
    // Multi-word query: no disease candidate equals "lung cancer" verbatim,
    // so the backend's first hit must still win (no regression vs. old
    // first-hit behavior). The mychem hit list starts with a nameless hit
    // that must be skipped in favor of the next non-empty candidate.
    global.fetch = mockFetchRouter([
      {
        host: 'mydisease.info',
        reply: () => Promise.resolve({
          ok: true,
          json: () => Promise.resolve({
            hits: [
              { _id: 'MONDO:0012159', mondo: { label: 'lung cancer susceptibility 1', id: 'MONDO:0012159' } },
              { _id: 'MONDO:0005061', mondo: { label: 'lung adenocarcinoma', id: 'MONDO:0005061' } },
            ],
          }),
        }),
      },
      {
        host: 'mychem.info',
        reply: () => Promise.resolve({
          ok: true,
          json: () => Promise.resolve({
            hits: [{}, { chebi: { name: 'Gefitinib' } }],
          }),
        }),
      },
      {
        host: ['mygene.info', 'myvariant.info'],
        reply: () => Promise.resolve({
          ok: true,
          json: () => Promise.resolve({ hits: [] }),
        }),
      },
    ]) as any;

    const results = await discover('lung cancer');

    expect(results).toHaveLength(2);
    const disease = results.find(r => r.entity_type === 'disease');
    expect(disease).toBeDefined();
    expect(disease!.identifier).toBe('MONDO:0012159');
    expect(disease!.name).toBe('lung cancer susceptibility 1');
    expect(disease!.matched_on).toBe('first');
    // Empty first mychem hit skipped; next non-empty candidate used.
    const drug = results.find(r => r.entity_type === 'drug');
    expect(drug).toBeDefined();
    expect(drug!.name).toBe('Gefitinib');
    expect(drug!.matched_on).toBe('first');
  });

  test('discover() emits no record for a backend whose hits are all empty', async () => {
    global.fetch = mockFetchRouter([
      {
        host: 'mychem.info',
        reply: () => Promise.resolve({
          ok: true,
          json: () => Promise.resolve({
            hits: [{}, { unii: { registry_number: '' } }],
          }),
        }),
      },
      {
        host: 'mydisease.info',
        reply: () => Promise.resolve({
          ok: true,
          json: () => Promise.resolve({
            hits: [{ _id: 'MONDO:0005105', mondo: { label: 'melanoma', id: 'MONDO:0005105' } }],
          }),
        }),
      },
      {
        host: ['mygene.info', 'myvariant.info'],
        reply: () => Promise.resolve({
          ok: true,
          json: () => Promise.resolve({ hits: [] }),
        }),
      },
    ]) as any;

    const results = await discover('melanoma');

    // mychem hits map to nameless drug candidates — no drug record emitted.
    expect(results.some(r => r.entity_type === 'drug')).toBe(false);
    expect(results).toHaveLength(1);
    expect(results[0].entity_type).toBe('disease');
    expect(results[0].name).toBe('melanoma');
    expect(results[0].matched_on).toBe('exact');
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
    global.fetch = jest.fn<(...args: any[]) => any>().mockImplementation(() => {
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
    const trialUrl = urls.find((u: string) => parseMockUrl(u).hostname === 'clinicaltrials.gov');
    expect(trialUrl).toBeDefined();
    expect(trialUrl).toContain('BRAF');
  });

  test('falls back to gene-only search when no protein change available', async () => {
    let callCount = 0;
    global.fetch = jest.fn<(...args: any[]) => any>().mockImplementation(() => {
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
    const trialUrl = urls.find((u: string) => parseMockUrl(u).hostname === 'clinicaltrials.gov');
    expect(trialUrl).toContain('BRAF');
  });

  test('falls back to raw variantId when resolution fails', async () => {
    global.fetch = jest.fn<(...args: any[]) => any>().mockImplementation(() => {
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
    global.fetch = jest.fn<(...args: any[]) => any>().mockImplementation(() => {
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
    const trialUrl = urls.find((u: string) => parseMockUrl(u).hostname === 'clinicaltrials.gov');
    // Should use V600E shorthand, not Val600Glu
    expect(trialUrl).toContain('V600E');
    expect(trialUrl).not.toContain('Val600Glu');
  });

  test('gene-only fallback when gene+mutation returns no results', async () => {
    let callCount = 0;
    global.fetch = jest.fn<(...args: any[]) => any>().mockImplementation(() => {
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
    global.fetch = jest.fn<(...args: any[]) => any>().mockImplementation(() => {
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
    const trialUrl = urls.find((u: string) => parseMockUrl(u).hostname === 'clinicaltrials.gov');
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
    global.fetch = jest.fn<(...args: any[]) => any>().mockImplementation(() => {
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
      phase: 'Phase 3',
      report_count: 0,
    });
    expect(results[1].drug_name).toBe('Dabrafenib');
  });

  test('ranks drugs by clinical stage and report count (observed OT enum format)', async () => {
    let callCount = 0;
    global.fetch = jest.fn<(...args: any[]) => any>().mockImplementation(() => {
      callCount++;
      return Promise.resolve({
        ok: true,
        json: () => {
          if (callCount === 1) {
            return Promise.resolve({
              data: {
                search: {
                  hits: [{ id: 'ENSG00000157764', name: 'BRAF', entity: 'target' }],
                },
              },
            });
          }
          // Scrambled on purpose: naive slice(0,20) would keep the API order.
          return Promise.resolve({
            data: {
              target: {
                drugAndClinicalCandidates: {
                  rows: [
                    { maxClinicalStage: 'PHASE_2', clinicalReports: [{ id: '1' }, { id: '2' }], drug: { id: 'CHEMBL1', name: 'ALUMINUM HYDROXIDE', drugType: 'Small molecule' } },
                    { maxClinicalStage: 'PHASE_4', clinicalReports: Array.from({ length: 9 }, (_, i) => ({ id: `v${i}` })), drug: { id: 'CHEMBL2', name: 'VEMURAFENIB', drugType: 'Small molecule' } },
                    { maxClinicalStage: 'PHASE_3', clinicalReports: [{ id: '3' }], drug: { id: 'CHEMBL3', name: 'QS-21', drugType: 'Small molecule' } },
                  ],
                },
              },
            },
          });
        },
      });
    }) as any;

    const results = await geneToDrugs('BRAF');

    expect(results.map(r => r.drug_name)).toEqual(['VEMURAFENIB', 'QS-21', 'ALUMINUM HYDROXIDE']);
    expect(results[0].phase).toBe('PHASE_4');
    expect(results[0].report_count).toBe(9);
  });

  test('collapses salt variants onto the best-ranked row', async () => {
    let callCount = 0;
    global.fetch = jest.fn<(...args: any[]) => any>().mockImplementation(() => {
      callCount++;
      return Promise.resolve({
        ok: true,
        json: () => {
          if (callCount === 1) {
            return Promise.resolve({
              data: {
                search: {
                  hits: [{ id: 'ENSG00000157764', name: 'BRAF', entity: 'target' }],
                },
              },
            });
          }
          return Promise.resolve({
            data: {
              target: {
                drugAndClinicalCandidates: {
                  rows: [
                    { maxClinicalStage: 'PHASE_3', clinicalReports: [{ id: '1' }], drug: { id: 'CHEMBL1', name: 'DABRAFENIB MESYLATE', drugType: 'Small molecule' } },
                    { maxClinicalStage: 'PHASE_1', clinicalReports: [], drug: { id: 'CHEMBL2', name: 'DABRAFENIB', drugType: 'Small molecule' } },
                    { maxClinicalStage: 'PHASE_2', clinicalReports: [{ id: '2' }], drug: { id: 'CHEMBL3', name: 'TRAMETINIB', drugType: 'Small molecule' } },
                  ],
                },
              },
            },
          });
        },
      });
    }) as any;

    const results = await geneToDrugs('BRAF');

    // Salt form and base form collapse; the higher-staged row survives.
    expect(results.map(r => r.drug_name)).toEqual(['DABRAFENIB MESYLATE', 'TRAMETINIB']);
    expect(results[0].phase).toBe('PHASE_3');
  });

  test('returns error when gene not found', async () => {
    global.fetch = jest.fn<(...args: any[]) => any>().mockResolvedValue({
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
    global.fetch = jest.fn<(...args: any[]) => any>().mockRejectedValue(new Error('Network error')) as any;

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
    global.fetch = jest.fn<(...args: any[]) => any>().mockResolvedValue({
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
    global.fetch = jest.fn<(...args: any[]) => any>().mockResolvedValue({
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
    global.fetch = jest.fn<(...args: any[]) => any>().mockImplementation(() => {
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
    global.fetch = jest.fn<(...args: any[]) => any>().mockResolvedValue({
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
    global.fetch = jest.fn<(...args: any[]) => any>().mockImplementation(() => {
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
    global.fetch = jest.fn<(...args: any[]) => any>().mockResolvedValue({
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
    const trialUrl = urls.find((u: string) => parseMockUrl(u).hostname === 'clinicaltrials.gov');
    expect(trialUrl).toBeDefined();
    // Should use query.intr (intervention) instead of query.cond (condition)
    expect(trialUrl).toContain('query.intr');
  });
});

// ============================================================
// drugToAdverseEvents (FDA FAERS via openFDA, aggregated counts)
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

  test('returns ranked FAERS reactions via fully-qualified substance_name search', async () => {
    global.fetch = jest.fn<(...args: any[]) => any>()
      .mockResolvedValueOnce({
        ok: true,
        headers: new Headers({ 'content-type': 'application/json' }),
        json: () => Promise.resolve({
          meta: { results: { total: 561125 } },
          results: [{ safetyreportid: '1' }],
        }),
      })
      .mockResolvedValueOnce({
        ok: true,
        headers: new Headers({ 'content-type': 'application/json' }),
        json: () => Promise.resolve({
          results: [
            { term: 'FATIGUE', count: 38660 },
            { term: 'NAUSEA', count: 21000 },
          ],
        }),
      }) as any;

    const result = await drugToAdverseEvents('aspirin');

    expect(global.fetch).toHaveBeenCalledTimes(2);
    const probeUrl = (global.fetch as any).mock.calls[0][0] as string;
    expect(probeUrl).toContain('patient.drug.openfda.substance_name');
    expect(probeUrl).toContain('%22aspirin%22');
    const countUrl = (global.fetch as any).mock.calls[1][0] as string;
    expect(countUrl).toContain('count=patient.reaction.reactionmeddrapt.exact');

    expect((result as any).total_reports).toBe(561125);
    expect((result as any).reactions).toEqual([
      { reaction: 'FATIGUE', count: 38660, source: 'openfda' },
      { reaction: 'NAUSEA', count: 21000, source: 'openfda' },
    ]);
  });

  test('404 zero-match on substance_name falls back to generic_name, then medicinalproduct', async () => {
    const notFound = {
      ok: false,
      status: 404,
      statusText: 'Not Found',
      headers: new Headers({ 'content-type': 'application/json' }),
      text: () => Promise.resolve('{"error":{"code":"NOT_FOUND"}}'),
    };
    global.fetch = jest.fn<(...args: any[]) => any>()
      .mockResolvedValueOnce(notFound)
      .mockResolvedValueOnce({
        ok: true,
        headers: new Headers({ 'content-type': 'application/json' }),
        json: () => Promise.resolve({ meta: { results: { total: 42 } }, results: [] }),
      })
      .mockResolvedValueOnce({
        ok: true,
        headers: new Headers({ 'content-type': 'application/json' }),
        json: () => Promise.resolve({ results: [{ term: 'DIZZINESS', count: 3 }] }),
      }) as any;

    const result = await drugToAdverseEvents('fancybrand');

    expect(global.fetch).toHaveBeenCalledTimes(3);
    const urls = (global.fetch as any).mock.calls.map((c: unknown[]) => c[0] as string);
    expect(urls[0]).toContain('patient.drug.openfda.substance_name');
    expect(urls[1]).toContain('patient.drug.openfda.generic_name');
    expect((result as any).total_reports).toBe(42);
    expect((result as any).reactions).toEqual([{ reaction: 'DIZZINESS', count: 3, source: 'openfda' }]);
  });

  test('zero-match on every field returns an empty result, not an error', async () => {
    const notFound = {
      ok: false,
      status: 404,
      statusText: 'Not Found',
      headers: new Headers({ 'content-type': 'application/json' }),
      text: () => Promise.resolve('{"error":{"code":"NOT_FOUND"}}'),
    };
    global.fetch = jest.fn<(...args: any[]) => any>().mockResolvedValue(notFound) as any;

    const result = await drugToAdverseEvents('zzznotadrug999');

    expect(global.fetch).toHaveBeenCalledTimes(3);
    expect(result).toEqual({ total_reports: 0, reactions: [] });
  });

  test('drug names with quotes and backslashes are Lucene-escaped in the search phrase', async () => {
    global.fetch = jest.fn<(...args: any[]) => any>()
      .mockResolvedValueOnce({
        ok: true,
        headers: new Headers({ 'content-type': 'application/json' }),
        json: () => Promise.resolve({ meta: { results: { total: 3 } }, results: [] }),
      })
      .mockResolvedValueOnce({
        ok: true,
        headers: new Headers({ 'content-type': 'application/json' }),
        json: () => Promise.resolve({ results: [{ term: 'RASH', count: 1 }] }),
      }) as any;

    await drugToAdverseEvents('we"ird\\name');

    const probeUrl = decodeURIComponent((global.fetch as any).mock.calls[0][0] as string);
    // Backslashes doubled first, then quotes escaped — a trailing backslash
    // must not consume the closing quote of the phrase.
    expect(probeUrl).toContain('patient.drug.openfda.substance_name:"we\\"ird\\\\name"');
  });

  test('returns error row on hard API failure', async () => {
    global.fetch = jest.fn<(...args: any[]) => any>().mockRejectedValue(new Error('Service unavailable')) as any;

    const results = await drugToAdverseEvents('aspirin');

    expect(results).toHaveLength(1);
    expect((results as any)[0]._error).toContain('Adverse event lookup for drug failed');
    expect((results as any)[0]._error).toContain('Service unavailable');
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
    global.fetch = jest.fn<(...args: any[]) => any>().mockImplementation(() => {
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
    global.fetch = jest.fn<(...args: any[]) => any>().mockImplementation(() => {
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

  test('ranks drugs by clinical stage then report count (observed OT enum format)', async () => {
    let callCount = 0;
    global.fetch = jest.fn<(...args: any[]) => any>().mockImplementation(() => {
      callCount++;
      return Promise.resolve({
        ok: true,
        json: () => {
          if (callCount === 1) {
            return Promise.resolve({
              data: {
                search: { hits: [{ id: 'EFO_0000616', name: 'melanoma', entity: 'disease' }] },
              },
            });
          }
          // Scrambled on purpose: naive slice(0,20) would keep the API order
          // (QS-21 / ALUMINUM HYDROXIDE ranking above standard of care).
          return Promise.resolve({
            data: {
              disease: {
                id: 'EFO_0000616',
                name: 'melanoma',
                drugAndClinicalCandidates: {
                  rows: [
                    { maxClinicalStage: 'PHASE_3', clinicalReports: [{ id: '1' }, { id: '2' }], drug: { id: 'CHEMBL1', name: 'QS-21' } },
                    { maxClinicalStage: 'PHASE_2', clinicalReports: [{ id: '3' }], drug: { id: 'CHEMBL2', name: 'ALUMINUM HYDROXIDE' } },
                    { maxClinicalStage: 'PHASE_4', clinicalReports: Array.from({ length: 12 }, (_, i) => ({ id: `v${i}` })), drug: { id: 'CHEMBL3', name: 'VEMURAFENIB' } },
                  ],
                },
              },
            },
          });
        },
      });
    }) as any;

    const results = await diseaseToDrugs('melanoma');

    expect(results.map(r => r.drug_name)).toEqual(['VEMURAFENIB', 'QS-21', 'ALUMINUM HYDROXIDE']);
    expect(results[0].phase).toBe('PHASE_4');
    expect(results[0].report_count).toBe(12);
    expect(results[1].report_count).toBe(2);
  });

  test('normalizes differently-formatted stage values when ranking', async () => {
    let callCount = 0;
    global.fetch = jest.fn<(...args: any[]) => any>().mockImplementation(() => {
      callCount++;
      return Promise.resolve({
        ok: true,
        json: () => {
          if (callCount === 1) {
            return Promise.resolve({
              data: {
                search: { hits: [{ id: 'EFO_0000616', name: 'melanoma', entity: 'disease' }] },
              },
            });
          }
          // Display-string 'Phase 3' must outrank the enum 'PHASE_2', and
          // 'Approved' (APPROVAL synonym) must outrank both.
          return Promise.resolve({
            data: {
              disease: {
                id: 'EFO_0000616',
                name: 'melanoma',
                drugAndClinicalCandidates: {
                  rows: [
                    { maxClinicalStage: 'PHASE_2', clinicalReports: [{ id: '1' }], drug: { id: 'CHEMBL1', name: 'DRUG PHASE2' } },
                    { maxClinicalStage: 'Phase 3', clinicalReports: [{ id: '2' }], drug: { id: 'CHEMBL2', name: 'DRUG DISPLAY' } },
                    { maxClinicalStage: 'Approved', clinicalReports: [{ id: '3' }], drug: { id: 'CHEMBL3', name: 'DRUG APPROVED' } },
                  ],
                },
              },
            },
          });
        },
      });
    }) as any;

    const results = await diseaseToDrugs('melanoma');

    expect(results.map(r => r.drug_name)).toEqual(['DRUG APPROVED', 'DRUG DISPLAY', 'DRUG PHASE2']);
    expect(results[1].phase).toBe('Phase 3');
  });

  test('collapses salt variants onto the best-ranked row', async () => {
    let callCount = 0;
    global.fetch = jest.fn<(...args: any[]) => any>().mockImplementation(() => {
      callCount++;
      return Promise.resolve({
        ok: true,
        json: () => {
          if (callCount === 1) {
            return Promise.resolve({
              data: {
                search: { hits: [{ id: 'EFO_0000616', name: 'melanoma', entity: 'disease' }] },
              },
            });
          }
          return Promise.resolve({
            data: {
              disease: {
                id: 'EFO_0000616',
                name: 'melanoma',
                drugAndClinicalCandidates: {
                  rows: [
                    { maxClinicalStage: 'PHASE_2', clinicalReports: [{ id: '1' }], drug: { id: 'CHEMBL1', name: 'DABRAFENIB MESYLATE' } },
                    { maxClinicalStage: 'APPROVAL', clinicalReports: [{ id: '2' }, { id: '3' }], drug: { id: 'CHEMBL2', name: 'DABRAFENIB' } },
                    { maxClinicalStage: 'PHASE_3', clinicalReports: [{ id: '4' }], drug: { id: 'CHEMBL3', name: 'TRAMETINIB' } },
                  ],
                },
              },
            },
          });
        },
      });
    }) as any;

    const results = await diseaseToDrugs('melanoma');

    // DABRAFENIB MESYLATE and DABRAFENIB share an identity key; the
    // approved base form survives, the salt form is dropped.
    expect(results.map(r => r.drug_name)).toEqual(['DABRAFENIB', 'TRAMETINIB']);
    expect(results[0].phase).toBe('APPROVAL');
    expect(results[0].report_count).toBe(2);
  });

  test('returns error when disease not found', async () => {
    global.fetch = jest.fn<(...args: any[]) => any>().mockResolvedValue({
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
    global.fetch = jest.fn<(...args: any[]) => any>().mockImplementation(() => {
      callCount++;
      return Promise.resolve({
        ok: true,
        json: () => {
          // Call 1: MyDisease MONDO label resolve (search-shaped mock: harmless)
          // Call 2: OpenTargets search (returns no hits)
          if (callCount === 2) {
            return Promise.resolve({
              data: { search: { hits: [] } },
            });
          }
          // Call 3+: EFO probe / drug queries resolve a disease
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
    // The fallback probe must query OpenTargets with the MONDO_ EFO ID format.
    const calls = (global.fetch as any).mock.calls;
    const efoProbe = calls.find((c: any[]) =>
      typeof c[1]?.body === 'string' &&
      c[1].body.includes('MONDO_0007254') &&
      c[1].body.includes('disease(efoId')
    );
    expect(efoProbe).toBeDefined();
    expect(String(efoProbe[0])).toContain('opentargets');
  });
});

// ============================================================
// diseaseToGenes (DisGeNET gda/summary)
// ============================================================
describe('diseaseToGenes', () => {
  let originalFetch: typeof global.fetch;
  let originalEnv: string | undefined;

  beforeEach(() => {
    jest.clearAllMocks();
    originalFetch = global.fetch;
    originalEnv = process.env.DISGENET_API_KEY;
    process.env.DISGENET_API_KEY = 'test-disgenet-key';
    connectionManager.closeAll();
  });

  afterEach(() => {
    global.fetch = originalFetch;
    if (originalEnv !== undefined) {
      process.env.DISGENET_API_KEY = originalEnv;
    } else {
      delete process.env.DISGENET_API_KEY;
    }
  });

  test('queries gda/summary with normalized disease code and raw Authorization key', async () => {
    global.fetch = jest.fn<(...args: any[]) => any>().mockResolvedValue({
      ok: true,
      json: () => Promise.resolve({
        payload: [
          {
            symbolOfGene: 'BRCA1',
            geneNcbiID: 672,
            diseaseName: 'Breast carcinoma',
            diseaseUMLSCUI: 'C0006142',
            score: 0.9,
            numPMIDs: 120,
          },
          {
            symbolOfGene: 'TP53',
            geneNcbiID: 7157,
            diseaseName: 'Breast carcinoma',
            diseaseUMLSCUI: 'C0006142',
            score: 0.8,
            numPMIDs: 80,
          },
        ],
        warnings: [],
        pageNum: 0,
        pageSize: 10,
        pageCount: 1,
        totalEntries: 2,
      }),
      headers: new Headers({ 'content-type': 'application/json' }),
    }) as any;

    const results = await diseaseToGenes('C0006142');

    expect(results).toHaveLength(2);
    expect(results[0]).toEqual({ gene_symbol: 'BRCA1', name: 'BRCA1', source: 'disgenet', score: 0.9 });

    const calls = (global.fetch as any).mock.calls;
    expect(calls.length).toBe(1);
    const url = new URL(calls[0][0] as string);
    expect(url.origin + url.pathname).toBe('https://api.disgenet.com/api/v1/gda/summary');
    expect(url.searchParams.get('disease')).toBe('UMLS_C0006142');
    expect(url.searchParams.get('page_number')).toBe('0');
    // Raw (unprefixed) API key in Authorization header.
    expect((calls[0][1].headers as Headers).get('Authorization')).toBe('test-disgenet-key');
  });

  test('normalizes colon-form MONDO ids to DisGeNET underscore form', async () => {
    global.fetch = jest.fn<(...args: any[]) => any>().mockResolvedValue({
      ok: true,
      json: () => Promise.resolve({ payload: [], warnings: [] }),
      headers: new Headers({ 'content-type': 'application/json' }),
    }) as any;

    const results = await diseaseToGenes('MONDO:0007254');

    expect(results).toEqual([]);
    const url = new URL((global.fetch as any).mock.calls[0][0] as string);
    expect(url.searchParams.get('disease')).toBe('MONDO_0007254');
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

  test('returns the enrichment envelope: pathways page, total_reported, truncated=false', async () => {
    global.fetch = jest.fn<(...args: any[]) => any>().mockResolvedValue({
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

    const result = (await geneEnrichment(['BRCA1', 'TP53', 'RB1', 'CHEK2', 'ATM'])) as GeneEnrichmentResult;

    expect(result.pathways).toHaveLength(2);
    expect(result.pathways[0]).toEqual({
      pathway_id: 'R-HSA-1640170',
      name: 'Cell Cycle',
      p_value: 0.001,
      genes_overlap: 5,
      genes_total: 100,
      source: 'reactome',
    });
    expect(result.pathways[1].pathway_id).toBe('R-HSA-73894');
    expect(result.total_reported).toBe(2);
    expect(result.truncated).toBe(false);
  });

  test('deduplicates, uppercases, and drops empties before submission (issue #85)', async () => {
    global.fetch = jest.fn<(...args: any[]) => any>().mockResolvedValue({
      ok: true,
      json: () => Promise.resolve({ pathways: [] }),
    }) as any;

    const result = (await geneEnrichment(['BRCA1', 'brca1', 'TP53', 'TP53', 'atm', '  '])) as GeneEnrichmentResult;

    expect(result).toEqual({ pathways: [], total_reported: 0, truncated: false });
    // The posted identifier list must contain each unique symbol exactly
    // once — Reactome counts every submitted line, so duplicates would
    // inflate genes_overlap beyond the real input size.
    expect(global.fetch).toHaveBeenCalledTimes(1);
    const call = (global.fetch as any).mock.calls[0];
    expect(String(call[0])).toContain('reactome.org/AnalysisService/identifiers/projection');
    expect(call[1].body).toBe('BRCA1\nTP53\nATM');
  });

  test('applies the caller limit and reports truncation honestly (issue #85)', async () => {
    const manyPathways = Array.from({ length: 45 }, (_, i) => ({
      stId: `R-HSA-${i}`,
      name: `Pathway ${i}`,
      entities: { pValue: 0.01, found: 3, total: 100 },
    }));
    global.fetch = jest.fn<(...args: any[]) => any>().mockResolvedValue({
      ok: true,
      json: () => Promise.resolve({ pathways: manyPathways }),
    }) as any;

    // Default limit 30: page truncated, total reported.
    const def = (await geneEnrichment(['A1', 'A2', 'A3'])) as GeneEnrichmentResult;
    expect(def.pathways).toHaveLength(30);
    expect(def.total_reported).toBe(45);
    expect(def.truncated).toBe(true);

    // Caller limit above the result count: no truncation.
    const wide = (await geneEnrichment(['A1', 'A2', 'A3'], 100)) as GeneEnrichmentResult;
    expect(wide.pathways).toHaveLength(45);
    expect(wide.total_reported).toBe(45);
    expect(wide.truncated).toBe(false);

    // Explicit small limit.
    const small = (await geneEnrichment(['A1', 'A2', 'A3'], 5)) as GeneEnrichmentResult;
    expect(small.pathways).toHaveLength(5);
    expect(small.total_reported).toBe(45);
    expect(small.truncated).toBe(true);
  });

  test('genes_overlap is Reactome-reported passthrough, never clamped (issue #85 invariant)', async () => {
    // Mocked upstream absurdity (found far above the unique input size):
    // post-dedup the invariant should hold for real responses, but what we
    // emit must always equal what Reactome reported — honesty over clamping.
    global.fetch = jest.fn<(...args: any[]) => any>().mockResolvedValue({
      ok: true,
      json: () => Promise.resolve({
        pathways: [
          { stId: 'R-HSA-1', name: 'Odd pathway', entities: { pValue: 0.5, found: 99, total: 100 } },
        ],
      }),
    }) as any;

    const result = (await geneEnrichment(['BRCA1', 'TP53', 'ATM'])) as GeneEnrichmentResult;

    expect(result.pathways[0].genes_overlap).toBe(99);
  });

  test('handles timeout with AbortError', async () => {
    const abortError = new DOMException('The operation was aborted', 'AbortError');
    global.fetch = jest.fn<(...args: any[]) => any>().mockRejectedValue(abortError) as any;

    const results = await geneEnrichment(['BRCA1', 'TP53', 'ATM']);

    expect(enrichError(results)).toContain('Request timed out');
  });

  test('handles HTTP error response', async () => {
    global.fetch = jest.fn<(...args: any[]) => any>().mockResolvedValue({
      ok: false,
      status: 500,
      statusText: 'Internal Server Error',
    }) as any;

    const err = enrichError(await geneEnrichment(['BRCA1', 'TP53', 'ATM']));

    expect(err).toContain('HTTP 500');
    expect(err).toContain('Internal Server Error');
  });

  // Issue #62: network-level failures must not blame the gene input.
  test('network failure (raw fetch rejection, cause code) names the code and proxy env, not gene input', async () => {
    global.fetch = jest.fn<(...args: any[]) => any>().mockRejectedValue(
      Object.assign(new TypeError('fetch failed'), { cause: { code: 'ETIMEDOUT' } })
    ) as any;

    const err = enrichError(await geneEnrichment(['BRCA1', 'TP53', 'ATM']));

    expect(err).toContain('ETIMEDOUT');
    expect(err).toContain('HTTPS_PROXY');
    expect(err).toContain('Network error');
    expect(err).not.toContain('Ensure at least 3 valid gene symbols');
  });

  test('network failure (HttpConnectionError already carrying the code) is classified the same', async () => {
    // Post-PR-#69 shape: the transport layer already appended the cause code.
    global.fetch = jest.fn<(...args: any[]) => any>().mockRejectedValue(
      new HttpConnectionError('fetch failed (ECONNREFUSED)')
    ) as any;

    const err = enrichError(await geneEnrichment(['BRCA1', 'TP53', 'ATM']));

    expect(err).toContain('ECONNREFUSED');
    expect(err).toContain('HTTPS_PROXY');
    expect(err).toContain('Network error');
    expect(err).not.toContain('Ensure at least 3 valid gene symbols');
  });
});

// ============================================================
// gene_enrich tool contract (schema + serialization, issue #85)
// ============================================================
describe('gene_enrich tool contract', () => {
  let harness: McpTestHarness;
  let originalFetch: typeof global.fetch;

  beforeAll(async () => {
    harness = await createMcpTestHarness();
  });

  afterAll(async () => {
    await harness.close();
  });

  beforeEach(() => {
    originalFetch = global.fetch;
    connectionManager.closeAll();
  });

  afterEach(() => {
    global.fetch = originalFetch;
  });

  test('schema rejects fewer than 3 genes before any request runs', async () => {
    const fetchMock = jest.fn<(...args: any[]) => any>().mockResolvedValue({
      ok: true,
      json: () => Promise.resolve({ pathways: [] }),
    });
    global.fetch = fetchMock as any;

    await expect(harness.callTool('gene_enrich', { genes: ['BRCA1', 'TP53'] })).rejects.toThrow(
      /at least 3 genes/
    );
    expect(fetchMock).not.toHaveBeenCalled();
  });

  test('serializes the envelope (pathways, total_reported, truncated) and passes limit through', async () => {
    global.fetch = jest.fn<(...args: any[]) => any>().mockResolvedValue({
      ok: true,
      json: () => Promise.resolve({
        pathways: Array.from({ length: 4 }, (_, i) => ({
          stId: `R-HSA-${i}`,
          name: `Pathway ${i}`,
          entities: { pValue: 0.01, found: 2, total: 50 },
        })),
      }),
    }) as any;

    const result = await harness.callTool('gene_enrich', {
      genes: ['BRCA1', 'TP53', 'ATM'],
      limit: 2,
    });

    expect(result).toEqual({
      pathways: [
        expect.objectContaining({ pathway_id: 'R-HSA-0' }),
        expect.objectContaining({ pathway_id: 'R-HSA-1' }),
      ],
      total_reported: 4,
      truncated: true,
    });
  });

  test('isError surfaces the _error row JSON on upstream failure', async () => {
    global.fetch = jest.fn<(...args: any[]) => any>().mockResolvedValue({
      ok: false,
      status: 503,
      statusText: 'Service Unavailable',
    }) as any;

    await expect(
      harness.callTool('gene_enrich', { genes: ['BRCA1', 'TP53', 'ATM'] })
    ).rejects.toThrow(/HTTP 503/);
  });
});

// ============================================================
// errorMessageWithCause / networkCauseCode helpers (entities/errors.ts)
// ============================================================
describe('errorMessageWithCause / networkCauseCode', () => {
  test('appends cause code when the message lacks it', () => {
    const raw = Object.assign(new TypeError('fetch failed'), { cause: { code: 'ETIMEDOUT' } });
    expect(errorMessageWithCause(raw)).toBe('fetch failed (ETIMEDOUT)');
    expect(networkCauseCode(raw)).toBe('ETIMEDOUT');
  });

  test('does not duplicate a code the message already carries', () => {
    const wrapped = new HttpConnectionError('fetch failed (ETIMEDOUT)');
    expect(errorMessageWithCause(wrapped)).toBe('fetch failed (ETIMEDOUT)');
  });

  test('falls back to cause message for wrapped errors without a code', () => {
    const wrapped = Object.assign(new Error('request failed'), {
      cause: new Error('socket hang up'),
    });
    expect(errorMessageWithCause(wrapped)).toBe('request failed (socket hang up)');
    expect(networkCauseCode(wrapped)).toBeUndefined();
  });

  test('leaves cause-less and non-error values alone', () => {
    expect(errorMessageWithCause(new Error('plain'))).toBe('plain');
    expect(errorMessageWithCause('boom')).toBe('boom');
    expect(networkCauseCode(new Error('plain'))).toBeUndefined();
    expect(networkCauseCode(null)).toBeUndefined();
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
    global.fetch = jest.fn<(...args: any[]) => any>().mockResolvedValue({
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
    global.fetch = jest.fn<(...args: any[]) => any>().mockImplementation(() => {
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
    global.fetch = jest.fn<(...args: any[]) => any>().mockImplementation(() => {
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
    global.fetch = jest.fn<(...args: any[]) => any>().mockResolvedValue({
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
    global.fetch = mockFetchRouter([
      // gene search (mygene) fails
      {
        host: 'mygene.info',
        reply: () => Promise.reject(new Error('mygene down')),
      },
      // drug search (mychem) succeeds
      {
        host: 'mychem.info',
        reply: () => Promise.resolve({
          ok: true,
          json: () => Promise.resolve({
            hits: [{ name: 'TestDrug' }],
          }),
        }),
      },
      // variant search (myvariant) succeeds
      {
        host: 'myvariant.info',
        reply: () => Promise.resolve({
          ok: true,
          json: () => Promise.resolve({ hits: [] }),
        }),
      },
      // disease search (mydisease) succeeds
      {
        host: 'mydisease.info',
        reply: () => Promise.resolve({
          ok: true,
          json: () => Promise.resolve({ hits: [] }),
        }),
      },
      // ClinicalTrials.gov
      {
        host: 'clinicaltrials.gov',
        reply: () => Promise.resolve({
          ok: true,
          json: () => Promise.resolve({ studies: [] }),
        }),
      },
      // NCBI eutils
      {
        host: 'eutils.ncbi.nlm.nih.gov',
        reply: () => Promise.resolve({
          ok: true,
          json: () => Promise.resolve({
            esearchresult: { idlist: [] },
          }),
        }),
      },
    ], () => Promise.resolve({
      ok: true,
      json: () => Promise.resolve({}),
    })) as any;

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
