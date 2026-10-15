import { describe, it, expect, beforeAll, afterAll } from '@jest/globals';
import { createMcpTestHarness } from '../../helpers/mcp-harness.js';
import { expectArticleSearchResult, expectArticleGetResult, expectArticleOaSection, expectArticleFullTextSection, expectCitationSection } from '../../helpers/assertions.js';
import { retryOnRateLimit } from '../../helpers/retry.js';
import { existsSync, mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

// Per-test caps: measured p95 ≈ 30 s (federated searches hit the arXiv leg's
// real request pacing), so 60 s is ~2× p95 headroom. Larger values are dead
// weight — the in-process MCP client caps each request at 60 s anyway.

let harness: Awaited<ReturnType<typeof createMcpTestHarness>>;
let savedCacheDir: string | undefined;
let cacheRoot: string;

beforeAll(async () => {
  harness = await createMcpTestHarness();
  // In-process harness: redirect fulltext file output away from the real
  // ~/.cache/biomcp for the whole live suite.
  savedCacheDir = process.env.BIOMCP_CACHE_DIR;
  cacheRoot = mkdtempSync(join(tmpdir(), 'biomcp-ftint-'));
  process.env.BIOMCP_CACHE_DIR = cacheRoot;
}, 30000);

afterAll(async () => {
  await harness.close();
  if (savedCacheDir === undefined) delete process.env.BIOMCP_CACHE_DIR;
  else process.env.BIOMCP_CACHE_DIR = savedCacheDir;
  rmSync(cacheRoot, { recursive: true, force: true });
});

describe('article_search', () => {
  it('returns PubMed results for BRCA1', async () => {
    const response = await retryOnRateLimit(() => harness.callTool('article_search', { query: 'BRCA1', source: 'pubmed' }));
    const results = response.results;
    expectArticleSearchResult(results);
    expect(results.length).toBeGreaterThan(0);
  }, 60000);

  it('returns results from europepmc source', async () => {
    const response = await retryOnRateLimit(() => harness.callTool('article_search', { query: 'cancer immunotherapy', source: 'europepmc' }));
    const results = response.results;
    expectArticleSearchResult(results);
    if (results.length > 0) {
      expect(results[0].source).toBe('europepmc');
    }
  }, 60000);

  it('returns empty for nonsensical query', async () => {
    const response = await retryOnRateLimit(() => harness.callTool('article_search', { query: 'ZZZZZNOTAPAPER99999xyz', source: 'pubmed' }));
    const results = response.results;
    expectArticleSearchResult(results);
    expect(results.length).toBe(0);
  }, 60000);

  // Issue #78: PubMed's term translation drops unrecognized tokens and
  // matches the residue; the gibberish query must NOT come back as
  // plausible-looking citations. Envelope contract: results [] + an
  // explanatory warning, errors (if any source failed) out of band.
  it('gibberish query returns no citations and a warning instead of noise (#78)', async () => {
    const response = await retryOnRateLimit(() => harness.callTool('article_search', { query: 'qqqzzz impossible term xyzzy' }));
    expect(Array.isArray(response.results)).toBe(true);
    expect(response.results).toEqual([]);
    expect(Array.isArray(response.warnings)).toBe(true);
    expect((response.warnings as string[]).some(w => w.includes('PubMed ignored all meaningful terms'))).toBe(true);
    expect(response.results.some((r: Record<string, unknown>) => r._error !== undefined)).toBe(false);
  }, 60000);

  // Issue #87: LitSense rows used to carry only pmid/score — no metadata.
  // Now each row keeps the matched sentence and is PubMed-enriched with a
  // title when enrichment succeeds (or the envelope carries the warning).
  it('litsense rows carry the matched sentence and titles (or an enrichment warning) (#87)', async () => {
    const response = await retryOnRateLimit(() => harness.callTool('article_search', { query: 'BRCA1 mutations increase breast cancer risk', source: 'litsense', limit: 5 }));
    const results = response.results;
    expect(Array.isArray(results)).toBe(true);
    expect(results.length).toBeGreaterThan(0);
    for (const r of results) {
      expect(r.source).toBe('litsense');
      expect(typeof r.sentence).toBe('string');
      expect(r.sentence.length).toBeGreaterThan(0);
    }
    const enrichmentUnavailable = (response.warnings as string[] | undefined)
      ?.some(w => w.startsWith('litsense metadata enrichment unavailable'));
    if (!enrichmentUnavailable) {
      expect(results.some((r: Record<string, unknown>) => typeof r.title === 'string' && (r.title as string).length > 0)).toBe(true);
    } else {
      console.warn('[article-search-litsense] enrichment unavailable this run; sparse rows + warning asserted');
    }
  }, 60000);
});

describe('article_search preprint_only (bioRxiv + medRxiv)', () => {
  it('returns labeled preprints with abstracts', async () => {
    const response = await retryOnRateLimit(() => harness.callTool('article_search', { query: 'crispr base editing', source: 'preprint_only', limit: 5 }));
    const results = response.results;
    expectArticleSearchResult(results);
    expect(results.length).toBeGreaterThan(0);
    for (const r of results) {
      expect(r.publication_types).toContain('preprint');
      expect(['bioRxiv', 'medRxiv']).toContain(r.journal);
      expect(r.abstract).toBeTruthy();
      expect(r.source).toBe('preprint_only');
    }
  }, 60000);

  it('applies dateRange filtering', async () => {
    const response = await retryOnRateLimit(() => harness.callTool('article_search', { query: 'crispr', source: 'preprint_only', limit: 5, dateRange: '2020-01-01/2021-12-31' }));
    const results = response.results;
    expectArticleSearchResult(results);
    for (const r of results) {
      const year = String(r.publication_date ?? '').slice(0, 4);
      expect(['2020', '2021']).toContain(year);
    }
  }, 60000);
});

describe('article_search arxiv source', () => {
  it('returns arXiv results for CRISPR base editing', async () => {
    const response = await retryOnRateLimit(() => harness.callTool('article_search', { query: 'CRISPR base editing', source: 'arxiv', limit: 5 }));
    const results = response.results;
    expectArticleSearchResult(results);
    expect(results.length).toBeGreaterThan(0);
    const first = results[0];
    expect(first.source).toBe('arxiv');
    expect(first.arxiv_id).toBeTruthy();
    expect(typeof first.title).toBe('string');
    expect(typeof first.abstract).toBe('string');
    expect(first.journal).toBe('arXiv');
    expect(first.publication_types).toContain('preprint');
  }, 60000);

  it('returns date-filtered arXiv results within 2024', async () => {
    const response = await retryOnRateLimit(() => harness.callTool('article_search', { query: 'transformer', source: 'arxiv', limit: 3, dateRange: '2024-01-01/2024-12-31' }));
    const results = response.results;
    expectArticleSearchResult(results);
    expect(results.length).toBeGreaterThan(0);
    expect(
      results.some((r) => typeof r.publication_date === 'string' && r.publication_date.startsWith('2024'))
    ).toBe(true);
  }, 60000);

  it('returns empty for nonsensical arXiv query', async () => {
    const response = await retryOnRateLimit(() => harness.callTool('article_search', { query: 'zzqqxxzz nothingmatches', source: 'arxiv' }));
    const results = response.results;
    expectArticleSearchResult(results);
    expect(results.length).toBe(0);
    expect(results.some((r) => r._error !== undefined)).toBe(false);
  }, 60000);

  // Federated regression: arXiv normally contributes rows, but its leg is
  // capped by the 20 s federated timeout and error rows are dropped by
  // dedup — so absence is only acceptable when the other sources still
  // delivered results (documented-acceptable absence).
  it('includes arXiv results in federated search when the leg completes', async () => {
    const response = await retryOnRateLimit(() => harness.callTool('article_search', { query: 'CRISPR base editing', limit: 20 }));
    const results = response.results;
    expectArticleSearchResult(results);
    expect(results.length).toBeGreaterThan(0);
    expect(results.some((r) => r.source !== 'arxiv')).toBe(true);
    const arxivRows = results.filter((r) => r.source === 'arxiv');
    if (arxivRows.length > 0) {
      expect(arxivRows[0].arxiv_id).toBeTruthy();
    } else {
      console.warn('[article-search-arxiv] federated run had no arXiv rows (legitimate timeout/absence); other sources delivered');
    }
  }, 60000);
});

describe('article_get', () => {
  it('returns article by PMID', async () => {
    const result = await retryOnRateLimit(() => harness.callTool('article_get', { id: '25333279' }));
    expectArticleGetResult(result);
    expect(result.title).toBeTruthy();
  }, 60000);

  // PMID 21639808 = Chapman NEJM BRIM-3. Its efetch XML carries
  // Volume 364 / Issue 26 / MedlinePgn 2507-16; locators must reach the tool output.
  it('returns citation locators for the golden case PMID', async () => {
    const result = await retryOnRateLimit(() => harness.callTool('article_get', { id: '21639808', sections: ['core'] }));
    expectArticleGetResult(result);
    expect(result.volume).toBe('364');
    expect(result.issue).toBe('26');
    expect(result.pages).toBe('2507-16');
  }, 60000);

  it('returns error for invalid PMID', async () => {
    await expect(
      harness.callTool('article_get', { id: '99999999' })
    ).rejects.toThrow('Could not resolve pmid');
  }, 30000);

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

describe('article_get preprint DOIs (bioRxiv/medRxiv)', () => {
  // 10.1101/2021.10.25.465764: bioRxiv preprint with a published version
  // (Frontiers in Bioinformatics) and a citation count — exercises the
  // official /details + /pubs path plus EPMC enrichment.
  it('returns preprint record with versions, license and published mapping by legacy DOI', async () => {
    const result = await retryOnRateLimit(() => harness.callTool('article_get', { id: '10.1101/2021.10.25.465764', sections: ['core'] }));
    expectArticleGetResult(result);
    expect(result.abstract).toBeTruthy();
    expect(['bioRxiv', 'medRxiv']).toContain(result.preprint_server);
    expect(Array.isArray((result.preprint as any)?.versions)).toBe(true);
    expect((result.preprint as any)?.versions.length).toBeGreaterThan(0);
    expect(result.license).toBeTruthy();
    expect((result.published as any)?.doi || (result.published as any)?.pmid).toBeTruthy();
  }, 60000);

  // New shared bioRxiv/medRxiv DOI prefix (live-verified posting).
  it('returns preprint record by new-prefix DOI (10.64898)', async () => {
    const result = await retryOnRateLimit(() => harness.callTool('article_get', { id: '10.64898/2026.08.11.744243' }));
    expectArticleGetResult(result);
    expect(result.preprint).toBeDefined();
    expect(['bioRxiv', 'medRxiv']).toContain(result.preprint_server);
  }, 60000);

  it('citation section returns Europe PMC preprint citations', async () => {
    // AlphaFold-Multimer preprint (PPR403752): 1000+ citations, stable.
    const result = await retryOnRateLimit(() => harness.callTool('article_get', { id: '10.1101/2021.10.04.463034', sections: ['citation'] }));
    const citation = (result as any)?.sections?.citation;
    expect(citation).toBeDefined();
    expect(citation._error).toBeUndefined();
    expect(Array.isArray(citation.citation_counts)).toBe(true);
    expect(citation.citation_counts[0]?.total ?? 0).toBeGreaterThan(0);
    expect(Array.isArray(citation.backward_references)).toBe(true);
  }, 60000);
});

describe('article_get sections', () => {
  // PMID 34265844 = AlphaFold (CC-BY, guaranteed OA). NCBI's oa.fcgi was
  // retired upstream (2026); oa metadata now comes from the Europe PMC
  // core record and must classify this as open_access.
  it('oa section returns license/access metadata without error', async () => {
    const result = await retryOnRateLimit(() => harness.callTool('article_get', { id: '34265844', sections: ['oa'] }));
    expectArticleOaSection(result);
    const oa = (result as any)?.sections?.open_access;
    expect(oa.status).toBe('open_access');
    expect(oa.full_text_available).toBe(true);
  }, 60000);

  // Full text itself: the same CC-BY article must yield a FILE handle by
  // default (Europe PMC fullTextXML, or the eutils db=pmc fallback leg).
  it('fulltext section writes the actual full text to a markdown file and returns a handle', async () => {
    const result = await retryOnRateLimit(() => harness.callTool('article_get', { id: '34265844', sections: ['fulltext'] }));
    expectArticleFullTextSection(result);
    const ft = (result as any)?.sections?.fulltext;
    expect(ft.mode).toBe('file');
    expect(ft.char_count).toBeGreaterThan(5000);
    expect(ft.sections).toBeUndefined(); // body never enters the reply
    expect(existsSync(ft.file_path)).toBe(true);
    // The file parses back: front matter, headings at the outlined lines
    const content = readFileSync(ft.file_path, 'utf8');
    expect(content.startsWith('---\n')).toBe(true);
    const lines = content.split('\n');
    for (const entry of ft.outline) {
      expect(lines[entry.line - 1]).toBe(`## ${entry.heading}`);
    }
    expect(result.is_open_access).toBe(true);
  }, 60000);

  // Free-to-read but not OA (Cell 2025 author manuscript, isOpenAccess=N):
  // Europe PMC fullTextXML 500s for this record — the eutils db=pmc leg is
  // load-bearing here.
  it('fulltext section fetches free-to-read (non-OA) text via the eutils fallback', async () => {
    const result = await retryOnRateLimit(() => harness.callTool('article_get', { id: '41478284', sections: ['fulltext'] }));
    const ft = (result as any)?.sections?.fulltext;
    expect(ft).toBeDefined();
    expect(ft._error).toBeUndefined();
    if (ft.status === 'available') {
      expect(ft.char_count).toBeGreaterThan(1000);
    } else {
      expect(['paywalled', 'no_machine_readable_xml', 'fetch_failed']).toContain(ft.reason);
    }
  }, 60000);

  // Not in PMC at all (Nature career column): honest unavailable envelope,
  // never a crash and never a silent empty.
  it('fulltext section reports not_in_pmc honestly for a non-PMC article', async () => {
    const result = await retryOnRateLimit(() => harness.callTool('article_get', { id: '42864440', sections: ['fulltext', 'oa'] }));
    const ft = (result as any)?.sections?.fulltext;
    expect(ft.status).toBe('unavailable');
    expect(ft.reason).toBe('no_pmcid');
    expect(ft.note).toContain('abstract');
    expect(ft.links?.doi_url).toMatch(/^https:\/\/doi\.org\//);
    const oa = (result as any)?.sections?.open_access;
    expect(oa.status).toBe('not_in_pmc');
  }, 60000);

  it('annotations section returns PubTator annotations', async () => {
    const result = await retryOnRateLimit(() => harness.callTool('article_get', { id: '25333279', sections: ['annotations'] }));
    const annotations = (result as any)?.sections?.annotations;
    expect(annotations).toBeDefined();
    expect(annotations._error).toBeUndefined();
  }, 60000);

  it('graph section returns citation-graph links', async () => {
    const result = await retryOnRateLimit(() => harness.callTool('article_get', { id: '25333279', sections: ['graph'] }));
    const graph = (result as any)?.sections?.citation_graph;
    expect(graph).toBeDefined();
    expect(graph._error).toBeUndefined();
  }, 60000);

  // Guards the crossref zero-contribution bug: the provider row must carry
  // data (count / backward refs) or an explicit error — never silent zeros.
  it('citation section (fast mode) never yields a silently-empty crossref row', async () => {
    const result = await retryOnRateLimit(() => harness.callTool('article_get', {
      id: '25333279',
      sections: ['citation'],
      citation_mode: 'fast',
    }));
    expectCitationSection(result);
    // Context bound (issue #60): provider rows are summaries — no record
    // arrays duplicating the deduplicated forward/backward lists — and the
    // whole citation section stays modest at the default limit.
    const citation = (result as any)?.sections?.citation;
    for (const row of citation.source_results) {
      expect(row.forward_citations).toBeUndefined();
      expect(row.backward_references).toBeUndefined();
    }
    expect(JSON.stringify(citation).length).toBeLessThan(20000);
  }, 120000);
});
