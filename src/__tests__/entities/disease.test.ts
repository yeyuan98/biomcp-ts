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
        hits: [{ name: 'Breast Cancer', diseaseid: 'C0006142' }],
      }),
    }) as any;

    await diseaseGet('C0006142');

    expect(global.fetch).toHaveBeenCalled();
    const callUrl = (global.fetch as any).mock.calls[0][0] as string;
    expect(callUrl).toContain('mydisease.info');
    expect(callUrl).toContain('/disease/');
    expect(callUrl).toContain('C0006142');
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
