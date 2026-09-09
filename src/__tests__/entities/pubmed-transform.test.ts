import { parsePubMedXml } from '../../entities/article/transform/pubmed.js';

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
<Author><CollectiveName>Test Group</CollectiveName></Author>
</AuthorList>
<PublicationTypeList>
<PublicationType>Journal Article</PublicationType>
</PublicationTypeList>
</Article>
<MeshHeadingList>
<MeshHeading><DescriptorName>BRCA1 Protein</DescriptorName></MeshHeading>
<MeshHeading><DescriptorName>Humans</DescriptorName></MeshHeading>
</MeshHeadingList>
<ChemicalList>
<Chemical>
<NameOfSubstance>Test Chemical</NameOfSubstance>
</Chemical>
</ChemicalList>
<KeywordList>
<Keyword>BRCA1</Keyword>
<Keyword>Genetics</Keyword>
</KeywordList>
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
<JournalIssue><Volume>500</Volume><PubDate><Year>2023</Year><Month>Jun</Month></PubDate>
</JournalIssue>
</Journal>
<ArticleTitle>Structured abstract test</ArticleTitle>
<Abstract>
<AbstractText Label="BACKGROUND">Background info here.</AbstractText>
<AbstractText Label="METHODS">Methods described here.</AbstractText>
<AbstractText Label="RESULTS">Results shown here.</AbstractText>
</Abstract>
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

const EMPTY_XML = `<?xml version="1.0"?>
<PubmedArticleSet>
</PubmedArticleSet>`;

const MEDLINE_DATE_XML = `<?xml version="1.0"?>
<PubmedArticleSet>
<PubmedArticle>
<MedlineCitation><PMID Version="1">99999</PMID>
<Article>
<Journal>
<ISOAbbreviation>J Med</ISOAbbreviation>
<JournalIssue>
<PubDate><MedlineDate>2023 Sep-Oct</MedlineDate></PubDate>
</JournalIssue>
</Journal>
<ArticleTitle>Medline date test</ArticleTitle>
</Article></MedlineCitation>
<PubmedData><ArticleIdList><ArticleId IdType="pubmed">99999</ArticleId></ArticleIdList></PubmedData>
</PubmedArticle>
</PubmedArticleSet>`;

const ELOCATION_DOI_XML = `<?xml version="1.0"?>
<PubmedArticleSet>
<PubmedArticle>
<MedlineCitation><PMID Version="1">88888</PMID>
<Article>
<ArticleTitle>ELocation DOI test</ArticleTitle>
<Journal><ISOAbbreviation>J Test</ISOAbbreviation></Journal>
<ELocationID EIdType="doi">10.9999/eloc.test</ELocationID>
</Article></MedlineCitation>
<PubmedData><ArticleIdList><ArticleId IdType="pubmed">88888</ArticleId></ArticleIdList></PubmedData>
</PubmedArticle>
</PubmedArticleSet>`;

