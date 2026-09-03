import { jest } from '@jest/globals';
import { drugSearch, drugGet, transformMyChemResponse, resolveBestMatch } from '../../entities/drug.js';
import { connectionManager } from '../../connections/manager.js';

describe('drug', () => {
  let originalFetch: typeof global.fetch;

  beforeEach(() => {
    jest.clearAllMocks();
    originalFetch = global.fetch;
    connectionManager.closeAll();
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

  test('drugGet() uses single combined query', async () => {
    global.fetch = jest.fn().mockResolvedValue({
      ok: true,
      json: () => Promise.resolve({
        hits: [{
          chebi: { name: 'Aspirin', mass: 180.16, formula: 'C9H8O4' },
          unichem: { chembl: 'CHEMBL25' },
        }],
      }),
    }) as any;

    await drugGet('Aspirin');

    // Single MyChem query — not 3 sequential calls
    expect(global.fetch).toHaveBeenCalledTimes(1);
    const callUrl = (global.fetch as any).mock.calls[0][0] as string;
    expect(callUrl).toContain('mychem.info');
    expect(callUrl).toContain('/query?');
    expect(callUrl).toContain('chebi.name');
    expect(callUrl).toContain('chebi.name_synonyms');
  });

  test('drugGet() escapes Lucene special characters in query', async () => {
    global.fetch = jest.fn().mockResolvedValue({
      ok: true,
      json: () => Promise.resolve({ hits: [] }),
    }) as any;

    await expect(drugGet('drug+name')).rejects.toThrow('not found');
    const callUrl = (global.fetch as any).mock.calls[0][0] as string;
    // '+' should be escaped to '\\+'
    expect(callUrl).toContain('drug%5C%2Bname');
  });

  test('drugGet() resolves drug found via synonym', async () => {
    global.fetch = jest.fn().mockResolvedValue({
      ok: true,
      json: () => Promise.resolve({
        hits: [{
          chebi: {
            name: 'Acetylsalicylic acid',
            mass: 180.16,
            formula: 'C9H8O4',
            name_synonyms: ['aspirin', '2-acetoxybenzoic acid'],
          },
          unii: { display_name: 'Aspirin' },
        }],
      }),
    }) as any;

    const result = await drugGet('aspirin');
    expect(result.name).toBe('Acetylsalicylic acid');
    expect(result.molecular_formula).toBe('C9H8O4');
  });

  test('drugGet() throws when no hits returned', async () => {
    global.fetch = jest.fn().mockResolvedValue({
      ok: true,
      json: () => Promise.resolve({ hits: [] }),
    }) as any;

    await expect(drugGet('nonexistent-drug-xyz')).rejects.toThrow(
      "Drug 'nonexistent-drug-xyz' not found"
    );
  });

  test('drugGet() adverse_events section fetches ranked FAERS reactions', async () => {
    global.fetch = jest.fn()
      .mockResolvedValueOnce({
        ok: true,
        json: () => Promise.resolve({
          hits: [{ chebi: { name: 'Aspirin' }, unichem: { chembl: 'CHEMBL25' } }],
        }),
      })
      .mockResolvedValueOnce({
        ok: true,
        json: () => Promise.resolve({ meta: { results: { total: 500 } }, results: [] }),
      })
      .mockResolvedValueOnce({
        ok: true,
        json: () => Promise.resolve({ results: [{ term: 'NAUSEA', count: 12 }] }),
      }) as any;

    const result = await drugGet('aspirin', ['adverse_events']);

    expect(global.fetch).toHaveBeenCalledTimes(3);
    const adverseUrls = (global.fetch as any).mock.calls.slice(1).map((c: unknown[]) => c[0] as string);
    expect(adverseUrls[0]).toContain('patient.drug.openfda.substance_name');
    expect(adverseUrls[1]).toContain('count=patient.reaction.reactionmeddrapt.exact');

    const section = result.sections?.adverse_events as { total_reports: number; reactions: Array<{ reaction: string; count: number }> };
    expect(section.total_reports).toBe(500);
    expect(section.reactions).toEqual([{ reaction: 'NAUSEA', count: 12, source: 'openfda' }]);
  });

  test('drugGet() sections=["all"] includes adverse_events alongside the six legacy sections', async () => {
    global.fetch = jest.fn().mockImplementation(async (input: any) => {
      const url = typeof input === 'string' ? input : input?.url ?? String(input);
      // Route on the parsed hostname (never substring matching — the query
      // carries user input and could contain any host string).
      const u = new URL(url);
      if (u.hostname === 'mychem.info') {
        return {
          ok: true,
          json: () => Promise.resolve({ hits: [{ chebi: { name: 'Aspirin' }, unichem: { chembl: 'CHEMBL25' } }] }),
        };
      }
      if (u.hostname === 'api.fda.gov') {
        return {
          ok: true,
          json: () => Promise.resolve(
            u.searchParams.has('count')
              ? { results: [{ term: 'FATIGUE', count: 5 }] }
              : { meta: { results: { total: 10 } }, results: [] }
          ),
        };
      }
      // OpenTargets (targets/indications) — minimal GraphQL-ish bodies.
      return {
        ok: true,
        json: () => Promise.resolve({ data: {} }),
      };
    }) as any;

    const result = await drugGet('aspirin', ['all']);

    expect(Object.keys(result.sections ?? {}).sort()).toEqual(
      ['adverse_events', 'eu_regulatory', 'indications', 'safety', 'targets', 'us_regulatory', 'who_regulatory'].sort()
    );
    expect((result.sections?.adverse_events as any).total_reports).toBe(10);
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

  describe('resolveBestMatch', () => {
    test('returns null for empty hits', () => {
      expect(resolveBestMatch('aspirin', [])).toBeNull();
    });

    test('picks exact case-insensitive chebi.name match (score 3)', () => {
      const hits = [
        { chebi: { name: 'Acetylsalicylic acid' } },
        { chebi: { name: 'Aspirin' } },
        { chebi: { name: 'aspirin derivative' } },
      ];
      const result = resolveBestMatch('aspirin', hits)!;
      expect(result.score).toBe(3);
      expect((result.hit as any).chebi.name).toBe('Aspirin');
    });

    test('picks exact match regardless of case', () => {
      const hits = [
        { chebi: { name: 'ASPIRIN' } },
        { chebi: { name: 'Some other drug' } },
      ];
      const result = resolveBestMatch('aspirin', hits)!;
      expect(result.score).toBe(3);
      expect((result.hit as any).chebi.name).toBe('ASPIRIN');
    });

    test('picks exact unii.display_name match when no chebi.name match (score 2)', () => {
      const hits = [
        { chebi: { name: 'Other Compound' }, unii: { display_name: 'Ibuprofen' } },
        { chebi: { name: 'Another Compound' } },
      ];
      const result = resolveBestMatch('ibuprofen', hits)!;
      expect(result.score).toBe(2);
      expect((result.hit as any).unii.display_name).toBe('Ibuprofen');
    });

    test('picks exact ndc.nonproprietaryname match when no chebi.name match (score 2)', () => {
      const hits = [
        { chebi: { name: 'Something else' }, ndc: { nonproprietaryname: 'Metformin' } },
        { chebi: { name: 'Unrelated' } },
      ];
      const result = resolveBestMatch('metformin', hits)!;
      expect(result.score).toBe(2);
      expect((result.hit as any).ndc.nonproprietaryname).toBe('Metformin');
    });

    test('picks contains match when no exact match (score 1)', () => {
      const hits = [
        { chebi: { name: 'Random Drug X' } },
        { chebi: { name: 'aspirin sodium' } },
      ];
      const result = resolveBestMatch('aspirin', hits)!;
      expect(result.score).toBe(1);
      expect((result.hit as any).chebi.name).toBe('aspirin sodium');
    });

    test('returns first hit with score 0 when nothing matches well', () => {
      const hits = [
        { chebi: { name: 'Totally unrelated' } },
        { chebi: { name: 'Also unrelated' } },
      ];
      const result = resolveBestMatch('aspirin', hits)!;
      expect(result.score).toBe(0);
      expect((result.hit as any).chebi.name).toBe('Totally unrelated');
    });

    test('picks exact synonym match as score 2', () => {
      const hits = [
        { chebi: { name: 'Acetylsalicylic acid', name_synonyms: ['aspirin', '2-acetoxybenzoic acid'] } },
        { chebi: { name: 'Other Drug' } },
      ];
      const result = resolveBestMatch('aspirin', hits)!;
      expect(result.score).toBe(2);
      expect((result.hit as any).chebi.name).toBe('Acetylsalicylic acid');
    });

    test('synonym match loses to exact chebi.name match', () => {
      const hits = [
        { chebi: { name: 'Aspirin' } },
        { chebi: { name: 'Acetylsalicylic acid', name_synonyms: ['aspirin'] } },
      ];
      const result = resolveBestMatch('aspirin', hits)!;
      expect(result.score).toBe(3);
      expect((result.hit as any).chebi.name).toBe('Aspirin');
    });

    test('synonym match wins over contains match', () => {
      const hits = [
        { chebi: { name: 'aspirin sodium' } },
        { chebi: { name: 'Acetylsalicylic acid', name_synonyms: ['aspirin'] } },
      ];
      const result = resolveBestMatch('aspirin', hits)!;
      expect(result.score).toBe(2);
      expect((result.hit as any).chebi.name).toBe('Acetylsalicylic acid');
    });

    test('synonym-only match scores 2 without display_name', () => {
      // Hit found via synonym, no unii.display_name or ndc.nonproprietaryname
      const hits = [
        { chebi: { name: 'N-(4-hydroxyphenyl)acetamide', name_synonyms: ['paracetamol', 'acetaminophen'] } },
      ];
      const result = resolveBestMatch('acetaminophen', hits)!;
      expect(result.score).toBe(2);
    });
  });
});
