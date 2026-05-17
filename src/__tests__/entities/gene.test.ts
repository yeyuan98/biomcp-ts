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

// ============================================================
// geneSearch with options
// ============================================================
describe('geneSearch with options', () => {
  let originalFetch: typeof global.fetch;

  beforeEach(() => {
    jest.clearAllMocks();
    originalFetch = global.fetch;
    connectionManager.closeAll();
  });

  afterEach(() => {
    global.fetch = originalFetch;
  });

  test('geneSearch() includes gene_type filter in query params', async () => {
    global.fetch = jest.fn().mockResolvedValue({
      ok: true,
      json: () => Promise.resolve({ hits: [] }),
    }) as any;

    await geneSearch('TP53', { gene_type: 'protein-coding' });

    const callUrl = (global.fetch as any).mock.calls[0][0] as string;
    expect(callUrl).toContain('type=protein-coding');
  });

  test('geneSearch() includes chromosome filter in query params', async () => {
    global.fetch = jest.fn().mockResolvedValue({
      ok: true,
      json: () => Promise.resolve({ hits: [] }),
    }) as any;

    await geneSearch('TP53', { chromosome: '17' });

    const callUrl = (global.fetch as any).mock.calls[0][0] as string;
    expect(callUrl).toContain('chr=17');
  });

  test('geneSearch() uses custom limit and offset', async () => {
    global.fetch = jest.fn().mockResolvedValue({
      ok: true,
      json: () => Promise.resolve({ hits: [] }),
    }) as any;

    await geneSearch('EGFR', { limit: 5, offset: 10 });

    const callUrl = (global.fetch as any).mock.calls[0][0] as string;
    expect(callUrl).toContain('size=5');
    expect(callUrl).toContain('from=10');
  });

  test('geneSearch() uses default limit=10 and offset=0', async () => {
    global.fetch = jest.fn().mockResolvedValue({
      ok: true,
      json: () => Promise.resolve({ hits: [] }),
    }) as any;

    await geneSearch('BRCA1');

    const callUrl = (global.fetch as any).mock.calls[0][0] as string;
    expect(callUrl).toContain('size=10');
    expect(callUrl).toContain('from=0');
  });

  test('geneSearch() does not include type/chr when options not provided', async () => {
    global.fetch = jest.fn().mockResolvedValue({
      ok: true,
      json: () => Promise.resolve({ hits: [] }),
    }) as any;

    await geneSearch('BRCA1');

    const callUrl = (global.fetch as any).mock.calls[0][0] as string;
    expect(callUrl).not.toContain('type=');
    expect(callUrl).not.toContain('chr=');
  });
});

// ============================================================
// geneSearch empty results
// ============================================================
describe('geneSearch empty results', () => {
  let originalFetch: typeof global.fetch;

  beforeEach(() => {
    jest.clearAllMocks();
    originalFetch = global.fetch;
    connectionManager.closeAll();
  });

  afterEach(() => {
    global.fetch = originalFetch;
  });

  test('geneSearch() returns empty array when API returns empty hits', async () => {
    global.fetch = jest.fn().mockResolvedValue({
      ok: true,
      json: () => Promise.resolve({ hits: [] }),
    }) as any;

    const results = await geneSearch('NONEXISTENT_GENE_XYZ');
    expect(results).toEqual([]);
  });

  test('geneSearch() returns empty array when API returns no hits field', async () => {
    global.fetch = jest.fn().mockResolvedValue({
      ok: true,
      json: () => Promise.resolve({}),
    }) as any;

    const results = await geneSearch('NONEXISTENT_GENE_XYZ');
    expect(results).toEqual([]);
  });
});

// ============================================================
// geneSearch with genomic_pos handling
// ============================================================
describe('geneSearch genomic_pos transformation', () => {
  let originalFetch: typeof global.fetch;

  beforeEach(() => {
    jest.clearAllMocks();
    originalFetch = global.fetch;
    connectionManager.closeAll();
  });

  afterEach(() => {
    global.fetch = originalFetch;
  });

  test('geneSearch() transforms genomic_pos into genomic_coordinates', async () => {
    global.fetch = jest.fn().mockResolvedValue({
      ok: true,
      json: () => Promise.resolve({
        hits: [{
          symbol: 'BRCA1',
          name: 'BRCA1 DNA repair',
          entrezgene: 672,
          genomic_pos: [{ chr: '17', start: 43044295, end: 43125370 }],
        }],
      }),
    }) as any;

    const results = await geneSearch('BRCA1');

    expect(results).toHaveLength(1);
    expect(results[0].genomic_coordinates).toEqual({
      chromosome: '17',
      start: 43044295,
      end: 43125370,
    });
  });

  test('geneSearch() handles result without genomic_pos', async () => {
    global.fetch = jest.fn().mockResolvedValue({
      ok: true,
      json: () => Promise.resolve({
        hits: [{
          symbol: 'MIR123',
          name: 'microRNA 123',
          entrezgene: 100000,
        }],
      }),
    }) as any;

    const results = await geneSearch('MIR123');

    expect(results).toHaveLength(1);
    expect(results[0].genomic_coordinates).toBeUndefined();
  });

  test('geneSearch() handles result with uniprot and omim fields', async () => {
    global.fetch = jest.fn().mockResolvedValue({
      ok: true,
      json: () => Promise.resolve({
        hits: [{
          symbol: 'TP53',
          name: 'Tumor protein p53',
          entrezgene: 7157,
          uniprot: ['P04637'],
          omim: [191170],
        }],
      }),
    }) as any;

    const results = await geneSearch('TP53');

    expect(results).toHaveLength(1);
    expect(results[0].uniprot_id).toBe('P04637');
    expect(results[0].omim_id).toBe('191170');
  });
});

