import { jest } from '@jest/globals';
import { diseaseSearch, diseaseGet, transformMyDiseaseResponse } from '../../entities/disease.js';
import { connectionManager } from '../../connections/manager.js';

describe('disease', () => {
  let originalFetch: typeof global.fetch;

  beforeEach(() => {
    jest.clearAllMocks();
    originalFetch = global.fetch;
    connectionManager.closeAll();
  });

  afterEach(() => {
    global.fetch = originalFetch;
  });

  test('diseaseSearch() calls connection with correct mydisease endpoint', async () => {
    global.fetch = jest.fn().mockResolvedValue({
      ok: true,
      json: () => Promise.resolve({ hits: [{ name: 'Breast Cancer', diseaseid: 'C0006142' }] }),
    }) as any;

    await diseaseSearch('breast cancer');

    expect(global.fetch).toHaveBeenCalled();
    const callUrl = (global.fetch as any).mock.calls[0][0] as string;
    expect(callUrl).toContain('mydisease.info');
    expect(callUrl).toContain('/query?');
    expect(callUrl).toContain('q=breast+cancer');
  });

  test('diseaseSearch() returns transformed results', async () => {
    global.fetch = jest.fn().mockResolvedValue({
      ok: true,
      json: () => Promise.resolve({
        hits: [{
          _id: 'MONDO:0007254',
          mondo: { label: 'Breast Cancer' },
          disease_ontology: { doid: 'DOID:1612' },
        }],
      }),
    }) as any;

    const results = await diseaseSearch('breast cancer');

    expect(results).toHaveLength(1);
    expect(results[0].name).toBe('Breast Cancer');
    expect(results[0].disease_id).toBe('MONDO:0007254');
    expect(results[0].doid).toBe('DOID:1612');
  });

  test('diseaseGet() calls connection with correct endpoint', async () => {
    global.fetch = jest.fn().mockResolvedValue({
      ok: true,
      json: () => Promise.resolve({
        _id: 'MONDO:0007254',
        mondo: { label: 'Breast Cancer' },
      }),
    }) as any;

    await diseaseGet('C0006142');

    expect(global.fetch).toHaveBeenCalled();
    const callUrl = (global.fetch as any).mock.calls[0][0] as string;
    expect(callUrl).toContain('mydisease.info');
    expect(callUrl).toContain('/disease/');
    expect(callUrl).toContain('C0006142');
  });

  test('diseaseGet() retries the alternate curie form when the primary lookup fails', async () => {
    global.fetch = jest.fn()
      .mockResolvedValueOnce({
        ok: false,
        status: 404,
      })
      .mockResolvedValueOnce({
        ok: true,
        json: () => Promise.resolve({
          _id: 'MONDO:0007254',
          mondo: { label: 'Breast Cancer' },
        }),
      }) as any;

    const result = await diseaseGet('MONDO_0007254');

    expect(global.fetch).toHaveBeenCalledTimes(2);
    const urls = (global.fetch as any).mock.calls.map((c: any[]) => String(c[0]));
    expect(urls[0]).toContain('/disease/MONDO_0007254');
    expect(urls[1]).toContain('/disease/MONDO%3A0007254');
    expect(result.disease_id).toBe('MONDO:0007254');
    expect(result.name).toBe('Breast Cancer');
  });

  test('diseaseGet() throws a descriptive error when no ID form resolves', async () => {
    global.fetch = jest.fn().mockResolvedValue({
      ok: false,
      status: 404,
    }) as any;

    await expect(diseaseGet('MONDO_9999999')).rejects.toThrow(/not found/);
    // Both separator forms attempted.
    expect(global.fetch).toHaveBeenCalledTimes(2);
  });

  test('transformMyDiseaseResponse() maps fields correctly', () => {
    const input = {
      _id: 'MONDO:0007254',
      mondo: { label: 'Breast Cancer' },
      disease_ontology: { doid: 'DOID:1612', def: 'A malignant neoplasm of the breast.' },
    };

    const result = transformMyDiseaseResponse(input);

    expect(result).toEqual({
      name: 'Breast Cancer',
      disease_id: 'MONDO:0007254',
      description: 'A malignant neoplasm of the breast.',
      ontology: 'mondo',
    });
  });
});

