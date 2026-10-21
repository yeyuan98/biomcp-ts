import { jest, describe, it, expect, beforeAll, afterAll, beforeEach, afterEach } from '@jest/globals';
import { connectionManager } from '../../connections/manager.js';
import { createMcpTestHarness, type McpTestHarness } from '../helpers/mcp-harness.js';
import { mockGlobalFetch } from '../helpers/mock-fetch.js';

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

/** Non-OK JSON error response shaped like Ensembl's VEP 400s — rest.ts reads
 *  `text()` to embed the upstream explanation in the thrown error message. */
function errJson(status: number, body: unknown) {
  return {
    ok: false,
    status,
    statusText: 'Bad Request',
    headers: new Headers({ 'content-type': 'application/json' }),
    text: () => Promise.resolve(JSON.stringify(body)),
    json: () => Promise.resolve(body),
  };
}

function mockFetchRoutes(routes: Record<string, (url: URL) => unknown>): void {
  global.fetch = jest.fn<(...args: any[]) => any>().mockImplementation((rawUrl: string) => {
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
  mockGlobalFetch();

  beforeAll(async () => {
    harness = await createMcpTestHarness();
  });

  afterAll(async () => {
    await harness.close();
  });

  beforeEach(() => {
    connectionManager.closeAll();
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
    // Unversioned input: no retry, no warnings.
    expect(fetchUrls()).toHaveLength(1);
    expect(result.warnings).toBeUndefined();
  });

  // Issue #194: Ensembl's VEP indexes only the RefSeq transcript versions of
  // its current release, so a stale-versioned accession 400s with the exact
  // upstream signature below — biomcp retries once with the bare accession
  // and flags the coordinate reinterpretation in warnings.
  it('ensembl_consequence retries a stale versioned RefSeq with the bare accession and warns', async () => {
    let vepCalls = 0;
    global.fetch = jest.fn<(...args: any[]) => any>().mockImplementation((rawUrl: string) => {
      if (new URL(rawUrl).pathname.startsWith('/vep/')) {
        vepCalls++;
        if (vepCalls === 1) {
          return Promise.resolve(
            errJson(400, { error: "Could not get a Transcript object for 'NM_004333.4'" })
          );
        }
        return Promise.resolve(okJson(VEP_RESPONSE));
      }
      return Promise.resolve(okJson({}));
    }) as any;

    const result = (await harness.callTool('ensembl_consequence', { variant: 'NM_004333.4:c.1799T>A' })) as any;

    expect(result.most_severe_consequence).toBe('missense_variant');
    expect(result.warnings).toHaveLength(2);
    expect(result.warnings[0]).toContain('RefSeq version .4 not carried by the current Ensembl release');
    expect(result.warnings[0]).toContain('verify the protein change against your source report');
    // Served transcript id (+version when upstream includes it) from the
    // most-severe-consequence row of the existing result parsing.
    expect(result.warnings[1]).toBe('Most severe consequence served on transcript ENST00000288602');
    const urls = fetchUrls().map(decodeURIComponent);
    expect(urls).toHaveLength(2);
    expect(urls[0]).toContain('/vep/human/hgvs/NM_004333.4:c.1799T>A');
    // Retry strips ONLY the transcript accession's version — the variant
    // part survives verbatim.
    expect(urls[1]).toContain('/vep/human/hgvs/NM_004333:c.1799T>A');
  });

  it('ensembl_consequence propagates unrelated 400s without the bare-accession retry', async () => {
    global.fetch = jest.fn<(...args: any[]) => any>().mockImplementation((rawUrl: string) => {
      if (new URL(rawUrl).pathname.startsWith('/vep/')) {
        // Versioned input, but the upstream failure is a ref-allele
        // mismatch — NOT the missing-transcript-version signature.
        return Promise.resolve(
          errJson(400, { error: 'Reference allele mismatch: expected T, found A' })
        );
      }
      return Promise.resolve(okJson({}));
    }) as any;

    await expect(
      harness.callTool('ensembl_consequence', { variant: 'NM_004333.4:c.1799T>A' })
    ).rejects.toThrow(/Upstream: Reference allele mismatch/);
    // No retry: exactly one upstream request was made.
    expect(fetchUrls()).toHaveLength(1);
  });

  it('ensembl_region returns features for an interval via split feature requests', async () => {
    mockFetchRoutes({ '/overlap/region': () => OVERLAP_FEATURES });

    const result = (await harness.callTool('ensembl_region', { region: '7:140450000-140480000' })) as any;

    expect(result.features[0].symbol).toBe('MKRN1');
    const urls = fetchUrls();
    expect(urls).toHaveLength(2);
    expect(urls).toContainEqual(expect.stringContaining('?feature=gene'));
    expect(urls).toContainEqual(expect.stringContaining('?feature=variation'));
    // 30 kb span: below the 50 kb variation cap → full window echoed, no truncation.
    expect(result.effective_variation_window).toEqual({ chr: '7', start: 140450000, end: 140480000 });
    expect(result.variation_truncated).toBeUndefined();
  });

  it('ensembl_region caps variation to a 50kb center window on large spans', async () => {
    mockFetchRoutes({ '/overlap/region': () => OVERLAP_FEATURES });

    const result = (await harness.callTool('ensembl_region', { region: '7:140700000-140950000' })) as any;

    const urls = fetchUrls();
    expect(urls).toContainEqual(
      expect.stringContaining('/overlap/region/human/7:140700000-140950000?feature=gene')
    );
    expect(urls).toContainEqual(
      expect.stringContaining('/overlap/region/human/7:140800000-140849999?feature=variation')
    );
    expect(result.effective_variation_window).toEqual({ chr: '7', start: 140800000, end: 140849999 });
    expect(result.variation_truncated).toContain('7:140800000-140849999');
  });

  it('ensembl_region rejects malformed regions via isError', async () => {
    mockFetchRoutes({});

    await expect(
      harness.callTool('ensembl_region', { region: 'not-a-region' })
    ).rejects.toThrow(/Invalid region/);
  });
});
