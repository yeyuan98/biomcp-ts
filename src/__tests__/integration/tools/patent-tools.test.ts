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
    const response = await retryOnRateLimit(() => harness.callTool('patent_search', { query: 'crispr cas9', limit: 5, seminal: false }));
    expectPatentSearchResult(response);
    const real = response.patents.filter((p: Record<string, unknown>) => !(p as any)._error);
    expect(real.length).toBeGreaterThan(0);
  }, 120000);

  it('returns US results via keyless ppubs source', async () => {
    const response = await retryOnRateLimit(() =>
      harness.callTool('patent_search', { query: 'crispr', source: 'ppubs', limit: 3, seminal: false }));
    expectPatentSearchResult(response);
    expect(response.patents.length).toBeGreaterThan(0);
    expect(response.patents[0].source).toBe('ppubs');
    expect(String(response.patents[0].publication_number)).toMatch(/^US/);
  }, 120000);

  it('applies assignee filter (stable identity: Moderna crispr filings exist)', async () => {
    const response = await retryOnRateLimit(() =>
      harness.callTool('patent_search', { query: 'crispr', assignee: 'Moderna', source: 'ppubs', limit: 5, seminal: false }));
    expectPatentSearchResult(response);
    expect(response.patents.length).toBeGreaterThan(0);
  }, 120000);

  it('respects limit parameter', async () => {
    const response = await retryOnRateLimit(() =>
      harness.callTool('patent_search', { query: 'cancer immunotherapy', source: 'ppubs', limit: 2, seminal: false }));
    expectPatentSearchResult(response);
    expect(response.patents.length).toBeLessThanOrEqual(2);
    expect(response.seminal_prior_art).toBeUndefined();
  }, 120000);

  it('ranks a quoted biotech concept by relevance on ppubs (mRNA display)', async () => {
    const response = await retryOnRateLimit(() =>
      harness.callTool('patent_search', { query: '"mRNA display"', source: 'ppubs', limit: 5 }));
    expectPatentSearchResult(response);
    const real = response.patents.filter((p: Record<string, unknown>) => !p._error && !p._hint);
    expect(real.length).toBeGreaterThan(0);
    // On-topic hit in the top 5: the mRNA display technique concerns
    // selecting binding proteins/peptides from mRNA libraries (tolerant matcher).
    const titles = real.map((p: Record<string, unknown>) => String(p.title || '')).join(' | ');
    expect(titles).toMatch(/binding prot|mrna display|aptamer|display librar|sequence/i);
    // Relevance mode surfaces scores and a family-based match count
    expect(real.some((p: Record<string, unknown>) => typeof p.relevance_score === 'number')).toBe(true);
    expect(response.total_hits?.ppubs).toBeDefined();
    expect(response.total_hits_basis?.ppubs).toContain('families');
  }, 120000);

  it('falls back to recency sort when sort_by=recency', async () => {
    const response = await retryOnRateLimit(() =>
      harness.callTool('patent_search', { query: 'crispr cas9', source: 'ppubs', sort_by: 'recency', limit: 3, seminal: false }));
    expectPatentSearchResult(response);
    const dates = response.patents
      .filter((p: Record<string, unknown>) => !p._error && !p._hint)
      .map((p: Record<string, unknown>) => String(p.publication_date || ''));
    expect(dates.length).toBeGreaterThan(0);
    const sorted = [...dates].sort().reverse();
    expect(dates).toEqual(sorted);
  }, 120000);

  it('discovers seminal prior art for a vocabulary-mismatched concept (mRNA display → Szostak)', async () => {
    const response = await retryOnRateLimit(() =>
      harness.callTool('patent_search', { query: '"mRNA display"', limit: 5 }));
    expectPatentSearchResult(response);
    // Default-on: seminal fields present whenever real results exist.
    expect(Array.isArray(response.seminal_prior_art)).toBe(true);
    expect(typeof response.mined_count).toBe('number');
    if ((response.mined_count as number) >= 3) {
      // The foundational Szostak art is co-cited by the top granted hits —
      // as US6261804 (when OPS creds resolve the family) or its PCT
      // WO9856915/WO1998/056915 forms (keyless). Tolerant matcher guards
      // against live index drift.
      const seminal = (response.seminal_prior_art as Array<Record<string, unknown>>)
        .map(e => `${e.publication_number} ${e.title || ''}`).join(' | ');
      expect(seminal).toMatch(/6261804|WO.?98.?05?6915|WO1998\/056915/i);
      const szostak = (response.seminal_prior_art as Array<Record<string, unknown>>)
        .find(e => /6261804|56915/i.test(String(e.publication_number)));
      expect(Number(szostak?.co_cited_by)).toBeGreaterThanOrEqual(2);
      expect(Array.isArray(szostak?.cited_by)).toBe(true);
    } else {
      // A thin pool must still be EXPLAINED, never silently empty.
      expect(String(response.semnal_note)).toMatch(/too few|no commonly-cited|skipped|deadline/);
    }
  }, 180000);
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
    const classifications = result.sections?.classifications as Record<string, unknown> | undefined;
    expect(classifications).toBeDefined();
    expect((classifications as any)?.error).toBeUndefined();
    expect(((classifications as any)?.cpc as unknown[])?.length).toBeGreaterThan(0);
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
