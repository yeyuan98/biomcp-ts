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
  it('returns breast cancer with MONDO ID', async () => {
    const results = await retryOnRateLimit(() => harness.callTool('disease_search', { query: 'breast cancer' }));
    expectDiseaseSearchResult(results);
    const hit = results.find((r: any) => r.disease_id?.startsWith('MONDO:') && /breast/i.test(r.name || ''));
    expect(hit).toBeDefined();
  }, 60000);

  it('returns lung cancer results', async () => {
    const results = await retryOnRateLimit(() => harness.callTool('disease_search', { query: 'lung cancer' }));
    expectDiseaseSearchResult(results);
    expect(results.length).toBeGreaterThan(0);
  }, 60000);

  it('returns empty for nonsense query', async () => {
    const results = await retryOnRateLimit(() => harness.callTool('disease_search', { query: 'ZZZZZNOTADISEASE99999' }));
    expectDiseaseSearchResult(results);
    expect(results.length).toBe(0);
  }, 60000);

  it('respects limit parameter', async () => {
    const results = await retryOnRateLimit(() => harness.callTool('disease_search', { query: 'diabetes', limit: 2 }));
    expectDiseaseSearchResult(results);
    expect(results.length).toBeLessThanOrEqual(2);
  }, 60000);
});

describe('disease_get', () => {
  it('returns breast cancer by MONDO ID', async () => {
    const result = await retryOnRateLimit(() => harness.callTool('disease_get', { disease_id: 'MONDO:0007254' }));
    expectDiseaseGetResult(result);
    expect(result.name.toLowerCase()).toContain('breast');
  }, 60000);

  it('throws for invalid disease ID', async () => {
    await expect(
      harness.callTool('disease_get', { disease_id: 'MONDO:9999999' })
    ).rejects.toThrow();
  }, 30000);
});

describe('disease_drugs', () => {
  it('returns drugs for breast cancer via OpenTargets', async () => {
    const result = await retryOnRateLimit(() => harness.callTool('disease_drugs', { disease_id: 'MONDO:0007254' }));
    expectCrossEntityDrugRows(result);
    // Breast cancer is a heavily drugged indication — real rows must exist.
    const realRows = (result as Array<Record<string, any>>).filter((r) => !r._error);
    expect(realRows.length).toBeGreaterThan(0);
  }, 60000);
});

describe('disease_trials', () => {
  it('returns trials for breast cancer', async () => {
    const result = await retryOnRateLimit(() => harness.callTool('disease_trials', { disease_id: 'MONDO:0007254' }));
    expectCrossEntityTrialRows(result);
    const realRows = (result as Array<Record<string, any>>).filter((r) => !r._error);
    expect(realRows.length).toBeGreaterThan(0);
  }, 60000);
});
