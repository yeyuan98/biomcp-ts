import { jest } from '@jest/globals';
import { connectionManager } from '../../connections/manager.js';
import { mockGlobalFetch } from '../helpers/mock-fetch.js';
import type {
  GTExEqtlResult,
  GTExErrorEnvelope,
  GTExMedianExpressionResult,
} from '../../entities/gtex.js';

const DATASETS = [
  {
    datasetId: 'gtex_v7',
    displayName: 'GTEx Analysis v7',
    gencodeVersion: 'v19',
    genomeBuild: 'GRCh37/hg19',
    tissueCount: 53,
  },
  {
    datasetId: 'gtex_v8',
    displayName: 'GTEx Analysis v8',
    gencodeVersion: 'v26',
    genomeBuild: 'GRCh38/hg38',
    tissueCount: 54,
  },
  {
    datasetId: 'kids_first_harmonization',
    displayName: "Kid's First",
    gencodeVersion: 'v26',
    genomeBuild: 'GRCh38/hg38',
    tissueCount: 5,
  },
  {
    datasetId: 'gtex_v10',
    displayName: 'GTEx Analysis v10',
    gencodeVersion: 'v39',
    genomeBuild: 'GRCh38/hg38',
    tissueCount: 54,
  },
];

const GENE_SEARCH_TP53_FUZZY = {
  data: [
    { gencodeId: 'ENSG00000143514.17', geneSymbol: 'TP53BP2', geneSymbolUpper: 'TP53BP2' },
    { gencodeId: 'ENSG00000115129.14', geneSymbol: 'TP53I3', geneSymbolUpper: 'TP53I3' },
    { gencodeId: 'ENSG00000141510.18', geneSymbol: 'TP53', geneSymbolUpper: 'TP53', entrezGeneId: 7157 },
  ],
  paging_info: { numberOfPages: 1, page: 0, maxItemsPerPage: 250, totalNumberOfItems: 3 },
};

const GENE_SEARCH_ENSG = {
  data: [
    { gencodeId: 'ENSG00000141510.18', geneSymbol: 'TP53', geneSymbolUpper: 'TP53', entrezGeneId: 7157 },
  ],
  paging_info: { numberOfPages: 1, page: 0, maxItemsPerPage: 250, totalNumberOfItems: 1 },
};

const GENE_SEARCH_NO_MATCH = {
  data: [
    { gencodeId: 'ENSG00000143514.17', geneSymbol: 'TP53BP2', geneSymbolUpper: 'TP53BP2' },
  ],
  paging_info: { numberOfPages: 7, page: 0, maxItemsPerPage: 250, totalNumberOfItems: 1586 },
};

const MEDIAN_TP53_UNSORTED = {
  data: [
    { median: 5.12, tissueSiteDetailId: 'Muscle_Skeletal', ontologyId: 'UBERON:0002378', datasetId: 'gtex_v10', gencodeId: 'ENSG00000141510.18', geneSymbol: 'TP53', unit: 'TPM' },
    { median: 22.65, tissueSiteDetailId: 'Adipose_Subcutaneous', ontologyId: 'UBERON:0002190', datasetId: 'gtex_v10', gencodeId: 'ENSG00000141510.18', geneSymbol: 'TP53', unit: 'TPM' },
    { median: 12.03, tissueSiteDetailId: 'Whole_Blood', ontologyId: 'UBERON:0000178', datasetId: 'gtex_v10', gencodeId: 'ENSG00000141510.18', geneSymbol: 'TP53', unit: 'TPM' },
  ],
};

const EQTL_TP53_UNSORTED = {
  data: [
    { variantId: 'chr17_7676153_C_T_b38', geneSymbol: 'TP53', gencodeId: 'ENSG00000141510.18', tissueSiteDetailId: 'Thyroid', pValue: 2.1e-8, nes: 0.35 },
    { variantId: 'chr17_7676409_C_T_b38', geneSymbol: 'TP53', gencodeId: 'ENSG00000141510.18', tissueSiteDetailId: 'Thyroid', pValue: 1.2e-12, nes: -0.28 },
    { variantId: 'chr17_7676582_A_G_b38', geneSymbol: 'TP53', gencodeId: 'ENSG00000141510.18', tissueSiteDetailId: 'Thyroid', pValue: 4.5e-6, nes: 0.11 },
  ],
};

