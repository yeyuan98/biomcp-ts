import { jest, describe, it, expect, beforeAll, afterAll, beforeEach } from '@jest/globals';
import { connectionManager } from '../../connections/manager.js';
import { createMcpTestHarness, type McpTestHarness } from '../helpers/mcp-harness.js';
import { parseMockUrl } from '../helpers/mock-url.js';
import { mockGlobalFetch } from '../helpers/mock-fetch.js';

/**
 * Standard list-tool envelope pins (issue #130): disease_search,
 * disease_drugs, disease_trials, and gene_articles reply with
 * { results, warnings?, errors? } — never a bare array — with the optional
 * channels emitted only when non-empty (article_search parity).
 * drug_search's { results, hint } shape is pinned in
 * entities/drug.test.ts (issue #83); geo_get's GDS guidance-as-data lives in
 * geo-tools.test.ts / entities/geo.test.ts.
 */

const PUBMED_EFETCH_XML = `<?xml version="1.0"?>
<PubmedArticleSet>
<PubmedArticle>
<MedlineCitation Status="MEDLINE" Owner="NLM">
<PMID Version="1">12345</PMID>
<Article PubModel="Electronic">
<Journal><Title>Scientific reports</Title><ISOAbbreviation>Sci Rep</ISOAbbreviation></Journal>
<ArticleTitle>Test article about BRCA1</ArticleTitle>
<Abstract><AbstractText>Full abstract text for testing purposes.</AbstractText></Abstract>
</Article>
</MedlineCitation>
</PubmedArticle>
</PubmedArticleSet>`;

const ARXIV_EMPTY_ATOM = `<?xml version='1.0' encoding='UTF-8'?>
<feed xmlns="http://www.w3.org/2005/Atom"><opensearch:totalResults xmlns:opensearch="http://a9.com/-/spec/opensearch/1.1/">0</opensearch:totalResults></feed>`;

const okJson = (payload: unknown) => ({
  ok: true,
  status: 200,
  statusText: 'OK',
  headers: new Headers({ 'content-type': 'application/json' }),
  json: () => Promise.resolve(payload),
});

const okText = (payload: string, contentType = 'text/xml') => ({
  ok: true,
  status: 200,
  statusText: 'OK',
  headers: new Headers({ 'content-type': contentType }),
  text: () => Promise.resolve(payload),
});

/** Sentinel rejection message with no network-failure signature: the
 * connection retry layer classifies it non-retryable, so no backoff sleeps. */
const S2_OUTAGE = 'unit test sentinel: semantic scholar backend disabled';

/**
 * Route every list-tool backend. `semanticScholarDown` rejects the Semantic
 * Scholar route so the federated fan-out records a per-backend error.
 */
function mockListToolBackends(opts: { semanticScholarDown?: boolean } = {}): void {
  global.fetch = jest.fn<(...args: any[]) => any>().mockImplementation((input: any, init?: { body?: string }) => {
    const url = parseMockUrl(input);
    switch (url.hostname) {
      // disease_search (mydisease) + drug_search (mychem) share /v1/query —
      // exact hostname disambiguates.
      case 'mydisease.info':
        return Promise.resolve(okJson({
          hits: [{ _id: 'MONDO:0007254', mondo: { label: 'breast carcinoma', id: 'MONDO:0007254' } }],
        }));
      case 'mychem.info':
        return Promise.resolve(okJson({
          hits: [{ chebi: { name: 'Aspirin' }, unichem: { chembl: 'CHEMBL25' } }],
        }));
      case 'clinicaltrials.gov':
        return Promise.resolve(okJson({
          studies: [
            {
              protocolSection: {
                identificationModule: { nctId: 'NCT01234567', briefTitle: 'Melanoma trial 1' },
                statusModule: { overallStatus: 'RECRUITING' },
              },
            },
            {
              protocolSection: {
                identificationModule: { nctId: 'NCT02345678', briefTitle: 'Melanoma trial 2' },
                statusModule: { overallStatus: 'COMPLETED' },
              },
            },
          ],
        }));
      case 'api.platform.opentargets.org': {
        // GraphQL POST body carries the query string — dispatch on it.
        const body = String(init?.body ?? '');
        if (body.includes('drugAndClinicalCandidates')) {
          return Promise.resolve(okJson({
            data: {
              disease: {
                id: 'EFO_0000313',
                name: 'melanoma',
                drugAndClinicalCandidates: {
                  rows: [
                    {
                      maxClinicalStage: 'PHASE_3',
                      clinicalReports: [{ id: 'NCT1' }, { id: 'NCT2' }],
                      drug: { id: 'CHEMBL1234', name: 'nivolumab' },
                    },
                    {
                      maxClinicalStage: 'PHASE_3',
                      clinicalReports: [{ id: 'NCT3' }],
                      drug: { id: 'CHEMBL5678', name: 'ipilimumab' },
                    },
                  ],
                },
              },
            },
          }));
        }
        return Promise.resolve(okJson({
          data: { search: { hits: [{ id: 'EFO_0000313', name: 'melanoma', entity: 'disease' }] } },
        }));
      }
      // gene_articles federated fan-out (searchArticles):
      case 'eutils.ncbi.nlm.nih.gov':
        if (url.pathname.includes('efetch')) {
          return Promise.resolve(okText(PUBMED_EFETCH_XML));
        }
        return Promise.resolve(okJson({ esearchresult: { count: '1', idlist: ['12345'] } }));
      case 'www.ebi.ac.uk': // europepmc
        return Promise.resolve(okJson({ resultList: { result: [] } }));
      case 'api.semanticscholar.org':
        if (opts.semanticScholarDown) {
          return Promise.reject(new Error(S2_OUTAGE));
        }
        return Promise.resolve(okJson({ data: [] }));
      case 'export.arxiv.org':
        return Promise.resolve(okText(ARXIV_EMPTY_ATOM, 'application/atom+xml'));
      case 'www.ncbi.nlm.nih.gov': // pubtator3 + litsense2 hosts
        if (url.pathname.includes('litsense')) return Promise.resolve(okJson([]));
        return Promise.resolve(okJson({ results: [] }));
      default:
        return Promise.reject(new Error(`unexpected url ${url.href}`));
    }
  }) as any;
}

