import { jest } from '@jest/globals';
import {
  drugSearch,
  drugGet,
  fetchAdverseEvents,
  transformMyChemResponse,
  resolveBestMatch,
  collapseSaltVariants,
  drugIdentityKey,
} from '../../entities/drug.js';
import type { DrugSearchResult } from '../../entities/drug.js';
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
      json: () => Promise.resolve({ hits: [{ name: 'Aspirin', unichem: { chembl: 'CHEMBL25' } }] }),
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

  test('drugSearch() maps chembl fields when chebi is absent', async () => {
    global.fetch = jest.fn().mockResolvedValue({
      ok: true,
      json: () => Promise.resolve({
        hits: [
          {
            _id: 'LGHSQOCGTJHDIL-UTXLBGCNSA-N',
            chembl: {
              pref_name: 'ALAMETHICIN',
              molecule_chembl_id: 'CHEMBL438243',
              inchi_key: 'LGHSQOCGTJHDIL-UTXLBGCNSA-N',
              molecule_properties: {
                full_mwt: 1964.34,
                full_molformula: 'C92H150N22O25',
              },
            },
          },
        ],
      }),
    }) as any;

    const results = await drugSearch('alamethicin');

    expect(results).toHaveLength(1);
    expect(results[0].name).toBe('ALAMETHICIN');
    expect(results[0].chembl_id).toBe('CHEMBL438243');
    expect(results[0].inchi_key).toBe('LGHSQOCGTJHDIL-UTXLBGCNSA-N');
    expect(results[0].molecular_weight).toBe(1964.34);
    expect(results[0].molecular_formula).toBe('C92H150N22O25');
  });

  // Regression for GitHub issue #63: MyChem records whose only annotation is
  // an FDA orphan designation (without even a generic_name) previously
  // transformed into {name: ""} rows that buried the real matches.
  test('drugSearch() drops name-less orphan-only rows and keeps the named hit', async () => {
    const nameLessHits = Array.from({ length: 8 }, (_, i) => ({
      _id: `orphan-only-${i}`,
      // Orphan designations carrying only indication text/dates — no
      // generic_name, so no usable name falls out of the fallback chain.
      fda_orphan_drug: [{
        designated_date: '2015-06-16',
        designation_status: 'Designated/Approved',
        orphan_designation: { original_text: 'Treatment of something rare' },
      }],
    }));
    global.fetch = jest.fn().mockResolvedValue({
      ok: true,
      json: () => Promise.resolve({
        hits: [
          ...nameLessHits,
          {
            _id: '354355033',
            chebi: { name: 'pembrolizumab' },
            unii: { registry_number: 'Q153Y5Z106' },
            unichem: { chembl: 'CHEMBL3338463' },
          },
        ],
      }),
    }) as any;

    const results = await drugSearch('pembrolizumab');

    expect(results).toHaveLength(1);
    expect(results[0].name).toBe('pembrolizumab');
    expect(results[0].chembl_id).toBe('CHEMBL3338463');
    // The orphan annotation is now part of the search projection.
    const callUrl = (global.fetch as any).mock.calls[0][0] as string;
    expect(callUrl).toContain('fda_orphan_drug');
  });

  test('drugSearch() uses the orphan designation generic_name as a last-resort name', async () => {
    // Live-verified shape: records exist with fda_orphan_drug but no
    // chebi/unii/chembl-pref_name/ndc (e.g. mychem _id FIHJKUPKCHIPAT-UHFFFAOYSA-N).
    global.fetch = jest.fn().mockResolvedValue({
      ok: true,
      json: () => Promise.resolve({
        hits: [{
          _id: 'FIHJKUPKCHIPAT-UHFFFAOYSA-N',
          fda_orphan_drug: [{
            generic_name: 'artesunate',
            designated_date: '2006-03-28',
            designation_status: 'Designated/Approved',
            orphan_designation: { original_text: 'treatment of severe malaria' },
          }],
        }],
      }),
    }) as any;

    const results = await drugSearch('artesunate');

    expect(results).toHaveLength(1);
    expect(results[0].name).toBe('artesunate');
  });

  test('drugSearch() collapses case and salt variants onto the richest row', async () => {
    global.fetch = jest.fn().mockResolvedValue({
      ok: true,
      json: () => Promise.resolve({
        hits: [
          { _id: 'A', unii: { display_name: 'Imatinib Mesylate' } },
          { _id: 'B', chembl: { pref_name: 'imatinib mesylate' } },
          { _id: 'C', ndc: { nonproprietaryname: 'IMATINIB MESYLATE' } },
          // Richest identity for the same base name: curated ChEBI data — must survive.
          { _id: 'D', chebi: { name: 'imatinib', formula: 'C29H31N7O', mass: 493.6 } },
        ],
      }),
    }) as any;

    const results = await drugSearch('imatinib');

    // Collapse policy: all four rows share the identity key "imatinib"
    // (name lowercased, trailing "mesylate" stripped), so exactly one row
    // survives. The ChEBI row wins on the most-populated-fields tier
    // (the other three carry nothing but a name).
    expect(results).toHaveLength(1);
    expect(results[0].name).toBe('imatinib');
    expect(results[0].molecular_formula).toBe('C29H31N7O');
    expect(results[0].molecular_weight).toBe(493.6);
  });

  describe('collapseSaltVariants', () => {
    const row = (name: string, extra: Partial<DrugSearchResult> = {}): DrugSearchResult => ({ name, ...extra });

    test('collapses methanesulfonate and sodium salt forms with the base drug', () => {
      expect(collapseSaltVariants([row('imatinib methanesulfonate'), row('imatinib')])).toHaveLength(1);
      expect(collapseSaltVariants([row('diclofenac sodium'), row('diclofenac')])).toHaveLength(1);
    });

    test('strips trailing salt tokens iteratively and case-insensitively', () => {
      const rows = collapseSaltVariants([
        row('Imatinib Mesylate'),
        row('imatinib methanesulfonate'),
        row('IMATINIB HYDROCHLORIDE'),
      ]);
      expect(rows).toHaveLength(1);
    });

    test('strips salt tokens only as trailing whole words, never substrings or leading tokens', () => {
      // Leading "sodium" is not a trailing token: distinct keys, no collapse.
      expect(collapseSaltVariants([row('sodium stibogluconate'), row('stibogluconate')])).toHaveLength(2);
      // Whole-word matching: a name merely containing salt-like letters is untouched.
      expect(drugIdentityKey({ name: 'hydrochlorothiazide' })).toBe('hydrochlorothiazide');
    });

    test('keeps distinct drugs separate (different chembl ids and base names)', () => {
      const rows = collapseSaltVariants([
        row('imatinib mesylate', { chembl_id: 'CHEMBL38868' }),
        row('dasatinib', { chembl_id: 'CHEMBL2178' }),
      ]);
      expect(rows).toHaveLength(2);
      expect(rows.map(r => r.name).sort()).toEqual(['dasatinib', 'imatinib mesylate']);
    });

    test('breaks richness ties deterministically: shortest name wins', () => {
      const rows = collapseSaltVariants([row('Imatinib Mesylate'), row('imatinib')]);
      expect(rows).toHaveLength(1);
      expect(rows[0].name).toBe('imatinib');
    });

    test('drops rows with empty or whitespace-only names', () => {
      const rows = collapseSaltVariants([row(''), row('   '), row('aspirin')]);
      expect(rows).toHaveLength(1);
      expect(rows[0].name).toBe('aspirin');
    });
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

  // Regression for the Lucene phrase-escaping fix (escapeLucenePhrase, drug.ts):
  // backslashes must be doubled BEFORE quotes are escaped, so a trailing
  // backslash cannot consume the closing quote of the phrase.
  test('fetchAdverseEvents() Lucene-escapes quotes and backslashes in the search phrase', async () => {
    global.fetch = jest.fn()
      .mockResolvedValueOnce({
        ok: true,
        json: () => Promise.resolve({ meta: { results: { total: 3 } }, results: [] }),
      })
      .mockResolvedValueOnce({
        ok: true,
        json: () => Promise.resolve({ results: [{ term: 'RASH', count: 1 }] }),
      }) as any;

    await fetchAdverseEvents('we"ird\\name');

    expect(global.fetch).toHaveBeenCalledTimes(2);
    const probeUrl = decodeURIComponent((global.fetch as any).mock.calls[0][0] as string);
    expect(probeUrl).toContain('patient.drug.openfda.substance_name:"we\\"ird\\\\name"');
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

  test('transformMyChemResponse() maps chembl fields when chebi/unii are absent', () => {
    const input = {
      chembl: {
        pref_name: 'ALAMETHICIN',
        molecule_chembl_id: 'CHEMBL438243',
        inchi: 'InChI=1S/test',
        inchi_key: 'LGHSQOCGTJHDIL-UTXLBGCNSA-N',
        smiles: 'CC(=O)NC',
        molecule_properties: {
          full_mwt: 1964.34,
          full_molformula: 'C92H150N22O25',
        },
      },
    };

    const result = transformMyChemResponse(input);

    expect(result).toEqual({
      name: 'ALAMETHICIN',
      chembl_id: 'CHEMBL438243',
      inchi: 'InChI=1S/test',
      inchi_key: 'LGHSQOCGTJHDIL-UTXLBGCNSA-N',
      smiles: 'CC(=O)NC',
      molecular_weight: 1964.34,
      molecular_formula: 'C92H150N22O25',
    });
  });

  test('drugGet() resolves ChEMBL hit and consolidates aliases for alamethicin', async () => {
    global.fetch = jest.fn().mockResolvedValue({
      ok: true,
      json: () => Promise.resolve({
        hits: [
          {
            _id: 'LGHSQOCGTJHDIL-UTXLBGCNSA-N',
            chembl: {
              pref_name: 'ALAMETHICIN',
              molecule_chembl_id: 'CHEMBL438243',
              smiles: 'CC(=O)NC...',
              molecule_properties: {
                full_molformula: 'C92H150N22O25',
                full_mwt: 1964.34,
              },
            },
            unichem: { chembl: 'CHEMBL438243' },
          },
          {
            _id: 'NRRXBXXRKXUIFD-ZTEFGAJGSA-N',
            unii: {
              display_name: 'ALAMETHICIN',
              molecular_formula: 'C92H150N22O25',
              registry_number: '27061-78-5',
            },
          },
        ],
      }),
    }) as any;

    const result = await drugGet('alamethicin');

    expect(result.name).toBe('ALAMETHICIN');
    expect(result.chembl_id).toBe('CHEMBL438243');
    expect(result.molecular_formula).toBe('C92H150N22O25');
    expect(result.molecular_weight).toBe(1964.34);
    expect(result.aliases).toEqual(['27061-78-5']);
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

    test('picks exact chembl.pref_name match as score 3', () => {
      const hits = [
        { chembl: { pref_name: 'ALAMETHICIN' } },
        { chebi: { name: 'Some other drug' } },
      ];
      const result = resolveBestMatch('alamethicin', hits)!;
      expect(result.score).toBe(3);
      expect((result.hit as any).chembl.pref_name).toBe('ALAMETHICIN');
    });

    test('tie-breaker prefers hit with ChEMBL identifier when scores are equal', () => {
      const hits = [
        { unii: { display_name: 'Alamethicin' } },
        { chembl: { pref_name: 'Alamethicin', molecule_chembl_id: 'CHEMBL438243' } },
      ];
      const result = resolveBestMatch('alamethicin', hits)!;
      expect(result.score).toBe(3);
      expect((result.hit as any).chembl.molecule_chembl_id).toBe('CHEMBL438243');
    });

    test('handles single string chebi.name_synonyms without throwing', () => {
      const hits = [
        { chebi: { name: 'Compound X', name_synonyms: 'single_synonym' } },
      ];
      const result = resolveBestMatch('single_synonym', hits)!;
      expect(result.score).toBe(2);
      expect((result.hit as any).chebi.name).toBe('Compound X');
    });
  });
});