// ============================================================
// diseaseGet gene_associations section (DisGeNET gda/summary)
// ============================================================
describe('diseaseGet gene_associations section (DisGeNET)', () => {
  let originalFetch: typeof global.fetch;
  let originalEnv: string | undefined;

  beforeEach(() => {
    jest.clearAllMocks();
    originalFetch = global.fetch;
    originalEnv = process.env.DISGENET_API_KEY;
    process.env.DISGENET_API_KEY = 'test-disgenet-key';
    connectionManager.closeAll();
  });

  afterEach(() => {
    global.fetch = originalFetch;
    if (originalEnv !== undefined) {
      process.env.DISGENET_API_KEY = originalEnv;
    } else {
      delete process.env.DISGENET_API_KEY;
    }
  });

  test('queries gda/summary with normalized disease code and raw Authorization key', async () => {
    global.fetch = jest.fn().mockImplementation((input: any) => {
      const url = typeof input === 'string' ? input : input.url;
      if (url.includes('mydisease.info')) {
        return Promise.resolve({
          ok: true,
          json: () => Promise.resolve({
            _id: 'C0006142',
            mondo: { label: 'Breast carcinoma' },
          }),
          headers: new Headers({ 'content-type': 'application/json' }),
        });
      }
      // DisGeNET gda/summary response
      return Promise.resolve({
        ok: true,
        json: () => Promise.resolve({
          payload: [
            {
              symbolOfGene: 'BRCA1',
              geneNcbiID: 672,
              diseaseName: 'Breast carcinoma',
              diseaseUMLSCUI: 'C0006142',
              score: 0.9,
              numPMIDs: 120,
            },
          ],
          warnings: [],
          pageNum: 0,
          pageSize: 10,
          pageCount: 1,
          totalEntries: 1,
        }),
        headers: new Headers({ 'content-type': 'application/json' }),
      });
    }) as any;

    const result = await diseaseGet('C0006142', ['gene_associations']);

    const calls = (global.fetch as any).mock.calls;
    const disgenetCall = calls.find((c: any[]) => String(c[0]).includes('api.disgenet.com'));
    expect(disgenetCall).toBeDefined();
    const url = new URL(disgenetCall[0] as string);
    expect(url.pathname).toBe('/api/v1/gda/summary');
    expect(url.searchParams.get('disease')).toBe('UMLS_C0006142');
    expect(url.searchParams.get('page_number')).toBe('0');
    // Raw (unprefixed) API key in Authorization header.
    expect((disgenetCall[1].headers as Headers).get('Authorization')).toBe('test-disgenet-key');

    const associations = result.sections!.gene_associations as any[];
    expect(associations).toHaveLength(1);
    expect(associations[0]).toEqual({
      gene_symbol: 'BRCA1',
      name: 'BRCA1',
      disease_name: 'Breast carcinoma',
      score: 0.9,
      pmids: 120,
      source: 'disgenet',
    });
  });

  test('normalizes colon-form MONDO ids to DisGeNET underscore form', async () => {
    global.fetch = jest.fn().mockImplementation((input: any) => {
      const url = typeof input === 'string' ? input : input.url;
      if (url.includes('mydisease.info')) {
        return Promise.resolve({
          ok: true,
          json: () => Promise.resolve({
            _id: 'MONDO:0007254',
            mondo: { label: 'Breast Cancer' },
          }),
          headers: new Headers({ 'content-type': 'application/json' }),
        });
      }
      return Promise.resolve({
        ok: true,
        json: () => Promise.resolve({ payload: [], warnings: [] }),
        headers: new Headers({ 'content-type': 'application/json' }),
      });
    }) as any;

    await diseaseGet('MONDO:0007254', ['gene_associations']);

    const disgenetCall = (global.fetch as any).mock.calls.find((c: any[]) => String(c[0]).includes('api.disgenet.com'));
    expect(disgenetCall).toBeDefined();
    const url = new URL(disgenetCall[0] as string);
    expect(url.searchParams.get('disease')).toBe('MONDO_0007254');
  });
});
