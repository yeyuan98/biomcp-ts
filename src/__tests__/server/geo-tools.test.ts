import { jest, describe, it, expect, beforeAll, afterAll, beforeEach, afterEach } from '@jest/globals';
import { connectionManager } from '../../connections/manager.js';
import { createMcpTestHarness, type McpTestHarness } from '../helpers/mcp-harness.js';

const EUTILS = 'https://eutils.ncbi.nlm.nih.gov/entrez/eutils';
const GEO_ACC = 'https://www.ncbi.nlm.nih.gov/geo/query/acc.cgi';
const GEO_FTP_HTTPS = 'https://ftp.ncbi.nlm.nih.gov/geo/series/GSE183nnn/GSE183947/suppl/GSE183947_fpkm.csv.gz';

const GSE_SOFT = [
  '^SERIES = GSE183947',
  '!Series_title = Identification of five cytotoxicity-related genes',
  '!Series_geo_accession = GSE183947',
  '!Series_status = Public on Sep 15 2021',
  '!Series_pubmed_id = 35046993',
  '!Series_type = Expression profiling by high throughput sequencing',
  '!Series_summary = RNA-seq of tumor and normal samples',
  '!Series_platform_id = GPL11154',
  '!Series_sample_id = GSM5574685',
  '!Series_sample_id = GSM5574686',
  '!Series_supplementary_file = ftp://ftp.ncbi.nlm.nih.gov/geo/series/GSE183nnn/GSE183947/suppl/GSE183947_fpkm.csv.gz',
  '!Series_relation = BioProject: https://www.ncbi.nlm.nih.gov/bioproject/PRJNA762469',
  '!Series_relation = SRA: https://www.ncbi.nlm.nih.gov/sra?term=SRP336638',
  '',
].join('\r\n');

function gseEsummaryEntry(): Record<string, unknown> {
  return {
    uid: '200183947',
    accession: 'GSE183947',
    title: 'Identification of five cytotoxicity-related genes',
    summary: 'RNA-seq of tumor and normal samples',
    gpl: '11154',
    taxon: 'Homo sapiens',
    entrytype: 'GSE',
    gdstype: 'Expression profiling by high throughput sequencing',
    pdat: '2021/09/15',
    suppfile: 'CSV',
    n_samples: 60,
    samples: [{ accession: 'GSM5574685', title: 'tumor rep1' }],
    pubmedids: [35046993],
    bioproject: 'PRJNA762469',
    extrelations: [{ relationtype: 'SRA', targetobject: 'SRP336638' }],
  };
}

function okJson(body: unknown) {
  return {
    ok: true,
    status: 200,
    statusText: 'OK',
    headers: new Headers({ 'content-type': 'application/json' }),
    json: () => Promise.resolve(body),
  };
}

function okText(text: string, contentType = 'text/plain') {
  return {
    ok: true,
    status: 200,
    statusText: 'OK',
    headers: new Headers({ 'content-type': contentType }),
    text: () => Promise.resolve(text),
  };
}

function okBinary(content: Buffer) {
  const arrayBuffer = new ArrayBuffer(content.length);
  new Uint8Array(arrayBuffer).set(content);
  return {
    ok: true,
    status: 200,
    statusText: 'OK',
    headers: new Headers({ 'content-length': String(content.length) }),
    arrayBuffer: () => Promise.resolve(arrayBuffer),
  };
}

type RouteHandler = (url: URL) => unknown;

function mockFetchRoutes(routes: Record<string, RouteHandler>): void {
  global.fetch = jest.fn().mockImplementation((rawUrl: string) => {
    const url = new URL(rawUrl);
    for (const [prefix, handler] of Object.entries(routes)) {
      if (url.href.startsWith(prefix)) {
        const result = handler(url) as unknown;
        if (result && typeof result === 'object' && 'ok' in (result as Record<string, unknown>)) {
          return Promise.resolve(result);
        }
        return Promise.resolve(okJson(result));
      }
    }
    return Promise.resolve(okJson({}));
  }) as any;
}