// ============================================================
// geneGet with sections
// ============================================================
describe('geneGet with sections', () => {
  let originalFetch: typeof global.fetch;

  beforeEach(() => {
    jest.clearAllMocks();
    originalFetch = global.fetch;
    connectionManager.closeAll();
  });

  afterEach(() => {
    global.fetch = originalFetch;
  });

  test('geneGet() with pathways section triggers section fetch', async () => {
    // First call: gene lookup via mygene
    // Second call: reactome pathway fetch
    let callIndex = 0;
    global.fetch = jest.fn().mockImplementation(() => {
      callIndex++;
      if (callIndex === 1) {
        // mygene lookup
        return Promise.resolve({
          ok: true,
          json: () => Promise.resolve({
            hits: [{
              symbol: 'BRCA1',
              name: 'BRCA1 DNA repair',
              summary: 'A DNA repair gene.',
            }],
          }),
          headers: new Headers({ 'content-type': 'application/json' }),
        });
      }
      // Reactome pathway lookup
      return Promise.resolve({
        ok: true,
        json: () => Promise.resolve({
          results: [{
            entries: [{
              type: 'Pathway',
              stId: 'R-HSA-5693568',
              name: 'HDR through Homologous Recombination',
            }],
          }],
        }),
        headers: new Headers({ 'content-type': 'application/json' }),
      });
    }) as any;

    const result = await geneGet('BRCA1', ['pathways']);

    expect(result.symbol).toBe('BRCA1');
    expect(result.sections).toBeDefined();
    expect(result.sections!.pathways).toBeDefined();
    expect((result.sections!.pathways as any[])[0].name).toBe('HDR through Homologous Recombination');
    expect((result.sections!.pathways as any[])[0].source).toBe('reactome');
  });

  test('geneGet() with protein section triggers uniprot fetch', async () => {
    let callIndex = 0;
    global.fetch = jest.fn().mockImplementation(() => {
      callIndex++;
      if (callIndex === 1) {
        return Promise.resolve({
          ok: true,
          json: () => Promise.resolve({
            hits: [{
              symbol: 'TP53',
              name: 'Tumor protein p53',
              summary: 'Tumor suppressor.',
            }],
          }),
          headers: new Headers({ 'content-type': 'application/json' }),
        });
      }
      // UniProt fetch
      return Promise.resolve({
        ok: true,
        json: () => Promise.resolve({
          results: [{
            primaryAccession: 'P04637',
            proteinDescription: {
              recommendedName: { fullName: { value: 'Cellular tumor antigen p53' } },
            },
          }],
        }),
        headers: new Headers({ 'content-type': 'application/json' }),
      });
    }) as any;

    const result = await geneGet('TP53', ['protein']);

    expect(result.sections).toBeDefined();
    expect(result.sections!.protein).toBeDefined();
    expect((result.sections!.protein as any).accession).toBe('P04637');
    expect((result.sections!.protein as any).name).toBe('Cellular tumor antigen p53');
  });

  test('geneGet() fetches multiple sections in parallel', async () => {
    let callIndex = 0;
    global.fetch = jest.fn().mockImplementation(() => {
      callIndex++;
      if (callIndex === 1) {
        return Promise.resolve({
          ok: true,
          json: () => Promise.resolve({
            hits: [{
              symbol: 'BRCA1',
              name: 'BRCA1 DNA repair',
              summary: 'DNA repair.',
            }],
          }),
          headers: new Headers({ 'content-type': 'application/json' }),
        });
      }
      // For any subsequent call, return a generic response
      return Promise.resolve({
        ok: true,
        json: () => Promise.resolve({ results: [], hits: [{ go: {} }] }),
        headers: new Headers({ 'content-type': 'application/json' }),
      });
    }) as any;

    const result = await geneGet('BRCA1', ['pathways', 'protein']);

    expect(result.sections).toBeDefined();
    // Both sections should be present (even if empty data from generic mock)
    expect(result.sections!.pathways).toBeDefined();
    expect(result.sections!.protein).toBeDefined();
    // Should have made more than one fetch call
    expect(global.fetch).toHaveBeenCalledTimes(3); // 1 gene lookup + 2 section fetches
  });
});