const TISSUES = {
  data: [
    { tissueSiteDetailId: 'Adipose_Subcutaneous', tissueSite: 'Adipose Tissue', tissueSiteDetail: 'Adipose - Subcutaneous', tissueSiteDetailAbbr: 'ADPSBQ', ontologyId: 'UBERON:0002190', eGeneCount: 17562 },
    { tissueSiteDetailId: 'Brain_Cortex', tissueSite: 'Brain', tissueSiteDetail: 'Brain - Cortex', tissueSiteDetailAbbr: 'BRNCX', ontologyId: 'UBERON:0000956', eGeneCount: 11131 },
    { tissueSiteDetailId: 'Whole_Blood', tissueSite: 'Blood', tissueSiteDetail: 'Whole Blood', tissueSiteDetailAbbr: 'WHLBLD', ontologyId: 'UBERON:0000178', eGeneCount: 9018 },
  ],
};

function okJson(body: unknown) {
  return {
    ok: true,
    status: 200,
    statusText: 'OK',
    json: () => Promise.resolve(body),
    headers: new Headers({ 'content-type': 'application/json' }),
  };
}

function geneSearchHandler(url: URL): unknown {
  const geneId = url.searchParams.get('geneId') || '';
  if (/^ENSG\d+/i.test(geneId)) return GENE_SEARCH_ENSG;
  return GENE_SEARCH_TP53_FUZZY;
}

type RouteHandler = (url: URL) => unknown;

function mockFetchRoutes(routes: Record<string, RouteHandler>): void {
  global.fetch = jest.fn<(...args: any[]) => any>().mockImplementation((rawUrl: string) => {
    const url = new URL(rawUrl);
    for (const [pathPrefix, handler] of Object.entries(routes)) {
      if (url.pathname.startsWith(pathPrefix)) {
        const result = handler(url) as unknown;
        if (result && typeof result === 'object' && 'ok' in (result as Record<string, unknown>)) {
          return Promise.resolve(result);
        }
        return Promise.resolve(okJson(result));
      }
    }
    return Promise.resolve(okJson({}));
  }) as any;
}

function defaultRoutes(overrides: Record<string, RouteHandler> = {}): Record<string, RouteHandler> {
  return {
    '/api/v2/metadata/dataset': () => DATASETS,
    '/api/v2/reference/geneSearch': geneSearchHandler,
    '/api/v2/expression/medianGeneExpression': () => MEDIAN_TP53_UNSORTED,
    '/api/v2/association/singleTissueEqtl': () => EQTL_TP53_UNSORTED,
    '/api/v2/dataset/tissueSiteDetail': () => TISSUES,
    ...overrides,
  };
}

async function loadGtex() {
  jest.resetModules();
  return await import('../../entities/gtex.js');
}

/** Success-path narrows: fail fast (with the leaked message) when one of
 *  the entry points unexpectedly returns a `_error` envelope (#132 union). */
function expectMedianResult(r: GTExMedianExpressionResult | GTExErrorEnvelope): GTExMedianExpressionResult {
  if ('_error' in r) throw new Error(`unexpected _error envelope: ${r._error}`);
  return r;
}

function expectEqtlResult(r: GTExEqtlResult | GTExErrorEnvelope): GTExEqtlResult {
  if ('_error' in r) throw new Error(`unexpected _error envelope: ${r._error}`);
  return r;
}

function callUrls(): string[] {
  return (global.fetch as any).mock.calls.map((c: any[]) => c[0] as string);
}

function urlsContaining(fragment: string): string[] {
  return callUrls().filter(u => u.includes(fragment));
}