function defaultRoutes(): Record<string, RouteHandler> {
  return {
    [`${EUTILS}/esearch.fcgi`]: url => {
      const term = url.searchParams.get('term') ?? '';
      if (/^GSE183947\[Accession\]$/.test(term)) {
        return { esearchresult: { count: '1', idlist: ['200183947'] } };
      }
      return { esearchresult: { count: '1', idlist: ['200183947'] } };
    },
    [`${EUTILS}/esummary.fcgi`]: url => {
      const ids = (url.searchParams.get('id') ?? '').split(',');
      const result: Record<string, unknown> = { uids: ids };
      for (const id of ids) {
        if (id === '200183947') result[id] = gseEsummaryEntry();
      }
      return { result };
    },
    [GEO_ACC]: () => okText(GSE_SOFT),
    [GEO_FTP_HTTPS]: () => okBinary(Buffer.from('fake-gz-bytes')),
  };
}

function fetchUrls(): string[] {
  return (global.fetch as any).mock.calls.map((c: any[]) => c[0] as string);
}

describe('geo tools', () => {
  let harness: McpTestHarness;
  let originalFetch: typeof global.fetch;

  beforeAll(async () => {
    harness = await createMcpTestHarness();
  });

  afterAll(async () => {
    await harness.close();
  });

  beforeEach(() => {
    jest.clearAllMocks();
    originalFetch = global.fetch;
    connectionManager.closeAll();
  });

  afterEach(() => {
    global.fetch = originalFetch;
  });

  it('geo_search maps esummary entries and applies the default gse entry_type', async () => {
    mockFetchRoutes(defaultRoutes());

    const results = (await harness.callTool('geo_search', { query: 'breast cancer RNA-seq' })) as any[];

    expect(results).toHaveLength(1);
    expect(results[0]).toMatchObject({
      accession: 'GSE183947',
      entry_type: 'GSE',
      organism: 'Homo sapiens',
      bioproject: 'PRJNA762469',
      sra_project: 'SRP336638',
      pubmed_ids: [35046993],
    });

    const searchUrl = fetchUrls().find(u => u.includes('esearch'))!;
    expect(new URL(searchUrl).searchParams.get('db')).toBe('gds');
    expect(new URL(searchUrl).searchParams.get('term')).toBe('breast cancer RNA-seq AND gse[ETYP]');
  });

  it('geo_get returns series details with chaining fields and no download by default', async () => {
    mockFetchRoutes(defaultRoutes());

    const detail = (await harness.callTool('geo_get', { accession: 'GSE183947' })) as any;

    expect(detail).toMatchObject({
      accession: 'GSE183947',
      entry_type: 'series',
      bioproject: 'PRJNA762469',
      sra: ['SRP336638'],
      pubmed_ids: [35046993],
      platform_ids: ['GPL11154'],
    });
    expect(detail.download).toBeUndefined();
    expect(fetchUrls().some(u => u.includes('ftp.ncbi.nlm.nih.gov'))).toBe(false);
  });

  it('geo_get download=true saves the supplementary file and returns its metadata', async () => {
    mockFetchRoutes(defaultRoutes());

    const detail = (await harness.callTool('geo_get', { accession: 'GSE183947', download: true })) as any;

    expect(detail.download).toMatchObject({
      filename: 'GSE183947_fpkm.csv.gz',
      size_bytes: 13,
      url: GEO_FTP_HTTPS,
    });
    expect(typeof detail.download.path).toBe('string');
    expect(detail.download.path.length).toBeGreaterThan(0);
  });

  it('geo_get rejects a malformed accession with isError', async () => {
    mockFetchRoutes(defaultRoutes());

    await expect(harness.callTool('geo_get', { accession: 'XYZ123' })).rejects.toThrow(
      /GEO accession like GSE183947, GSM5574685, GPL11154/
    );
    expect(fetchUrls()).toHaveLength(0);
  });
});
