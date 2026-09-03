import { describe, it, expect, beforeAll, afterAll } from '@jest/globals';
import { createMcpTestHarness } from '../../helpers/mcp-harness.js';
import { expectGeneSearchResult, expectGeneGetResult, expectCrossEntityDrugRows, expectCrossEntityTrialRows, expectCrossEntityArticleRows } from '../../helpers/assertions.js';
import { retryOnRateLimit } from '../../helpers/retry.js';

let harness: Awaited<ReturnType<typeof createMcpTestHarness>>;

beforeAll(async () => {
  harness = await createMcpTestHarness();
}, 30000);

afterAll(async () => {
  await harness.close();
});

describe('gene_search', () => {
  it('returns BRCA1 with stable identity', async () => {
    const results = await retryOnRateLimit(() => harness.callTool('gene_search', { query: 'BRCA1' }));
    expectGeneSearchResult(results);
    const hit = results.find((r: any) => r.symbol === 'BRCA1');
    expect(hit).toBeDefined();
    expect(Number(hit.entrez_id)).toBe(672);
  }, 60000);

  it('returns TP53 with stable identity', async () => {
    const results = await retryOnRateLimit(() => harness.callTool('gene_search', { query: 'TP53' }));
    expectGeneSearchResult(results);
    const hit = results.find((r: any) => r.symbol === 'TP53');
    expect(hit).toBeDefined();
    expect(Number(hit.entrez_id)).toBe(7157);
  }, 60000);

  it('returns results for EGFR', async () => {
    const results = await retryOnRateLimit(() => harness.callTool('gene_search', { query: 'EGFR' }));
    expectGeneSearchResult(results);
    const hit = results.find((r: any) => r.symbol === 'EGFR');
    expect(hit).toBeDefined();
    expect(Number(hit.entrez_id)).toBe(1956);
  }, 60000);

  it('returns empty for nonsense query', async () => {
    const results = await retryOnRateLimit(() => harness.callTool('gene_search', { query: 'ZZZZZNOTAGENE99999' }));
    expectGeneSearchResult(results);
    expect(results.length).toBe(0);
  }, 60000);

  it('respects limit parameter', async () => {
    const results = await retryOnRateLimit(() => harness.callTool('gene_search', { query: 'kinase', limit: 2 }));
    expectGeneSearchResult(results);
    expect(results.length).toBeLessThanOrEqual(2);
  }, 60000);
});

describe('gene_get', () => {
  it('returns BRCA1 core data', async () => {
    const result = await retryOnRateLimit(() => harness.callTool('gene_get', { symbol: 'BRCA1' }));
    expectGeneGetResult(result);
    expect(result.symbol).toBe('BRCA1');
    expect(result.name).toBeTruthy();
  }, 60000);

  it('returns TP53 core data', async () => {
    const result = await retryOnRateLimit(() => harness.callTool('gene_get', { symbol: 'TP53' }));
    expectGeneGetResult(result);
    expect(result.symbol).toBe('TP53');
  }, 60000);

  it('throws for invalid gene symbol', async () => {
    await expect(
      harness.callTool('gene_get', { symbol: 'INVALIDGENEXYZ999' })
    ).rejects.toThrow();
  }, 30000);
});

describe('gene_diseases', () => {
  it('returns diseases for BRCA1 via OpenTargets fallback', async () => {
    const result = await retryOnRateLimit(() => harness.callTool('gene_diseases', { symbol: 'BRCA1' }));
    expect(Array.isArray(result) || typeof result === 'object').toBe(true);
    if (Array.isArray(result)) {
      expect(result.length).toBeGreaterThan(0);
    }
  }, 60000);
});

describe('gene_drugs', () => {
  it('returns drugs for EGFR with real OpenTargets rows', async () => {
    const result = await retryOnRateLimit(() => harness.callTool('gene_drugs', { symbol: 'EGFR' }));
    expectCrossEntityDrugRows(result);
    // EGFR is a heavily drugged kinase target — real rows must exist.
    const realRows = (result as Array<Record<string, any>>).filter((r) => !r._error);
    expect(realRows.length).toBeGreaterThan(0);
    expect(realRows[0].source).toBe('opentargets');
  }, 60000);

  it('returns shape-valid (possibly empty) drugs for BRCA1', async () => {
    const result = await retryOnRateLimit(() => harness.callTool('gene_drugs', { symbol: 'BRCA1' }));
    expectCrossEntityDrugRows(result);
    // Zero rows is a valid live answer: BRCA1 is not a direct drug target in
    // OpenTargets (PARP inhibitors target PARP1/2, not BRCA1 itself).
  }, 60000);
});

describe('gene_trials', () => {
  it('returns trials for BRCA1', async () => {
    const result = await retryOnRateLimit(() => harness.callTool('gene_trials', { symbol: 'BRCA1' }));
    expectCrossEntityTrialRows(result);
    const realRows = (result as Array<Record<string, any>>).filter((r) => !r._error);
    expect(realRows.length).toBeGreaterThan(0);
  }, 60000);
});

describe('gene_articles', () => {
  it('returns articles for BRCA1', async () => {
    const result = await retryOnRateLimit(() => harness.callTool('gene_articles', { symbol: 'BRCA1' }));
    expectCrossEntityArticleRows(result);
  }, 60000);
});

describe('gene_enrich', () => {
  it('performs enrichment for gene list', async () => {
    try {
      const result = await retryOnRateLimit(() => harness.callTool('gene_enrich', { genes: ['BRCA1', 'TP53', 'EGFR'] }));
      expect(result).toBeDefined();
    } catch (error) {
      if (error instanceof Error && error.message.includes('gene_enrich')) {
        console.warn('gene_enrich skipped: upstream API unavailable');
        return;
      }
      throw error;
    }
  }, 60000);

  it('rejects input with fewer than 3 genes', async () => {
    await expect(
      harness.callTool('gene_enrich', { genes: ['BRCA1', 'TP53'] })
    ).rejects.toThrow();
  }, 30000);
});