describe('gtex dataset metadata', () => {
  mockGlobalFetch();

  beforeEach(() => {
    jest.clearAllMocks();
    connectionManager.closeAll();
  });

  test('getGtexDatasets() maps metadata and caches — second call does not re-fetch', async () => {
    const { getGtexDatasets } = await loadGtex();
    mockFetchRoutes(defaultRoutes());

    const first = await getGtexDatasets();
    const second = await getGtexDatasets();

    expect(first.map(d => d.datasetId)).toEqual(['gtex_v7', 'gtex_v8', 'kids_first_harmonization', 'gtex_v10']);
    expect(first[3]).toMatchObject({ datasetId: 'gtex_v10', gencodeVersion: 'v39', genomeBuild: 'GRCh38/hg38' });
    expect(second).toBe(first);
    expect(urlsContaining('metadata/dataset')).toHaveLength(1);
  });

  test('failed metadata call is not cached — retry re-fetches', async () => {
    const { getGtexDatasets } = await loadGtex();
    let fail = true;
    mockFetchRoutes({
      '/api/v2/metadata/dataset': () => {
        if (fail) throw new Error('boom');
        return DATASETS;
      },
    });

    await expect(getGtexDatasets()).rejects.toThrow('boom');
    fail = false;
    await expect(getGtexDatasets()).resolves.toHaveLength(4);
    expect(urlsContaining('metadata/dataset')).toHaveLength(2);
  });
});

describe('gtex resolveGencodeId', () => {
  mockGlobalFetch();

  beforeEach(() => {
    jest.clearAllMocks();
    connectionManager.closeAll();
  });

  test('symbol query filters exact match from fuzzy prefix results', async () => {
    const { resolveGencodeId } = await loadGtex();
    mockFetchRoutes(defaultRoutes());

    const resolution = await resolveGencodeId('TP53');

    expect(resolution).toEqual({ gencodeId: 'ENSG00000141510.18', geneSymbol: 'TP53', entrezGeneId: 7157 });
    const searchUrl = urlsContaining('geneSearch')[0];
    expect(searchUrl).toContain('geneId=TP53');
    expect(searchUrl).toContain('gencodeVersion=v39');
  });

  test('ENSG identifier (bare or versioned) resolves via single-hit path', async () => {
    const { resolveGencodeId } = await loadGtex();
    mockFetchRoutes(defaultRoutes());

    const resolution = await resolveGencodeId('ENSG00000141510');

    expect(resolution.gencodeId).toBe('ENSG00000141510.18');
    expect(resolution.geneSymbol).toBe('TP53');
    expect(urlsContaining('geneSearch')[0]).toContain('geneId=ENSG00000141510');
  });

  test('resolution is memoized case-insensitively', async () => {
    const { resolveGencodeId } = await loadGtex();
    mockFetchRoutes(defaultRoutes());

    await resolveGencodeId('TP53');
    await resolveGencodeId('tp53');

    expect(urlsContaining('geneSearch')).toHaveLength(1);
  });

  test('failed resolution is not memoized — next call re-fetches', async () => {
    const { resolveGencodeId } = await loadGtex();
    mockFetchRoutes(defaultRoutes({ '/api/v2/reference/geneSearch': () => GENE_SEARCH_NO_MATCH }));

    await expect(resolveGencodeId('TP53')).rejects.toThrow("Gene 'TP53' not found in GTEx v10 gene reference");
    await expect(resolveGencodeId('TP53')).rejects.toThrow('not found in GTEx v10');
    // 2 pages probed per attempt, and the failed result is not memoized.
    expect(urlsContaining('geneSearch')).toHaveLength(4);
  });

  test('exact match on page 2 is found and further pages are not fetched', async () => {
    const { resolveGencodeId } = await loadGtex();
    let page = 0;
    mockFetchRoutes(defaultRoutes({
      '/api/v2/reference/geneSearch': () => {
        if (page === 0) {
          page = 1;
          return GENE_SEARCH_NO_MATCH;
        }
        return GENE_SEARCH_TP53_FUZZY;
      },
    }));

    const resolution = await resolveGencodeId('TP53');

    expect(resolution.gencodeId).toBe('ENSG00000141510.18');
    const searchUrls = urlsContaining('geneSearch');
    expect(searchUrls).toHaveLength(2);
    expect(searchUrls[0]).toContain('page=0');
    expect(searchUrls[1]).toContain('page=1');
  });

  test('search caps at 2 pages when no exact match exists', async () => {
    const { resolveGencodeId } = await loadGtex();
    mockFetchRoutes(defaultRoutes({ '/api/v2/reference/geneSearch': () => GENE_SEARCH_NO_MATCH }));

    await expect(resolveGencodeId('TP53')).rejects.toThrow('not found in GTEx v10');
    expect(urlsContaining('geneSearch')).toHaveLength(2);
  });

  test('metadata failure falls back to pinned dataset and version', async () => {
    const { resolveGencodeId } = await loadGtex();
    mockFetchRoutes({
      '/api/v2/metadata/dataset': () => {
        throw new Error('metadata down');
      },
      '/api/v2/reference/geneSearch': geneSearchHandler,
    });

    const resolution = await resolveGencodeId('TP53');

    expect(resolution.gencodeId).toBe('ENSG00000141510.18');
    expect(urlsContaining('geneSearch')[0]).toContain('gencodeVersion=v39');
  });
});

