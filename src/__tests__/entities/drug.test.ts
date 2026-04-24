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
    expect(callUrl).toContain('/query?');
    expect(callUrl).toContain('q=aspirin');
  });

  test('drugSearch() returns transformed results', async () => {
    global.fetch = jest.fn().mockResolvedValue({
      ok: true,
      json: () => Promise.resolve({
        hits: [
          {
            _id: 'BSIYZIXJDXWZKO-UHFFFAOYSA-N',
            chebi: { name: 'Aspirin', formula: 'C9H8O4', mass: 180.16, inchikey: 'BSIYZIXJDXWZKO-UHFFFAOYSA-N' },
            unii: { smiles: 'CC(=O)Oc1ccccc1C(=O)O', registry_number: 'R16CO5Y76E' },
            unichem: { chembl: 'CHEMBL25' },
          },
        ],
      }),
    }) as any;

    const results = await drugSearch('aspirin');

    expect(results).toHaveLength(1);
    expect(results[0].name).toBe('Aspirin');
    expect(results[0].chembl_id).toBe('CHEMBL25');
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
    expect(callUrl).toContain('/query?');
  });

  test('transformMyChemResponse() maps fields correctly', () => {
    const input = {
      chebi: {
        name: 'Aspirin',
        inchi: 'InChI=1S/C9H8O4',
        inchikey: 'BSIYZIXJDXWZKO-UHFFFAOYSA-N',
        mass: 180.16,
        formula: 'C9H8O4',
      },
      unii: {
        smiles: 'CC(=O)Oc1ccccc1C(=O)O',
      },
      unichem: {
        chembl: 'CHEMBL25',
      },
    };

    const result = transformMyChemResponse(input);

    expect(result).toEqual({
      name: 'Aspirin',
      chembl_id: 'CHEMBL25',
      inchi: 'InChI=1S/C9H8O4',
      inchi_key: 'BSIYZIXJDXWZKO-UHFFFAOYSA-N',
      smiles: 'CC(=O)Oc1ccccc1C(=O)O',
      molecular_weight: 180.16,
      molecular_formula: 'C9H8O4',
    });
  });
});