// ============================================================
// geneGet with smart=true and alias resolution
// ============================================================
describe('geneGet with smart alias resolution', () => {
  let originalFetch: typeof global.fetch;

  beforeEach(() => {
    jest.clearAllMocks();
    originalFetch = global.fetch;
    connectionManager.closeAll();
  });

  afterEach(() => {
    global.fetch = originalFetch;
  });

  test('geneGet() smart=true resolves alias when exact match fails', async () => {
    let callIndex = 0;
    global.fetch = jest.fn().mockImplementation(() => {
      callIndex++;
      if (callIndex === 1) {
        // First lookup: no exact match
        return Promise.resolve({
          ok: true,
          json: () => Promise.resolve({ hits: [] }),
          headers: new Headers({ 'content-type': 'application/json' }),
        });
      }
      if (callIndex === 2) {
        // Alias lookup: finds matching alias
        return Promise.resolve({
          ok: true,
          json: () => Promise.resolve({
            hits: [{
              _id: '672',
              symbol: 'BRCA1',
              alias: ['RNF53', 'FANCS'],
            }],
          }),
          headers: new Headers({ 'content-type': 'application/json' }),
        });
      }
      // Third call: lookup by resolved symbol
      return Promise.resolve({
        ok: true,
        json: () => Promise.resolve({
          hits: [{
            symbol: 'BRCA1',
            name: 'BRCA1 DNA repair',
            summary: 'DNA repair gene.',
          }],
        }),
        headers: new Headers({ 'content-type': 'application/json' }),
      });
    }) as any;

    const result = await geneGet('RNF53', undefined, true);

    expect(result.symbol).toBe('BRCA1');
    expect(result.name).toBe('BRCA1 DNA repair');
    expect(global.fetch).toHaveBeenCalledTimes(3);
  });

  test('geneGet() smart=true, alias not found throws smart-specific error', async () => {
    let callIndex = 0;
    global.fetch = jest.fn().mockImplementation(() => {
      callIndex++;
      if (callIndex === 1) {
        // First lookup: no exact match
        return Promise.resolve({
          ok: true,
          json: () => Promise.resolve({ hits: [] }),
          headers: new Headers({ 'content-type': 'application/json' }),
        });
      }
      // Alias lookup: no alias found
      return Promise.resolve({
        ok: true,
        json: () => Promise.resolve({ hits: [] }),
        headers: new Headers({ 'content-type': 'application/json' }),
      });
    }) as any;

    await expect(geneGet('COMPLETELY_UNKNOWN_GENE_XYZ', undefined, true))
      .rejects.toThrow('No matching gene found for this name or alias');
  });
});

// ============================================================
// geneGet with smart=false, no hits
// ============================================================
describe('geneGet without smart mode', () => {
  let originalFetch: typeof global.fetch;

  beforeEach(() => {
    jest.clearAllMocks();
    originalFetch = global.fetch;
    connectionManager.closeAll();
  });

  afterEach(() => {
    global.fetch = originalFetch;
  });

  test('geneGet() smart=false, no hits throws error suggesting smart=true', async () => {
    global.fetch = jest.fn().mockResolvedValue({
      ok: true,
      json: () => Promise.resolve({ hits: [] }),
      headers: new Headers({ 'content-type': 'application/json' }),
    }) as any;

    await expect(geneGet('UNKNOWN_GENE_XYZ'))
      .rejects.toThrow('Use gene_search to find the official symbol, or enable smart=true for automatic alias resolution');
  });

  test('geneGet() with no smart param defaults to non-smart behavior', async () => {
    global.fetch = jest.fn().mockResolvedValue({
      ok: true,
      json: () => Promise.resolve({ hits: [] }),
      headers: new Headers({ 'content-type': 'application/json' }),
    }) as any;

    await expect(geneGet('UNKNOWN_GENE'))
      .rejects.toThrow('Use gene_search to find the official symbol');
  });
});

// ============================================================
// geneGet error in section fetch
// ============================================================
describe('geneGet section fetch error handling', () => {
  let originalFetch: typeof global.fetch;

  beforeEach(() => {
    jest.clearAllMocks();
    originalFetch = global.fetch;
    connectionManager.closeAll();
  });

  test('geneGet() returns partial results when a section fetch fails', async () => {
    let callIndex = 0;
    global.fetch = jest.fn().mockImplementation(() => {
      callIndex++;
      if (callIndex === 1) {
        // Gene lookup succeeds
        return Promise.resolve({
          ok: true,
          json: () => Promise.resolve({
            hits: [{
              symbol: 'BRCA1',
              name: 'BRCA1 DNA repair',
              summary: 'DNA repair gene.',
            }],
          }),
          headers: new Headers({ 'content-type': 'application/json' }),
        });
      }
      if (callIndex === 2) {
        // Section fetch fails
        return Promise.reject(new Error('Network timeout'));
      }
      // Fallback
      return Promise.resolve({
        ok: true,
        json: () => Promise.resolve({ results: [], hits: [] }),
        headers: new Headers({ 'content-type': 'application/json' }),
      });
    }) as any;

    const result = await geneGet('BRCA1', ['pathways']);

    expect(result.symbol).toBe('BRCA1');
    expect(result.sections).toBeDefined();
    // Failed section should have an error entry (fetchPathways catches internally)
    expect(result.sections!.pathways).toBeDefined();
    // fetchPathways catches errors and returns an array with _error
    const pathwaysData = result.sections!.pathways as Array<{ _error: string }>;
    expect(pathwaysData[0]._error).toBeDefined();
    expect(pathwaysData[0]._error).toContain('Pathway lookup failed');
  });
});

// ============================================================
// geneGet with 'all' sections
// ============================================================
describe('geneGet with all sections', () => {
  let originalFetch: typeof global.fetch;

  beforeEach(() => {
    jest.clearAllMocks();
    originalFetch = global.fetch;
    connectionManager.closeAll();
  });

  test('geneGet() with sections=["all"] fetches all known sections', async () => {
    let callIndex = 0;
    global.fetch = jest.fn().mockImplementation(() => {
      callIndex++;
      if (callIndex === 1) {
        return Promise.resolve({
          ok: true,
          json: () => Promise.resolve({
            hits: [{
              symbol: 'TP53',
              name: 'Tumor protein p53',
              summary: 'Tumor suppressor.',
            }],
          }),
          headers: new Headers({ 'content-type': 'application/json' }),
        });
      }
      // All section fetches return minimal data
      return Promise.resolve({
        ok: true,
        json: () => Promise.resolve({ results: [], hits: [], data: {} }),
        headers: new Headers({ 'content-type': 'application/json' }),
        text: () => Promise.resolve('[]'),
        arrayBuffer: () => Promise.resolve(Buffer.from('[]')),
      });
    }) as any;

    const result = await geneGet('TP53', ['all']);

    expect(result.symbol).toBe('TP53');
    expect(result.sections).toBeDefined();
    // Should have many sections - the code fetches 14 sections for 'all'
    const sectionKeys = Object.keys(result.sections!);
    expect(sectionKeys.length).toBeGreaterThanOrEqual(14);
    // Verify some expected section keys
    expect(sectionKeys).toContain('pathways');
    expect(sectionKeys).toContain('protein');
    expect(sectionKeys).toContain('ontology');
    expect(sectionKeys).toContain('interactions');
    expect(sectionKeys).toContain('civic');
    expect(sectionKeys).toContain('expression');
  });
});