describe('gtexMedianExpression', () => {
  mockGlobalFetch();

  beforeEach(() => {
    jest.clearAllMocks();
    connectionManager.closeAll();
  });

  test('resolves versioned gencodeId and queries gtex_v10', async () => {
    const { gtexMedianExpression } = await loadGtex();
    mockFetchRoutes(defaultRoutes());

    const result = expectMedianResult(await gtexMedianExpression('TP53'));

    const medianUrl = urlsContaining('medianGeneExpression')[0];
    expect(medianUrl).toContain('gencodeId=ENSG00000141510.18');
    expect(medianUrl).toContain('datasetId=gtex_v10');
    expect(medianUrl).not.toContain('tissueSiteDetailId=');

    expect(result).toEqual({
      gene_symbol: 'TP53',
      gencode_id: 'ENSG00000141510.18',
      dataset: 'gtex_v10',
      unit: 'TPM',
      tissues: [
        { tissue: 'Adipose_Subcutaneous', median_tpm: 22.65, ontology_id: 'UBERON:0002190' },
        { tissue: 'Whole_Blood', median_tpm: 12.03, ontology_id: 'UBERON:0000178' },
        { tissue: 'Muscle_Skeletal', median_tpm: 5.12, ontology_id: 'UBERON:0002378' },
      ],
    });
  });

  test('tissue filter is passed through', async () => {
    const { gtexMedianExpression } = await loadGtex();
    mockFetchRoutes(defaultRoutes());

    await gtexMedianExpression('TP53', { tissueSiteDetailId: 'Whole_Blood' });

    expect(urlsContaining('medianGeneExpression')[0]).toContain('tissueSiteDetailId=Whole_Blood');
  });

  test('limit takes top-N tissues after sorting', async () => {
    const { gtexMedianExpression } = await loadGtex();
    mockFetchRoutes(defaultRoutes());

    const result = expectMedianResult(await gtexMedianExpression('TP53', { limit: 2 }));

    expect(result.tissues.map(t => t.tissue)).toEqual(['Adipose_Subcutaneous', 'Whole_Blood']);
  });

  test('empty data yields empty tissues, not an error', async () => {
    const { gtexMedianExpression } = await loadGtex();
    mockFetchRoutes(defaultRoutes({ '/api/v2/expression/medianGeneExpression': () => ({ data: [] }) }));

    const result = expectMedianResult(await gtexMedianExpression('TP53'));

    expect(result.tissues).toEqual([]);
    expect(result.unit).toBe('TPM');
    expect(result.gencode_id).toBe('ENSG00000141510.18');
  });

  test('gene that cannot be resolved returns a structured _error envelope (not a throw)', async () => {
    const { gtexMedianExpression } = await loadGtex();
    mockFetchRoutes(defaultRoutes({ '/api/v2/reference/geneSearch': () => GENE_SEARCH_NO_MATCH }));

    const result = await gtexMedianExpression('NOT_A_GENE');

    // #132: deterministic lookup failures surface as the house envelope
    // {_error, source, retryable} instead of a raw throw.
    expect(result).toMatchObject({ source: 'gtex', retryable: false });
    if (!('_error' in result)) throw new Error('expected a _error envelope');
    expect(result._error).toContain('GTEx request failed');
    expect(result._error).toContain("Gene 'NOT_A_GENE' not found in GTEx v10 gene reference");
    expect(result._error).not.toContain('Usually transient'); // wrong remedy for a deterministic miss
  });

  test('upstream 5xx returns a structured _error envelope classified retryable', async () => {
    const { gtexMedianExpression } = await loadGtex();
    mockFetchRoutes(defaultRoutes({
      '/api/v2/expression/medianGeneExpression': () => ({
        ok: false,
        status: 503,
        statusText: 'Service Unavailable',
        json: () => Promise.resolve({}),
        headers: new Headers({ 'content-type': 'application/json' }),
      } as any),
    }));

    const result = await gtexMedianExpression('TP53');

    expect(result).toMatchObject({ source: 'gtex', retryable: true });
    if (!('_error' in result)) throw new Error('expected a _error envelope');
    expect(result._error).toContain('GTEx request failed');
    expect(result._error).toContain('HTTP 503');
    expect(result._error).toContain('Usually transient — retry once or twice, or try later.');
    // gtex retries once (attempts: 2) before the envelope: two fetches.
    expect(urlsContaining('medianGeneExpression')).toHaveLength(2);
  });
});

