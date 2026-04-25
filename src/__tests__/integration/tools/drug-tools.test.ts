import { describe, it, expect, beforeAll, afterAll } from '@jest/globals';
import { createMcpTestHarness } from '../../helpers/mcp-harness.js';
import { expectDrugSearchResult, expectDrugGetResult } from '../../helpers/assertions.js';

let harness: Awaited<ReturnType<typeof createMcpTestHarness>>;

beforeAll(async () => {
  harness = await createMcpTestHarness();
}, 30000);

afterAll(async () => {
  await harness.close();
});

describe('drug_search', () => {
  it('returns aspirin results with valid name', async () => {
    const results = await harness.callTool('drug_search', { query: 'aspirin' });
    expectDrugSearchResult(results);
    expect(results.length).toBeGreaterThan(0);
    const hit = results.find((r: any) => r.name?.toLowerCase().includes('aspirin'));
    expect(hit).toBeDefined();
  }, 30000);

  it('returns imatinib', async () => {
    const results = await harness.callTool('drug_search', { query: 'imatinib' });
    expectDrugSearchResult(results);
    const hit = results.find((r: any) =>
      r.chembl_id === 'CHEMBL941' || r.name?.toLowerCase().includes('imatinib')
    );
    expect(hit).toBeDefined();
  }, 30000);

  it('returns empty for nonsense query', async () => {
    const results = await harness.callTool('drug_search', { query: 'ZZZZNOTADRUG99999' });
    expectDrugSearchResult(results);
    expect(results.length).toBe(0);
  }, 30000);

  it('respects limit parameter', async () => {
    const results = await harness.callTool('drug_search', { query: 'inhibitor', limit: 2 });
    expectDrugSearchResult(results);
    expect(results.length).toBeLessThanOrEqual(2);
  }, 30000);
});

describe('drug_get', () => {
  it('returns aspirin core data', async () => {
    const result = await harness.callTool('drug_get', { name: 'aspirin' });
    expectDrugGetResult(result);
    expect(result.name.toLowerCase()).toContain('aspirin');
  }, 30000);

  it('returns imatinib core data', async () => {
    const result = await harness.callTool('drug_get', { name: 'imatinib' });
    expectDrugGetResult(result);
    expect(result.name.toLowerCase()).toContain('imatinib');
  }, 30000);

  it('throws for invalid drug name', async () => {
    await expect(
      harness.callTool('drug_get', { name: 'INVALIDDRUGXYZ999' })
    ).rejects.toThrow();
  }, 30000);
});

describe('drug_trials', () => {
  it('returns trials for imatinib', async () => {
    const result = await harness.callTool('drug_trials', { drug: 'imatinib' });
    expect(result).toBeDefined();
  }, 30000);
});
