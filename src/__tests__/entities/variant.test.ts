import { jest } from '@jest/globals';
import { variantSearch, variantGet, transformMyVariantHit, getVariantSearchFilters, getVariantGetSections, fetchOncoKbAnnotation, normalizeProteinChange } from '../../entities/variant.js';
import { connectionManager } from '../../connections/manager.js';
import { vcf123BrafV600eHit } from '../fixtures/myvariant.js';
import { mockGlobalFetch } from '../helpers/mock-fetch.js';

describe('variant', () => {
  mockGlobalFetch();

  beforeEach(() => {
    jest.clearAllMocks();
    connectionManager.closeAll();
  });

  // ========== Existing tests (kept unchanged) ==========

  test('variantSearch() calls connection with correct myvariant endpoint', async () => {
    global.fetch = jest.fn<(...args: any[]) => any>().mockResolvedValue({
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
    global.fetch = jest.fn<(...args: any[]) => any>().mockResolvedValue({
      ok: true,
      json: () => Promise.resolve({
        hits: [vcf123BrafV600eHit],
      }),
    }) as any;

    const results = await variantSearch({ query: 'rs123' });

    expect(results).toHaveLength(1);
    expect(results[0].id).toBe('rs123');
    expect(results[0].gene).toBe('BRCA1');
    expect(results[0].hgvs_p).toBe('V600E');
    expect(results[0].significance).toBe('Pathogenic');
    expect(results[0].gnomad_af).toBe(0.001);
  });

  test('variantGet() calls connection with correct endpoint', async () => {
    global.fetch = jest.fn<(...args: any[]) => any>().mockResolvedValue({
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
    const input = vcf123BrafV600eHit;

    const result = transformMyVariantHit(input);

    expect(result).toEqual({
      id: 'rs123',
      gene: 'BRCA1',
      hgvs_p: 'V600E',
      hgvs_c: 'c.1799T>A',
      significance: 'Pathogenic',
      clinvar_stars: undefined,
      gnomad_af: 0.001,
    });
  });

  // ========== NEW TESTS ==========

  // --- variantSearch filter tests ---

  test('variantSearch() with gene filter includes cadd.gene.genename in query', async () => {
    global.fetch = jest.fn<(...args: any[]) => any>().mockResolvedValue({
      ok: true,
      json: () => Promise.resolve({ hits: [] }),
    }) as any;

    await variantSearch({ gene: 'BRCA1' });

    const callUrl = (global.fetch as any).mock.calls[0][0] as string;
    expect(callUrl).toContain('cadd.gene.genename%3ABRCA1');
  });

  test('variantSearch() with pathogenic significance uses a quoted phrase, not a wildcard substring', async () => {
    global.fetch = jest.fn<(...args: any[]) => any>().mockResolvedValue({
      ok: true,
      json: () => Promise.resolve({ hits: [] }),
    }) as any;

    await variantSearch({ significance: 'pathogenic' });

    const callUrl = (global.fetch as any).mock.calls[0][0] as string;
    const queryParam = new URL(callUrl).searchParams.get('q') || '';
    // Phrase (token) match — a wildcard `*pathogenic*` would also match
    // "Conflicting interpretations of pathogenicity" (live: BRCA1 wildcard
    // 2678 hits incl. Conflicting rows; phrase 861 pathogenic-only rows).
    expect(queryParam).toContain('clinvar.rcv.clinical_significance:"pathogenic"');
    expect(queryParam).not.toContain('*pathogenic*');
  });

  test('variantSearch() with likely_pathogenic significance maps to the "likely pathogenic" phrase', async () => {
    global.fetch = jest.fn<(...args: any[]) => any>().mockResolvedValue({
      ok: true,
      json: () => Promise.resolve({ hits: [] }),
    }) as any;

    await variantSearch({ significance: 'likely_pathogenic' });

    const callUrl = (global.fetch as any).mock.calls[0][0] as string;
    const queryParam = new URL(callUrl).searchParams.get('q') || '';
    expect(queryParam).toContain('clinvar.rcv.clinical_significance:"likely pathogenic"');
  });

  test('variantSearch() significance post-filter drops hits displayed as "Conflicting interpretations of pathogenicity"', async () => {
    // clinvar.rcv is an ARRAY: the ANY-match query clause admits a record
    // whose displayed significance is Conflicting but that carries one
    // pathogenic RCV — the post-filter must drop it.
    global.fetch = jest.fn<(...args: any[]) => any>().mockResolvedValue({
      ok: true,
      json: () => Promise.resolve({
        hits: [
          {
            _id: 'chr17:g.1A>T',
            clinvar: { rcv: [
              { clinical_significance: 'Conflicting interpretations of pathogenicity' },
              { clinical_significance: 'Pathogenic' },
            ] },
          },
          {
            _id: 'chr17:g.2C>G',
            clinvar: { rcv: [{ clinical_significance: 'Pathogenic' }] },
          },
        ],
      }),
    }) as any;

    const results = await variantSearch({ significance: 'pathogenic' });

    expect(results.map(r => r.id)).toEqual(['chr17:g.2C>G']);
  });

  test('variantSearch() significance post-filter keeps "Pathogenic/Likely pathogenic" for both requested categories', async () => {
    const mkFetch = () => jest.fn<(...args: any[]) => any>().mockResolvedValue({
      ok: true,
      json: () => Promise.resolve({
        hits: [{
          _id: 'chr17:g.3T>A',
          clinvar: { rcv: [{ clinical_significance: 'Pathogenic/Likely pathogenic' }] },
        }],
      }),
    }) as any;

    global.fetch = mkFetch();
    const asPathogenic = await variantSearch({ significance: 'pathogenic' });
    expect(asPathogenic).toHaveLength(1);

    global.fetch = mkFetch();
    const asLikelyPathogenic = await variantSearch({ significance: 'likely_pathogenic' });
    expect(asLikelyPathogenic).toHaveLength(1);
  });

  test('variantSearch() with consequence missense maps to missense_variant', async () => {
    global.fetch = jest.fn<(...args: any[]) => any>().mockResolvedValue({
      ok: true,
      json: () => Promise.resolve({ hits: [] }),
    }) as any;

    await variantSearch({ consequence: 'missense' });

    const callUrl = decodeURIComponent((global.fetch as any).mock.calls[0][0] as string);
    expect(callUrl).toContain('missense_variant');
  });

  test('variantSearch() with consequence frameshift maps to frameshift_variant', async () => {
    global.fetch = jest.fn<(...args: any[]) => any>().mockResolvedValue({
      ok: true,
      json: () => Promise.resolve({ hits: [] }),
    }) as any;

    await variantSearch({ consequence: 'frameshift' });

    const callUrl = decodeURIComponent((global.fetch as any).mock.calls[0][0] as string);
    expect(callUrl).toContain('frameshift_variant');
  });

  test('variantSearch() with hgvsp filter includes dbnsfp.hgvsp in query', async () => {
    global.fetch = jest.fn<(...args: any[]) => any>().mockResolvedValue({
      ok: true,
      json: () => Promise.resolve({ hits: [] }),
    }) as any;

    await variantSearch({ hgvsp: 'p.Val600Glu' });

    const callUrl = decodeURIComponent((global.fetch as any).mock.calls[0][0] as string);
    expect(callUrl).toContain('dbnsfp.hgvsp:*p.Val600Glu*');
  });

  test('variantSearch() with bare c. hgvsc passes it through to the query unchanged', async () => {
    // rewriteVariantQuery is idempotent for bare c. forms — the token goes
    // into q verbatim (live: 50 relevant hits incl. BRAF V600E rs113488022,
    // vs 2408 loose phrase matches for the old quoted-field clause).
    global.fetch = jest.fn<(...args: any[]) => any>().mockResolvedValue({
      ok: true,
      json: () => Promise.resolve({ hits: [] }),
    }) as any;

    await variantSearch({ hgvsc: 'c.1799T>A' });

    const callUrl = (global.fetch as any).mock.calls[0][0] as string;
    const queryParam = new URL(callUrl).searchParams.get('q') || '';
    expect(queryParam).toContain('c.1799T>A');
  });

  test('variantSearch() with full-HGVS hgvsc splits it into feature_id + hgvs_c clauses', async () => {
    // snpeff.ann.hgvs_c stores ONLY the c. portion (the transcript lives in
    // snpeff.ann.feature_id), so quoting the full NM_004333.4:c.1799T>A
    // string matched nothing (live: 0 hits); the rewrite splits it exactly
    // like the query= path (mirrors the query-param test below).
    global.fetch = jest.fn<(...args: any[]) => any>().mockResolvedValue({
      ok: true,
      json: () => Promise.resolve({ hits: [] }),
    }) as any;

    await variantSearch({ hgvsc: 'NM_004333.4:c.1799T>A' });

    const callUrl = decodeURIComponent((global.fetch as any).mock.calls[0][0] as string).replace(/\+/g, ' ');
    expect(callUrl).toContain('snpeff.ann.feature_id:NM_004333.4');
    expect(callUrl).toContain('snpeff.ann.hgvs_c:"c.1799T>A"');
    // The unsplit full string must NOT appear as a quoted hgvs_c value.
    expect(callUrl).not.toContain('snpeff.ann.hgvs_c:"NM_004333.4:c.1799T>A"');
  });

  test('variantSearch() with min_cadd includes cadd.phred range in query', async () => {
    global.fetch = jest.fn<(...args: any[]) => any>().mockResolvedValue({
      ok: true,
      json: () => Promise.resolve({ hits: [] }),
    }) as any;

    await variantSearch({ min_cadd: 20 });

    const callUrl = decodeURIComponent((global.fetch as any).mock.calls[0][0] as string).replace(/\+/g, ' ');
    expect(callUrl).toContain('cadd.phred:[20 TO *]');
  });

  test('variantSearch() with max_frequency uses real gnomad AF fields in OR-clause', async () => {
    global.fetch = jest.fn<(...args: any[]) => any>().mockResolvedValue({
      ok: true,
      json: () => Promise.resolve({ hits: [] }),
    }) as any;

    await variantSearch({ max_frequency: 0.01 });

    const callUrl = decodeURIComponent((global.fetch as any).mock.calls[0][0] as string).replace(/\+/g, ' ');
    expect(callUrl).toContain('(gnomad_exome.af.af:[* TO 0.01] OR gnomad_genome.af.af:[* TO 0.01])');
    expect(callUrl).not.toContain('gnomad_af:');
    expect(callUrl).toContain('fields=dbsnp,snpeff,clinvar,gnomad_exome,gnomad_genome,cadd,dbnsfp');
  });

  test('variantSearch() with rs123 query rewrites to dbsnp.rsid', async () => {
    global.fetch = jest.fn<(...args: any[]) => any>().mockResolvedValue({
      ok: true,
      json: () => Promise.resolve({ hits: [] }),
    }) as any;

    await variantSearch({ query: 'rs123' });

    const callUrl = (global.fetch as any).mock.calls[0][0] as string;
    expect(callUrl).toContain('dbsnp.rsid%3Ars123');
  });

  test('variantSearch() with HGVS cDNA query rewrites to snpeff filters', async () => {
    global.fetch = jest.fn<(...args: any[]) => any>().mockResolvedValue({
      ok: true,
      json: () => Promise.resolve({ hits: [] }),
    }) as any;

    await variantSearch({ query: 'NM_004333.4:c.1799T>A' });

    const callUrl = decodeURIComponent((global.fetch as any).mock.calls[0][0] as string);
    expect(callUrl).toContain('snpeff.ann.feature_id:NM_004333.4');
    expect(callUrl).toContain('snpeff.ann.hgvs_c:"c.1799T>A"');
  });

  test('variantSearch() returns empty array for empty hits', async () => {
    global.fetch = jest.fn<(...args: any[]) => any>().mockResolvedValue({
      ok: true,
      json: () => Promise.resolve({ hits: [] }),
    }) as any;

    const results = await variantSearch({ query: 'BRCA1' });

    expect(results).toEqual([]);
  });

  test('variantSearch() with multiple filters joins them with AND', async () => {
    global.fetch = jest.fn<(...args: any[]) => any>().mockResolvedValue({
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

  test('variantGet() with ClinVar numeric id resolves via clinvar.variant_id then fetches the variant', async () => {
    // /variant/13961 404s live — ClinVar ids are not document keys; the
    // resolver must query clinvar.variant_id (NOT _clinvarVariantId, which
    // returns 0 hits) and use hits[0]._id for the fetch.
    let callCount = 0;
    global.fetch = jest.fn<(...args: any[]) => any>().mockImplementation(() => {
      callCount++;
      if (callCount === 1) {
        return Promise.resolve({
          ok: true,
          json: () => Promise.resolve({ hits: [{ _id: 'chr7:g.140453136A>T' }] }),
        });
      }
      return Promise.resolve({
        ok: true,
        json: () => Promise.resolve({
          _id: 'chr7:g.140453136A>T',
          dbsnp: { rsid: 'rs113488022' },
        }),
      });
    }) as any;

    const result = await variantGet('13961', []);

    expect(global.fetch).toHaveBeenCalledTimes(2);
    const resolveUrl = (global.fetch as any).mock.calls[0][0] as string;
    expect(resolveUrl).toContain('/query?');
    expect(decodeURIComponent(resolveUrl)).toContain('clinvar.variant_id:13961');
    expect(decodeURIComponent(resolveUrl)).toContain('fields=_id');
    expect(decodeURIComponent(resolveUrl)).toContain('size=1');
    const fetchUrl = (global.fetch as any).mock.calls[1][0] as string;
    expect(fetchUrl).toContain('/variant/chr7:g.140453136A%3ET');
    expect(result.id).toBe('rs113488022');
  });

  test('variantGet() accepts clinvar_-prefixed and VCV accession ClinVar id forms', async () => {
    for (const id of ['clinvar_13961', 'VCV0000013961']) {
      let callCount = 0;
      global.fetch = jest.fn<(...args: any[]) => any>().mockImplementation(() => {
        callCount++;
        if (callCount === 1) {
          return Promise.resolve({
            ok: true,
            json: () => Promise.resolve({ hits: [{ _id: 'chr7:g.140453136A>T' }] }),
          });
        }
        return Promise.resolve({
          ok: true,
          json: () => Promise.resolve({ _id: 'chr7:g.140453136A>T', dbsnp: { rsid: 'rs113488022' } }),
        });
      }) as any;

      const result = await variantGet(id, []);
      expect(result.id).toBe('rs113488022');
      const resolveUrl = decodeURIComponent((global.fetch as any).mock.calls[0][0] as string);
      // VCV leading zeros are normalized away; both forms resolve to 13961.
      expect(resolveUrl).toContain('clinvar.variant_id:13961');
    }
  });

  test('variantGet() with unresolvable ClinVar id throws a descriptive ClinVar error', async () => {
    global.fetch = jest.fn<(...args: any[]) => any>().mockResolvedValue({
      ok: true,
      json: () => Promise.resolve({ hits: [] }),
    }) as any;

    await expect(variantGet('999999999999', [])).rejects.toThrow(/ClinVar.*not found.*could not be resolved/s);
    // Only the resolution query ran — no blind /variant/999... fetch.
    expect(global.fetch).toHaveBeenCalledTimes(1);
  });

  test('variantGet() with array response selects best variant with gnomad data', async () => {
    const variantArray = [
      { _id: 'chr7:1', _version: 1, dbsnp: { rsid: 'rs1' } },
      { _id: 'chr7:2', _version: 3, dbsnp: { rsid: 'rs2' }, gnomad_exome: { af: { af: 0.01 } } },
      { _id: 'chr7:3', _version: 2, dbsnp: { rsid: 'rs3' }, gnomad_genome: { af: { af: 0.005 } } },
    ];

    global.fetch = jest.fn<(...args: any[]) => any>().mockResolvedValue({
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

    global.fetch = jest.fn<(...args: any[]) => any>().mockImplementation(() => {
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
    global.fetch = jest.fn<(...args: any[]) => any>().mockResolvedValue({
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
    global.fetch = jest.fn<(...args: any[]) => any>().mockResolvedValue({
      ok: true,
      json: () => Promise.resolve({ error: 'Variant not found' }),
    }) as any;

    await expect(variantGet('nonexistent')).rejects.toThrow('not found');
  });

  test('variantGet() alphagenome section returns honest stub without network call', async () => {
    global.fetch = jest.fn<(...args: any[]) => any>().mockResolvedValue({
      ok: true,
      headers: new Headers({ 'content-type': 'application/json' }),
      json: () => Promise.resolve({
        _id: 'vcf123',
        dbsnp: { rsid: 'rs123' },
      }),
    }) as any;

    const result = await variantGet('rs123', ['core', 'alphagenome']);

    // Only the MyVariant.info core fetch happens — the former fabricated
    // gRPC-over-HTTP transport is gone and the section fails honestly.
    expect(global.fetch).toHaveBeenCalledTimes(1);
    expect(result.sections!.core).toEqual(expect.objectContaining({ id: 'rs123' }));
    expect(result.sections!.alphagenome).toEqual({
      _error: expect.stringContaining('temporarily unavailable'),
    });
  });

  test('variantGet() maps alphagenome_scores alias to alphagenome section', async () => {
    global.fetch = jest.fn<(...args: any[]) => any>().mockResolvedValue({
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

  test('transformMyVariantHit() maps gnomad_af from exome, falling back to genome', () => {
    const fromExome = transformMyVariantHit({
      _id: 'vcf123',
      gnomad_exome: { af: { af: 0.005 } },
      gnomad_genome: { af: { af: 0.002 } },
      snpeff: { ann: [] },
    });
    expect(fromExome.gnomad_af).toBe(0.005);

    const genomeOnly = transformMyVariantHit({
      _id: 'vcf124',
      gnomad_genome: { af: { af: 0.002 } },
      snpeff: { ann: [] },
    });
    expect(genomeOnly.gnomad_af).toBe(0.002);
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
    global.fetch = jest.fn<(...args: any[]) => any>().mockResolvedValue({
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
    global.fetch = jest.fn<(...args: any[]) => any>().mockResolvedValue({
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
    global.fetch = jest.fn<(...args: any[]) => any>().mockResolvedValue({
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
    global.fetch = jest.fn<(...args: any[]) => any>().mockImplementation(() => {
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
    global.fetch = jest.fn<(...args: any[]) => any>().mockResolvedValue({
      ok: true,
      json: () => Promise.resolve({ hits: [] }),
    }) as any;

    await variantSearch({ query: 'BRCA1', limit: 5, offset: 10 });

    const callUrl = (global.fetch as any).mock.calls[0][0] as string;
    expect(callUrl).toContain('size=5');
    expect(callUrl).toContain('from=10');
  });
});

// ============================================================
// variantGet clinical section — CIViC lookup (schema-valid query)
// ============================================================
describe('variantGet clinical section — CIViC lookup', () => {
  mockGlobalFetch();

  beforeEach(() => {
    jest.clearAllMocks();
    connectionManager.closeAll();
  });

  afterEach(() => {
    jest.restoreAllMocks();
  });

  function mockConnections(civicResponse: unknown) {
    const civicRequest = jest.fn<(...args: any[]) => any>().mockResolvedValue(civicResponse);
    const realGetConnection = connectionManager.getConnection.bind(connectionManager);
    jest.spyOn(connectionManager, 'getConnection').mockImplementation((sourceId: string) => {
      if (sourceId === 'civic') {
        return { request: civicRequest } as any;
      }
      return realGetConnection(sourceId);
    });
    return civicRequest;
  }

  function mockMyVariantGet() {
    global.fetch = jest.fn<(...args: any[]) => any>().mockResolvedValue({
      ok: true,
      headers: new Headers({ 'content-type': 'application/json' }),
      json: () => Promise.resolve({
        _id: 'chr7:140453136:A:T',
        dbsnp: { rsid: 'rs113488022', gene: { symbol: 'BRAF' } },
        snpeff: { ann: [{ genename: 'BRAF', hgvs_p: 'p.Val600Glu', hgvs_c: 'c.1799T>A' }] },
      }),
    }) as any;
  }

  test('queries gene(entrezSymbol)/variants with rootField and filters protein match client-side', async () => {
    const civicRequest = mockConnections({
      data: {
        gene: {
          variants: {
            nodes: [
              { id: 704, name: 'V600E+V600K', clinicalSignificanceCounts: [], singleVariantMolecularProfile: { molecularProfileScore: 0, evidenceItems: { totalCount: 0 } } },
              { id: 12, name: 'V600E', clinicalSignificanceCounts: [{ significance: 'ONCOGENIC', count: 3 }], singleVariantMolecularProfile: { molecularProfileScore: 1471.5, evidenceItems: { totalCount: 213 } } },
            ],
          },
        },
      },
    });
    mockMyVariantGet();

    const result = await variantGet('rs113488022', ['clinical']);

    expect(civicRequest).toHaveBeenCalledTimes(1);
    const [query, variables, options] = civicRequest.mock.calls[0];
    // Schema-valid query shape (live-verified against civicdb.org/api/graphql)
    expect(query).toContain('gene(entrezSymbol: $gene)');
    expect(query).toContain('variants(');
    expect(query).not.toContain('variants(gene:');
    // Protein change normalized from snpeff's "p.Val600Glu" to CIViC's "V600E"
    expect(variables).toEqual({ gene: 'BRAF', hgvsp: 'V600E' });
    // Phase-1 B2 payoff: schema drift on the gene root throws instead of silent null
    expect(options).toEqual({ rootField: 'gene' });

    // Client-side exact match: "V600E+V600K" must NOT match, "V600E" must
    const civic = (result.sections!.clinical as any).civic;
    expect(civic).toEqual({
      id: 12,
      name: 'V600E',
      clinical_significance: 'ONCOGENIC(3)',
      evidence_score: 1471.5,
      evidence_count: 213,
    });
  });

  test('omits civic entry when no node matches the protein change exactly', async () => {
    const civicRequest = mockConnections({
      data: {
        gene: {
          variants: {
            nodes: [
              { id: 563, name: 'V600K', clinicalSignificanceCounts: [], singleVariantMolecularProfile: { molecularProfileScore: 1, evidenceItems: { totalCount: 2 } } },
            ],
          },
        },
      },
    });
    mockMyVariantGet();

    const result = await variantGet('rs113488022', ['clinical']);

    expect(civicRequest).toHaveBeenCalledTimes(1);
    // No exact match -> no civic entry -> clinical section resolves null
    expect(result.sections!.clinical).toBeNull();
  });
});

// ============================================================
// OncoKB annotation (hugoSymbol params + IndicatorAnnotationResp mapping)
// ============================================================
describe('fetchOncoKbAnnotation', () => {
  mockGlobalFetch();
  const originalToken = process.env.ONCOKB_TOKEN;

  beforeEach(() => {
    jest.clearAllMocks();
    connectionManager.closeAll();
    process.env.ONCOKB_TOKEN = 'test-token';
  });

  afterEach(() => {
    if (originalToken) process.env.ONCOKB_TOKEN = originalToken;
    else delete process.env.ONCOKB_TOKEN;
  });

  test('sends hugoSymbol + normalized alteration, never legacy gene/byProteinChange params', async () => {
    global.fetch = jest.fn<(...args: any[]) => any>().mockResolvedValue({
      ok: true,
      json: () => Promise.resolve({
        geneExist: true,
        variantExist: true,
        hugoSymbol: 'BRAF',
        oncogenic: 'Oncogenic',
        highestLevel: 'LEVEL_1',
        mutationEffect: { knownEffect: 'Gain-of-function' },
        treatments: [
          { level: 'LEVEL_1', drugs: [{ drugName: 'Vemurafenib' }, { drugName: 'Dabrafenib' }] },
        ],
      }),
    }) as any;

    const result = await fetchOncoKbAnnotation('BRAF', 'p.Val600Glu');

    const callUrl = (global.fetch as any).mock.calls[0][0] as string;
    expect(callUrl).toContain('/annotate/mutations/byProteinChange?');
    expect(callUrl).toContain('hugoSymbol=BRAF');
    expect(callUrl).toContain('alteration=V600E');
    expect(callUrl).not.toContain('gene=');
    expect(callUrl).not.toContain('byProteinChange=');

    // IndicatorAnnotationResp mapping (conservative renames of mapped fields)
    expect(result).toEqual({
      oncogenic: 'Oncogenic',
      level: 'LEVEL_1',
      effect: 'Gain-of-function',
      therapies: [{ name: 'Vemurafenib, Dabrafenib', level: 'LEVEL_1' }],
    });
  });

  test('returns null annotation payload for empty OncoKB response object', async () => {
    global.fetch = jest.fn<(...args: any[]) => any>().mockResolvedValue({
      ok: true,
      json: () => Promise.resolve({ geneExist: false, variantExist: false }),
    }) as any;

    const result = await fetchOncoKbAnnotation('BRAF', 'V600E');

    expect(result).toEqual({ oncogenic: undefined, level: undefined, effect: undefined, therapies: [] });
  });
});

// ============================================================
// normalizeProteinChange
// ============================================================
describe('normalizeProteinChange', () => {
  test.each([
    ['V600E', 'V600E'],
    ['p.Val600Glu', 'V600E'],
    ['p.Val600Glu ', 'V600E'],
    ['Thr599_Val600insThr', 'T599_V600INST'],
    ['v600e', 'V600E'],
    ['p.Gly12Ter', 'G12*'],
    ['p.Val600*', 'V600*'],
  ])('normalizeProteinChange(%s) -> %s', (input, expected) => {
    expect(normalizeProteinChange(input)).toBe(expected);
  });
});
