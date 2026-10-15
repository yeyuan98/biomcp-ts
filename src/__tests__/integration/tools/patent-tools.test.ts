import { describe, it, expect, beforeAll, afterAll } from '@jest/globals';
import { createMcpTestHarness } from '../../helpers/mcp-harness.js';
import { expectPatentSearchResult, expectPatentGetResult } from '../../helpers/assertions.js';
import { retryOnRateLimit } from '../../helpers/retry.js';
import { ppubsClient, opsClient } from '../../../entities/patent/index.js';

let harness: Awaited<ReturnType<typeof createMcpTestHarness>>;

// Per-test caps: 60 s everywhere. The in-process MCP client caps each request
// at 60 s, so larger jest timeouts only ever benefit the retryOnRateLimit
// wrapper — measured p95 of passing searches is far below this on CI.
// Tests not targeting seminal mining pass `seminal: false` so they skip the
// expensive citation-graph mining pass; the seminal contract is covered by
// the dedicated Szostak test below.

beforeAll(async () => {
  harness = await createMcpTestHarness();
}, 30000);

afterAll(async () => {
  await harness.close();
  ppubsClient.close();
  opsClient.close();
});

describe('patent_search', () => {
  it('returns patents from auto-selected backends; limit=5 → EXACTLY 5 items, no marker keys (#86)', async () => {
    const response = await retryOnRateLimit(() => harness.callTool('patent_search', { query: 'crispr cas9', limit: 5, seminal: false }));
    expectPatentSearchResult(response);
    // Core #86 invariant: the results array contains only real patent
    // records and respects limit exactly — failures/notes ride in
    // warnings/errors, never as extra items.
    expect(response.patents).toHaveLength(5);
    for (const p of response.patents as Array<Record<string, unknown>>) {
      expect(p).not.toHaveProperty('_note');
      expect(p).not.toHaveProperty('_error');
      expect(p).not.toHaveProperty('_hint');
    }
  }, 60000);

  it('returns US results via keyless ppubs source', async () => {
    const response = await retryOnRateLimit(() =>
      harness.callTool('patent_search', { query: 'crispr', source: 'ppubs', limit: 3, seminal: false }));
    expectPatentSearchResult(response);
    expect(response.patents.length).toBeGreaterThan(0);
    expect(response.patents[0].source).toBe('ppubs');
    expect(String(response.patents[0].publication_number)).toMatch(/^US/);
  }, 60000);

  it('applies assignee filter (stable identity: Moderna crispr filings exist)', async () => {
    const response = await retryOnRateLimit(() =>
      harness.callTool('patent_search', { query: 'crispr', assignee: 'Moderna', source: 'ppubs', limit: 5, seminal: false }));
    expectPatentSearchResult(response);
    expect(response.patents.length).toBeGreaterThan(0);
  }, 60000);

  it('respects limit parameter', async () => {
    const response = await retryOnRateLimit(() =>
      harness.callTool('patent_search', { query: 'cancer immunotherapy', source: 'ppubs', limit: 2, seminal: false }));
    expectPatentSearchResult(response);
    expect(response.patents.length).toBeLessThanOrEqual(2);
    expect((response as any).seminal_prior_art).toBeUndefined();
  }, 60000);

  it('ranks a quoted biotech concept by relevance on ppubs (mRNA display)', async () => {
    const response = await retryOnRateLimit(() =>
      harness.callTool('patent_search', { query: '"mRNA display"', source: 'ppubs', limit: 5, seminal: false }));
    expectPatentSearchResult(response);
    const real = response.patents;
    expect(real.length).toBeGreaterThan(0);
    // On-topic hit in the top 5: the mRNA display technique concerns
    // selecting binding proteins/peptides from mRNA libraries (tolerant matcher).
    const titles = real.map((p: Record<string, unknown>) => String(p.title || '')).join(' | ');
    expect(titles).toMatch(/binding prot|mrna display|aptamer|display librar|sequence/i);
    // Relevance mode surfaces scores and a family-based match count
    expect(real.some((p: Record<string, unknown>) => typeof p.relevance_score === 'number')).toBe(true);
    expect(response.total_hits?.ppubs).toBeDefined();
    expect((response as any).total_hits_basis?.ppubs).toContain('families');
  }, 60000);

  it('falls back to recency sort when sort_by=recency', async () => {
    const response = await retryOnRateLimit(() =>
      harness.callTool('patent_search', { query: 'crispr cas9', source: 'ppubs', sort_by: 'recency', limit: 3, seminal: false }));
    expectPatentSearchResult(response);
    const dates = response.patents
      .map((p: Record<string, unknown>) => String(p.publication_date || ''));
    expect(dates.length).toBeGreaterThan(0);
    const sorted = [...dates].sort().reverse();
    expect(dates).toEqual(sorted);
  }, 60000);

  it('discovers seminal prior art for a vocabulary-mismatched concept (mRNA display → Szostak)', async () => {
    const response = await retryOnRateLimit(() =>
      harness.callTool('patent_search', { query: '"mRNA display"', limit: 5 }));
    expectPatentSearchResult(response);
    // Default-on: seminal fields present whenever real results exist.
    expect(Array.isArray((response as any).seminal_prior_art)).toBe(true);
    expect(typeof (response as any).mined_count).toBe('number');
    if (((response as any).mined_count as number) >= 3) {
      // The foundational Szostak art is co-cited across assignees by the
      // diversity-sampled top grants — resolved to a US family member
      // (US6261804B1/US6207446B1, "Selection of proteins using RNA-protein
      // fusions", General Hospital Corp) with OPS creds, or its PCT form
      // WO98/31700 keylessly. Tolerant matcher guards against live drift.
      const seminal = ((response as any).seminal_prior_art as Array<Record<string, unknown>>)
        .map(e => `${e.publication_number} ${e.title || ''} ${e.assignee || ''}`).join(' | ');
      expect(seminal).toMatch(/6261804|6207446|31700|RNA-protein fusions/i);
      const szostak = ((response as any).seminal_prior_art as Array<Record<string, unknown>>)
        .find(e => /6261804|6207446|31700/i.test(String(e.publication_number)));
      expect(Number(szostak?.co_cited_by)).toBeGreaterThanOrEqual(2);
      expect(Array.isArray(szostak?.cited_by)).toBe(true);
    } else {
      // A thin pool must still be EXPLAINED, never silently empty.
      expect(String((response as any).seminal_note)).toMatch(/too few|no commonly-cited|skipped|deadline/);
    }
  }, 60000);
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
    const classifications = (result.sections as any)?.classifications as Record<string, unknown> | undefined;
    expect(classifications).toBeDefined();
    expect((classifications as any)?.error).toBeUndefined();
    expect(((classifications as any)?.cpc as unknown[])?.length).toBeGreaterThan(0);
    const claims = (result.sections as any)?.claims as Record<string, unknown> | undefined;
    expect(claims).toBeDefined();
    if (!(claims as any)?.error) {
      expect(Array.isArray((claims as any).claims)).toBe(true);
      expect((claims as any).claims.length).toBeGreaterThan(0);
    }
    const citations = (result.sections as any)?.citations as Record<string, unknown> | undefined;
    if (citations && !Array.isArray(citations)) {
      if (!(citations as any).error) {
        expect(Array.isArray((citations as any).backward)).toBe(true);
      }
    }
  }, 60000);

  it('rejects invalid patent ids', async () => {
    await expect(harness.callTool('patent_get', { patent_id: 'not-a-patent' }))
      .rejects.toThrow(/Invalid patent number/i);
  }, 15000);
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
    }, 60000);

    it('fetches worldwide (non-US) patent core', async () => {
      const result = await retryOnRateLimit(() =>
        harness.callTool('patent_get', { patent_id: 'EP1000000A1' }));
      expectPatentGetResult(result);
      expect(String(result.publication_number)).toMatch(/^EP/);
      expect(result.title).toBeTruthy();
    }, 60000);

    it('fetches claims for an EP patent (OPS fulltext authority)', async () => {
      const result = await retryOnRateLimit(() =>
        harness.callTool('patent_get', { patent_id: 'EP1000000A1', sections: ['claims'], limit: 3 }));
      expectPatentGetResult(result);
      const claims = (result.sections as any)?.claims as Record<string, unknown> | undefined;
      expect(claims).toBeDefined();
      expect((claims as any)?.error).toBeUndefined();
      expect(Array.isArray((claims as any)?.claims)).toBe(true);
    }, 60000);
});

