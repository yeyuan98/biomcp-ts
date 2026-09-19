import { jest } from '@jest/globals';
import { articleSearch, searchArxiv, parseArxivAtomXml } from '../../entities/article.js';
import { connectionManager } from '../../connections/manager.js';

// The 'arxiv' registry source enforces the arXiv Terms-of-Use rate (1
// request / 3 s) via a capacity-1 token bucket and retries 429s after a
// ~3.5 s backoff. The limiter's acquire() is mocked to a no-op (precedent:
// src/__tests__/connections/rest.test.ts:6) so tests stay fast; the 429
// fault-injection test intentionally sleeps through ONE real retry backoff
// (~3.5 s) so the registry retry policy itself is exercised.
jest.mock('../../connections/rate-limiter.js', () => ({
  TokenBucketRateLimiter: jest.fn().mockImplementation(() => ({
    acquire: jest.fn().mockResolvedValue(undefined),
  })),
  RateLimiterFactory: {
    create: jest.fn().mockReturnValue({ acquire: jest.fn().mockResolvedValue(undefined) }),
    getEffectiveRate: jest.fn().mockReturnValue(3000),
  },
}));

// Trimmed from /tmp/opencode/arxiv-api-research/r18_multi_id.xml (real API
// response, captured 2026-09-19). Entry 1: single author (with leading
// space), arxiv:doi, doi link, single category, old-style versioned id.
// Entry 3: multi-author with (multi-)affiliations, no DOI, single category;
// summary retains the real leading whitespace and &lt;/&gt; entities.
// Summaries truncated; structure preserved verbatim.
const MULTI_ENTRY_XML = `<?xml version='1.0' encoding='UTF-8'?>
<feed xmlns:opensearch="http://a9.com/-/spec/opensearch/1.1/" xmlns:arxiv="http://arxiv.org/schemas/atom" xmlns="http://www.w3.org/2005/Atom">
  <id>https://arxiv.org/api/kbE+jLcHsSENBy428JNKSKJMjNA</id>
  <title>arXiv Query: search_query=&amp;id_list=hep-ex/0307015,0710.5765&amp;start=0&amp;max_results=10</title>
  <updated>2026-09-19T11:18:29Z</updated>
  <link href="https://arxiv.org/api/query?search_query=&amp;start=0&amp;max_results=10&amp;id_list=hep-ex/0307015,0710.5765" type="application/atom+xml"/>
  <opensearch:itemsPerPage>10</opensearch:itemsPerPage>
  <opensearch:totalResults>2</opensearch:totalResults>
  <opensearch:startIndex>0</opensearch:startIndex>
  <entry>
    <id>http://arxiv.org/abs/hep-ex/0307015v1</id>
    <title>Multi-Electron Production at High Transverse Momenta in ep Collisions at HERA</title>
    <updated>2003-07-07T17:46:39Z</updated>
    <link href="https://arxiv.org/abs/hep-ex/0307015v1" rel="alternate" type="text/html"/>
    <link href="https://arxiv.org/pdf/hep-ex/0307015v1" rel="related" type="application/pdf" title="pdf"/>
    <summary>  Multi-electron production is studied at high electron transverse momentum in positron- and electron-proton collisions using the H1 detector at HERA.</summary>
    <category term="hep-ex" scheme="http://arxiv.org/schemas/atom"/>
    <published>2003-07-07T17:46:39Z</published>
    <arxiv:comment>23 pages, 8 figures and 4 tables</arxiv:comment>
    <arxiv:primary_category term="hep-ex"/>
    <arxiv:journal_ref>Eur.Phys.J.C31:17-29,2003</arxiv:journal_ref>
    <author>
      <name> H1 Collaboration</name>
    </author>
    <arxiv:doi>10.1140/epjc/s2003-01326-x</arxiv:doi>
    <link rel="related" href="https://doi.org/10.1140/epjc/s2003-01326-x" title="doi"/>
  </entry>
  <entry>
    <id>http://arxiv.org/abs/0710.5765v1</id>
    <title>Halo Gas Cross Sections And Covering Fractions of MgII Absorption Selected Galaxies</title>
    <updated>2007-10-30T21:18:23Z</updated>
    <link href="https://arxiv.org/abs/0710.5765v1" rel="alternate" type="text/html"/>
    <link href="https://arxiv.org/pdf/0710.5765v1" rel="related" type="application/pdf" title="pdf"/>
    <summary>  We examine halo gas cross sections and covering fractions, f_c, of intermediate redshift MgII absorption selected galaxies. For equivalent widths W_r(2796) &gt; 0.3 Ang, we find 43 &lt; R_x &lt; 88 kpc and obtain a mean of &lt;f_c&gt; ~ 0.6 for our sample.</summary>
    <category term="astro-ph" scheme="http://arxiv.org/schemas/atom"/>
    <published>2007-10-30T21:18:23Z</published>
    <arxiv:comment>6 pages, 2 figures, Accepted for publication in AJ</arxiv:comment>
    <arxiv:primary_category term="astro-ph"/>
    <author>
      <name>G. G. Kacprzak</name>
      <arxiv:affiliation>NMSU</arxiv:affiliation>
    </author>
    <author>
      <name>C. W. Churchill</name>
      <arxiv:affiliation>NMSU</arxiv:affiliation>
    </author>
    <author>
      <name>C. C. Steidel</name>
      <arxiv:affiliation>Caltech</arxiv:affiliation>
    </author>
    <author>
      <name>M. T. Murphy</name>
      <arxiv:affiliation>IoA</arxiv:affiliation>
      <arxiv:affiliation>Swinburne</arxiv:affiliation>
    </author>
  </entry>
</feed>`;

