import { jest } from '@jest/globals';
import { searchArticles, articleSearch, articleGet, transformPubTator, transformLitSense, transformEuropePMC, transformSemanticScholar, transformPreprint, parseDateRange, parseArticleId, isPreprintDoi } from '../../entities/article/index.js';
import { clearCitationCache } from '../../entities/article/citation/index.js';
import { clearWorkCache } from '../../entities/article/citation/crossref.js';
import { clearCitedInCache } from '../../entities/article/citation/pubmed.js';
import { fetchOpenAccess, licenseToUrl } from '../../entities/article/detail/open-access.js';
import type { OpenAccessResult } from '../../entities/article/detail/open-access.js';
import { fetchFullText, parseFullTextJats, FULLTEXT_DEFAULT_MAX_CHARS } from '../../entities/article/detail/fulltext.js';
import { writeFullTextFile } from '../../entities/article/detail/fulltext-store.js';
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync, readdirSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { gzipSync } from 'node:zlib';
import { resetJournalTitleMap } from '../../entities/article/search/journal-titles.js';
import { getPreprintArticle } from '../../entities/article/detail/preprint.js';
import { applyLimit } from '../../server/tools/utils.js';
import { connectionManager } from '../../connections/manager.js';
import { parseMockUrl } from '../helpers/mock-url.js';
import { mockGlobalFetch } from '../helpers/mock-fetch.js';

// Fake-timer helpers (patent.test.ts convention, see src/__tests__/README.md):
// limiters only refill when the clock moves forward, so any fake-timer
// install must start later than real time AND later than the fake time any
// earlier install reached.
const REAL_TIME_AT_LOAD = Date.now();
let fakeTimersInstalled = 0;

function installFakeTimers(): void {
  fakeTimersInstalled++;
  jest.useFakeTimers({ now: REAL_TIME_AT_LOAD + fakeTimersInstalled * 3_600_000 });
}

// Await a promise that internally sleeps on module timers (token-bucket rate
// limiters, retry backoffs) under fake timers, stepping the clock until the
// promise settles. Same pattern as patent.test.ts / citation.test.ts.
async function advanceUntilSettled<T>(p: Promise<T>): Promise<T> {
  let settled = false;
  let value: T | undefined;
  let failure: { error: unknown } | undefined;
  p.then(
    v => { value = v; settled = true; },
    e => { failure = { error: e }; settled = true; },
  );
  while (!settled) {
    await jest.advanceTimersByTimeAsync(250);
  }
  if (failure) throw failure.error;
  return value as T;
}

const SINGLE_ARTICLE_XML = `<?xml version="1.0"?>
<PubmedArticleSet>
<PubmedArticle>
<MedlineCitation Status="MEDLINE" Owner="NLM">
<PMID Version="1">12345</PMID>
<Article PubModel="Electronic">
<Journal>
<Title>Scientific reports</Title>
<ISOAbbreviation>Sci Rep</ISOAbbreviation>
<JournalIssue><Volume>8</Volume><Issue>1</Issue>
<PubDate><Year>2018</Year><Month>Sep</Month><Day>21</Day></PubDate>
</JournalIssue>
</Journal>
<ArticleTitle>Test article about BRCA1</ArticleTitle>
<Abstract><AbstractText>Full abstract text for testing purposes.</AbstractText></Abstract>
<AuthorList>
<Author><LastName>Smith</LastName><ForeName>John</ForeName><Initials>J</Initials></Author>
<Author><LastName>Doe</LastName><ForeName>Jane</ForeName><Initials>J</Initials></Author>
</AuthorList>
<PublicationTypeList>
<PublicationType>Journal Article</PublicationType>
</PublicationTypeList>
</Article>
<MeshHeadingList>
<MeshHeading><DescriptorName>BRCA1 Protein</DescriptorName></MeshHeading>
<MeshHeading><DescriptorName>Humans</DescriptorName></MeshHeading>
</MeshHeadingList>
</MedlineCitation>
<PubmedData>
<ArticleIdList>
<ArticleId IdType="pubmed">12345</ArticleId>
<ArticleId IdType="doi">10.1234/test.2018</ArticleId>
<ArticleId IdType="pmc">PMC9999999</ArticleId>
</ArticleIdList>
</PubmedData>
</PubmedArticle>
</PubmedArticleSet>`;

const MINIMAL_ARTICLE_XML_NO_PMC = `<?xml version="1.0"?>
<PubmedArticleSet>
<PubmedArticle>
<MedlineCitation Status="MEDLINE" Owner="NLM">
<PMID Version="1">12345</PMID>
<Article PubModel="Electronic">
<Journal><Title>Nature</Title><ISOAbbreviation>Nature</ISOAbbreviation></Journal>
<ArticleTitle>Test</ArticleTitle>
</Article>
</MedlineCitation>
<PubmedData>
<ArticleIdList>
<ArticleId IdType="pubmed">12345</ArticleId>
<ArticleId IdType="doi">10.1234/test.2018</ArticleId>
</ArticleIdList>
</PubmedData>
</PubmedArticle>
</PubmedArticleSet>`;

// PubmedArticleSet fixture whose rows carry caller-chosen PubDate shapes
// (Year/Month/Day combos, MedlineDate strings, or no date at all) — for the
// client-side dateRange post-filter tests (issue #120: displayed dates are
// print/issue dates, which the epub-based pdat esearch window misses).
// PMIDs are assigned in order starting at 40000001 so esearch idlists
// can line up with the fixture rows.
const pubmedDatedArticleXml = (
  rows: Array<{ year?: string; month?: string; day?: string; medlineDate?: string }>
): string => `<?xml version="1.0"?>
<PubmedArticleSet>
${rows.map((row, i) => {
  const pubDate = row.medlineDate !== undefined
    ? `<PubDate><MedlineDate>${row.medlineDate}</MedlineDate></PubDate>`
    : `<PubDate>${row.year ? `<Year>${row.year}</Year>` : ''}${row.month ? `<Month>${row.month}</Month>` : ''}${row.day ? `<Day>${row.day}</Day>` : ''}</PubDate>`;
  return `<PubmedArticle>
<MedlineCitation Status="MEDLINE" Owner="NLM">
<PMID Version="1">${40000001 + i}</PMID>
<Article PubModel="Print">
<Journal><Title>Nature</Title><ISOAbbreviation>Nature</ISOAbbreviation>
<JournalIssue><Volume>1</Volume><Issue>1</Issue>${pubDate}</JournalIssue>
</Journal>
<ArticleTitle>Dated article ${i}</ArticleTitle>
</Article>
</MedlineCitation>
</PubmedArticle>`;
}).join('\n')}
</PubmedArticleSet>`;

const pubmedDatedPmids = (n: number): string[] =>
  Array.from({ length: n }, (_, i) => String(40000001 + i));

// Europe PMC core-record payload, live-verified shape: the link list lives
// at fullTextUrlList.fullTextUrl (NOT fullTextUrlList.fullTextUrlList) and
// availability is one of 'Open access' | 'Free' | 'Subscription required'.
const epmcCoreRecord = (overrides: Record<string, unknown> = {}) => ({
  pmcid: 'PMC9999999',
  doi: '10.1234/test.2018',
  isOpenAccess: 'Y',
  inPMC: 'Y',
  inEPMC: 'Y',
  license: 'cc by',
  fullTextUrlList: {
    fullTextUrl: [
      { availability: 'Open access', availabilityCode: 'OA', documentStyle: 'pdf', site: 'Unpaywall', url: 'https://example.com/paper.pdf' },
      { availability: 'Subscription required', availabilityCode: 'S', documentStyle: 'doi', site: 'DOI', url: 'https://doi.org/10.1234/test.2018' },
      { availability: 'Open access', availabilityCode: 'OA', documentStyle: 'html', site: 'Europe_PMC', url: 'https://europepmc.org/articles/PMC9999999' },
      { availability: 'Open access', availabilityCode: 'OA', documentStyle: 'pdf', site: 'Europe_PMC', url: 'https://europepmc.org/articles/PMC9999999?pdf=render' },
    ],
  },
  ...overrides,
});

const epmcSearchHit = (record: unknown) => ({ hitCount: 1, resultList: { result: [record] } });

// JATS full-text fixture (Europe PMC bare <article> form). The introduction
// paragraph is deliberately long so truncation tests can exercise the cap.
const LONG_INTRO = 'Diphtheria toxin inserts its T domain into endosomal membranes under acidic conditions. '.repeat(12);
const JATS_FULLTEXT_XML = `<?xml version="1.0"?>
<article article-type="research-article">
<body>
<sec><title>Introduction</title><p>${LONG_INTRO}Concentrations of H<sup>+</sup> up to 4 <italic>&#956;</italic>M were tested.</p></sec>
<sec><title>Results</title>
<p>First result paragraph.</p>
<sec><title>Mutation effects</title><p>Nested section text.</p></sec>
<fig><label>Figure 1</label><caption><p>Cartoon of the T domain.</p></caption></fig>
</sec>
</body>
<back>
<sec><title>Acknowledgments</title><p>We thank the funders.</p></sec>
<ref-list><ref><label>1</label></ref></ref-list>
</back>
</article>`;

const PMC_ARTICLESET_XML = `<?xml version="1.0"?>
<pmc-articleset>${JATS_FULLTEXT_XML}</pmc-articleset>`;

const OA_OPEN: OpenAccessResult = {
  pmcid: 'PMC9999999',
  status: 'open_access',
  full_text_available: true,
  is_open_access: true,
  license: 'cc by',
  note: 'test fixture',
  source: 'europepmc',
};

const europepmcLitePage = (n: number) => ({
  resultList: {
    result: Array.from({ length: n }, (_, i) => ({
      pmid: String(41721000 + i),
      title: `Article ${i}`,
      authorString: 'Smith J',
      journalTitle: 'Nature',
      firstPublicationDate: '2026-01-01',
      citedByCount: i,
      isOpenAccess: 'N',
    })),
  },
});

