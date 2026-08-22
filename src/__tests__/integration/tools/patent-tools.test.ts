import { describe, it, expect, beforeAll, afterAll } from '@jest/globals';
import { createMcpTestHarness } from '../../helpers/mcp-harness.js';
import { expectPatentSearchResult, expectPatentGetResult } from '../../helpers/assertions.js';
import { retryOnRateLimit } from '../../helpers/retry.js';
import { ppubsClient, opsClient } from '../../../entities/patent/index.js';

let harness: Awaited<ReturnType<typeof createMcpTestHarness>>;

beforeAll(async () => {
  harness = await createMcpTestHarness();
}, 30000);

afterAll(async () => {
  await harness.close();
  ppubsClient.close();
  opsClient.close();
});

describe('patent_search', () => {
  it('returns patents from auto-selected backends', async () => {
    const response = await retryOnRateLimit(() => harness.callTool('patent_search', { query: 'crispr cas9', limit: 5 }));
    expectPatentSearchResult(response);
    const real = response.patents.filter((p: Record<string, unknown>) => !(p as any)._error);
    expect(real.length).toBeGreaterThan(0);
  }, 120000);

  it('returns US results via keyless ppubs source', async () => {
    const response = await retryOnRateLimit(() =>
      harness.callTool('patent_search', { query: 'crispr', source: 'ppubs', limit: 3 }));
    expectPatentSearchResult(response);
    expect(response.patents.length).toBeGreaterThan(0);
    expect(response.patents[0].source).toBe('ppubs');
    expect(String(response.patents[0].publication_number)).toMatch(/^US/);
  }, 120000);

  it('applies assignee filter (stable identity: Moderna crispr filings exist)', async () => {
    const response = await retryOnRateLimit(() =>
      harness.callTool('patent_search', { query: 'crispr', assignee: 'Moderna', source: 'ppubs', limit: 5 }));
    expectPatentSearchResult(response);
    expect(response.patents.length).toBeGreaterThan(0);
  }, 120000);

  it('respects limit parameter', async () => {
    const response = await retryOnRateLimit(() =>
      harness.callTool('patent_search', { query: 'cancer immunotherapy', source: 'ppubs', limit: 2 }));
    expectPatentSearchResult(response);
    expect(response.patents.length).toBeLessThanOrEqual(2);
  }, 120000);
});

describe('patent_get', () => {
  it('returns a US patent with sections (stable identity)', async () => {
    const result = await retryOnRateLimit(() =>
      harness.callTool('patent_get', {
        patent_id: 'US11027025B2',
        sections: ['claims', 'citations', 'family', 'classifications'],
        limit: 5,
      }));
    expectPatentGetResult(result);
    expect(String(result.publication_number)).toMatch(/^US11027025/);
    // claims: US fulltext must come through some chain step
    const claims = result.sections?.claims as Record<string, unknown> | undefined;
    expect(claims).toBeDefined();
    if (!(claims as any)?.error) {
      expect(Array.isArray((claims as any).claims)).toBe(true);
      expect((claims as any).claims.length).toBeGreaterThan(0);
    }
    const citations = result.sections?.citations as Record<string, unknown> | undefined;
    if (citations && !Array.isArray(citations)) {
      if (!(citations as any).error) {
        expect(Array.isArray((citations as any).backward)).toBe(true);
      }
    }
  }, 120000);

  it('rejects invalid patent ids', async () => {
    await expect(harness.callTool('patent_get', { patent_id: 'not-a-patent' }))
      .rejects.toThrow(/Invalid patent number/i);
  }, 60000);
});

// Keyed live tests: skipped automatically when credentials are absent.
const opsDescribe = (process.env.EPO_OPS_CONSUMER_KEY && process.env.EPO_OPS_CONSUMER_SECRET) ? describe : describe.skip;
const odpDescribe = process.env.USPTO_API_KEY ? describe : describe.skip;

opsDescribe('patent_search (EPO OPS, keyed)', () => {
    it('searches worldwide publications with CQL', async () => {
      const response = await retryOnRateLimit(() =>
        harness.callTool('patent_search', { query: 'crispr', assignee: 'moderna', source: 'ops', limit: 3 }));
      expectPatentSearchResult(response);
      expect(response.patents.length).toBeGreaterThan(0);
      expect(response.patents[0].source).toBe('ops');
    }, 120000);

    it('fetches worldwide (non-US) patent core', async () => {
      const result = await retryOnRateLimit(() =>
        harness.callTool('patent_get', { patent_id: 'EP1000000A1' }));
      expectPatentGetResult(result);
      expect(String(result.publication_number)).toMatch(/^EP/);
      expect(result.title).toBeTruthy();
    }, 120000);

    it('fetches claims for an EP patent (OPS fulltext authority)', async () => {
      const result = await retryOnRateLimit(() =>
        harness.callTool('patent_get', { patent_id: 'EP1000000A1', sections: ['claims'], limit: 3 }));
      expectPatentGetResult(result);
      const claims = result.sections?.claims as Record<string, unknown> | undefined;
      expect(claims).toBeDefined();
      expect((claims as any)?.error).toBeUndefined();
      expect(Array.isArray((claims as any)?.claims)).toBe(true);
    }, 120000);
});

odpDescribe('patent_get (USPTO ODP, keyed)', () => {
  it('resolves a granted US patent via ODP', async () => {
    const result = await retryOnRateLimit(() =>
      harness.callTool('patent_get', { patent_id: 'US11027025B2' }));
    expectPatentGetResult(result);
    expect(String(result.publication_number)).toMatch(/^US11027025/);
  }, 120000);
});