// Trimmed from r15_id_versioned.xml (id_list=1706.03762v2): http + versioned
// new-style id, multi-author, two categories. Authors/summary truncated.
const VERSIONED_ID_XML = `<?xml version='1.0' encoding='UTF-8'?>
<feed xmlns:opensearch="http://a9.com/-/spec/opensearch/1.1/" xmlns:arxiv="http://arxiv.org/schemas/atom" xmlns="http://www.w3.org/2005/Atom">
  <id>https://arxiv.org/api/N9oUB3XqzQgf/rXwiFWDZBQUDL4</id>
  <title>arXiv Query: search_query=&amp;id_list=1706.03762v2&amp;start=0&amp;max_results=10</title>
  <updated>2026-09-19T11:17:54Z</updated>
  <link href="https://arxiv.org/api/query?search_query=&amp;start=0&amp;max_results=10&amp;id_list=1706.03762v2" type="application/atom+xml"/>
  <opensearch:itemsPerPage>10</opensearch:itemsPerPage>
  <opensearch:totalResults>1</opensearch:totalResults>
  <opensearch:startIndex>0</opensearch:startIndex>
  <entry>
    <id>http://arxiv.org/abs/1706.03762v2</id>
    <title>Attention Is All You Need</title>
    <updated>2017-06-19T16:49:45Z</updated>
    <link href="https://arxiv.org/abs/1706.03762v2" rel="alternate" type="text/html"/>
    <link href="https://arxiv.org/pdf/1706.03762v2" rel="related" type="application/pdf" title="pdf"/>
    <summary>The dominant sequence transduction models are based on complex recurrent or convolutional neural networks in an encoder-decoder configuration.</summary>
    <category term="cs.CL" scheme="http://arxiv.org/schemas/atom"/>
    <category term="cs.LG" scheme="http://arxiv.org/schemas/atom"/>
    <published>2017-06-12T17:57:34Z</published>
    <arxiv:comment>15 pages, 5 figure</arxiv:comment>
    <arxiv:primary_category term="cs.CL"/>
    <author>
      <name>Ashish Vaswani</name>
    </author>
    <author>
      <name>Noam Shazeer</name>
    </author>
  </entry>
</feed>`;

