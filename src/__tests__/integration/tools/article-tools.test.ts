import { describe, it, expect, beforeAll, afterAll } from '@jest/globals';
import { createMcpTestHarness } from '../../helpers/mcp-harness.js';
import { expectArticleSearchResult, expectArticleGetResult, expectArticleOaSection, expectCitationSection } from '../../helpers/assertions.js';
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

describe('article_search preprint_only (bioRxiv + medRxiv)', () => {
  it('returns labeled preprints with abstracts', async () => {
    const results = await retryOnRateLimit(() => harness.callTool('article_search', { query: 'crispr base editing', source: 'preprint_only', limit: 5 }));
    expectArticleSearchResult(results);
    expect(results.length).toBeGreaterThan(0);
    for (const r of results) {
      expect(r.publication_types).toContain('Preprint');
      expect(['bioRxiv', 'medRxiv']).toContain(r.journal);
      expect(r.abstract).toBeTruthy();
      expect(r.source).toBe('preprint_only');
    }
  }, 60000);

  it('applies dateRange filtering', async () => {
    const results = await retryOnRateLimit(() => harness.callTool('article_search', { query: 'crispr', source: 'preprint_only', limit: 5, dateRange: '2020-01-01/2021-12-31' }));
    expectArticleSearchResult(results);
    for (const r of results) {
      const year = String(r.publication_date ?? '').slice(0, 4);
      expect(['2020', '2021']).toContain(year);
    }
  }, 60000);
});

describe('article_search arxiv source', () => {
  it('returns arXiv results for CRISPR base editing', async () => {
    const results = await retryOnRateLimit(() => harness.callTool('article_search', { query: 'CRISPR base editing', source: 'arxiv', limit: 5 }));
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
    const results = await retryOnRateLimit(() => harness.callTool('article_search', { query: 'transformer', source: 'arxiv', limit: 3, dateRange: '2024-01-01/2024-12-31' }));
    expectArticleSearchResult(results);
    expect(results.length).toBeGreaterThan(0);
    expect(
      results.some((r) => typeof r.publication_date === 'string' && r.publication_date.startsWith('2024'))
    ).toBe(true);
  }, 60000);

  it('returns empty for nonsensical arXiv query', async () => {
    const results = await retryOnRateLimit(() => harness.callTool('article_search', { query: 'zzqqxxzz nothingmatches', source: 'arxiv' }));
    expectArticleSearchResult(results);
    expect(results.length).toBe(0);
    expect(results.some((r) => r._error !== undefined)).toBe(false);
  }, 60000);

  // Federated regression: arXiv normally contributes rows, but its leg is
  // capped by the 20 s federated timeout and error rows are dropped by
  // dedup — so absence is only acceptable when the other sources still
  // delivered results (documented-acceptable absence).
  it('includes arXiv results in federated search when the leg completes', async () => {
    const results = await retryOnRateLimit(() => harness.callTool('article_search', { query: 'CRISPR base editing', limit: 20 }));
    expectArticleSearchResult(results);
    expect(results.length).toBeGreaterThan(0);
    expect(results.some((r) => r.source !== 'arxiv')).toBe(true);
    const arxivRows = results.filter((r) => r.source === 'arxiv');
    if (arxivRows.length > 0) {
      expect(arxivRows[0].arxiv_id).toBeTruthy();
    } else {
      console.warn('[article-search-arxiv] federated run had no arXiv rows (legitimate timeout/absence); other sources delivered');
    }
  }, 90000);
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
    expect(Array.isArray(result.preprint?.versions)).toBe(true);
    expect(result.preprint?.versions.length).toBeGreaterThan(0);
    expect(result.license).toBeTruthy();
    expect(result.published?.doi || result.published?.pmid).toBeTruthy();
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
  }, 90000);
});

describe('article_get sections', () => {
  // PMID 34265844 = AlphaFold (CC-BY, guaranteed OA). The pmc_oa leg is
  // unreachable from some networks (datacenter-IP 404s); the europepmc
  // fallback must still deliver license metadata either way.
  it('oa section returns license/PDF metadata without error', async () => {
    const result = await retryOnRateLimit(() => harness.callTool('article_get', { id: '34265844', sections: ['oa'] }));
    expectArticleOaSection(result);
  }, 90000);

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
  }, 120000);
});
