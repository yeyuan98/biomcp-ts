import { jest } from '@jest/globals';
import { geneSearch, geneGet, transformMyGeneResponse } from '../../entities/gene.js';
import { connectionManager } from '../../connections/manager.js';

describe('gene', () => {
  let originalFetch: typeof global.fetch;

  beforeEach(() => {
    jest.clearAllMocks();
    originalFetch = global.fetch;
    connectionManager.closeAll();
  });

  afterEach(() => {
    global.fetch = originalFetch;
  });

  test('geneSearch() calls connection with correct mygene search endpoint', async () => {
    global.fetch = jest.fn().mockResolvedValue({
      ok: true,
      json: () => Promise.resolve({ hits: [{ symbol: 'BRCA1', name: 'BRCA1' }] }),
    }) as any;

    await geneSearch('brca1');

    expect(global.fetch).toHaveBeenCalled();
    const callUrl = (global.fetch as any).mock.calls[0][0] as string;
    expect(callUrl).toContain('mygene.info');
    expect(callUrl).toContain('/query?');
    expect(callUrl).toContain('q=brca1');
  });

  test('geneSearch() returns transformed results', async () => {
    global.fetch = jest.fn().mockResolvedValue({
      ok: true,
      json: () => Promise.resolve({
        hits: [{ symbol: 'BRCA1', name: 'BRCA1 DNA repair', entrezgene: 672 }],
      }),
    }) as any;

    const results = await geneSearch('brca1');

    expect(results).toHaveLength(1);
    expect(results[0].symbol).toBe('BRCA1');
    expect(results[0].name).toBe('BRCA1 DNA repair');
    expect(results[0].entrez_id).toBe(672);
  });

  test('geneGet() calls connection with correct endpoint', async () => {
    global.fetch = jest.fn().mockResolvedValue({
      ok: true,
      json: () => Promise.resolve({
        hits: [{ symbol: 'BRCA1', name: 'BRCA1 DNA repair' }],
      }),
    }) as any;

    await geneGet('BRCA1');

    expect(global.fetch).toHaveBeenCalled();
    const callUrl = (global.fetch as any).mock.calls[0][0] as string;
    expect(callUrl).toContain('mygene.info');
    expect(callUrl).toContain('/query?');
    expect(callUrl).toContain('symbol');
    expect(callUrl).toContain('BRCA1');
  });

  test('transformMyGeneResponse() maps fields correctly', () => {
    const input = {
      symbol: 'BRCA1',
      name: 'BRCA1 DNA repair',
      summary: 'This gene encodes a protein that functions in DNA repair.',
    };

    const result = transformMyGeneResponse(input);

    expect(result).toEqual({
      symbol: 'BRCA1',
      name: 'BRCA1 DNA repair',
      summary: 'This gene encodes a protein that functions in DNA repair.',
    });
  });
});