// Verbatim from r20_empty.xml: genuine zero-hit response (200 + empty feed).
const EMPTY_FEED_XML = `<?xml version='1.0' encoding='UTF-8'?>
<feed xmlns:opensearch="http://a9.com/-/spec/opensearch/1.1/" xmlns:arxiv="http://arxiv.org/schemas/atom" xmlns="http://www.w3.org/2005/Atom">
  <id>https://arxiv.org/api/t/5bXYtsWyJ+PvixGBi1InLNPYI</id>
  <title>arXiv Query: search_query=all:xqzjwqvxnonexistentterm&amp;id_list=&amp;start=0&amp;max_results=3</title>
  <updated>2026-09-19T11:18:37Z</updated>
  <link href="https://arxiv.org/api/query?search_query=all:xqzjwqvxnonexistentterm&amp;start=0&amp;max_results=3&amp;id_list=" type="application/atom+xml"/>
  <opensearch:itemsPerPage>3</opensearch:itemsPerPage>
  <opensearch:totalResults>0</opensearch:totalResults>
  <opensearch:startIndex>0</opensearch:startIndex>
</feed>`;

// Shape of the HTML error/robot pages arXiv serves instead of Atom under
// blocks or outages (plan D11 fail-fast case).
const HTML_PAGE = `<!DOCTYPE html>
<html><head><title>arXiv</title></head>
<body><h1>Request blocked</h1></body></html>`;

// Starts as a genuine feed but breaks mid-entry (truncated transfer): passes
// the `<?xml`/`<feed>` sniff, then fast-xml-parser throws on the unterminated
// tag — the mid-stream counterpart of the HTML fail-fast case.
const TRUNCATED_MID_ENTRY_XML = `<?xml version='1.0' encoding='UTF-8'?>
<feed xmlns="http://www.w3.org/2005/Atom">
  <entry>
    <id>http://arxiv.org/abs/1706.03762v2</id>
    <title>Attention Is All You Need</title>
    <published>2017-06-12T17:57:34Z</published>
    <category te`;

// Minimal single-entry feed wrapper for transform edge cases.
const singleEntryFeed = (entry: string) => `<?xml version='1.0' encoding='UTF-8'?>
<feed xmlns="http://www.w3.org/2005/Atom">
${entry}
</feed>`;

function atomResponse(xml: string) {
  return {
    ok: true,
    headers: new Headers({ 'content-type': 'application/atom+xml; charset=utf-8' }),
    text: () => Promise.resolve(xml),
  };
}

function jsonResponse(body: unknown) {
  return {
    ok: true,
    headers: new Headers({ 'content-type': 'application/json' }),
    json: () => Promise.resolve(body),
  };
}

