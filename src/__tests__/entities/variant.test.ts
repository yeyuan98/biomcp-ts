import { jest } from '@jest/globals';
import { variantSearch, variantGet, transformMyVariantHit } from '../../entities/variant.js';

describe('variant', () => {
  let originalFetch: typeof global.fetch;

  beforeEach(() => {
    jest.clearAllMocks();
    originalFetch = global.fetch;
  });

  afterEach(() => {
    global.fetch = originalFetch;
  });

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
          clinvar: { significance: 'pathogenic', stars: 2 },
          gnomad: { af: 0.001 },
        }],
      }),
    }) as any;

    const results = await variantSearch({ query: 'rs123' });

    expect(results).toHaveLength(1);
    expect(results[0].id).toBe('rs123');
    expect(results[0].gene).toBe('BRCA1');
    expect(results[0].hgvs_p).toBe('p.Val600Glu');
    expect(results[0].significance).toBe('pathogenic');
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
      clinvar: { significance: 'pathogenic', stars: 2 },
      gnomad: { af: 0.001 },
    };

    const result = transformMyVariantHit(input);

    expect(result).toEqual({
      id: 'rs123',
      gene: 'BRCA1',
      hgvs_p: 'p.Val600Glu',
      hgvs_c: 'c.1799T>A',
      significance: 'pathogenic',
      clinvar_stars: 2,
      gnomad_af: 0.001,
    });
  });
});
