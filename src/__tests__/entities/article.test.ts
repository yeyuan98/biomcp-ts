import { jest } from '@jest/globals';
import { articleSearch, articleGet, deduplicateAndRank, transformPubTator, transformLitSense, transformEuropePMC, transformSemanticScholar } from '../../entities/article.js';
import { parsePubMedXml } from '../../transform/pubmed.js';

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

const STRUCTURED_ABSTRACT_XML = `<?xml version="1.0"?>
<PubmedArticleSet>
<PubmedArticle>
<MedlineCitation Status="MEDLINE" Owner="NLM">
<PMID Version="1">67890</PMID>
<Article PubModel="Print">
<Journal>
<Title>Nature</Title>
<ISOAbbreviation>Nature</ISOAbbreviation>
<JournalIssue><Volume>500</Volume>
<PubDate><Year>2023</Year><Month>Jun</Month></PubDate>
</JournalIssue>
</Journal>
<ArticleTitle>Structured abstract test</ArticleTitle>
<Abstract>
<AbstractText Label="BACKGROUND">Background info here.</AbstractText>
<AbstractText Label="METHODS">Methods described here.</AbstractText>
<AbstractText Label="RESULTS">Results shown here.</AbstractText>
</Abstract>
<AuthorList>
<Author><LastName>Test</LastName><ForeName>Author</ForeName></Author>
</AuthorList>
</Article>
</MedlineCitation>
<PubmedData>
<ArticleIdList>
<ArticleId IdType="pubmed">67890</ArticleId>
</ArticleIdList>
</PubmedData>
</PubmedArticle>
</PubmedArticleSet>`;

const BATCH_XML = `<?xml version="1.0"?>
<PubmedArticleSet>
<PubmedArticle>
<MedlineCitation><PMID Version="1">111</PMID>
<Article><ArticleTitle>First article</ArticleTitle>
<Abstract><AbstractText>Abstract one.</AbstractText></Abstract>
<Journal><ISOAbbreviation>J One</ISOAbbreviation></Journal>
</Article></MedlineCitation>
<PubmedData><ArticleIdList><ArticleId IdType="pubmed">111</ArticleId></ArticleIdList></PubmedData>
</PubmedArticle>
<PubmedArticle>
<MedlineCitation><PMID Version="1">222</PMID>
<Article><ArticleTitle>Second article</ArticleTitle>
<Abstract><AbstractText>Abstract two.</AbstractText></Abstract>
<Journal><ISOAbbreviation>J Two</ISOAbbreviation></Journal>
</Article></MedlineCitation>
<PubmedData><ArticleIdList><ArticleId IdType="pubmed">222</ArticleId></ArticleIdList></PubmedData>
</PubmedArticle>
</PubmedArticleSet>`;

