import { jest } from '@jest/globals';
import { getCitations, fieldScore, recordKey, deduplicateRecords, clearCitationCache } from '../../entities/article/citation/index.js';
import * as europepmcProvider from '../../entities/article/citation/europepmc.js';
import * as crossrefProvider from '../../entities/article/citation/crossref.js';
import * as pubmedProvider from '../../entities/article/citation/pubmed.js';
import * as opencitationsProvider from '../../entities/article/citation/opencitations.js';
import * as semanticScholarProvider from '../../entities/article/citation/semantic-scholar.js';
import { connectionManager } from '../../connections/manager.js';

function mockJson(data: unknown) {
  return {
    ok: true,
    headers: new Headers({ 'content-type': 'application/json' }),
    json: () => Promise.resolve(data),
    text: () => Promise.resolve(JSON.stringify(data)),
  };
}

function mockXml(xml: string) {
  return {
    ok: true,
    headers: new Headers({ 'content-type': 'text/xml' }),
    text: () => Promise.resolve(xml),
  };
}

// Await a promise that internally sleeps on module timers (token-bucket rate
// limiters, registry retry backoffs) under jest fake timers, stepping the
// clock until the promise settles. Same pattern as patent.test.ts.
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

jest.setTimeout(30000);

describe('citation module', () => {
  let originalFetch: typeof global.fetch;

  beforeEach(() => {
    jest.clearAllMocks();
    originalFetch = global.fetch;
    connectionManager.closeAll();
    clearCitationCache();
    crossrefProvider.clearWorkCache();
    pubmedProvider.clearCitedInCache();
  });

  afterEach(() => {
    global.fetch = originalFetch;
    clearCitationCache();
  });

  describe('deduplicateRecords', () => {
    test('deduplicates by DOI', () => {
      const records = [
        { doi: '10.1/a', title: 'First', source: 'src1' },
        { doi: '10.1/a', title: 'Second', authors: ['Author A'], source: 'src2' },
      ];
      const result = deduplicateRecords(records as any);
      expect(result).toHaveLength(1);
      expect(result[0].authors).toEqual(['Author A']);
    });

    test('deduplicates by PMID when no DOI', () => {
      const records = [
        { pmid: '123', title: 'First', source: 'src1' },
        { pmid: '123', title: 'Better', journal: 'Nature', source: 'src2' },
      ];
      const result = deduplicateRecords(records as any);
      expect(result).toHaveLength(1);
      expect(result[0].journal).toBe('Nature');
    });

    test('deduplicates by PMCID when no DOI or PMID', () => {
      const records = [
        { pmcid: 'PMC123', source: 'src1' },
        { pmcid: 'PMC123', title: 'Titled', source: 'src2' },
      ];
      const result = deduplicateRecords(records as any);
      expect(result).toHaveLength(1);
      expect(result[0].title).toBe('Titled');
    });

    test('keeps records without keys', () => {
      const records = [
        { title: 'No ID', source: 'src1' },
        { title: 'Also no ID', source: 'src2' },
      ];
      const result = deduplicateRecords(records as any);
      expect(result).toHaveLength(2);
    });

    test('keeps records with different IDs', () => {
      const records = [
        { doi: '10.1/a', title: 'A', source: 'src1' },
        { doi: '10.1/b', title: 'B', source: 'src2' },
      ];
      const result = deduplicateRecords(records as any);
      expect(result).toHaveLength(2);
    });

    test('empty input returns empty', () => {
      expect(deduplicateRecords([])).toEqual([]);
    });
  });

  describe('fieldScore', () => {
    test('scores 0 for minimal record', () => {
      expect(fieldScore({ source: 'test' })).toBe(0);
    });

    test('scores higher for records with more fields', () => {
      const minimal = { doi: '10.1/a', source: 'test' };
      const rich = { doi: '10.1/a', pmid: '123', title: 'T', authors: ['A'], journal: 'J', year: 2023, source: 'test' };
      expect(fieldScore(rich as any)).toBeGreaterThan(fieldScore(minimal as any));
    });
  });

  describe('recordKey', () => {
    test('returns doi: prefix for DOI', () => {
      expect(recordKey({ doi: '10.1/a', source: 'test' })).toBe('doi:10.1/a');
    });

    test('returns pmid: prefix for PMID when no DOI', () => {
      expect(recordKey({ pmid: '123', source: 'test' })).toBe('pmid:123');
    });

    test('returns null for record without IDs', () => {
      expect(recordKey({ source: 'test' })).toBeNull();
    });
  });

  describe('getCitations', () => {
    beforeEach(() => {
      jest.useFakeTimers();
    });

    afterEach(() => {
      jest.useRealTimers();
    });

    test('returns federated result structure', async () => {
      global.fetch = jest.fn().mockResolvedValue(mockJson({})) as any;

      const result = await advanceUntilSettled(
        getCitations(
          { pmid: '12345', doi: '10.1/test' },
          { limit: 5 }
        )
      );

      expect(result.article_id).toEqual({ pmid: '12345', doi: '10.1/test' });
      // Fast mode uses 4 providers (Europe PMC, Semantic Scholar, Crossref, OpenCitations)
      expect(result.source_results).toHaveLength(4);
      expect(Array.isArray(result.forward_citations)).toBe(true);
      expect(Array.isArray(result.backward_references)).toBe(true);
    });

    test('queries specific source when source option provided', async () => {
      global.fetch = jest.fn().mockResolvedValue(mockJson({})) as any;

      const result = await advanceUntilSettled(
        getCitations(
          { pmid: '12345', doi: '10.1/test' },
          { source: 'pubmed' }
        )
      );

      expect(result.source_results).toHaveLength(1);
      expect(result.source_results[0].source_id).toBe('pubmed');
    });

    test('full mode queries all 5 providers', async () => {
      global.fetch = jest.fn().mockResolvedValue(mockJson({})) as any;

      const result = await advanceUntilSettled(
        getCitations(
          { pmid: '12345', doi: '10.1/test' },
          { full: true }
        )
      );

      expect(result.article_id).toEqual({ pmid: '12345', doi: '10.1/test' });
      // Full mode uses all 5 providers
      expect(result.source_results).toHaveLength(5);
      expect(result.source_results.map((r) => r.source_id)).toEqual(
        expect.arrayContaining(['pubmed', 'europepmc', 'semantic_scholar', 'crossref', 'opencitations'])
      );
    });

    test('returns error for unknown source', async () => {
      global.fetch = jest.fn().mockResolvedValue(mockJson({})) as any;

      const result = await getCitations(
        { pmid: '12345' },
        { source: 'nonexistent' }
      );

      expect(result.source_results[0].error).toContain('Unknown citation source');
    });
  });

  describe('EuropePMC provider', () => {
    test('getForwardCitations resolves DOI to PMID first', async () => {
      const searchResponse = {
        resultList: {
          result: [{ pmid: '12345' }],
        },
      };
      const citationsResponse = {
        citationList: {
          citation: [
            { id: '111', source: 'MED', title: 'Cited Paper', authorString: 'Smith J', journalAbbreviation: 'Nature', pubYear: 2023 },
          ],
        },
      };

      let callCount = 0;
      global.fetch = jest.fn().mockImplementation(() => {
        callCount++;
        if (callCount === 1) return Promise.resolve(mockJson(searchResponse));
        return Promise.resolve(mockJson(citationsResponse));
      }) as any;

      const result = await europepmcProvider.getForwardCitations({ doi: '10.1/test' }, 10);

      expect(result).toHaveLength(1);
      expect(result[0].pmid).toBe('111');
      expect(result[0].title).toBe('Cited Paper');
      expect(result[0].journal).toBe('Nature');
      expect(result[0].year).toBe(2023);
      expect(result[0].source).toBe('europepmc');

      const calls = (global.fetch as any).mock.calls;
      expect(calls[0][0]).toContain('query=');
      expect(calls[0][0]).toContain('DOI%3A%22');
      expect(calls[1][0]).toContain('MED/12345/citations');
    });

    test('getForwardCitations resolves PMCID to PMID first', async () => {
      const searchResponse = {
        resultList: {
          result: [{ pmid: '12345' }],
        },
      };
      const citationsResponse = {
        citationList: {
          citation: [],
        },
      };

      let callCount = 0;
      global.fetch = jest.fn().mockImplementation(() => {
        callCount++;
        if (callCount === 1) return Promise.resolve(mockJson(searchResponse));
        return Promise.resolve(mockJson(citationsResponse));
      }) as any;

      await europepmcProvider.getForwardCitations({ pmcid: 'PMC123' }, 10);

      const calls = (global.fetch as any).mock.calls;
      expect(calls[0][0]).toContain('PMCID%3APMC123');
      expect(calls[1][0]).toContain('MED/12345/citations');
    });

    test('getForwardCitations maps pmid only for MED source and keeps ID-less entries with titles', async () => {
      const citationsResponse = {
        citationList: {
          citation: [
            { id: '9', source: 'AGR', title: 'Non-MED entry', journalAbbreviation: 'Plant J', pubYear: '2020' },
            { id: '222', source: 'MED', title: 'MED entry' },
            { title: 'No ID at all' },
          ],
        },
      };

      global.fetch = jest.fn().mockResolvedValue(mockJson(citationsResponse)) as any;

      const result = await europepmcProvider.getForwardCitations({ pmid: '12345' }, 10);

      expect(result).toHaveLength(3);
      expect(result[0].pmid).toBeUndefined();
      expect(result[0].title).toBe('Non-MED entry');
      expect(result[0].journal).toBe('Plant J');
      expect(result[0].year).toBe(2020);
      expect(result[1].pmid).toBe('222');
      expect(result[2].title).toBe('No ID at all');
    });

    test('getForwardCitations falls back to legacy citationsArray shape', async () => {
      const citationsResponse = {
        citationsArray: {
          citation: [
            { id: '111', source: 'MED', title: 'Legacy Paper', journalAbbreviation: 'Nature', pubYear: 2023 },
          ],
        },
      };

      global.fetch = jest.fn().mockResolvedValue(mockJson(citationsResponse)) as any;

      const result = await europepmcProvider.getForwardCitations({ pmid: '12345' }, 10);

      expect(result).toHaveLength(1);
      expect(result[0].title).toBe('Legacy Paper');
    });

    test('getBackwardReferences uses MED source path and referenceList shape', async () => {
      const referencesResponse = {
        referenceList: {
          reference: [
            { id: '10592235', source: 'MED', title: 'The Protein Data Bank.', authorString: 'Berman HM, Westbrook J', journalAbbreviation: 'Nucleic Acids Res', pubYear: 2000 },
            { id: '999', source: 'MED', title: 'Future ref', pubYear: 2030 },
          ],
        },
      };

      global.fetch = jest.fn().mockResolvedValue(mockJson(referencesResponse)) as any;

      const result = await europepmcProvider.getBackwardReferences({ pmid: '17145705' }, 10);

      const callUrl = (global.fetch as any).mock.calls[0][0] as string;
      expect(callUrl).toContain('MED/17145705/references');
      expect(result).toHaveLength(2);
      expect(result[0].pmid).toBe('10592235');
      expect(result[0].journal).toBe('Nucleic Acids Res');
      expect(result[0].authors).toEqual(['Berman HM', 'Westbrook J']);
      expect(result[1].title).toBe('Future ref');
    });

    test('getBackwardReferences filters by article year', async () => {
      const referencesResponse = {
        referenceList: {
          reference: [
            { id: '1', source: 'MED', title: 'Old', pubYear: 2000 },
            { id: '2', source: 'MED', title: 'Too new', pubYear: 2030 },
          ],
        },
      };

      global.fetch = jest.fn().mockResolvedValue(mockJson(referencesResponse)) as any;

      const result = await europepmcProvider.getBackwardReferences({ pmid: '12345' }, 10, 2007);

      expect(result).toHaveLength(1);
      expect(result[0].title).toBe('Old');
    });

    test('returns empty when PMID resolution fails', async () => {
      global.fetch = jest.fn().mockResolvedValue(mockJson({ resultList: { result: [] } })) as any;

      const result = await europepmcProvider.getForwardCitations({ doi: '10.1/notfound' }, 10);
      expect(result).toEqual([]);
    });

    test('returns empty when no ID available', async () => {
      const result = await europepmcProvider.getForwardCitations({}, 10);
      expect(result).toEqual([]);
    });

    test('uses PMID directly when available', async () => {
      const citationsResponse = {
        citationList: {
          citation: [
            { id: '111', source: 'MED', title: 'Cited Paper' },
          ],
        },
      };

      global.fetch = jest.fn().mockResolvedValue(mockJson(citationsResponse)) as any;

      const result = await europepmcProvider.getForwardCitations({ pmid: '12345' }, 10);

      expect(result).toHaveLength(1);
      expect(result[0].title).toBe('Cited Paper');

      const callUrl = (global.fetch as any).mock.calls[0][0] as string;
      expect(callUrl).toContain('MED/12345/citations');
    });
  });

  describe('Crossref provider', () => {
    test('getForwardCitations makes no request (references filter removed from Crossref API)', async () => {
      global.fetch = jest.fn().mockResolvedValue(mockJson({})) as any;

      const result = await crossrefProvider.getForwardCitations({ doi: '10.1/test' }, 10);

      expect(result).toEqual([]);
      expect(global.fetch).not.toHaveBeenCalled();
    });

    test('getForwardCitations returns empty when no DOI', async () => {
      const result = await crossrefProvider.getForwardCitations({ pmid: '123' }, 10);
      expect(result).toEqual([]);
    });

    test('appends mailto param when CROSSREF_EMAIL is set', async () => {
      process.env.CROSSREF_EMAIL = 'researcher@example.org';
      try {
        global.fetch = jest.fn().mockResolvedValue(mockJson({ message: { 'is-referenced-by-count': 3, reference: [] } })) as any;

        await crossrefProvider.getCitationCount({ doi: '10.1/test' });

        const callUrl = (global.fetch as any).mock.calls[0][0] as string;
        expect(callUrl).toContain('mailto=researcher%40example.org');
      } finally {
        delete process.env.CROSSREF_EMAIL;
      }
    });

    test('omits mailto param when CROSSREF_EMAIL is unset', async () => {
      global.fetch = jest.fn().mockResolvedValue(mockJson({ message: { 'is-referenced-by-count': 3, reference: [] } })) as any;

      await crossrefProvider.getCitationCount({ doi: '10.1/test' });

      const callUrl = (global.fetch as any).mock.calls[0][0] as string;
      expect(callUrl).not.toContain('mailto=');
    });

    test('getCitationCount shares work cache with getBackwardReferences', async () => {
      const workResponse = {
        message: {
          'is-referenced-by-count': 42,
          reference: [{ DOI: '10.1/ref1' }],
        },
      };

      global.fetch = jest.fn().mockResolvedValue(mockJson(workResponse)) as any;

      const refs = await crossrefProvider.getBackwardReferences({ doi: '10.1/test' }, 10);
      const count = await crossrefProvider.getCitationCount({ doi: '10.1/test' });

      expect(global.fetch).toHaveBeenCalledTimes(1);
      expect(refs).toHaveLength(1);
      expect(count?.total).toBe(42);
    });

    test('reference[].author delivered as a plain string maps to authors (live Crossref shape)', async () => {
      const errorSpy = jest.spyOn(console, 'error').mockImplementation(() => {});
      try {
        const workResponse = {
          message: {
            'is-referenced-by-count': 43,
            reference: [
              { DOI: '10.1016/S0147-6513(03)00095-2', 'article-title': 'Aquatic selenium pollution', author: 'AD Lemly', year: 2002 },
              { DOI: '10.1/two', author: 'A One; B Two' },
            ],
          },
        };
        global.fetch = jest.fn().mockResolvedValue(mockJson(workResponse)) as any;

        const refs = await crossrefProvider.getBackwardReferences({ doi: '10.1371/journal.pone.0110904' }, 50);
        const count = await crossrefProvider.getCitationCount({ doi: '10.1371/journal.pone.0110904' });

        expect(refs).toHaveLength(2);
        expect(refs[0].authors).toEqual(['AD Lemly']);
        expect(refs[1].authors).toEqual(['A One', 'B Two']);
        expect(count?.total).toBe(43);
        // String authors are the documented live shape — not an error condition.
        expect(errorSpy).not.toHaveBeenCalled();
      } finally {
        errorSpy.mockRestore();
      }
    });

    test('structured author arrays keep working alongside string authors', async () => {
      const workResponse = {
        message: {
          'is-referenced-by-count': 7,
          reference: [
            { DOI: '10.1/struct', author: [{ family: 'Lemly', given: 'A. D.' }] },
            { DOI: '10.1/string', author: 'MC Thompson' },
          ],
        },
      };
      global.fetch = jest.fn().mockResolvedValue(mockJson(workResponse)) as any;

      const refs = await crossrefProvider.getBackwardReferences({ doi: '10.1/works' }, 10);

      expect(refs[0].authors).toEqual(['A. D. Lemly']);
      expect(refs[1].authors).toEqual(['MC Thompson']);
    });

    test('count survives a malformed reference entry (never silently zeroed)', async () => {
      const errorSpy = jest.spyOn(console, 'error').mockImplementation(() => {});
      try {
        const workResponse = {
          message: {
            'is-referenced-by-count': 43,
            reference: [{ author: { unexpected: 'object shape' } }, { DOI: '10.1/ok', author: 'AD Lemly' }],
          },
        };
        global.fetch = jest.fn().mockResolvedValue(mockJson(workResponse)) as any;

        const count = await crossrefProvider.getCitationCount({ doi: '10.1/malformed' });

        expect(count?.total).toBe(43);
      } finally {
        errorSpy.mockRestore();
      }
    });

    test('failed work fetch is not memoized: next call retries', async () => {
      global.fetch = jest.fn()
        .mockResolvedValueOnce({
          ok: false,
          status: 404,
          statusText: 'Not Found',
          headers: new Headers({ 'content-type': 'text/html' }),
          text: () => Promise.resolve('err'),
        })
        .mockResolvedValueOnce(mockJson({ message: { 'is-referenced-by-count': 9, reference: [] } })) as any;

      const count1 = await crossrefProvider.getCitationCount({ doi: '10.1/negcache' });
      expect(count1).toBeNull();
      expect(global.fetch).toHaveBeenCalledTimes(1);

      const count2 = await crossrefProvider.getCitationCount({ doi: '10.1/negcache' });
      expect(global.fetch).toHaveBeenCalledTimes(2);
      expect(count2?.total).toBe(9);
    });

    test('clearWorkCache resets cache so next call makes a new fetch', async () => {
      global.fetch = jest.fn()
        .mockResolvedValueOnce(mockJson({ message: { 'is-referenced-by-count': 5, reference: [] } }))
        .mockResolvedValueOnce(mockJson({ message: { 'is-referenced-by-count': 10, reference: [] } })) as any;

      // First call uses cache
      const count1 = await crossrefProvider.getCitationCount({ doi: '10.1/test' });
      expect(global.fetch).toHaveBeenCalledTimes(1);

      // Second call with same DOI should use cache (no new fetch)
      const count1Again = await crossrefProvider.getCitationCount({ doi: '10.1/test' });
      expect(global.fetch).toHaveBeenCalledTimes(1);
      expect(count1Again?.total).toBe(5);

      // After clearing cache, next call makes a new fetch
      crossrefProvider.clearWorkCache();
      const count2 = await crossrefProvider.getCitationCount({ doi: '10.1/test' });

      expect(global.fetch).toHaveBeenCalledTimes(2);
      expect(count2?.total).toBe(10);
    });
  });

  describe('PubMed provider', () => {
    const ENRICHMENT_XML = `<?xml version="1.0"?>
<PubmedArticleSet>
<PubmedArticle>
<MedlineCitation Status="MEDLINE" Owner="NLM">
<PMID Version="1">111</PMID>
<Article PubModel="Electronic">
<Journal><Title>Nature</Title><ISOAbbreviation>Nature</ISOAbbreviation></Journal>
<ArticleTitle>Citing Article</ArticleTitle>
<Abstract><AbstractText>Abstract text.</AbstractText></Abstract>
<AuthorList><Author><LastName>Smith</LastName><ForeName>John</ForeName></Author></AuthorList>
</Article>
</MedlineCitation>
<PubmedData>
<ArticleIdList>
<ArticleId IdType="pubmed">111</ArticleId>
<ArticleId IdType="doi">10.1/citing</ArticleId>
</ArticleIdList>
</PubmedData>
</PubmedArticle>
</PubmedArticleSet>`;

    test('getForwardCitations enriches PMIDs via EFetch', async () => {
      global.fetch = jest.fn()
        .mockResolvedValueOnce(mockJson({
          linksets: [{ linksetdbs: [{ linkname: 'pubmed_pubmed_citedin', links: ['111'] }] }],
        }))
        .mockResolvedValueOnce(mockXml(ENRICHMENT_XML)) as any;

      const result = await pubmedProvider.getForwardCitations({ pmid: '12345' }, 10);

      expect(result).toHaveLength(1);
      expect(result[0].pmid).toBe('111');
      expect(result[0].title).toBe('Citing Article');
      expect(result[0].authors).toEqual(['Smith John']);
      expect(result[0].journal).toBe('Nature');
      expect(result[0].source).toBe('pubmed');
    });

    test('getCitationCount shares elink cache with getForwardCitations', async () => {
      global.fetch = jest.fn()
        .mockResolvedValueOnce(mockJson({
          linksets: [{ linksetdbs: [{ linkname: 'pubmed_pubmed_citedin', links: ['111', '222', '333'] }] }],
        }))
        .mockResolvedValueOnce(mockXml(ENRICHMENT_XML)) as any;

      const citations = await pubmedProvider.getForwardCitations({ pmid: '12345' }, 10);
      const count = await pubmedProvider.getCitationCount({ pmid: '12345' });

      const elinkCalls = (global.fetch as any).mock.calls.filter(
        (call: any[]) => typeof call[0] === 'string' && call[0].includes('elink') && call[0].includes('citedin')
      );
      expect(elinkCalls).toHaveLength(1);
      expect(citations).toHaveLength(3);
      expect(count?.total).toBe(3);
      expect(count?.source).toBe('pubmed');
    });

    test('clearCitedInCache resets cache so next call makes a new fetch', async () => {
      let mockCallCount = 0;
      global.fetch = jest.fn().mockImplementation(() => {
        mockCallCount++;
        if (mockCallCount === 1) {
          return Promise.resolve(mockJson({
            linksets: [{ linksetdbs: [{ linkname: 'pubmed_pubmed_citedin', links: ['111'] }] }],
          }));
        } else {
          return Promise.resolve(mockJson({
            linksets: [{ linksetdbs: [{ linkname: 'pubmed_pubmed_citedin', links: ['111', '222'] }] }],
          }));
        }
      }) as any;

      // First call makes a fetch
      const count1 = await pubmedProvider.getCitationCount({ pmid: '12345' });
      expect(global.fetch).toHaveBeenCalledTimes(1);
      expect(count1?.total).toBe(1);

      // Second call with same PMID should use cache (no new fetch)
      const count1Again = await pubmedProvider.getCitationCount({ pmid: '12345' });
      expect(global.fetch).toHaveBeenCalledTimes(1);
      expect(count1Again?.total).toBe(1);

      // After clearing cache, next call makes a new fetch
      pubmedProvider.clearCitedInCache();
      // Small delay to ensure cache cleanup is complete
      await new Promise(resolve => setImmediate(resolve));
      const count2 = await pubmedProvider.getCitationCount({ pmid: '12345' });

      expect(global.fetch).toHaveBeenCalledTimes(2);
      expect(count2?.total).toBe(2);
    });

    test('getCitationCount returns null when no links', async () => {
      global.fetch = jest.fn().mockResolvedValue(mockJson({
        linksets: [{ linksetdbs: [] }],
      })) as any;

      const result = await pubmedProvider.getCitationCount({ pmid: '12345' });
      expect(result).toBeNull();
    });

    test('returns empty when no PMID', async () => {
      const result = await pubmedProvider.getForwardCitations({ doi: '10.1/test' }, 10);
      expect(result).toEqual([]);
    });
  });

  describe('OpenCitations provider', () => {
    test('getForwardCitations calls v2 API with doi-prefixed path and parses PID strings', async () => {
      global.fetch = jest.fn().mockResolvedValue(mockJson([
        { citing: 'omid:br/06202413427 doi:10.1021/ci2003126 openalex:W2079223054 pmid:22145975', cited: 'omid:br/061601349566 doi:10.1093/nar/gkl999' },
        { citing: 'omid:br/06330144817 doi:10.1101/2023.06.21.545851 openalex:W438189127', cited: 'omid:br/061601349566 doi:10.1093/nar/gkl999' },
      ])) as any;

      const result = await opencitationsProvider.getForwardCitations({ doi: '10.1093/nar/gkl999' }, 10);

      expect(result).toHaveLength(2);
      expect(result[0].doi).toBe('10.1021/ci2003126');
      expect(result[0].pmid).toBe('22145975');
      expect(result[0].source).toBe('opencitations');
      expect(result[1].doi).toBe('10.1101/2023.06.21.545851');
      expect(result[1].pmid).toBeUndefined();

      const callUrl = (global.fetch as any).mock.calls[0][0] as string;
      expect(callUrl).toContain('https://api.opencitations.net/index/v2/citations/doi:10.1093%2Fnar%2Fgkl999');
    });

    test('getBackwardReferences parses cited PID strings', async () => {
      global.fetch = jest.fn().mockResolvedValue(mockJson([
        { citing: 'omid:br/061601349566 doi:10.1093/nar/gkl999', cited: 'omid:br/0650243709 doi:10.1021/jm048957q pmid:15943484' },
      ])) as any;

      const result = await opencitationsProvider.getBackwardReferences({ doi: '10.1093/nar/gkl999' }, 10);

      expect(result).toHaveLength(1);
      expect(result[0].doi).toBe('10.1021/jm048957q');
      expect(result[0].pmid).toBe('15943484');

      const callUrl = (global.fetch as any).mock.calls[0][0] as string;
      expect(callUrl).toContain('https://api.opencitations.net/index/v2/references/doi:10.1093%2Fnar%2Fgkl999');
    });

    test('getCitationCount parses string count from v2 API', async () => {
      global.fetch = jest.fn().mockResolvedValue(mockJson([{ count: '1974' }])) as any;

      const result = await opencitationsProvider.getCitationCount({ doi: '10.1/test' });

      expect(result).toEqual({ total: 1974, source: 'opencitations' });

      const callUrl = (global.fetch as any).mock.calls[0][0] as string;
      expect(callUrl).toContain('https://api.opencitations.net/index/v2/citation-count/doi:10.1%2Ftest');
    });

    test('returns empty when no DOI', async () => {
      const result = await opencitationsProvider.getForwardCitations({ pmid: '123' }, 10);
      expect(result).toEqual([]);
    });
  });

  describe('Semantic Scholar provider', () => {
    beforeEach(() => {
      jest.useFakeTimers();
    });

    afterEach(() => {
      jest.useRealTimers();
    });

    test('getForwardCitations uses PMCID as query ID', async () => {
      global.fetch = jest.fn().mockResolvedValue(mockJson({
        data: [{ citationPaper: { paperId: 'abc', title: 'Paper', authors: [{ name: 'A' }], year: 2023, venue: 'Science', externalIds: { DOI: '10.1/a' } } }],
      })) as any;

      const result = await advanceUntilSettled(
        semanticScholarProvider.getForwardCitations({ pmcid: 'PMC123' }, 10)
      );

      expect(result).toHaveLength(1);
      const callUrl = (global.fetch as any).mock.calls[0][0] as string;
      expect(decodeURIComponent(callUrl)).toContain('PMCID:PMC123');
    });

    test('returns empty when no ID at all', async () => {
      const result = await semanticScholarProvider.getForwardCitations({}, 10);
      expect(result).toEqual([]);
    });

    test('handles 429 rate limiting gracefully (registry-driven retry)', async () => {
      global.fetch = jest.fn().mockResolvedValue({
        ok: false,
        status: 429,
        statusText: 'Too Many Requests',
      }) as any;

      // Registry 'semantic_scholar' entry: attempts 3, backoffMs 500 —
      // exactly 3 tries total (single retry policy, no per-call-site wrapper).
      const result = await advanceUntilSettled(
        semanticScholarProvider.getForwardCitations({ pmid: '123' }, 10)
      );

      expect(result).toEqual([]);
      expect(global.fetch).toHaveBeenCalledTimes(3);
    });
  });
});