// ============================================================
// geneGet abort/timeout handling
// ============================================================
describe('geneGet abort/timeout handling', () => {
  let originalFetch: typeof global.fetch;

  beforeEach(() => {
    jest.clearAllMocks();
    originalFetch = global.fetch;
    connectionManager.closeAll();
  });

  afterEach(() => {
    global.fetch = originalFetch;
  });

  test('geneGet() handles AbortError from fetch', async () => {
    const abortError = new DOMException('The operation was aborted', 'AbortError');
    global.fetch = jest.fn().mockRejectedValue(abortError) as any;

    await expect(geneGet('BRCA1')).rejects.toThrow();
  });
});

// ============================================================
// geneGet with genomic_pos transformation
// ============================================================
describe('geneGet genomic_pos handling', () => {
  let originalFetch: typeof global.fetch;

  beforeEach(() => {
    jest.clearAllMocks();
    originalFetch = global.fetch;
    connectionManager.closeAll();
  });

  afterEach(() => {
    global.fetch = originalFetch;
  });

  test('geneGet() sets chromosome and position from genomic_pos', async () => {
    global.fetch = jest.fn().mockResolvedValue({
      ok: true,
      json: () => Promise.resolve({
        hits: [{
          symbol: 'BRCA1',
          name: 'BRCA1 DNA repair',
          summary: 'DNA repair.',
          genomic_pos: [{ chr: '17', start: 43044295, end: 43125370 }],
        }],
      }),
      headers: new Headers({ 'content-type': 'application/json' }),
    }) as any;

    const result = await geneGet('BRCA1');

    expect(result.chromosome).toBe('17');
    expect(result.position).toBe('43044295-43125370');
  });

  test('geneGet() handles non-array genomic_pos', async () => {
    global.fetch = jest.fn().mockResolvedValue({
      ok: true,
      json: () => Promise.resolve({
        hits: [{
          symbol: 'TP53',
          name: 'Tumor protein p53',
          genomic_pos: { chr: '17', start: 7661779, end: 7687538 },
        }],
      }),
      headers: new Headers({ 'content-type': 'application/json' }),
    }) as any;

    const result = await geneGet('TP53');

    expect(result.chromosome).toBe('17');
    expect(result.position).toBe('7661779-7687538');
  });

  test('geneGet() handles missing genomic_pos', async () => {
    global.fetch = jest.fn().mockResolvedValue({
      ok: true,
      json: () => Promise.resolve({
        hits: [{
          symbol: 'MIRLET7A1',
          name: 'microRNA let-7a-1',
          summary: 'A microRNA.',
        }],
      }),
      headers: new Headers({ 'content-type': 'application/json' }),
    }) as any;

    const result = await geneGet('MIRLET7A1');

    expect(result.chromosome).toBeUndefined();
    expect(result.position).toBeUndefined();
  });
});

// ============================================================
// geneGet section aliases
// ============================================================
describe('geneGet section aliases', () => {
  let originalFetch: typeof global.fetch;

  beforeEach(() => {
    jest.clearAllMocks();
    originalFetch = global.fetch;
    connectionManager.closeAll();
  });

  afterEach(() => {
    global.fetch = originalFetch;
  });

  test('geneGet() maps dosage_sensitivity alias to clingen', async () => {
    let callIndex = 0;
    global.fetch = jest.fn().mockImplementation(() => {
      callIndex++;
      if (callIndex === 1) {
        return Promise.resolve({
          ok: true,
          json: () => Promise.resolve({
            hits: [{
              symbol: 'BRCA1',
              name: 'BRCA1 DNA repair',
              summary: 'DNA repair.',
            }],
          }),
          headers: new Headers({ 'content-type': 'application/json' }),
        });
      }
      // clingen always returns error stub
      return Promise.resolve({
        ok: true,
        json: () => Promise.resolve({}),
        headers: new Headers({ 'content-type': 'application/json' }),
      });
    }) as any;

    const result = await geneGet('BRCA1', ['dosage_sensitivity']);

    expect(result.sections).toBeDefined();
    // clingen returns an error object about no public API
    expect(result.sections!.clingen).toBeDefined();
    expect((result.sections!.clingen as any)._error).toContain('ClinGen');
  });

  test('geneGet() maps protein_atlas alias to hpa', async () => {
    let callIndex = 0;
    global.fetch = jest.fn().mockImplementation((url: string) => {
      callIndex++;
      if (callIndex === 1) {
        return Promise.resolve({
          ok: true,
          json: () => Promise.resolve({
            hits: [{
              symbol: 'BRCA1',
              name: 'BRCA1',
              summary: 'DNA repair.',
            }],
          }),
          headers: new Headers({ 'content-type': 'application/json' }),
        });
      }
      // HPA fetch — proteinatlas.org
      return Promise.resolve({
        ok: true,
        json: () => Promise.resolve([
          { Gene: 'BRCA1', 'Subcellular location': ['Nucleus', 'Cytoplasm'] },
        ]),
        headers: new Headers({ 'content-type': 'application/json' }),
        arrayBuffer: () => Promise.resolve(Buffer.from(JSON.stringify([
          { Gene: 'BRCA1', 'Subcellular location': ['Nucleus', 'Cytoplasm'] },
        ]))),
        text: () => Promise.resolve(JSON.stringify([
          { Gene: 'BRCA1', 'Subcellular location': ['Nucleus', 'Cytoplasm'] },
        ])),
      });
    }) as any;

    const result = await geneGet('BRCA1', ['protein_atlas']);

    expect(result.sections).toBeDefined();
    expect(result.sections!.hpa).toBeDefined();
  });
});