describe('parsePubMedXml', () => {
  test('parses single article', () => {
    const results = parsePubMedXml(SINGLE_ARTICLE_XML);
    expect(results).toHaveLength(1);
    expect(results[0].pmid).toBe('12345');
  });

  test('parses batch of articles', () => {
    const results = parsePubMedXml(BATCH_XML);
    expect(results).toHaveLength(2);
    expect(results[0].pmid).toBe('111');
    expect(results[1].pmid).toBe('222');
  });

  test('returns empty array for empty XML', () => {
    const results = parsePubMedXml(EMPTY_XML);
    expect(results).toEqual([]);
  });

  test('returns empty array for invalid XML', () => {
    // fast-xml-parser doesn't throw on invalid XML, just returns empty result
    const results = parsePubMedXml('not xml');
    expect(results).toEqual([]);
  });

  test('returns empty array for XML without PubmedArticleSet', () => {
    const results = parsePubMedXml('<?xml version="1.0"?><data></data>');
    expect(results).toEqual([]);
  });

  test('extracts PMID', () => {
    const results = parsePubMedXml(SINGLE_ARTICLE_XML);
    expect(results[0].pmid).toBe('12345');
  });

  test('extracts PMCID', () => {
    const results = parsePubMedXml(SINGLE_ARTICLE_XML);
    expect(results[0].pmcid).toBe('PMC9999999');
  });

  test('extracts DOI from ArticleIdList', () => {
    const results = parsePubMedXml(SINGLE_ARTICLE_XML);
    expect(results[0].doi).toBe('10.1234/test.2018');
  });

  test('extracts DOI from ELocationID when not in ArticleIdList', () => {
    const results = parsePubMedXml(ELOCATION_DOI_XML);
    expect(results[0].doi).toBe('10.9999/eloc.test');
  });

  test('extracts title', () => {
    const results = parsePubMedXml(SINGLE_ARTICLE_XML);
    expect(results[0].title).toBe('Test article about BRCA1');
  });

  test('extracts plain abstract', () => {
    const results = parsePubMedXml(SINGLE_ARTICLE_XML);
    expect(results[0].abstract).toBe('Full abstract text for testing purposes.');
  });

  test('extracts structured abstract with labels', () => {
    const results = parsePubMedXml(STRUCTURED_ABSTRACT_XML);
    expect(results[0].abstract).toBe('BACKGROUND: Background info here. METHODS: Methods described here. RESULTS: Results shown here.');
  });

  test('extracts authors', () => {
    const results = parsePubMedXml(SINGLE_ARTICLE_XML);
    expect(results[0].authors).toEqual(['Smith John', 'Doe Jane', 'Test Group']);
  });

  test('includes collective names in authors when present', () => {
    const results = parsePubMedXml(SINGLE_ARTICLE_XML);
    expect(results[0].authors).toContain('Test Group');
  });

  test('extracts journal from ISOAbbreviation', () => {
    const results = parsePubMedXml(SINGLE_ARTICLE_XML);
    expect(results[0].journal).toBe('Sci Rep');
  });

  test('extracts journal from Title when ISOAbbreviation missing', () => {
    const xml = `<?xml version="1.0"?>
<PubmedArticleSet>
<PubmedArticle>
<MedlineCitation><PMID Version="1">111</PMID>
<Article><Journal><Title>Full Journal Name</Title></Journal></Article>
</MedlineCitation>
<PubmedData><ArticleIdList><ArticleId IdType="pubmed">111</ArticleId></ArticleIdList></PubmedData>
</PubmedArticle>
</PubmedArticleSet>`;
    const results = parsePubMedXml(xml);
    expect(results[0].journal).toBe('Full Journal Name');
  });

  test('extracts publication date from Year/Month/Day', () => {
    const results = parsePubMedXml(SINGLE_ARTICLE_XML);
    expect(results[0].publication_date).toBe('2018 Sep 21');
  });

  test('extracts publication date from MedlineDate', () => {
    const results = parsePubMedXml(MEDLINE_DATE_XML);
    expect(results[0].publication_date).toBe('2023 Sep-Oct');
  });

  test('extracts MeSH headings', () => {
    const results = parsePubMedXml(SINGLE_ARTICLE_XML);
    expect(results[0].mesh_headings).toEqual(['BRCA1 Protein', 'Humans']);
  });

  test('extracts publication types', () => {
    const results = parsePubMedXml(SINGLE_ARTICLE_XML);
    expect(results[0].publication_types).toEqual(['Journal Article']);
  });

  test('extracts keywords', () => {
    const results = parsePubMedXml(SINGLE_ARTICLE_XML);
    expect(results[0].keywords).toEqual(['BRCA1', 'Genetics']);
  });

  test('extracts chemicals', () => {
    const results = parsePubMedXml(SINGLE_ARTICLE_XML);
    expect(results[0].chemicals).toEqual(['Test Chemical']);
  });

  test('sets source to pubmed', () => {
    const results = parsePubMedXml(SINGLE_ARTICLE_XML);
    expect(results[0].source).toBe('pubmed');
  });

  test('handles missing optional fields', () => {
    const minimalXml = `<?xml version="1.0"?>
<PubmedArticleSet>
<PubmedArticle>
<MedlineCitation><PMID Version="1">12345</PMID>
<Article></Article>
</MedlineCitation>
<PubmedData><ArticleIdList><ArticleId IdType="pubmed">12345</ArticleId></ArticleIdList></PubmedData>
</PubmedArticle>
</PubmedArticleSet>`;
    const results = parsePubMedXml(minimalXml);
    expect(results[0].pmid).toBe('12345');
    expect(results[0].title).toBeUndefined();
    expect(results[0].abstract).toBeUndefined();
    expect(results[0].authors).toBeUndefined();
  });

  test('handles missing authors list', () => {
    const xml = `<?xml version="1.0"?>
<PubmedArticleSet>
<PubmedArticle>
<MedlineCitation><PMID Version="1">123</PMID>
<Article><ArticleTitle>No authors</ArticleTitle></Article>
</MedlineCitation>
<PubmedData><ArticleIdList><ArticleId IdType="pubmed">123</ArticleId></ArticleIdList></PubmedData>
</PubmedArticle>
</PubmedArticleSet>`;
    const results = parsePubMedXml(xml);
    expect(results[0].authors).toBeUndefined();
  });

  test('handles author with only LastName', () => {
    const xml = `<?xml version="1.0"?>
<PubmedArticleSet>
<PubmedArticle>
<MedlineCitation><PMID Version="1">123</PMID>
<Article>
<ArticleTitle>Last name only</ArticleTitle>
<AuthorList><Author><LastName>Only</LastName></Author></AuthorList>
</Article>
</MedlineCitation>
<PubmedData><ArticleIdList><ArticleId IdType="pubmed">123</ArticleId></ArticleIdList></PubmedData>
</PubmedArticle>
</PubmedArticleSet>`;
    const results = parsePubMedXml(xml);
    expect(results[0].authors).toEqual(['Only']);
  });

  test('handles empty string abstract text element', () => {
    const xml = `<?xml version="1.0"?>
<PubmedArticleSet>
<PubmedArticle>
<MedlineCitation><PMID Version="1">123</PMID>
<Article>
<ArticleTitle>Empty abstract</ArticleTitle>
<Abstract><AbstractText></AbstractText></Abstract>
</Article>
</MedlineCitation>
<PubmedData><ArticleIdList><ArticleId IdType="pubmed">123</ArticleId></ArticleIdList></PubmedData>
</PubmedArticle>
</PubmedArticleSet>`;
    const results = parsePubMedXml(xml);
    expect(results[0].abstract).toBe('');
  });

  test('extracts volume, issue, and pages from MedlinePgn', () => {
    const xml = `<?xml version="1.0"?>
<PubmedArticleSet>
<PubmedArticle>
<MedlineCitation><PMID Version="1">21639808</PMID>
<Article>
<Journal>
<ISOAbbreviation>N Engl J Med</ISOAbbreviation>
<JournalIssue><Volume>364</Volume><Issue>26</Issue>
<PubDate><Year>2011</Year><Month>Jun</Month><Day>30</Day></PubDate>
</JournalIssue>
</Journal>
<ArticleTitle>Improved survival with vemurafenib in melanoma</ArticleTitle>
<Pagination><StartPage>2507</StartPage><EndPage>2516</EndPage><MedlinePgn>2507-16</MedlinePgn></Pagination>
<ELocationID EIdType="doi">10.1056/NEJMoa1103782</ELocationID>
</Article>
</MedlineCitation>
<PubmedData><ArticleIdList><ArticleId IdType="pubmed">21639808</ArticleId><ArticleId IdType="doi">10.1056/NEJMoa1103782</ArticleId></ArticleIdList></PubmedData>
</PubmedArticle>
</PubmedArticleSet>`;
    const results = parsePubMedXml(xml);
    expect(results[0].volume).toBe('364');
    expect(results[0].issue).toBe('26');
    expect(results[0].pages).toBe('2507-16');
    expect(results[0].doi).toBe('10.1056/NEJMoa1103782');
  });

  test('falls back to StartPage-EndPage when MedlinePgn is missing', () => {
    const xml = `<?xml version="1.0"?>
<PubmedArticleSet>
<PubmedArticle>
<MedlineCitation><PMID Version="1">111</PMID>
<Article>
<Journal><JournalIssue><Volume>12</Volume></JournalIssue></Journal>
<ArticleTitle>Range pagination</ArticleTitle>
<Pagination><StartPage>100</StartPage><EndPage>110</EndPage></Pagination>
</Article>
</MedlineCitation>
<PubmedData><ArticleIdList><ArticleId IdType="pubmed">111</ArticleId></ArticleIdList></PubmedData>
</PubmedArticle>
<PubmedArticle>
<MedlineCitation><PMID Version="1">222</PMID>
<Article>
<ArticleTitle>Single page</ArticleTitle>
<Pagination><StartPage>42</StartPage></Pagination>
</Article>
</MedlineCitation>
<PubmedData><ArticleIdList><ArticleId IdType="pubmed">222</ArticleId></ArticleIdList></PubmedData>
</PubmedArticle>
</PubmedArticleSet>`;
    const results = parsePubMedXml(xml);
    expect(results[0].volume).toBe('12');
    expect(results[0].pages).toBe('100-110');
    expect(results[1].pages).toBe('42');
  });

  test('falls back to pii elocation when no pagination exists', () => {
    const xml = `<?xml version="1.0"?>
<PubmedArticleSet>
<PubmedArticle>
<MedlineCitation><PMID Version="1">333</PMID>
<Article>
<ArticleTitle>Nature e-location paper</ArticleTitle>
<ELocationID EIdType="pii">nature11071</ELocationID>
</Article>
</MedlineCitation>
<PubmedData><ArticleIdList><ArticleId IdType="pubmed">333</ArticleId></ArticleIdList></PubmedData>
</PubmedArticle>
</PubmedArticleSet>`;
    const results = parsePubMedXml(xml);
    expect(results[0].pages).toBe('nature11071');
  });

  test('maps doi and pii from multiple ELocationID entries', () => {
    const xml = `<?xml version="1.0"?>
<PubmedArticleSet>
<PubmedArticle>
<MedlineCitation><PMID Version="1">444</PMID>
<Article>
<ArticleTitle>Dual elocation paper</ArticleTitle>
<ELocationID EIdType="doi">10.1038/nature11071</ELocationID>
<ELocationID EIdType="pii">S0140-6736(18)30123-4</ELocationID>
</Article>
</MedlineCitation>
<PubmedData><ArticleIdList><ArticleId IdType="pubmed">444</ArticleId></ArticleIdList></PubmedData>
</PubmedArticle>
</PubmedArticleSet>`;
    const results = parsePubMedXml(xml);
    expect(results[0].doi).toBe('10.1038/nature11071');
    expect(results[0].pages).toBe('S0140-6736(18)30123-4');
  });

  test('doi-only elocation yields no pages', () => {
    const results = parsePubMedXml(ELOCATION_DOI_XML);
    expect(results[0].doi).toBe('10.9999/eloc.test');
    expect(results[0].pages).toBeUndefined();
  });

  test('leaves locator fields absent when record has none', () => {
    const results = parsePubMedXml(BATCH_XML);
    expect(results[0].volume).toBeUndefined();
    expect(results[0].issue).toBeUndefined();
    expect(results[0].pages).toBeUndefined();
  });

  test('decodes numeric character references in titles and authors', () => {
    const xml = `<?xml version="1.0"?>
<PubmedArticleSet>
<PubmedArticle>
<MedlineCitation><PMID Version="1">555</PMID>
<Article>
<ArticleTitle>&#x3b2;-catenin &amp; WNT signaling in cancer&#xa0;review</ArticleTitle>
<AuthorList>
<Author><LastName>J&#xe9;r&#xe9;my</LastName><ForeName>Raymond</ForeName></Author>
</AuthorList>
</Article>
</MedlineCitation>
<PubmedData><ArticleIdList><ArticleId IdType="pubmed">555</ArticleId></ArticleIdList></PubmedData>
</PubmedArticle>
</PubmedArticleSet>`;
    const results = parsePubMedXml(xml);
    expect(results[0].title).toBe('\u03b2-catenin & WNT signaling in cancer\u00a0review');
    expect(results[0].authors).toEqual(['J\u00e9r\u00e9my Raymond']);
  });
});