describe('article', () => {
  mockGlobalFetch();

  beforeEach(() => {
    jest.clearAllMocks();
    connectionManager.closeAll();
    process.env.NCBI_API_KEY = '';
    // Pin the journal-titles asset to a nonexistent sentinel so unit tests
    // are deterministic even when a real dist/assets asset exists (a prior
    // local `npm run build`): the rewrite tests below override this with
    // their own fixture; every other search keeps today's no-rewrite URLs.
    process.env.BIOMCP_JOURNAL_TITLES_PATH = '/nonexistent/biomcp-journal-titles-unit-tests.tsv.gz';
  });

  afterEach(() => {
    delete process.env.NCBI_API_KEY;
    delete process.env.BIOMCP_JOURNAL_TITLES_PATH;
    resetJournalTitleMap();
    clearCitationCache();
    clearWorkCache();
    clearCitedInCache();
  });

  test('articleSearch() calls ESearch then EFetch for PubMed', async () => {
    global.fetch = jest.fn<(...args: any[]) => any>()
      .mockResolvedValueOnce({
        ok: true,
        headers: new Headers({ 'content-type': 'application/json' }),
        json: () => Promise.resolve({ esearchresult: { idlist: ['12345'], count: '1' } }),
      })
      .mockResolvedValueOnce({
        ok: true,
        headers: new Headers({ 'content-type': 'text/xml' }),
        text: () => Promise.resolve(SINGLE_ARTICLE_XML),
      }) as any;

    const result = await articleSearch('brca1', { source: 'pubmed' });

    expect(global.fetch).toHaveBeenCalledTimes(2);
    const searchCallUrl = (global.fetch as any).mock.calls[0][0] as string;
    expect(searchCallUrl).toContain('esearch.fcgi');
    expect(searchCallUrl).toContain('term=brca1');
    // #134: esearch must request relevance ordering, not PubMed's
    // recency-default pool.
    expect(searchCallUrl).toContain('sort=relevance');

    const fetchCallUrl = (global.fetch as any).mock.calls[1][0] as string;
    expect(fetchCallUrl).toContain('efetch.fcgi');

    expect(result).toHaveLength(1);
    expect(result[0].pmid).toBe('12345');
    expect(result[0].title).toBe('Test article about BRCA1');
    expect(result[0].abstract).toBe('Full abstract text for testing purposes.');
    expect(result[0].journal).toBe('Sci Rep');
    expect(result[0].authors).toEqual(['Smith John', 'Doe Jane']);
    expect(result[0].doi).toBe('10.1234/test.2018');
    expect(result[0].pmcid).toBe('PMC9999999');
    expect(result[0].mesh_headings).toEqual(['BRCA1 Protein', 'Humans']);
    expect(result[0].publication_types).toEqual(['Journal Article']);
  });

  test('articleSearch() returns empty on empty results', async () => {
    global.fetch = jest.fn<(...args: any[]) => any>().mockResolvedValue({
      ok: true,
      headers: new Headers({ 'content-type': 'application/json' }),
      json: () => Promise.resolve({ esearchresult: { idlist: [] } }),
    }) as any;

    const result = await articleSearch('nonexistent', { source: 'pubmed' });
    expect(result).toEqual([]);
  });

  test('articleGet() calls EFetch with correct PMID', async () => {
    global.fetch = jest.fn<(...args: any[]) => any>().mockResolvedValue({
      ok: true,
      headers: new Headers({ 'content-type': 'text/xml' }),
      text: () => Promise.resolve(SINGLE_ARTICLE_XML),
    }) as any;

    const result = await articleGet('12345');

    expect(global.fetch).toHaveBeenCalled();
    const callUrl = (global.fetch as any).mock.calls[0][0] as string;
    expect(callUrl).toContain('efetch.fcgi');
    expect(callUrl).toContain('id=12345');
    expect(result.pmid).toBe('12345');
    expect(result.title).toBe('Test article about BRCA1');
  });

  test('articleSearch() with pubtator source uses /search/?text= endpoint', async () => {
    global.fetch = jest.fn<(...args: any[]) => any>().mockResolvedValue({
      ok: true,
      headers: new Headers({ 'content-type': 'application/json' }),
      json: () => Promise.resolve({
        results: [
          { _id: '34083286', pmid: 34083286, pmcid: 'PMC999', title: 'BRCA1 article', journal: 'Nature', authors: ['Smith J'], date: '2021-06-01', doi: '10.1234/test', score: 250 },
        ],
      }),
    }) as any;

    const result = await articleSearch('brca1', { source: 'pubtator' });

    const callUrl = (global.fetch as any).mock.calls[0][0] as string;
    expect(callUrl).toContain('/search/?text=');
    expect(callUrl).toContain('brca1');
    expect(callUrl).toContain('page=1');
    expect(callUrl).toContain('size=10');
    expect(result).toHaveLength(1);
    expect(result[0].pmid).toBe('34083286');
    expect(result[0].pmcid).toBe('PMC999');
    expect(result[0].authors).toEqual(['Smith J']);
    expect(result[0].journal).toBe('Nature');
    expect(result[0].doi).toBe('10.1234/test');
    expect(result[0].source).toBe('pubtator');
  });

  test('articleSearch() pubtator paginates server-side for offset windows', async () => {
    const page = Array.from({ length: 15 }, (_, i) => ({
      _id: String(34083286 + i), pmid: 34083286 + i, title: `Article ${i}`,
    }));
    global.fetch = jest.fn<(...args: any[]) => any>().mockResolvedValue({
      ok: true,
      headers: new Headers({ 'content-type': 'application/json' }),
      json: () => Promise.resolve({ results: page }),
    }) as any;

    // Window [10,15): page 1 sized to cover the window, sliced to it.
    const result = await articleSearch('brca1', { source: 'pubtator', limit: 5, offset: 10 });

    const callUrl = (global.fetch as any).mock.calls[0][0] as string;
    expect(callUrl).toContain('page=1');
    expect(callUrl).toContain('size=15');
    expect(result).toHaveLength(5);
    expect(result.map(r => r.pmid)).toEqual(['34083296', '34083297', '34083298', '34083299', '34083300']);
  });

  test('articleSearch() pubtator requests a larger size when limit exceeds the API default', async () => {
    global.fetch = jest.fn<(...args: any[]) => any>().mockResolvedValue({
      ok: true,
      headers: new Headers({ 'content-type': 'application/json' }),
      json: () => Promise.resolve({ results: [] }),
    }) as any;

    await articleSearch('brca1', { source: 'pubtator', limit: 15 });

    const callUrl = (global.fetch as any).mock.calls[0][0] as string;
    expect(callUrl).toContain('size=15');
  });

  test('articleSearch() with litsense source uses /sentences/?query= endpoint', async () => {
    global.fetch = jest.fn<(...args: any[]) => any>().mockResolvedValue({
      ok: true,
      headers: new Headers({ 'content-type': 'application/json' }),
      json: () => Promise.resolve([
        { pmid: 12345, text: 'This is a relevant sentence.', score: 0.95, section: 'abstract', annotations: [] },
      ]),
    }) as any;

    const result = await articleSearch('brca1', { source: 'litsense' });

    const callUrl = (global.fetch as any).mock.calls[0][0] as string;
    expect(callUrl).toContain('/sentences/?query=');
    expect(callUrl).toContain('brca1');
    expect(callUrl).toContain('limit=');
    expect(callUrl).not.toContain('size=');
    expect(result).toHaveLength(1);
    expect(result[0].pmid).toBe('12345');
    expect(result[0].abstract).toBeUndefined();
    expect(result[0].score).toBe(0.95);
    expect(result[0].source).toBe('litsense');
  });

  test('articleSearch() litsense offset windows client-side via over-fetch', async () => {
    const rows = [11, 22, 33, 44, 55].map(pmid => ({
      pmid, text: `Sentence ${pmid}.`, score: 0.9, section: 'abstract', annotations: [],
    }));
    global.fetch = jest.fn<(...args: any[]) => any>().mockResolvedValue({
      ok: true,
      headers: new Headers({ 'content-type': 'application/json' }),
      json: () => Promise.resolve(rows),
    }) as any;

    const result = await articleSearch('brca1', { source: 'litsense', limit: 2, offset: 2 });

    const callUrl = (global.fetch as any).mock.calls[0][0] as string;
    expect(callUrl).toContain('limit=4');
    expect(result).toHaveLength(2);
    expect(result.map((r: any) => r.pmid)).toEqual(['33', '44']);
  });

  test('articleSearch() litsense over-fetch clamps at the 300-row API cap', async () => {
    const rows = Array.from({ length: 300 }, (_, i) => ({
      pmid: i + 1, text: `Sentence ${i}.`, score: 0.9, section: 'abstract', annotations: [],
    }));
    global.fetch = jest.fn<(...args: any[]) => any>().mockResolvedValue({
      ok: true,
      headers: new Headers({ 'content-type': 'application/json' }),
      json: () => Promise.resolve(rows),
    }) as any;

    const result = await articleSearch('brca1', { source: 'litsense', limit: 10, offset: 295 });

    const callUrl = (global.fetch as any).mock.calls[0][0] as string;
    expect(callUrl).toContain('limit=300');
    expect(result).toHaveLength(5);
    expect(result.map((r: any) => r.pmid)).toEqual(['296', '297', '298', '299', '300']);
  });

  test('articleSearch() litsense offset beyond results yields empty page', async () => {
    const rows = [11, 22].map(pmid => ({
      pmid, text: `Sentence ${pmid}.`, score: 0.9, section: 'abstract', annotations: [],
    }));
    global.fetch = jest.fn<(...args: any[]) => any>().mockResolvedValue({
      ok: true,
      headers: new Headers({ 'content-type': 'application/json' }),
      json: () => Promise.resolve(rows),
    }) as any;

    const result = await articleSearch('brca1', { source: 'litsense', limit: 10, offset: 400 });

    const callUrl = (global.fetch as any).mock.calls[0][0] as string;
    expect(callUrl).toContain('limit=300');
    expect(result).toEqual([]);
  });

  test('articleSearch() europepmc offset windows client-side via over-fetch', async () => {
    global.fetch = jest.fn<(...args: any[]) => any>().mockResolvedValue({
      ok: true,
      headers: new Headers({ 'content-type': 'application/json' }),
      json: () => Promise.resolve(europepmcLitePage(4)),
    }) as any;

    const result = await articleSearch('brca1', { source: 'europepmc', limit: 2, offset: 2 });

    const callUrl = (global.fetch as any).mock.calls[0][0] as string;
    expect(callUrl).toContain('pageSize=4');
    expect(callUrl).toContain('cursorMark=*');
    expect(result).toHaveLength(2);
    expect(result.map((r: any) => r.pmid)).toEqual(['41721002', '41721003']);
  });

  test('articleSearch() europepmc over-fetch clamps at the 1000-row API cap', async () => {
    global.fetch = jest.fn<(...args: any[]) => any>().mockResolvedValue({
      ok: true,
      headers: new Headers({ 'content-type': 'application/json' }),
      json: () => Promise.resolve(europepmcLitePage(1000)),
    }) as any;

    const result = await articleSearch('brca1', { source: 'europepmc', limit: 10, offset: 995 });

    const callUrl = (global.fetch as any).mock.calls[0][0] as string;
    expect(callUrl).toContain('pageSize=1000');
    expect(result).toHaveLength(5);
    expect(result.map((r: any) => r.pmid)).toEqual(['41721995', '41721996', '41721997', '41721998', '41721999']);
  });

  test('articleSearch() europepmc offset beyond the cap yields empty page', async () => {
    global.fetch = jest.fn<(...args: any[]) => any>().mockResolvedValue({
      ok: true,
      headers: new Headers({ 'content-type': 'application/json' }),
      json: () => Promise.resolve(europepmcLitePage(1000)),
    }) as any;

    const result = await articleSearch('brca1', { source: 'europepmc', limit: 10, offset: 1000 });

    const callUrl = (global.fetch as any).mock.calls[0][0] as string;
    expect(callUrl).toContain('pageSize=1000');
    expect(result).toEqual([]);
  });

  test('articleSearch() europepmc missing resultList yields empty page', async () => {
    global.fetch = jest.fn<(...args: any[]) => any>().mockResolvedValue({
      ok: true,
      headers: new Headers({ 'content-type': 'application/json' }),
      json: () => Promise.resolve({ hitCount: 0 }),
    }) as any;

    const result = await articleSearch('brca1', { source: 'europepmc', limit: 5 });

    expect(global.fetch).toHaveBeenCalledTimes(1);
    expect(result).toEqual([]);
  });

  test('articleSearch() europepmc explicit cursorMark takes precedence over offset', async () => {
    global.fetch = jest.fn<(...args: any[]) => any>().mockResolvedValue({
      ok: true,
      headers: new Headers({ 'content-type': 'application/json' }),
      json: () => Promise.resolve(europepmcLitePage(5)),
    }) as any;

    const result = await articleSearch('brca1', { source: 'europepmc', limit: 2, offset: 3, cursorMark: 'AoIIQCC9' });

    const callUrl = (global.fetch as any).mock.calls[0][0] as string;
    expect(callUrl).toContain('pageSize=2');
    expect(callUrl).toContain('cursorMark=AoIIQCC9');
    expect(result).toHaveLength(2);
    expect(result.map((r: any) => r.pmid)).toEqual(['41721000', '41721001']);
  });

  test('articleSearch() europepmc offset=0 keeps the page-1 request shape', async () => {
    global.fetch = jest.fn<(...args: any[]) => any>().mockResolvedValue({
      ok: true,
      headers: new Headers({ 'content-type': 'application/json' }),
      json: () => Promise.resolve(europepmcLitePage(10)),
    }) as any;

    const result = await articleSearch('brca1', { source: 'europepmc', limit: 5 });

    const callUrl = (global.fetch as any).mock.calls[0][0] as string;
    expect(callUrl).toContain('pageSize=5');
    expect(callUrl).toContain('cursorMark=*');
    expect(result).toHaveLength(5);
    expect(result.map((r: any) => r.pmid)).toEqual(['41721000', '41721001', '41721002', '41721003', '41721004']);
  });

  test('transformPubTator maps new PubTator3 fields correctly', () => {
    const result = transformPubTator({
      _id: '34083286',
      pmid: 34083286,
      pmcid: 'PMC8577473',
      title: 'Test Title',
      journal: 'Nature',
      authors: ['Author A', 'Author B'],
      date: '2021-06-01T00:00:00Z',
      doi: '10.1234/test',
      score: 250.5,
    });

    expect(result.pmid).toBe('34083286');
    expect(result.pmcid).toBe('PMC8577473');
    expect(result.title).toBe('Test Title');
    expect(result.journal).toBe('Nature');
    expect(result.authors).toEqual(['Author A', 'Author B']);
    expect(result.publication_date).toBe('2021-06-01T00:00:00Z');
    expect(result.doi).toBe('10.1234/test');
    expect(result.score).toBe(250.5);
    expect(result.source).toBe('pubtator');
  });

  test('transformLitSense maps LitSense fields correctly', () => {
    const result = transformLitSense({
      pmid: 12345,
      pmcid: 'PMC999',
      text: 'A sentence about BRCA1.',
      score: 0.88,
      section: 'abstract',
      annotations: ['Gene:BRCA1'],
    });

    expect(result.pmid).toBe('12345');
    expect(result.pmcid).toBe('PMC999');
    expect(result.abstract).toBeUndefined();
    expect(result.score).toBe(0.88);
    expect(result.source).toBe('litsense');
    // the matched sentence is kept on the row (issue #87: no more bare pmid/score)
    expect(result.sentence).toBe('A sentence about BRCA1.');
    expect(result.section).toBe('abstract');
  });

  test('transformEuropePMC maps fields correctly', () => {
    const result = transformEuropePMC({
      pmid: '12345',
      pmcid: 'PMC999',
      doi: '10.1234/test',
      title: 'Europe PMC Article',
      authorString: 'Smith J, Doe A',
      journalTitle: 'Nature',
      journalVolume: '12',
      issue: '3',
      pageInfo: '456-62',
      firstPublicationDate: '2023-01-15',
      citedByCount: 42,
      isOpenAccess: 'Y',
    });

    expect(result.pmid).toBe('12345');
    expect(result.pmcid).toBe('PMC999');
    expect(result.doi).toBe('10.1234/test');
    expect(result.title).toBe('Europe PMC Article');
    expect(result.authors).toEqual(['Smith J', 'Doe A']);
    expect(result.journal).toBe('Nature');
    expect(result.volume).toBe('12');
    expect(result.issue).toBe('3');
    expect(result.pages).toBe('456-62');
    expect(result.cited_by).toBe(42);
    expect(result.is_open_access).toBe(true);
    expect(result.source).toBe('europepmc');
  });

  test('transformEuropePMC normalizes raw and escaped markup in titles', () => {
    const resultRaw = transformEuropePMC({
      pmid: '34731621',
      title: 'Human Ca<sub>V</sub>2.2 and Ca<sup>2+</sup> with P &lt; 0.05 in <i>E. coli</i>',
      authorString: 'Dong Y, Gao Y',
      journalTitle: 'Cell Rep',
    });
    expect(resultRaw.title).toBe('Human Ca(V)2.2 and Ca(2+) with P < 0.05 in E. coli');

    const resultEscaped = transformEuropePMC({
      pmid: '34731622',
      title: '&lt;i&gt;Protoplaythoa variabilis&lt;/i&gt; toxin Ca&lt;sub&gt;V&lt;/sub&gt;2.2 &amp; risk',
      authorString: 'Smith J',
      journalTitle: 'Toxicon',
    });
    expect(resultEscaped.title).toBe('Protoplaythoa variabilis toxin Ca(V)2.2 & risk');

    const resultNested = transformEuropePMC({
      pmid: '34731623',
      title: 'Nested 10<sup>2<sup>3</sup></sup> power &amp; &lt;inf&gt;sub&lt;/inf&gt;',
      authorString: 'Test A',
      journalTitle: 'Math Bio',
    });
    expect(resultNested.title).toBe('Nested 10(2(3)) power & (sub)');

    const resultEmptyTags = transformEuropePMC({
      pmid: '34731624',
      title: '<i><b> </b></i>',
      authorString: 'Test B',
      journalTitle: 'Empty',
    });
    expect(resultEmptyTags.title).toBeUndefined();

    const resultInequalities = transformEuropePMC({
      pmid: '34731625',
      title: 'Effect of Drug X (P < 0.05) vs Placebo (P > 0.01) with <100 nm size',
      authorString: 'Test C',
      journalTitle: 'Lancet',
    });
    expect(resultInequalities.title).toBe('Effect of Drug X (P < 0.05) vs Placebo (P > 0.01) with <100 nm size');

    const resultDoubleEscape = transformEuropePMC({
      pmid: '34731626',
      title: '&amp;lt;script&amp;gt;alert(1)&amp;lt;/script&amp;gt;',
      authorString: 'Test D',
      journalTitle: 'Sec',
    });
    expect(resultDoubleEscape.title).toBe('&lt;script&gt;alert(1)&lt;/script&gt;');

    const resultReassembly = transformEuropePMC({
      pmid: '34731627',
      title: '<<script>script>alert(1)</script>',
      authorString: 'Test E',
      journalTitle: 'Sec2',
    });
    expect(resultReassembly.title).toBe('alert(1)');
  });

  test('transformEuropePMC maps null locator fields to absent', () => {
    const result = transformEuropePMC({
      pmid: '12345',
      title: 'E-location article',
      journalTitle: 'J Cell Mol Med',
      journalVolume: null,
      issue: '16',
      pageInfo: 'e71310',
      firstPublicationDate: '2026-08-01',
      citedByCount: 0,
      isOpenAccess: 'N',
    } as any);

    expect(result.volume).toBeUndefined();
    expect(result.issue).toBe('16');
    expect(result.pages).toBe('e71310');
  });

  test('transformSemanticScholar maps fields correctly', () => {
    const result = transformSemanticScholar({
      title: 'SS Paper',
      abstract: 'Abstract text',
      authors: [{ name: 'Alice' }, { name: 'Bob' }],
      year: 2023,
      venue: 'Science',
      citationCount: 100,
      isOpenAccess: false,
      externalIds: { PMID: '99887', PMCID: 'PMC111', DOI: '10.1/ss' },
    });

    expect(result.pmid).toBe('99887');
    expect(result.pmcid).toBe('PMC111');
    expect(result.doi).toBe('10.1/ss');
    expect(result.title).toBe('SS Paper');
    expect(result.abstract).toBe('Abstract text');
    expect(result.authors).toEqual(['Alice', 'Bob']);
    expect(result.journal).toBe('Science');
    expect(result.cited_by).toBe(100);
    expect(result.is_open_access).toBe(false);
    expect(result.source).toBe('semantic_scholar');
  });

  test('transformSemanticScholar maps ArXiv external id for arXiv-only papers', () => {
    const result = transformSemanticScholar({
      title: 'Attention Is All You Need',
      externalIds: { ArXiv: '1706.03762' },
    });

    expect(result.arxiv_id).toBe('1706.03762');
    expect(result.pmid).toBeUndefined();
    expect(result.pmcid).toBeUndefined();
    expect(result.doi).toBeUndefined();
  });

  test('articleSearch() returns empty for unknown source', async () => {
    const result = await articleSearch('brca1', { source: 'unknown' as any });
    expect(result).toEqual([]);
  });

  describe('dateRange', () => {
    test('parseDateRange parses full range', () => {
      expect(parseDateRange('2020-01-01/2023-12-31')).toEqual({
        from: '2020-01-01',
        to: '2023-12-31',
      });
    });

    test('parseDateRange parses open-ended from', () => {
      expect(parseDateRange('2020-01-01/')).toEqual({
        from: '2020-01-01',
        to: undefined,
      });
    });

    test('parseDateRange parses open-ended to', () => {
      expect(parseDateRange('/2023-12-31')).toEqual({
        from: undefined,
        to: '2023-12-31',
      });
    });

    test('PubMed search appends date params when dateRange is set', async () => {
      global.fetch = jest.fn<(...args: any[]) => any>()
        .mockResolvedValueOnce({
          ok: true,
          headers: new Headers({ 'content-type': 'application/json' }),
          json: () => Promise.resolve({ esearchresult: { idlist: [] } }),
        }) as any;

      await articleSearch('brca1', { source: 'pubmed', dateRange: '2020-01-01/2023-12-31' });

      const searchCallUrl = (global.fetch as any).mock.calls[0][0] as string;
      expect(searchCallUrl).toContain('datetype=pdat');
      expect(searchCallUrl).toContain('mindate=2020/01/01');
      expect(searchCallUrl).toContain('maxdate=2023/12/31');
    });

    test('PubMed search with open-ended from-only dateRange sends both bounds (defaulted maxdate)', async () => {
      global.fetch = jest.fn<(...args: any[]) => any>()
        .mockResolvedValueOnce({
          ok: true,
          headers: new Headers({ 'content-type': 'application/json' }),
          json: () => Promise.resolve({ esearchresult: { idlist: [] } }),
        }) as any;

      await articleSearch('brca1', { source: 'pubmed', dateRange: '2020-01-01/' });

      const searchCallUrl = (global.fetch as any).mock.calls[0][0] as string;
      expect(searchCallUrl).toContain('datetype=pdat');
      expect(searchCallUrl).toContain('mindate=2020/01/01');
      expect(searchCallUrl).toContain('maxdate=3000/12/31');
    });

    test('PubMed search with open-ended to-only dateRange sends both bounds (defaulted mindate)', async () => {
      global.fetch = jest.fn<(...args: any[]) => any>()
        .mockResolvedValueOnce({
          ok: true,
          headers: new Headers({ 'content-type': 'application/json' }),
          json: () => Promise.resolve({ esearchresult: { idlist: [] } }),
        }) as any;

      await articleSearch('brca1', { source: 'pubmed', dateRange: '/2023-12-31' });

      const searchCallUrl = (global.fetch as any).mock.calls[0][0] as string;
      expect(searchCallUrl).toContain('datetype=pdat');
      expect(searchCallUrl).toContain('mindate=1600/01/01');
      expect(searchCallUrl).toContain('maxdate=2023/12/31');
    });

    test('PubMed search overfetches retmax = min(limit*2, 100) when dateRange is set, plain limit otherwise', async () => {
      global.fetch = jest.fn<(...args: any[]) => any>().mockImplementation(() => ({
        ok: true,
        headers: new Headers({ 'content-type': 'application/json' }),
        json: () => Promise.resolve({ esearchresult: { idlist: [] } }),
      })) as any;

      await articleSearch('brca1', { source: 'pubmed', dateRange: '2020-01-01/2020-12-31', limit: 10 });
      await articleSearch('brca1', { source: 'pubmed', dateRange: '2020-01-01/2020-12-31', limit: 60 });
      await articleSearch('brca1', { source: 'pubmed', limit: 10 });

      const urls = (global.fetch as any).mock.calls.map((c: any[]) => String(c[0]));
      expect(urls[0]).toContain('retmax=20');
      expect(urls[1]).toContain('retmax=100');
      expect(urls[2]).toContain('retmax=10');
    });

    test('PubMed dateRange post-filter drops out-of-window displayed dates and warns on a short page', async () => {
      global.fetch = jest.fn<(...args: any[]) => any>()
        .mockResolvedValueOnce({
          ok: true,
          headers: new Headers({ 'content-type': 'application/json' }),
          json: () => Promise.resolve({ esearchresult: { idlist: pubmedDatedPmids(3) } }),
        })
        .mockResolvedValueOnce({
          ok: true,
          headers: new Headers({ 'content-type': 'text/xml' }),
          text: () => Promise.resolve(pubmedDatedArticleXml([
            { year: '2024', month: 'Mar', day: '5' },  // in window
            { year: '2025', month: 'Jan' },            // out: pdat matched a 2024 epub, print date is 2025
            { year: '2024', month: 'Aug', day: '13' }, // in window
          ])),
        }) as any;

      const response = await searchArticles('brca1', { source: 'pubmed', dateRange: '2024-01-01/2024-12-31' });

      expect(response.results.map(r => r.pmid)).toEqual(['40000001', '40000003']);
      expect(response.warnings).toHaveLength(1);
      expect(response.warnings![0]).toBe(
        'Removed 1 records outside date range 2024-01-01/2024-12-31 (PubMed date-filter mismatch); ' +
        '2/10 rows returned. More may exist — page with offset or raise limit.'
      );
    });

    test('PubMed dateRange post-filter on a full page warns without the paging remedy', async () => {
      global.fetch = jest.fn<(...args: any[]) => any>()
        .mockResolvedValueOnce({
          ok: true,
          headers: new Headers({ 'content-type': 'application/json' }),
          json: () => Promise.resolve({ esearchresult: { idlist: pubmedDatedPmids(3) } }),
        })
        .mockResolvedValueOnce({
          ok: true,
          headers: new Headers({ 'content-type': 'text/xml' }),
          text: () => Promise.resolve(pubmedDatedArticleXml([
            { year: '2024', month: 'Mar', day: '5' },
            { year: '2025', month: 'Jan' },
            { year: '2024', month: 'Aug', day: '13' },
          ])),
        }) as any;

      const response = await searchArticles('brca1', { source: 'pubmed', dateRange: '2024-01-01/2024-12-31', limit: 2 });

      expect(response.results.map(r => r.pmid)).toEqual(['40000001', '40000003']);
      expect(response.warnings).toHaveLength(1);
      expect(response.warnings![0]).toBe(
        'Removed 1 records outside your date range (PubMed date-filter mismatch).'
      );
    });

    test('PubMed dateRange post-filter with zero in-window rows returns [] with the overfetch warning', async () => {
      global.fetch = jest.fn<(...args: any[]) => any>()
        .mockResolvedValueOnce({
          ok: true,
          headers: new Headers({ 'content-type': 'application/json' }),
          json: () => Promise.resolve({ esearchresult: { idlist: pubmedDatedPmids(2) } }),
        })
        .mockResolvedValueOnce({
          ok: true,
          headers: new Headers({ 'content-type': 'text/xml' }),
          text: () => Promise.resolve(pubmedDatedArticleXml([
            { year: '2025', month: 'Jan' },
            { year: '2026', month: 'Jun' },
          ])),
        }) as any;

      const response = await searchArticles('brca1', { source: 'pubmed', dateRange: '2024-01-01/2024-12-31' });

      expect(response.results).toEqual([]);
      expect(response.warnings).toHaveLength(1);
      expect(response.warnings![0]).toBe(
        '0 in-window records in fetched pool (PubMed date-filter mismatch); try a larger limit.'
      );
    });

    test('PubMed dateRange post-filter passes MedlineDate/undated rows and refines month/day on boundary years only', async () => {
      global.fetch = jest.fn<(...args: any[]) => any>()
        .mockResolvedValueOnce({
          ok: true,
          headers: new Headers({ 'content-type': 'application/json' }),
          json: () => Promise.resolve({ esearchresult: { idlist: pubmedDatedPmids(7) } }),
        })
        .mockResolvedValueOnce({
          ok: true,
          headers: new Headers({ 'content-type': 'text/xml' }),
          text: () => Promise.resolve(pubmedDatedArticleXml([
            { year: '2024', month: 'Jan' },             // boundary from-year, month < from-month → dropped
            { year: '2024', month: 'Jun' },             // boundary month, no day → kept (cannot disprove)
            { year: '2024', month: 'Jun', day: '20' },  // boundary to-day → dropped
            { year: '2024', month: 'Jul', day: '2' },   // boundary to-year, month > to-month → dropped
            { medlineDate: '2024 Jan-Feb' },            // unparseable MedlineDate → kept
            { year: '2023', month: 'Dec', day: '15' },  // year alone is outside → dropped
            {},                                          // no displayed date → kept
          ])),
        }) as any;

      const response = await searchArticles('brca1', { source: 'pubmed', dateRange: '2024-06-01/2024-06-15' });

      expect(response.results.map(r => r.pmid)).toEqual(['40000002', '40000005', '40000007']);
    });

    test('PubMed dateRange post-filter emits no warning when nothing was dropped', async () => {
      global.fetch = jest.fn<(...args: any[]) => any>()
        .mockResolvedValueOnce({
          ok: true,
          headers: new Headers({ 'content-type': 'application/json' }),
          json: () => Promise.resolve({ esearchresult: { idlist: pubmedDatedPmids(2) } }),
        })
        .mockResolvedValueOnce({
          ok: true,
          headers: new Headers({ 'content-type': 'text/xml' }),
          text: () => Promise.resolve(pubmedDatedArticleXml([
            { year: '2024', month: 'Mar', day: '5' },
            { year: '2024', month: 'Aug', day: '13' },
          ])),
        }) as any;

      const response = await searchArticles('brca1', { source: 'pubmed', dateRange: '2024-01-01/2024-12-31' });

      expect(response.results).toHaveLength(2);
      expect(response.warnings).toBeUndefined();
    });

    test('Europe PMC search appends date range in query', async () => {
      global.fetch = jest.fn<(...args: any[]) => any>().mockResolvedValue({
        ok: true,
        headers: new Headers({ 'content-type': 'application/json' }),
        json: () => Promise.resolve({ resultList: { result: [] } }),
      }) as any;

      await articleSearch('brca1', { source: 'europepmc', dateRange: '2020-01-01/2023-12-31' });

      const callUrl = (global.fetch as any).mock.calls[0][0] as string;
      const decodedUrl = decodeURIComponent(callUrl);
      expect(decodedUrl).toContain('FIRST_PDATE:[2020-01-01 TO 2023-12-31]');
    });

    test('Europe PMC search with open-ended to-only dateRange', async () => {
      global.fetch = jest.fn<(...args: any[]) => any>().mockResolvedValue({
        ok: true,
        headers: new Headers({ 'content-type': 'application/json' }),
        json: () => Promise.resolve({ resultList: { result: [] } }),
      }) as any;

      await articleSearch('brca1', { source: 'europepmc', dateRange: '/2023-12-31' });

      const callUrl = (global.fetch as any).mock.calls[0][0] as string;
      const decodedUrl = decodeURIComponent(callUrl);
      expect(decodedUrl).toContain('FIRST_PDATE:[* TO 2023-12-31]');
    });

    test('Europe PMC search date clause is day-granular across distinct years', async () => {
      global.fetch = jest.fn<(...args: any[]) => any>().mockResolvedValue({
        ok: true,
        headers: new Headers({ 'content-type': 'application/json' }),
        json: () => Promise.resolve({ resultList: { result: [] } }),
      }) as any;

      await articleSearch('brca1', { source: 'europepmc', dateRange: '2020-06-15/2021-03-01' });

      const callUrl = (global.fetch as any).mock.calls[0][0] as string;
      const decodedUrl = decodeURIComponent(callUrl);
      // month/day is preserved: FIRST_PDATE matches the displayed
      // firstPublicationDate at day granularity (issue #120)
      expect(decodedUrl).toContain('brca1 AND FIRST_PDATE:[2020-06-15 TO 2021-03-01]');
    });

    test('Europe PMC search with open-ended from-only dateRange', async () => {
      global.fetch = jest.fn<(...args: any[]) => any>().mockResolvedValue({
        ok: true,
        headers: new Headers({ 'content-type': 'application/json' }),
        json: () => Promise.resolve({ resultList: { result: [] } }),
      }) as any;

      await articleSearch('brca1', { source: 'europepmc', dateRange: '2020-06-01/' });

      const callUrl = (global.fetch as any).mock.calls[0][0] as string;
      const decodedUrl = decodeURIComponent(callUrl);
      expect(decodedUrl).toContain('FIRST_PDATE:[2020-06-01 TO *]');
    });

    test('Semantic Scholar search appends publicationDateOrYear param', async () => {
      global.fetch = jest.fn<(...args: any[]) => any>().mockResolvedValue({
        ok: true,
        headers: new Headers({ 'content-type': 'application/json' }),
        json: () => Promise.resolve({ data: [] }),
      }) as any;

      await articleSearch('brca1', { source: 'semantic_scholar', dateRange: '2020-01-01/2023-12-31' });

      const callUrl = (global.fetch as any).mock.calls[0][0] as string;
      expect(callUrl).toContain('publicationDateOrYear=2020-01-01:2023-12-31');
    });

    test('Semantic Scholar search with open-ended from-only', async () => {
      global.fetch = jest.fn<(...args: any[]) => any>().mockResolvedValue({
        ok: true,
        headers: new Headers({ 'content-type': 'application/json' }),
        json: () => Promise.resolve({ data: [] }),
      }) as any;

      await articleSearch('brca1', { source: 'semantic_scholar', dateRange: '2020-01-01/' });

      const callUrl = (global.fetch as any).mock.calls[0][0] as string;
      expect(callUrl).toContain('publicationDateOrYear=2020-01-01:');
    });

    // B8: article search shares the single-flight S2 queue with citations.
    // While the first search is in flight, a second search must NOT start its
    // fetch — even after the registry rate-limit interval has elapsed.
    test('concurrent Semantic Scholar searches are serialized by the shared queue', async () => {
      jest.useFakeTimers();
      try {
        const ok = () => ({
          ok: true,
          headers: new Headers({ 'content-type': 'application/json' }),
          json: () => Promise.resolve({ data: [] }),
        });
        let releaseFirst!: (v: unknown) => void;
        global.fetch = jest.fn<(...args: any[]) => any>().mockImplementation((url: unknown) => {
          if (parseMockUrl(url).hostname !== 'api.semanticscholar.org') return Promise.resolve(ok());
          if ((global.fetch as any).mock.calls.filter((c: any[]) => parseMockUrl(c[0]).hostname === 'api.semanticscholar.org').length === 1) {
            return new Promise(resolve => { releaseFirst = resolve; });
          }
          return Promise.resolve(ok());
        }) as any;

        const first = articleSearch('brca1', { source: 'semantic_scholar' });
        const second = articleSearch('tp53', { source: 'semantic_scholar' });
        // Past the 2s unkeyed rate limit: serialization can only come from the queue.
        await jest.advanceTimersByTimeAsync(3000);
        expect(global.fetch).toHaveBeenCalledTimes(1);

        releaseFirst(ok());
        await jest.advanceTimersByTimeAsync(20000);
        await Promise.all([first, second]);
        expect(global.fetch).toHaveBeenCalledTimes(2);
      } finally {
        jest.useRealTimers();
      }
    });

    test('pubtator source surfaces dateRange rejection as an envelope error, never an item (#87)', async () => {
      const response = await searchArticles('brca1', { source: 'pubtator', dateRange: '2020-01-01/2023-12-31' });
      expect(response.results).toEqual([]);
      expect(response.errors).toHaveLength(1);
      expect(response.errors![0].source).toBe('pubtator');
      expect(response.errors![0].message).toContain('does not support date filtering');
      expect(response.errors![0].message).toContain('Use pubmed, europepmc, semantic_scholar, preprint_only, or arxiv.');
    });

    test('litsense source surfaces dateRange rejection as an envelope error, never an item (#87)', async () => {
      const response = await searchArticles('brca1', { source: 'litsense', dateRange: '2020-01-01/2023-12-31' });
      expect(response.results).toEqual([]);
      expect(response.errors).toHaveLength(1);
      expect(response.errors![0].source).toBe('litsense');
      expect(response.errors![0].message).toContain('does not support date filtering');
    });

    test('federated search with dateRange only queries date-aware backends', async () => {
      global.fetch = jest.fn<(...args: any[]) => any>()
        .mockResolvedValueOnce({
          ok: true,
          headers: new Headers({ 'content-type': 'application/json' }),
          json: () => Promise.resolve({ esearchresult: { idlist: [] } }),
        })
        .mockResolvedValueOnce({
          ok: true,
          headers: new Headers({ 'content-type': 'application/json' }),
          json: () => Promise.resolve({ resultList: { result: [] } }),
        })
        .mockResolvedValueOnce({
          ok: true,
          headers: new Headers({ 'content-type': 'application/json' }),
          json: () => Promise.resolve({ data: [] }),
        })
        .mockResolvedValueOnce({
          ok: true,
          headers: new Headers({ 'content-type': 'application/atom+xml' }),
          text: () => Promise.resolve(`<?xml version='1.0' encoding='UTF-8'?>\n<feed xmlns="http://www.w3.org/2005/Atom"><opensearch:totalResults xmlns:opensearch="http://a9.com/-/spec/opensearch/1.1/">0</opensearch:totalResults></feed>`),
        }) as any;

      await articleSearch('brca1', { dateRange: '2020-01-01/2023-12-31' });

      expect(global.fetch).toHaveBeenCalledTimes(4);

      const urls = (global.fetch as any).mock.calls.map((c: any) => c[0] as string);
      expect(urls[0]).toContain('esearch.fcgi');
      // #134: the federated pubmed leg also requests relevance ordering.
      expect(urls[0]).toContain('sort=relevance');
      expect(urls[1]).toContain('europepmc');
      expect(urls[2]).toContain('semanticscholar');
      expect(urls[3]).toContain('export.arxiv.org');
    });

    test('federated search without dateRange queries all backends', async () => {
      global.fetch = jest.fn<(...args: any[]) => any>().mockResolvedValue({
        ok: true,
        headers: new Headers({ 'content-type': 'application/json' }),
        json: () => Promise.resolve({ esearchresult: { idlist: [] } }),
      }) as any;

      await articleSearch('brca1');

      expect(global.fetch).toHaveBeenCalledTimes(6);
    });

    // Regression for the throw-on-timeout invariant: a hanging backend must
    // REJECT into Promise.allSettled (error result). If withTimeout ever
    // resolves null instead, `allArticles.push(...result.value)` spreads null
    // and this test fails with a TypeError rather than silently dropping the
    // backend's results.
    test('federated search: hanging provider rejects, never resolves null', async () => {
      jest.useFakeTimers();
      try {
        global.fetch = jest.fn<(...args: any[]) => any>().mockImplementation((url: unknown) => {
          if (parseMockUrl(url).hostname === 'api.semanticscholar.org') {
            return new Promise(() => {});
          }
          return Promise.resolve({
            ok: true,
            headers: new Headers({ 'content-type': 'application/json' }),
            json: () => Promise.resolve({}),
          });
        }) as any;

        const promise = articleSearch('brca1');
        await jest.advanceTimersByTimeAsync(20000);
        const result = await promise;

        // Resolved without a crash: the hung backend landed as a rejected
        // (error) entry that allSettled skipped, not a null spread.
        expect(result).toEqual([]);
      } finally {
        jest.useRealTimers();
      }
    });

    const okJson = (payload: unknown) => ({
      ok: true,
      headers: new Headers({ 'content-type': 'application/json' }),
      json: () => Promise.resolve(payload),
    });
    const okXml = (payload: string) => ({
      ok: true,
      headers: new Headers({ 'content-type': 'text/xml' }),
      text: () => Promise.resolve(payload),
    });

    // Live-verified PubMed behavior (issue #78): the automatic term
    // translation drops unrecognized tokens and matches the residue —
    // "qqqzzz impossible term xyzzy" executes as impossible AND term and
    // would return ~3300 unrelated papers.
    test('searchArticles: pubmed gibberish query returns [] + warning, never residue noise (#78)', async () => {
      global.fetch = jest.fn<(...args: any[]) => any>().mockImplementation((url: unknown) => {
        const u = String(url);
        if (u.includes('esearch.fcgi')) {
          return Promise.resolve(okJson({
            esearchresult: {
              idlist: ['42869464', '42851520'],
              count: '3333',
              querytranslation: '("impossibilities"[All Fields] OR "impossible"[All Fields]) AND ("term"[All Fields])',
            },
          }));
        }
        throw new Error('efetch must not run when the query was suppressed');
      }) as any;

      const response = await searchArticles('qqqzzz impossible term xyzzy', { source: 'pubmed' });

      expect(response.results).toEqual([]);
      expect(global.fetch).toHaveBeenCalledTimes(1);
      expect(response.warnings?.some(w =>
        w.includes('qqqzzz') && w.includes('xyzzy') && w.includes('unrecognized')
      )).toBe(true);
      expect(response.errors).toBeUndefined();
    });

    // Live-verified federated behavior (issue #78 repro): arXiv matches
    // "impossible"/"term" in physics papers when PubMed recognized nothing.
    test('searchArticles federated: gibberish suppresses other backends\' residue matches too (#78)', async () => {
      const arxivFeed = `<?xml version="1.0"?><feed xmlns="http://www.w3.org/2005/Atom">
<entry><id>http://arxiv.org/abs/2510.12868v1</id><title>Branes and Antibranes: The Impossible States</title>
<summary>Abstract mentioning the word term.</summary><published>2025-10-14T00:00:00Z</published>
<author><name>R. Emparan</name></author><arxiv:primary_category xmlns:arxiv="http://arxiv.org/schemas/atom" term="hep-th"/></entry>
</feed>`;
      global.fetch = jest.fn<(...args: any[]) => any>().mockImplementation((url: unknown) => {
        const { hostname } = parseMockUrl(url);
        const u = String(url);
        if (u.includes('esearch.fcgi')) {
          return Promise.resolve(okJson({
            esearchresult: {
              idlist: ['42869464'],
              count: '3333',
              querytranslation: '("impossibilities"[All Fields] OR "impossible"[All Fields]) AND ("term"[All Fields])',
            },
          }));
        }
        // arXiv returns a plausible-looking match on the generic residue words
        if (hostname === 'export.arxiv.org') {
          return Promise.resolve({
            ok: true,
            headers: new Headers({ 'content-type': 'application/atom+xml' }),
            text: () => Promise.resolve(arxivFeed),
          });
        }
        if (hostname === 'api.semanticscholar.org') return Promise.resolve(okJson({ data: [] }));
        // europepmc/pubtator/litsense fail hard — errors must still ride out
        return Promise.reject(new Error('network down'));
      }) as any;

      const response = await searchArticles('qqqzzz impossible term xyzzy', {});

      // The whole federated page is suppressed — the arXiv residue match
      // never seats as a plausible citation.
      expect(response.results).toEqual([]);
      expect(response.results.some(r => r.source === 'arxiv')).toBe(false);
      expect(response.warnings?.some(w => w.includes('PubMed ignored all meaningful terms'))).toBe(true);
      expect(response.warnings?.some(w => w.includes('federated results suppressed'))).toBe(true);
      // Per-source failures from the other legs still ride in errors
      expect(response.errors?.map(e => e.source)).toEqual(expect.arrayContaining(['europepmc', 'pubtator', 'litsense']));
    });

    test('searchArticles: pubmed partial token drop still returns results + honest warning (#78)', async () => {
      global.fetch = jest.fn<(...args: any[]) => any>().mockImplementation((url: unknown) => {
        const u = String(url);
        if (u.includes('esearch.fcgi')) {
          return Promise.resolve(okJson({
            esearchresult: {
              idlist: ['12345'],
              count: '1',
              querytranslation: '"crispr"[All Fields] AND "cas9"[All Fields]',
            },
          }));
        }
        return Promise.resolve(okXml(SINGLE_ARTICLE_XML));
      }) as any;

      const response = await searchArticles('crispr cas9 zzzqqqxyzzy', { source: 'pubmed' });

      expect(response.results).toHaveLength(1);
      expect(response.results[0]._error).toBeUndefined();
      expect(response.warnings?.some(w => w.includes('zzzqqqxyzzy') && w.includes('ignored unrecognized terms'))).toBe(true);
    });

    test('searchArticles: pubmed normal query carries no degradation warning', async () => {
      global.fetch = jest.fn<(...args: any[]) => any>().mockImplementation((url: unknown) => {
        const u = String(url);
        if (u.includes('esearch.fcgi')) {
          return Promise.resolve(okJson({
            esearchresult: {
              idlist: ['12345'],
              count: '1',
              querytranslation: '"brca1"[All Fields]',
            },
          }));
        }
        return Promise.resolve(okXml(SINGLE_ARTICLE_XML));
      }) as any;

      const response = await searchArticles('brca1', { source: 'pubmed' });

      expect(response.results).toHaveLength(1);
      expect(response.warnings).toBeUndefined();
      expect(response.errors).toBeUndefined();
    });

    test('searchArticles: litsense rows carry the matched sentence + PubMed-enriched title (#87)', async () => {
      const litsenseRows = [
        { pmid: 12345, text: 'Sentence about BRCA1.', score: 1, section: 'abstract', annotations: [] },
        { pmid: 67890, text: 'Another sentence.', score: 0.9, section: 'INTRO', annotations: [] },
      ];
      global.fetch = jest.fn<(...args: any[]) => any>().mockImplementation((url: unknown) => {
        const u = String(url);
        if (u.includes('/sentences/')) return Promise.resolve(okJson(litsenseRows));
        if (u.includes('efetch.fcgi')) return Promise.resolve(okXml(SINGLE_ARTICLE_XML));
        throw new Error(`unexpected ${u}`);
      }) as any;

      const response = await searchArticles('brca1', { source: 'litsense' });

      expect(response.results).toHaveLength(2);
      for (const row of response.results) {
        expect(row.sentence).toBeTruthy();
        expect(typeof row.section).toBe('string');
        expect(row.source).toBe('litsense');
      }
      // PMID 12345 is enriched from the mocked efetch (SINGLE_ARTICLE_XML);
      // PMID 67890 is not in the XML and stays sparse.
      const enriched = response.results.find(r => r.pmid === '12345');
      expect(enriched?.title).toBe('Test article about BRCA1');
      expect(enriched?.abstract).toBe('Full abstract text for testing purposes.');
      const sparse = response.results.find(r => r.pmid === '67890');
      expect(sparse?.title).toBeUndefined();
      expect(response.warnings).toBeUndefined();
    });

    test('searchArticles: litsense enrichment failure keeps sparse rows + surfaces a warning (#87)', async () => {
      const litsenseRows = [
        { pmid: 12345, text: 'Sentence about BRCA1.', score: 1, section: 'abstract', annotations: [] },
      ];
      global.fetch = jest.fn<(...args: any[]) => any>().mockImplementation((url: unknown) => {
        const u = String(url);
        if (u.includes('/sentences/')) return Promise.resolve(okJson(litsenseRows));
        if (u.includes('efetch.fcgi')) {
          return Promise.resolve(okXml('<!DOCTYPE html><html><body>blocked</body></html>'));
        }
        throw new Error(`unexpected ${u}`);
      }) as any;

      const response = await searchArticles('brca1', { source: 'litsense' });

      expect(response.results).toHaveLength(1);
      expect(response.results[0].sentence).toBe('Sentence about BRCA1.');
      expect(response.results[0].title).toBeUndefined();
      expect(response.warnings?.some(w => w.startsWith('litsense metadata enrichment unavailable'))).toBe(true);
      expect(response.errors).toBeUndefined();
    });

    test('searchArticles: litsense relevance floor drops noise matches and warns when nothing clears it (#78)', async () => {
      // Live-measured LitSense noise floor for gibberish: ~0.39-0.55.
      const noiseRows = [
        { pmid: 11111, text: 'Unrelated sentence.', score: 0.5156, section: 'abstract', annotations: [] },
        { pmid: 22222, text: 'Another unrelated one.', score: 0.41, section: 'results', annotations: [] },
      ];
      global.fetch = jest.fn<(...args: any[]) => any>().mockImplementation((url: unknown) => {
        const u = String(url);
        if (u.includes('/sentences/')) return Promise.resolve(okJson(noiseRows));
        throw new Error(`unexpected ${u}`);
      }) as any;

      const response = await searchArticles('qqqzzz xyzzy plugh', { source: 'litsense' });

      expect(response.results).toEqual([]);
      expect(response.warnings?.some(w => w.includes('relevance floor') && w.includes('2 litsense matches'))).toBe(true);
    });

    test('searchArticles federated: failed backends become envelope errors, never result items (#87)', async () => {
      global.fetch = jest.fn<(...args: any[]) => any>().mockImplementation((url: unknown) => {
        const { hostname } = parseMockUrl(url);
        const u = String(url);
        if (hostname === 'eutils.ncbi.nlm.nih.gov') {
          if (u.includes('esearch.fcgi')) {
            return Promise.resolve(okJson({
              esearchresult: { idlist: ['12345'], count: '1', querytranslation: '"brca1"[All Fields]' },
            }));
          }
          return Promise.resolve(okXml(SINGLE_ARTICLE_XML));
        }
        if (hostname === 'api.semanticscholar.org') {
          return Promise.resolve(okJson({ data: [] }));
        }
        // pubtator + litsense fail hard (no retry config — fast in tests)
        return Promise.reject(new Error('network down'));
      }) as any;

      const response = await searchArticles('brca1', {});

      expect(response.results).toHaveLength(1);
      expect(response.results[0].pmid).toBe('12345');
      expect(response.results.every(r => r._error === undefined)).toBe(true);
      const failedSources = response.errors?.map(e => e.source);
      expect(failedSources).toEqual(expect.arrayContaining(['pubtator', 'litsense']));
      for (const err of response.errors ?? []) {
        expect(err.message).toContain('failed');
        expect(typeof err.message).toBe('string');
      }
    });

    // Federated floor warning must fire only when the FLOOR emptied the
    // litsense contribution — an above-floor litsense row whose PMID also
    // came from pubmed dedup-merges into that record and legitimately
    // disappears as a litsense-sourced row; that is not a floor drop and
    // must NOT be reported as one.
    test('searchArticles federated: dedup-merged litsense rows are not misreported as floor drops (#78)', async () => {
      const litsenseRows = [
        // above floor, same PMID as the pubmed hit → merges, page keeps the pubmed record
        { pmid: 12345, text: 'Topical BRCA1 sentence.', score: 0.95, section: 'abstract', annotations: [] },
      ];
      const pubmedLeg = (u: string) => {
        if (u.includes('efetch')) {
          return Promise.resolve(okXml(SINGLE_ARTICLE_XML));
        }
        return Promise.resolve(okJson({
          esearchresult: { idlist: ['12345'], count: '1', querytranslation: '"brca1"[All Fields]' },
        }));
      };
      global.fetch = jest.fn<(...args: any[]) => any>().mockImplementation((url: unknown) => {
        const { hostname } = parseMockUrl(url);
        const u = String(url);
        if (hostname === 'eutils.ncbi.nlm.nih.gov') return pubmedLeg(u);
        if (u.includes('/sentences/')) return Promise.resolve(okJson(litsenseRows));
        if (hostname === 'api.semanticscholar.org') return Promise.resolve(okJson({ data: [] }));
        return Promise.reject(new Error('network down'));
      }) as any;

      const merged = await searchArticles('brca1', {});
      expect(merged.results.some(r => r.pmid === '12345')).toBe(true);
      expect(merged.warnings?.some(w => w.includes('relevance floor'))).toBeFalsy();

      // Same federation but the litsense leg returns ONLY sub-floor noise
      // → the floor emptied the contribution and the warning must say so.
      const noiseOnly = [
        { pmid: 99999, text: 'Unrelated sentence.', score: 0.42, section: 'abstract', annotations: [] },
      ];
      (global.fetch as any).mockImplementation((url: unknown) => {
        const { hostname } = parseMockUrl(url);
        const u = String(url);
        if (hostname === 'eutils.ncbi.nlm.nih.gov') return pubmedLeg(u);
        if (u.includes('/sentences/')) return Promise.resolve(okJson(noiseOnly));
        if (hostname === 'api.semanticscholar.org') return Promise.resolve(okJson({ data: [] }));
        return Promise.reject(new Error('network down'));
      });

      const emptied = await searchArticles('brca1', {});
      expect(emptied.results.some(r => r.pmid === '12345')).toBe(true);
      expect(emptied.warnings?.some(w => w.includes('relevance floor') && w.includes('1 litsense matches'))).toBe(true);
    });

    // Crowd-out disclosure (issue #134): ranking is citation-based but only
    // some legs populate cited_by, so zero-cited sources tie at 0, the stable
    // sort keeps federation order, and with limit applied post-dedup a
    // MATCHING secondary source can contribute 0 rows with no signal.
    const CROWD_ARXIV_FEED = `<?xml version="1.0"?><feed xmlns="http://www.w3.org/2005/Atom">
<entry><id>http://arxiv.org/abs/2510.12868v1</id><title>CRISPR base editing review</title>
<summary>Abstract.</summary><published>2025-10-14T00:00:00Z</published>
<author><name>A. Author</name></author>
<arxiv:primary_category xmlns:arxiv="http://arxiv.org/schemas/atom" term="q-bio.GN"/></entry>
</feed>`;
    const crowdOutFederation = (extraMocks: Array<(u: string, hostname: string) => unknown> = []) =>
      jest.fn<(...args: any[]) => any>().mockImplementation((url: unknown) => {
        const { hostname } = parseMockUrl(url);
        const u = String(url);
        if (hostname === 'eutils.ncbi.nlm.nih.gov') {
          if (u.includes('efetch.fcgi')) return Promise.resolve(okXml(SINGLE_ARTICLE_XML));
          return Promise.resolve(okJson({
            esearchresult: { idlist: ['12345'], count: '1', querytranslation: '"brca1"[All Fields]' },
          }));
        }
        if (hostname === 'export.arxiv.org') {
          return Promise.resolve({
            ok: true,
            headers: new Headers({ 'content-type': 'application/atom+xml' }),
            text: () => Promise.resolve(CROWD_ARXIV_FEED),
          });
        }
        if (u.includes('europepmc')) return Promise.resolve(okJson({ resultList: { result: [] } }));
        if (hostname === 'api.semanticscholar.org') return Promise.resolve(okJson({ data: [] }));
        for (const mock of extraMocks) {
          const handled = mock(u, hostname);
          if (handled !== undefined) return Promise.resolve(handled);
        }
        return Promise.reject(new Error('network down'));
      }) as any;

    test('searchArticles federated: crowded-out secondary source is disclosed with an exact warning (#134)', async () => {
      global.fetch = crowdOutFederation();

      const response = await searchArticles('brca1', { limit: 1 });

      // The single-row page goes to pubmed (zero-cited tie, federation
      // order) — arXiv matched but contributed nothing, and says so.
      expect(response.results).toHaveLength(1);
      expect(response.results[0].pmid).toBe('12345');
      expect(response.warnings?.some(w =>
        w === "arXiv had matches but none made this page — query source 'arxiv' directly if broader coverage is needed."
      )).toBe(true);
    });

    test('searchArticles federated: no crowd-out warning when the secondary contributes rows (#134)', async () => {
      global.fetch = crowdOutFederation();

      const response = await searchArticles('brca1');

      // Default limit 10: both rows survive — nothing to disclose.
      expect(response.results.some(r => r.pmid === '12345')).toBe(true);
      expect(response.results.some(r => r.source === 'arxiv')).toBe(true);
      expect(response.warnings?.some(w => w.includes('had matches but none made this page'))).toBeFalsy();
    });

    test('searchArticles federated: dedup-merged twins do not count as crowded out (#134)', async () => {
      // arXiv's row is the arXiv twin OF the pubmed record (same DOI in
      // submitter vs registry casing) — it merges into the pubmed row, so
      // arXiv IS represented even though no kept row has source 'arxiv'.
      // NB: the arxiv namespace is declared on the ROOT (as in real feeds)
      // so <arxiv:doi> parses to a plain string, not an attribute object.
      const twinFeed = CROWD_ARXIV_FEED
        .replace(
          '<feed xmlns="http://www.w3.org/2005/Atom">',
          '<feed xmlns="http://www.w3.org/2005/Atom" xmlns:arxiv="http://arxiv.org/schemas/atom">'
        )
        .replace(
          '</entry>',
          '<arxiv:doi>10.1234/TEST.2018</arxiv:doi></entry>'
        );
      global.fetch = jest.fn<(...args: any[]) => any>().mockImplementation((url: unknown) => {
        const { hostname } = parseMockUrl(url);
        const u = String(url);
        if (hostname === 'eutils.ncbi.nlm.nih.gov') {
          if (u.includes('efetch.fcgi')) return Promise.resolve(okXml(SINGLE_ARTICLE_XML));
          return Promise.resolve(okJson({
            esearchresult: { idlist: ['12345'], count: '1', querytranslation: '"brca1"[All Fields]' },
          }));
        }
        if (hostname === 'export.arxiv.org') {
          return Promise.resolve({
            ok: true,
            headers: new Headers({ 'content-type': 'application/atom+xml' }),
            text: () => Promise.resolve(twinFeed),
          });
        }
        if (u.includes('europepmc')) return Promise.resolve(okJson({ resultList: { result: [] } }));
        if (hostname === 'api.semanticscholar.org') return Promise.resolve(okJson({ data: [] }));
        return Promise.reject(new Error('network down'));
      }) as any;

      const response = await searchArticles('brca1', { limit: 1 });

      expect(response.results).toHaveLength(1);
      expect(response.results[0].source).toBe('pubmed');
      // The twin merged (DOI match) — arXiv is represented, not crowded out.
      expect(response.results[0].arxiv_id).toBe('2510.12868');
      expect(response.warnings?.some(w => w.includes('had matches but none made this page'))).toBeFalsy();
    });

    test('searchArticles federated: ONE warning names ALL crowded-out sources (#134)', async () => {
      const litsenseRows = [
        // Above the relevance floor with its own PMID — a real competing
        // match that still loses the limit-1 page.
        { pmid: 67890, text: 'Topical BRCA1 sentence.', score: 0.95, section: 'abstract', annotations: [] },
      ];
      global.fetch = crowdOutFederation([
        (u) => u.includes('/sentences/') ? okJson(litsenseRows) : undefined,
      ]);

      const response = await searchArticles('brca1', { limit: 1 });

      expect(response.results).toHaveLength(1);
      expect(response.warnings?.some(w =>
        w === "arXiv, LitSense had matches but none made this page — query sources 'arxiv', 'litsense' directly if broader coverage is needed."
      )).toBe(true);
    });

    test('searchArticles federated: a leg whose rows were all date-dropped is NOT crowd-out (#134)', async () => {
      // PubMed's own displayed-date post-filter (#120) drops its whole pool
      // BEFORE federation sees a row — offered == 0, so pubmed must not be
      // reported as crowded out (its matches never competed for the page).
      global.fetch = jest.fn<(...args: any[]) => any>().mockImplementation((url: unknown) => {
        const { hostname } = parseMockUrl(url);
        const u = String(url);
        if (hostname === 'eutils.ncbi.nlm.nih.gov') {
          if (u.includes('efetch.fcgi')) {
            return Promise.resolve(okXml(pubmedDatedArticleXml([{ year: '2018', month: 'Sep', day: '21' }])));
          }
          return Promise.resolve(okJson({
            esearchresult: { idlist: pubmedDatedPmids(1), count: '1', querytranslation: '"brca1"[All Fields]' },
          }));
        }
        if (u.includes('europepmc')) {
          return Promise.resolve(okJson(epmcSearchHit({
            pmid: '41721001',
            title: 'In-window Europe PMC hit',
            authorString: 'Smith J',
            journalTitle: 'Nature',
            firstPublicationDate: '2020-06-01',
            citedByCount: 2,
            isOpenAccess: 'N',
          })));
        }
        if (hostname === 'api.semanticscholar.org') return Promise.resolve(okJson({ data: [] }));
        if (hostname === 'export.arxiv.org') {
          return Promise.resolve({
            ok: true,
            headers: new Headers({ 'content-type': 'application/atom+xml' }),
            text: () => Promise.resolve(`<?xml version='1.0' encoding='UTF-8'?>\n<feed xmlns="http://www.w3.org/2005/Atom"><opensearch:totalResults xmlns:opensearch="http://a9.com/-/spec/opensearch/1.1/">0</opensearch:totalResults></feed>`),
          });
        }
        throw new Error(`unexpected ${u}`);
      }) as any;

      const response = await searchArticles('brca1', { dateRange: '2020-01-01/2020-12-31', limit: 3 });

      expect(response.results).toHaveLength(1);
      expect(response.results[0].source).toBe('europepmc');
      // Sanity: pubmed DID have pool matches — dropped by its own filter.
      expect(response.warnings?.some(w => w.includes('0 in-window records'))).toBe(true);
      expect(response.warnings?.some(w => w.includes('had matches but none made this page'))).toBeFalsy();
    });
  });

  describe('parseArticleId', () => {
    test('parses PMID (numeric)', () => {
      expect(parseArticleId('12345')).toEqual({ type: 'pmid', value: '12345' });
    });

    test('parses PMID with whitespace trimmed', () => {
      expect(parseArticleId('  12345  ')).toEqual({ type: 'pmid', value: '12345' });
    });

    test('parses PMCID', () => {
      expect(parseArticleId('PMC1234567')).toEqual({ type: 'pmcid', value: 'PMC1234567' });
    });

    test('parses lowercase pmcid', () => {
      expect(parseArticleId('pmc1234567')).toEqual({ type: 'pmcid', value: 'pmc1234567' });
    });

    test('parses DOI', () => {
      expect(parseArticleId('10.1038/s41586-021-03819-2')).toEqual({ type: 'doi', value: '10.1038/s41586-021-03819-2' });
    });

    test('parses DOI with doi: prefix', () => {
      expect(parseArticleId('doi:10.1038/s41586-021-03819-2')).toEqual({ type: 'doi', value: '10.1038/s41586-021-03819-2' });
    });

    test('parses DOI with DOI: prefix (uppercase)', () => {
      expect(parseArticleId('DOI:10.1038/s41586-021-03819-2')).toEqual({ type: 'doi', value: '10.1038/s41586-021-03819-2' });
    });

    test('throws for empty string', () => {
      expect(() => parseArticleId('')).toThrow('Unrecognized identifier format');
    });

    test('throws for random text', () => {
      expect(() => parseArticleId('hello world')).toThrow('Unrecognized identifier format');
    });

    test('throws for invalid DOI (too few digits)', () => {
      expect(() => parseArticleId('10.1/test')).toThrow('Unrecognized identifier format');
    });

    test('throws for DOI without suffix', () => {
      expect(() => parseArticleId('10.1038/')).toThrow('Unrecognized identifier format');
    });

    test('parses PMID with leading zeros', () => {
      expect(parseArticleId('00012345')).toEqual({ type: 'pmid', value: '00012345' });
    });
  });

  describe('articleGet with ID resolution', () => {
    test('articleGet() with PMID still works directly (no IDConv call)', async () => {
      global.fetch = jest.fn<(...args: any[]) => any>().mockResolvedValue({
        ok: true,
        headers: new Headers({ 'content-type': 'text/xml' }),
        text: () => Promise.resolve(SINGLE_ARTICLE_XML),
      }) as any;

      const result = await articleGet('12345');

      expect(global.fetch).toHaveBeenCalledTimes(1);
      const callUrl = (global.fetch as any).mock.calls[0][0] as string;
      expect(callUrl).toContain('efetch.fcgi');
      expect(result.pmid).toBe('12345');
    });

    test('articleGet() with empty records from IDConv throws error', async () => {
      global.fetch = jest.fn<(...args: any[]) => any>().mockResolvedValue({
        ok: true,
        headers: new Headers({ 'content-type': 'application/json' }),
        json: () => Promise.resolve({ status: 'ok', records: [] }),
      }) as any;

      await expect(articleGet('PMC99999999')).rejects.toThrow('No record returned for pmcid');
    });

    test('articleGet() with PMCID error-status record without errmsg throws error', async () => {
      global.fetch = jest.fn<(...args: any[]) => any>().mockResolvedValue({
        ok: true,
        headers: new Headers({ 'content-type': 'application/json' }),
        json: () => Promise.resolve({
          status: 'ok',
          records: [{ pmcid: 'PMC99999999', requestedId: 'PMC99999999', status: 'error' }],
        }),
      }) as any;

      await expect(articleGet('PMC99999999')).rejects.toThrow('Could not resolve pmcid');
    });

    test('articleGet() with error-status record without errmsg throws error', async () => {
      global.fetch = jest.fn<(...args: any[]) => any>().mockResolvedValue({
        ok: true,
        headers: new Headers({ 'content-type': 'application/json' }),
        json: () => Promise.resolve({
          status: 'ok',
          records: [{ pmcid: 'PMC99999999', status: 'error' }],
        }),
      }) as any;

      await expect(articleGet('PMC99999999')).rejects.toThrow('Could not resolve pmcid');
    });

    test('articleGet() with PMID and oa section reports not_in_pmc when the article is not in PMC', async () => {
      global.fetch = jest.fn<(...args: any[]) => any>()
        .mockResolvedValueOnce({
          ok: true,
          headers: new Headers({ 'content-type': 'text/xml' }),
          text: () => Promise.resolve(MINIMAL_ARTICLE_XML_NO_PMC),
        })
        .mockResolvedValueOnce({
          ok: true,
          headers: new Headers({ 'content-type': 'application/json' }),
          json: () => Promise.resolve({
            status: 'ok',
            records: [{ pmid: 12345, status: 'error', errmsg: 'Not in PMC' }],
          }),
        }) as any;

      const result = await articleGet('12345', ['oa']);

      // efetch + failed idconv only — without a PMCID there is no Europe PMC call
      expect(global.fetch).toHaveBeenCalledTimes(2);
      expect(result.sections?.open_access).toEqual({
        status: 'not_in_pmc',
        full_text_available: false,
        links: { doi_url: 'https://doi.org/10.1234/test.2018' },
        note: expect.stringContaining('No PMC record'),
        source: 'europepmc',
      });
    });

    test('articleGet() with PMCID resolves to PMID then fetches', async () => {
      global.fetch = jest.fn<(...args: any[]) => any>()
        .mockResolvedValueOnce({
          ok: true,
          headers: new Headers({ 'content-type': 'application/json' }),
          json: () => Promise.resolve({
            status: 'ok',
            records: [{ doi: '10.1234/test.2018', pmcid: 'PMC9999999', pmid: 12345 }],
          }),
        })
        .mockResolvedValueOnce({
          ok: true,
          headers: new Headers({ 'content-type': 'text/xml' }),
          text: () => Promise.resolve(SINGLE_ARTICLE_XML),
        }) as any;

      const result = await articleGet('PMC9999999');

      expect(global.fetch).toHaveBeenCalledTimes(2);
      const idConvUrl = (global.fetch as any).mock.calls[0][0] as string;
      expect(idConvUrl).toContain('ids=PMC9999999');
      expect(idConvUrl).toContain('idconv');

      expect(result.pmid).toBe('12345');
      expect(result.title).toBe('Test article about BRCA1');
    });

    test('articleGet() with DOI merges resolved IDs into result', async () => {
      const minimalXml = `<?xml version="1.0"?>
<PubmedArticleSet>
<PubmedArticle>
<MedlineCitation Status="MEDLINE" Owner="NLM">
<PMID Version="1">12345</PMID>
<Article PubModel="Electronic">
<Journal><Title>Nature</Title><ISOAbbreviation>Nature</ISOAbbreviation></Journal>
<ArticleTitle>Test</ArticleTitle>
</Article>
</MedlineCitation>
<PubmedData>
<ArticleIdList>
<ArticleId IdType="pubmed">12345</ArticleId>
</ArticleIdList>
</PubmedData>
</PubmedArticle>
</PubmedArticleSet>`;

      global.fetch = jest.fn<(...args: any[]) => any>()
        .mockResolvedValueOnce({
          ok: true,
          headers: new Headers({ 'content-type': 'application/json' }),
          json: () => Promise.resolve({
            status: 'ok',
            records: [{ doi: '10.1234/test.2018', pmcid: 'PMC9999999', pmid: 12345 }],
          }),
        })
        .mockResolvedValueOnce({
          ok: true,
          headers: new Headers({ 'content-type': 'text/xml' }),
          text: () => Promise.resolve(minimalXml),
        }) as any;

      const result = await articleGet('10.1234/test.2018');

      expect(result.pmid).toBe('12345');
      expect(result.doi).toBe('10.1234/test.2018');
      expect(result.pmcid).toBe('PMC9999999');
    });

    test('articleGet() with unresolvable DOI throws error', async () => {
      global.fetch = jest.fn<(...args: any[]) => any>().mockResolvedValue({
        ok: true,
        headers: new Headers({ 'content-type': 'application/json' }),
        json: () => Promise.resolve({
          status: 'ok',
          records: [{
            doi: '10.9999/nonexistent',
            requestedId: '10.9999/nonexistent',
            status: 'error',
            errmsg: 'Identifier not found in PMC',
          }],
        }),
      }) as any;

      await expect(articleGet('10.9999/nonexistent')).rejects.toThrow('Could not resolve doi');
    });

    test('articleGet() with invalid identifier format throws error', async () => {
      await expect(articleGet('not-a-valid-id')).rejects.toThrow('Unrecognized identifier format');
    });

    test('articleGet() with DOI and oa section reads the Europe PMC core record', async () => {
      global.fetch = jest.fn<(...args: any[]) => any>()
        .mockResolvedValueOnce({
          ok: true,
          headers: new Headers({ 'content-type': 'application/json' }),
          json: () => Promise.resolve({
            status: 'ok',
            records: [{ doi: '10.1234/test.2018', pmcid: 'PMC9999999', pmid: 12345 }],
          }),
        })
        .mockResolvedValueOnce({
          ok: true,
          headers: new Headers({ 'content-type': 'text/xml' }),
          text: () => Promise.resolve(SINGLE_ARTICLE_XML),
        })
        .mockResolvedValueOnce({
          ok: true,
          headers: new Headers({ 'content-type': 'application/json' }),
          json: () => Promise.resolve(epmcSearchHit(epmcCoreRecord())),
        }) as any;

      const result = await articleGet('10.1234/test.2018', ['oa']);

      expect(global.fetch).toHaveBeenCalledTimes(3);
      const idConvUrl = (global.fetch as any).mock.calls[0][0] as string;
      expect(idConvUrl).toContain('idconv');

      const efetchUrl = (global.fetch as any).mock.calls[1][0] as string;
      expect(efetchUrl).toContain('efetch.fcgi');

      const epmcUrl = (global.fetch as any).mock.calls[2][0] as string;
      expect(epmcUrl).toContain('europepmc');
      expect(epmcUrl).toContain('PMCID%3APMC9999999');

      expect(result.sections?.open_access).toEqual({
        pmcid: 'PMC9999999',
        status: 'open_access',
        full_text_available: true,
        is_open_access: true,
        license: 'cc by',
        license_url: 'https://creativecommons.org/licenses/by/4.0/',
        links: {
          pmc_url: 'https://pmc.ncbi.nlm.nih.gov/articles/PMC9999999/',
          pdf_url: 'https://example.com/paper.pdf',
          epmc_url: 'https://europepmc.org/articles/PMC9999999',
          doi_url: 'https://doi.org/10.1234/test.2018',
        },
        note: expect.any(String),
        source: 'europepmc',
      });
      expect(result.is_open_access).toBe(true);
    });

    test('articleGet() with PMID and oa section reuses the PMCID from the PubMed XML (no IDConv call)', async () => {
      global.fetch = jest.fn<(...args: any[]) => any>()
        .mockResolvedValueOnce({
          ok: true,
          headers: new Headers({ 'content-type': 'text/xml' }),
          text: () => Promise.resolve(SINGLE_ARTICLE_XML),
        })
        .mockResolvedValueOnce({
          ok: true,
          headers: new Headers({ 'content-type': 'application/json' }),
          json: () => Promise.resolve(epmcSearchHit(epmcCoreRecord())),
        }) as any;

      const result = await articleGet('12345', ['oa']);

      // The PubMed XML carries ArticleId IdType="pmc" — IDConv is skipped
      expect(global.fetch).toHaveBeenCalledTimes(2);
      const epmcUrl = (global.fetch as any).mock.calls[1][0] as string;
      expect(epmcUrl).toContain('PMCID%3APMC9999999');

      expect(result.sections?.open_access).toMatchObject({ status: 'open_access', pmcid: 'PMC9999999' });
    });

    test('articleGet() with PMID and oa section resolves the PMCID via IDConv when the PubMed XML lacks it', async () => {
      global.fetch = jest.fn<(...args: any[]) => any>()
        .mockResolvedValueOnce({
          ok: true,
          headers: new Headers({ 'content-type': 'text/xml' }),
          text: () => Promise.resolve(MINIMAL_ARTICLE_XML_NO_PMC),
        })
        .mockResolvedValueOnce({
          ok: true,
          headers: new Headers({ 'content-type': 'application/json' }),
          json: () => Promise.resolve({
            status: 'ok',
            records: [{ pmcid: 'PMC9999999', pmid: 12345 }],
          }),
        })
        .mockResolvedValueOnce({
          ok: true,
          headers: new Headers({ 'content-type': 'application/json' }),
          json: () => Promise.resolve(epmcSearchHit(epmcCoreRecord())),
        }) as any;

      const result = await articleGet('12345', ['oa']);

      expect(global.fetch).toHaveBeenCalledTimes(3);
      const idConvUrl = (global.fetch as any).mock.calls[1][0] as string;
      expect(idConvUrl).toContain('ids=12345');
      expect(idConvUrl).toContain('idconv');

      expect(result.sections?.open_access).toMatchObject({ status: 'open_access', pmcid: 'PMC9999999' });
    });

    test('fetchOpenAccess classifies open_access records and keeps only machine-fetchable PDFs', async () => {
      global.fetch = jest.fn<(...args: any[]) => any>()
        .mockResolvedValue({
          ok: true,
          headers: new Headers({ 'content-type': 'application/json' }),
          json: () => Promise.resolve(epmcSearchHit(epmcCoreRecord())),
        }) as any;

      const result = await fetchOpenAccess('PMC9999999', '10.1234/test.2018');

      expect(global.fetch).toHaveBeenCalledTimes(1);
      const epmcUrl = (global.fetch as any).mock.calls[0][0] as string;
      expect(epmcUrl).toContain('europepmc');
      expect(epmcUrl).toContain('PMCID%3APMC9999999');

      // Unpaywall pdf kept; the bot-gated Europe_PMC ?pdf=render link must
      // NOT become pdf_url (it 403s non-browser clients — live-verified).
      expect(result.links?.pdf_url).toBe('https://example.com/paper.pdf');
      expect(result.status).toBe('open_access');
      expect(result.full_text_available).toBe(true);
      expect(result.is_open_access).toBe(true);
      expect(result.license).toBe('cc by');
      expect(result.license_url).toBe('https://creativecommons.org/licenses/by/4.0/');
      expect(result.links?.pmc_url).toBe('https://pmc.ncbi.nlm.nih.gov/articles/PMC9999999/');
      expect(result.links?.doi_url).toBe('https://doi.org/10.1234/test.2018');
    });

    test('fetchOpenAccess classifies free-to-read records (isOpenAccess=N, no license)', async () => {
      // Live-verified Cell 2025 shape: Free links but isOpenAccess N, and
      // the only pdf link is the bot-gated Europe PMC render.
      const freeRecord = {
        pmcid: 'PMC12774453',
        isOpenAccess: 'N',
        inPMC: 'Y',
        inEPMC: 'Y',
        fullTextUrlList: {
          fullTextUrl: [
            { availability: 'Subscription required', documentStyle: 'doi', site: 'DOI', url: 'https://doi.org/10.1016/j.cell.2025.11.036' },
            { availability: 'Free', documentStyle: 'html', site: 'Europe_PMC', url: 'https://europepmc.org/articles/PMC12774453' },
            { availability: 'Free', documentStyle: 'pdf', site: 'Europe_PMC', url: 'https://europepmc.org/articles/PMC12774453?pdf=render' },
          ],
        },
      };
      global.fetch = jest.fn<(...args: any[]) => any>()
        .mockResolvedValue({
          ok: true,
          headers: new Headers({ 'content-type': 'application/json' }),
          json: () => Promise.resolve(epmcSearchHit(freeRecord)),
        }) as any;

      const result = await fetchOpenAccess('PMC12774453', '10.1016/j.cell.2025.11.036');

      expect(result.status).toBe('free_to_read');
      expect(result.full_text_available).toBe(true);
      expect(result.is_open_access).toBe(false);
      expect(result.license).toBeUndefined();
      // Europe_PMC render links are browser-only: no pdf_url here
      expect(result.links?.pdf_url).toBeUndefined();
      expect(result.note).toContain('publisher copyright');
    });

    test('fetchOpenAccess reports paywalled for in-PMC records without free links', async () => {
      const paywalledRecord = {
        pmcid: 'PMC9999999',
        isOpenAccess: 'N',
        inPMC: 'Y',
        inEPMC: 'Y',
        fullTextUrlList: {
          fullTextUrl: [{ availability: 'Subscription required', documentStyle: 'doi', site: 'DOI', url: 'https://doi.org/10.1/x' }],
        },
      };
      global.fetch = jest.fn<(...args: any[]) => any>()
        .mockResolvedValue({
          ok: true,
          headers: new Headers({ 'content-type': 'application/json' }),
          json: () => Promise.resolve(epmcSearchHit(paywalledRecord)),
        }) as any;

      const result = await fetchOpenAccess('PMC9999999');

      expect(result.status).toBe('paywalled');
      expect(result.full_text_available).toBe(false);
      expect(result.note).toContain('not free to read');
    });

    test('fetchOpenAccess reports unknown when Europe PMC has no record for a valid PMCID', async () => {
      global.fetch = jest.fn<(...args: any[]) => any>()
        .mockResolvedValue({
          ok: true,
          headers: new Headers({ 'content-type': 'application/json' }),
          json: () => Promise.resolve({ hitCount: 0, resultList: { result: [] } }),
        }) as any;

      const result = await fetchOpenAccess('PMC9999999');

      // PMCID verified upstream, so this is a data gap — never not_in_pmc
      expect(result.status).toBe('unknown');
      expect(result.full_text_available).toBe(false);
      expect(result._error).toBeUndefined();
      expect(result.links?.pmc_url).toBeDefined();
    });

    test('fetchOpenAccess surfaces _error when the Europe PMC search fails at transport level', async () => {
      // Persistent failure mock: the europepmc connection retries 5xx
      // (3 attempts), so mockResolvedValueOnce chains would be consumed.
      global.fetch = jest.fn<(...args: any[]) => any>().mockResolvedValue({
        ok: false,
        status: 503,
        statusText: 'Service Unavailable',
        headers: new Headers({ 'content-type': 'text/html' }),
        text: () => Promise.resolve('down'),
      }) as any;

      const result = await fetchOpenAccess('PMC9999999');

      expect((result as any)._error).toContain('Open access lookup failed');
      expect((result as any)._error).toContain('503');
    }, 30000);

    test('articleGet() with oa section reports not_in_pmc when neither PubMed XML nor IDConv has a PMCID', async () => {
      global.fetch = jest.fn<(...args: any[]) => any>()
        .mockResolvedValueOnce({
          ok: true,
          headers: new Headers({ 'content-type': 'text/xml' }),
          text: () => Promise.resolve(MINIMAL_ARTICLE_XML_NO_PMC),
        })
        .mockResolvedValueOnce({
          ok: true,
          headers: new Headers({ 'content-type': 'application/json' }),
          json: () => Promise.resolve({
            status: 'ok',
            records: [{ pmid: 12345 }],
          }),
        }) as any;

      const result = await articleGet('12345', ['oa']);

      expect(global.fetch).toHaveBeenCalledTimes(2);
      expect(result.sections?.open_access).toMatchObject({ status: 'not_in_pmc', full_text_available: false });
      expect(result.is_open_access).toBeUndefined();
    });

    test('articleGet() with doi: prefix resolves correctly', async () => {
      global.fetch = jest.fn<(...args: any[]) => any>()
        .mockResolvedValueOnce({
          ok: true,
          headers: new Headers({ 'content-type': 'application/json' }),
          json: () => Promise.resolve({
            status: 'ok',
            records: [{ doi: '10.1234/test.2018', pmid: 12345 }],
          }),
        })
        .mockResolvedValueOnce({
          ok: true,
          headers: new Headers({ 'content-type': 'text/xml' }),
          text: () => Promise.resolve(SINGLE_ARTICLE_XML),
        }) as any;

      const result = await articleGet('doi:10.1234/test.2018');

      const idConvUrl = (global.fetch as any).mock.calls[0][0] as string;
      expect(idConvUrl).toContain('ids=10.1234');
      expect(idConvUrl).not.toContain('doi:');
      expect(result.pmid).toBe('12345');
    });

    test('articleGet() with DOI that fails IDConv falls back to PubMed esearch', async () => {
      global.fetch = jest.fn<(...args: any[]) => any>()
        .mockResolvedValueOnce({
          ok: true,
          headers: new Headers({ 'content-type': 'application/json' }),
          json: () => Promise.resolve({
            status: 'ok',
            records: [],
          }),
        })
        .mockResolvedValueOnce({
          ok: true,
          headers: new Headers({ 'content-type': 'application/json' }),
          json: () => Promise.resolve({
            esearchresult: { idlist: ['12345'] },
          }),
        })
        .mockResolvedValueOnce({
          ok: true,
          headers: new Headers({ 'content-type': 'text/xml' }),
          text: () => Promise.resolve(SINGLE_ARTICLE_XML),
        }) as any;

      const result = await articleGet('10.9999/nonexistent');

      expect(result.pmid).toBe('12345');
      expect(global.fetch).toHaveBeenCalledTimes(3);
    });

    test('articleGet() with DOI that fails both IDConv and PubMed esearch throws', async () => {
      global.fetch = jest.fn<(...args: any[]) => any>().mockResolvedValue({
        ok: true,
        headers: new Headers({ 'content-type': 'application/json' }),
        json: () => Promise.resolve({
          status: 'ok',
          records: [],
        }),
      }) as any;

      await expect(articleGet('10.9999/nonexistent')).rejects.toThrow('Could not resolve doi');
    });

    test('articleGet() with DOI that returns error status without errmsg throws', async () => {
      global.fetch = jest.fn<(...args: any[]) => any>()
        .mockResolvedValueOnce({
          ok: true,
          headers: new Headers({ 'content-type': 'application/json' }),
          json: () => Promise.resolve({
            status: 'ok',
            records: [{
              doi: '10.9999/nonexistent',
              requestedId: '10.9999/nonexistent',
              status: 'error',
            }],
          }),
        })
        .mockResolvedValueOnce({
          ok: true,
          headers: new Headers({ 'content-type': 'application/json' }),
          json: () => Promise.resolve({
            status: 'ok',
            records: [],
          }),
        }) as any;

      await expect(articleGet('10.9999/nonexistent')).rejects.toThrow('Could not resolve doi');
    });

    test('articleGet() with fulltext section reports no_pmcid honestly when the article is not in PMC', async () => {
      global.fetch = jest.fn<(...args: any[]) => any>()
        .mockResolvedValueOnce({
          ok: true,
          headers: new Headers({ 'content-type': 'text/xml' }),
          text: () => Promise.resolve(MINIMAL_ARTICLE_XML_NO_PMC),
        })
        .mockResolvedValueOnce({
          ok: true,
          headers: new Headers({ 'content-type': 'application/json' }),
          json: () => Promise.resolve({
            status: 'ok',
            records: [{ pmid: 12345, status: 'error', errmsg: 'not found' }],
          }),
        }) as any;

      // No PMCID in any fixture, so the unavailable envelope short-circuits
      // before writeFullTextFile — no cache-dir isolation needed here; if the
      // fixture ever gains a PMCID, move this into the isolated fulltext
      // describe below.
      const result = await articleGet('12345', ['fulltext']);

      expect(global.fetch).toHaveBeenCalledTimes(2);
      const ft = result.sections?.fulltext as any;
      expect(ft).toMatchObject({ status: 'unavailable', reason: 'no_pmcid' });
      // the implied oa lookup's classification is echoed standalone:
      // not_in_pmc, not paywalled — distinguishable without sections=["oa"]
      expect(ft.oa_status).toBe('not_in_pmc');
      expect(ft.links?.doi_url).toBe('https://doi.org/10.1234/test.2018');
      expect(ft.note).toContain('abstract');
      // fulltext implies the oa metadata lookup, but no open_access section
      // is stored unless explicitly requested
      expect(result.sections?.open_access).toBeUndefined();
    });

    test('articleGet() with sections=["all"] fetches all sections but NEVER fulltext', async () => {
      const emptyJsonResponse = {
        ok: true,
        headers: new Headers({ 'content-type': 'application/json' }),
        json: () => Promise.resolve({}),
      };
      // Sections run in parallel — route by hostname/path, never by call order.
      global.fetch = jest.fn((url: unknown) => {
        const { hostname, pathname, searchParams } = parseMockUrl(url);
        if (hostname === 'eutils.ncbi.nlm.nih.gov' && pathname.endsWith('/efetch.fcgi') && searchParams.get('db') === 'pubmed') {
          return Promise.resolve({ ok: true, headers: new Headers({ 'content-type': 'text/xml' }), text: () => Promise.resolve(SINGLE_ARTICLE_XML) });
        }
        if (hostname === 'www.ebi.ac.uk' && pathname.endsWith('/search')) {
          return Promise.resolve({ ok: true, headers: new Headers({ 'content-type': 'application/json' }), json: () => Promise.resolve(epmcSearchHit(epmcCoreRecord())) });
        }
        return Promise.resolve(emptyJsonResponse);
      }) as any;

      const result = await articleGet('12345', ['all']);

      expect((global.fetch as any).mock.calls.length).toBeGreaterThanOrEqual(5);
      expect(result.sections).toBeDefined();
      expect(result.sections).toHaveProperty('open_access');
      expect(result.sections).toHaveProperty('annotations');
      expect(result.sections).toHaveProperty('citation_graph');
      expect(result.sections).toHaveProperty('citation');
      // Full text is opt-in ONLY — "all" never triggers the XML fetch nor
      // emits a fulltext section.
      expect(result.sections!.fulltext).toBeUndefined();
      const fulltextCalls = (global.fetch as any).mock.calls.map((c: any) => String(c[0])).filter((u: any) => u.includes('fullTextXML') || u.includes('db=pmc'));
      expect(fulltextCalls).toHaveLength(0);
    }, 30000);


    test('articleGet() with sections=["fulltext"] inline mode uses the cap and shares the oa lookup', async () => {
      global.fetch = jest.fn((url: unknown) => {
        const { hostname, pathname } = parseMockUrl(url);
        if (hostname === 'eutils.ncbi.nlm.nih.gov' && pathname.endsWith('/efetch.fcgi')) {
          return Promise.resolve({ ok: true, headers: new Headers({ 'content-type': 'text/xml' }), text: () => Promise.resolve(SINGLE_ARTICLE_XML) });
        }
        if (hostname === 'www.ebi.ac.uk' && pathname.endsWith('/search')) {
          return Promise.resolve({ ok: true, headers: new Headers({ 'content-type': 'application/json' }), json: () => Promise.resolve(epmcSearchHit(epmcCoreRecord())) });
        }
        if (hostname === 'www.ebi.ac.uk' && pathname.endsWith('/fullTextXML')) {
          return Promise.resolve({ ok: true, headers: new Headers({ 'content-type': 'text/xml' }), text: () => Promise.resolve(JATS_FULLTEXT_XML) });
        }
        return Promise.reject(new Error(`unexpected url ${url}`));
      }) as any;

      const result = await articleGet('12345', ['fulltext'], { fulltextMaxChars: 5000, fulltextOutput: 'inline' });

      expect(global.fetch).toHaveBeenCalledTimes(3);
      const ft = result.sections?.fulltext as any;
      expect(ft.status).toBe('available');
      expect(ft.max_chars).toBe(5000);
      expect(ft.is_open_access).toBe(true);
      expect(ft.oa_status).toBe('open_access');
      // one shared Europe PMC search backs oa metadata + fulltext header
      expect(result.sections?.open_access).toBeUndefined();
      expect(result.is_open_access).toBe(true);
    });

    test('articleGet() with DOI where IDConv record has no pmid throws', async () => {
      global.fetch = jest.fn<(...args: any[]) => any>().mockResolvedValue({
        ok: true,
        headers: new Headers({ 'content-type': 'application/json' }),
        json: () => Promise.resolve({
          status: 'ok',
          records: [{ doi: '10.9999/x', pmcid: 'PMC123' }],
        }),
      }) as any;

      await expect(articleGet('10.9999/x')).rejects.toThrow('Could not resolve doi');
    });

    test('articleGet() with oa section returns license information from the Europe PMC record', async () => {
      global.fetch = jest.fn<(...args: any[]) => any>()
        .mockResolvedValueOnce({
          ok: true,
          headers: new Headers({ 'content-type': 'text/xml' }),
          text: () => Promise.resolve(SINGLE_ARTICLE_XML),
        })
        .mockResolvedValueOnce({
          ok: true,
          headers: new Headers({ 'content-type': 'application/json' }),
          json: () => Promise.resolve(epmcSearchHit(epmcCoreRecord({ license: 'cc by-nc' }))),
        }) as any;

      const result = await articleGet('12345', ['oa']);

      expect(result.sections?.open_access).toMatchObject({
        pmcid: 'PMC9999999',
        license: 'cc by-nc',
        license_url: 'https://creativecommons.org/licenses/by-nc/4.0/',
        status: 'open_access',
      });
    });
  });

  describe('licenseToUrl', () => {
    test('maps CC license names to their 4.0 URLs by default', () => {
      const licenses = ['cc0', 'cc by', 'cc by-nc', 'cc by-nc-nd', 'cc by-nc-sa', 'cc by-nd', 'cc by-sa'];
      for (const license of licenses) {
        expect(licenseToUrl(license)).toBeDefined();
      }
      expect(licenseToUrl('cc by')).toBe('https://creativecommons.org/licenses/by/4.0/');
      expect(licenseToUrl('CC BY-NC')).toBe('https://creativecommons.org/licenses/by-nc/4.0/');
    });

    test('keeps the declared license version when present', () => {
      expect(licenseToUrl('CC BY 3.0')).toBe('https://creativecommons.org/licenses/by/3.0/');
      expect(licenseToUrl('cc by-nc-sa 2.5')).toBe('https://creativecommons.org/licenses/by-nc-sa/2.5/');
    });

    test('returns undefined for unknown license strings', () => {
      expect(licenseToUrl('some publisher agreement')).toBeUndefined();
    });
  });

  describe('fulltext section', () => {
    let fulltextCacheDir: string | undefined;

    beforeEach(() => {
      // File-mode writes must never touch the real ~/.cache/biomcp
      fulltextCacheDir = process.env.BIOMCP_CACHE_DIR;
      process.env.BIOMCP_CACHE_DIR = mkdtempSync(join(tmpdir(), 'biomcp-ft-'));
    });

    afterEach(() => {
      if (fulltextCacheDir === undefined) delete process.env.BIOMCP_CACHE_DIR;
      else process.env.BIOMCP_CACHE_DIR = fulltextCacheDir;
      try {
        rmSync(process.env.BIOMCP_CACHE_DIR ?? join(tmpdir(), 'biomcp-ft-'), { recursive: true, force: true });
      } catch {
        void 0;
      }
    });

    const xmlResponse = (xml: string) => ({
      ok: true,
      headers: new Headers({ 'content-type': 'text/xml' }),
      text: () => Promise.resolve(xml),
    });
    const failingResponse = (status: number) => ({
      ok: false,
      status,
      statusText: 'Error',
      headers: new Headers({ 'content-type': 'text/html' }),
      text: () => Promise.resolve('error'),
    });

    test('fetchFullText fetches Europe PMC fullTextXML and parses sections', async () => {
      global.fetch = jest.fn<(...args: any[]) => any>().mockResolvedValue(xmlResponse(JATS_FULLTEXT_XML)) as any;

      const result = await fetchFullText('PMC9999999', { oa: OA_OPEN, output: 'inline' });

      expect(global.fetch).toHaveBeenCalledTimes(1);
      const url = (global.fetch as any).mock.calls[0][0] as string;
      expect(url).toContain('/PMC9999999/fullTextXML');
      expect(result.status).toBe('available');
      expect(result.source).toBe('europepmc');
      expect(result.format).toBe('jats-xml');
      expect(result.is_open_access).toBe(true);
      expect(result.oa_status).toBe('open_access');
      expect(result.license).toBe('cc by');
      expect(result.truncated).toBe(false);
      const headings = (result.sections ?? []).map(s => s.heading);
      expect(headings).toEqual(['Introduction', 'Results', 'Results — Mutation effects', 'Acknowledgments']);
      expect(result.sections?.[0].text).toContain('H(+)'); // <sup> -> parentheses
      expect(result.sections?.[0].text).toContain('4 μM');
      expect(result.sections?.[1].text).toContain('[Figure 1]'); // fig -> placeholder
      // reference list dropped; note points at the citation section
      expect(result.note).toContain('sections=["citation"]');
    });

    test('fetchFullText falls back to eutils efetch db=pmc when Europe PMC fails', async () => {
      // Live-verified: Europe PMC answers HTTP 500 (deterministic) for
      // free-to-read records its fullTextXML endpoint cannot serve.
      global.fetch = jest.fn((url: unknown) => {
        const { hostname } = parseMockUrl(url);
        if (hostname === 'www.ebi.ac.uk') return Promise.resolve(failingResponse(500));
        if (hostname === 'eutils.ncbi.nlm.nih.gov') return Promise.resolve(xmlResponse(PMC_ARTICLESET_XML));
        return Promise.reject(new Error(`unexpected url ${url}`));
      }) as any;

      const result = await fetchFullText('PMC9999999', { oa: OA_OPEN, output: 'inline' });

      const eutilsUrl = (global.fetch as any).mock.calls.map((c: any) => String(c[0])).find((u: any) => u.includes('efetch.fcgi'));
      expect(eutilsUrl).toContain('db=pmc');
      expect(eutilsUrl).toContain('id=9999999'); // PMC prefix stripped
      expect(result.status).toBe('available');
      expect(result.source).toBe('eutils');
      expect(result.sections?.length).toBeGreaterThan(0);
    }, 30000);

    test('fetchFullText reports fetch_failed when both legs fail', async () => {
      global.fetch = jest.fn<(...args: any[]) => any>().mockResolvedValue(failingResponse(500)) as any;

      const result = await fetchFullText('PMC9999999', { oa: OA_OPEN });

      expect(result.status).toBe('unavailable');
      expect(result.reason).toBe('fetch_failed');
      expect(result.note).toContain('retry');
      expect(result._error).toBeUndefined();
    }, 30000);

    test('fetchFullText skips upstream calls for paywalled records', async () => {
      global.fetch = jest.fn() as any;

      const result = await fetchFullText('PMC9999999', { oa: { ...OA_OPEN, status: 'paywalled', full_text_available: false } });

      expect(global.fetch).not.toHaveBeenCalled();
      expect(result.status).toBe('unavailable');
      expect(result.reason).toBe('paywalled');
      // oa classification is echoed standalone: paywalled is visible
      // without requesting the oa section
      expect(result.oa_status).toBe('paywalled');
      expect(result.note).toContain('not free to read');
      // no DOI known -> the note must not point at a nonexistent links.doi_url
      expect(result.note).not.toContain('doi_url');

      const withDoi = await fetchFullText('PMC9999999', { oa: { ...OA_OPEN, status: 'paywalled', full_text_available: false }, doi: '10.1234/x' });
      expect(withDoi.note).toContain('doi_url');
      expect(withDoi.links?.doi_url).toBe('https://doi.org/10.1234/x');
    });

    test('fetchFullText reports no_pmcid without upstream calls', async () => {
      global.fetch = jest.fn() as any;

      const result = await fetchFullText(undefined, { doi: '10.1234/x' });

      expect(global.fetch).not.toHaveBeenCalled();
      expect(result.status).toBe('unavailable');
      expect(result.reason).toBe('no_pmcid');
      expect(result.links?.doi_url).toBe('https://doi.org/10.1234/x');
    });

    test('fetchFullText reports no_machine_readable_xml for front-only records', async () => {
      const frontOnly = '<?xml version="1.0"?><article><front><article-meta><title>x</title></article-meta></front></article>';
      global.fetch = jest.fn<(...args: any[]) => any>().mockResolvedValue(xmlResponse(frontOnly)) as any;

      const result = await fetchFullText('PMC9999999', { oa: OA_OPEN });

      expect(result.status).toBe('unavailable');
      expect(result.reason).toBe('no_machine_readable_xml');
    });

    test('fetchFullText truncates honestly with per-section flags and omitted sections', async () => {
      global.fetch = jest.fn<(...args: any[]) => any>().mockResolvedValue(xmlResponse(JATS_FULLTEXT_XML)) as any;

      // Clamped to the 1000-char floor; the fixture introduction is ~1300 chars
      const result = await fetchFullText('PMC9999999', { oa: OA_OPEN, maxChars: 250, output: 'inline' });

      expect(result.max_chars).toBe(1000);
      expect(result.truncated).toBe(true);
      expect(result.total_char_count).toBeGreaterThan(result.char_count!);
      expect(result.sections?.length).toBe(1);
      expect(result.sections?.[0].truncated).toBe(true);
      expect(result.sections?.[0].text.endsWith('…')).toBe(true);
      expect(result.omitted_sections).toEqual(['Results', 'Results — Mutation effects', 'Acknowledgments']);
      expect(result.note).toContain('fulltext_max_chars=200000');
    });

    test('fetchFullText file mode (default) writes markdown and returns a handle, never the body', async () => {
      global.fetch = jest.fn<(...args: any[]) => any>().mockResolvedValue(xmlResponse(JATS_FULLTEXT_XML)) as any;

      const result = await fetchFullText('PMC9999999', { oa: OA_OPEN, pmid: '12345', title: 'A test title' });

      expect(result.mode).toBe('file');
      expect(result.format).toBe('markdown');
      expect(result.status).toBe('available');
      expect(result.oa_status).toBe('open_access');
      expect(result.file_path).toBeDefined();
      expect(existsSync(result.file_path!)).toBe(true);
      expect(result.sections).toBeUndefined(); // the body never enters the reply
      expect(result.max_chars).toBe(0);
      expect(result.pmid).toBe('12345');
      expect(result.title).toBe('A test title');
      expect(result.note).toContain('fulltext_output="inline"');
      expect(result.note).toContain('sections=["citation"]');
      expect(result.note).toContain('offset/limit or grep');
      expect(result.note).toContain('pruned after ~24h');

      // The file: front matter, single-line title, headings at the outline lines
      const content = readFileSync(result.file_path!, 'utf8');
      expect(content.startsWith('---\n')).toBe(true);
      expect(content).toContain('pmcid: PMC9999999');
      expect(content).toContain('pmid: "12345"');
      expect(content).toContain('title: "A test title"');
      expect(content).toContain('# A test title');
      const fileLines = content.split('\n');
      for (const entry of result.outline ?? []) {
        expect(fileLines[entry.line - 1]).toBe(`## ${entry.heading}`);
        expect(entry.chars).toBeGreaterThan(0);
      }
      expect((result.outline ?? []).map(o => o.heading)).toEqual(
        ['Introduction', 'Results', 'Results — Mutation effects', 'Acknowledgments']
      );
      // body wrapped for line-based agent tools
      const maxLine = Math.max(...fileLines.filter(l => l.length > 0).map(l => l.length));
      expect(maxLine).toBeLessThanOrEqual(130);
    });

    test('fetchFullText file mode normalizes the PMCID and overwrites on re-write', async () => {
      const first = writeFullTextFile({
        pmcid: 'pmc9999999',
        source: 'eutils',
        sections: [{ heading: 'S', text: 'first', truncated: false }],
      });
      expect(first.ok).toBe(true);
      if (first.ok) expect(first.file_path.endsWith('PMC9999999.md')).toBe(true);

      const second = writeFullTextFile({
        pmcid: 'PMC9999999',
        source: 'eutils',
        sections: [{ heading: 'S', text: 'second version', truncated: false }],
      });
      expect(second.ok).toBe(true);
      if (second.ok) expect(second.file_path).toBe(first.ok ? first.file_path : '');
      expect(readdirSync(join(process.env.BIOMCP_CACHE_DIR!, 'fulltext'))).toHaveLength(1);
      expect(readFileSync(join(process.env.BIOMCP_CACHE_DIR!, 'fulltext', 'PMC9999999.md'), 'utf8')).toContain('second version');
    });

    test('fetchFullText file mode falls back to inline when the cache dir is unwritable', async () => {
      global.fetch = jest.fn<(...args: any[]) => any>().mockResolvedValue(xmlResponse(JATS_FULLTEXT_XML)) as any;
      // Point the cache root at a regular file: every fs op under it fails
      const notADir = join(tmpdir(), `biomcp-notadir-${process.pid}`);
      writeFileSync(notADir, 'x');

      const saved = process.env.BIOMCP_CACHE_DIR;
      process.env.BIOMCP_CACHE_DIR = notADir;
      try {
        const result = await fetchFullText('PMC9999999', { oa: OA_OPEN });
        expect(result.mode).toBe('inline');
        expect(result.status).toBe('available');
        expect(result.sections?.length).toBeGreaterThan(0);
        expect(result.note).toContain('File output was requested but unavailable');
      } finally {
        if (saved === undefined) delete process.env.BIOMCP_CACHE_DIR;
        else process.env.BIOMCP_CACHE_DIR = saved;
        rmSync(notADir, { force: true });
      }
    });

    test('articleGet() with sections=["fulltext"] file mode returns a handle for an existing file', async () => {
      global.fetch = jest.fn((url: unknown) => {
        const { hostname, pathname } = parseMockUrl(url);
        if (hostname === 'eutils.ncbi.nlm.nih.gov' && pathname.endsWith('/efetch.fcgi')) {
          return Promise.resolve({ ok: true, headers: new Headers({ 'content-type': 'text/xml' }), text: () => Promise.resolve(SINGLE_ARTICLE_XML) });
        }
        if (hostname === 'www.ebi.ac.uk' && pathname.endsWith('/search')) {
          return Promise.resolve({ ok: true, headers: new Headers({ 'content-type': 'application/json' }), json: () => Promise.resolve(epmcSearchHit(epmcCoreRecord())) });
        }
        if (hostname === 'www.ebi.ac.uk' && pathname.endsWith('/fullTextXML')) {
          return Promise.resolve({ ok: true, headers: new Headers({ 'content-type': 'text/xml' }), text: () => Promise.resolve(JATS_FULLTEXT_XML) });
        }
        return Promise.reject(new Error(`unexpected url ${url}`));
      }) as any;

      const result = await articleGet('12345', ['fulltext']);

      const ft = result.sections?.fulltext as any;
      expect(ft.mode).toBe('file');
      expect(ft.status).toBe('available');
      expect(existsSync(ft.file_path)).toBe(true);
      expect(ft.outline.length).toBeGreaterThan(0);
      expect(ft.sections).toBeUndefined();
      expect(result.is_open_access).toBe(true);
    });

    test('file mode ignores fulltext_max_chars — the file carries the complete text', async () => {
      global.fetch = jest.fn<(...args: any[]) => any>().mockResolvedValue(xmlResponse(JATS_FULLTEXT_XML)) as any;

      const result = await fetchFullText('PMC9999999', { oa: OA_OPEN, maxChars: 1000 });

      expect(result.mode).toBe('file');
      expect(result.char_count).toBe(result.total_char_count);
      expect(result.truncated).toBe(false);
      // the fixture body (~1178 chars) exceeds the inline cap that file
      // mode must ignore
      expect(result.char_count).toBeGreaterThan(1000);
    });

    test('file->inline fallback clamps to the default cap even when a larger inline cap was passed', async () => {
      global.fetch = jest.fn<(...args: any[]) => any>().mockResolvedValue(xmlResponse(JATS_FULLTEXT_XML)) as any;
      const notADir = join(tmpdir(), `biomcp-notadir2-${process.pid}`);
      writeFileSync(notADir, 'x');

      const saved = process.env.BIOMCP_CACHE_DIR;
      process.env.BIOMCP_CACHE_DIR = notADir;
      try {
        const result = await fetchFullText('PMC9999999', { oa: OA_OPEN, maxChars: 200000 });
        expect(result.mode).toBe('inline');
        expect(result.max_chars).toBeLessThanOrEqual(FULLTEXT_DEFAULT_MAX_CHARS);
      } finally {
        if (saved === undefined) delete process.env.BIOMCP_CACHE_DIR;
        else process.env.BIOMCP_CACHE_DIR = saved;
        rmSync(notADir, { force: true });
      }
    });

    test('fetchFullText maps eutils error bodies to retryable fetch_failed, not no_machine_readable_xml', async () => {
      // E-utilities answers some failures HTTP 200 with <eFetchResult><ERROR>
      // (e.g. rate limiting) — that is an upstream failure, not a missing body.
      const eutilError = '<?xml version="1.0"?><eFetchResult><ERROR>Agent exceeded rate limit</ERROR></eFetchResult>';
      global.fetch = jest.fn((url: unknown) => {
        const { hostname } = parseMockUrl(url);
        if (hostname === 'www.ebi.ac.uk') return Promise.resolve(failingResponse(500));
        if (hostname === 'eutils.ncbi.nlm.nih.gov') {
          return Promise.resolve({ ok: true, headers: new Headers({ 'content-type': 'text/xml' }), text: () => Promise.resolve(eutilError) });
        }
        return Promise.reject(new Error(`unexpected url ${url}`));
      }) as any;

      const result = await fetchFullText('PMC9999999', { oa: OA_OPEN });

      expect(result.status).toBe('unavailable');
      expect(result.reason).toBe('fetch_failed');
      expect(result.note).toContain('retry');
    }, 30000);

    test('parseFullTextJats keeps boolean text nodes', () => {
      // preserveOrder converts "true"/"false" text to booleans — paragraphs
      // must not silently vanish.
      const xml = '<?xml version="1.0"?><article><body><sec><title>Flags</title><p>true</p><p>false</p><p>real text</p></sec></body></article>';
      const result = parseFullTextJats(xml, FULLTEXT_DEFAULT_MAX_CHARS);
      expect(result?.sections[0].text).toBe('true\n\nfalse\n\nreal text');
    });

    test('parseFullTextJats keeps numeric citation markers inside xref', () => {
      // preserveOrder mode hands numeric text nodes back as numbers
      // ({"#text": 1}) — they must be stringified, not dropped.
      const xml = '<?xml version="1.0"?><article><body><sec><title>T</title><p>such as diphtheria [<xref rid="B1" ref-type="bibr">1</xref>], botulinum [<xref rid="B2" ref-type="bibr">2</xref>].</p></sec></body></article>';
      const result = parseFullTextJats(xml, FULLTEXT_DEFAULT_MAX_CHARS);
      expect(result?.sections[0].text).toBe('such as diphtheria [1], botulinum [2].');
    });

    test('parseFullTextJats handles the eutils pmc-articleset wrapper', () => {
      const result = parseFullTextJats(PMC_ARTICLESET_XML, FULLTEXT_DEFAULT_MAX_CHARS);
      expect(result).not.toBeNull();
      expect(result!.sections.map(s => s.heading)).toContain('Introduction');
      expect(result!.hasReferences).toBe(true);
    });

    test('parseFullTextJats returns null for error payloads and body-less documents', () => {
      const err = '<?xml version="1.0"?><eFetchResult><ERROR>Supplied id parameter is empty.</ERROR></eFetchResult>';
      expect(parseFullTextJats(err, FULLTEXT_DEFAULT_MAX_CHARS)).toBeNull();
      expect(parseFullTextJats('<?xml version="1.0"?><article><front/></article>', FULLTEXT_DEFAULT_MAX_CHARS)).toBeNull();
    });
  });

  // Issue #121: a trailing full journal name is rewritten to the NLM
  // abbreviation on the pubmed and europepmc journal legs, with a warnings
  // disclosure. The asset map is a small fixture injected through the
  // BIOMCP_JOURNAL_TITLES_PATH env override (the outer beforeEach pins a
  // nonexistent sentinel for every other test in this suite).
  describe('journal name rewrite (trailing full title → NLM abbreviation)', () => {
    let assetDir: string;

    beforeEach(() => {
      assetDir = mkdtempSync(join(tmpdir(), 'biomcp-journal-asset-'));
      const tsv = 'new england journal of medicine\tN Engl J Med\nnature genetics\tNat Genet\n';
      process.env.BIOMCP_JOURNAL_TITLES_PATH = join(assetDir, 'journal-titles.tsv.gz');
      writeFileSync(process.env.BIOMCP_JOURNAL_TITLES_PATH, gzipSync(Buffer.from(tsv, 'utf8')));
      resetJournalTitleMap();
    });

    afterEach(() => {
      rmSync(assetDir, { recursive: true, force: true });
      resetJournalTitleMap(); // the outer afterEach restores the env sentinel
    });

    test('pubmed leg hoists a trailing full journal title into Abbr[Journal] and warns', async () => {
      global.fetch = jest.fn<(...args: any[]) => any>()
        .mockResolvedValueOnce({
          ok: true,
          headers: new Headers({ 'content-type': 'application/json' }),
          json: () => Promise.resolve({ esearchresult: { idlist: ['12345'], count: '1' } }),
        })
        .mockResolvedValueOnce({
          ok: true,
          headers: new Headers({ 'content-type': 'text/xml' }),
          text: () => Promise.resolve(SINGLE_ARTICLE_XML),
        }) as any;

      const response = await searchArticles('Huntington disease New England Journal of Medicine', { source: 'pubmed' });

      const searchCallUrl = (global.fetch as any).mock.calls[0][0] as string;
      expect(searchCallUrl).toContain('esearch.fcgi');
      expect(searchCallUrl).toContain(`term=${encodeURIComponent('Huntington disease N Engl J Med[Journal]')}`);
      expect(searchCallUrl).not.toContain(encodeURIComponent('England'));
      expect(response.warnings).toContain(
        `Journal phrase rewritten: 'New England Journal of Medicine' → 'N Engl J Med[Journal]'.`
      );
    });

    test('europepmc journal leg converts a trailing full title into a JOURNAL clause and warns', async () => {
      global.fetch = jest.fn((url: unknown) => {
        const { hostname, pathname } = parseMockUrl(url);
        if (hostname === 'www.ebi.ac.uk' && pathname.endsWith('/search')) {
          return Promise.resolve({
            ok: true,
            headers: new Headers({ 'content-type': 'application/json' }),
            json: () => Promise.resolve({ resultList: { result: [] } }),
          });
        }
        return Promise.reject(new Error(`unexpected url ${url}`));
      }) as any;

      const response = await searchArticles('Huntington disease New England Journal of Medicine', { source: 'europepmc' });

      const callUrl = (global.fetch as any).mock.calls[0][0] as string;
      expect(callUrl).toContain(`query=${encodeURIComponent('(Huntington disease) AND JOURNAL:"N Engl J Med"')}`);
      expect(response.warnings).toContain(
        `Journal phrase rewritten: 'New England Journal of Medicine' → 'JOURNAL:"N Engl J Med"'.`
      );
    });

    test('whole-query journal name rewrites to the bare journal constraint', async () => {
      global.fetch = jest.fn<(...args: any[]) => any>().mockResolvedValue({
        ok: true,
        headers: new Headers({ 'content-type': 'application/json' }),
        json: () => Promise.resolve({ esearchresult: { idlist: [] } }),
      }) as any;

      await searchArticles('New England Journal of Medicine', { source: 'pubmed' });

      const searchCallUrl = (global.fetch as any).mock.calls[0][0] as string;
      expect(searchCallUrl).toContain(`term=${encodeURIComponent('N Engl J Med[Journal]')}`);
    });

    test('query with no trailing journal name is sent verbatim, with no warning', async () => {
      global.fetch = jest.fn<(...args: any[]) => any>().mockResolvedValue({
        ok: true,
        headers: new Headers({ 'content-type': 'application/json' }),
        json: () => Promise.resolve({ esearchresult: { idlist: [] } }),
      }) as any;

      const response = await searchArticles('Huntington disease', { source: 'pubmed' });

      const searchCallUrl = (global.fetch as any).mock.calls[0][0] as string;
      expect(searchCallUrl).toContain(`term=${encodeURIComponent('Huntington disease')}`);
      expect(response.warnings).toBeUndefined();
    });

    test('preprint path is untouched even when the query ends with a journal name', async () => {
      global.fetch = jest.fn((url: unknown) => {
        const { hostname, pathname } = parseMockUrl(url);
        if (hostname === 'www.ebi.ac.uk' && pathname.endsWith('/search')) {
          return Promise.resolve({
            ok: true,
            headers: new Headers({ 'content-type': 'application/json' }),
            json: () => Promise.resolve({ resultList: { result: [] } }),
          });
        }
        return Promise.reject(new Error(`unexpected url ${url}`));
      }) as any;

      const response = await searchArticles('Huntington disease New England Journal of Medicine', { source: 'preprint_only' });

      const callUrl = (global.fetch as any).mock.calls[0][0] as string;
      expect(callUrl).toContain(encodeURIComponent('(Huntington disease New England Journal of Medicine'));
      expect(callUrl).toContain(encodeURIComponent('SRC:PPR'));
      expect(callUrl).not.toContain(encodeURIComponent('JOURNAL:"'));
      expect(response.warnings).toBeUndefined();
    });
  });
});