describe('list-tool envelopes (issue #130)', () => {
  let harness: McpTestHarness;
  mockGlobalFetch();

  beforeAll(async () => {
    harness = await createMcpTestHarness();
  });

  afterAll(async () => {
    await harness.close();
  });

  beforeEach(() => {
    jest.clearAllMocks();
    connectionManager.closeAll();
  });

  it('disease_search wraps rows in { results } with no warnings/errors keys', async () => {
    mockListToolBackends();

    const envelope = await harness.callTool('disease_search', { query: 'breast cancer' });

    expect(envelope).toEqual({
      results: [{ name: 'breast carcinoma', disease_id: 'MONDO:0007254', mondo_id: 'MONDO:0007254' }],
    });
    expect('warnings' in envelope).toBe(false);
    expect('errors' in envelope).toBe(false);
  });

  it('disease_drugs wraps ranked rows in { results } (limit applied to results, inline _error rows kept as items)', async () => {
    mockListToolBackends();

    const envelope = await harness.callTool('disease_drugs', { disease_id: 'melanoma', limit: 1 });

    expect(Array.isArray(envelope.results)).toBe(true);
    // OpenTargets ranking (max clinical phase, then report count) puts
    // nivolumab (2 reports) ahead of ipilimumab (1); limit slices results.
    expect(envelope.results).toEqual([
      { drug_name: 'nivolumab', source: 'opentargets', phase: 'PHASE_3', report_count: 2 },
    ]);
    expect('warnings' in envelope).toBe(false);
    expect('errors' in envelope).toBe(false);
  });

  it('disease_trials wraps trial rows in { results }', async () => {
    mockListToolBackends();

    const envelope = await harness.callTool('disease_trials', { disease_id: 'melanoma' });

    expect(envelope.results).toEqual([
      { nct_id: 'NCT01234567', title: 'Melanoma trial 1', status: 'RECRUITING' },
      { nct_id: 'NCT02345678', title: 'Melanoma trial 2', status: 'COMPLETED' },
    ]);
    expect('warnings' in envelope).toBe(false);
    expect('errors' in envelope).toBe(false);
  });

  it('gene_articles returns the searchArticles envelope { results } on a clean page', async () => {
    mockListToolBackends();

    const envelope = await harness.callTool('gene_articles', { symbol: 'BRCA1' });

    expect(Array.isArray(envelope.results)).toBe(true);
    expect(envelope.results).toHaveLength(1);
    expect(envelope.results[0]).toMatchObject({ pmid: '12345', title: 'Test article about BRCA1' });
    expect('errors' in envelope).toBe(false);
  });

  it('gene_articles: a failed backend rides in errors[] with results still populated', async () => {
    // The payoff of calling searchArticles directly (vs the deleted bare-array
    // geneToArticles wrapper): a Semantic Scholar outage is structurally
    // visible instead of indistinguishable from "few articles".
    mockListToolBackends({ semanticScholarDown: true });

    const envelope = await harness.callTool('gene_articles', { symbol: 'BRCA1' });

    expect(Array.isArray(envelope.results)).toBe(true);
    expect(envelope.results).toHaveLength(1);
    expect(envelope.results[0]).toMatchObject({ pmid: '12345' });
    expect(Array.isArray(envelope.errors)).toBe(true);
    const s2 = envelope.errors.find((e: any) => e.source === 'semantic_scholar');
    expect(s2).toBeDefined();
    expect(s2.message).toContain(S2_OUTAGE);
    // No _error marker rows inside results — errors never masquerade as items.
    expect(envelope.results.some((r: any) => r._error !== undefined)).toBe(false);
  });
});
