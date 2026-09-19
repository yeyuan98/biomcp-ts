import { jest } from '@jest/globals';
import { articleSearch, articleGet, transformPubTator, transformLitSense, transformEuropePMC, transformSemanticScholar, transformPreprint, parseDateRange, parseArticleId, isPreprintDoi, parseOaXml } from '../../entities/article.js';
import { clearCitationCache } from '../../entities/article/citation/index.js';
import { clearWorkCache } from '../../entities/article/citation/crossref.js';
import { clearCitedInCache } from '../../entities/article/citation/pubmed.js';
import { fetchOpenAccess } from '../../entities/article/detail/open-access.js';
import { getPreprintArticle } from '../../entities/article/detail/preprint.js';
import { connectionManager } from '../../connections/manager.js';

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
  let originalFetch: typeof global.fetch;

  beforeEach(() => {
    jest.clearAllMocks();
    originalFetch = global.fetch;
    connectionManager.closeAll();
    process.env.NCBI_API_KEY = '';
  });

  afterEach(() => {
    global.fetch = originalFetch;
    delete process.env.NCBI_API_KEY;
    clearCitationCache();
    clearWorkCache();
    clearCitedInCache();
  });

  test('articleSearch() calls ESearch then EFetch for PubMed', async () => {
    global.fetch = jest.fn()
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
    global.fetch = jest.fn().mockResolvedValue({
      ok: true,
      headers: new Headers({ 'content-type': 'application/json' }),
      json: () => Promise.resolve({ esearchresult: { idlist: [] } }),
    }) as any;

    const result = await articleSearch('nonexistent', { source: 'pubmed' });
    expect(result).toEqual([]);
  });

  test('articleGet() calls EFetch with correct PMID', async () => {
    global.fetch = jest.fn().mockResolvedValue({
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
    global.fetch = jest.fn().mockResolvedValue({
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
    global.fetch = jest.fn().mockResolvedValue({
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
    global.fetch = jest.fn().mockResolvedValue({
      ok: true,
      headers: new Headers({ 'content-type': 'application/json' }),
      json: () => Promise.resolve({ results: [] }),
    }) as any;

    await articleSearch('brca1', { source: 'pubtator', limit: 15 });

    const callUrl = (global.fetch as any).mock.calls[0][0] as string;
    expect(callUrl).toContain('size=15');
  });

  test('articleSearch() with litsense source uses /sentences/?query= endpoint', async () => {
    global.fetch = jest.fn().mockResolvedValue({
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
    global.fetch = jest.fn().mockResolvedValue({
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
    global.fetch = jest.fn().mockResolvedValue({
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
    global.fetch = jest.fn().mockResolvedValue({
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
    global.fetch = jest.fn().mockResolvedValue({
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
    global.fetch = jest.fn().mockResolvedValue({
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
    global.fetch = jest.fn().mockResolvedValue({
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
    global.fetch = jest.fn().mockResolvedValue({
      ok: true,
      headers: new Headers({ 'content-type': 'application/json' }),
      json: () => Promise.resolve({ hitCount: 0 }),
    }) as any;

    const result = await articleSearch('brca1', { source: 'europepmc', limit: 5 });

    expect(global.fetch).toHaveBeenCalledTimes(1);
    expect(result).toEqual([]);
  });

  test('articleSearch() europepmc explicit cursorMark takes precedence over offset', async () => {
    global.fetch = jest.fn().mockResolvedValue({
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
    global.fetch = jest.fn().mockResolvedValue({
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
      global.fetch = jest.fn()
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
      global.fetch = jest.fn()
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
      global.fetch = jest.fn()
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

    test('Europe PMC search appends date range in query', async () => {
      global.fetch = jest.fn().mockResolvedValue({
        ok: true,
        headers: new Headers({ 'content-type': 'application/json' }),
        json: () => Promise.resolve({ resultList: { result: [] } }),
      }) as any;

      await articleSearch('brca1', { source: 'europepmc', dateRange: '2020-01-01/2023-12-31' });

      const callUrl = (global.fetch as any).mock.calls[0][0] as string;
      expect(callUrl).toContain('pub_year');
      expect(callUrl).toContain('2020');
      expect(callUrl).toContain('2023');
    });

    test('Europe PMC search with open-ended to-only dateRange', async () => {
      global.fetch = jest.fn().mockResolvedValue({
        ok: true,
        headers: new Headers({ 'content-type': 'application/json' }),
        json: () => Promise.resolve({ resultList: { result: [] } }),
      }) as any;

      await articleSearch('brca1', { source: 'europepmc', dateRange: '/2023-12-31' });

      const callUrl = (global.fetch as any).mock.calls[0][0] as string;
      const decodedUrl = decodeURIComponent(callUrl);
      expect(decodedUrl).toContain('pub_year:[* TO 2023]');
    });

    test('Europe PMC search date clause is year-granular across distinct years', async () => {
      global.fetch = jest.fn().mockResolvedValue({
        ok: true,
        headers: new Headers({ 'content-type': 'application/json' }),
        json: () => Promise.resolve({ resultList: { result: [] } }),
      }) as any;

      await articleSearch('brca1', { source: 'europepmc', dateRange: '2020-06-15/2021-03-01' });

      const callUrl = (global.fetch as any).mock.calls[0][0] as string;
      const decodedUrl = decodeURIComponent(callUrl);
      // month/day is truncated: the clause carries years only
      expect(decodedUrl).toContain('brca1 AND pub_year:[2020 TO 2021]');
    });

    test('Europe PMC search with open-ended from-only dateRange', async () => {
      global.fetch = jest.fn().mockResolvedValue({
        ok: true,
        headers: new Headers({ 'content-type': 'application/json' }),
        json: () => Promise.resolve({ resultList: { result: [] } }),
      }) as any;

      await articleSearch('brca1', { source: 'europepmc', dateRange: '2020-06-01/' });

      const callUrl = (global.fetch as any).mock.calls[0][0] as string;
      const decodedUrl = decodeURIComponent(callUrl);
      expect(decodedUrl).toContain('pub_year:[2020 TO *]');
    });

    test('Semantic Scholar search appends publicationDateOrYear param', async () => {
      global.fetch = jest.fn().mockResolvedValue({
        ok: true,
        headers: new Headers({ 'content-type': 'application/json' }),
        json: () => Promise.resolve({ data: [] }),
      }) as any;

      await articleSearch('brca1', { source: 'semantic_scholar', dateRange: '2020-01-01/2023-12-31' });

      const callUrl = (global.fetch as any).mock.calls[0][0] as string;
      expect(callUrl).toContain('publicationDateOrYear=2020-01-01:2023-12-31');
    });

    test('Semantic Scholar search with open-ended from-only', async () => {
      global.fetch = jest.fn().mockResolvedValue({
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
        global.fetch = jest.fn().mockImplementation((url: unknown) => {
          if (!String(url).includes('semanticscholar')) return Promise.resolve(ok());
          if ((global.fetch as any).mock.calls.filter((c: any[]) => String(c[0]).includes('semanticscholar')).length === 1) {
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

    test('pubtator source returns error when dateRange is set', async () => {
      const result = await articleSearch('brca1', { source: 'pubtator', dateRange: '2020-01-01/2023-12-31' });
      expect(result).toHaveLength(1);
      expect(result[0]).toHaveProperty('_error');
      expect((result[0] as any)._error).toContain('does not support date filtering');
    });

    test('litsense source returns error when dateRange is set', async () => {
      const result = await articleSearch('brca1', { source: 'litsense', dateRange: '2020-01-01/2023-12-31' });
      expect(result).toHaveLength(1);
      expect(result[0]).toHaveProperty('_error');
      expect((result[0] as any)._error).toContain('does not support date filtering');
    });

    test('federated search with dateRange only queries date-aware backends', async () => {
      global.fetch = jest.fn()
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
      expect(urls[1]).toContain('europepmc');
      expect(urls[2]).toContain('semanticscholar');
      expect(urls[3]).toContain('export.arxiv.org');
    });

    test('federated search without dateRange queries all backends', async () => {
      global.fetch = jest.fn().mockResolvedValue({
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
        global.fetch = jest.fn().mockImplementation((url: unknown) => {
          if (String(url).includes('semanticscholar')) {
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
      global.fetch = jest.fn().mockResolvedValue({
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
      global.fetch = jest.fn().mockResolvedValue({
        ok: true,
        headers: new Headers({ 'content-type': 'application/json' }),
        json: () => Promise.resolve({ status: 'ok', records: [] }),
      }) as any;

      await expect(articleGet('PMC99999999')).rejects.toThrow('No record returned for pmcid');
    });

    test('articleGet() with PMCID error-status record without errmsg throws error', async () => {
      global.fetch = jest.fn().mockResolvedValue({
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
      global.fetch = jest.fn().mockResolvedValue({
        ok: true,
        headers: new Headers({ 'content-type': 'application/json' }),
        json: () => Promise.resolve({
          status: 'ok',
          records: [{ pmcid: 'PMC99999999', status: 'error' }],
        }),
      }) as any;

      await expect(articleGet('PMC99999999')).rejects.toThrow('Could not resolve pmcid');
    });

    test('articleGet() with PMID and oa section returns empty when IDConv has error record', async () => {
      global.fetch = jest.fn()
        .mockResolvedValueOnce({
          ok: true,
          headers: new Headers({ 'content-type': 'text/xml' }),
          text: () => Promise.resolve(SINGLE_ARTICLE_XML),
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

      expect(global.fetch).toHaveBeenCalledTimes(2);
      expect(result.sections?.open_access).toEqual({});
    });

    test('articleGet() with PMCID resolves to PMID then fetches', async () => {
      global.fetch = jest.fn()
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

      global.fetch = jest.fn()
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
      global.fetch = jest.fn().mockResolvedValue({
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

    test('articleGet() with DOI and oa section avoids double IDConv call', async () => {
      global.fetch = jest.fn()
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
          headers: new Headers({ 'content-type': 'text/xml' }),
          text: () => Promise.resolve('<OA><records><record><link format="pdf">https://example.com/paper.pdf</link></record><record/></records></OA>'),
        }) as any;

      const result = await articleGet('10.1234/test.2018', ['oa']);

      expect(global.fetch).toHaveBeenCalledTimes(3);
      const idConvUrl = (global.fetch as any).mock.calls[0][0] as string;
      expect(idConvUrl).toContain('idconv');

      const efetchUrl = (global.fetch as any).mock.calls[1][0] as string;
      expect(efetchUrl).toContain('efetch.fcgi');

      const oaUrl = (global.fetch as any).mock.calls[2][0] as string;
      expect(oaUrl).toContain('oa.fcgi');
      expect(oaUrl).toContain('PMC9999999');
      expect(oaUrl).not.toContain('.fcgi/?');

      expect(result.sections?.open_access).toEqual({ pmcid: 'PMC9999999', pdf_url: 'https://example.com/paper.pdf', source: 'pmc_oa' });
    });

    test('articleGet() with PMID and oa section uses IDConv to get PMCID', async () => {
      global.fetch = jest.fn()
        .mockResolvedValueOnce({
          ok: true,
          headers: new Headers({ 'content-type': 'text/xml' }),
          text: () => Promise.resolve(SINGLE_ARTICLE_XML),
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
          headers: new Headers({ 'content-type': 'text/xml' }),
          text: () => Promise.resolve('<OA><records><record><link format="pdf">https://example.com/paper.pdf</link></record><record/></records></OA>'),
        }) as any;

      const result = await articleGet('12345', ['oa']);

      expect(global.fetch).toHaveBeenCalledTimes(3);
      const idConvUrl = (global.fetch as any).mock.calls[1][0] as string;
      expect(idConvUrl).toContain('ids=12345');
      expect(idConvUrl).toContain('idconv');

      expect(result.sections?.open_access).toEqual({ pmcid: 'PMC9999999', pdf_url: 'https://example.com/paper.pdf', source: 'pmc_oa' });
    });

    test('fetchOpenAccess falls back to Europe PMC when pmc_oa is unavailable', async () => {
      global.fetch = jest.fn()
        .mockResolvedValueOnce({
          ok: false,
          status: 404,
          statusText: 'Not Found',
          headers: new Headers({ 'content-type': 'text/html' }),
          text: () => Promise.resolve('blocked'),
        })
        .mockResolvedValueOnce({
          ok: true,
          headers: new Headers({ 'content-type': 'application/json' }),
          json: () => Promise.resolve({
            resultList: {
              result: [{
                license: 'cc by',
                isOpenAccess: 'Y',
                fullTextUrlList: {
                  fullTextUrlList: [
                    { documentStyle: 'pdf', availability: 'Open access', url: 'https://europepmc.org/backend/ptpmcrender.fcgi?accid=PMC9999999' },
                    { documentStyle: 'html', availability: 'Open access', url: 'https://europepmc.org/articles/PMC9999999' },
                  ],
                },
              }],
            },
          }),
        }) as any;

      const result = await fetchOpenAccess('12345', 'PMC9999999');

      expect(global.fetch).toHaveBeenCalledTimes(2);
      const pmcOaUrl = (global.fetch as any).mock.calls[0][0] as string;
      expect(pmcOaUrl).toBe('https://www.ncbi.nlm.nih.gov/pmc/utils/oa/oa.fcgi?id=PMC9999999');
      const epmcUrl = (global.fetch as any).mock.calls[1][0] as string;
      expect(epmcUrl).toContain('europepmc');
      expect(epmcUrl).toContain('PMCID%3APMC9999999');

      expect(result).toEqual({
        pmcid: 'PMC9999999',
        pdf_url: 'https://europepmc.org/backend/ptpmcrender.fcgi?accid=PMC9999999',
        license: 'cc by',
        license_url: 'https://creativecommons.org/licenses/by/4.0/',
        source: 'europepmc',
      });
    });

    test('fetchOpenAccess surfaces _error when both pmc_oa and Europe PMC fail', async () => {
      global.fetch = jest.fn()
        .mockResolvedValueOnce({
          ok: false,
          status: 404,
          statusText: 'Not Found',
          headers: new Headers({ 'content-type': 'text/html' }),
          text: () => Promise.resolve('blocked'),
        })
        .mockResolvedValueOnce({
          ok: false,
          status: 503,
          statusText: 'Service Unavailable',
          headers: new Headers({ 'content-type': 'text/html' }),
          text: () => Promise.resolve('down'),
        }) as any;

      const result = await fetchOpenAccess('12345', 'PMC9999999');

      expect((result as any)._error).toContain('Open access lookup failed');
      expect((result as any)._error).toContain('404');
    });

    test('fetchOpenAccess returns empty when no PMCID found', async () => {
      global.fetch = jest.fn()
        .mockResolvedValueOnce({
          ok: true,
          headers: new Headers({ 'content-type': 'text/xml' }),
          text: () => Promise.resolve(SINGLE_ARTICLE_XML),
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
      expect(result.sections?.open_access).toEqual({});
    });

    test('articleGet() with doi: prefix resolves correctly', async () => {
      global.fetch = jest.fn()
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
      global.fetch = jest.fn()
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
      global.fetch = jest.fn().mockResolvedValue({
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
      global.fetch = jest.fn()
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

    test('articleGet() with PMID and oa section returns empty when IDConv returns error record', async () => {
      global.fetch = jest.fn()
        .mockResolvedValueOnce({
          ok: true,
          headers: new Headers({ 'content-type': 'text/xml' }),
          text: () => Promise.resolve(SINGLE_ARTICLE_XML),
        })
        .mockResolvedValueOnce({
          ok: true,
          headers: new Headers({ 'content-type': 'application/json' }),
          json: () => Promise.resolve({
            status: 'ok',
            records: [{ pmid: 12345, status: 'error', errmsg: 'not found' }],
          }),
        }) as any;

      const result = await articleGet('12345', ['oa']);

      expect(global.fetch).toHaveBeenCalledTimes(2);
      expect(result.sections?.open_access).toEqual({});
    });

    test('articleGet() with sections=["all"] fetches all section types', async () => {
      const emptyJsonResponse = {
        ok: true,
        headers: new Headers({ 'content-type': 'application/json' }),
        json: () => Promise.resolve({}),
      };
      global.fetch = jest.fn()
        .mockResolvedValueOnce({
          ok: true,
          headers: new Headers({ 'content-type': 'text/xml' }),
          text: () => Promise.resolve(SINGLE_ARTICLE_XML),
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
          headers: new Headers({ 'content-type': 'text/xml' }),
          text: () => Promise.resolve('<OA><records><record><link format="pdf">https://example.com/paper.pdf</link></record><record/></records></OA>'),
        })
        .mockResolvedValueOnce({
          ok: true,
          headers: new Headers({ 'content-type': 'application/json' }),
          json: () => Promise.resolve({ PubTator3: [{ passages: [{ text: 'test', annotations: [] }] }] }),
        })
        .mockResolvedValueOnce({
          ok: true,
          headers: new Headers({ 'content-type': 'application/json' }),
          json: () => Promise.resolve({ linksets: [{ linksetdbs: [{ linkname: 'pubmed_pubmed_citedin', links: ['111', '222'] }] }] }),
        })
        .mockResolvedValueOnce({
          ok: true,
          headers: new Headers({ 'content-type': 'application/json' }),
          json: () => Promise.resolve({ linksets: [{ linksetdbs: [{ linkname: 'pubmed_pubmed_refs', links: ['333', '444'] }] }] }),
        })
        .mockResolvedValue(emptyJsonResponse) as any;

      const result = await articleGet('12345', ['all']);

      expect(global.fetch.mock.calls.length).toBeGreaterThanOrEqual(6);
      expect(result.sections).toBeDefined();
      expect(result.sections).toHaveProperty('open_access');
      expect(result.sections).toHaveProperty('annotations');
      expect(result.sections).toHaveProperty('citation_graph');
      expect(result.sections).toHaveProperty('citation');
    }, 30000);

    test('articleGet() with DOI where IDConv record has no pmid throws', async () => {
      global.fetch = jest.fn().mockResolvedValue({
        ok: true,
        headers: new Headers({ 'content-type': 'application/json' }),
        json: () => Promise.resolve({
          status: 'ok',
          records: [{ doi: '10.9999/x', pmcid: 'PMC123' }],
        }),
      }) as any;

      await expect(articleGet('10.9999/x')).rejects.toThrow('Could not resolve doi');
    });

    test('articleGet() with oa section returns license information', async () => {
      const OA_XML_WITH_LICENSE = `<?xml version="1.0"?>
      <OA>
        <responseDate>2019-01-28 10:41:16</responseDate>
        <request id="PMC5334499">https://www.ncbi.nlm.nih.gov/utils/oa/oa.fcgi?id=PMC5334499</request>
        <records returned-count="1" total-count="1">
          <record id="PMC5334499" citation="World J Radiol. 2017 Feb 28; 9(2):27-33" license="CC BY-NC" retracted="no">
            <link format="tgz" updated="2017-03-17 13:10:45" href="ftp://ftp.ncbi.nlm.nih.gov/pub/pmc/oa_package/8e/71/PMC5334499.tar.gz"/>
            <link format="pdf" updated="2017-03-03 06:05:17" href="ftp://ftp.ncbi.nlm.nih.gov/pub/pmc/oa_pdf/8e/71/WJR-9-27.PMC5334499.pdf"/>
          </record>
        </records>
      </OA>`;

      global.fetch = jest.fn()
        .mockResolvedValueOnce({
          ok: true,
          headers: new Headers({ 'content-type': 'text/xml' }),
          text: () => Promise.resolve(SINGLE_ARTICLE_XML),
        })
        .mockResolvedValueOnce({
          ok: true,
          headers: new Headers({ 'content-type': 'application/json' }),
          json: () => Promise.resolve({
            status: 'ok',
            records: [{ pmcid: 'PMC5334499', pmid: 12345 }],
          }),
        })
        .mockResolvedValueOnce({
          ok: true,
          headers: new Headers({ 'content-type': 'text/xml' }),
          text: () => Promise.resolve(OA_XML_WITH_LICENSE),
        }) as any;

      const result = await articleGet('12345', ['oa']);

      expect(result.sections?.open_access).toEqual({
        pmcid: 'PMC5334499',
        pdf_url: 'ftp://ftp.ncbi.nlm.nih.gov/pub/pmc/oa_pdf/8e/71/WJR-9-27.PMC5334499.pdf',
        license: 'CC BY-NC',
        license_url: 'https://creativecommons.org/licenses/by-nc/4.0/',
        source: 'pmc_oa',
      });
    });
  });

  describe('parseOaXml', () => {
    test('parseOaXml extracts license from record attribute', () => {
      const OA_XML = `<?xml version="1.0"?>
      <OA>
        <records returned-count="1" total-count="1">
          <record id="PMC5334499" license="CC BY-NC" retracted="no">
            <link format="pdf" href="https://example.com/paper.pdf"/>
          </record>
        </records>
      </OA>`;

      const result = parseOaXml(OA_XML);

      expect(result.license).toBe('CC BY-NC');
      expect(result.license_url).toBe('https://creativecommons.org/licenses/by-nc/4.0/');
      expect(result.pdf_url).toBe('https://example.com/paper.pdf');
    });

    test('parseOaXml handles various CC license types', () => {
      const licenses = [
        'CC0',
        'CC BY',
        'CC BY-NC',
        'CC BY-NC-ND',
        'CC BY-NC-SA',
        'CC BY-ND',
        'CC BY-SA',
      ];

      for (const license of licenses) {
        const OA_XML = `<?xml version="1.0"?>
        <OA>
          <records>
            <record license="${license}">
              <link format="pdf" href="https://example.com/paper.pdf"/>
            </record>
          </records>
        </OA>`;

        const result = parseOaXml(OA_XML);
        expect(result.license).toBe(license);
        expect(result.license_url).toBeDefined();
      }
    });

    test('parseOaXml returns undefined for license when not present', () => {
      const OA_XML = `<?xml version="1.0"?>
      <OA>
        <records>
          <record id="PMC123">
            <link format="pdf" href="https://example.com/paper.pdf"/>
          </record>
        </records>
      </OA>`;

      const result = parseOaXml(OA_XML);

      expect(result.license).toBeUndefined();
      expect(result.license_url).toBeUndefined();
      expect(result.pdf_url).toBe('https://example.com/paper.pdf');
    });

    test('parseOaXml handles alternative record location', () => {
      const OA_XML = `<?xml version="1.0"?>
      <OA>
        <record license="CC BY">
          <link format="pdf" href="https://example.com/paper.pdf"/>
        </record>
      </OA>`;

      const result = parseOaXml(OA_XML);

      expect(result.license).toBe('CC BY');
      expect(result.license_url).toBe('https://creativecommons.org/licenses/by/4.0/');
      expect(result.pdf_url).toBe('https://example.com/paper.pdf');
    });

    test('parseOaXml handles case-insensitive license matching', () => {
      const OA_XML = `<?xml version="1.0"?>
      <OA>
        <records>
          <record license="cc by-nc">
            <link format="pdf" href="https://example.com/paper.pdf"/>
          </record>
        </records>
      </OA>`;

      const result = parseOaXml(OA_XML);

      expect(result.license).toBe('cc by-nc');
      expect(result.license_url).toBe('https://creativecommons.org/licenses/by-nc/4.0/');
    });

    test('parseOaXml handles license with version number', () => {
      const OA_XML = `<?xml version="1.0"?>
      <OA>
        <records>
          <record license="CC BY 4.0">
            <link format="pdf" href="https://example.com/paper.pdf"/>
          </record>
        </records>
      </OA>`;

      const result = parseOaXml(OA_XML);

      expect(result.license).toBe('CC BY 4.0');
      expect(result.license_url).toBe('https://creativecommons.org/licenses/by/4.0/');
    });
  });
});

describe('preprint source (bioRxiv/medRxiv via preprint_only)', () => {
  let originalFetch: typeof global.fetch;

  beforeEach(() => {
    jest.clearAllMocks();
    originalFetch = global.fetch;
    connectionManager.closeAll();
    process.env.NCBI_API_KEY = '';
  });

  afterEach(() => {
    global.fetch = originalFetch;
    delete process.env.NCBI_API_KEY;
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

  test('articleSearch preprint_only builds the PPR publisher query with resultType=core', async () => {
    global.fetch = jest.fn().mockResolvedValue(jsonResponse(preprintCorePage(10))) as any;

    const result = await articleSearch('crispr', { source: 'preprint_only' });

    expect(global.fetch).toHaveBeenCalledTimes(1);
    const url = (global.fetch as any).mock.calls[0][0] as string;
    const decoded = decodeURIComponent(url);
    expect(decoded).toContain('SRC:PPR');
    expect(decoded).toContain('PUBLISHER:(bioRxiv OR medRxiv)');
    expect(url).toContain('resultType=core');
    expect(url).toContain('cursorMark=*');

    expect(result).toHaveLength(10);
    expect(result[0].publication_types).toEqual(['Preprint']);
    expect(result[0].abstract).toBe('Abstract 0');
    expect(result[0].journal).toBe('bioRxiv');
    expect(result[0].preprint_server).toBe('bioRxiv');
    expect(result[1].journal).toBe('medRxiv');
    expect(result[0].ppr_id).toBe('PPR1000000');
    expect(result[0].source).toBe('preprint_only');
    expect(result[0].authors).toEqual(['Zhang W', 'Li H']);
  });

  test('articleSearch preprint_only applies date range and offset window', async () => {
    global.fetch = jest.fn().mockResolvedValue(jsonResponse(preprintCorePage(10))) as any;

    const result = await articleSearch('vaccine', { source: 'preprint_only', limit: 3, offset: 5, dateRange: '2025-01-01/2025-12-31' });

    const url = (global.fetch as any).mock.calls[0][0] as string;
    expect(url).toContain(encodeURIComponent('AND pub_year:[2025 TO 2025]'));
    expect(url).toContain(`pageSize=${Math.min(3 + 5, 1000)}`);
    // client-side window: rows 5..7 of the 10-row fixture
    expect(result.map(r => r.title)).toEqual(['Preprint 5', 'Preprint 6', 'Preprint 7']);
  });

  test('articleSearch preprint_only date clause is year-granular and follows the PPR wrapper', async () => {
    global.fetch = jest.fn().mockResolvedValue(jsonResponse(preprintCorePage(3))) as any;

    await articleSearch('vaccine', { source: 'preprint_only', dateRange: '2020-06-15/2021-03-01' });

    const url = (global.fetch as any).mock.calls[0][0] as string;
    const decoded = decodeURIComponent(url);
    expect(decoded).toContain('(vaccine) AND SRC:PPR AND PUBLISHER:(bioRxiv OR medRxiv) AND pub_year:[2020 TO 2021]');
  });

  test('articleSearch preprint_only explicit cursorMark takes precedence over offset', async () => {
    global.fetch = jest.fn().mockResolvedValue(jsonResponse(preprintCorePage(6))) as any;

    const result = await articleSearch('crispr', { source: 'preprint_only', limit: 2, offset: 4, cursorMark: 'AoIIQCC9' });

    const url = (global.fetch as any).mock.calls[0][0] as string;
    expect(url).toContain('pageSize=2');
    expect(url).toContain('cursorMark=AoIIQCC9');
    expect(url).not.toContain('cursorMark=*');
    // the cursor defines the window start: offset is ignored, rows come
    // from the head of the page with no client-side skip
    expect(result.map(r => r.title)).toEqual(['Preprint 0', 'Preprint 1']);
  });

  test('articleSearch preprint_only empty resultList.result yields []', async () => {
    global.fetch = jest.fn().mockResolvedValue(jsonResponse({ resultList: {} })) as any;

    const result = await articleSearch('crispr', { source: 'preprint_only' });

    expect(global.fetch).toHaveBeenCalledTimes(1);
    expect(result).toEqual([]);
  });

  test('articleSearch preprint_only returns _error row on transport failure', async () => {
    global.fetch = jest.fn().mockRejectedValue(new Error('network down')) as any;

    const result = await articleSearch('crispr', { source: 'preprint_only' });

    expect(result).toHaveLength(1);
    expect(result[0]._error).toContain('searchPreprints failed');
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
      // duplicate version numbers exercise the dedupe path
      if (u.includes('api.biorxiv.org/details/biorxiv/')) return Promise.resolve(jsonResponse({ ...biorxivDetailsPayload('bioRxiv'), collection: [...biorxivDetailsPayload('bioRxiv').collection, { ...biorxivDetailsPayload('bioRxiv').collection[0] }] }));
      if (u.includes('api.biorxiv.org/pubs/')) {
        return Promise.resolve(jsonResponse({
          messages: [{ status: 'ok' }],
          collection: [{ preprint_doi: '10.1101/2025.03.05.641768', published_doi: '10.3389/fbinf.2025.1577324', published_journal: 'Frontiers in Bioinformatics', published_date: '2025-09-04', preprint_date: '2025-03-05' }],
        }));
      }
      if (u.includes('ebi.ac.uk')) return Promise.resolve(jsonResponse(epmcCorePayload));
      return Promise.reject(new Error(`unexpected url ${u}`));
    }) as any;

    const result = await articleGet('10.1101/2025.03.05.641768');

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

  test('articleGet falls back to medrxiv server on biorxiv soft miss', async () => {
    global.fetch = jest.fn((url: unknown) => {
      const u = String(url);
      if (u.includes('api.biorxiv.org/details/biorxiv/')) {
        return Promise.resolve(jsonResponse({ messages: [{ status: 'no posts found' }], collection: [] }));
      }
      if (u.includes('api.biorxiv.org/details/medrxiv/')) return Promise.resolve(jsonResponse(biorxivDetailsPayload('medRxiv', ['1'])));
      if (u.includes('api.biorxiv.org/pubs/')) {
        return Promise.resolve(jsonResponse({ messages: [{ status: 'no articles found for published version of ' }], collection: [] }));
      }
      if (u.includes('ebi.ac.uk')) return Promise.resolve(jsonResponse(epmcCorePayload));
      return Promise.reject(new Error(`unexpected url ${u}`));
    }) as any;

    const result = await articleGet('10.1101/2025.03.05.641768');

    expect(result.preprint_server).toBe('medRxiv');
    expect(result.journal).toBe('medRxiv');
    // /pubs soft-miss → published falls back to EPMC's Preprint-of link
    expect(result.published?.pmid).toBe('32015507');
    expect(result.published?.source).toBe('europepmc');
  }, 15000);

  test('articleGet on unknown preprint DOI throws not-found', async () => {
    global.fetch = jest.fn((url: unknown) => {
      const u = String(url);
      if (u.includes('api.biorxiv.org/details/')) {
        return Promise.resolve(jsonResponse({ messages: [{ status: 'no posts found' }], collection: [] }));
      }
      if (u.includes('ebi.ac.uk')) return Promise.resolve(jsonResponse({ resultList: { result: [] } }));
      return Promise.reject(new Error(`unexpected url ${u}`));
    }) as any;

    await expect(articleGet('10.1101/2099.01.01.000001')).rejects.toThrow(/not found on bioRxiv\/medRxiv/);
  }, 15000);

  test('articleGet preprint citation section uses PPR endpoints', async () => {
    global.fetch = jest.fn((url: unknown) => {
      const u = String(url);
      if (u.includes('api.biorxiv.org/details/biorxiv/')) return Promise.resolve(jsonResponse(biorxivDetailsPayload('bioRxiv', ['1'])));
      if (u.includes('api.biorxiv.org/pubs/')) return Promise.resolve(jsonResponse({ messages: [{ status: 'no posts found' }], collection: [] }));
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
      if (u.includes('ebi.ac.uk')) return Promise.resolve(jsonResponse(epmcCorePayload));
      return Promise.reject(new Error(`unexpected url ${u}`));
    }) as any;

    const result = await articleGet('10.1101/2021.10.25.465764', ['citation']);

    const citation = result.sections?.citation as any;
    expect(citation).toBeDefined();
    expect(citation._error).toBeUndefined();
    expect(citation.article_id).toEqual({ doi: '10.1101/2021.10.25.465764' });
    expect(citation.citation_counts).toEqual([{ total: 44, source: 'europepmc' }]);
    expect(citation.forward_citations[0].title).toBe('Citing paper');
    expect(citation.backward_references[0].title).toBe('Referenced paper');
    expect(citation.items_available).toBe(true);
  }, 15000);

  test('articleGet degrades to Europe PMC core when the official API is unreachable', async () => {
    global.fetch = jest.fn((url: unknown) => {
      const u = String(url);
      if (u.includes('api.biorxiv.org/')) return Promise.reject(new Error('connection refused'));
      if (u.includes('ebi.ac.uk')) return Promise.resolve(jsonResponse(epmcCorePayload));
      return Promise.reject(new Error(`unexpected url ${u}`));
    }) as any;

    const result = await articleGet('10.1101/2021.10.25.465764');

    expect(result.title).toBe('The preprint title');
    expect(result.abstract).toBe('The preprint abstract');
    expect(result.preprint?.data_source).toBe('europepmc');
    expect(result.cited_by).toBe(44);
    expect(result.ppr_id).toBe('PPR910295');
  }, 20000);

  test('articleGet transport outage skips medrxiv probe and /pubs, degrades to EPMC', async () => {
    global.fetch = jest.fn((url: unknown) => {
      const u = String(url);
      if (u.includes('api.biorxiv.org/')) return Promise.reject(new Error('network down'));
      if (u.includes('ebi.ac.uk')) return Promise.resolve(jsonResponse(epmcCorePayload));
      return Promise.reject(new Error(`unexpected url ${u}`));
    }) as any;

    const result = await articleGet('10.1101/2021.10.25.465764');

    const urls = (global.fetch as any).mock.calls.map((c: unknown[]) => String(c[0]));
    // same host serves both collections → no medrxiv probe after transport failure
    expect(urls.some(u => u.includes('/details/medrxiv/'))).toBe(false);
    // official API unreachable → /pubs would be pure wasted latency
    expect(urls.some(u => u.includes('/pubs/'))).toBe(false);
    // EPMC degraded core with published from the "Preprint of" link, no network call
    expect(result.preprint?.data_source).toBe('europepmc');
    expect(result.published).toEqual({ pmid: '32015507', source: 'europepmc' });
  }, 20000);

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
      if (u.includes('api.biorxiv.org/')) return Promise.reject(new Error('network down'));
      if (u.includes('ebi.ac.uk')) return Promise.resolve(jsonResponse(epmcWithoutLink));
      return Promise.reject(new Error(`unexpected url ${u}`));
    }) as any;

    const result = await articleGet('10.1101/2021.10.25.465764');

    expect(result.preprint?.data_source).toBe('europepmc');
    expect(result.published).toBeNull();
  }, 20000);

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
      if (u.includes('api.biorxiv.org/details/biorxiv/')) return Promise.resolve(jsonResponse(detailsWithPublishedDoi));
      // /pubs soft miss → no published mapping from the official pubs endpoint
      if (u.includes('api.biorxiv.org/pubs/')) return Promise.resolve(jsonResponse({ messages: [{ status: 'no posts found' }], collection: [] }));
      // no EPMC record → no "Preprint of" link either
      if (u.includes('ebi.ac.uk')) return Promise.resolve(jsonResponse({ resultList: { result: [] } }));
      return Promise.reject(new Error(`unexpected url ${u}`));
    }) as any;

    const result = await articleGet('10.1101/2025.03.05.641768');

    // fallback chain end: /details record's own `published` DOI field
    expect(result.published).toEqual({ doi: '10.1234/journal.2024.01.001', source: 'biorxiv_details' });
  }, 15000);

  test('articleGet preprint citation section carries _error when the PPR endpoints reject', async () => {
    global.fetch = jest.fn((url: unknown) => {
      const u = String(url);
      if (u.includes('api.biorxiv.org/details/biorxiv/')) return Promise.resolve(jsonResponse(biorxivDetailsPayload('bioRxiv', ['1'])));
      if (u.includes('api.biorxiv.org/pubs/')) return Promise.resolve(jsonResponse({ messages: [{ status: 'no posts found' }], collection: [] }));
      // both PPR legs reject; the non-network message keeps the europepmc
      // registry retry (1 retry on network signatures) out of the timing
      if (u.includes('/PPR910295/citations') || u.includes('/PPR910295/references')) {
        return Promise.reject(new Error('PPR citation endpoints exploded'));
      }
      if (u.includes('ebi.ac.uk')) return Promise.resolve(jsonResponse(epmcCorePayload));
      return Promise.reject(new Error(`unexpected url ${u}`));
    }) as any;

    const result = await articleGet('10.1101/2021.10.25.465764', ['citation']);

    // exact fetchPprCitationSection catch shape: `Preprint citation lookup failed: <msg>`
    expect(result.sections?.citation).toEqual({ _error: 'Preprint citation lookup failed: PPR citation endpoints exploded' });
  }, 15000);

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
      if (u.includes('api.biorxiv.org/details/biorxiv/')) return Promise.resolve(jsonResponse(detailsNaFunder));
      if (u.includes('api.biorxiv.org/pubs/')) return Promise.resolve(jsonResponse({ messages: [{ status: 'no posts found' }], collection: [] }));
      if (u.includes('ebi.ac.uk')) return Promise.resolve(jsonResponse(epmcCorePayload));
      return Promise.reject(new Error(`unexpected url ${u}`));
    }) as any;

    const result = await articleGet('10.1101/2025.03.05.641768');

    expect(result.preprint?.data_source).toBe('api.biorxiv.org');
    expect(result.preprint?.funders).toBeUndefined();
  }, 15000);

  test('articleGet preprint citation limit slices forward citations and references', async () => {
    const threeCitations = [1, 2, 3].map(i => ({
      id: String(1000 + i), source: 'MED', title: `Citing paper ${i}`, authorString: 'Doe J', journalTitle: 'Nature', pubYear: '2023',
    }));
    const threeReferences = [1, 2, 3].map(i => ({
      id: String(2000 + i), source: 'MED', title: `Referenced paper ${i}`, authorString: 'Roe A', journalTitle: 'Science', pubYear: '2019',
    }));
    global.fetch = jest.fn((url: unknown) => {
      const u = String(url);
      if (u.includes('api.biorxiv.org/details/biorxiv/')) return Promise.resolve(jsonResponse(biorxivDetailsPayload('bioRxiv', ['1'])));
      if (u.includes('api.biorxiv.org/pubs/')) return Promise.resolve(jsonResponse({ messages: [{ status: 'no posts found' }], collection: [] }));
      if (u.includes('/PPR910295/citations')) return Promise.resolve(jsonResponse({ hitCount: 3, citationList: { citation: threeCitations } }));
      if (u.includes('/PPR910295/references')) return Promise.resolve(jsonResponse({ referenceList: { reference: threeReferences } }));
      if (u.includes('ebi.ac.uk')) return Promise.resolve(jsonResponse(epmcCorePayload));
      return Promise.reject(new Error(`unexpected url ${u}`));
    }) as any;

    const result = await articleGet('10.1101/2021.10.25.465764', ['citation'], { limit: 2 });

    const citation = result.sections?.citation as any;
    expect(citation.forward_citations).toHaveLength(2);
    // slice keeps the head of the list (post filter+transform)
    expect(citation.forward_citations.map((c: any) => c.title)).toEqual(['Citing paper 1', 'Citing paper 2']);
    expect(citation.backward_references).toHaveLength(2);
    // fetch pageSize = max(limit*3, 10) — the limit still governs the returned window
    const urls = (global.fetch as any).mock.calls.map((c: unknown[]) => String(c[0]));
    expect(urls.find(u => u.includes('/PPR910295/citations'))).toContain('pageSize=10');
  }, 15000);

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
      if (u.includes('api.biorxiv.org/details/biorxiv/')) return Promise.resolve(jsonResponse(biorxivDetailsPayload('bioRxiv', ['1'])));
      if (u.includes('api.biorxiv.org/pubs/')) return Promise.resolve(jsonResponse({ messages: [{ status: 'no posts found' }], collection: [] }));
      if (u.includes('ebi.ac.uk')) return Promise.resolve(jsonResponse({ resultList: { result: [] } }));
      return Promise.reject(new Error(`unexpected url ${u}`));
    }) as any;

    const result = await getPreprintArticle('10.1101/2024.01.01.12345?v=x');

    expect(result.preprint?.data_source).toBe('api.biorxiv.org');
    const urls = (global.fetch as any).mock.calls.map((c: unknown[]) => String(c[0]));
    const detailsUrl = urls.find(u => u.includes('/details/biorxiv/')) ?? '';
    // reserved chars encoded per segment ('?' → %3F, '=' → %3D), '/' preserved
    expect(detailsUrl).toContain('2024.01.01.12345%3Fv%3Dx');
    expect(detailsUrl).not.toContain('?v=x');
    const pubsUrl = urls.find(u => u.includes('/pubs/')) ?? '';
    expect(pubsUrl).toContain('2024.01.01.12345%3Fv%3Dx/na');
  }, 15000);
});