describe('parseArxivAtomXml', () => {
  test('maps real multi-entry feed: multi-author, categories, affiliations, doi, old-style versioned id', () => {
    const articles = parseArxivAtomXml(MULTI_ENTRY_XML);

    expect(articles).toHaveLength(2);

    // Entry 1: single-author singular shape, doi present, id version-stripped.
    expect(articles[0].arxiv_id).toBe('hep-ex/0307015');
    expect(articles[0].doi).toBe('10.1140/epjc/s2003-01326-x');
    expect(articles[0].title).toBe('Multi-Electron Production at High Transverse Momenta in ep Collisions at HERA');
    expect(articles[0].abstract).toBe('Multi-electron production is studied at high electron transverse momentum in positron- and electron-proton collisions using the H1 detector at HERA.');
    expect(articles[0].authors).toEqual(['H1 Collaboration']);
    expect(articles[0].journal).toBe('arXiv');
    expect(articles[0].publication_date).toBe('2003-07-07');
    // Keywords dedupe: arXiv repeats the primary (hep-ex) in <category>.
    expect(articles[0].keywords).toEqual(['hep-ex']);
    expect(articles[0].publication_types).toEqual(['preprint']);
    expect(articles[0].source).toBe('arxiv');
    expect(articles[0].pmid).toBeUndefined();

    // Entry 2: affiliations normalized away, doi absent, entities unescaped,
    // leading summary whitespace trimmed, author names trimmed.
    expect(articles[1].arxiv_id).toBe('0710.5765');
    expect(articles[1].doi).toBeUndefined();
    expect(articles[1].authors).toEqual(['G. G. Kacprzak', 'C. W. Churchill', 'C. C. Steidel', 'M. T. Murphy']);
    expect(articles[1].abstract).toMatch(/^We examine halo gas/);
    expect(articles[1].abstract).toContain('43 < R_x < 88 kpc');
    expect(articles[1].abstract).toContain('<f_c>');
    expect(articles[1].abstract).not.toContain('&lt;');
    expect(articles[1].publication_date).toBe('2007-10-30');
  });

  test('extracts versionless arxiv_id from http + versioned new-style ids (r15)', () => {
    const articles = parseArxivAtomXml(VERSIONED_ID_XML);
    expect(articles).toHaveLength(1);
    expect(articles[0].arxiv_id).toBe('1706.03762');
    expect(articles[0].title).toBe('Attention Is All You Need');
    // Keywords dedupe: primary cs.CL repeated in <category> is dropped.
    expect(articles[0].keywords).toEqual(['cs.CL', 'cs.LG']);
    expect(articles[0].publication_date).toBe('2017-06-12');
  });

  test('tolerates UTF-8 BOM and leading whitespace before the XML declaration', () => {
    const articles = parseArxivAtomXml(`\uFEFF\n\t  ${VERSIONED_ID_XML}`);
    expect(articles).toHaveLength(1);
    expect(articles[0].arxiv_id).toBe('1706.03762');
  });

  test('throws a descriptive error on HTML (non-feed) input', () => {
    expect(() => parseArxivAtomXml(HTML_PAGE)).toThrow('Unexpected arXiv response');
    expect(() => parseArxivAtomXml(HTML_PAGE)).toThrow(/HTML error or block page/);
  });

  test('empty feed returns [] (0 hits are not an error)', () => {
    expect(parseArxivAtomXml(EMPTY_FEED_XML)).toEqual([]);
  });

  test('entry with a non-arxiv <id> yields a keyless row (arxiv_id undefined) without throwing', () => {
    const articles = parseArxivAtomXml(singleEntryFeed(`  <entry>
    <id>http://example.org/x</id>
    <title>Foreign entry outside the arxiv.org abs namespace</title>
    <published>2020-01-01T00:00:00Z</published>
    <author>
      <name>Some One</name>
    </author>
  </entry>`));

    // No throw: the id regex simply fails to match → arxiv_id stays undefined
    expect(articles).toHaveLength(1);
    expect(articles[0].arxiv_id).toBeUndefined();
    expect(articles[0].title).toBe('Foreign entry outside the arxiv.org abs namespace');
    // keyless in dedup terms: no pmid/pmcid/doi either
    expect(articles[0].doi).toBeUndefined();
    expect(articles[0].pmid).toBeUndefined();
  });

  test('absent arxiv:primary_category falls back to categories-only keywords', () => {
    const articles = parseArxivAtomXml(singleEntryFeed(`  <entry>
    <id>http://arxiv.org/abs/2104.12345v1</id>
    <title>No primary category declared</title>
    <published>2021-04-01T00:00:00Z</published>
    <category term="cs.CL" scheme="http://arxiv.org/schemas/atom"/>
    <category term="cs.LG" scheme="http://arxiv.org/schemas/atom"/>
  </entry>`));

    expect(articles).toHaveLength(1);
    // no primary → categories verbatim, no dedupe-first reordering
    expect(articles[0].keywords).toEqual(['cs.CL', 'cs.LG']);
  });
});

