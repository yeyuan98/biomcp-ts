import { describe, it, expect, beforeAll, afterAll, jest } from '@jest/globals';
import { createMcpTestHarness } from '../../helpers/mcp-harness.js';
import { expectDrugGetResult, expectDrugAdverseEventsSection } from '../../helpers/assertions.js';
import { retryOnRateLimit } from '../../helpers/retry.js';

jest.setTimeout(60000); // measured p95 ≈ 7 s with occasional retry-amplified outliers; 60 s also matches the MCP client request cap

let harness: Awaited<ReturnType<typeof createMcpTestHarness>>;

beforeAll(async () => {
  harness = await createMcpTestHarness();
}, 30000);

afterAll(async () => {
  await harness.close();
});

describe('drug_search', () => {
  // drug_search replies are envelopes (issue #83): { results, hint? }.
  it('returns aspirin results with valid name', async () => {
    const envelope = await retryOnRateLimit(() => harness.callTool('drug_search', { query: 'aspirin' }));
    expect(Array.isArray(envelope.results)).toBe(true);
    expect(envelope.results.length).toBeGreaterThan(0);
    const hit = envelope.results.find((r: any) => /aspirin|acetylsalicylic acid/i.test(r.name || ''));
    expect(hit).toBeDefined();
    // A matching query carries no hint.
    expect(envelope.hint).toBeUndefined();
  }, 60000);

  it('returns imatinib without a sparse no-identifier duplicate (issue #83)', async () => {
    const envelope = await retryOnRateLimit(() => harness.callTool('drug_search', { query: 'imatinib' }));
    expect(Array.isArray(envelope.results)).toBe(true);
    const hit = envelope.results.find((r: any) =>
      r.chembl_id === 'CHEMBL941' || r.name?.toLowerCase().includes('imatinib')
    );
    expect(hit).toBeDefined();
    // Every imatinib-named row must carry a chemical identity — the sparse
    // "Imatinib Mesylate" row with no ids merges into the id-bearing rows.
    for (const r of envelope.results) {
      if (r.name?.toLowerCase().includes('imatinib')) {
        expect(r.chembl_id || r.inchi_key).toBeTruthy();
      }
    }
    // Issue #123: `unii` carries the FDA UNII, never the CAS registry number
    // (dash-separated digits) — that value rides in `cas` (live-verified on
    // mychem.info: the imatinib base row maps unii=BKJ8M8G5HI / cas=152459-95-5).
    expect(hit.unii ?? '').not.toMatch(/^\d{2,7}-\d{2}-\d$/);
    expect(hit.cas ?? '').toMatch(/^\d{2,7}-\d{2}-\d$/);
    for (const r of envelope.results) {
      if (r.unii !== undefined) expect(r.unii).not.toMatch(/^\d{2,7}-\d{2}-\d$/);
      if (r.cas !== undefined) expect(r.cas).toMatch(/^\d{2,7}-\d{2}-\d$/);
    }
  }, 60000);

  it('returns an empty-results envelope with a hint for nonsense query', async () => {
    const envelope = await retryOnRateLimit(() => harness.callTool('drug_search', { query: 'ZZZZNOTADRUG99999' }));
    expect(envelope.results).toEqual([]);
    expect(typeof envelope.hint).toBe('string');
    expect(envelope.hint).toContain('drug_search matches drug names/keywords');
  }, 60000);

  it('mechanism-style query (EGFR inhibitor) returns empty results plus the gene_drugs hint (issue #83)', async () => {
    // MyChem has no mechanism text in this query: the UMLS-concept hits it
    // does return carry no chemical identity fields, so after the transform
    // + dedup passes the result is legitimately empty — with the hint
    // directing mechanism/target queries to gene_drugs.
    const envelope = await retryOnRateLimit(() => harness.callTool('drug_search', { query: 'EGFR inhibitor' }));
    expect(envelope.results).toEqual([]);
    expect(typeof envelope.hint).toBe('string');
    expect(envelope.hint).toContain("No ChEMBL/MyChem identity matches for 'EGFR inhibitor'");
    expect(envelope.hint).toContain('gene_drugs');
  }, 60000);

  it('respects limit parameter', async () => {
    const envelope = await retryOnRateLimit(() => harness.callTool('drug_search', { query: 'inhibitor', limit: 2 }));
    expect(Array.isArray(envelope.results)).toBe(true);
    expect(envelope.results.length).toBeLessThanOrEqual(2);
  }, 60000);
});

describe('drug_get', () => {
  it('returns aspirin core data', async () => {
    const result = await retryOnRateLimit(() => harness.callTool('drug_get', { name: 'aspirin' }));
    expectDrugGetResult(result);
    // Canonical ChEBI name is "acetylsalicylic acid"; "aspirin" is a synonym
    expect(['aspirin', 'acetylsalicylic acid']).toContain((result.name as string).toLowerCase());
  }, 60000);

  it('returns imatinib core data', async () => {
    const result = await retryOnRateLimit(() => harness.callTool('drug_get', { name: 'imatinib' }));
    expectDrugGetResult(result);
    expect((result.name as string).toLowerCase()).toContain('imatinib');
  }, 60000);

  it('throws for invalid drug name', async () => {
    await expect(
      harness.callTool('drug_get', { name: 'INVALIDDRUGXYZ999' })
    ).rejects.toThrow();
  }, 30000);
});

describe('drug_get sections', () => {
  it('adverse_events returns ranked FDA FAERS reactions', async () => {
    const result = await retryOnRateLimit(() => harness.callTool('drug_get', { name: 'aspirin', sections: ['adverse_events'] }));
    expectDrugAdverseEventsSection(result);
  }, 90000);

  it('sections=["all"] includes all six sections incl. adverse_events', async () => {
    const result = await retryOnRateLimit(() => harness.callTool('drug_get', { name: 'aspirin', sections: ['all'], limit: 5 }));
    expect(result.sections).toBeDefined();
    expect(Object.keys(result.sections).sort()).toEqual(
      ['adverse_events', 'indications', 'safety', 'targets', 'us_regulatory', 'who_regulatory'].sort()
    );
    expectDrugAdverseEventsSection(result);
  }, 90000);

  it('safety section returns FDA label safety data (section plumbing baseline)', async () => {
    const result = await retryOnRateLimit(() => harness.callTool('drug_get', { name: 'aspirin', sections: ['safety'] }));
    const safety = (result as any)?.sections?.safety;
    expect(safety).toBeDefined();
  }, 60000);
});

describe('drug_trials', () => {
  it('returns trials for imatinib', async () => {
    const result = await retryOnRateLimit(() => harness.callTool('drug_trials', { drug: 'imatinib' }));
    expect(Array.isArray(result)).toBe(true);
    expect(result.length).toBeGreaterThan(0);
    for (const t of result) {
      expect(t.nct_id).toMatch(/^NCT\d{8}$/);
      expect(typeof t.title).toBe('string');
    }
  }, 60000);
});
