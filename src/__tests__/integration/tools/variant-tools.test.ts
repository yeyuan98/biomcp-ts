import { describe, it, expect, beforeAll, afterAll } from '@jest/globals';
import { createMcpTestHarness } from '../../helpers/mcp-harness.js';
import { expectVariantSearchResult, expectVariantGetResult, expectCrossEntityTrialRows } from '../../helpers/assertions.js';
import { retryOnRateLimit } from '../../helpers/retry.js';

let harness: Awaited<ReturnType<typeof createMcpTestHarness>>;

beforeAll(async () => {
  harness = await createMcpTestHarness();
}, 30000);

afterAll(async () => {
  await harness.close();
});

describe('variant_search', () => {
  it('returns rs113488022 with stable rsID', async () => {
    const results = await retryOnRateLimit(() => harness.callTool('variant_search', { query: 'rs113488022' }));
    expectVariantSearchResult(results);
    const hit = results.find((r: any) => r.id === 'rs113488022');
    expect(hit).toBeDefined();
  }, 60000);

  it('searches by gene with hgvsp parameter', async () => {
    const results = await retryOnRateLimit(() => harness.callTool('variant_search', { gene: 'BRAF', hgvsp: 'V600E' }));
    expectVariantSearchResult(results);
    if (results.length > 0) {
      const hit = results.find((r: any) =>
        r.gene?.toUpperCase() === 'BRAF' && r.hgvs_p?.includes('V600E')
      );
      expect(hit).toBeDefined();
    }
  }, 60000);

  it('returns empty for nonsense query', async () => {
    const results = await retryOnRateLimit(() => harness.callTool('variant_search', { query: 'NOTAVARIANT999999' }));
    expectVariantSearchResult(results);
    expect(results.length).toBe(0);
  }, 60000);

  it('respects limit parameter', async () => {
    const results = await retryOnRateLimit(() => harness.callTool('variant_search', { query: 'BRAF', limit: 2 }));
    expectVariantSearchResult(results);
    expect(results.length).toBeLessThanOrEqual(2);
  }, 60000);
});

describe('variant_get', () => {
  it('returns rs113488022 core data', async () => {
    const result = await retryOnRateLimit(() => harness.callTool('variant_get', { id: 'rs113488022' }));
    expectVariantGetResult(result);
    expect(result.id).toContain('rs113488022');
  }, 60000);

  it('throws for invalid variant ID', async () => {
    await expect(
      harness.callTool('variant_get', { id: 'NOTAVARIANT999999' })
    ).rejects.toThrow();
  }, 30000);
});

describe('variant_oncokb', () => {
  it.skip('returns annotation for BRAF V600E (requires ONCOKB_TOKEN)', async () => {
    const result = await retryOnRateLimit(() => harness.callTool('variant_oncokb', { gene: 'BRAF', protein_change: 'V600E' }));
    expect(result).toBeDefined();
  }, 60000);
});

describe('variant_trials', () => {
  it('returns trials for a variant', async () => {
    const result = await retryOnRateLimit(() => harness.callTool('variant_trials', { variant: 'rs113488022' }));
    expectCrossEntityTrialRows(result);
    const realRows = (result as Array<Record<string, any>>).filter((r) => !r._error);
    expect(realRows.length).toBeGreaterThan(0);
  }, 60000);
});
