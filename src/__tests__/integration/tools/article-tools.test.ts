import { describe, it, expect, beforeAll, afterAll } from '@jest/globals';
import { createMcpTestHarness } from '../../helpers/mcp-harness.js';
import { expectArticleSearchResult, expectArticleGetResult } from '../../helpers/assertions.js';
import { retryOnRateLimit } from '../../helpers/retry.js';

let harness: Awaited<ReturnType<typeof createMcpTestHarness>>;

beforeAll(async () => {
  harness = await createMcpTestHarness();
}, 30000);

afterAll(async () => {
  await harness.close();
});

describe('article_search', () => {
  it('returns PubMed results for BRCA1', async () => {
    const results = await retryOnRateLimit(() => harness.callTool('article_search', { query: 'BRCA1', source: 'pubmed' }));
    expectArticleSearchResult(results);
    expect(results.length).toBeGreaterThan(0);
  }, 60000);

  it('returns results from europepmc source', async () => {
    const results = await retryOnRateLimit(() => harness.callTool('article_search', { query: 'cancer immunotherapy', source: 'europepmc' }));
    expectArticleSearchResult(results);
    if (results.length > 0) {
      expect(results[0].source).toBe('europepmc');
    }
  }, 60000);

  it('returns empty for nonsensical query', async () => {
    const results = await retryOnRateLimit(() => harness.callTool('article_search', { query: 'ZZZZZNOTAPAPER99999xyz', source: 'pubmed' }));
    expectArticleSearchResult(results);
    expect(results.length).toBe(0);
  }, 60000);
});

describe('article_get', () => {
  it('returns article by PMID', async () => {
    const result = await retryOnRateLimit(() => harness.callTool('article_get', { id: '25333279' }));
    expectArticleGetResult(result);
    expect(result.title).toBeTruthy();
  }, 60000);

  it('returns empty for invalid PMID', async () => {
    const result = await retryOnRateLimit(() => harness.callTool('article_get', { id: '99999999' }));
    expect(result).toBeDefined();
  }, 60000);

  it('returns article by PMCID', async () => {
    const result = await retryOnRateLimit(() => harness.callTool('article_get', { id: 'PMC4325238' }));
    expect(result).toBeDefined();
    expect(result.title).toBeTruthy();
  }, 60000);

  it('returns article by DOI', async () => {
    const result = await retryOnRateLimit(() => harness.callTool('article_get', { id: '10.1038/nature12373' }));
    expect(result).toBeDefined();
    expect(result.pmid).toBeTruthy();
  }, 60000);

  it('returns error when id is missing', async () => {
    await expect(harness.callTool('article_get', {})).rejects.toThrow('article_get');
  }, 60000);

  it('returns error for invalid identifier format', async () => {
    await expect(harness.callTool('article_get', { id: 'not-a-valid-id' })).rejects.toThrow('article_get');
  }, 60000);
});
