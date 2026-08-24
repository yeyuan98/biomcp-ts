import { jest, describe, it, expect, beforeAll, afterAll, beforeEach, afterEach } from '@jest/globals';
import { connectionManager } from '../../connections/manager.js';
import { createMcpTestHarness, type McpTestHarness } from '../helpers/mcp-harness.js';

const DATASETS = [
  {
    datasetId: 'gtex_v8',
    displayName: 'GTEx Analysis v8',
    gencodeVersion: 'v26',
    genomeBuild: 'GRCh38/hg38',
    tissueCount: 54,
  },
  {
    datasetId: 'gtex_v10',
    displayName: 'GTEx Analysis v10',
    gencodeVersion: 'v39',
    genomeBuild: 'GRCh38/hg38',
    tissueCount: 54,
  },
];

const GENE_SEARCH_TP53 = {
  data: [
    { gencodeId: 'ENSG00000143514.17', geneSymbol: 'TP53BP2', geneSymbolUpper: 'TP53BP2' },
    { gencodeId: 'ENSG00000141510.18', geneSymbol: 'TP53', geneSymbolUpper: 'TP53', entrezGeneId: 7157 },
  ],
  paging_info: { numberOfPages: 1, page: 0 },
};

const MEDIAN_TP53_UNSORTED = {
  data: [
    { median: 5.12, tissueSiteDetailId: 'Muscle_Skeletal', ontologyId: 'UBERON:0002378', unit: 'TPM' },
    { median: 22.65, tissueSiteDetailId: 'Adipose_Subcutaneous', ontologyId: 'UBERON:0002190', unit: 'TPM' },
    { median: 12.03, tissueSiteDetailId: 'Whole_Blood', ontologyId: 'UBERON:0000178', unit: 'TPM' },
  ],
};

const EQTL_TP53_UNSORTED = {
  data: [
    { variantId: 'chr17_7676153_C_T_b38', pValue: 2.1e-8, nes: 0.35, slope: 0.12 },
    { variantId: 'chr17_7676409_C_T_b38', pValue: 1.2e-12, nes: -0.28, slope: -0.09 },
    { variantId: 'chr17_7676582_A_G_b38', pValue: 4.5e-6, nes: 0.11, slope: 0.05 },
  ],
};

const TISSUES = {
  data: [
    { tissueSiteDetailId: 'Adipose_Subcutaneous', tissueSiteDetail: 'Adipose - Subcutaneous', eGeneCount: 17562 },
    { tissueSiteDetailId: 'Brain_Cortex', tissueSiteDetail: 'Brain - Cortex', eGeneCount: 11131 },
    { tissueSiteDetailId: 'Whole_Blood', tissueSiteDetail: 'Whole Blood', eGeneCount: 9018 },
  ],
};

function okJson(body: unknown) {
  return {
    ok: true,
    status: 200,
    statusText: 'OK',
    headers: new Headers({ 'content-type': 'application/json' }),
    json: () => Promise.resolve(body),
  };
}

type RouteHandler = (url: URL) => unknown;

function mockFetchRoutes(routes: Record<string, RouteHandler>): void {
  global.fetch = jest.fn().mockImplementation((rawUrl: string) => {
    const url = new URL(rawUrl);
    for (const [prefix, handler] of Object.entries(routes)) {
      if (url.pathname.startsWith(prefix)) {
        return Promise.resolve(okJson(handler(url)));
      }
    }
    return Promise.resolve(okJson({}));
  }) as any;
}

function defaultRoutes(): Record<string, RouteHandler> {
  return {
    '/api/v2/metadata/dataset': () => DATASETS,
    '/api/v2/reference/geneSearch': () => GENE_SEARCH_TP53,
    '/api/v2/expression/medianGeneExpression': () => MEDIAN_TP53_UNSORTED,
    '/api/v2/association/singleTissueEqtl': () => EQTL_TP53_UNSORTED,
    '/api/v2/dataset/tissueSiteDetail': () => TISSUES,
  };
}

function fetchUrls(): string[] {
  return (global.fetch as any).mock.calls.map((c: any[]) => c[0] as string);
}

describe('gtex tools', () => {
  let harness: McpTestHarness;
  let originalFetch: typeof global.fetch;

  beforeAll(async () => {
    harness = await createMcpTestHarness();
  });

  afterAll(async () => {
    await harness.close();
  });

  beforeEach(() => {
    jest.clearAllMocks();
    originalFetch = global.fetch;
    connectionManager.closeAll();
  });

  afterEach(() => {
    global.fetch = originalFetch;
  });

  it('gtex_expression returns tissues sorted by descending median TPM', async () => {
    mockFetchRoutes(defaultRoutes());

    const result = (await harness.callTool('gtex_expression', { gene: 'TP53' })) as any;

    expect(result).toMatchObject({
      gene_symbol: 'TP53',
      gencode_id: 'ENSG00000141510.18',
      dataset: 'gtex_v10',
      unit: 'TPM',
    });
    expect(result.tissues.map((t: any) => t.tissue)).toEqual([
      'Adipose_Subcutaneous',
      'Whole_Blood',
      'Muscle_Skeletal',
    ]);
    expect(result.tissues.map((t: any) => t.median_tpm)).toEqual([22.65, 12.03, 5.12]);
  });

  it('gtex_expression passes the tissue filter to the API and honors limit', async () => {
    mockFetchRoutes(defaultRoutes());

    const result = (await harness.callTool('gtex_expression', {
      gene: 'TP53',
      tissue: 'Whole_Blood',
      limit: 1,
    })) as any;

    expect(result.tissues).toHaveLength(1);
    const expressionUrl = fetchUrls().find(u => u.includes('medianGeneExpression'))!;
    expect(new URL(expressionUrl).searchParams.get('tissueSiteDetailId')).toBe('Whole_Blood');
  });

  it('gtex_eqtl returns associations sorted by ascending p-value', async () => {
    mockFetchRoutes(defaultRoutes());

    const result = (await harness.callTool('gtex_eqtl', { gene: 'TP53', tissue: 'Whole_Blood' })) as any;

    expect(result).toMatchObject({
      gene_symbol: 'TP53',
      gencode_id: 'ENSG00000141510.18',
      tissue: 'Whole_Blood',
    });
    expect(result.associations.map((a: any) => a.variant_id)).toEqual([
      'chr17_7676409_C_T_b38',
      'chr17_7676153_C_T_b38',
      'chr17_7676582_A_G_b38',
    ]);
    expect(result.associations[0].p_value).toBe(1.2e-12);
  });

  it('gtex_eqtl rejects an unknown tissueSiteDetailId with isError', async () => {
    mockFetchRoutes(defaultRoutes());

    await expect(harness.callTool('gtex_eqtl', { gene: 'TP53', tissue: 'Not_A_Tissue' })).rejects.toThrow(
      /Invalid tissue 'Not_A_Tissue'/
    );
  });
});