// ============================================================
// resolveGeneAlias - case-exact match priority
// ============================================================
describe('resolveGeneAlias via geneGet smart', () => {
  let originalFetch: typeof global.fetch;

  beforeEach(() => {
    jest.clearAllMocks();
    originalFetch = global.fetch;
    connectionManager.closeAll();
  });

  afterEach(() => {
    global.fetch = originalFetch;
  });

  test('geneGet() smart mode prefers case-exact alias match', async () => {
    let callIndex = 0;
    global.fetch = jest.fn().mockImplementation(() => {
      callIndex++;
      if (callIndex === 1) {
        // First lookup: no exact match
        return Promise.resolve({
          ok: true,
          json: () => Promise.resolve({ hits: [] }),
          headers: new Headers({ 'content-type': 'application/json' }),
        });
      }
      if (callIndex === 2) {
        // Alias lookup: two hits with different case aliases
        return Promise.resolve({
          ok: true,
          json: () => Promise.resolve({
            hits: [
              {
                _id: '100',
                symbol: 'GENEA',
                alias: ['aliasA', 'CASEMATCH'],  // case-exact match for 'CASEMATCH'
              },
              {
                _id: '200',
                symbol: 'GENEB',
                alias: ['casematch'],  // case-insensitive only
              },
            ],
          }),
          headers: new Headers({ 'content-type': 'application/json' }),
        });
      }
      // Third call: resolved lookup
      return Promise.resolve({
        ok: true,
        json: () => Promise.resolve({
          hits: [{
            symbol: 'GENEA',
            name: 'Gene A',
            summary: 'Gene A description.',
          }],
        }),
        headers: new Headers({ 'content-type': 'application/json' }),
      });
    }) as any;

    const result = await geneGet('CASEMATCH', undefined, true);

    // Should resolve to GENEA because it has the case-exact alias 'CASEMATCH'
    expect(result.symbol).toBe('GENEA');
  });

  test('geneGet() smart mode falls back to case-insensitive alias match', async () => {
    let callIndex = 0;
    global.fetch = jest.fn().mockImplementation(() => {
      callIndex++;
      if (callIndex === 1) {
        return Promise.resolve({
          ok: true,
          json: () => Promise.resolve({ hits: [] }),
          headers: new Headers({ 'content-type': 'application/json' }),
        });
      }
      if (callIndex === 2) {
        // Alias lookup: only case-insensitive match available
        return Promise.resolve({
          ok: true,
          json: () => Promise.resolve({
            hits: [{
              _id: '672',
              symbol: 'BRCA1',
              alias: ['rnf53', 'fancs'],  // lowercase alias for RNF53
            }],
          }),
          headers: new Headers({ 'content-type': 'application/json' }),
        });
      }
      // Resolved lookup
      return Promise.resolve({
        ok: true,
        json: () => Promise.resolve({
          hits: [{
            symbol: 'BRCA1',
            name: 'BRCA1 DNA repair',
            summary: 'DNA repair.',
          }],
        }),
        headers: new Headers({ 'content-type': 'application/json' }),
      });
    }) as any;

    const result = await geneGet('RNF53', undefined, true);

    // Should resolve to BRCA1 via case-insensitive match
    expect(result.symbol).toBe('BRCA1');
  });

  test('geneGet() smart mode handles string alias (not array)', async () => {
    let callIndex = 0;
    global.fetch = jest.fn().mockImplementation(() => {
      callIndex++;
      if (callIndex === 1) {
        return Promise.resolve({
          ok: true,
          json: () => Promise.resolve({ hits: [] }),
          headers: new Headers({ 'content-type': 'application/json' }),
        });
      }
      if (callIndex === 2) {
        // Alias returned as a single string (not array)
        return Promise.resolve({
          ok: true,
          json: () => Promise.resolve({
            hits: [{
              _id: '672',
              symbol: 'BRCA1',
              alias: 'FANCS',  // string, not array
            }],
          }),
          headers: new Headers({ 'content-type': 'application/json' }),
        });
      }
      // Resolved lookup
      return Promise.resolve({
        ok: true,
        json: () => Promise.resolve({
          hits: [{
            symbol: 'BRCA1',
            name: 'BRCA1 DNA repair',
            summary: 'DNA repair.',
          }],
        }),
        headers: new Headers({ 'content-type': 'application/json' }),
      });
    }) as any;

    const result = await geneGet('FANCS', undefined, true);

    expect(result.symbol).toBe('BRCA1');
  });

  test('geneGet() smart mode sorts alias hits by _id for deterministic ordering', async () => {
    let callIndex = 0;
    global.fetch = jest.fn().mockImplementation(() => {
      callIndex++;
      if (callIndex === 1) {
        return Promise.resolve({
          ok: true,
          json: () => Promise.resolve({ hits: [] }),
          headers: new Headers({ 'content-type': 'application/json' }),
        });
      }
      if (callIndex === 2) {
        // Two hits with same alias, different _id (entrezgene)
        // The one with lower _id should be preferred
        return Promise.resolve({
          ok: true,
          json: () => Promise.resolve({
            hits: [
              {
                _id: '9999',
                symbol: 'LATER_GENE',
                alias: ['shared_alias'],
              },
              {
                _id: '100',
                symbol: 'EARLIER_GENE',
                alias: ['shared_alias'],
              },
            ],
          }),
          headers: new Headers({ 'content-type': 'application/json' }),
        });
      }
      // Resolved lookup
      return Promise.resolve({
        ok: true,
        json: () => Promise.resolve({
          hits: [{
            symbol: 'EARLIER_GENE',
            name: 'Earlier Gene',
            summary: 'A gene.',
          }],
        }),
        headers: new Headers({ 'content-type': 'application/json' }),
      });
    }) as any;

    const result = await geneGet('shared_alias', undefined, true);

    // Lower _id = 100 should be picked first
    expect(result.symbol).toBe('EARLIER_GENE');
  });
});

