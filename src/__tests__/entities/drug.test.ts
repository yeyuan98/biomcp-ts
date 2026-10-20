import { jest } from '@jest/globals';
import {
  drugSearch,
  drugGet,
  fetchAdverseEvents,
  fetchWHORegulatory,
  innLeadPhrases,
  resetWhoPqCacheForTests,
  transformMyChemResponse,
  resolveBestMatch,
  collapseSaltVariants,
  drugIdentityKey,
  looksLikeSystematicChemicalName,
} from '../../entities/drug.js';
import type { DrugSearchResult } from '../../entities/drug.js';
import { connectionManager } from '../../connections/manager.js';
import { parseMockUrl } from '../helpers/mock-url.js';
import { createMcpTestHarness, type McpTestHarness } from '../helpers/mcp-harness.js';
import { mockGlobalFetch } from '../helpers/mock-fetch.js';

describe('drug', () => {
  mockGlobalFetch();

  beforeEach(() => {
    jest.clearAllMocks();
    connectionManager.closeAll();
    process.env.MYCHEM_API_KEY = '';
    resetWhoPqCacheForTests();
  });

  afterEach(() => {
    delete process.env.MYCHEM_API_KEY;
  });

  test('drugSearch() calls connection with correct mychem search endpoint', async () => {
    global.fetch = jest.fn<(...args: any[]) => any>().mockResolvedValue({
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
    global.fetch = jest.fn<(...args: any[]) => any>().mockResolvedValue({
      ok: true,
      json: () => Promise.resolve({
        hits: [
          {
            _id: 'BSIYZIXJDXWZKO-UHFFFAOYSA-N',
            chebi: { name: 'Aspirin', formula: 'C9H8O4', mass: 180.16, inchikey: 'BSIYZIXJDXWZKO-UHFFFAOYSA-N' },
            unii: { smiles: 'CC(=O)Oc1ccccc1C(=O)O', unii: 'R16CO5Y76E', registry_number: '50-78-2' },
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
    expect(results[0].unii).toBe('R16CO5Y76E');
    expect(results[0].cas).toBe('50-78-2');
  });

  // Regression for GitHub issue #123: the `unii` output field carried the CAS
  // registry number (MyChem's unii.registry_number) instead of the FDA UNII
  // (unii.unii). Live-verified shapes on mychem.info: imatinib (CHEMBL941
  // row) → unii BKJ8M8G5HI / registry_number 152459-95-5; aspirin →
  // R16CO5Y76E / 50-78-2.
  test('drugSearch() maps the FDA UNII and the CAS registry number to separate fields', async () => {
    global.fetch = jest.fn<(...args: any[]) => any>().mockResolvedValue({
      ok: true,
      json: () => Promise.resolve({
        hits: [
          {
            _id: 'KTUFNOKKBVMGRW-UHFFFAOYSA-N',
            unii: { display_name: 'IMATINIB', unii: 'BKJ8M8G5HI', registry_number: '152459-95-5' },
            unichem: { chembl: 'CHEMBL941' },
          },
        ],
      }),
    }) as any;

    const results = await drugSearch('imatinib');

    expect(results).toHaveLength(1);
    expect(results[0].name).toBe('IMATINIB');
    expect(results[0].unii).toBe('BKJ8M8G5HI');
    expect(results[0].cas).toBe('152459-95-5');
    // The two identifiers must never cross over: a UNII is 10 alphanumeric
    // characters, a CAS is dash-separated digits.
    expect(results[0].unii).not.toMatch(/^\d{2,7}-\d{2}-\d$/);
    expect(results[0].cas).toMatch(/^\d{2,7}-\d{2}-\d$/);
    // The projection requests BOTH members of MyChem's unii sub-document.
    const callUrl = (global.fetch as any).mock.calls[0][0] as string;
    expect(callUrl).toContain('unii.unii');
    expect(callUrl).toContain('unii.registry_number');
  });

  test('drugSearch() maps chembl fields when chebi is absent', async () => {
    global.fetch = jest.fn<(...args: any[]) => any>().mockResolvedValue({
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
    global.fetch = jest.fn<(...args: any[]) => any>().mockResolvedValue({
      ok: true,
      json: () => Promise.resolve({
        hits: [
          ...nameLessHits,
          {
            _id: '354355033',
            chebi: { name: 'pembrolizumab' },
            unii: { unii: 'DPT0O3T46P', registry_number: '1374853-91-4' },
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
    global.fetch = jest.fn<(...args: any[]) => any>().mockResolvedValue({
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
    global.fetch = jest.fn<(...args: any[]) => any>().mockResolvedValue({
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

    // Second merge pass (issue #83): an id-less row whose salt-stripped name
    // matches an id-bearing row is the same chemical entity — merge, don't
    // keep a sparse duplicate.
    test('absorbs the identifier-less imatinib trio member into the id-bearing rows', () => {
      // Live "imatinib" search shape: base (CHEMBL941), mesylate salt
      // (CHEMBL1642), and a sparse "Imatinib Mesylate" row with no ids —
      // the id-less row's name-only key can never collide with an id key.
      const rows = collapseSaltVariants([
        row('imatinib', { chembl_id: 'CHEMBL941' }),
        row('imatinib mesylate', { chembl_id: 'CHEMBL1642' }),
        row('Imatinib Mesylate'),
      ]);
      expect(rows).toHaveLength(2);
      expect(rows.map(r => r.chembl_id).sort()).toEqual(['CHEMBL1642', 'CHEMBL941']);
    });

    test('id-less rows merge into id-bearing namesakes case- and salt-insensitively', () => {
      const rows = collapseSaltVariants([
        row('IMATINIB MESYLATE', { chembl_id: 'CHEMBL1642' }),
        row('imatinib'),
      ]);
      expect(rows).toHaveLength(1);
      expect(rows[0].chembl_id).toBe('CHEMBL1642');
    });

    test('the id-bearing survivor absorbs fields the sparse row uniquely carried', () => {
      const rows = collapseSaltVariants([
        row('imatinib', { chembl_id: 'CHEMBL941' }),
        row('Imatinib Mesylate', { molecular_formula: 'C29H31N7O' }),
      ]);
      expect(rows).toHaveLength(1);
      expect(rows[0].chembl_id).toBe('CHEMBL941');
      expect(rows[0].name).toBe('imatinib'); // name never overwritten
      expect(rows[0].molecular_formula).toBe('C29H31N7O'); // absorbed
    });

    test('id-less rows with no id-bearing namesake survive untouched', () => {
      const rows = collapseSaltVariants([
        row('artesunate', { molecular_formula: 'C19H28O8' }),
        row('sodium stibogluconate'), // no id-bearing "stibogluconate" — keep
      ]);
      expect(rows).toHaveLength(2);
      expect(rows.map(r => r.name).sort()).toEqual(['artesunate', 'sodium stibogluconate']);
    });
  });

  test('drugGet() uses single combined query', async () => {
    global.fetch = jest.fn<(...args: any[]) => any>().mockResolvedValue({
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
    global.fetch = jest.fn<(...args: any[]) => any>().mockResolvedValue({
      ok: true,
      json: () => Promise.resolve({ hits: [] }),
    }) as any;

    await expect(drugGet('drug+name')).rejects.toThrow('not found');
    const callUrl = (global.fetch as any).mock.calls[0][0] as string;
    // '+' should be escaped to '\\+'
    expect(callUrl).toContain('drug%5C%2Bname');
  });

  test('drugGet() resolves drug found via synonym', async () => {
    global.fetch = jest.fn<(...args: any[]) => any>().mockResolvedValue({
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

  // Regression for GitHub issue #135 (part 1): ChEBI's preferred label for
  // some molecules IS the systematic IUPAC name, which previously became
  // `name` verbatim. Live-verified on mychem.info 2026-10-17: tetrabenazine
  // (CHEBI:64028 / CHEMBL117785) carries the 83-char systematic name as
  // chebi.name while chembl.pref_name is the usable "TETRABENAZINE"; the
  // live ndc sub-document is an ARRAY of NDC records, so ndc.nonproprietaryname
  // never resolves on this hit and the demoted chain lands on pref_name.
  const TETRABENAZINE_SYSTEMATIC =
    '9,10-dimethoxy-3-isobutyl-1,3,4,6,7,11b-hexahydro-2H-pyrido[2,1-a]isoquinolin-2-one';

  test('looksLikeSystematicChemicalName() fires only on systematic shapes', () => {
    expect(TETRABENAZINE_SYSTEMATIC.length).toBe(83);
    expect(looksLikeSystematicChemicalName(TETRABENAZINE_SYSTEMATIC)).toBe(true);
    // Real drug names must pass through untouched.
    expect(looksLikeSystematicChemicalName('acetylsalicylic acid')).toBe(false); // 0 locant chars
    expect(looksLikeSystematicChemicalName('5-aminolevulinic acid')).toBe(false); // 2 locant chars
    expect(looksLikeSystematicChemicalName('vitamin B12')).toBe(false); // 2 locant chars
    // Each clause fires independently: length >= 50 with no locants...
    expect(looksLikeSystematicChemicalName('a'.repeat(50))).toBe(true);
    // ...bracket locants (fused-ring nomenclature)...
    expect(looksLikeSystematicChemicalName('pyrido[2,1-a]')).toBe(true);
    // ...digit/hyphen locant density >= 3 without brackets or length.
    expect(looksLikeSystematicChemicalName('1,2,3-propanetriol')).toBe(true);
  });

  test('drugGet() demotes a systematic ChEBI label to iupac and falls through to ChEMBL pref_name', async () => {
    global.fetch = jest.fn<(...args: any[]) => any>().mockResolvedValue({
      ok: true,
      json: () => Promise.resolve({
        hits: [{
          _id: 'MKJIEFSOBYUXJB-UHFFFAOYSA-N',
          chebi: { name: TETRABENAZINE_SYSTEMATIC, id: 'CHEBI:64028' },
          chembl: { pref_name: 'TETRABENAZINE' },
          ndc: [{ nonproprietaryname: 'tetrabenazine' }],
        }],
      }),
    }) as any;

    const result = await drugGet('tetrabenazine');

    // pref_name stays VERBATIM — ChEMBL stores it uppercase; no case invention.
    expect(result.name).toBe('TETRABENAZINE');
    expect(result.iupac).toBe(TETRABENAZINE_SYSTEMATIC);
  });

  test('drugGet() keeps a non-systematic ChEBI label as name even when pref_name exists (aspirin)', async () => {
    // The demotion pattern must NOT fire for real ChEBI drug names:
    // "acetylsalicylic acid" is a legitimate drug name, not a systematic
    // one, so it keeps its place at the head of the name chain.
    global.fetch = jest.fn<(...args: any[]) => any>().mockResolvedValue({
      ok: true,
      json: () => Promise.resolve({
        hits: [{
          chebi: { name: 'acetylsalicylic acid', formula: 'C9H8O4', mass: 180.16 },
          chembl: { pref_name: 'ASPIRIN' },
          unichem: { chembl: 'CHEMBL25' },
        }],
      }),
    }) as any;

    const result = await drugGet('aspirin');

    expect(result.name).toBe('acetylsalicylic acid');
    // Simpler contract: the raw ChEBI label is ALWAYS exposed when present,
    // even when it equals `name`.
    expect(result.iupac).toBe('acetylsalicylic acid');
  });

  test('drugGet() throws when no hits returned', async () => {
    global.fetch = jest.fn<(...args: any[]) => any>().mockResolvedValue({
      ok: true,
      json: () => Promise.resolve({ hits: [] }),
    }) as any;

    await expect(drugGet('nonexistent-drug-xyz')).rejects.toThrow(
      "Drug 'nonexistent-drug-xyz' not found"
    );
  });

  test('drugGet() adverse_events section fetches ranked FAERS reactions', async () => {
    global.fetch = jest.fn<(...args: any[]) => any>()
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

  // Regression for GitHub issue #135 (part 3): fetchIndications previously
  // sliced the raw upstream order (rows.slice(0, 20)) with NO sort, so a
  // PHASE_3 row could sit above APPROVAL rows — and the slice could even
  // discard APPROVAL rows entirely. Ranking now happens BEFORE the slice,
  // with the same comparator family gene_drugs/disease_drugs use
  // (clinicalStageRank, then clinicalReports count, then disease name).
  const mockDrugGetHosts = (otIndicationRows: unknown[]) => {
    return jest.fn<(...args: any[]) => any>().mockImplementation(async (input: any, init?: any) => {
      const url = typeof input === 'string' ? input : input?.url ?? String(input);
      const u = new URL(url);
      if (u.hostname === 'mychem.info') {
        return {
          ok: true,
          json: () => Promise.resolve({
            hits: [{ chebi: { name: 'Aspirin' }, unichem: { chembl: 'CHEMBL25' } }],
          }),
        };
      }
      // OpenTargets GraphQL POST — body is { query, variables }.
      expect(u.hostname).toBe('api.platform.opentargets.org');
      expect(String(init?.body)).toContain('clinicalReports');
      return {
        ok: true,
        json: () => Promise.resolve({
          data: { drug: { id: 'CHEMBL25', name: 'ASPIRIN', indications: { rows: otIndicationRows } } },
        }),
      };
    }) as any;
  };

  test('drugGet() indications ranked by phase desc, then report count desc, then disease name asc', async () => {
    global.fetch = mockDrugGetHosts([
      { maxClinicalStage: 'PHASE_3', clinicalReports: [{ id: 'ECA1' }, { id: 'ECA2' }], disease: { id: 'MONDO_1', name: 'Zeta disease' } },
      { maxClinicalStage: 'APPROVAL', clinicalReports: [{ id: 'ECB1' }], disease: { id: 'MONDO_2', name: 'Beta disease' } },
      { maxClinicalStage: 'APPROVAL', clinicalReports: [{ id: 'ECC1' }, { id: 'ECC2' }, { id: 'ECC3' }], disease: { id: 'MONDO_3', name: 'Alpha disease' } },
      { maxClinicalStage: 'PHASE_2', clinicalReports: [], disease: { id: 'MONDO_4', name: 'Achondroplasia' } },
    ]);

    const result = await drugGet('aspirin', ['indications']);

    const rows = result.sections?.indications as Array<{ disease_name: string; phase: string }>;
    expect(rows.map(r => r.phase)).toEqual(['APPROVAL', 'APPROVAL', 'PHASE_3', 'PHASE_2']);
    // APPROVAL tie broken by report count (3 > 1); PHASE_3 vs PHASE_2 need no tie-break.
    expect(rows.map(r => r.disease_name)).toEqual(['Alpha disease', 'Beta disease', 'Zeta disease', 'Achondroplasia']);
  });

  test('drugGet() indications cap applies AFTER ranking — APPROVAL rows survive the 20-row slice', async () => {
    // 22 PHASE_2 rows ahead of 3 APPROVAL rows in the raw upstream order:
    // the old slice(0, 20) kept 20 PHASE_2 rows and dropped every APPROVAL.
    const rows = [
      ...Array.from({ length: 22 }, (_, i) => ({
        maxClinicalStage: 'PHASE_2',
        clinicalReports: [{ id: `EC_P2_${i}` }],
        disease: { id: `MONDO_P2_${i}`, name: `Phase two disease ${i}` },
      })),
      ...Array.from({ length: 3 }, (_, i) => ({
        maxClinicalStage: 'APPROVAL',
        clinicalReports: [{ id: `EC_AP_${i}` }],
        disease: { id: `MONDO_AP_${i}`, name: `Approved disease ${i}` },
      })),
    ];
    global.fetch = mockDrugGetHosts(rows);

    const result = await drugGet('aspirin', ['indications']);

    const indications = result.sections?.indications as Array<{ disease_name: string; phase: string }>;
    expect(indications).toHaveLength(20);
    expect(indications.slice(0, 3).map(r => r.phase)).toEqual(['APPROVAL', 'APPROVAL', 'APPROVAL']);
    expect(indications.slice(3).every(r => r.phase === 'PHASE_2')).toBe(true);
  });

  // Regression for the Lucene phrase-escaping fix (escapeLucenePhrase, drug.ts):
  // backslashes must be doubled BEFORE quotes are escaped, so a trailing
  // backslash cannot consume the closing quote of the phrase.
  test('fetchAdverseEvents() Lucene-escapes quotes and backslashes in the search phrase', async () => {
    global.fetch = jest.fn<(...args: any[]) => any>()
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

  // Regression for GitHub issue #135 (part 2, WHO half): who_regulatory was a
  // hardcoded `{ prequalified: false }` stub — no lookup ever ran. It is now a
  // real lookup against WHO Prequalification's official anonymous CSV export
  // (live-verified 2026-10-17, ~655 rows). The fixture below is a real slice
  // of that export (header + artemether fixed-dose combo rows + rows chosen
  // to exercise quoted commas, parenthesized salts, and empty dates).
  const WHO_PQ_FIXTURE_CSV = [
    '"WHO Reference Number","INN, Dosage Form and Strength","Product Type","Therapeutic Area",Applicant,"Dosage Form","Basis of Listing","Date of Prequalification"',
    'MA026,"Artemether/Lumefantrine Tablet 20mg/120mg","Finished Pharmaceutical Product",Malaria,"Novartis Pharma AG",Tablet,"Prequalification - Abridged","26  Apr,  2004"',
    'MA062,"Artemether/Lumefantrine Tablet 20mg/120mg","Finished Pharmaceutical Product",Malaria,"Ipca Laboratories Ltd",Tablet,"Prequalification - Full","15  Dec,  2009"',
    'MA069,"Artemether/Lumefantrine Tablet, Dispersible 20mg/120mg","Finished Pharmaceutical Product",Malaria,"Novartis Pharma AG","Tablet, Dispersible","Prequalification - Abridged","27  Feb,  2009"',
    'HA107,"Abacavir (sulfate) Solution, Oral 20mg/mL","Finished Pharmaceutical Product",HIV/AIDS,"ViiV Healthcare BV","Solution, Oral","Prequalification - Abridged","20  Mar,  2002"',
    'HA634,"Dolutegravir (sodium) Tablet, Film-coated 50mg","Finished Pharmaceutical Product",HIV/AIDS,"ViiV Healthcare BV","Tablet, Film-coated","Prequalification - Abridged","14  Oct,  2014"',
    '"ANDA 077268 USFDA","Zidovudine Solution, Oral 10mg/ml","Finished Pharmaceutical Product",HIV/AIDS,"Aurobindo Pharma Ltd","Solution, Oral","Alternative Listing",',
  ].join('\n');

  const mockWhoPqHosts = (whoCsv: string | Error = WHO_PQ_FIXTURE_CSV) => {
    return jest.fn<(...args: any[]) => any>().mockImplementation(async (input: any) => {
      const url = typeof input === 'string' ? input : input?.url ?? String(input);
      const u = new URL(url);
      if (u.hostname === 'mychem.info') {
        return {
          ok: true,
          json: () => Promise.resolve({ hits: [{ chebi: { name: 'Artemether' }, unichem: { chembl: 'CHEMBL123' } }] }),
        };
      }
      expect(u.hostname).toBe('extranet.who.int');
      if (whoCsv instanceof Error) throw whoCsv;
      return { ok: true, text: () => Promise.resolve(whoCsv) };
    }) as any;
  };

  const whoFetchCount = (): number =>
    (global.fetch as any).mock.calls.filter((c: unknown[]) => {
      const url = typeof c[0] === 'string' ? c[0] : (c[0] as any)?.url ?? String(c[0]);
      return new URL(url).hostname === 'extranet.who.int';
    }).length;

  test('innLeadPhrases() extracts INN lead phrases from real column shapes', () => {
    // Fixed-dose combo: both components, strength fragments dropped.
    expect(innLeadPhrases('Artemether/Lumefantrine Tablet 20mg/120mg'))
      .toEqual(['artemether', 'lumefantrine tablet']);
    // Comma-separated sub-form qualifier cut; salt parens stop the word-run.
    expect(innLeadPhrases('Dolutegravir (sodium) Tablet, Film-coated 50mg'))
      .toEqual(['dolutegravir']);
    expect(innLeadPhrases('Abacavir (sulfate) Solution, Oral 20mg/mL'))
      .toEqual(['abacavir']);
    // Multi-word INN: the form word may trail the phrase (prefix-matched).
    expect(innLeadPhrases('Emtricitabine/Tenofovir disoproxil fumarate Tablet 200mg/300mg'))
      .toEqual(['emtricitabine', 'tenofovir disoproxil fumarate tablet']);
    // Plain single-INN row.
    expect(innLeadPhrases('Zidovudine Solution, Oral 10mg/ml')).toEqual(['zidovudine solution']);
  });

  test('fetchWHORegulatory() returns prequalified true with products for artemether', async () => {
    global.fetch = mockWhoPqHosts();

    const result = await fetchWHORegulatory('artemether');

    expect(result.prequalified).toBe(true);
    expect(result.unavailable).toBeUndefined();
    // All three artemether combo rows in the fixture (incl. the Dispersible
    // one whose form qualifier sits behind a comma).
    expect(result.products).toHaveLength(3);
    expect(result.products?.[0]).toEqual({
      who_ref: 'MA026',
      inn_form: 'Artemether/Lumefantrine Tablet 20mg/120mg',
      applicant: 'Novartis Pharma AG',
      date: '26 Apr, 2004', // double-space date collapsed, comma kept
    });
  });

  test('fetchWHORegulatory() matches a combo component and a salt-suffixed query', async () => {
    global.fetch = mockWhoPqHosts();

    // "lumefantrine" is the second slash-component; the trailing form word
    // "Tablet" must not defeat the leading-token-run match.
    const combo = await fetchWHORegulatory('lumefantrine');
    expect(combo.prequalified).toBe(true);
    expect(combo.products?.every(p => p.inn_form.toLowerCase().includes('lumefantrine'))).toBe(true);

    // Trailing salt token on the query is stripped; the row's "(sodium)" salt
    // marker is handled by the phrase extraction.
    const salt = await fetchWHORegulatory('Dolutegravir Sodium');
    expect(salt.prequalified).toBe(true);
    expect(salt.products?.map(p => p.who_ref)).toEqual(['HA634']);
  });

  test('fetchWHORegulatory() quote-containing INN row parses with its comma intact', async () => {
    global.fetch = mockWhoPqHosts();

    const result = await fetchWHORegulatory('zidovudine');

    // "Zidovudine Solution, Oral 10mg/ml" — the comma lives INSIDE the quoted
    // field and must not split the row (a naive split would shift every later
    // column and break applicant/date extraction).
    expect(result.prequalified).toBe(true);
    const row = result.products?.find(p => p.who_ref === 'ANDA 077268 USFDA');
    expect(row?.inn_form).toBe('Zidovudine Solution, Oral 10mg/ml');
    expect(row?.applicant).toBe('Aurobindo Pharma Ltd');
    expect(row?.date).toBeUndefined(); // trailing empty date column
  });

  test('fetchWHORegulatory() false for a name outside PQ scope carries the scope note', async () => {
    global.fetch = mockWhoPqHosts();

    const result = await fetchWHORegulatory('aspirin');

    expect(result.prequalified).toBe(false);
    expect(result.products).toEqual([]);
    expect(result.unavailable).toBeUndefined();
    expect(result.note).toBe(
      'Not WHO-prequalified; WHO PQ covers ~650 global-health priority products (HIV/TB/malaria/reproductive health).'
    );
  });

  test('fetchWHORegulatory() fetch rejection returns the unavailable/_error envelope, never a fake false', async () => {
    global.fetch = mockWhoPqHosts(new Error('network down'));

    const result = await fetchWHORegulatory('artemether');

    expect(result).toEqual({
      prequalified: false,
      unavailable: true,
      _error: 'WHO PQ lookup failed: network down. Usually transient — retry later.',
      source: 'who',
    });
  });

  test('fetchWHORegulatory() non-CSV response is a fetch failure, not a zero-match false', async () => {
    global.fetch = mockWhoPqHosts('<html><body>403 Forbidden</body></html>');

    const result = await fetchWHORegulatory('artemether');

    expect(result.prequalified).toBe(false);
    expect(result.unavailable).toBe(true);
    expect(result._error).toContain('not the WHO PQ CSV export');
    expect(result.note).toBeUndefined(); // failure and out-of-scope are distinct answers
  });

  test('fetchWHORegulatory() caches the CSV for 24h — a second lookup does not refetch', async () => {
    global.fetch = mockWhoPqHosts();

    await fetchWHORegulatory('artemether');
    await fetchWHORegulatory('zidovudine'); // same process, different drug

    expect(whoFetchCount()).toBe(1);
  });

  test('WHO PQ memo: a backward wall-clock jump cannot pin it stale-forever — normal progression still expires it', async () => {
    // WSL2 #166: the memo's TTL runs on the monotonic clock, so a wall-clock
    // jump backward (which would make `Date.now - fetchedAt` negative and a
    // wall-clock memo live forever) must not matter, and the memo must still
    // expire once monotonic time passes the 24 h TTL. Fake timers virtualize
    // performance.now; setSystemTime moves only the virtual Date
    // (verified) — exactly the wall-jumps/monotonic-ticks split under test.
    global.fetch = mockWhoPqHosts();

    await fetchWHORegulatory('artemether');
    expect(whoFetchCount()).toBe(1);

    jest.useFakeTimers();
    try {
      // Wall clock jumps back 5 minutes; monotonic clock unaffected.
      jest.setSystemTime(Date.now() - 5 * 60_000);
      await fetchWHORegulatory('lumefantrine');
      expect(whoFetchCount()).toBe(1); // still memoized — no refetch storm

      // 24 h TTL passes on the monotonic clock: the memo MUST expire.
      jest.advanceTimersByTime(24 * 60 * 60 * 1000 + 60_000);
      await fetchWHORegulatory('dolutegravir');
      expect(whoFetchCount()).toBe(2); // genuinely expired → refetch
    } finally {
      jest.useRealTimers();
    }
  });

  test('drugGet() who_regulatory section wires the real lookup through the section pipeline', async () => {
    global.fetch = mockWhoPqHosts();

    const result = await drugGet('artemether', ['who_regulatory']);

    const section = result.sections?.who_regulatory as { prequalified: boolean; products: Array<{ who_ref: string }> };
    expect(section.prequalified).toBe(true);
    expect(section.products.map(p => p.who_ref)).toEqual(['MA026', 'MA062', 'MA069']);
    // eu_regulatory is gone from the section switch: no key, no stub.
    expect(result.sections?.eu_regulatory).toBeUndefined();
  });

  test('drugGet() sections=["all"] includes all six sections incl. adverse_events', async () => {
    global.fetch = jest.fn<(...args: any[]) => any>().mockImplementation(async (input: any) => {
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
      ['adverse_events', 'indications', 'safety', 'targets', 'us_regulatory', 'who_regulatory'].sort()
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
    global.fetch = jest.fn<(...args: any[]) => any>().mockResolvedValue({
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
    // Issue #123: the CAS registry number rides in `cas` — `aliases` stays
    // reserved for true name synonyms (none sourced today).
    expect(result.cas).toBe('27061-78-5');
    expect(result.aliases).toBeUndefined();
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

// ============================================================
// drug_search tool envelope (issue #83)
// ============================================================
describe('drug_search tool envelope (issue #83)', () => {
  let harness: McpTestHarness;
  mockGlobalFetch();

  beforeAll(async () => {
    harness = await createMcpTestHarness();
  });

  afterAll(async () => {
    await harness.close();
  });

  beforeEach(() => {
    jest.clearAllMocks();
    connectionManager.closeAll();
  });

  test('wraps results in the { results } envelope on matches', async () => {
    global.fetch = jest.fn<(...args: any[]) => any>().mockImplementation((input: any) => {
      const url = parseMockUrl(input);
      expect(url.hostname).toBe('mychem.info');
      return Promise.resolve({
        ok: true,
        json: () => Promise.resolve({
          hits: [{ chebi: { name: 'Aspirin' }, unichem: { chembl: 'CHEMBL25' } }],
        }),
        headers: new Headers({ 'content-type': 'application/json' }),
      });
    }) as any;

    const envelope = await harness.callTool('drug_search', { query: 'aspirin' });

    expect(Array.isArray(envelope.results)).toBe(true);
    expect(envelope.results).toHaveLength(1);
    expect(envelope.results[0].name).toBe('Aspirin');
    expect(envelope.hint).toBeUndefined();
  });

  test('empty results carry the mechanism-query hint naming gene_drugs', async () => {
    // MyChem has no mechanism text in this query — "EGFR inhibitor"-style
    // queries legitimately return nothing, and the envelope must say where
    // those queries belong instead of a bare [].
    global.fetch = jest.fn<(...args: any[]) => any>().mockResolvedValue({
      ok: true,
      json: () => Promise.resolve({ hits: [] }),
      headers: new Headers({ 'content-type': 'application/json' }),
    }) as any;

    const envelope = await harness.callTool('drug_search', { query: 'EGFR inhibitor' });

    expect(envelope.results).toEqual([]);
    expect(typeof envelope.hint).toBe('string');
    expect(envelope.hint).toContain("No ChEMBL/MyChem identity matches for 'EGFR inhibitor'");
    expect(envelope.hint).toContain('drug_search matches drug names/keywords');
    expect(envelope.hint).toContain("use gene_drugs with the target's gene symbol");
  });
});
