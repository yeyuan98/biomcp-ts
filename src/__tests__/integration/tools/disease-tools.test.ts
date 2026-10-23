import { describe, it, expect, beforeAll, afterAll } from '@jest/globals';
import { createMcpTestHarness } from '../../helpers/mcp-harness.js';
import { expectDiseaseSearchResult, expectDiseaseGetResult, expectCrossEntityDrugRows, expectCrossEntityTrialRows } from '../../helpers/assertions.js';
import { retryOnRateLimit } from '../../helpers/retry.js';

let harness: Awaited<ReturnType<typeof createMcpTestHarness>>;

beforeAll(async () => {
  harness = await createMcpTestHarness();
}, 30000);

afterAll(async () => {
  await harness.close();
});

describe('disease_search', () => {
  // disease_search replies are envelopes (issue #130): { results, warnings?, errors? }.
  it('returns breast cancer with MONDO ID', async () => {
    const envelope = await retryOnRateLimit(() => harness.callTool('disease_search', { query: 'breast cancer' }));
    expectDiseaseSearchResult(envelope.results);
    const hit = envelope.results.find((r: any) => r.disease_id?.startsWith('MONDO:') && /breast/i.test(r.name || ''));
    expect(hit).toBeDefined();
  }, 60000);

  it('returns lung cancer results', async () => {
    const envelope = await retryOnRateLimit(() => harness.callTool('disease_search', { query: 'lung cancer' }));
    expectDiseaseSearchResult(envelope.results);
    expect(envelope.results.length).toBeGreaterThan(0);
  }, 60000);

  it('returns empty for nonsense query', async () => {
    const envelope = await retryOnRateLimit(() => harness.callTool('disease_search', { query: 'ZZZZZNOTADISEASE99999' }));
    expectDiseaseSearchResult(envelope.results);
    expect(envelope.results.length).toBe(0);
  }, 60000);

  it('respects limit parameter', async () => {
    const envelope = await retryOnRateLimit(() => harness.callTool('disease_search', { query: 'diabetes', limit: 2 }));
    expectDiseaseSearchResult(envelope.results);
    expect(envelope.results.length).toBeLessThanOrEqual(2);
  }, 60000);
});

describe('disease_get', () => {
  it('returns breast cancer by MONDO ID', async () => {
    const result = await retryOnRateLimit(() => harness.callTool('disease_get', { disease_id: 'MONDO:0007254' }));
    expectDiseaseGetResult(result);
    expect((result.name as string).toLowerCase()).toContain('breast');
  }, 60000);

  it('resolves a UMLS CUI to its MONDO document (C0006142)', async () => {
    const result = await retryOnRateLimit(() => harness.callTool('disease_get', { disease_id: 'C0006142' }));
    expectDiseaseGetResult(result);
    expect(result.disease_id).toBe('MONDO:0007254');
    expect((result.name as string).toLowerCase()).toContain('breast');
  }, 60000);

  it('accepts the docstring UMLS CUI example (C0018794)', async () => {
    // The docstring's golden example: previously rejected with "Supported ID
    // formats: MONDO/DOID/OMIM". C0018794 resolves to the UMLS-sourced
    // HP:0012722 document (a nameless stub in mydisease), whose real name —
    // "Heart block" — comes from MedGen enrichment (issue #100).
    const result = await retryOnRateLimit(() => harness.callTool('disease_get', { disease_id: 'C0018794' }));
    expectDiseaseGetResult(result);
    expect(result.disease_id).toBe('HP:0012722');
    expect((result.name as string).toLowerCase()).toMatch(/heart block/);
    expect(result.ontology).toBe('umls');
  }, 60000);

  it('throws for invalid disease ID', async () => {
    await expect(
      harness.callTool('disease_get', { disease_id: 'MONDO:9999999' })
    ).rejects.toThrow();
  }, 30000);
});

describe('disease_drugs', () => {
  it('returns drugs for breast cancer via OpenTargets', async () => {
    // Envelope (issue #130): { results, warnings?, errors? } — partial
    // failures ride in errors[] (issue #159); the sibling gene_drugs tool
    // was converted to the same contract in #179.
    const envelope = await retryOnRateLimit(() => harness.callTool('disease_drugs', { disease_id: 'MONDO:0007254' }));
    expectCrossEntityDrugRows(envelope.results);
    // Breast cancer is a heavily drugged indication — real rows must exist.
    const realRows = (envelope.results as Array<Record<string, any>>).filter((r) => !r._error);
    expect(realRows.length).toBeGreaterThan(0);
  }, 60000);
});

describe('disease_trials', () => {
  it('returns trials for breast cancer', async () => {
    const envelope = await retryOnRateLimit(() => harness.callTool('disease_trials', { disease_id: 'MONDO:0007254' }));
    expectCrossEntityTrialRows(envelope.results);
    const realRows = (envelope.results as Array<Record<string, any>>).filter((r) => !r._error);
    expect(realRows.length).toBeGreaterThan(0);
  }, 60000);
});
