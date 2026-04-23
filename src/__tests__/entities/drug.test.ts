import { jest } from '@jest/globals';
import { drugSearch, drugGet, transformMyChemResponse } from '../../entities/drug.js';

describe('drug', () => {
  let originalFetch: typeof global.fetch;

  beforeEach(() => {
    jest.clearAllMocks();
    originalFetch = global.fetch;
    process.env.MYCHEM_API_KEY = '';
  });

  afterEach(() => {
    global.fetch = originalFetch;
    delete process.env.MYCHEM_API_KEY;
  });

  test('drugSearch() calls connection with correct mychem search endpoint', async () => {
    global.fetch = jest.fn().mockResolvedValue({
      ok: true,
      json: () => Promise.resolve({ hits: [{ name: 'Aspirin', uichem: 'CHEMBL25' }] }),
    }) as any;

    await drugSearch('aspirin');

    expect(global.fetch).toHaveBeenCalled();
    const callUrl = (global.fetch as any).mock.calls[0][0] as string;
    expect(callUrl).toContain('mychem.info');
    expect(callUrl).toContain('/search?');
    expect(callUrl).toContain('q=aspirin');
  });

  test('drugSearch() returns transformed results', async () => {
    global.fetch = jest.fn().mockResolvedValue({
      ok: true,
      json: () => Promise.resolve({
        hits: [
          { name: 'Aspirin', uichem: 'CHEMBL25', inchi_key: 'BSIYZIXJDXWZKO', mw: 180.16, formula: 'C9H8O4' },
        ],
      }),
    }) as any;

    const results = await drugSearch('aspirin');

    expect(results).toHaveLength(1);
    expect(results[0].name).toBe('Aspirin');
    expect(results[0].uichem_id).toBe('CHEMBL25');
    expect(results[0].molecular_weight).toBe(180.16);
    expect(results[0].molecular_formula).toBe('C9H8O4');
  });

  test('drugGet() calls connection with correct endpoint', async () => {
    global.fetch = jest.fn().mockResolvedValue({
      ok: true,
      json: () => Promise.resolve({
        hits: [{ name: 'Aspirin', uichem: 'CHEMBL25' }],
      }),
    }) as any;

    await drugGet('Aspirin');

    expect(global.fetch).toHaveBeenCalled();
    const callUrl = (global.fetch as any).mock.calls[0][0] as string;
    expect(callUrl).toContain('mychem.info');
    expect(callUrl).toContain('/get?');
  });

  test('transformMyChemResponse() maps fields correctly', () => {
    const input = {
      name: 'Aspirin',
      uichem: 'CHEMBL25',
      inchi: 'InChI=1S/C9H8O4',
      inchi_key: 'BSIYZIXJDXWZKO-UHFFFAOYSA-N',
      smiles: 'CC(=O)Oc1ccccc1C(=O)O',
      mw: 180.16,
      formula: 'C9H8O4',
    };

    const result = transformMyChemResponse(input);

    expect(result).toEqual({
      name: 'Aspirin',
      uichem_id: 'CHEMBL25',
      inchi: input.inchi,
      inchi_key: 'BSIYZIXJDXWZKO-UHFFFAOYSA-N',
      smiles: 'CC(=O)Oc1ccccc1C(=O)O',
      molecular_weight: 180.16,
      molecular_formula: 'C9H8O4',
    });
  });
});
