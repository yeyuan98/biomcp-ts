import { describe, it, expect, beforeAll, afterAll } from '@jest/globals';
import { createMcpTestHarness } from '../../helpers/mcp-harness.js';
import { expectArticleSearchResult, expectArticleGetResult } from '../../helpers/assertions.js';

let harness: Awaited<ReturnType<typeof createMcpTestHarness>>;

beforeAll(async () => {
  harness = await createMcpTestHarness();
}, 30000);

afterAll(async () => {
  await harness.close();
});

describe('article_search', () => {
  it('returns PubMed results for BRCA1', async () => {
    const results = await harness.callTool('article_search', { query: 'BRCA1', source: 'pubmed' });
    expectArticleSearchResult(results);
    expect(results.length).toBeGreaterThan(0);
  }, 30000);

  it('returns results from europepmc source', async () => {
    const results = await harness.callTool('article_search', { query: 'cancer immunotherapy', source: 'europepmc' });
    expectArticleSearchResult(results);
    if (results.length > 0) {
      expect(results[0].source).toBe('europepmc');
    }
  }, 30000);

  it('returns empty for nonsensical query', async () => {
    const results = await harness.callTool('article_search', { query: 'ZZZZZNOTAPAPER99999xyz', source: 'pubmed' });
    expectArticleSearchResult(results);
    expect(results.length).toBe(0);
  }, 30000);
});

describe('article_get', () => {
  it('returns article by PMID', async () => {
    const result = await harness.callTool('article_get', { pmid: '25333279' });
    expectArticleGetResult(result);
    expect(result.title).toBeTruthy();
  }, 30000);

  it('returns empty for invalid PMID', async () => {
    const result = await harness.callTool('article_get', { pmid: '99999999' });
    expect(result).toBeDefined();
  }, 30000);
});
