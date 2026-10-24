import { describe, it, expect, beforeAll, afterAll } from '@jest/globals';
import { createMcpTestHarness } from '../../helpers/mcp-harness.js';
import { retryOnRateLimit } from '../../helpers/retry.js';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { gzipSync } from 'node:zlib';
import { resetJournalTitleMap } from '../../../entities/article/search/journal-titles.js';

// Per-test caps: journal_metrics is a single OpenAlex roundtrip (30 s tool
// budget, 15 s registry timeout × retry headroom), and the chain test adds
// one PubMed article_get — 60 s matches the neighboring article suites and
// the in-process MCP client's per-request cap.

let harness: Awaited<ReturnType<typeof createMcpTestHarness>>;
let savedCacheDir: string | undefined;
let cacheRoot: string;
let savedTitlesPath: string | undefined;
let titlesDir: string;

beforeAll(async () => {
  harness = await createMcpTestHarness();
  // In-process harness: keep any cache writes away from the real
  // ~/.cache/biomcp for the whole live suite.
  savedCacheDir = process.env.BIOMCP_CACHE_DIR;
  cacheRoot = mkdtempSync(join(tmpdir(), 'biomcp-jmint-'));
  process.env.BIOMCP_CACHE_DIR = cacheRoot;

  // The abbreviation-expansion test below must own its NLM fixture: the CI
  // integration job installs and runs jest only (ci.yml has no build step
  // there), so the bundled dist/assets/journal-titles.tsv.gz is absent and
  // the loader silently disables expansion (empty map, no warning) — OpenAlex
  // returns 0 hits for the raw abbreviation. The env override has absolute
  // precedence and a set-but-missing path disables the feature, so the local
  // dist asset can never leak in either. This MUST run before any test, not
  // inside the expansion test itself: the abbreviation map is a lazy
  // per-process singleton and this jest harness runs in-process in file
  // order — the 'methods in molecular biology' search would otherwise warm
  // the map empty first.
  savedTitlesPath = process.env.BIOMCP_JOURNAL_TITLES_PATH;
  titlesDir = mkdtempSync(join(tmpdir(), 'biomcp-jtitles-'));
  const titlesFixture = join(titlesDir, 'journal-titles.tsv.gz');
  writeFileSync(
    titlesFixture,
    gzipSync(
      Buffer.from('new england journal of medicine\tN Engl J Med\nnature\tNature\n', 'utf8'),
    ),
  );
  process.env.BIOMCP_JOURNAL_TITLES_PATH = titlesFixture;
  resetJournalTitleMap();
}, 30000);

afterAll(async () => {
  await harness.close();
  if (savedCacheDir === undefined) delete process.env.BIOMCP_CACHE_DIR;
  else process.env.BIOMCP_CACHE_DIR = savedCacheDir;
  rmSync(cacheRoot, { recursive: true, force: true });
  if (savedTitlesPath === undefined) delete process.env.BIOMCP_JOURNAL_TITLES_PATH;
  else process.env.BIOMCP_JOURNAL_TITLES_PATH = savedTitlesPath;
  resetJournalTitleMap();
  rmSync(titlesDir, { recursive: true, force: true });
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

  // NLM abbreviation → full-title expansion happens via the journal-titles
  // asset (built into dist/assets/ by scripts/build/fetch-journal-list.ts).
  // The CI integration job installs and runs jest only — no build step — so
  // the file-level beforeAll points BIOMCP_JOURNAL_TITLES_PATH at this
  // suite's own two-entry fixture rather than assuming the bundled asset.
  it('expands NLM abbreviations via the bundled list', async () => {
    const response = await retryOnRateLimit(() => callJournalMetrics({ query: 'N Engl J Med' }));
    const results = response.results;
    expect(Array.isArray(results)).toBe(true);
    expect(results.length).toBeGreaterThan(0);
    expect(results[0].display_name).toBe('New England Journal of Medicine');
    expect(results[0].summary_stats.two_year_mean_citedness).toBeGreaterThan(5);
    // Expansion is deterministic under the fixture, so the disclosure
    // warning is now asserted exactly. The map stores the NORMALIZED title
    // key, so the expanded search term is lowercase — matching the warning
    // construction in src/entities/journal/openalex.ts.
    expect(response.warnings).toContain(
      "Journal abbreviation expanded: 'N Engl J Med' → 'new england journal of medicine' (NLM).",
    );
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