describe('searchArxiv', () => {
  let originalFetch: typeof global.fetch;

  beforeEach(() => {
    jest.clearAllMocks();
    originalFetch = global.fetch;
    connectionManager.closeAll();
  });

  afterEach(() => {
    global.fetch = originalFetch;
  });

  test('builds query URL with sanitized terms (quotes/parens stripped, field prefixes neutralized)', async () => {
    global.fetch = jest.fn().mockResolvedValue(atomResponse(VERSIONED_ID_XML)) as any;

    const result = await articleSearch('CRISPR "base (editing)" ti:cas9 AU:Smith', { source: 'arxiv' });

    expect(global.fetch).toHaveBeenCalledTimes(1);
    const url = (global.fetch as any).mock.calls[0][0] as string;
    expect(url).toContain('https://export.arxiv.org/api/query?search_query=');
    expect(url).toContain('all:(CRISPR%20base%20editing%20cas9%20Smith)');
    expect(url).toContain('&start=0&max_results=10&sortBy=relevance');
    expect(url).not.toContain('ti:');
    expect(url).not.toContain('AU:');
    expect(url).not.toContain('%22');
    expect(url).not.toContain('sortBy=relevance&');

    expect(result).toHaveLength(1);
    expect(result[0].arxiv_id).toBe('1706.03762');
    expect(result[0].source).toBe('arxiv');
  });

  test('appends quoted submittedDate range with open bounds defaulted (r08 syntax)', async () => {
    global.fetch = jest.fn().mockResolvedValue(atomResponse(EMPTY_FEED_XML)) as any;

    await articleSearch('quantum', { source: 'arxiv', dateRange: '2020-01-01/' });
    await articleSearch('quantum', { source: 'arxiv', dateRange: '/2020-12-31' });

    expect(global.fetch).toHaveBeenCalledTimes(2);
    const openToEnd = (global.fetch as any).mock.calls[0][0] as string;
    expect(openToEnd).toContain('+AND+submittedDate:%22202001010000+TO+209912312359%22');
    const openFromStart = (global.fetch as any).mock.calls[1][0] as string;
    expect(openFromStart).toContain('+AND+submittedDate:%22199107010000+TO+202012312359%22');
  });

  test('both-bounds dateRange sends submittedDate:"A TO B" with no sentinel bounds', async () => {
    global.fetch = jest.fn().mockResolvedValue(atomResponse(EMPTY_FEED_XML)) as any;

    await articleSearch('quantum', { source: 'arxiv', dateRange: '2020-01-01/2020-12-31' });

    const url = (global.fetch as any).mock.calls[0][0] as string;
    expect(url).toContain('+AND+submittedDate:%22202001010000+TO+202012312359%22');
    // neither the 1991 arXiv-epoch nor the 2099 upper sentinel leaks in
    expect(url).not.toContain('199107010000');
    expect(url).not.toContain('209912312359');
  });

  test('clamps max_results at 50 and passes offset as start', async () => {
    global.fetch = jest.fn().mockResolvedValue(atomResponse(EMPTY_FEED_XML)) as any;

    await searchArxiv('electron', 100, 5);

    const url = (global.fetch as any).mock.calls[0][0] as string;
    expect(url).toContain('&start=5&max_results=50&');
    expect(url).not.toContain('max_results=100');
  });

  test('empty feed resolves to [] (not an error result)', async () => {
    global.fetch = jest.fn().mockResolvedValue(atomResponse(EMPTY_FEED_XML)) as any;

    const result = await searchArxiv('xqzjwqvxnonexistentterm', 10, 0);
    expect(result).toEqual([]);
  });

  test('HTML body surfaces as _error result (transform throw caught by error contract)', async () => {
    global.fetch = jest.fn().mockResolvedValue({
      ok: true,
      headers: new Headers({ 'content-type': 'text/html' }),
      text: () => Promise.resolve(HTML_PAGE),
    }) as any;

    const result = await searchArxiv('electron', 10, 0);
    expect(result).toHaveLength(1);
    expect(result[0]._error).toContain('searchArxiv failed');
    expect(result[0]._error).toContain('Unexpected arXiv response');
  });

  test('HTTP 403: fetch called exactly once (never retried) and _error names the per-IP block, not an API key', async () => {
    global.fetch = jest.fn().mockResolvedValue({ ok: false, status: 403, statusText: 'Forbidden' }) as any;

    const result = await searchArxiv('electron', 10, 0);

    expect(global.fetch).toHaveBeenCalledTimes(1);
    expect(result).toHaveLength(1);
    const err = result[0]._error || '';
    expect(err).toContain('searchArxiv failed');
    expect(err).toMatch(/block/i);
    expect(err).toMatch(/IP/);
    expect(err).toContain('does not offer API keys');
    expect(err).not.toContain('Set the required API key');
  });

  test('HTTP 429: retried exactly once (2 fetches), then surfaces _error', async () => {
    // NB: this test intentionally sleeps through the real ~3.5 s retry
    // backoff (registry retry: { attempts: 2, backoffMs: 3500 }) — only the
    // rate limiter is mocked (see file header).
    global.fetch = jest.fn().mockResolvedValue({ ok: false, status: 429, statusText: 'Too Many Requests' }) as any;

    const result = await searchArxiv('electron', 10, 0);

    expect(global.fetch).toHaveBeenCalledTimes(2);
    expect(result).toHaveLength(1);
    expect(result[0]._error).toContain('searchArxiv failed');
    expect(result[0]._error).toContain('HTTP 429');
    expect(result[0]._error).toContain('shared `biomcp serve` daemon');
    expect(result[0]._error).not.toContain('API key');
  });

  test('query reduced to nothing by sanitization returns [] without a network call', async () => {
    global.fetch = jest.fn() as any;

    const result = await searchArxiv('()"")', 10, 0);

    expect(result).toEqual([]);
    expect(global.fetch).not.toHaveBeenCalled();
  });

  test('fetch transport rejection surfaces as a single generic _error row', async () => {
    // 'fetch failed' matches the connection-layer network signature, so the
    // registry retry policy fires first (attempts: 2 → exactly 2 fetches);
    // NB: this test sleeps through one real ~3.5 s retry backoff like the
    // 429 test above (only the rate limiter is mocked — see file header).
    global.fetch = jest.fn().mockRejectedValue(new TypeError('fetch failed')) as any;

    const result = await searchArxiv('electron', 10, 0);

    expect(global.fetch).toHaveBeenCalledTimes(2);
    expect(result).toHaveLength(1);
    // backendErrorRow generic wording, byte-identical to the shared envelope
    expect(result[0]._error).toBe(
      'searchArxiv failed: fetch failed. This may be a temporary data source issue. Try again or use a different source.'
    );
  });

  test('truncated mid-entry XML fails parsing and surfaces as an _error row', async () => {
    // Passes the feed sniff (<?xml + <feed>), then the parser hits the
    // unterminated tag mid-entry and throws — wrapped by the shared catch.
    global.fetch = jest.fn().mockResolvedValue(atomResponse(TRUNCATED_MID_ENTRY_XML)) as any;

    const result = await searchArxiv('electron', 10, 0);

    expect(result).toHaveLength(1);
    expect(result[0]._error).toContain('searchArxiv failed');
    expect(result[0]._error).toContain('Failed to parse arXiv Atom XML');
  });

  test('federated run drops the arXiv leg\'s _error row when the other legs succeed', async () => {
    // arXiv leg rejects at the transport level (retried once, then a
    // single-element _error row); Europe PMC returns keyed rows so the
    // final federated pool is non-empty and provably _error-free.
    const europepmcRows = {
      resultList: {
        result: [
          { pmid: '41721000', title: 'Cited journal row', authorString: 'Smith J', journalTitle: 'Nature', firstPublicationDate: '2026-01-01', citedByCount: 5, isOpenAccess: 'N' },
          { pmid: '41721001', title: 'Second journal row', authorString: 'Doe A', journalTitle: 'Cell', firstPublicationDate: '2026-02-01', citedByCount: 1, isOpenAccess: 'Y' },
        ],
      },
    };
    global.fetch = jest.fn((url: unknown) => {
      const u = String(url);
      if (u.includes('export.arxiv.org')) return Promise.reject(new TypeError('fetch failed'));
      if (u.includes('ebi.ac.uk')) return Promise.resolve(jsonResponse(europepmcRows));
      if (u.includes('semanticscholar.org')) return Promise.resolve(jsonResponse({ data: [] }));
      if (u.includes('pubtator3-api')) return Promise.resolve(jsonResponse({ results: [] }));
      if (u.includes('litsense2-api')) return Promise.resolve(jsonResponse([]));
      return Promise.resolve(jsonResponse({ esearchresult: { idlist: [] } })); // eutils esearch
    }) as any;

    const result = await articleSearch('crispr');

    // the arXiv outage degraded to an _error row which dedup dropped
    expect(result.some(r => Boolean(r._error))).toBe(false);
    expect(result).toHaveLength(2);
    expect(result.map(r => r.pmid)).toEqual(['41721000', '41721001']);
  });
});
});
