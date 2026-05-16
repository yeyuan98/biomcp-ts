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
    test('returns federated result structure', async () => {
      global.fetch = jest.fn().mockResolvedValue(mockJson({})) as any;

      const result = await getCitations(
        { pmid: '12345', doi: '10.1/test' },
        { limit: 5 }
      );

      expect(result.article_id).toEqual({ pmid: '12345', doi: '10.1/test' });
      // Fast mode uses 3 providers (Europe PMC, Semantic Scholar, Crossref)
      expect(result.source_results).toHaveLength(3);
      expect(Array.isArray(result.forward_citations)).toBe(true);
      expect(Array.isArray(result.backward_references)).toBe(true);
    });

    test('queries specific source when source option provided', async () => {
      global.fetch = jest.fn().mockResolvedValue(mockJson({})) as any;

      const result = await getCitations(
        { pmid: '12345', doi: '10.1/test' },
        { source: 'pubmed' }
      );

      expect(result.source_results).toHaveLength(1);
      expect(result.source_results[0].source_id).toBe('pubmed');
    });

    test('full mode queries all 5 providers', async () => {
      global.fetch = jest.fn().mockResolvedValue(mockJson({})) as any;

      const result = await getCitations(
        { pmid: '12345', doi: '10.1/test' },
        { full: true }
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
        citationsArray: {
          citation: [
            { pmid: '111', doi: '10.1/cited1', title: 'Cited Paper', authorString: 'Smith J', journalTitle: 'Nature', pubYear: '2023' },
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
      expect(result[0].title).toBe('Cited Paper');

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
        citationsArray: {
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
        citationsArray: {
          citation: [
            { pmid: '111', title: 'Cited Paper' },
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
    test('getForwardCitations queries references filter', async () => {
      const crossrefForwardResponse = {
        message: {
          items: [
            { DOI: '10.1/citing1', title: ['Citing Paper'], author: [{ family: 'Smith', given: 'John' }], 'container-title': ['Science'] },
          ],
        },
      };

      global.fetch = jest.fn().mockResolvedValue(mockJson(crossrefForwardResponse)) as any;

      const result = await crossrefProvider.getForwardCitations({ doi: '10.1/test' }, 10);

      expect(result).toHaveLength(1);
      expect(result[0].doi).toBe('10.1/citing1');
      expect(result[0].title).toBe('Citing Paper');
      expect(result[0].authors).toEqual(['John Smith']);
      expect(result[0].journal).toBe('Science');
      expect(result[0].source).toBe('crossref');

      const callUrl = (global.fetch as any).mock.calls[0][0] as string;
      expect(callUrl).toContain('filter=references:');
      expect(callUrl).toContain('rows=10');
    });

    test('getForwardCitations returns empty when no DOI', async () => {
      const result = await crossrefProvider.getForwardCitations({ pmid: '123' }, 10);
      expect(result).toEqual([]);
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
    test('getForwardCitations returns citing DOIs', async () => {
      global.fetch = jest.fn().mockResolvedValue(mockJson([
        { citing: '10.1/citing1', cited: '10.1/test' },
        { citing: '10.1/citing2', cited: '10.1/test' },
      ])) as any;

      const result = await opencitationsProvider.getForwardCitations({ doi: '10.1/test' }, 10);

      expect(result).toHaveLength(2);
      expect(result[0].doi).toBe('10.1/citing1');
      expect(result[0].source).toBe('opencitations');
    });

    test('getCitationCount returns count', async () => {
      global.fetch = jest.fn().mockResolvedValue(mockJson([{ count: 15 }])) as any;

      const result = await opencitationsProvider.getCitationCount({ doi: '10.1/test' });

      expect(result).toEqual({ total: 15, source: 'opencitations' });
    });

    test('returns empty when no DOI', async () => {
      const result = await opencitationsProvider.getForwardCitations({ pmid: '123' }, 10);
      expect(result).toEqual([]);
    });
  });

  describe('Semantic Scholar provider', () => {
    test('getForwardCitations uses PMCID as query ID', async () => {
      global.fetch = jest.fn().mockResolvedValue(mockJson({
        data: [{ citationPaper: { paperId: 'abc', title: 'Paper', authors: [{ name: 'A' }], year: 2023, venue: 'Science', externalIds: { DOI: '10.1/a' } } }],
      })) as any;

      const result = await semanticScholarProvider.getForwardCitations({ pmcid: 'PMC123' }, 10);

      expect(result).toHaveLength(1);
      const callUrl = (global.fetch as any).mock.calls[0][0] as string;
      expect(decodeURIComponent(callUrl)).toContain('PMCID:PMC123');
    });

    test('returns empty when no ID at all', async () => {
      const result = await semanticScholarProvider.getForwardCitations({}, 10);
      expect(result).toEqual([]);
    });

    test('handles 429 rate limiting gracefully', async () => {
      global.fetch = jest.fn().mockResolvedValue({
        ok: false,
        status: 429,
        statusText: 'Too Many Requests',
      }) as any;

      const result = await semanticScholarProvider.getForwardCitations({ pmid: '123' }, 10);
      expect(result).toEqual([]);
    });
  });
});
