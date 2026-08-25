import { jest, describe, it, expect, beforeEach, afterEach } from '@jest/globals';
import { connectionManager } from '../../connections/manager.js';

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

const TRANSCRIPTS = [
  {
    id: 'ENST00000646891',
    version: 2,
    biotype: 'protein_coding',
    is_canonical: 1,
    display_name: 'BRAF-202',
    Translation: { id: 'ENSP00000493543', length: 723 },
    Exon: [{}, {}, {}],
  },
  {
    id: 'ENST00000288602',
    version: 13,
    biotype: 'protein_coding',
    is_canonical: 0,
    display_name: 'BRAF-201',
    Translation: { id: 'ENSP00000288602', length: 806 },
    Exon: [{}, {}],
  },
];

const HOMOLOGY_RESPONSE = {
  data: [
    {
      id: 'ENSG00000157764',
      homologies: [
        {
          type: 'ortholog_one2one',
          method_link_type: 'ENSEMBL_ORTHOLOGUES',
          taxonomy_level: 'Vertebrates',
          source: { id: 'ENSG00000157764', species: 'homo_sapiens' },
          target: { id: 'ENSMUSG00000002413', species: 'mus_musculus', taxon_id: 10090, protein_id: 'ENSMUSP00000029397', perc_id: 87.6866 },
        },
        {
          type: 'ortholog_one2many',
          taxonomy_level: 'Vertebrates',
          source: { id: 'ENSG00000157764', species: 'homo_sapiens' },
          target: { id: 'ENSDARG00000103202', species: 'danio_rerio', taxon_id: 7955, perc_id: null },
        },
        {
          type: 'ortholog_one2one',
          taxonomy_level: 'Mammals',
          source: { id: 'ENSG00000157764', species: 'homo_sapiens' },
          target: { id: 'ENSFCAG00000004233', species: 'felis_catus', taxon_id: 9685, perc_id: 94.2 },
        },
      ],
    },
  ],
};

const VEP_HGVS_RESPONSE = {
  input: 'NM_004333:c.1799T>A',
  most_severe_consequence: 'missense_variant',
  allele_string: 'A/T',
  colocated_variants: [
    { id: 'rs113488060', source: 'ClinVar', clin_sig: ['pathogenic'], frequencies: { gnomadg: 0.0063 } },
    { id: 'COSV56107175', source: 'COSMIC', clin_sig: [] },
    { id: 'extra1' }, { id: 'extra2' }, { id: 'extra3' }, { id: 'should_be_dropped' },
  ],
  transcript_consequences: [
    {
      transcript_id: 'ENST00000288602',
      gene_id: 'ENSG00000157764',
      gene_symbol: 'BRAF',
      biotype: 'protein_coding',
      consequence_terms: ['missense_variant'],
      impact: 'MODERATE',
      codons: 'gTg/gAg',
      amino_acids: 'V/E',
      protein_start: 640,
      protein_end: 640,
      sift_score: 0,
      sift_prediction: 'deleterious_low_confidence',
      polyphen_score: 0.43,
      polyphen_prediction: 'benign',
    },
    {
      transcript_id: 'ENST00000496384',
      gene_id: 'ENSG00000157764',
      consequence_terms: ['stop_gained'],
      impact: 'HIGH',
    },
    {
      transcript_id: 'ENST00000888888',
      consequence_terms: ['intron_variant'],
      impact: 'MODIFIER',
    },
  ],
};

const VEP_RSID_RESPONSE = [
  {
    input: 'rs113488060',
    most_severe_consequence: 'missense_variant',
    transcript_consequences: [
      { transcript_id: 'ENST00000288602', consequence_terms: ['missense_variant'], impact: 'MODERATE' },
    ],
  },
];

const OVERLAP_FEATURES = [
  { feature_type: 'gene', gene_id: 'ENSG00000133606', external_name: 'MKRN1', biotype: 'protein_coding', seq_region_name: '7', start: 140450000, end: 140461000, strand: -1, assembly_name: 'GRCh38' },
  { feature_type: 'variation', id: 'rs1001402578', alleles: ['T', 'C'], consequence_type: ['intron_variant'], clinical_significance: [], source: 'dbSNP', seq_region_name: '7', start: 140451234, end: 140451234, strand: 1 },
];

function okJson(body: unknown) {
  return {
    ok: true,
    status: 200,
    statusText: 'OK',
    json: () => Promise.resolve(body),
    headers: new Headers({ 'content-type': 'application/json' }),
  };
}

type RouteHandler = (url: URL, init?: RequestInit) => unknown;

