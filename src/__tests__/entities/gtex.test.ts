import { jest } from '@jest/globals';
import { connectionManager } from '../../connections/manager.js';

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
    { variantId: 'chr17_7676153_C_T_b38', geneSymbol: 'TP53', gencodeId: 'ENSG00000141510.18', tissueSiteDetailId: 'Thyroid', pValue: 2.1e-8, nes: 0.35, slope: 0.12 },
    { variantId: 'chr17_7676409_C_T_b38', geneSymbol: 'TP53', gencodeId: 'ENSG00000141510.18', tissueSiteDetailId: 'Thyroid', pValue: 1.2e-12, nes: -0.28, slope: -0.09 },
    { variantId: 'chr17_7676582_A_G_b38', geneSymbol: 'TP53', gencodeId: 'ENSG00000141510.18', tissueSiteDetailId: 'Thyroid', pValue: 4.5e-6, nes: 0.11, slope: 0.05 },
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
  global.fetch = jest.fn().mockImplementation((rawUrl: string) => {
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

function callUrls(): string[] {
  return (global.fetch as any).mock.calls.map((c: any[]) => c[0] as string);
}

function urlsContaining(fragment: string): string[] {
  return callUrls().filter(u => u.includes(fragment));
}

describe('gtex dataset metadata', () => {
  let originalFetch: typeof global.fetch;

  beforeEach(() => {
    jest.clearAllMocks();
    originalFetch = global.fetch;
    connectionManager.closeAll();
  });

  afterEach(() => {
    global.fetch = originalFetch;
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
  let originalFetch: typeof global.fetch;

  beforeEach(() => {
    jest.clearAllMocks();
    originalFetch = global.fetch;
    connectionManager.closeAll();
  });

  afterEach(() => {
    global.fetch = originalFetch;
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
  let originalFetch: typeof global.fetch;

  beforeEach(() => {
    jest.clearAllMocks();
    originalFetch = global.fetch;
    connectionManager.closeAll();
  });

  afterEach(() => {
    global.fetch = originalFetch;
  });

  test('resolves versioned gencodeId and queries gtex_v10', async () => {
    const { gtexMedianExpression } = await loadGtex();
    mockFetchRoutes(defaultRoutes());

    const result = await gtexMedianExpression('TP53');

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

    const result = await gtexMedianExpression('TP53', { limit: 2 });

    expect(result.tissues.map(t => t.tissue)).toEqual(['Adipose_Subcutaneous', 'Whole_Blood']);
  });

  test('empty data yields empty tissues, not an error', async () => {
    const { gtexMedianExpression } = await loadGtex();
    mockFetchRoutes(defaultRoutes({ '/api/v2/expression/medianGeneExpression': () => ({ data: [] }) }));

    const result = await gtexMedianExpression('TP53');

    expect(result.tissues).toEqual([]);
    expect(result.unit).toBe('TPM');
    expect(result.gencode_id).toBe('ENSG00000141510.18');
  });

  test('gene that cannot be resolved throws a readable error', async () => {
    const { gtexMedianExpression } = await loadGtex();
    mockFetchRoutes(defaultRoutes({ '/api/v2/reference/geneSearch': () => GENE_SEARCH_NO_MATCH }));

    await expect(gtexMedianExpression('NOT_A_GENE')).rejects.toThrow("Gene 'NOT_A_GENE' not found in GTEx v10 gene reference");
  });
});

describe('gtexEqtl', () => {
  let originalFetch: typeof global.fetch;

  beforeEach(() => {
    jest.clearAllMocks();
    originalFetch = global.fetch;
    connectionManager.closeAll();
  });

  afterEach(() => {
    global.fetch = originalFetch;
  });

  test('invalid tissue throws with hint listing valid tissue count', async () => {
    const { gtexEqtl } = await loadGtex();
    mockFetchRoutes(defaultRoutes());

    await expect(gtexEqtl('TP53', 'Not_A_Tissue')).rejects.toThrow(
      "Invalid tissue 'Not_A_Tissue'. Use gtex tissues like 'Brain_Cortex', 'Whole_Blood' — see dataset/tissueSiteDetail (3 tissues in gtex_v10)"
    );
    expect(urlsContaining('singleTissueEqtl')).toHaveLength(0);
  });

  test('empty association list is a legitimate result, not an error', async () => {
    const { gtexEqtl } = await loadGtex();
    mockFetchRoutes(defaultRoutes({ '/api/v2/association/singleTissueEqtl': () => ({ data: [] }) }));

    const result = await gtexEqtl('TP53', 'Whole_Blood');

    expect(result).toEqual({
      gene_symbol: 'TP53',
      gencode_id: 'ENSG00000141510.18',
      tissue: 'Whole_Blood',
      associations: [],
    });
  });

  test('associations are sorted by pValue ascending and limited', async () => {
    const { gtexEqtl } = await loadGtex();
    mockFetchRoutes(defaultRoutes());

    const result = await gtexEqtl('TP53', 'Whole_Blood', { limit: 2 });

    const eqtlUrl = urlsContaining('singleTissueEqtl')[0];
    expect(eqtlUrl).toContain('gencodeId=ENSG00000141510.18');
    expect(eqtlUrl).toContain('datasetId=gtex_v10');
    expect(eqtlUrl).toContain('tissueSiteDetailId=Whole_Blood');

    expect(result.associations.map(a => a.p_value)).toEqual([1.2e-12, 2.1e-8]);
    expect(result.associations[0].variant_id).toBe('chr17_7676409_C_T_b38');
    expect(result.associations[0]).toMatchObject({ nes: -0.28, slope: -0.09 });
  });

  test('HTTP 422 from the API surfaces as a readable Error', async () => {
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

    await expect(gtexEqtl('TP53', 'Whole_Blood')).rejects.toThrow('HTTP 422');
  });
});

describe('getGtexTissues', () => {
  let originalFetch: typeof global.fetch;

  beforeEach(() => {
    jest.clearAllMocks();
    originalFetch = global.fetch;
    connectionManager.closeAll();
  });

  afterEach(() => {
    global.fetch = originalFetch;
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