// ============================================================
// geneGet core only (no sections)
// ============================================================
describe('geneGet core only', () => {
  let originalFetch: typeof global.fetch;

  beforeEach(() => {
    jest.clearAllMocks();
    originalFetch = global.fetch;
    connectionManager.closeAll();
  });

  afterEach(() => {
    global.fetch = originalFetch;
  });

  test('geneGet() without sections returns core fields only', async () => {
    global.fetch = jest.fn().mockResolvedValue({
      ok: true,
      json: () => Promise.resolve({
        hits: [{
          symbol: 'TP53',
          name: 'Tumor protein p53',
          summary: 'A tumor suppressor gene.',
        }],
      }),
      headers: new Headers({ 'content-type': 'application/json' }),
    }) as any;

    const result = await geneGet('TP53');

    expect(result.symbol).toBe('TP53');
    expect(result.name).toBe('Tumor protein p53');
    expect(result.summary).toBe('A tumor suppressor gene.');
    expect(result.sections).toBeUndefined();
  });
});

// ============================================================
// geneGet with GO section
// ============================================================
describe('geneGet with GO section', () => {
  let originalFetch: typeof global.fetch;

  beforeEach(() => {
    jest.clearAllMocks();
    originalFetch = global.fetch;
    connectionManager.closeAll();
  });

  afterEach(() => {
    global.fetch = originalFetch;
  });

  test('geneGet() fetches GO terms and categorizes by aspect', async () => {
    let callIndex = 0;
    global.fetch = jest.fn().mockImplementation(() => {
      callIndex++;
      if (callIndex === 1) {
        return Promise.resolve({
          ok: true,
          json: () => Promise.resolve({
            hits: [{
              symbol: 'TP53',
              name: 'Tumor protein p53',
              summary: 'Tumor suppressor.',
            }],
          }),
          headers: new Headers({ 'content-type': 'application/json' }),
        });
      }
      // GO section fetch via mygene
      return Promise.resolve({
        ok: true,
        json: () => Promise.resolve({
          hits: [{
            go: {
              BP: [
                { id: 'GO:0006915', term: 'apoptotic process' },
                { id: 'GO:0008283', term: 'cell population proliferation' },
              ],
              MF: [
                { id: 'GO:0003700', term: 'DNA-binding transcription factor activity' },
              ],
              CC: [
                { id: 'GO:0005634', term: 'nucleus' },
              ],
            },
          }],
        }),
        headers: new Headers({ 'content-type': 'application/json' }),
      });
    }) as any;

    const result = await geneGet('TP53', ['go']);

    expect(result.sections).toBeDefined();
    expect(result.sections!.go).toBeDefined();
    const goTerms = result.sections!.go as Array<{ id: string; term: string; aspect: string }>;
    expect(goTerms.length).toBe(4);
    expect(goTerms.some(t => t.aspect === 'BP')).toBe(true);
    expect(goTerms.some(t => t.aspect === 'MF')).toBe(true);
    expect(goTerms.some(t => t.aspect === 'CC')).toBe(true);
  });
});

// ============================================================
// geneGet with interactions section
// ============================================================
describe('geneGet with interactions section', () => {
  let originalFetch: typeof global.fetch;

  beforeEach(() => {
    jest.clearAllMocks();
    originalFetch = global.fetch;
    connectionManager.closeAll();
  });

  afterEach(() => {
    global.fetch = originalFetch;
  });

  test('geneGet() fetches protein-protein interactions from STRING', async () => {
    let callIndex = 0;
    global.fetch = jest.fn().mockImplementation(() => {
      callIndex++;
      if (callIndex === 1) {
        return Promise.resolve({
          ok: true,
          json: () => Promise.resolve({
            hits: [{
              symbol: 'TP53',
              name: 'Tumor protein p53',
              summary: 'Tumor suppressor.',
            }],
          }),
          headers: new Headers({ 'content-type': 'application/json' }),
        });
      }
      // STRING interactions
      return Promise.resolve({
        ok: true,
        json: () => Promise.resolve([
          { preferredName_B: 'MDM2', score: 0.999 },
          { preferredName_B: 'BRCA1', score: 0.956 },
        ]),
        headers: new Headers({ 'content-type': 'application/json' }),
      });
    }) as any;

    const result = await geneGet('TP53', ['interactions']);

    expect(result.sections).toBeDefined();
    const interactions = result.sections!.interactions as Array<{ symbol: string; score: number; source: string }>;
    expect(interactions.length).toBe(2);
    expect(interactions[0].symbol).toBe('MDM2');
    expect(interactions[0].source).toBe('string');
    expect(interactions[1].score).toBe(0.956);
  });
});

