import { jest } from '@jest/globals';
import { variantSearch, variantGet, transformMyVariantHit, getVariantSearchFilters, getVariantGetSections } from '../../entities/variant.js';
import { connectionManager } from '../../connections/manager.js';

describe('variant', () => {
  let originalFetch: typeof global.fetch;

  beforeEach(() => {
    jest.clearAllMocks();
    originalFetch = global.fetch;
    connectionManager.closeAll();
  });

  afterEach(() => {
    global.fetch = originalFetch;
  });

  // ========== Existing tests (kept unchanged) ==========

  test('variantSearch() calls connection with correct myvariant endpoint', async () => {
    global.fetch = jest.fn().mockResolvedValue({
      ok: true,
      json: () => Promise.resolve({ hits: [{ _id: 'rs123', gene: { symbol: 'BRCA1' } }] }),
    }) as any;

    await variantSearch({ query: 'rs123' });

    expect(global.fetch).toHaveBeenCalled();
    const callUrl = (global.fetch as any).mock.calls[0][0] as string;
    expect(callUrl).toContain('myvariant.info');
    expect(callUrl).toContain('/query?');
    expect(callUrl).toContain('q=dbsnp.rsid');
  });

  test('variantSearch() returns transformed results', async () => {
    global.fetch = jest.fn().mockResolvedValue({
      ok: true,
      json: () => Promise.resolve({
        hits: [{
          _id: 'vcf123',
          dbsnp: { rsid: 'rs123', gene: { symbol: 'BRCA1' } },
          snpeff: { ann: [{ hgvs_p: 'p.Val600Glu', hgvs_c: 'c.1799T>A', genename: 'BRCA1' }] },
          clinvar: { rcv: [{ clinical_significance: 'Pathogenic', review_status: 'reviewed by expert panel' }] },
          gnomad: { af: 0.001 },
        }],
      }),
    }) as any;

    const results = await variantSearch({ query: 'rs123' });

    expect(results).toHaveLength(1);
    expect(results[0].id).toBe('rs123');
    expect(results[0].gene).toBe('BRCA1');
    expect(results[0].hgvs_p).toBe('p.Val600Glu');
    expect(results[0].significance).toBe('Pathogenic');
    expect(results[0].gnomad_af).toBe(0.001);
  });

  test('variantGet() calls connection with correct endpoint', async () => {
    global.fetch = jest.fn().mockResolvedValue({
      ok: true,
      json: () => Promise.resolve({
        _id: 'vcf123',
        dbsnp: { rsid: 'rs123' },
        gene: { symbol: 'BRCA1' },
      }),
    }) as any;

    await variantGet('rs123');

    expect(global.fetch).toHaveBeenCalled();
    const callUrl = (global.fetch as any).mock.calls[0][0] as string;
    expect(callUrl).toContain('myvariant.info');
    expect(callUrl).toContain('/variant/rs123?');
  });

  test('transformMyVariantHit() maps fields correctly', () => {
    const input = {
      _id: 'vcf123',
      dbsnp: { rsid: 'rs123', gene: { symbol: 'BRCA1' } },
      snpeff: { ann: [{ hgvs_p: 'p.Val600Glu', hgvs_c: 'c.1799T>A', genename: 'BRCA1' }] },
      clinvar: { rcv: [{ clinical_significance: 'Pathogenic', review_status: 'reviewed by expert panel' }] },
      gnomad: { af: 0.001 },
    };

    const result = transformMyVariantHit(input);

    expect(result).toEqual({
      id: 'rs123',
      gene: 'BRCA1',
      hgvs_p: 'p.Val600Glu',
      hgvs_c: 'c.1799T>A',
      significance: 'Pathogenic',
      clinvar_stars: undefined,
      gnomad_af: 0.001,
    });
  });

  // ========== NEW TESTS ==========

  // --- variantSearch filter tests ---

  test('variantSearch() with gene filter includes cadd.gene.genename in query', async () => {
    global.fetch = jest.fn().mockResolvedValue({
      ok: true,
      json: () => Promise.resolve({ hits: [] }),
    }) as any;

    await variantSearch({ gene: 'BRCA1' });

    const callUrl = (global.fetch as any).mock.calls[0][0] as string;
    expect(callUrl).toContain('cadd.gene.genename%3ABRCA1');
  });

  test('variantSearch() with pathogenic significance filter maps correctly', async () => {
    global.fetch = jest.fn().mockResolvedValue({
      ok: true,
      json: () => Promise.resolve({ hits: [] }),
    }) as any;

    await variantSearch({ significance: 'pathogenic' });

    const callUrl = (global.fetch as any).mock.calls[0][0] as string;
    // pathogenic -> pathogenic (same)
    expect(callUrl).toContain('pathogenic');
  });

  test('variantSearch() with likely_pathogenic significance maps to "likely pathogenic"', async () => {
    global.fetch = jest.fn().mockResolvedValue({
      ok: true,
      json: () => Promise.resolve({ hits: [] }),
    }) as any;

    await variantSearch({ significance: 'likely_pathogenic' });

    const callUrl = decodeURIComponent((global.fetch as any).mock.calls[0][0] as string).replace(/\+/g, ' ');
    expect(callUrl).toContain('likely pathogenic');
  });

  test('variantSearch() with consequence missense maps to missense_variant', async () => {
    global.fetch = jest.fn().mockResolvedValue({
      ok: true,
      json: () => Promise.resolve({ hits: [] }),
    }) as any;

    await variantSearch({ consequence: 'missense' });

    const callUrl = decodeURIComponent((global.fetch as any).mock.calls[0][0] as string);
    expect(callUrl).toContain('missense_variant');
  });

  test('variantSearch() with consequence frameshift maps to frameshift_variant', async () => {
    global.fetch = jest.fn().mockResolvedValue({
      ok: true,
      json: () => Promise.resolve({ hits: [] }),
    }) as any;

    await variantSearch({ consequence: 'frameshift' });

    const callUrl = decodeURIComponent((global.fetch as any).mock.calls[0][0] as string);
    expect(callUrl).toContain('frameshift_variant');
  });

  test('variantSearch() with hgvsp filter includes dbnsfp.hgvsp in query', async () => {
    global.fetch = jest.fn().mockResolvedValue({
      ok: true,
      json: () => Promise.resolve({ hits: [] }),
    }) as any;

    await variantSearch({ hgvsp: 'p.Val600Glu' });

    const callUrl = decodeURIComponent((global.fetch as any).mock.calls[0][0] as string);
    expect(callUrl).toContain('dbnsfp.hgvsp:*p.Val600Glu*');
  });

  test('variantSearch() with hgvsc filter includes snpeff.ann.hgvs_c in query', async () => {
    global.fetch = jest.fn().mockResolvedValue({
      ok: true,
      json: () => Promise.resolve({ hits: [] }),
    }) as any;

    await variantSearch({ hgvsc: 'c.1799T>A' });

    const callUrl = decodeURIComponent((global.fetch as any).mock.calls[0][0] as string);
    expect(callUrl).toContain('snpeff.ann.hgvs_c:"c.1799T>A"');
  });

  test('variantSearch() with min_cadd includes cadd.phred range in query', async () => {
    global.fetch = jest.fn().mockResolvedValue({
      ok: true,
      json: () => Promise.resolve({ hits: [] }),
    }) as any;

    await variantSearch({ min_cadd: 20 });

    const callUrl = decodeURIComponent((global.fetch as any).mock.calls[0][0] as string).replace(/\+/g, ' ');
    expect(callUrl).toContain('cadd.phred:[20 TO *]');
  });

  test('variantSearch() with max_frequency includes gnomad_af range in query', async () => {
    global.fetch = jest.fn().mockResolvedValue({
      ok: true,
      json: () => Promise.resolve({ hits: [] }),
    }) as any;

    await variantSearch({ max_frequency: 0.01 });

    const callUrl = decodeURIComponent((global.fetch as any).mock.calls[0][0] as string).replace(/\+/g, ' ');
    expect(callUrl).toContain('gnomad_af:[* TO 0.01]');
  });

  test('variantSearch() with rs123 query rewrites to dbsnp.rsid', async () => {
    global.fetch = jest.fn().mockResolvedValue({
      ok: true,
      json: () => Promise.resolve({ hits: [] }),
    }) as any;

    await variantSearch({ query: 'rs123' });

    const callUrl = (global.fetch as any).mock.calls[0][0] as string;
    expect(callUrl).toContain('dbsnp.rsid%3Ars123');
  });

  test('variantSearch() with HGVS cDNA query rewrites to snpeff filters', async () => {
    global.fetch = jest.fn().mockResolvedValue({
      ok: true,
      json: () => Promise.resolve({ hits: [] }),
    }) as any;

    await variantSearch({ query: 'NM_004333.4:c.1799T>A' });

    const callUrl = decodeURIComponent((global.fetch as any).mock.calls[0][0] as string);
    expect(callUrl).toContain('snpeff.ann.feature_id:NM_004333.4');
    expect(callUrl).toContain('snpeff.ann.hgvs_c:"c.1799T>A"');
  });

  test('variantSearch() returns empty array for empty hits', async () => {
    global.fetch = jest.fn().mockResolvedValue({
      ok: true,
      json: () => Promise.resolve({ hits: [] }),
    }) as any;

    const results = await variantSearch({ query: 'BRCA1' });

    expect(results).toEqual([]);
  });

  test('variantSearch() with multiple filters joins them with AND', async () => {
    global.fetch = jest.fn().mockResolvedValue({
      ok: true,
      json: () => Promise.resolve({ hits: [] }),
    }) as any;

    await variantSearch({ gene: 'TP53', significance: 'pathogenic', min_cadd: 20 });

    const callUrl = decodeURIComponent((global.fetch as any).mock.calls[0][0] as string).replace(/\+/g, ' ');
    // All three filter parts should be present and AND-joined
    const queryParam = new URL(callUrl).searchParams.get('q') || '';
    expect(queryParam).toContain('cadd.gene.genename:TP53');
    expect(queryParam).toContain('AND');
    expect(queryParam).toContain('pathogenic');
    expect(queryParam).toContain('cadd.phred:[20 TO *]');
  });

  // --- variantGet tests ---

  test('variantGet() with array response selects best variant with gnomad data', async () => {
    const variantArray = [
      { _id: 'chr7:1', _version: 1, dbsnp: { rsid: 'rs1' } },
      { _id: 'chr7:2', _version: 3, dbsnp: { rsid: 'rs2' }, gnomad_exome: { af: { af: 0.01 } } },
      { _id: 'chr7:3', _version: 2, dbsnp: { rsid: 'rs3' }, gnomad_genome: { af: { af: 0.005 } } },
    ];

    global.fetch = jest.fn().mockResolvedValue({
      ok: true,
      json: () => Promise.resolve(variantArray),
    }) as any;

    const result = await variantGet('rs2', []);

    // Should select the one with gnomad data and highest _version (rs2 has _version 3)
    expect(result.id).toBe('rs2');
  });

  test('variantGet() with HGVS input resolves to genomic ID', async () => {
    const hgvsId = 'NM_004333.4:c.1799T>A';
    let callCount = 0;

    global.fetch = jest.fn().mockImplementation(() => {
      callCount++;
      if (callCount === 1) {
        // First call: resolve HGVS to genomic ID
        return Promise.resolve({
          ok: true,
          json: () => Promise.resolve({ hits: [{ _id: 'chr7:140453136:A:T' }] }),
        });
      }
      // Second call: fetch variant details
      return Promise.resolve({
        ok: true,
        json: () => Promise.resolve({
          _id: 'chr7:140453136:A:T',
          dbsnp: { rsid: 'rs113488022' },
        }),
      });
    }) as any;

    const result = await variantGet(hgvsId, []);

    expect(global.fetch).toHaveBeenCalledTimes(2);
    expect(result.id).toBe('rs113488022');
  });

  test('variantGet() with "all" sections fetches all 5 sections', async () => {
    global.fetch = jest.fn().mockResolvedValue({
      ok: true,
      json: () => Promise.resolve({
        _id: 'vcf123',
        dbsnp: { rsid: 'rs123' },
      }),
    }) as any;

    const result = await variantGet('rs123', ['all']);

    // Should have sections for all 5: core, frequency, predictions, clinical, alphagenome
    expect(result.sections).toBeDefined();
    const sectionKeys = Object.keys(result.sections!);
    expect(sectionKeys).toHaveLength(5);
    expect(sectionKeys).toContain('core');
    expect(sectionKeys).toContain('frequency');
    expect(sectionKeys).toContain('predictions');
    expect(sectionKeys).toContain('clinical');
    expect(sectionKeys).toContain('alphagenome');
  });

  test('variantGet() with error response throws', async () => {
    global.fetch = jest.fn().mockResolvedValue({
      ok: true,
      json: () => Promise.resolve({ error: 'Variant not found' }),
    }) as any;

    await expect(variantGet('nonexistent')).rejects.toThrow('not found');
  });

  test('variantGet() with section fetch failure returns partial result with _error', async () => {
    delete process.env.ALPHAGENOME_API_KEY;
    // Main variant fetch succeeds; the alphagenome section genuinely REJECTS
    // (fetchAlphaGenomeSection throws without an API key) — the section must
    // land as an _error entry while the core section still resolves.
    global.fetch = jest.fn().mockImplementation(() => {
      return Promise.resolve({
        ok: true,
        headers: new Headers({ 'content-type': 'application/json' }),
        json: () => Promise.resolve({
          _id: 'vcf123',
          dbsnp: { rsid: 'rs123' },
        }),
      });
    }) as any;

    const result = await variantGet('rs123', ['core', 'alphagenome']);

    expect(result.sections).toBeDefined();
    expect(result.sections!.core).toEqual(expect.objectContaining({ id: 'rs123' }));
    expect((result.sections!.alphagenome as any)._error).toContain('ALPHAGENOME_API_KEY');
  });

  test('variantGet() maps alphagenome_scores alias to alphagenome section', async () => {
    global.fetch = jest.fn().mockResolvedValue({
      ok: true,
      json: () => Promise.resolve({
        _id: 'vcf123',
        dbsnp: { rsid: 'rs123' },
      }),
    }) as any;

    const result = await variantGet('rs123', ['alphagenome_scores']);

    // Should have alphagenome section (aliased from alphagenome_scores)
    expect(result.sections).toBeDefined();
    expect(result.sections!.alphagenome).toBeDefined();
  });

  // --- transformMyVariantHit edge cases ---

  test('transformMyVariantHit() with dbnsfp gene name fallback when snpeff is empty', () => {
    const input = {
      _id: 'vcf123',
      dbnsfp: { gene: { genename: 'TP53' } },
      snpeff: { ann: [] },
    };

    const result = transformMyVariantHit(input);

    expect(result.gene).toBe('TP53');
  });

  test('transformMyVariantHit() with clinvar significance from dbnsfp when clinvar is empty', () => {
    const input = {
      _id: 'vcf123',
      dbnsfp: { clinvar: { clnsig: 'Pathogenic' } },
      snpeff: { ann: [] },
    };

    const result = transformMyVariantHit(input);

    expect(result.significance).toBe('Pathogenic');
  });

  test('transformMyVariantHit() maps gnomad_af correctly', () => {
    const input = {
      _id: 'vcf123',
      gnomad: { af: 0.005 },
      snpeff: { ann: [] },
    };

    const result = transformMyVariantHit(input);

    expect(result.gnomad_af).toBe(0.005);
  });

  test('transformMyVariantHit() with minimal data uses _id as fallback', () => {
    const input = {
      _id: 'chr7:140453136:A:T',
    };

    const result = transformMyVariantHit(input);

    expect(result.id).toBe('chr7:140453136:A:T');
    expect(result.gene).toBeUndefined();
    expect(result.hgvs_p).toBeUndefined();
    expect(result.hgvs_c).toBeUndefined();
    expect(result.significance).toBeUndefined();
    expect(result.gnomad_af).toBeUndefined();
  });

  // --- Helper function tests ---

  test('getVariantSearchFilters() returns expected filter list', () => {
    const filters = getVariantSearchFilters();

    expect(filters).toContain('gene');
    expect(filters).toContain('hgvsp');
    expect(filters).toContain('significance');
    expect(filters).toContain('max_frequency');
    expect(filters).toContain('min_cadd');
    expect(filters).toContain('consequence');
    expect(filters).toHaveLength(6);
  });

  test('getVariantGetSections() returns expected section list', () => {
    const sections = getVariantGetSections();

    expect(sections).toContain('core');
    expect(sections).toContain('frequency');
    expect(sections).toContain('predictions');
    expect(sections).toContain('clinical');
    expect(sections).toContain('alphagenome');
    expect(sections).toHaveLength(5);
  });

  // --- variantGet with specific sections ---

  test('variantGet() with frequency section includes gnomad data', async () => {
    global.fetch = jest.fn().mockResolvedValue({
      ok: true,
      json: () => Promise.resolve({
        _id: 'vcf123',
        dbsnp: { rsid: 'rs123' },
        gnomad_exome: { af: { af: 0.02 } },
      }),
    }) as any;

    const result = await variantGet('rs123', ['frequency']);

    expect(result.sections).toBeDefined();
    const freq = result.sections!.frequency as any;
    expect(freq).toBeDefined();
    expect(freq.gnomad_exome_af).toBe(0.02);
  });

  test('variantGet() with predictions section extracts CADD scores', async () => {
    global.fetch = jest.fn().mockResolvedValue({
      ok: true,
      json: () => Promise.resolve({
        _id: 'vcf123',
        dbsnp: { rsid: 'rs123' },
        cadd: { score: 25.3, phred: 0.99 },
      }),
    }) as any;

    const result = await variantGet('rs123', ['predictions']);

    expect(result.sections).toBeDefined();
    const preds = result.sections!.predictions as any;
    expect(preds).toBeDefined();
    expect(preds.cadd_score).toBe(25.3);
    expect(preds.cadd_phred).toBe(0.99);
  });

  test('variantGet() with clinical section extracts clinvar data', async () => {
    global.fetch = jest.fn().mockResolvedValue({
      ok: true,
      json: () => Promise.resolve({
        _id: 'vcf123',
        dbsnp: { rsid: 'rs123' },
        clinvar: {
          variant_id: 12345,
          rcv: [{
            clinical_significance: 'Pathogenic',
            review_status: 'reviewed by expert panel',
            number_submitters: 3,
            conditions: [{ name: 'Breast cancer' }],
          }],
        },
      }),
    }) as any;

    const result = await variantGet('rs123', ['clinical']);

    expect(result.sections).toBeDefined();
    const clinical = result.sections!.clinical as any;
    expect(clinical).toBeDefined();
    expect(clinical.clinvar).toBeDefined();
    expect(clinical.clinvar.significance).toBe('Pathogenic');
    expect(clinical.clinvar.stars).toBe(3);
  });

  test('variantGet() with HGVS input that cannot be resolved throws', async () => {
    let callCount = 0;
    global.fetch = jest.fn().mockImplementation(() => {
      callCount++;
      // HGVS resolve returns no hits
      return Promise.resolve({
        ok: true,
        json: () => Promise.resolve({ hits: [] }),
      });
    }) as any;

    await expect(variantGet('NM_999999.1:c.1A>T', [])).rejects.toThrow('not found');
  });

  test('variantSearch() with limit and offset passes them as query params', async () => {
    global.fetch = jest.fn().mockResolvedValue({
      ok: true,
      json: () => Promise.resolve({ hits: [] }),
    }) as any;

    await variantSearch({ query: 'BRCA1', limit: 5, offset: 10 });

    const callUrl = (global.fetch as any).mock.calls[0][0] as string;
    expect(callUrl).toContain('size=5');
    expect(callUrl).toContain('from=10');
  });
});
