import { describe, it, expect, beforeAll, afterAll } from '@jest/globals';
import { createMcpTestHarness } from '../../helpers/mcp-harness.js';
import { retryOnRateLimit } from '../../helpers/retry.js';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

// Per-test caps: journal_metrics is a single OpenAlex roundtrip (30 s tool
// budget, 15 s registry timeout × retry headroom), and the chain test adds
// one PubMed article_get — 60 s matches the neighboring article suites and
// the in-process MCP client's per-request cap.

let harness: Awaited<ReturnType<typeof createMcpTestHarness>>;
let savedCacheDir: string | undefined;
let cacheRoot: string;

beforeAll(async () => {
  harness = await createMcpTestHarness();
  // In-process harness: keep any cache writes away from the real
  // ~/.cache/biomcp for the whole live suite.
  savedCacheDir = process.env.BIOMCP_CACHE_DIR;
  cacheRoot = mkdtempSync(join(tmpdir(), 'biomcp-jmint-'));
  process.env.BIOMCP_CACHE_DIR = cacheRoot;
}, 30000);

afterAll(async () => {
  await harness.close();
  if (savedCacheDir === undefined) delete process.env.BIOMCP_CACHE_DIR;
  else process.env.BIOMCP_CACHE_DIR = savedCacheDir;
  rmSync(cacheRoot, { recursive: true, force: true });
});

// journal_metrics never throws for upstream failures — they ride in the
// envelope's errors[] channel — so surface them as throws here; the
// retryOnRateLimit wrapper then retries the retryable ones (OpenAlex
// per-second 429s, transient network) and fails honestly on terminal
// errors (e.g. exhausted keyless daily budget).
async function callJournalMetrics(args: Record<string, unknown>) {
  const response = await harness.callTool('journal_metrics', args);
  if (Array.isArray(response.errors) && response.errors.length > 0) {
    throw new Error('openalex upstream error: ' + JSON.stringify(response.errors));
  }
  return response;
}

describe('journal_metrics', () => {
  it('by ISSN resolves the journal exactly', async () => {
    const response = await retryOnRateLimit(() => callJournalMetrics({ query: '0028-0836' }));
    const results = response.results;
    expect(Array.isArray(results)).toBe(true);
    expect(results.length).toBe(1);
    const journal = results[0];
    expect(journal.display_name).toBe('Nature');
    expect(journal.type).toBe('journal');
    expect(journal.issn_l).toBe('0028-0836');
    expect(journal.summary_stats.two_year_mean_citedness).toBeGreaterThan(0);
    expect(journal.listed_in).toContain('medline');
    // counts_by_year: newest first, at most a decade of rows.
    expect(Array.isArray(journal.counts_by_year)).toBe(true);
    expect(journal.counts_by_year.length).toBeLessThanOrEqual(10);
    const years = journal.counts_by_year.map((c: { year: number }) => c.year);
    for (let i = 1; i < years.length; i++) {
      expect(years[i - 1]).toBeGreaterThan(years[i]);
    }
  }, 60000);

  it('by name search returns ranked candidates', async () => {
    const response = await retryOnRateLimit(() => callJournalMetrics({ query: 'methods in molecular biology', limit: 3 }));
    const results = response.results;
    expect(Array.isArray(results)).toBe(true);
    expect(results.length).toBeGreaterThanOrEqual(1);
    const first = results[0];
    expect(first.type).toBe('book series');
    expect(first.display_name).toMatch(/molecular biology/i);
  }, 60000);

  // NLM abbreviation → full-title expansion happens via the bundled
  // dist/assets/journal-titles.tsv.gz asset (built by scripts/build/
  // fetch-journal-list.ts). Without a build the map is empty and this
  // legitimately fails — CI builds before integration.
  it('expands NLM abbreviations via the bundled list', async () => {
    const response = await retryOnRateLimit(() => callJournalMetrics({ query: 'N Engl J Med' }));
    const results = response.results;
    expect(Array.isArray(results)).toBe(true);
    expect(results.length).toBeGreaterThan(0);
    expect(results[0].display_name).toBe('New England Journal of Medicine');
    expect(results[0].summary_stats.two_year_mean_citedness).toBeGreaterThan(5);
    // The expansion disclosure warning depends on the built asset being
    // present (absent asset = feature silently disabled) — shape-check it
    // when present, but never hard-assert the text.
    if (Array.isArray(response.warnings)) {
      for (const w of response.warnings) {
        expect(typeof w).toBe('string');
      }
    }
  }, 60000);

  // The article → journal chain: article records carry journal_issn
  // (PubMed ISSNLinking-first), which feeds journal_metrics' exact ISSN
  // mode. NOTE: PMID 21639808 is the Chapman BRIM-3 NEJM paper (N Engl J Med
  // 2011;364:2507-16 — see the golden-case pins in article-tools.test.ts),
  // so the ISSN is NEJM's Linking 0028-4793, not Nature's 0028-0836.
  it('article_get → journal_issn → journal_metrics chain', async () => {
    // A degraded fetch returns an {_error} record instead of throwing, which
    // would bypass retryOnRateLimit — surface it so transient PubMed
    // throttling gets retried rather than failing on a missing journal_issn.
    const fetchArticle = async () => {
      const article = await harness.callTool('article_get', { id: '21639808', sections: ['core'] });
      if (article._error !== undefined) {
        throw new Error(String(article._error));
      }
      return article;
    };
    const article = await retryOnRateLimit(fetchArticle);
    expect(article.journal_issn).toBe('0028-4793');
    const response = await retryOnRateLimit(() => callJournalMetrics({ query: article.journal_issn }));
    const results = response.results;
    expect(results.length).toBe(1);
    expect(results[0].display_name).toBe('New England Journal of Medicine');
  }, 60000);
});