describe('article', () => {
  let originalFetch: typeof global.fetch;

  beforeEach(() => {
    jest.clearAllMocks();
    originalFetch = global.fetch;
    process.env.NCBI_API_KEY = '';
  });

  afterEach(() => {
    global.fetch = originalFetch;
    delete process.env.NCBI_API_KEY;
  });

  test('articleSearch() calls ESearch then EFetch for PubMed', async () => {
    global.fetch = jest.fn()
      .mockResolvedValueOnce({
        ok: true,
        headers: new Headers({ 'content-type': 'application/json' }),
        json: () => Promise.resolve({ esearchresult: { idlist: ['12345'] } }),
      })
      .mockResolvedValueOnce({
        ok: true,
        headers: new Headers({ 'content-type': 'text/xml' }),
        text: () => Promise.resolve(SINGLE_ARTICLE_XML),
      }) as any;

    const results = await articleSearch('brca1', { source: 'pubmed' });

    expect(global.fetch).toHaveBeenCalledTimes(2);
    const searchCallUrl = (global.fetch as any).mock.calls[0][0] as string;
    expect(searchCallUrl).toContain('esearch.fcgi');
    expect(searchCallUrl).toContain('term=brca1');

    const fetchCallUrl = (global.fetch as any).mock.calls[1][0] as string;
    expect(fetchCallUrl).toContain('efetch.fcgi');

    expect(results).toHaveLength(1);
    expect(results[0].pmid).toBe('12345');
    expect(results[0].title).toBe('Test article about BRCA1');
    expect(results[0].abstract).toBe('Full abstract text for testing purposes.');
    expect(results[0].journal).toBe('Sci Rep');
    expect(results[0].authors).toEqual(['Smith John', 'Doe Jane']);
    expect(results[0].doi).toBe('10.1234/test.2018');
    expect(results[0].pmcid).toBe('PMC9999999');
    expect(results[0].mesh_headings).toEqual(['BRCA1 Protein', 'Humans']);
    expect(results[0].publication_types).toEqual(['Journal Article']);
  });

  test('articleSearch() returns empty on empty results', async () => {
    global.fetch = jest.fn().mockResolvedValue({
      ok: true,
      headers: new Headers({ 'content-type': 'application/json' }),
      json: () => Promise.resolve({ esearchresult: { idlist: [] } }),
    }) as any;

    const results = await articleSearch('nonexistent', { source: 'pubmed' });
    expect(results).toEqual([]);
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

  test('parsePubMedXml handles structured abstracts', () => {
    const articles = parsePubMedXml(STRUCTURED_ABSTRACT_XML);
    expect(articles).toHaveLength(1);
    expect(articles[0].abstract).toContain('BACKGROUND: Background info here.');
    expect(articles[0].abstract).toContain('METHODS: Methods described here.');
    expect(articles[0].abstract).toContain('RESULTS: Results shown here.');
  });

  test('parsePubMedXml handles batch of articles', () => {
    const articles = parsePubMedXml(BATCH_XML);
    expect(articles).toHaveLength(2);
    expect(articles[0].pmid).toBe('111');
    expect(articles[1].pmid).toBe('222');
  });

  test('parsePubMedXml returns empty for non-XML input', () => {
    const articles = parsePubMedXml('not xml');
    expect(articles).toEqual([]);
  });

  test('parsePubMedXml returns empty for empty document', () => {
    const articles = parsePubMedXml('<?xml version="1.0"?><PubmedArticleSet></PubmedArticleSet>');
    expect(articles).toEqual([]);
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

    const results = await articleSearch('brca1', { source: 'pubtator' });

    const callUrl = (global.fetch as any).mock.calls[0][0] as string;
    expect(callUrl).toContain('/search/?text=');
    expect(callUrl).toContain('brca1');
    expect(results).toHaveLength(1);
    expect(results[0].pmid).toBe('34083286');
    expect(results[0].pmcid).toBe('PMC999');
    expect(results[0].authors).toEqual(['Smith J']);
    expect(results[0].journal).toBe('Nature');
    expect(results[0].doi).toBe('10.1234/test');
    expect(results[0].source).toBe('pubtator');
  });

  test('articleSearch() with litsense source uses /sentences/?query= endpoint', async () => {
    global.fetch = jest.fn().mockResolvedValue({
      ok: true,
      headers: new Headers({ 'content-type': 'application/json' }),
      json: () => Promise.resolve([
        { pmid: 12345, text: 'This is a relevant sentence.', score: 0.95, section: 'abstract', annotations: [] },
      ]),
    }) as any;

    const results = await articleSearch('brca1', { source: 'litsense' });

    const callUrl = (global.fetch as any).mock.calls[0][0] as string;
    expect(callUrl).toContain('/sentences/?query=');
    expect(callUrl).toContain('brca1');
    expect(results).toHaveLength(1);
    expect(results[0].pmid).toBe('12345');
    expect(results[0].abstract).toBe('This is a relevant sentence.');
    expect(results[0].score).toBe(0.95);
    expect(results[0].source).toBe('litsense');
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
    expect(result.abstract).toBe('A sentence about BRCA1.');
    expect(result.score).toBe(0.88);
    expect(result.source).toBe('litsense');
  });

  test('transformEuropePMC maps fields correctly', () => {
    const result = transformEuropePMC({
      pubmedId: '12345',
      pmcId: 'PMC999',
      doi: '10.1234/test',
      title: 'Europe PMC Article',
      authorString: 'Smith J, Doe A',
      journalTitle: 'Nature',
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
    expect(result.cited_by).toBe(42);
    expect(result.is_open_access).toBe(true);
    expect(result.source).toBe('europepmc');
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

  test('deduplicateAndRank deduplicates by pmid and sorts by cited_by', () => {
    const articles = [
      { pmid: '1', title: 'A', cited_by: 5, source: 'pubmed' as const },
      { pmid: '2', title: 'B', cited_by: 20, source: 'pubmed' as const },
      { pmid: '1', title: 'A dup', cited_by: 10, source: 'europepmc' as const },
      { pmid: '3', title: 'C', cited_by: 15, source: 'pubmed' as const },
    ];

    const result = deduplicateAndRank(articles, 3);

    expect(result).toHaveLength(3);
    expect(result[0].pmid).toBe('2');
    expect(result[1].pmid).toBe('3');
    expect(result[2].pmid).toBe('1');
    expect(result[2].title).toBe('A');
  });

  test('articleSearch() returns empty for unknown source', async () => {
    const results = await articleSearch('brca1', { source: 'unknown' as any });
    expect(results).toEqual([]);
  });
});
