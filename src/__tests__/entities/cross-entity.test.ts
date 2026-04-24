import { jest } from '@jest/globals';
import { geneEnrichment, discover, searchAll, batchGet } from '../../entities/cross-entity.js';

describe('cross-entity', () => {
  let originalFetch: typeof global.fetch;

  beforeEach(() => {
    jest.clearAllMocks();
    originalFetch = global.fetch;
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

  test('discover() calls geneSearch + drugSearch + diseaseSearch', async () => {
    global.fetch = jest.fn().mockResolvedValue({
      ok: true,
      json: () => Promise.resolve({ hits: [] }),
    }) as any;

    await discover('brca1');

    expect(global.fetch).toHaveBeenCalled();
    const urls = (global.fetch as any).mock.calls.map((c: any[]) => c[0] as string);
    const hasMygene = urls.some((u: string) => u.includes('mygene.info'));
    const hasMyvariant = urls.some((u: string) => u.includes('myvariant.info'));
    const hasMychem = urls.some((u: string) => u.includes('mychem.info'));
    const hasMydisease = urls.some((u: string) => u.includes('mydisease.info'));
    expect(hasMygene).toBe(true);
    expect(hasMyvariant).toBe(true);
    expect(hasMychem).toBe(true);
    expect(hasMydisease).toBe(true);
  });

  test('searchAll() calls all entity search functions', async () => {
    global.fetch = jest.fn().mockResolvedValue({
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
    const hasMygene = urls.some((u: string) => u.includes('mygene.info'));
    const hasMyvariant = urls.some((u: string) => u.includes('myvariant.info'));
    const hasMychem = urls.some((u: string) => u.includes('mychem.info'));
    const hasMydisease = urls.some((u: string) => u.includes('mydisease.info'));
    const hasClinicaltrials = urls.some((u: string) => u.includes('clinicaltrials.gov'));
    const hasEutils = urls.some((u: string) => u.includes('eutils.ncbi.nlm.nih.gov'));
    expect(hasMygene).toBe(true);
    expect(hasMyvariant).toBe(true);
    expect(hasMychem).toBe(true);
    expect(hasMydisease).toBe(true);
    expect(hasClinicaltrials).toBe(true);
    expect(hasEutils).toBe(true);
  });

  test('batchGet() calls correct entity get per type', async () => {
    global.fetch = jest.fn().mockResolvedValue({
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

  test('discover() falls back to OLS4 when no other results found', async () => {
    let callCount = 0;
    global.fetch = jest.fn().mockImplementation((url: string) => {
      callCount++;
      if (url.includes('mygene.info') || url.includes('myvariant.info') || url.includes('mychem.info') || url.includes('mydisease.info')) {
        return Promise.resolve({
          ok: true,
          json: () => Promise.resolve({ hits: [] }),
        });
      }
      if (url.includes('ols4')) {
        return Promise.resolve({
          ok: true,
          json: () => Promise.resolve({
            response: {
              docs: [
                { iri: 'http://example.org/BRCA1', obo_id: 'hgnc:1100', label: 'BRCA1', type: 'class', ontology_name: 'hgnc' },
              ],
              numFound: 1,
            },
          }),
        });
      }
      return Promise.resolve({
        ok: true,
        json: () => Promise.resolve({}),
      });
    }) as any;

    const results = await discover('BRCA1');

    const urls = (global.fetch as any).mock.calls.map((c: any[]) => c[0] as string);
    const hasOls4 = urls.some((u: string) => u.includes('ols4') && u.includes('/api/search'));
    expect(hasOls4).toBe(true);
    expect(results.some(r => r.name === 'BRCA1' && r.source === 'hgnc')).toBe(true);
  });
});