describe('gtexEqtl', () => {
  mockGlobalFetch();

  beforeEach(() => {
    jest.clearAllMocks();
    connectionManager.closeAll();
  });

  test('invalid tissue returns a structured _error envelope (hint preserved, no association fetch)', async () => {
    const { gtexEqtl } = await loadGtex();
    mockFetchRoutes(defaultRoutes());

    const result = await gtexEqtl('TP53', 'Not_A_Tissue');

    // #132: validation failures surface as the house envelope, carrying the
    // original hint verbatim, classified non-retryable.
    expect(result).toMatchObject({ source: 'gtex', retryable: false });
    if (!('_error' in result)) throw new Error('expected a _error envelope');
    expect(result._error).toContain("Invalid tissue 'Not_A_Tissue'");
    expect(result._error).toContain("'Brain_Cortex', 'Whole_Blood'");
    expect(result._error).toContain('3 tissues in gtex_v10');
    expect(urlsContaining('singleTissueEqtl')).toHaveLength(0);
  });

  test('empty association list is a legitimate result, not an error', async () => {
    const { gtexEqtl } = await loadGtex();
    mockFetchRoutes(defaultRoutes({ '/api/v2/association/singleTissueEqtl': () => ({ data: [] }) }));

    const result = expectEqtlResult(await gtexEqtl('TP53', 'Whole_Blood'));

    expect(result).toEqual({
      gene_symbol: 'TP53',
      gencode_id: 'ENSG00000141510.18',
      tissue: 'Whole_Blood',
      associations: [],
      note: 'TP53 has no significant cis-eQTLs in any GTEx v10 tissue',
    });
  });

  test('empty in the queried tissue triggers one all-tissues diagnostic call whose note ranks other tissues', async () => {
    const { gtexEqtl } = await loadGtex();
    // Tissue-scoped query: empty. All-tissues query: rows in 7 tissues with
    // distinct-enough counts to pin the ranking (ties fall back to the order
    // tissues first appear in the response).
    const allTissuesRows = [
      ...Array(4).fill(0).map((_, i) => ({ variantId: `kc_${i}`, pValue: 1e-5, nes: 0.2, tissueSiteDetailId: 'Kidney_Cortex' })),
      ...Array(3).fill(0).map((_, i) => ({ variantId: `nt_${i}`, pValue: 1e-5, nes: -0.1, tissueSiteDetailId: 'Nerve_Tibial' })),
      ...Array(2).fill(0).map((_, i) => ({ variantId: `haa_${i}`, pValue: 1e-5, nes: 0.3, tissueSiteDetailId: 'Heart_Atrial_Appendage' })),
      ...Array(2).fill(0).map((_, i) => ({ variantId: `snse_${i}`, pValue: 1e-5, nes: 0.4, tissueSiteDetailId: 'Skin_Not_Sun_Exposed' })),
      { variantId: 'em_0', pValue: 1e-5, nes: 0.5, tissueSiteDetailId: 'Esophagus_Muscularis' },
      { variantId: 'fb_0', pValue: 1e-5, nes: -0.2, tissueSiteDetailId: 'Fibroblasts' },
      { variantId: 'pit_0', pValue: 1e-5, nes: 0.6, tissueSiteDetailId: 'Pituitary' },
    ];
    mockFetchRoutes(defaultRoutes({
      '/api/v2/association/singleTissueEqtl': (url) =>
        url.searchParams.has('tissueSiteDetailId') ? { data: [] } : { data: allTissuesRows },
    }));

    const result = expectEqtlResult(await gtexEqtl('TP53', 'Whole_Blood'));

    // Exactly two association fetches: scoped, then the all-tissues diagnostic.
    const eqtlUrls = urlsContaining('singleTissueEqtl');
    expect(eqtlUrls).toHaveLength(2);
    expect(eqtlUrls[0]).toContain('tissueSiteDetailId=Whole_Blood');
    expect(eqtlUrls[0]).toContain('gencodeId=ENSG00000141510.18');
    expect(eqtlUrls[0]).toContain('datasetId=gtex_v10');
    expect(eqtlUrls[1]).not.toContain('tissueSiteDetailId=');
    expect(eqtlUrls[1]).toContain('gencodeId=ENSG00000141510.18');
    expect(eqtlUrls[1]).toContain('datasetId=gtex_v10');

    expect(result.associations).toEqual([]);
    expect(result.note).toBe(
      'TP53 has no significant cis-eQTLs in Whole_Blood in GTEx v10, but has 14 in other tissues: '
      + 'Kidney_Cortex (4), Nerve_Tibial (3), Heart_Atrial_Appendage (2), Skin_Not_Sun_Exposed (2), '
      + 'Esophagus_Muscularis (1), and 2 more'
    );
  });

  test('empty everywhere yields the any-tissue note', async () => {
    const { gtexEqtl } = await loadGtex();
    // Both the scoped and the diagnostic query return empty data.
    let calls = 0;
    mockFetchRoutes(defaultRoutes({
      '/api/v2/association/singleTissueEqtl': () => {
        calls += 1;
        return { data: [] };
      },
    }));

    const result = expectEqtlResult(await gtexEqtl('TP53', 'Brain_Cortex'));

    expect(result.associations).toEqual([]);
    expect(result.note).toBe('TP53 has no significant cis-eQTLs in any GTEx v10 tissue');
    expect(calls).toBe(2);
  });

  test('a failed diagnostic call does not fail the empty result', async () => {
    const { gtexEqtl } = await loadGtex();
    let calls = 0;
    mockFetchRoutes(defaultRoutes({
      '/api/v2/association/singleTissueEqtl': (url) => {
        calls += 1;
        if (!url.searchParams.has('tissueSiteDetailId')) throw new Error('diagnostic down');
        return { data: [] };
      },
    }));

    const result = expectEqtlResult(await gtexEqtl('TP53', 'Whole_Blood'));

    expect(result.associations).toEqual([]);
    expect(result.note).toBeUndefined();
    expect(calls).toBe(2);
  });

  test('associations are sorted by pValue ascending and limited', async () => {
    const { gtexEqtl } = await loadGtex();
    mockFetchRoutes(defaultRoutes());

    const result = expectEqtlResult(await gtexEqtl('TP53', 'Whole_Blood', { limit: 2 }));

    const eqtlUrl = urlsContaining('singleTissueEqtl')[0];
    expect(eqtlUrl).toContain('gencodeId=ENSG00000141510.18');
    expect(eqtlUrl).toContain('datasetId=gtex_v10');
    expect(eqtlUrl).toContain('tissueSiteDetailId=Whole_Blood');

    expect(result.associations.map(a => a.p_value)).toEqual([1.2e-12, 2.1e-8]);
    expect(result.associations[0].variant_id).toBe('chr17_7676409_C_T_b38');
    expect(result.associations[0]).toMatchObject({ nes: -0.28 });
  });

  test('non-empty tissue result makes exactly one association fetch and carries no note', async () => {
    const { gtexEqtl } = await loadGtex();
    mockFetchRoutes(defaultRoutes());

    const result = expectEqtlResult(await gtexEqtl('TP53', 'Whole_Blood'));

    expect(urlsContaining('singleTissueEqtl')).toHaveLength(1);
    expect(result.associations.length).toBeGreaterThan(0);
    expect('note' in result).toBe(false);
  });

  test('upstream network rejection returns a structured _error envelope classified retryable', async () => {
    const { gtexEqtl } = await loadGtex();
    const networkReject = Object.assign(new TypeError('fetch failed'), { cause: { code: 'ECONNREFUSED' } });
    mockFetchRoutes(defaultRoutes({
      '/api/v2/association/singleTissueEqtl': () => {
        throw networkReject;
      },
    }));

    const result = await gtexEqtl('TP53', 'Whole_Blood');

    // #132: the raw HttpConnectionError throw is gone; the envelope names
    // the cause signal (cause.code appended by errorMessageWithCause).
    expect(result).toMatchObject({ source: 'gtex', retryable: true });
    if (!('_error' in result)) throw new Error('expected a _error envelope');
    expect(result._error).toContain('GTEx request failed');
    expect(result._error).toContain('fetch failed (ECONNREFUSED)');
    expect(result._error).toContain('Usually transient — retry once or twice, or try later.');
    // gtex retries once (attempts: 2): two association fetches.
    expect(urlsContaining('singleTissueEqtl')).toHaveLength(2);
  });

  test('HTTP 422 from the API surfaces as a non-retryable _error envelope', async () => {
    const { gtexEqtl } = await loadGtex();
    mockFetchRoutes(defaultRoutes({
      '/api/v2/association/singleTissueEqtl': () => ({
        ok: false,
        status: 422,
        statusText: 'Unprocessable Entity',
        json: () => Promise.resolve({ detail: [{ type: 'enum', loc: ['query', 'tissueSiteDetailId'], msg: 'Input should be a valid tissue' }] }),
        headers: new Headers({ 'content-type': 'application/json' }),
      } as any),
    }));

    const result = await gtexEqtl('TP53', 'Whole_Blood');

    expect(result).toMatchObject({ source: 'gtex', retryable: false });
    if (!('_error' in result)) throw new Error('expected a _error envelope');
    expect(result._error).toContain('HTTP 422');
    expect(result._error).toContain('Unprocessable Entity');
  });
});

describe('getGtexTissues', () => {
  mockGlobalFetch();

  beforeEach(() => {
    jest.clearAllMocks();
    connectionManager.closeAll();
  });

  test('returns tissue details and caches across calls', async () => {
    const { getGtexTissues } = await loadGtex();
    mockFetchRoutes(defaultRoutes());

    const first = await getGtexTissues();
    const second = await getGtexTissues();

    expect(first).toHaveLength(3);
    expect(first[0]).toEqual({
      tissueSiteDetailId: 'Adipose_Subcutaneous',
      tissueSiteDetail: 'Adipose - Subcutaneous',
      tissueSiteDetailAbbr: 'ADPSBQ',
      ontologyId: 'UBERON:0002190',
      eGeneCount: 17562,
    });
    expect(second).toBe(first);
    expect(urlsContaining('tissueSiteDetail')).toHaveLength(1);
  });
});