// ============================================================
// geneGet with civic section
// ============================================================
describe('geneGet with civic section', () => {
  let originalFetch: typeof global.fetch;

  beforeEach(() => {
    jest.clearAllMocks();
    originalFetch = global.fetch;
    connectionManager.closeAll();
  });

  afterEach(() => {
    global.fetch = originalFetch;
  });

  test('geneGet() fetches CIViC clinical variants', async () => {
    let callIndex = 0;
    global.fetch = jest.fn().mockImplementation(() => {
      callIndex++;
      if (callIndex === 1) {
        return Promise.resolve({
          ok: true,
          json: () => Promise.resolve({
            hits: [{
              symbol: 'BRAF',
              name: 'B-Raf proto-oncogene',
              summary: 'Serine/threonine kinase.',
            }],
          }),
          headers: new Headers({ 'content-type': 'application/json' }),
        });
      }
      // CIViC GraphQL response
      return Promise.resolve({
        ok: true,
        json: () => Promise.resolve({
          data: {
            gene: {
              id: 5,
              name: 'BRAF',
              variants: {
                nodes: [
                  { id: 12, name: 'V600E' },
                  { id: 33, name: 'K601E' },
                ],
              },
            },
          },
        }),
        headers: new Headers({ 'content-type': 'application/json' }),
      });
    }) as any;

    const result = await geneGet('BRAF', ['civic']);

    expect(result.sections).toBeDefined();
    const civic = result.sections!.civic as { variants: Array<{ name: string }> };
    expect(civic.variants).toBeDefined();
    expect(civic.variants.length).toBe(2);
    expect(civic.variants[0].name).toBe('V600E');
  });
});

// ============================================================
// geneGet with unknown section
// ============================================================
describe('geneGet with unknown section', () => {
  let originalFetch: typeof global.fetch;

  beforeEach(() => {
    jest.clearAllMocks();
    originalFetch = global.fetch;
    connectionManager.closeAll();
  });

  afterEach(() => {
    global.fetch = originalFetch;
  });

  test('geneGet() handles unknown section name gracefully', async () => {
    global.fetch = jest.fn().mockResolvedValue({
      ok: true,
      json: () => Promise.resolve({
        hits: [{
          symbol: 'TP53',
          name: 'Tumor protein p53',
          summary: 'Tumor suppressor.',
        }],
      }),
      headers: new Headers({ 'content-type': 'application/json' }),
    }) as any;

    const result = await geneGet('TP53', ['unknown_section_xyz']);

    expect(result.symbol).toBe('TP53');
    expect(result.sections).toBeDefined();
    // Unknown section should still be present but with null data
    expect(result.sections!.unknown_section_xyz).toBeNull();
  });
});

// ============================================================
// geneGet with clingen section (stub)
// ============================================================
describe('geneGet with clingen section', () => {
  let originalFetch: typeof global.fetch;

  beforeEach(() => {
    jest.clearAllMocks();
    originalFetch = global.fetch;
    connectionManager.closeAll();
  });

  afterEach(() => {
    global.fetch = originalFetch;
  });

  test('geneGet() clingen returns error about no public API', async () => {
    global.fetch = jest.fn().mockResolvedValue({
      ok: true,
      json: () => Promise.resolve({
        hits: [{
          symbol: 'BRCA1',
          name: 'BRCA1 DNA repair',
          summary: 'DNA repair.',
        }],
      }),
      headers: new Headers({ 'content-type': 'application/json' }),
    }) as any;

    const result = await geneGet('BRCA1', ['clingen']);

    expect(result.sections).toBeDefined();
    expect(result.sections!.clingen).toBeDefined();
    expect((result.sections!.clingen as any)._error).toContain('ClinGen');
    expect((result.sections!.clingen as any)._error).toContain('not available via public API');
  });
});

// ============================================================
// geneGet with constraint section (gnomad)
// ============================================================
describe('geneGet with constraint section', () => {
  let originalFetch: typeof global.fetch;

  beforeEach(() => {
    jest.clearAllMocks();
    originalFetch = global.fetch;
    connectionManager.closeAll();
  });

  afterEach(() => {
    global.fetch = originalFetch;
  });

  test('geneGet() fetches gnomAD constraint scores', async () => {
    let callIndex = 0;
    global.fetch = jest.fn().mockImplementation(() => {
      callIndex++;
      if (callIndex === 1) {
        return Promise.resolve({
          ok: true,
          json: () => Promise.resolve({
            hits: [{
              symbol: 'TP53',
              name: 'Tumor protein p53',
              summary: 'Tumor suppressor.',
            }],
          }),
          headers: new Headers({ 'content-type': 'application/json' }),
        });
      }
      // gnomAD GraphQL response
      return Promise.resolve({
        ok: true,
        json: () => Promise.resolve({
          data: {
            gene: {
              gnomad_constraint: {
                oe_lof: 0.08,
                oe_lof_upper: 0.12,
                oe_mis: 0.76,
                oe_syn: 0.98,
              },
            },
          },
        }),
        headers: new Headers({ 'content-type': 'application/json' }),
      });
    }) as any;

    const result = await geneGet('TP53', ['constraint']);

    expect(result.sections).toBeDefined();
    const constraint = result.sections!.constraint as any;
    expect(constraint.lof).toBeDefined();
    expect(constraint.lof.oe_score).toBe(0.08);
    expect(constraint.lof.oe_lof_upper).toBe(0.12);
    expect(constraint.lof.mis_bad_loe).toBe(0.76);
    expect(constraint.syn).toBeDefined();
    expect(constraint.syn.oe_score).toBe(0.98);
  });
});