odpDescribe('patent_get (USPTO ODP, keyed)', () => {
  it('resolves a granted US patent via ODP', async () => {
    const result = await retryOnRateLimit(() =>
      harness.callTool('patent_get', { patent_id: 'US11027025B2' }));
    expectPatentGetResult(result);
    expect(String(result.publication_number)).toMatch(/^US11027025/);
  }, 60000);
});

describe('patent_search resilience (live)', () => {
  it('placeholder OPS creds: first search reports the failure, subsequent searches back off with a coverage note', async () => {
    const { resetOpsBackoff, opsClient } = await import('../../../entities/patent/ops-client.js');
    const savedKey = process.env.EPO_OPS_CONSUMER_KEY;
    const savedSecret = process.env.EPO_OPS_CONSUMER_SECRET;
    try {
      resetOpsBackoff();
      opsClient.close(); // drop any token cached from earlier tests
      process.env.EPO_OPS_CONSUMER_KEY = 'placeholder-key';
      process.env.EPO_OPS_CONSUMER_SECRET = 'placeholder-secret';
      const first = await retryOnRateLimit(() =>
        harness.callTool('patent_search', { query: 'crispr', limit: 3, seminal: false }));
      // Auth failure surfaces in the envelope errors on the first search…
      expect((first.errors as Array<{ source: string; message: string }> | undefined)
        ?.some(e => e.source === 'ops' && e.message.includes("'ops' failed"))).toBe(true);
      // …and trips the auth-class backoff immediately.
      const second = await retryOnRateLimit(() =>
        harness.callTool('patent_search', { query: 'crispr', limit: 3, seminal: false }));
      // No ops attempt (and hence no repeated ops error) after the trip.
      // If the worldwide substitute is also unavailable, a coverage warning
      // explains the US-only results instead (logic unit-pinned; live GP
      // availability varies, so the note's presence is not asserted here).
      const secondOpsError = (second.errors as Array<{ source: string; message: string }> | undefined)
        ?.some(e => e.source === 'ops' && e.message.includes("'ops' failed"));
      expect(secondOpsError).toBe(false);
      // Still returns real ppubs results regardless of worldwide status.
      expect(second.patents.length).toBeGreaterThan(0);
      for (const p of second.patents as Array<Record<string, unknown>>) {
        expect(p).not.toHaveProperty('_error');
        expect(p).not.toHaveProperty('_note');
        expect(p).not.toHaveProperty('_hint');
      }
    } finally {
      process.env.EPO_OPS_CONSUMER_KEY = savedKey;
      process.env.EPO_OPS_CONSUMER_SECRET = savedSecret;
      resetOpsBackoff();
      opsClient.close();
    }
  }, 60000);
});