describe('preprint source (bioRxiv/medRxiv via preprint_only)', () => {
  mockGlobalFetch();

  beforeEach(() => {
    jest.clearAllMocks();
    connectionManager.closeAll();
    process.env.NCBI_API_KEY = '';
    // biorxiv pacing (registry intervalMs=1000, capacity-1 bucket) and retry
    // backoffs sleep on module timers — run the whole describe on a fake
    // clock (installed after closeAll so lazily constructed limiters see the
    // fake now) and await via advanceUntilSettled.
    installFakeTimers();
  });

  afterEach(() => {
    delete process.env.NCBI_API_KEY;
    jest.useRealTimers();
    // fresh limiters for later suites (they were constructed against the fake clock)
    connectionManager.closeAll();
  });

  const jsonResponse = (body: unknown) => ({
    ok: true,
    headers: new Headers({ 'content-type': 'application/json' }),
    json: () => Promise.resolve(body),
  });

  const preprintCorePage = (n: number) => ({
    resultList: {
      result: Array.from({ length: n }, (_, i) => ({
        id: `PPR${1000000 + i}`,
        source: 'PPR',
        doi: `10.1101/2025.05.19.65489${i}`,
        title: `Preprint ${i}`,
        authorString: 'Zhang W, Li H',
        abstractText: `Abstract ${i}`,
        firstPublicationDate: '2025-05-19',
        citedByCount: i,
        isOpenAccess: 'Y',
        bookOrReportDetails: { publisher: i % 2 === 0 ? 'bioRxiv' : 'medRxiv' },
      })),
    },
  });

  const biorxivDetailsPayload = (server: string, versions: string[] = ['1', '2']) => ({
    messages: [{ status: 'ok' }],
    collection: versions.map(v => ({
      doi: '10.1101/2025.03.05.641768',
      title: 'Rationality self-organizes beyond subjective reasonings',
      authors: 'Yonekura, S.; Kanazawa, H.',
      author_corresponding: 'Shogo Yonekura',
      author_corresponding_institution: 'The University of Tokyo',
      date: v === '1' ? '2025-03-05' : '2025-09-10',
      version: v,
      type: 'new results',
      license: 'cc_by',
      category: 'neuroscience',
      jatsxml: 'https://www.biorxiv.org/content/early/2025/03/05/2025.03.05.641768.source.xml',
      abstract: 'The somatic marker hypothesis proposes…',
      funder: [{ name: 'JST', id: 'https://ror.org/04yrw5x43', 'id-type': 'ROR', award: 'JPMJCR' }],
      published: 'NA',
      server,
    })),
  });

  const epmcCorePayload = {
    resultList: {
      result: [{
        id: 'PPR910295',
        source: 'PPR',
        doi: '10.1101/2021.10.25.465764',
        title: 'The preprint title',
        authorString: 'Al-okaily, A, Tbakhi, A',
        abstractText: 'The preprint abstract',
        firstPublicationDate: '2021-10-26',
        citedByCount: 44,
        isOpenAccess: 'Y',
        bookOrReportDetails: { publisher: 'bioRxiv' },
        commentCorrectionList: { commentCorrection: [{ source: 'MED', id: '32015507', type: 'Preprint of' }] },
      }],
    },
  };

  // Shared fetch router for the preprint citation-section tests: full happy
  // path (official details + /pubs soft miss + both PPR endpoints + EPMC
  // core) with three records per PPR direction so limit slicing is visible.
  const pprCitationRouter = () => jest.fn((url: unknown) => {
    const u = String(url);
    const { hostname, pathname } = parseMockUrl(u);
    if (hostname === 'api.biorxiv.org' && pathname.startsWith('/details/biorxiv/')) return Promise.resolve(jsonResponse(biorxivDetailsPayload('bioRxiv', ['1'])));
    if (hostname === 'api.biorxiv.org' && pathname.startsWith('/pubs/')) return Promise.resolve(jsonResponse({ messages: [{ status: 'no posts found' }], collection: [] }));
    if (u.includes('/PPR910295/citations')) {
      return Promise.resolve(jsonResponse({
        hitCount: 3,
        citationList: { citation: [1, 2, 3].map(i => ({ id: String(1000 + i), source: 'MED', title: `Citing paper ${i}`, authorString: 'Doe J', journalTitle: 'Nature', pubYear: '2023' })) },
      }));
    }
    if (u.includes('/PPR910295/references')) {
      return Promise.resolve(jsonResponse({
        hitCount: 3,
        referenceList: { reference: [1, 2, 3].map(i => ({ id: String(2000 + i), source: 'MED', title: `Referenced paper ${i}`, authorString: 'Roe A', journalTitle: 'Science', pubYear: '2019' })) },
      }));
    }
    if (hostname === 'www.ebi.ac.uk') return Promise.resolve(jsonResponse(epmcCorePayload));
    return Promise.reject(new Error(`unexpected url ${u}`));
  });

  const requestedUrls = () => (global.fetch as any).mock.calls.map((c: unknown[]) => String(c[0]));

  test('articleSearch preprint_only builds the PPR publisher query with resultType=core', async () => {
    global.fetch = jest.fn<(...args: any[]) => any>().mockResolvedValue(jsonResponse(preprintCorePage(10))) as any;

    const result = await advanceUntilSettled(articleSearch('crispr', { source: 'preprint_only' }));

    expect(global.fetch).toHaveBeenCalledTimes(1);
    const url = (global.fetch as any).mock.calls[0][0] as string;
    const decoded = decodeURIComponent(url);
    expect(decoded).toContain('SRC:PPR');
    expect(decoded).toContain('PUBLISHER:(bioRxiv OR medRxiv)');
    expect(url).toContain('resultType=core');
    expect(url).toContain('cursorMark=*');

    expect(result).toHaveLength(10);
    expect(result[0].publication_types).toEqual(['preprint']);
    expect(result[0].abstract).toBe('Abstract 0');
    expect(result[0].journal).toBe('bioRxiv');
    expect(result[0].preprint_server).toBe('bioRxiv');
    expect(result[1].journal).toBe('medRxiv');
    expect(result[0].ppr_id).toBe('PPR1000000');
    expect(result[0].source).toBe('preprint_only');
    expect(result[0].authors).toEqual(['Zhang W', 'Li H']);
  });

  test('articleSearch preprint_only applies date range and offset window', async () => {
    global.fetch = jest.fn<(...args: any[]) => any>().mockResolvedValue(jsonResponse(preprintCorePage(10))) as any;

    const result = await advanceUntilSettled(articleSearch('vaccine', { source: 'preprint_only', limit: 3, offset: 5, dateRange: '2025-01-01/2025-12-31' }));

    const url = (global.fetch as any).mock.calls[0][0] as string;
    expect(url).toContain(encodeURIComponent('AND FIRST_PDATE:[2025-01-01 TO 2025-12-31]'));
    expect(url).toContain(`pageSize=${Math.min(3 + 5, 1000)}`);
    // client-side window: rows 5..7 of the 10-row fixture
    expect(result.map(r => r.title)).toEqual(['Preprint 5', 'Preprint 6', 'Preprint 7']);
  });

  test('articleSearch preprint_only date clause is day-granular and follows the PPR wrapper', async () => {
    global.fetch = jest.fn<(...args: any[]) => any>().mockResolvedValue(jsonResponse(preprintCorePage(3))) as any;

    await advanceUntilSettled(articleSearch('vaccine', { source: 'preprint_only', dateRange: '2020-06-15/2021-03-01' }));

    const url = (global.fetch as any).mock.calls[0][0] as string;
    const decoded = decodeURIComponent(url);
    expect(decoded).toContain('(vaccine) AND SRC:PPR AND PUBLISHER:(bioRxiv OR medRxiv) AND FIRST_PDATE:[2020-06-15 TO 2021-03-01]');
  });

  test('articleSearch preprint_only explicit cursorMark takes precedence over offset', async () => {
    global.fetch = jest.fn<(...args: any[]) => any>().mockResolvedValue(jsonResponse(preprintCorePage(6))) as any;

    const result = await advanceUntilSettled(articleSearch('crispr', { source: 'preprint_only', limit: 2, offset: 4, cursorMark: 'AoIIQCC9' }));

    const url = (global.fetch as any).mock.calls[0][0] as string;
    expect(url).toContain('pageSize=2');
    expect(url).toContain('cursorMark=AoIIQCC9');
    expect(url).not.toContain('cursorMark=*');
    // the cursor defines the window start: offset is ignored, rows come
    // from the head of the page with no client-side skip
    expect(result.map(r => r.title)).toEqual(['Preprint 0', 'Preprint 1']);
  });

  test('articleSearch preprint_only empty resultList.result yields []', async () => {
    global.fetch = jest.fn<(...args: any[]) => any>().mockResolvedValue(jsonResponse({ resultList: {} })) as any;

    const result = await advanceUntilSettled(articleSearch('crispr', { source: 'preprint_only' }));

    expect(global.fetch).toHaveBeenCalledTimes(1);
    expect(result).toEqual([]);
  });

  test('articleSearch preprint_only surfaces transport failure as an envelope error (#87)', async () => {
    global.fetch = jest.fn<(...args: any[]) => any>().mockRejectedValue(new Error('network down')) as any;

    const response = await advanceUntilSettled(searchArticles('crispr', { source: 'preprint_only' }));

    expect(response.results).toEqual([]);
    expect(response.errors).toHaveLength(1);
    expect(response.errors![0].source).toBe('preprint_only');
    expect(response.errors![0].message).toContain('searchPreprints failed');
  });

  test('isPreprintDoi classifies both prefixes and rejects journal DOIs', () => {
    expect(isPreprintDoi('10.1101/2025.03.05.641768')).toBe(true);
    expect(isPreprintDoi('10.1101/2021.10.25.465764')).toBe(true);
    expect(isPreprintDoi('10.64898/2026.08.11.744243')).toBe(true);
    // CSHL Press journal shares the 10.1101 prefix — must NOT classify
    expect(isPreprintDoi('10.1101/gr.123456')).toBe(false);
    expect(isPreprintDoi('10.1038/s41586-021-03819-2')).toBe(false);
    expect(isPreprintDoi('10.1101/2025.03')).toBe(false);
  });

  test('articleGet on preprint DOI builds record from official API + EPMC enrichment', async () => {
    global.fetch = jest.fn((url: unknown) => {
      const u = String(url);
      const { hostname, pathname } = parseMockUrl(u);
      // duplicate version numbers exercise the dedupe path
      if (hostname === 'api.biorxiv.org' && pathname.startsWith('/details/biorxiv/')) return Promise.resolve(jsonResponse({ ...biorxivDetailsPayload('bioRxiv'), collection: [...biorxivDetailsPayload('bioRxiv').collection, { ...biorxivDetailsPayload('bioRxiv').collection[0] }] }));
      if (hostname === 'api.biorxiv.org' && pathname.startsWith('/pubs/')) {
        return Promise.resolve(jsonResponse({
          messages: [{ status: 'ok' }],
          collection: [{ preprint_doi: '10.1101/2025.03.05.641768', published_doi: '10.3389/fbinf.2025.1577324', published_journal: 'Frontiers in Bioinformatics', published_date: '2025-09-04', preprint_date: '2025-03-05' }],
        }));
      }
      if (hostname === 'www.ebi.ac.uk') return Promise.resolve(jsonResponse(epmcCorePayload));
      return Promise.reject(new Error(`unexpected url ${u}`));
    }) as any;

    const result = await advanceUntilSettled(articleGet('10.1101/2025.03.05.641768'));

    // official core: semicolon authors, versions sorted, license, jatsxml
    expect(result.title).toBe('Rationality self-organizes beyond subjective reasonings');
    expect(result.authors).toEqual(['Yonekura, S.', 'Kanazawa, H.']);
    expect(result.preprint_server).toBe('bioRxiv');
    expect(result.license).toBe('cc_by');
    expect(result.category).toBe('neuroscience');
    expect(result.jatsxml_url).toContain('.source.xml');
    expect(result.version).toBe(2);
    expect(result.preprint?.data_source).toBe('api.biorxiv.org');
    expect(result.preprint?.versions.map(v => v.version)).toEqual([1, 2]);
    expect(result.preprint?.corresponding_author?.name).toBe('Shogo Yonekura');
    expect(result.preprint?.funders?.[0].id_type).toBe('ROR');
    // EPMC enrichment: citation count + OA flag
    expect(result.cited_by).toBe(44);
    expect(result.is_open_access).toBe(true);
    // published mapping from /pubs (legacy 10.1101 DOI)
    expect(result.published?.doi).toBe('10.3389/fbinf.2025.1577324');
    expect(result.published?.journal).toBe('Frontiers in Bioinformatics');
    // no sections requested → none attached
    expect(result.sections).toBeUndefined();
  });

  test('articleGet on preprint DOI with sections=["fulltext"] returns the honest link-only envelope', async () => {
    global.fetch = jest.fn((url: unknown) => {
      const u = String(url);
      const { hostname, pathname } = parseMockUrl(u);
      if (hostname === 'api.biorxiv.org' && pathname.startsWith('/details/biorxiv/')) return Promise.resolve(jsonResponse(biorxivDetailsPayload('bioRxiv')));
      if (hostname === 'api.biorxiv.org' && pathname.startsWith('/pubs/')) return Promise.resolve(jsonResponse({ messages: [{ status: 'no posts found' }], collection: [] }));
      if (hostname === 'www.ebi.ac.uk') return Promise.resolve(jsonResponse(epmcCorePayload));
      return Promise.reject(new Error(`unexpected url ${u}`));
    }) as any;

    const result = await advanceUntilSettled(articleGet('10.1101/2025.03.05.641768', ['fulltext']));

    const ft = result.sections?.fulltext as any;
    expect(ft).toMatchObject({ status: 'unavailable', reason: 'not_implemented_for_preprints' });
    expect(ft.links?.jatsxml_url).toContain('.source.xml');
    expect(ft.note).toContain('jatsxml_url');
  });

  test('articleGet on preprint DOI with sections=["all"] never emits a fulltext envelope', async () => {
    global.fetch = jest.fn((url: unknown) => {
      const u = String(url);
      const { hostname, pathname } = parseMockUrl(u);
      if (hostname === 'api.biorxiv.org' && pathname.startsWith('/details/biorxiv/')) return Promise.resolve(jsonResponse(biorxivDetailsPayload('bioRxiv')));
      if (hostname === 'api.biorxiv.org' && pathname.startsWith('/pubs/')) return Promise.resolve(jsonResponse({ messages: [{ status: 'no posts found' }], collection: [] }));
      if (hostname === 'www.ebi.ac.uk') return Promise.resolve(jsonResponse(epmcCorePayload));
      return Promise.reject(new Error(`unexpected url ${u}`));
    }) as any;

    const result = await advanceUntilSettled(articleGet('10.1101/2025.03.05.641768', ['all']));

    expect(result.sections?.fulltext).toBeUndefined();
  });

  test('articleGet falls back to medrxiv server on biorxiv soft miss', async () => {
    global.fetch = jest.fn((url: unknown) => {
      const u = String(url);
      const { hostname, pathname } = parseMockUrl(u);
      if (hostname === 'api.biorxiv.org' && pathname.startsWith('/details/biorxiv/')) {
        return Promise.resolve(jsonResponse({ messages: [{ status: 'no posts found' }], collection: [] }));
      }
      if (hostname === 'api.biorxiv.org' && pathname.startsWith('/details/medrxiv/')) return Promise.resolve(jsonResponse(biorxivDetailsPayload('medRxiv', ['1'])));
      if (hostname === 'api.biorxiv.org' && pathname.startsWith('/pubs/')) {
        return Promise.resolve(jsonResponse({ messages: [{ status: 'no articles found for published version of ' }], collection: [] }));
      }
      if (hostname === 'www.ebi.ac.uk') return Promise.resolve(jsonResponse(epmcCorePayload));
      return Promise.reject(new Error(`unexpected url ${u}`));
    }) as any;

    const result = await advanceUntilSettled(articleGet('10.1101/2025.03.05.641768'));

    expect(result.preprint_server).toBe('medRxiv');
    expect(result.journal).toBe('medRxiv');
    // /pubs soft-miss → published falls back to EPMC's Preprint-of link
    expect(result.published?.pmid).toBe('32015507');
    expect(result.published?.source).toBe('europepmc');
  });

  test('articleGet on unknown preprint DOI throws not-found', async () => {
    global.fetch = jest.fn((url: unknown) => {
      const u = String(url);
      const { hostname, pathname } = parseMockUrl(u);
      if (hostname === 'api.biorxiv.org' && pathname.startsWith('/details/')) {
        return Promise.resolve(jsonResponse({ messages: [{ status: 'no posts found' }], collection: [] }));
      }
      if (hostname === 'www.ebi.ac.uk') return Promise.resolve(jsonResponse({ resultList: { result: [] } }));
      return Promise.reject(new Error(`unexpected url ${u}`));
    }) as any;

    await expect(advanceUntilSettled(articleGet('10.1101/2099.01.01.000001'))).rejects.toThrow(/not found on bioRxiv\/medRxiv/);
  });

  test('articleGet preprint citation section uses PPR endpoints', async () => {
    global.fetch = jest.fn((url: unknown) => {
      const u = String(url);
      const { hostname, pathname } = parseMockUrl(u);
      if (hostname === 'api.biorxiv.org' && pathname.startsWith('/details/biorxiv/')) return Promise.resolve(jsonResponse(biorxivDetailsPayload('bioRxiv', ['1'])));
      if (hostname === 'api.biorxiv.org' && pathname.startsWith('/pubs/')) return Promise.resolve(jsonResponse({ messages: [{ status: 'no posts found' }], collection: [] }));
      if (u.includes('/PPR910295/citations')) {
        return Promise.resolve(jsonResponse({
          citationList: { citation: [{ id: '123', source: 'MED', title: 'Citing paper', authorString: 'Doe J', journalTitle: 'Nature', pubYear: '2023' }] },
        }));
      }
      if (u.includes('/PPR910295/references')) {
        return Promise.resolve(jsonResponse({
          referenceList: { reference: [{ id: '456', source: 'MED', title: 'Referenced paper', authorString: 'Roe A', journalTitle: 'Science', pubYear: '2019' }] },
        }));
      }
      if (hostname === 'www.ebi.ac.uk') return Promise.resolve(jsonResponse(epmcCorePayload));
      return Promise.reject(new Error(`unexpected url ${u}`));
    }) as any;

    const result = await advanceUntilSettled(articleGet('10.1101/2021.10.25.465764', ['citation']));

    const citation = result.sections?.citation as any;
    expect(citation).toBeDefined();
    expect(citation._error).toBeUndefined();
    expect(citation.article_id).toEqual({ doi: '10.1101/2021.10.25.465764' });
    expect(citation.citation_counts).toEqual([{ total: 44, source: 'europepmc' }]);
    expect(citation.forward_citations[0].title).toBe('Citing paper');
    expect(citation.backward_references[0].title).toBe('Referenced paper');
    expect(citation.items_available).toBe(true);
  });

  test('articleGet degrades to Europe PMC core when the official API is unreachable', async () => {
    global.fetch = jest.fn((url: unknown) => {
      const u = String(url);
      const { hostname, pathname } = parseMockUrl(u);
      if (hostname === 'api.biorxiv.org') return Promise.reject(new Error('connection refused'));
      if (hostname === 'www.ebi.ac.uk') return Promise.resolve(jsonResponse(epmcCorePayload));
      return Promise.reject(new Error(`unexpected url ${u}`));
    }) as any;

    const result = await advanceUntilSettled(articleGet('10.1101/2021.10.25.465764'));

    expect(result.title).toBe('The preprint title');
    expect(result.abstract).toBe('The preprint abstract');
    expect(result.preprint?.data_source).toBe('europepmc');
    expect(result.cited_by).toBe(44);
    expect(result.ppr_id).toBe('PPR910295');
  });

  test('articleGet transport outage skips medrxiv probe and /pubs, degrades to EPMC', async () => {
    global.fetch = jest.fn((url: unknown) => {
      const u = String(url);
      const { hostname, pathname } = parseMockUrl(u);
      if (hostname === 'api.biorxiv.org') return Promise.reject(new Error('network down'));
      if (hostname === 'www.ebi.ac.uk') return Promise.resolve(jsonResponse(epmcCorePayload));
      return Promise.reject(new Error(`unexpected url ${u}`));
    }) as any;

    const result = await advanceUntilSettled(articleGet('10.1101/2021.10.25.465764'));

    const urls = (global.fetch as any).mock.calls.map((c: unknown[]) => String(c[0]));
    // same host serves both collections → no medrxiv probe after transport failure
    expect(urls.some((u: any) => u.includes('/details/medrxiv/'))).toBe(false);
    // official API unreachable → /pubs would be pure wasted latency
    expect(urls.some((u: any) => u.includes('/pubs/'))).toBe(false);
    // EPMC degraded core with published from the "Preprint of" link, no network call
    expect(result.preprint?.data_source).toBe('europepmc');
    expect(result.published).toEqual({ pmid: '32015507', source: 'europepmc' });
  });

  test('articleGet transport outage yields published null without an EPMC preprint-of link', async () => {
    const epmcWithoutLink = {
      resultList: {
        result: [{
          ...epmcCorePayload.resultList.result[0],
          commentCorrectionList: undefined,
        }],
      },
    };
    global.fetch = jest.fn((url: unknown) => {
      const u = String(url);
      const { hostname, pathname } = parseMockUrl(u);
      if (hostname === 'api.biorxiv.org') return Promise.reject(new Error('network down'));
      if (hostname === 'www.ebi.ac.uk') return Promise.resolve(jsonResponse(epmcWithoutLink));
      return Promise.reject(new Error(`unexpected url ${u}`));
    }) as any;

    const result = await advanceUntilSettled(articleGet('10.1101/2021.10.25.465764'));

    expect(result.preprint?.data_source).toBe('europepmc');
    expect(result.published).toBeNull();
  });

  test('getPreprintArticle skips /pubs with a published note when step 1 exceeds the budget threshold', async () => {
    // A Date.now spy would leak the +25 s jump into token-bucket limiters
    // (their refill freezes while the clock reads in the future), so the
    // describe's fake timers carry a monotonic base and the clock is flipped
    // via setSystemTime instead. The fake clock only ever advances forward,
    // so the "25s already spent" note below stays valid.
    const base = Date.now();
    global.fetch = jest.fn((url: unknown) => {
      const u = String(url);
      const { hostname, pathname } = parseMockUrl(u);
      if (hostname === 'api.biorxiv.org' && pathname.startsWith('/details/biorxiv/')) {
        jest.setSystemTime(base + 25_000); // step 1 consumed 25 s — past the 20 s skip threshold
        return Promise.resolve(jsonResponse(biorxivDetailsPayload('bioRxiv', ['1'])));
      }
      if (hostname === 'api.biorxiv.org' && pathname.startsWith('/pubs/')) {
        // Would win the fallback chain if (incorrectly) requested.
        return Promise.resolve(jsonResponse({
          messages: [{ status: 'ok' }],
          collection: [{ preprint_doi: '10.1101/2025.03.05.641768', published_doi: '10.3389/fbinf.2025.1577324' }],
        }));
      }
      if (hostname === 'www.ebi.ac.uk') return Promise.resolve(jsonResponse(epmcCorePayload));
      return Promise.reject(new Error(`unexpected url ${u}`));
    }) as any;

    const result = await advanceUntilSettled(getPreprintArticle('10.1101/2025.03.05.641768'));

    const urls = requestedUrls();
    // budget guard: /pubs never hit the wire despite the official API succeeding
    expect(urls.some((u: any) => u.includes('/pubs/'))).toBe(false);
    // published mapping degrades to the EPMC "Preprint of" link...
    expect(result.published).toMatchObject({ pmid: '32015507', source: 'europepmc' });
    // ...with the skip disclosed on the natural note field
    expect((result.published as any).note).toContain('/pubs skipped');
    expect((result.published as any).note).toContain('25s already spent');
  });

  test('getPreprintArticle still calls /pubs (no skip note) when step 1 is fast', async () => {
    global.fetch = jest.fn((url: unknown) => {
      const u = String(url);
      const { hostname, pathname } = parseMockUrl(u);
      if (hostname === 'api.biorxiv.org' && pathname.startsWith('/details/biorxiv/')) return Promise.resolve(jsonResponse(biorxivDetailsPayload('bioRxiv', ['1'])));
      if (hostname === 'api.biorxiv.org' && pathname.startsWith('/pubs/')) {
        return Promise.resolve(jsonResponse({
          messages: [{ status: 'ok' }],
          collection: [{ preprint_doi: '10.1101/2025.03.05.641768', published_doi: '10.3389/fbinf.2025.1577324', published_journal: 'Frontiers in Bioinformatics', published_date: '2025-09-04', preprint_date: '2025-03-05' }],
        }));
      }
      if (hostname === 'www.ebi.ac.uk') return Promise.resolve(jsonResponse(epmcCorePayload));
      return Promise.reject(new Error(`unexpected url ${u}`));
    }) as any;

    const result = await advanceUntilSettled(getPreprintArticle('10.1101/2025.03.05.641768'));

    const urls = requestedUrls();
    expect(urls.some((u: any) => u.includes('/pubs/'))).toBe(true);
    expect(result.published).toMatchObject({ doi: '10.3389/fbinf.2025.1577324', source: 'biorxiv_pubs' });
    expect((result.published as any).note).toBeUndefined();
  });

  test('articleGet published falls back to the official /details published DOI when /pubs and EPMC yield nothing', async () => {
    const detailsWithPublishedDoi = {
      ...biorxivDetailsPayload('bioRxiv', ['1']),
      collection: [{
        ...biorxivDetailsPayload('bioRxiv', ['1']).collection[0],
        published: '10.1234/journal.2024.01.001', // not 'NA'
      }],
    };
    global.fetch = jest.fn((url: unknown) => {
      const u = String(url);
      const { hostname, pathname } = parseMockUrl(u);
      if (hostname === 'api.biorxiv.org' && pathname.startsWith('/details/biorxiv/')) return Promise.resolve(jsonResponse(detailsWithPublishedDoi));
      // /pubs soft miss → no published mapping from the official pubs endpoint
      if (hostname === 'api.biorxiv.org' && pathname.startsWith('/pubs/')) return Promise.resolve(jsonResponse({ messages: [{ status: 'no posts found' }], collection: [] }));
      // no EPMC record → no "Preprint of" link either
      if (hostname === 'www.ebi.ac.uk') return Promise.resolve(jsonResponse({ resultList: { result: [] } }));
      return Promise.reject(new Error(`unexpected url ${u}`));
    }) as any;

    const result = await advanceUntilSettled(articleGet('10.1101/2025.03.05.641768'));

    // fallback chain end: /details record's own `published` DOI field
    expect(result.published).toEqual({ doi: '10.1234/journal.2024.01.001', source: 'biorxiv_details' });
  });

  test('articleGet preprint citation section carries _error when the PPR endpoints reject', async () => {
    global.fetch = jest.fn((url: unknown) => {
      const u = String(url);
      const { hostname, pathname } = parseMockUrl(u);
      if (hostname === 'api.biorxiv.org' && pathname.startsWith('/details/biorxiv/')) return Promise.resolve(jsonResponse(biorxivDetailsPayload('bioRxiv', ['1'])));
      if (hostname === 'api.biorxiv.org' && pathname.startsWith('/pubs/')) return Promise.resolve(jsonResponse({ messages: [{ status: 'no posts found' }], collection: [] }));
      // both PPR legs reject; the non-network message keeps the europepmc
      // registry retry (1 retry on network signatures) out of the timing
      if (u.includes('/PPR910295/citations') || u.includes('/PPR910295/references')) {
        return Promise.reject(new Error('PPR citation endpoints exploded'));
      }
      if (hostname === 'www.ebi.ac.uk') return Promise.resolve(jsonResponse(epmcCorePayload));
      return Promise.reject(new Error(`unexpected url ${u}`));
    }) as any;

    const result = await advanceUntilSettled(articleGet('10.1101/2021.10.25.465764', ['citation']));

    // exact fetchPprCitationSection catch shape: `Preprint citation lookup failed: <msg>`
    expect(result.sections?.citation).toEqual({ _error: 'Preprint citation lookup failed: PPR citation endpoints exploded' });
  });

  test('articleGet omits funders when the official record carries the string "NA"', async () => {
    const detailsNaFunder = {
      ...biorxivDetailsPayload('bioRxiv', ['1']),
      collection: [{
        ...biorxivDetailsPayload('bioRxiv', ['1']).collection[0],
        funder: 'NA', // the official API string sentinel, not an array
      }],
    };
    global.fetch = jest.fn((url: unknown) => {
      const u = String(url);
      const { hostname, pathname } = parseMockUrl(u);
      if (hostname === 'api.biorxiv.org' && pathname.startsWith('/details/biorxiv/')) return Promise.resolve(jsonResponse(detailsNaFunder));
      if (hostname === 'api.biorxiv.org' && pathname.startsWith('/pubs/')) return Promise.resolve(jsonResponse({ messages: [{ status: 'no posts found' }], collection: [] }));
      if (hostname === 'www.ebi.ac.uk') return Promise.resolve(jsonResponse(epmcCorePayload));
      return Promise.reject(new Error(`unexpected url ${u}`));
    }) as any;

    const result = await advanceUntilSettled(articleGet('10.1101/2025.03.05.641768'));

    expect(result.preprint?.data_source).toBe('api.biorxiv.org');
    expect(result.preprint?.funders).toBeUndefined();
  });

  test('articleGet preprint citation limit slices forward citations and references', async () => {
    const threeCitations = [1, 2, 3].map(i => ({
      id: String(1000 + i), source: 'MED', title: `Citing paper ${i}`, authorString: 'Doe J', journalTitle: 'Nature', pubYear: '2023',
    }));
    const threeReferences = [1, 2, 3].map(i => ({
      id: String(2000 + i), source: 'MED', title: `Referenced paper ${i}`, authorString: 'Roe A', journalTitle: 'Science', pubYear: '2019',
    }));
    global.fetch = jest.fn((url: unknown) => {
      const u = String(url);
      const { hostname, pathname } = parseMockUrl(u);
      if (hostname === 'api.biorxiv.org' && pathname.startsWith('/details/biorxiv/')) return Promise.resolve(jsonResponse(biorxivDetailsPayload('bioRxiv', ['1'])));
      if (hostname === 'api.biorxiv.org' && pathname.startsWith('/pubs/')) return Promise.resolve(jsonResponse({ messages: [{ status: 'no posts found' }], collection: [] }));
      if (u.includes('/PPR910295/citations')) return Promise.resolve(jsonResponse({ hitCount: 3, citationList: { citation: threeCitations } }));
      if (u.includes('/PPR910295/references')) return Promise.resolve(jsonResponse({ referenceList: { reference: threeReferences } }));
      if (hostname === 'www.ebi.ac.uk') return Promise.resolve(jsonResponse(epmcCorePayload));
      return Promise.reject(new Error(`unexpected url ${u}`));
    }) as any;

    const result = await advanceUntilSettled(articleGet('10.1101/2021.10.25.465764', ['citation'], { limit: 2 }));

    const citation = result.sections?.citation as any;
    expect(citation.forward_citations).toHaveLength(2);
    // slice keeps the head of the list (post filter+transform)
    expect(citation.forward_citations.map((c: any) => c.title)).toEqual(['Citing paper 1', 'Citing paper 2']);
    expect(citation.backward_references).toHaveLength(2);
    // fetch pageSize = max(limit*3, 10) — the limit still governs the returned window
    const urls = (global.fetch as any).mock.calls.map((c: unknown[]) => String(c[0]));
    expect(urls.find((u: any) => u.includes('/PPR910295/citations'))).toContain('pageSize=10');
  });

  test('articleGet preprint citation_direction="forward" requests only /citations; skipped array key stays empty', async () => {
    global.fetch = pprCitationRouter() as any;

    const result = await advanceUntilSettled(articleGet('10.1101/2021.10.25.465764', ['citation'], { citationDirection: 'forward' }));

    const urls = requestedUrls();
    expect(urls.some((u: any) => u.includes('/PPR910295/citations'))).toBe(true);
    expect(urls.some((u: any) => u.includes('/PPR910295/references'))).toBe(false);
    const citation = result.sections?.citation as any;
    expect(citation.forward_citations.map((c: any) => c.title)).toEqual(['Citing paper 1', 'Citing paper 2', 'Citing paper 3']);
    // envelope key intact for the skipped direction → applyLimit still slices a real array
    expect(Array.isArray(citation.backward_references)).toBe(true);
    expect(citation.backward_references).toEqual([]);
    // skipped direction ⇒ no EPMC hitCount for it; total falls back to the core record count
    expect(citation.citation_counts).toEqual([{ total: 44, source: 'europepmc' }]);
  });

  test('articleGet preprint citation_direction="backward" requests only /references', async () => {
    global.fetch = pprCitationRouter() as any;

    const result = await advanceUntilSettled(articleGet('10.1101/2021.10.25.465764', ['citation'], { citationDirection: 'backward' }));

    const urls = requestedUrls();
    expect(urls.some((u: any) => u.includes('/PPR910295/citations'))).toBe(false);
    expect(urls.some((u: any) => u.includes('/PPR910295/references'))).toBe(true);
    const citation = result.sections?.citation as any;
    expect(citation.backward_references.map((c: any) => c.title)).toEqual(['Referenced paper 1', 'Referenced paper 2', 'Referenced paper 3']);
    expect(Array.isArray(citation.forward_citations)).toBe(true);
    expect(citation.forward_citations).toEqual([]);
  });

  test('articleGet preprint default direction requests both PPR endpoints (no regression)', async () => {
    global.fetch = pprCitationRouter() as any;

    const result = await advanceUntilSettled(articleGet('10.1101/2021.10.25.465764', ['citation']));

    const urls = requestedUrls();
    expect(urls.some((u: any) => u.includes('/PPR910295/citations'))).toBe(true);
    expect(urls.some((u: any) => u.includes('/PPR910295/references'))).toBe(true);
    const citation = result.sections?.citation as any;
    expect(citation.forward_citations).toHaveLength(3);
    expect(citation.backward_references).toHaveLength(3);
  });

  test('articleGet preprint names unsupported sections and citation_mode via sections._note', async () => {
    global.fetch = pprCitationRouter() as any;

    const result = await advanceUntilSettled(articleGet('10.1101/2021.10.25.465764', ['citation', 'oa', 'graph'], { citationMode: 'full' }));

    // unsupported sections are NOT attached on the preprint path...
    expect(result.sections?.open_access).toBeUndefined();
    expect(result.sections?.citation_graph).toBeUndefined();
    // ...and the reply discloses both the sections and the meaningless mode
    const note = (result.sections?._note as string) ?? '';
    expect(note).toContain('"oa"');
    expect(note).toContain('"graph"');
    expect(note).not.toContain('"annotations"');
    expect(note).toContain('citation_mode="full"');
    expect(note).toContain('Europe PMC PPR');
  });

  test('articleGet preprint supported requests carry no sections._note', async () => {
    global.fetch = pprCitationRouter() as any;

    const result = await advanceUntilSettled(articleGet('10.1101/2021.10.25.465764', ['citation']));

    expect(result.sections?.citation).toBeDefined();
    expect(result.sections?._note).toBeUndefined();
  });

  test('articleGet preprint citation source_results rows are compact summaries (no record arrays)', async () => {
    global.fetch = pprCitationRouter() as any;

    const result = await advanceUntilSettled(articleGet('10.1101/2021.10.25.465764', ['citation'], { limit: 2 }));

    const rows = (result.sections?.citation as any).source_results;
    expect(rows).toHaveLength(1);
    // counts + display name only — records live solely in the top-level arrays
    expect(rows[0]).toEqual({ source_id: 'europepmc', source: 'Europe PMC', forward_count: 2, backward_count: 2, total: 4 });
    expect(rows[0].forward_citations).toBeUndefined();
    expect(rows[0].backward_references).toBeUndefined();
    expect(rows[0].citation_count).toBeUndefined();
  });

  test('applyLimit slices the preprint citation arrays and passes sections._note through untouched', async () => {
    global.fetch = pprCitationRouter() as any;

    // forward-only + a mode request ⇒ _note present; limit 2 pre-slices inside the preprint path
    const result = await advanceUntilSettled(articleGet('10.1101/2021.10.25.465764', ['citation'], { citationDirection: 'forward', citationMode: 'fast', limit: 2 }));
    // the tool layer's own maps (mirrors server/tools/article.ts)
    const limited = applyLimit(
      result.sections!,
      ['citation'],
      { citation: 'citation' },
      { citation: ['forward_citations', 'backward_references'] },
      1
    );

    const citation = limited.citation as any;
    expect(citation.forward_citations).toHaveLength(1);
    expect(citation.forward_citations[0].title).toBe('Citing paper 1');
    // top-level keys intact: the skipped direction is still a (empty) array
    expect(citation.backward_references).toEqual([]);
    expect(citation._error).toBeUndefined();
    // the runtime note is not a section key — applyLimit must not drop it
    expect(limited._note).toContain('citation_mode="fast"');
  });

  test('transformPreprint defaults the server label to bioRxiv when bookOrReportDetails is absent', () => {
    const result = transformPreprint({
      id: 'PPR123456',
      doi: '10.1101/2025.01.01.000001',
      title: 'A preprint without publisher metadata',
      authorString: 'Zhang W, Li H',
      firstPublicationDate: '2025-01-01',
    });

    expect(result.journal).toBe('bioRxiv');
    expect(result.preprint_server).toBe('bioRxiv');
    expect(result.source).toBe('preprint_only');
    expect(result.ppr_id).toBe('PPR123456');
  });

  test('getPreprintArticle per-segment URL-encodes reserved chars in the DOI path', async () => {
    global.fetch = jest.fn((url: unknown) => {
      const u = String(url);
      const { hostname, pathname } = parseMockUrl(u);
      if (hostname === 'api.biorxiv.org' && pathname.startsWith('/details/biorxiv/')) return Promise.resolve(jsonResponse(biorxivDetailsPayload('bioRxiv', ['1'])));
      if (hostname === 'api.biorxiv.org' && pathname.startsWith('/pubs/')) return Promise.resolve(jsonResponse({ messages: [{ status: 'no posts found' }], collection: [] }));
      if (hostname === 'www.ebi.ac.uk') return Promise.resolve(jsonResponse({ resultList: { result: [] } }));
      return Promise.reject(new Error(`unexpected url ${u}`));
    }) as any;

    const result = await advanceUntilSettled(getPreprintArticle('10.1101/2024.01.01.12345?v=x'));

    expect(result.preprint?.data_source).toBe('api.biorxiv.org');
    const urls = (global.fetch as any).mock.calls.map((c: unknown[]) => String(c[0]));
    const detailsUrl = urls.find((u: any) => parseMockUrl(u).pathname.startsWith('/details/biorxiv/')) ?? '';
    // reserved chars encoded per segment ('?' → %3F, '=' → %3D), '/' preserved
    expect(detailsUrl).toContain('2024.01.01.12345%3Fv%3Dx');
    expect(detailsUrl).not.toContain('?v=x');
    const pubsUrl = urls.find((u: any) => u.includes('/pubs/')) ?? '';
    expect(pubsUrl).toContain('2024.01.01.12345%3Fv%3Dx/na');
  });
});