// ============================================================
// geneGet with disgenet section (no API key)
// ============================================================
describe('geneGet with disgenet section', () => {
  let originalFetch: typeof global.fetch;
  let originalEnv: string | undefined;

  beforeEach(() => {
    jest.clearAllMocks();
    originalFetch = global.fetch;
    originalEnv = process.env.DISGENET_API_KEY;
    delete process.env.DISGENET_API_KEY;
    connectionManager.closeAll();
  });

  afterEach(() => {
    global.fetch = originalFetch;
    if (originalEnv !== undefined) {
      process.env.DISGENET_API_KEY = originalEnv;
    }
  });

  test('geneGet() disgenet returns error when DISGENET_API_KEY not set', async () => {
    global.fetch = jest.fn().mockResolvedValue({
      ok: true,
      json: () => Promise.resolve({
        hits: [{
          symbol: 'BRCA1',
          name: 'BRCA1 DNA repair',
          summary: 'DNA repair.',
        }],
      }),
      headers: new Headers({ 'content-type': 'application/json' }),
    }) as any;

    const result = await geneGet('BRCA1', ['disgenet']);

    expect(result.sections).toBeDefined();
    const disgenet = result.sections!.disgenet as any;
    expect(disgenet._error).toContain('DISGENET_API_KEY');
  });
});

// ============================================================
// geneGet with ontology section
// ============================================================
describe('geneGet with ontology section', () => {
  let originalFetch: typeof global.fetch;

  beforeEach(() => {
    jest.clearAllMocks();
    originalFetch = global.fetch;
    connectionManager.closeAll();
  });

  afterEach(() => {
    global.fetch = originalFetch;
  });

  test('geneGet() fetches ontology enrichment data', async () => {
    let callIndex = 0;
    global.fetch = jest.fn().mockImplementation(() => {
      callIndex++;
      if (callIndex === 1) {
        return Promise.resolve({
          ok: true,
          json: () => Promise.resolve({
            hits: [{
              symbol: 'TP53',
              name: 'Tumor protein p53',
              summary: 'Tumor suppressor.',
            }],
          }),
          headers: new Headers({ 'content-type': 'application/json' }),
        });
      }
      // mygene GO response
      return Promise.resolve({
        ok: true,
        json: () => Promise.resolve({
          hits: [{
            go: {
              BP: [
                { id: 'GO:0006915', term: 'apoptotic process' },
              ],
              MF: [
                { id: 'GO:0003700', term: 'DNA-binding transcription factor activity' },
              ],
              CC: [
                { id: 'GO:0005634', term: 'nucleus' },
              ],
            },
          }],
        }),
        headers: new Headers({ 'content-type': 'application/json' }),
      });
    }) as any;

    const result = await geneGet('TP53', ['ontology']);

    expect(result.sections).toBeDefined();
    const ontology = result.sections!.ontology as any;
    expect(ontology.go_enrichment).toBeDefined();
    expect(ontology.go_enrichment.length).toBe(3);
  });
});

// ============================================================
// geneGet multiple sections with partial failure
// ============================================================
describe('geneGet multiple sections with partial success and failure', () => {
  let originalFetch: typeof global.fetch;

  beforeEach(() => {
    jest.clearAllMocks();
    originalFetch = global.fetch;
    connectionManager.closeAll();
  });

  afterEach(() => {
    global.fetch = originalFetch;
  });

  test('geneGet() returns mix of successful and failed sections', async () => {
    let callIndex = 0;
    global.fetch = jest.fn().mockImplementation(() => {
      callIndex++;
      if (callIndex === 1) {
        // Gene lookup
        return Promise.resolve({
          ok: true,
          json: () => Promise.resolve({
            hits: [{
              symbol: 'BRCA1',
              name: 'BRCA1 DNA repair',
              summary: 'DNA repair.',
            }],
          }),
          headers: new Headers({ 'content-type': 'application/json' }),
        });
      }
      if (callIndex === 2) {
        // pathways section: success
        return Promise.resolve({
          ok: true,
          json: () => Promise.resolve({
            results: [{
              entries: [{
                type: 'Pathway',
                stId: 'R-HSA-1',
                name: 'Test Pathway',
              }],
            }],
          }),
          headers: new Headers({ 'content-type': 'application/json' }),
        });
      }
      // protein section: failure
      return Promise.reject(new Error('UniProt is down'));
    }) as any;

    const result = await geneGet('BRCA1', ['pathways', 'protein']);

    expect(result.sections).toBeDefined();
    // Pathways should succeed
    expect(result.sections!.pathways).toBeDefined();
    const pathways = result.sections!.pathways as Array<{ id: string; name: string; source: string }>;
    expect(pathways[0].name).toBe('Test Pathway');

    // Protein should have error (fetchProtein catches internally and returns { _error })
    expect(result.sections!.protein).toBeDefined();
    const proteinError = result.sections!.protein as { _error: string };
    expect(proteinError._error).toBeDefined();
    expect(proteinError._error).toContain('Protein lookup failed');
  });
});

// ============================================================
// transformMyGeneResponse additional tests
// ============================================================
describe('transformMyGeneResponse edge cases', () => {
  test('handles missing summary', () => {
    const input = { symbol: 'TP53', name: 'Tumor protein p53' };
    const result = transformMyGeneResponse(input);
    expect(result.summary).toBeUndefined();
  });

  test('preserves all fields', () => {
    const input = {
      symbol: 'BRCA1',
      name: 'BRCA1 DNA repair',
      summary: 'DNA repair gene.',
    };
    const result = transformMyGeneResponse(input);
    expect(result).toEqual(input);
  });
});
