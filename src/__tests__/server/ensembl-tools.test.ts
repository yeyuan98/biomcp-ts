import { jest, describe, it, expect, beforeAll, afterAll, beforeEach, afterEach } from '@jest/globals';
import { connectionManager } from '../../connections/manager.js';
import { createMcpTestHarness, type McpTestHarness } from '../helpers/mcp-harness.js';

const LOOKUP_BRAF = {
  id: 'ENSG00000157764',
  display_name: 'BRAF',
  biotype: 'protein_coding',
  version: 16,
  assembly_name: 'GRCh38',
  seq_region_name: '7',
  start: 140719327,
  end: 140925199,
  strand: -1,
  canonical_transcript: 'ENST00000646891.2',
};

const HOMOLOGY_RESPONSE = {
  data: [
    {
      id: 'ENSG00000157764',
      homologies: [
        {
          type: 'ortholog_one2one',
          taxonomy_level: 'Vertebrates',
          source: { id: 'ENSG00000157764', species: 'homo_sapiens' },
          target: { id: 'ENSMUSG00000002413', species: 'mus_musculus', taxon_id: 10090, perc_id: 87.6866 },
        },
      ],
    },
  ],
};

const VEP_RESPONSE = [
  {
    most_severe_consequence: 'missense_variant',
    transcript_consequences: [
      {
        transcript_id: 'ENST00000288602',
        gene_symbol: 'BRAF',
        consequence_terms: ['missense_variant'],
        impact: 'MODERATE',
        amino_acids: 'V/E',
        sift_prediction: 'deleterious_low_confidence',
      },
    ],
    colocated_variants: [{ id: 'rs113488060', source: 'ClinVar', clin_sig: ['pathogenic'] }],
  },
];

const OVERLAP_FEATURES = [
  { feature_type: 'gene', gene_id: 'ENSG00000133606', external_name: 'MKRN1', seq_region_name: '7', start: 140450000, end: 140461000, strand: -1 },
];

function okJson(body: unknown) {
  return {
    ok: true,
    status: 200,
    statusText: 'OK',
    headers: new Headers({ 'content-type': 'application/json' }),
    json: () => Promise.resolve(body),
  };
}

function mockFetchRoutes(routes: Record<string, (url: URL) => unknown>): void {
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

function fetchUrls(): string[] {
  return (global.fetch as any).mock.calls.map((c: any[]) => c[0] as string);
}

describe('ensembl tools', () => {
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

  it('ensembl_lookup resolves a symbol to Ensembl metadata', async () => {
    mockFetchRoutes({ '/lookup/symbol': () => LOOKUP_BRAF });

    const result = (await harness.callTool('ensembl_lookup', { gene_or_id: 'BRAF' })) as any;

    expect(result.id).toBe('ENSG00000157764');
    expect(result.canonical_transcript).toBe('ENST00000646891.2');
    expect(fetchUrls()[0]).toContain('/lookup/symbol/human/BRAF');
  });

  it('ensembl_homology maps orthologues with percent identity', async () => {
    mockFetchRoutes({
      '/lookup/symbol': () => LOOKUP_BRAF,
      '/homology/id': () => HOMOLOGY_RESPONSE,
    });

    const result = (await harness.callTool('ensembl_homology', { gene: 'BRAF' })) as any;

    expect(result.type).toBe('orthologues');
    expect(result.homologies[0].target.id).toBe('ENSMUSG00000002413');
    expect(result.homologies[0].target.perc_id).toBeCloseTo(87.6866);
  });

  it('ensembl_consequence returns VEP consequences for HGVS input', async () => {
    mockFetchRoutes({ '/vep/': () => VEP_RESPONSE });

    const result = (await harness.callTool('ensembl_consequence', { variant: 'NM_004333:c.1799T>A' })) as any;

    expect(result.most_severe_consequence).toBe('missense_variant');
    expect(result.consequences[0].gene_symbol).toBe('BRAF');
    expect(decodeURIComponent(fetchUrls()[0])).toContain('/vep/human/hgvs/NM_004333:c.1799T>A');
  });

  it('ensembl_region returns features for an interval', async () => {
    mockFetchRoutes({ '/overlap/region': () => OVERLAP_FEATURES });

    const result = (await harness.callTool('ensembl_region', { region: '7:140450000-140480000' })) as any;

    expect(result.features[0].symbol).toBe('MKRN1');
    expect(fetchUrls()[0]).toContain('?feature=gene;feature=variation');
  });

  it('ensembl_region rejects malformed regions via isError', async () => {
    mockFetchRoutes({});

    await expect(
      harness.callTool('ensembl_region', { region: 'not-a-region' })
    ).rejects.toThrow(/Invalid region/);
  });
});
