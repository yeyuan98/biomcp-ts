import { jest } from '@jest/globals';
import { diseaseSearch, diseaseGet, transformMyDiseaseResponse } from '../../entities/disease.js';

describe('disease', () => {
  let originalFetch: typeof global.fetch;

  beforeEach(() => {
    jest.clearAllMocks();
    originalFetch = global.fetch;
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
        hits: [{ name: 'Breast Cancer', diseaseid: 'C0006142', ontology: 'DOID:1612' }],
      }),
    }) as any;

    const results = await diseaseSearch('breast cancer');

    expect(results).toHaveLength(1);
    expect(results[0].name).toBe('Breast Cancer');
    expect(results[0].disease_id).toBe('C0006142');
    expect(results[0].ontology).toBe('DOID:1612');
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
      name: 'Breast Cancer',
      diseaseid: 'C0006142',
      description: 'A malignant neoplasm of the breast.',
      ontology: 'DOID:1612',
    };

    const result = transformMyDiseaseResponse(input);

    expect(result).toEqual({
      name: 'Breast Cancer',
      disease_id: 'C0006142',
      description: 'A malignant neoplasm of the breast.',
      ontology: 'DOID:1612',
    });
  });
});