function mockFetchRoutes(routes: Record<string, RouteHandler>): void {
  global.fetch = jest.fn().mockImplementation((rawUrl: string, init?: RequestInit) => {
    const url = new URL(rawUrl);
    for (const [prefix, handler] of Object.entries(routes)) {
      if (url.pathname.startsWith(prefix)) {
        const result = handler(url, init) as unknown;
        return Promise.resolve(result);
      }
    }
    return Promise.resolve(okJson({}));
  }) as any;
}

async function loadEnsembl() {
  return await import('../../entities/ensembl.js');
}

function callUrls(): string[] {
  return (global.fetch as any).mock.calls.map((c: any[]) => c[0] as string);
}

function fetchInits(): RequestInit[] {
  return (global.fetch as any).mock.calls.map((c: any[]) => c[1]);
}

describe('ensembl entity', () => {
  let originalFetch: typeof global.fetch;

  beforeEach(() => {
    originalFetch = global.fetch;
    connectionManager.closeAll();
  });

  afterEach(() => {
    global.fetch = originalFetch;
  });

  describe('ensemblLookup', () => {
    it('resolves a symbol without expand', async () => {
      const { ensemblLookup } = await loadEnsembl();
      mockFetchRoutes({
        '/lookup/symbol': () => okJson(LOOKUP_BRAF),
      });

      const result = await ensemblLookup('BRAF');

      expect(result.id).toBe('ENSG00000157764');
      expect(result.symbol).toBe('BRAF');
      expect(result.assembly).toBe('GRCh38');
      expect(result.chromosome).toBe('7');
      expect(result.strand).toBe(-1);
      expect(result.canonical_transcript).toBe('ENST00000646891.2');
      expect(result.transcripts).toBeUndefined();
      expect(callUrls()[0]).toContain('/lookup/symbol/human/BRAF');
      expect(callUrls()[0]).not.toContain('expand');
    });

    it('expand=1 appends the flag and maps transcripts', async () => {
      const { ensemblLookup } = await loadEnsembl();
      mockFetchRoutes({
        '/lookup/symbol': () => okJson({ ...LOOKUP_BRAF, Transcript: TRANSCRIPTS }),
      });

      const result = await ensemblLookup('BRAF', { expand: true });

      expect(callUrls()[0]).toContain('expand=1');
      expect(result.transcripts).toHaveLength(2);
      expect(result.transcripts![0].is_canonical).toBe(true);
      expect(result.transcripts![0].translation_id).toBe('ENSP00000493543');
      expect(result.transcripts![0].exon_count).toBe(3);
      expect(result.transcripts![1].is_canonical).toBe(false);
    });

    it('routes ENSG inputs to /lookup/id and scrubs version suffixes', async () => {
      const { ensemblLookup } = await loadEnsembl();
      mockFetchRoutes({
        '/lookup/id': () => okJson(LOOKUP_BRAF),
      });

      const result = await ensemblLookup('ENSG00000157764.16');

      expect(result.id).toBe('ENSG00000157764');
      // Upstream rejects versioned IDs with HTTP 400 — only the bare form may be sent.
      expect(callUrls()[0]).toContain('/lookup/id/ENSG00000157764');
      expect(callUrls()[0]).not.toContain('ENSG00000157764.');
    });

    it('rejects transcript/protein IDs with a helpful error', async () => {
      const { ensemblLookup } = await loadEnsembl();
      mockFetchRoutes({});

      await expect(ensemblLookup('ENST00000288602')).rejects.toThrow(/transcript\/protein ID/);
      await expect(ensemblLookup('ENSP00000288602')).rejects.toThrow(/transcript\/protein ID/);
    });

    it('propagates upstream 400 errors (not-found IDs return 400, not 404)', async () => {
      const { ensemblLookup } = await loadEnsembl();
      mockFetchRoutes({
        '/lookup/id': () => ({
          ok: false,
          status: 400,
          statusText: 'Bad Request',
          json: () => Promise.resolve({ error: "ID 'ENSG99999999999' not found" }),
          headers: new Headers({ 'content-type': 'application/json' }),
        }),
      });

      await expect(ensemblLookup('ENSG99999999999')).rejects.toThrow(/HTTP 400/);
    });

    it('retries transient 503s via the registry retry config then succeeds', async () => {
      const { ensemblLookup } = await loadEnsembl();
      let calls = 0;
      mockFetchRoutes({
        '/lookup/id': () => {
          calls += 1;
          if (calls < 3) {
            return {
              ok: false,
              status: 503,
              statusText: 'Service Unavailable',
              json: () => Promise.resolve({}),
              headers: new Headers(),
            };
          }
          return okJson(LOOKUP_BRAF);
        },
      });

      const result = await ensemblLookup('ENSG00000157764');
      expect(result.symbol).toBe('BRAF');
      expect(calls).toBe(3);
    }, 15000);

    it('surfaces an error after exhausting retries on persistent 503s', async () => {
      const { ensemblLookup } = await loadEnsembl();
      mockFetchRoutes({
        '/lookup/id': () => ({
          ok: false,
          status: 503,
          statusText: 'Service Unavailable',
          json: () => Promise.resolve({}),
          headers: new Headers(),
        }),
      });

      await expect(ensemblLookup('ENSG00000157764')).rejects.toThrow(/HTTP 503/);
    }, 15000);
  });

  describe('resolveEnsemblGene', () => {
    it('resolves symbols and stable IDs to core metadata', async () => {
      const mod = await loadEnsembl();
      mockFetchRoutes({
        '/lookup/symbol': () => okJson(LOOKUP_BRAF),
        '/lookup/id': () => okJson(LOOKUP_BRAF),
      });

      const bySymbol = await mod.resolveEnsemblGene('BRAF', 'mouse');
      expect(bySymbol.species).toBe('mouse');
      expect(callUrls()[0]).toContain('/lookup/symbol/mouse/BRAF');

      const byId = await mod.resolveEnsemblGene('ENSG00000157764');
      expect(byId.id).toBe('ENSG00000157764');
      expect(callUrls()[1]).toContain('/lookup/id/');
    });
  });

  describe('ensemblHomology', () => {
    it('resolves symbols via /lookup then maps homologies sorted by percent identity desc', async () => {
      const { ensemblHomology } = await loadEnsembl();
      mockFetchRoutes({
        '/lookup/symbol': () => okJson(LOOKUP_BRAF),
        '/homology/id': () => okJson(HOMOLOGY_RESPONSE),
      });

      const result = await ensemblHomology('BRAF');

      expect(result.total).toBe(3);
      expect(result.returned).toBe(3);
      expect(result.truncated).toBe(false);
      expect(result.type).toBe('orthologues');
      expect(result.homologies.map(h => h.target.perc_id)).toEqual([94.2, 87.6866, null]);
      expect(result.homologies[0].target.species).toBe('felis_catus');
      expect(result.homologies[0].taxonomy_level).toBe('Mammals');
      // Symbol route proved flaky upstream — only /lookup/symbol + /homology/id are used.
      expect(callUrls()[0]).toContain('/lookup/symbol/human/BRAF');
      expect(callUrls()[1]).toContain('/homology/id/human/ENSG00000157764?type=orthologues');
    });

    it('skips resolution for ENSG inputs and passes target filters as semicolon params', async () => {
      const { ensemblHomology } = await loadEnsembl();
      mockFetchRoutes({
        '/homology/id': () => okJson(HOMOLOGY_RESPONSE),
      });

      const result = await ensemblHomology('ENSG00000157764', { target_species: 'mouse', limit: 1 });

      expect(callUrls()).toHaveLength(1);
      const url = callUrls()[0];
      expect(url).toContain('/homology/id/human/ENSG00000157764?');
      expect(url).toContain('type=orthologues;');
      expect(url).toContain('target_species=mouse');
      expect(result.returned).toBe(1);
      expect(result.truncated).toBe(true);
    });

    it('supports paralogues and target_taxon', async () => {
      const { ensemblHomology } = await loadEnsembl();
      mockFetchRoutes({
        '/lookup/symbol': () => okJson(LOOKUP_BRAF),
        '/homology/id': () => okJson({ data: [{ id: 'ENSG00000157764', homologies: [] }] }),
      });

      const result = await ensemblHomology('BRAF', { type: 'paralogues', target_taxon: 10090 });

      expect(result.type).toBe('paralogues');
      expect(result.homologies).toEqual([]);
      const url = callUrls()[1];
      expect(url).toContain('type=paralogues');
      expect(url).toContain('target_taxon=10090');
    });
  });

  describe('ensemblConsequence', () => {
    it('GETs HGVS notation URL-encoded and maps consequences sorted by impact', async () => {
      const { ensemblConsequence } = await loadEnsembl();
      // NB: VEP returns an array of results even for a single input.
      mockFetchRoutes({
        '/vep/': () => okJson([VEP_HGVS_RESPONSE]),
      });

      const result = await ensemblConsequence('NM_004333:c.1799T>A');

      expect(result.most_severe_consequence).toBe('missense_variant');
      expect(decodeURIComponent(callUrls()[0])).toContain('/vep/human/hgvs/NM_004333:c.1799T>A');
      expect(result.effects_total).toBe(3);
      expect(result.consequences.map(c => c.impact)).toEqual(['HIGH', 'MODERATE', 'MODIFIER']);
      const moderate = result.consequences[1];
      expect(moderate.gene_symbol).toBe('BRAF');
      expect(moderate.sift_prediction).toBe('deleterious_low_confidence');
      expect(moderate.polyphen_prediction).toBe('benign');
      expect(result.colocated_variants).toHaveLength(5);
      expect(result.colocated_variants[0].id).toBe('rs113488060');
      expect(result.colocated_variants[0].clin_sig).toEqual(['pathogenic']);
    });

    it('honors the limit option after sorting', async () => {
      const { ensemblConsequence } = await loadEnsembl();
      mockFetchRoutes({
        '/vep/': () => okJson([VEP_HGVS_RESPONSE]),
      });

      const result = await ensemblConsequence('NM_004333:c.1799T>A', { limit: 1 });

      expect(result.consequences).toHaveLength(1);
      expect(result.effects_returned).toBe(1);
      expect(result.effects_total).toBe(3);
      expect(result.consequences[0].impact).toBe('HIGH');
    });

    it('uses POST /vep/{species}/id for rsIDs', async () => {
      const { ensemblConsequence } = await loadEnsembl();
      mockFetchRoutes({
        '/vep/': () => okJson(VEP_RSID_RESPONSE),
      });

      const result = await ensemblConsequence('rs113488060');

      const url = new URL(callUrls()[0]);
      expect(url.pathname).toBe('/vep/human/id');
      const init = fetchInits()[0];
      expect(init.method).toBe('POST');
      expect(JSON.parse(String(init.body))).toEqual({ ids: ['rs113488060'] });
      expect(result.input).toBe('rs113488060');
      expect(result.most_severe_consequence).toBe('missense_variant');
    });

    it('rejects unsupported variant formats with guidance', async () => {
      const { ensemblConsequence } = await loadEnsembl();
      mockFetchRoutes({});

      await expect(ensemblConsequence('chr7:140453136A>T')).rejects.toThrow(/HGVS|rsID/);
    });
  });

  describe('ensemblRegion', () => {
    it('builds repeated feature params and maps gene/variation features', async () => {
      const { ensemblRegion } = await loadEnsembl();
      mockFetchRoutes({
        '/overlap/region': () => okJson(OVERLAP_FEATURES),
      });

      const result = await ensemblRegion('7:140450000-140480000');

      const url = callUrls()[0];
      expect(url).toContain('/overlap/region/human/7:140450000-140480000?feature=gene;feature=variation');
      expect(result.region).toBe('7:140450000-140480000');
      expect(result.total).toBe(2);
      expect(result.truncated).toBe(false);

      const gene = result.features[0];
      expect(gene.type).toBe('gene');
      expect(gene.id).toBe('ENSG00000133606');
      expect(gene.symbol).toBe('MKRN1');
      expect(gene.biotype).toBe('protein_coding');

      const variation = result.features[1];
      expect(variation.type).toBe('variation');
      expect(variation.id).toBe('rs1001402578');
      expect(variation.alleles).toEqual(['T', 'C']);
      expect(variation.consequence_types).toEqual(['intron_variant']);
    });

    it('slices to the limit with a truncated marker', async () => {
      const { ensemblRegion } = await loadEnsembl();
      mockFetchRoutes({
        '/overlap/region': () =>
          okJson(
            Array.from({ length: 120 }, (_, i) => ({
              feature_type: 'gene',
              gene_id: `ENSG${String(i).padStart(11, '0')}`,
              start: 1000 + i,
              end: 2000 + i,
            }))
          ),
      });

      const result = await ensemblRegion('7:1000-9000', { features: ['gene'], limit: 50 });

      expect(result.total).toBe(120);
      expect(result.returned).toBe(50);
      expect(result.truncated).toBe(true);
      expect(result.features).toHaveLength(50);
    });

    it('validates region format, span, and feature names', async () => {
      const { ensemblRegion } = await loadEnsembl();
      mockFetchRoutes({});

      await expect(ensemblRegion('7:140450000')).rejects.toThrow(/Invalid region/);
      await expect(ensemblRegion('7:20000000-1000000')).rejects.toThrow(/end must be >= start/);
      await expect(ensemblRegion('7:1-20000000')).rejects.toThrow(/5 Mb upstream limit/);
      await expect(ensemblRegion('7:1-1000', { features: ['regulatory' as never] })).rejects.toThrow(/Unsupported feature/);
    });
  });
});
